"""Deterministic, bounded Pillow image composition and enhancement engine."""

from __future__ import annotations

import hashlib
import io
import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from functools import partial
from typing import Any

from PIL import (
    Image,
    ImageChops,
    ImageCms,
    ImageDraw,
    ImageEnhance,
    ImageFilter,
    ImageFont,
    ImageOps,
    UnidentifiedImageError,
)

MAX_COMPRESSED_SOURCE_BYTES = 100 * 1024 * 1024
MAX_OUTPUT_BYTES = 512 * 1024 * 1024
MAX_PIXELS = 100_000_000
MAX_DIMENSION = 50_000
PROCESSOR_NAME = "ipw-deterministic-pillow-image-export"
PROCESSOR_VERSION = "1.0.0"
STANDARD_RESAMPLING_LABEL = "Standard resampling (not AI reconstruction)"
Image.MAX_IMAGE_PIXELS = MAX_PIXELS


def _canonical_srgb_profile() -> bytes:
    profile = bytearray(ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes())
    profile[24:36] = b"\x07\xd0\x00\x01\x00\x01\x00\x00\x00\x00\x00\x00"
    profile[84:100] = b"\x00" * 16
    return bytes(profile)


CANONICAL_SRGB_PROFILE = _canonical_srgb_profile()


@dataclass(frozen=True)
class VerifiedRasterAsset:
    shared_asset_id: str
    source_version_id: str
    sha256: str
    media_type: str
    byte_size: int
    width: int
    height: int
    data: bytes


@dataclass(frozen=True)
class RenderedImage:
    data: bytes
    sha256: str
    media_type: str
    width: int
    height: int
    metadata_verified: bool
    parameters_sha256: str


class DeterministicImageEngine:
    def render(
        self,
        *,
        snapshot: dict[str, Any],
        artboard_id: str,
        assets: dict[str, VerifiedRasterAsset],
        operations: list[dict[str, Any]],
        profile: dict[str, Any],
    ) -> RenderedImage:
        board = next(
            (
                item
                for item in snapshot.get("artboards", [])
                if item.get("artboard_id") == artboard_id
            ),
            None,
        )
        if not isinstance(board, dict):
            raise ValueError("export artboard is not present in the immutable document version")
        scale = self._unit_scale(str(board.get("unit", "px")))
        width = self._bounded_dimension(float(board["width"]) * scale)
        height = self._bounded_dimension(float(board["height"]) * scale)
        self._guard_pixels(width, height)
        background = board.get("background", {})
        if background.get("kind") == "transparent":
            canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        else:
            canvas = Image.new(
                "RGBA", (width, height), self._colour(background.get("color"), "#FFFFFF")
            )
        layers = [
            item
            for item in snapshot.get("layers", [])
            if item.get("artboard_id") == artboard_id and item.get("visible", True)
        ]
        layers_by_id = {str(item["layer_id"]): item for item in layers}
        roots = sorted(
            (item for item in layers if item.get("parent_layer_id") is None),
            key=lambda item: (int(item.get("order", 0)), str(item.get("layer_id", ""))),
        )
        for layer in roots:
            self._render_layer(canvas, layer, layers_by_id, assets, scale, snapshot)
        adjusted = self._operations(canvas, operations)
        output = self._size_output(adjusted, profile)
        return self._encode(output, profile, assets, operations)

    def _render_layer(
        self,
        canvas: Image.Image,
        layer: dict[str, Any],
        layers_by_id: dict[str, dict[str, Any]],
        assets: dict[str, VerifiedRasterAsset],
        unit: float,
        snapshot: dict[str, Any],
        parent_offset: tuple[float, float] = (0, 0),
    ) -> None:
        if layer.get("layer_type") == "group":
            transform = self._transform(layer)
            children = sorted(
                (
                    item
                    for item in layers_by_id.values()
                    if item.get("parent_layer_id") == layer.get("layer_id")
                ),
                key=lambda item: (int(item.get("order", 0)), str(item.get("layer_id", ""))),
            )
            offset = (
                parent_offset[0] + float(transform["x"]) * unit,
                parent_offset[1] + float(transform["y"]) * unit,
            )
            for child in children:
                self._render_layer(canvas, child, layers_by_id, assets, unit, snapshot, offset)
            return
        transform = self._transform(layer)
        width = self._bounded_dimension(float(transform["width"]) * unit)
        height = self._bounded_dimension(float(transform["height"]) * unit)
        self._guard_pixels(width, height)
        kind = layer.get("layer_type")
        if kind == "raster_image":
            content = layer.get("raster") or {}
            asset = assets.get(str(content.get("shared_asset_id", "")))
            if asset is None:
                raise ValueError("raster layer has no verified immutable source")
            item = self._raster_layer(asset, content, width, height)
        elif kind == "shape":
            item = self._shape_layer(layer.get("shape") or {}, width, height)
        elif kind == "rich_text":
            item = self._text_layer(layer.get("rich_text") or {}, width, height)
        elif kind == "vector_svg":
            item = self._vector_layer(layer.get("vector") or {}, width, height)
        else:
            raise ValueError(f"layer type {kind!r} has no approved image export renderer")
        if bool(transform.get("flip_x")):
            item = ImageOps.mirror(item)
        if bool(transform.get("flip_y")):
            item = ImageOps.flip(item)
        scale_x = float(transform.get("scale_x", 1))
        scale_y = float(transform.get("scale_y", 1))
        if scale_x != 1 or scale_y != 1:
            scaled_width = self._bounded_dimension(item.width * scale_x)
            scaled_height = self._bounded_dimension(item.height * scale_y)
            self._guard_pixels(scaled_width, scaled_height)
            item = item.resize((scaled_width, scaled_height), Image.Resampling.LANCZOS)
        rotation = float(transform.get("rotation_degrees", 0))
        if rotation:
            item = item.rotate(-rotation, expand=True, resample=Image.Resampling.BICUBIC)
        opacity = max(0.0, min(1.0, float(layer.get("opacity", 1))))
        if opacity != 1:
            alpha = item.getchannel("A").point(lambda value: round(value * opacity))
            item.putalpha(alpha)
        left = round(parent_offset[0] + float(transform["x"]) * unit)
        top = round(parent_offset[1] + float(transform["y"]) * unit)
        self._composite(canvas, item, left, top, str(layer.get("blend_mode", "normal")))

    def _raster_layer(
        self, asset: VerifiedRasterAsset, content: dict[str, Any], width: int, height: int
    ) -> Image.Image:
        if (
            len(asset.data) != asset.byte_size
            or hashlib.sha256(asset.data).hexdigest() != asset.sha256
        ):
            raise ValueError("raster bytes do not match immutable source identity")
        try:
            with Image.open(io.BytesIO(asset.data)) as opened:
                if opened.width != asset.width or opened.height != asset.height:
                    raise ValueError("raster dimensions do not match verified inspection facts")
                opened.load()
                source = ImageOps.exif_transpose(opened).convert("RGBA")
        except (UnidentifiedImageError, Image.DecompressionBombError) as error:
            raise ValueError("verified raster could not be decoded safely") from error
        crop = content.get("crop") or {}
        box = (
            round(source.width * float(crop.get("left", 0))),
            round(source.height * float(crop.get("top", 0))),
            round(source.width * float(crop.get("right", 1))),
            round(source.height * float(crop.get("bottom", 1))),
        )
        if box[2] <= box[0] or box[3] <= box[1]:
            raise ValueError("raster crop has no positive area")
        source = source.crop(box).resize((width, height), Image.Resampling.LANCZOS)
        adjustments = content.get("adjustments") or {}
        layer_ops = [
            self._operation(
                "exposure_brightness",
                {
                    "exposure_ev": float(adjustments.get("exposure", 0)) / 20,
                    "brightness": adjustments.get("brightness", 0),
                },
            ),
            self._operation("contrast", {"amount": adjustments.get("contrast", 0)}),
            self._operation(
                "saturation_vibrance",
                {"saturation": adjustments.get("saturation", 0), "vibrance": 0},
            ),
            self._operation(
                "white_balance_temperature",
                {"temperature_kelvin": 6500 + round(float(adjustments.get("temperature", 0)) * 35)},
            ),
            self._operation("tint", {"amount": adjustments.get("tint", 0)}),
            self._operation(
                "unsharp_mask",
                {"radius": 1, "amount": float(adjustments.get("sharpness", 0)) * 2, "threshold": 3},
            ),
        ]
        return self._operations(source, layer_ops)

    def _shape_layer(self, shape: dict[str, Any], width: int, height: int) -> Image.Image:
        image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(image)
        fill = self._optional_colour(shape.get("fill"))
        stroke = self._optional_colour(shape.get("stroke"))
        stroke_width = max(0, round(float(shape.get("stroke_width", 0))))
        bounds = (
            stroke_width // 2,
            stroke_width // 2,
            width - 1 - stroke_width // 2,
            height - 1 - stroke_width // 2,
        )
        kind = shape.get("shape")
        if kind == "rectangle":
            draw.rounded_rectangle(
                bounds,
                radius=max(0, round(float(shape.get("corner_radius", 0)))),
                fill=fill,
                outline=stroke,
                width=stroke_width,
            )
        elif kind == "ellipse":
            draw.ellipse(bounds, fill=fill, outline=stroke, width=stroke_width)
        elif kind in {"line", "polygon"}:
            points = [
                (round(float(item["x"]) * width), round(float(item["y"]) * height))
                for item in shape.get("points", [])
            ]
            if kind == "line" and len(points) == 2:
                draw.line(points, fill=stroke or fill or "#3559E0", width=max(1, stroke_width))
            elif kind == "polygon" and len(points) >= 3:
                draw.polygon(points, fill=fill, outline=stroke, width=stroke_width)
            else:
                raise ValueError("shape points are invalid")
        else:
            raise ValueError("shape kind is not supported")
        return image

    def _text_layer(self, text: dict[str, Any], width: int, height: int) -> Image.Image:
        family = str(text.get("font_family", "system-ui")).lower()
        if family not in {"system-ui", "arial", "times new roman", "courier new"}:
            raise ValueError("text layer uses a font outside the approved system fallback set")
        image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(image)
        # Pillow's bundled bitmap fallback is deterministic and avoids host font substitution.
        font = ImageFont.load_default(size=max(1, round(float(text.get("font_size", 32)))))
        align = str(text.get("text_align", "left"))
        draw.multiline_text(
            (0, 0),
            str(text.get("text", "")),
            fill=self._colour(text.get("color"), "#162033"),
            font=font,
            align=align if align != "justify" else "left",
            spacing=4,
        )
        return image

    def _vector_layer(self, vector: dict[str, Any], width: int, height: int) -> Image.Image:
        path = vector.get("path_data")
        if not isinstance(path, str) or not path.strip():
            raise ValueError("external vector assets require a separately approved renderer")
        tokens = re.findall(r"[MLHVZmlhvz]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?", path)
        curved_commands = {"C", "c", "S", "s", "Q", "q", "T", "t", "A", "a"}
        if not tokens or any(path_token in curved_commands for path_token in tokens):
            raise ValueError("curved vector paths require the approved vector renderer")
        points = self._simple_path_points(tokens)
        if len(points) < 2:
            raise ValueError("vector path has no drawable geometry")
        xs = [point[0] for point in points]
        ys = [point[1] for point in points]
        span_x = max(max(xs) - min(xs), 1e-9)
        span_y = max(max(ys) - min(ys), 1e-9)
        scaled = [
            ((x - min(xs)) / span_x * (width - 1), (y - min(ys)) / span_y * (height - 1))
            for x, y in points
        ]
        image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(image)
        fill = self._optional_colour(vector.get("fill"))
        stroke = self._optional_colour(vector.get("stroke"))
        stroke_width = max(0, round(float(vector.get("stroke_width", 0))))
        if tokens[-1].lower() == "z":
            draw.polygon(scaled, fill=fill, outline=stroke, width=stroke_width)
        else:
            draw.line(scaled, fill=stroke or fill or "#3559E0", width=max(1, stroke_width))
        return image

    def _operations(self, image: Image.Image, operations: list[dict[str, Any]]) -> Image.Image:
        result = image.convert("RGBA")
        for operation in sorted(operations, key=lambda item: int(item.get("order", 0))):
            if not operation.get("enabled", True):
                continue
            kind = str(operation.get("kind"))
            parameters = operation.get("parameters") or {}
            if kind == "orientation_normalize":
                # Raster composition already applies EXIF orientation exactly once.
                continue
            if kind == "crop":
                result = result.crop(
                    (
                        round(result.width * float(parameters["left"])),
                        round(result.height * float(parameters["top"])),
                        round(result.width * float(parameters["right"])),
                        round(result.height * float(parameters["bottom"])),
                    )
                )
            elif kind == "rotate":
                result = result.rotate(
                    -float(parameters["degrees"]),
                    expand=bool(parameters.get("expand_canvas", True)),
                    resample=Image.Resampling.BICUBIC,
                )
            elif kind == "flip":
                if parameters.get("horizontal"):
                    result = ImageOps.mirror(result)
                if parameters.get("vertical"):
                    result = ImageOps.flip(result)
            elif kind == "resize":
                result = self._resize_operation(result, parameters)
            elif kind == "exposure_brightness":
                factor = max(
                    0.01,
                    (2 ** float(parameters.get("exposure_ev", 0)))
                    * (1 + float(parameters.get("brightness", 0)) / 100),
                )
                result = self._with_alpha(
                    result,
                    partial(self._brightness, amount=factor),
                )
            elif kind == "contrast":
                contrast_factor = max(0, 1 + float(parameters.get("amount", 0)) / 100)
                result = self._with_alpha(
                    result,
                    partial(self._contrast, amount=contrast_factor),
                )
            elif kind == "highlights_shadows":
                result = self._tone_regions(
                    result,
                    float(parameters.get("highlights", 0)),
                    float(parameters.get("shadows", 0)),
                )
            elif kind == "white_balance_temperature":
                result = self._temperature(result, int(parameters.get("temperature_kelvin", 6500)))
            elif kind == "tint":
                result = self._tint(result, float(parameters.get("amount", 0)))
            elif kind == "saturation_vibrance":
                saturation = 1 + float(parameters.get("saturation", 0)) / 100
                vibrance = float(parameters.get("vibrance", 0)) / 100
                result = self._with_alpha(
                    result,
                    partial(
                        self._colour_enhance,
                        saturation=saturation,
                        vibrance=vibrance,
                    ),
                )
            elif kind == "gamma":
                gamma = float(parameters.get("gamma", 1))
                result = self._lut(
                    result, [round(255 * ((index / 255) ** (1 / gamma))) for index in range(256)]
                )
            elif kind == "levels":
                result = self._levels(
                    result,
                    int(parameters.get("black", 0)),
                    int(parameters.get("white", 255)),
                    float(parameters.get("midpoint", 1)),
                )
            elif kind == "curves":
                result = self._curve(
                    result,
                    str(parameters.get("channel", "rgb")),
                    list(parameters.get("points", [])),
                )
            elif kind == "grayscale":
                alpha = result.getchannel("A")
                result = ImageOps.grayscale(result.convert("RGB")).convert("RGB").convert("RGBA")
                result.putalpha(alpha)
            elif kind == "unsharp_mask":
                result = result.filter(
                    ImageFilter.UnsharpMask(
                        radius=float(parameters.get("radius", 1)),
                        percent=round(float(parameters.get("amount", 100))),
                        threshold=int(parameters.get("threshold", 3)),
                    )
                )
            elif kind == "noise_reduction":
                strength = int(parameters.get("strength", 20))
                if strength:
                    result = result.filter(ImageFilter.GaussianBlur(radius=max(0.1, strength / 35)))
            elif kind == "colour_profile_conversion":
                if parameters.get("target_profile") == "display-p3":
                    raise ValueError(
                        "Display P3 output is unavailable in the bounded Pillow engine"
                    )
            elif kind == "alpha_background":
                if parameters.get("behavior") == "flatten":
                    result = self._flatten(result, str(parameters["background"]))
            elif kind == "resampling_scale":
                scale = int(parameters["scale"])
                result = result.resize(
                    (result.width * scale, result.height * scale),
                    self._resampler(str(parameters.get("algorithm", "lanczos"))),
                )
            else:
                raise ValueError(f"operation {kind!r} has no approved deterministic processor")
            self._guard_pixels(result.width, result.height)
        return result

    def _size_output(self, image: Image.Image, profile: dict[str, Any]) -> Image.Image:
        width = profile.get("width")
        height = profile.get("height")
        percentage = profile.get("percentage")
        if percentage is not None:
            width = max(1, round(image.width * float(percentage) / 100))
            height = max(1, round(image.height * float(percentage) / 100))
        elif (
            profile.get("physical_width") is not None or profile.get("physical_height") is not None
        ):
            ppi = int(profile["ppi"])
            factor = {"in": 1.0, "cm": 1 / 2.54, "mm": 1 / 25.4}[str(profile["physical_unit"])]
            width = round(
                float(profile.get("physical_width") or (image.width / ppi / factor)) * factor * ppi
            )
            height = round(
                float(profile.get("physical_height") or (image.height / ppi / factor))
                * factor
                * ppi
            )
        if width is None and height is None:
            return image
        if width is None:
            if height is None:
                raise ValueError("output height is required")
            width = round(image.width * float(height) / image.height)
        if height is None:
            if width is None:
                raise ValueError("output width is required")
            height = round(image.height * float(width) / image.width)
        target = (self._bounded_dimension(float(width)), self._bounded_dimension(float(height)))
        self._guard_pixels(*target)
        fit = profile.get("fit", "contain")
        resampler = self._resampler(str(profile.get("resampling_algorithm", "lanczos")))
        if fit == "stretch":
            return image.resize(target, resampler)
        if fit == "cover":
            return ImageOps.fit(image, target, method=resampler)
        contained = ImageOps.contain(image, target, method=resampler)
        background = (
            (0, 0, 0, 0)
            if profile.get("alpha_behavior") == "preserve"
            else self._colour(profile.get("background"), "#FFFFFF")
        )
        result = Image.new("RGBA", target, background)
        result.alpha_composite(
            contained, ((target[0] - contained.width) // 2, (target[1] - contained.height) // 2)
        )
        return result

    def _encode(
        self,
        image: Image.Image,
        profile: dict[str, Any],
        assets: dict[str, VerifiedRasterAsset],
        operations: list[dict[str, Any]],
    ) -> RenderedImage:
        if int(profile.get("bit_depth", 8)) != 8:
            raise ValueError("16-bit colour output requires the future libvips capability gate")
        colour_profile = str(profile.get("colour_profile", "srgb"))
        if colour_profile == "display-p3":
            raise ValueError("Display P3 output requires the future colour-engine capability gate")
        icc = CANONICAL_SRGB_PROFILE if colour_profile == "srgb" else None
        if profile.get("alpha_behavior") == "flatten":
            image = self._flatten(image, str(profile.get("background") or "#FFFFFF"))
        format_name = str(profile["format"])
        output = io.BytesIO()
        kwargs: dict[str, Any] = {"icc_profile": icc}
        if format_name == "jpeg":
            save_image = image.convert("RGB")
            subsampling_name = profile.get("chroma_subsampling")
            subsampling = {
                "4:4:4": 0,
                "4:2:2": 1,
                "4:2:0": 2,
            }.get(str(subsampling_name), 0)
            kwargs.update(
                format="JPEG",
                quality=int(profile.get("quality") or 90),
                optimize=False,
                progressive=False,
                subsampling=subsampling,
            )
            media_type = "image/jpeg"
        elif format_name == "png":
            save_image = image
            kwargs.update(format="PNG", optimize=False, compress_level=6)
            media_type = "image/png"
        elif format_name == "webp":
            save_image = image
            kwargs.update(
                format="WEBP",
                lossless=bool(profile.get("lossless", False)),
                quality=int(profile.get("quality") or 90),
                method=4,
                exact=True,
            )
            media_type = "image/webp"
        elif format_name == "tiff":
            save_image = image
            kwargs.update(format="TIFF", compression="tiff_deflate")
            media_type = "image/tiff"
        else:
            raise ValueError("requested output format has no executable encoder")
        metadata = self._safe_exif(profile.get("metadata_policy") or {}, assets)
        if metadata is not None:
            kwargs["exif"] = metadata
        save_image.save(output, **kwargs)
        data = output.getvalue()
        if not data or len(data) > MAX_OUTPUT_BYTES:
            raise ValueError("encoded output exceeds the bounded object limit")
        self._verify_encoded(data, format_name, image.width, image.height)
        parameters = json.dumps(
            {"operations": operations, "profile": profile}, sort_keys=True, separators=(",", ":")
        ).encode()
        return RenderedImage(
            data,
            hashlib.sha256(data).hexdigest(),
            media_type,
            image.width,
            image.height,
            True,
            hashlib.sha256(parameters).hexdigest(),
        )

    def _safe_exif(
        self, policy: dict[str, Any], assets: dict[str, VerifiedRasterAsset]
    ) -> bytes | None:
        if len(assets) != 1:
            return None
        source = next(iter(assets.values()))
        try:
            with Image.open(io.BytesIO(source.data)) as opened:
                original = opened.getexif()
        except (UnidentifiedImageError, OSError):
            return None
        safe = Image.Exif()
        if policy.get("preserve_copyright", True) and 33432 in original:
            safe[33432] = original[33432]
        if policy.get("preserve_description") and 270 in original:
            safe[270] = original[270]
        if policy.get("preserve_capture_time") and 36867 in original:
            safe[36867] = original[36867]
        if policy.get("preserve_camera"):
            for tag in (271, 272):
                if tag in original:
                    safe[tag] = original[tag]
        safe[274] = 1
        return safe.tobytes() if len(safe) else None

    def _verify_encoded(self, data: bytes, format_name: str, width: int, height: int) -> None:
        expected = {"jpeg": "JPEG", "png": "PNG", "webp": "WEBP", "tiff": "TIFF"}[format_name]
        try:
            with Image.open(io.BytesIO(data)) as opened:
                if opened.format != expected or opened.size != (width, height):
                    raise ValueError("encoded output failed format verification")
                exif = opened.getexif()
                if 34853 in exif or exif.get(274, 1) != 1:
                    raise ValueError(
                        "encoded output retained prohibited location or orientation metadata"
                    )
            with Image.open(io.BytesIO(data)) as verification:
                verification.verify()
        except (OSError, RuntimeError) as error:
            raise ValueError("encoded output failed decoder verification") from error

    @staticmethod
    def _operation(kind: str, parameters: dict[str, Any]) -> dict[str, Any]:
        return {"kind": kind, "enabled": True, "order": 0, "parameters": parameters}

    @staticmethod
    def _transform(layer: dict[str, Any]) -> dict[str, Any]:
        value = layer.get("transform")
        if not isinstance(value, dict):
            raise ValueError("layer transform is missing")
        return value

    @staticmethod
    def _unit_scale(unit: str) -> float:
        return {"px": 1, "in": 96, "mm": 96 / 25.4, "pt": 96 / 72}.get(unit, 1)

    @staticmethod
    def _bounded_dimension(value: float) -> int:
        result = max(1, round(value))
        if result > MAX_DIMENSION:
            raise ValueError("output dimension exceeds processor capacity")
        return result

    @staticmethod
    def _guard_pixels(width: int, height: int) -> None:
        if width > MAX_DIMENSION or height > MAX_DIMENSION or width * height > MAX_PIXELS:
            raise ValueError("output pixels exceed processor capacity")

    @staticmethod
    def _colour(value: Any, fallback: str) -> str:
        return (
            value
            if isinstance(value, str) and re.fullmatch(r"#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?", value)
            else fallback
        )

    def _optional_colour(self, value: Any) -> str | None:
        return None if value is None else self._colour(value, "#000000")

    @staticmethod
    def _resampler(value: str) -> Image.Resampling:
        resamplers: dict[str, Image.Resampling] = {
            "nearest": Image.Resampling.NEAREST,
            "bilinear": Image.Resampling.BILINEAR,
            "bicubic": Image.Resampling.BICUBIC,
            "lanczos": Image.Resampling.LANCZOS,
        }
        return resamplers.get(value, Image.Resampling.LANCZOS)

    @staticmethod
    def _with_alpha(
        image: Image.Image, transform: Callable[[Image.Image], Image.Image]
    ) -> Image.Image:
        alpha = image.getchannel("A")
        result = transform(image.convert("RGB")).convert("RGBA")
        result.putalpha(alpha)
        return result

    def _lut(self, image: Image.Image, table: list[int]) -> Image.Image:
        return self._with_alpha(image, lambda rgb: rgb.point(table * 3))

    def _levels(self, image: Image.Image, black: int, white: int, midpoint: float) -> Image.Image:
        table = [
            round(255 * (max(0, min(1, (value - black) / (white - black))) ** (1 / midpoint)))
            for value in range(256)
        ]
        return self._lut(image, table)

    def _curve(self, image: Image.Image, channel: str, points: list[dict[str, Any]]) -> Image.Image:
        ordered = [(float(item["input"]) * 255, float(item["output"]) * 255) for item in points]
        table = []
        for value in range(256):
            upper = next(
                (index for index, point in enumerate(ordered) if point[0] >= value),
                len(ordered) - 1,
            )
            lower = max(0, upper - 1)
            left, right = ordered[lower], ordered[upper]
            ratio = 0 if right[0] == left[0] else (value - left[0]) / (right[0] - left[0])
            table.append(round(left[1] + (right[1] - left[1]) * ratio))
        alpha = image.getchannel("A")
        channels = list(image.convert("RGB").split())
        targets = range(3) if channel == "rgb" else [{"red": 0, "green": 1, "blue": 2}[channel]]
        for target in targets:
            channels[target] = channels[target].point(table)
        result = Image.merge("RGB", channels).convert("RGBA")
        result.putalpha(alpha)
        return result

    def _tone_regions(self, image: Image.Image, highlights: float, shadows: float) -> Image.Image:
        table = []
        for value in range(256):
            normalized = value / 255
            shadow_weight = (1 - normalized) ** 2
            highlight_weight = normalized**2
            table.append(
                round(
                    max(
                        0,
                        min(
                            255,
                            value
                            + shadows * 1.2 * shadow_weight
                            + highlights * 1.2 * highlight_weight,
                        ),
                    )
                )
            )
        return self._lut(image, table)

    def _temperature(self, image: Image.Image, kelvin: int) -> Image.Image:
        amount = max(-1, min(1, (kelvin - 6500) / 5500))
        alpha = image.getchannel("A")
        red, green, blue = image.convert("RGB").split()
        red = red.point(lambda value: round(max(0, min(255, value * (1 + amount * 0.18)))))
        blue = blue.point(lambda value: round(max(0, min(255, value * (1 - amount * 0.18)))))
        result = Image.merge("RGB", (red, green, blue)).convert("RGBA")
        result.putalpha(alpha)
        return result

    def _tint(self, image: Image.Image, amount: float) -> Image.Image:
        alpha = image.getchannel("A")
        red, green, blue = image.convert("RGB").split()
        factor = amount / 100
        red = red.point(lambda value: round(max(0, min(255, value * (1 + factor * 0.08)))))
        green = green.point(lambda value: round(max(0, min(255, value * (1 - factor * 0.12)))))
        blue = blue.point(lambda value: round(max(0, min(255, value * (1 + factor * 0.08)))))
        result = Image.merge("RGB", (red, green, blue)).convert("RGBA")
        result.putalpha(alpha)
        return result

    @staticmethod
    def _vibrance(image: Image.Image, amount: float) -> Image.Image:
        if amount == 0:
            return image
        hsv = image.convert("HSV")
        hue, saturation, value = hsv.split()
        saturation = saturation.point(
            lambda item: round(max(0, min(255, item + amount * (255 - item))))
        )
        return Image.merge("HSV", (hue, saturation, value)).convert("RGB")

    @staticmethod
    def _brightness(image: Image.Image, *, amount: float) -> Image.Image:
        return ImageEnhance.Brightness(image).enhance(amount)

    @staticmethod
    def _contrast(image: Image.Image, *, amount: float) -> Image.Image:
        return ImageEnhance.Contrast(image).enhance(amount)

    def _colour_enhance(
        self, image: Image.Image, *, saturation: float, vibrance: float
    ) -> Image.Image:
        return self._vibrance(ImageEnhance.Color(image).enhance(max(0, saturation)), vibrance)

    def _resize_operation(self, image: Image.Image, value: dict[str, Any]) -> Image.Image:
        mode = value["mode"]
        if mode == "percent":
            width, height = (
                round(image.width * float(value["width"]) / 100),
                round(image.height * float(value["height"]) / 100),
            )
        elif mode == "physical":
            factor = {"in": 1.0, "cm": 1 / 2.54, "mm": 1 / 25.4}[str(value["physical_unit"])]
            width, height = (
                round(float(value["width"]) * factor * int(value["ppi"])),
                round(float(value["height"]) * factor * int(value["ppi"])),
            )
        else:
            width, height = round(float(value["width"])), round(float(value["height"]))
        target = (self._bounded_dimension(width), self._bounded_dimension(height))
        self._guard_pixels(*target)
        return image.resize(target, self._resampler(str(value.get("algorithm", "lanczos"))))

    def _flatten(self, image: Image.Image, background: str) -> Image.Image:
        base = Image.new("RGBA", image.size, self._colour(background, "#FFFFFF"))
        base.alpha_composite(image)
        return base.convert("RGB").convert("RGBA")

    @staticmethod
    def _composite(canvas: Image.Image, item: Image.Image, left: int, top: int, mode: str) -> None:
        if mode == "normal":
            canvas.alpha_composite(item, (left, top))
            return
        overlay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        overlay.alpha_composite(item, (left, top))
        alpha = overlay.getchannel("A")
        base_rgb, over_rgb = canvas.convert("RGB"), overlay.convert("RGB")
        if mode in {"multiply", "darken"}:
            mixed = (
                ImageChops.multiply(base_rgb, over_rgb)
                if mode == "multiply"
                else ImageChops.darker(base_rgb, over_rgb)
            )
        elif mode in {"screen", "lighten"}:
            mixed = (
                ImageChops.screen(base_rgb, over_rgb)
                if mode == "screen"
                else ImageChops.lighter(base_rgb, over_rgb)
            )
        elif mode == "overlay":
            mixed = ImageChops.soft_light(base_rgb, over_rgb)
        else:
            raise ValueError("blend mode has no approved export implementation")
        canvas.alpha_composite(Image.composite(mixed.convert("RGBA"), overlay, alpha))

    @staticmethod
    def _simple_path_points(tokens: list[str]) -> list[tuple[float, float]]:
        points: list[tuple[float, float]] = []
        index = 0
        command = ""
        current = (0.0, 0.0)
        while index < len(tokens):
            token = tokens[index]
            if token.isalpha():
                command = token
                index += 1
                continue
            if command.lower() in {"m", "l"}:
                if index + 1 >= len(tokens):
                    raise ValueError("vector path coordinate is incomplete")
                x, y = float(tokens[index]), float(tokens[index + 1])
                index += 2
                current = (current[0] + x, current[1] + y) if command.islower() else (x, y)
                points.append(current)
            elif command.lower() == "h":
                x = float(token)
                index += 1
                current = (current[0] + x if command.islower() else x, current[1])
                points.append(current)
            elif command.lower() == "v":
                y = float(token)
                index += 1
                current = (current[0], current[1] + y if command.islower() else y)
                points.append(current)
            else:
                raise ValueError("vector path command is not supported")
        return points
