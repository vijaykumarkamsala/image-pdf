"""Deterministic, bounded Pillow image composition and enhancement engine."""

from __future__ import annotations

import hashlib
import importlib
import io
import json
import math
import os
import platform
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from typing import Any

from PIL import (
    Image,
    ImageChops,
    ImageCms,
    ImageDraw,
    ImageEnhance,
    ImageFilter,
    ImageOps,
    UnidentifiedImageError,
)
from pydantic import ValidationError

from ipw.contracts import ExportOutputProfile, ImageOperation
from ipw.inspection import inspect_bytes

MAX_COMPRESSED_SOURCE_BYTES = 64 * 1024 * 1024
MAX_OUTPUT_BYTES = 64 * 1024 * 1024
MAX_PIXELS = 16_000_000
MAX_DIMENSION = 12_000
MAX_PROCESS_RSS_BYTES = 768 * 1024 * 1024
MAX_PROCESS_SECONDS = 60.0
PROCESSOR_NAME = "ipw-deterministic-pillow-image-export"
PROCESSOR_VERSION = "1.1.0"
STANDARD_RESAMPLING_LABEL = "Standard resampling (not AI reconstruction)"
Image.MAX_IMAGE_PIXELS = MAX_PIXELS


def _canonical_srgb_profile() -> bytes:
    profile = bytearray(ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes())
    profile[24:36] = b"\x07\xd0\x00\x01\x00\x01\x00\x00\x00\x00\x00\x00"
    profile[84:100] = b"\x00" * 16
    return bytes(profile)


CANONICAL_SRGB_PROFILE = _canonical_srgb_profile()


def _effectively_visible_layers(snapshot: dict[str, Any], artboard_id: str) -> list[dict[str, Any]]:
    layers = [
        layer for layer in snapshot.get("layers", []) if layer.get("artboard_id") == artboard_id
    ]
    by_id = {str(layer.get("layer_id")): layer for layer in layers}

    def visible(layer: dict[str, Any]) -> bool:
        current: dict[str, Any] | None = layer
        visited: set[str] = set()
        while current is not None:
            if not current.get("visible", True):
                return False
            layer_id = str(current.get("layer_id", ""))
            if not layer_id or layer_id in visited:
                raise ValueError("native document contains a cyclic layer hierarchy")
            visited.add(layer_id)
            parent_id = current.get("parent_layer_id")
            if parent_id is None:
                return True
            current = by_id.get(str(parent_id))
            if current is None:
                raise ValueError("native document layer parent is outside the selected artboard")
        return False

    return [layer for layer in layers if visible(layer)]


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
    orientation: int | None = None
    bit_depth: int | None = None
    frame_count: int | None = None
    has_icc_profile: bool | None = None
    colour_model: str | None = None


@dataclass(frozen=True)
class RenderedImage:
    data: bytes
    sha256: str
    media_type: str
    width: int
    height: int
    metadata_verified: bool
    metadata_evidence: dict[str, str]
    histogram: dict[str, Any]
    parameters_sha256: str


@dataclass(frozen=True)
class ProcessingLimits:
    max_rss_bytes: int = MAX_PROCESS_RSS_BYTES
    max_seconds: float = MAX_PROCESS_SECONDS


class ProcessingBudget:
    """Cooperative process-level budget checked between every expensive stage."""

    def __init__(
        self,
        limits: ProcessingLimits | None = None,
        *,
        clock: Callable[[], float] = time.monotonic,
        rss: Callable[[], int] | None = None,
        checkpoint: Callable[[str], None] | None = None,
    ) -> None:
        self._limits = limits or ProcessingLimits()
        self._clock = clock
        self._rss = rss or _process_rss_bytes
        self._checkpoint = checkpoint
        self._started = clock()

    def check(self, stage: str) -> None:
        if self._checkpoint is not None:
            self._checkpoint(stage)
        if self._clock() - self._started > self._limits.max_seconds:
            raise TimeoutError(f"image processing exceeded {self._limits.max_seconds:g} seconds")
        resident = self._rss()
        if resident > self._limits.max_rss_bytes:
            raise MemoryError(
                f"image processing exceeded the {self._limits.max_rss_bytes // (1024 * 1024)} MiB "
                "process memory limit"
            )


def _process_rss_bytes() -> int:
    if platform.system() == "Windows":
        return _windows_process_memory_counters()[0]
    try:
        sysconf = vars(os).get("sysconf")
        if not callable(sysconf):
            return 0
        page_size = sysconf("SC_PAGE_SIZE")
        with Path("/proc/self/statm").open(encoding="ascii") as handle:
            resident_pages = int(handle.read().split()[1])
        return int(page_size) * resident_pages
    except (AttributeError, OSError, ValueError, IndexError) as error:
        raise RuntimeError("process memory accounting is unavailable") from error


def process_peak_rss_bytes() -> int:
    """Return peak process RSS for reproducible resource evidence."""

    if platform.system() == "Windows":
        return _windows_process_memory_counters()[1]
    try:
        resource_module: Any = importlib.import_module("resource")
        usage = resource_module.getrusage(resource_module.RUSAGE_SELF).ru_maxrss
        return int(usage if platform.system() == "Darwin" else usage * 1024)
    except (ImportError, OSError, ValueError) as error:
        raise RuntimeError("peak process memory accounting is unavailable") from error


def _windows_process_memory_counters() -> tuple[int, int]:
    # Explicit signatures prevent the 64-bit pseudo-handle from being truncated.
    import ctypes
    from ctypes import wintypes

    class ProcessMemoryCounters(ctypes.Structure):
        _fields_ = [
            ("cb", wintypes.DWORD),
            ("PageFaultCount", wintypes.DWORD),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetCurrentProcess.argtypes = []
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    process = kernel32.GetCurrentProcess()
    try:
        get_memory = kernel32.K32GetProcessMemoryInfo
    except AttributeError:
        get_memory = ctypes.WinDLL("psapi", use_last_error=True).GetProcessMemoryInfo
    get_memory.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(ProcessMemoryCounters),
        wintypes.DWORD,
    ]
    get_memory.restype = wintypes.BOOL
    counters = ProcessMemoryCounters()
    counters.cb = ctypes.sizeof(counters)
    if not get_memory(process, ctypes.byref(counters), counters.cb):
        raise OSError(ctypes.get_last_error(), "GetProcessMemoryInfo failed")
    return int(counters.WorkingSetSize), int(counters.PeakWorkingSetSize)


class DeterministicImageEngine:
    def render(
        self,
        *,
        snapshot: dict[str, Any],
        artboard_id: str,
        assets: dict[str, VerifiedRasterAsset],
        operations: list[dict[str, Any]],
        profile: dict[str, Any],
        budget: ProcessingBudget | None = None,
    ) -> RenderedImage:
        try:
            operations = [
                ImageOperation.model_validate(operation).model_dump(mode="json")
                for operation in operations
            ]
            profile = ExportOutputProfile.model_validate(profile).model_dump(mode="json")
        except ValidationError as error:
            raise ValueError("image export parameters failed contract validation") from error
        active_budget = budget or ProcessingBudget()
        active_budget.check("validate")
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
        self._validate_snapshot(snapshot, artboard_id)
        self._validate_orientation(operations)
        self._validate_profile(snapshot, artboard_id, assets, profile)
        colour_settings = self._colour_settings(operations, profile, assets)
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
            item for item in snapshot.get("layers", []) if item.get("artboard_id") == artboard_id
        ]
        layers_by_id = {str(item["layer_id"]): item for item in layers}
        roots = sorted(
            (
                item
                for item in layers
                if item.get("parent_layer_id") is None and item.get("visible", True)
            ),
            key=lambda item: (int(item.get("order", 0)), str(item.get("layer_id", ""))),
        )
        for layer in roots:
            active_budget.check(f"layer:{layer.get('layer_id', 'unknown')}")
            self._render_layer(
                canvas,
                layer,
                layers_by_id,
                assets,
                scale,
                snapshot,
                colour_settings,
                active_budget,
            )
        active_budget.check("recipe")
        adjusted = self._operations(canvas, operations, active_budget)
        active_budget.check("output-size")
        output = self._size_output(adjusted, profile)
        active_budget.check("encode")
        return self._encode(output, profile, assets, operations, active_budget)

    def _render_layer(
        self,
        canvas: Image.Image,
        layer: dict[str, Any],
        layers_by_id: dict[str, dict[str, Any]],
        assets: dict[str, VerifiedRasterAsset],
        unit: float,
        snapshot: dict[str, Any],
        colour_settings: tuple[str, ImageCms.Intent, bool],
        budget: ProcessingBudget,
        parent_offset: tuple[float, float] = (0, 0),
        ancestry: tuple[str, ...] = (),
    ) -> None:
        if not layer.get("visible", True):
            return
        layer_id = str(layer.get("layer_id", ""))
        if not layer_id or layer_id in ancestry:
            raise ValueError("native document contains a cyclic or unidentified layer")
        budget.check(f"render:{layer_id}")
        transform = self._transform(layer)
        width = self._bounded_dimension(float(transform["width"]) * unit)
        height = self._bounded_dimension(float(transform["height"]) * unit)
        self._guard_pixels(width, height)
        if layer.get("layer_type") == "group":
            item = Image.new("RGBA", (width, height), (0, 0, 0, 0))
            children = sorted(
                (
                    item
                    for item in layers_by_id.values()
                    if item.get("parent_layer_id") == layer.get("layer_id")
                    and item.get("visible", True)
                ),
                key=lambda item: (int(item.get("order", 0)), str(item.get("layer_id", ""))),
            )
            for child in children:
                self._render_layer(
                    item,
                    child,
                    layers_by_id,
                    assets,
                    unit,
                    snapshot,
                    colour_settings,
                    budget,
                    ancestry=(*ancestry, layer_id),
                )
        else:
            kind = layer.get("layer_type")
            if kind == "raster_image":
                content = layer.get("raster") or {}
                asset = assets.get(str(content.get("shared_asset_id", "")))
                if asset is None:
                    raise ValueError("raster layer has no verified immutable source")
                item = self._raster_layer(
                    asset,
                    content,
                    width,
                    height,
                    colour_settings=colour_settings,
                    budget=budget,
                )
            elif kind == "shape":
                item = self._shape_layer(layer.get("shape") or {}, width, height, unit=unit)
            elif kind == "rich_text":
                item = self._text_layer(layer.get("rich_text") or {}, width, height)
            elif kind == "vector_svg":
                item = self._vector_layer(layer.get("vector") or {}, width, height, unit=unit)
            else:
                raise ValueError(f"layer type {kind!r} has no approved image export renderer")
            item = self._apply_masks(item, layer, snapshot)
        item, offset_x, offset_y = self._transform_item(item, transform, layer)
        budget.check(f"composite:{layer_id}")
        left = round(parent_offset[0] + float(transform["x"]) * unit + offset_x)
        top = round(parent_offset[1] + float(transform["y"]) * unit + offset_y)
        self._composite(canvas, item, left, top, str(layer.get("blend_mode", "normal")))

    def _transform_item(
        self, item: Image.Image, transform: dict[str, Any], layer: dict[str, Any]
    ) -> tuple[Image.Image, float, float]:
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
        offset_x = 0.0
        offset_y = 0.0
        if rotation:
            radians = math.radians(rotation)
            cosine = math.cos(radians)
            sine = math.sin(radians)
            corners = (
                (0.0, 0.0),
                (item.width * cosine, item.width * sine),
                (-item.height * sine, item.height * cosine),
                (
                    item.width * cosine - item.height * sine,
                    item.width * sine + item.height * cosine,
                ),
            )
            offset_x = math.floor(min(point[0] for point in corners))
            offset_y = math.floor(min(point[1] for point in corners))
            item = item.rotate(-rotation, expand=True, resample=Image.Resampling.BICUBIC)
            self._guard_pixels(item.width, item.height)
        opacity = float(layer.get("opacity", 1))
        if not 0 <= opacity <= 1:
            raise ValueError("native layer opacity is outside the supported range")
        if opacity != 1:
            alpha = item.getchannel("A").point(lambda value: round(value * opacity))
            item.putalpha(alpha)
        return item, offset_x, offset_y

    def _validate_snapshot(self, snapshot: dict[str, Any], artboard_id: str) -> None:
        layers = [
            item for item in snapshot.get("layers", []) if item.get("artboard_id") == artboard_id
        ]
        identifiers = {str(item.get("layer_id", "")) for item in layers}
        if "" in identifiers or len(identifiers) != len(layers):
            raise ValueError("native document layer identities are invalid")
        sibling_orders: set[tuple[str, int]] = set()
        parents: dict[str, str | None] = {}
        for layer in layers:
            parent = layer.get("parent_layer_id")
            if parent is not None and str(parent) not in identifiers:
                raise ValueError("native document layer parent is outside the selected artboard")
            if parent is not None:
                parent_layer = next(item for item in layers if item.get("layer_id") == parent)
                if parent_layer.get("layer_type") != "group":
                    raise ValueError("native child layer parent is not a group")
            layer_id = str(layer["layer_id"])
            parents[layer_id] = None if parent is None else str(parent)
            sibling_key = (parents[layer_id] or "", int(layer.get("order", 0)))
            if sibling_key in sibling_orders:
                raise ValueError("native sibling layer order is not unique")
            sibling_orders.add(sibling_key)
            transform = self._transform(layer)
            numeric = {
                name: float(transform.get(name, fallback))
                for name, fallback in {
                    "x": 0,
                    "y": 0,
                    "width": 0,
                    "height": 0,
                    "rotation_degrees": 0,
                    "scale_x": 1,
                    "scale_y": 1,
                    "skew_x_degrees": 0,
                    "skew_y_degrees": 0,
                }.items()
            }
            if not all(math.isfinite(value) for value in numeric.values()):
                raise ValueError("native layer transform contains a non-finite value")
            if numeric["width"] <= 0 or numeric["height"] <= 0:
                raise ValueError("native layer transform has no positive area")
            if numeric["scale_x"] <= 0 or numeric["scale_y"] <= 0:
                raise ValueError("native layer scale must be positive")
            if numeric["skew_x_degrees"] or numeric["skew_y_degrees"]:
                raise ValueError("native skew export is unavailable in this build")
            scaled_width = self._bounded_dimension(numeric["width"] * numeric["scale_x"])
            scaled_height = self._bounded_dimension(numeric["height"] * numeric["scale_y"])
            self._guard_pixels(scaled_width, scaled_height)
            if layer.get("shared_style_ids"):
                raise ValueError(
                    "shared-style native export is unavailable until style projection is canonical"
                )
            if layer.get("layer_type") == "rich_text":
                self._text_layer(layer.get("rich_text") or {}, 1, 1)
            if layer.get("layer_type") == "vector_svg":
                vector = layer.get("vector") or {}
                if vector.get("shared_asset_id") or vector.get("sanitised_svg_object_reference_id"):
                    raise ValueError(
                        "external vector export requires the approved sanitised vector renderer"
                    )
                path = str(vector.get("path_data") or "")
                if len(re.findall(r"(?<![A-Za-z])[Mm](?=\s|[-+0-9.])", path)) > 1:
                    raise ValueError(
                        "multiple vector subpaths require the future canonical renderer"
                    )
        for layer_id in identifiers:
            visited: set[str] = set()
            cursor: str | None = layer_id
            while cursor is not None:
                if cursor in visited:
                    raise ValueError("native document contains a cyclic layer hierarchy")
                visited.add(cursor)
                cursor = parents[cursor]
        selected_masks = [
            item for item in snapshot.get("masks", []) if item.get("artboard_id") == artboard_id
        ]
        mask_ids = {str(item.get("mask_id", "")) for item in selected_masks}
        if "" in mask_ids:
            raise ValueError("native document mask identity is invalid")
        for layer in layers:
            content = layer.get("raster") or layer.get("vector") or {}
            referenced = [str(value) for value in content.get("mask_ids", [])]
            if len(referenced) > 1:
                raise ValueError("multiple masks on one layer are unavailable in this build")
            for mask_id in referenced:
                if str(mask_id) not in mask_ids:
                    raise ValueError("native layer references a missing editable mask")

    @staticmethod
    def _validate_orientation(operations: list[dict[str, Any]]) -> None:
        normalizations = [
            operation
            for operation in operations
            if operation.get("enabled", True) and operation.get("kind") == "orientation_normalize"
        ]
        if normalizations:
            raise ValueError(
                "orientation is already normalized once at verified source decode and is not an "
                "executable recipe operation"
            )

    @staticmethod
    def _validate_profile(
        snapshot: dict[str, Any],
        artboard_id: str,
        assets: dict[str, VerifiedRasterAsset],
        profile: dict[str, Any],
    ) -> None:
        format_name = str(profile.get("format"))
        if format_name not in {"jpeg", "png", "webp", "tiff"}:
            raise ValueError("requested output format has no executable encoder")
        lossless = bool(profile.get("lossless", False))
        quality = profile.get("quality")
        if format_name in {"png", "tiff"} and (not lossless or quality is not None):
            raise ValueError(f"{format_name.upper()} must use its fixed lossless encoding")
        if format_name == "jpeg" and (lossless or quality is None):
            raise ValueError("JPEG requires an explicit lossy quality")
        if format_name == "webp" and (
            (lossless and quality is not None) or (not lossless and quality is None)
        ):
            raise ValueError("WebP quality is valid exactly when lossy encoding is selected")
        if format_name == "webp" and (
            profile.get("physical_width") is not None or profile.get("physical_height") is not None
        ):
            raise ValueError("WebP physical-resolution metadata is unavailable")
        if str(profile.get("fit", "contain")) not in {"contain", "cover", "stretch"}:
            raise ValueError("output fit mode is unavailable")
        if str(profile.get("colour_profile", "srgb")) == "preserve":
            visible_content = [
                layer
                for layer in _effectively_visible_layers(snapshot, artboard_id)
                if layer.get("layer_type") not in {"group", "raster_image"}
            ]
            if len(assets) != 1 or visible_content:
                raise ValueError(
                    "source profile preservation requires one raster source "
                    "and no native sRGB artwork"
                )
            source = next(iter(assets.values()))
            if source.has_icc_profile is not True or source.colour_model != "rgb":
                raise ValueError(
                    "source profile preservation requires one validated RGB ICC profile"
                )
            board = next(
                item
                for item in snapshot.get("artboards", [])
                if item.get("artboard_id") == artboard_id
            )
            if (board.get("background") or {}).get("kind") != "transparent":
                raise ValueError(
                    "source profile preservation requires a transparent artboard background"
                )

    @staticmethod
    def _colour_settings(
        operations: list[dict[str, Any]],
        profile: dict[str, Any],
        assets: dict[str, VerifiedRasterAsset],
    ) -> tuple[str, ImageCms.Intent, bool]:
        conversions = [
            item
            for item in operations
            if item.get("enabled", True) and item.get("kind") == "colour_profile_conversion"
        ]
        if len(conversions) > 1:
            raise ValueError("only one colour-profile conversion may be active")
        enabled = sorted(
            (item for item in operations if item.get("enabled", True)),
            key=lambda item: int(item.get("order", 0)),
        )
        if conversions and enabled and enabled[0] is not conversions[0]:
            raise ValueError("colour-profile conversion must be the first enabled recipe operation")
        output_target = str(profile.get("colour_profile", "srgb"))
        parameters = conversions[0].get("parameters", {}) if conversions else {}
        target = str(parameters.get("target_profile", output_target))
        if target != output_target:
            raise ValueError("recipe and output colour-profile targets must match")
        if target == "display-p3":
            raise ValueError("Display P3 output requires the future colour-engine capability gate")
        if target not in {"preserve", "srgb"}:
            raise ValueError("requested colour-profile target is unavailable")
        if target == "preserve" and len(assets) > 1:
            raise ValueError("profile preservation supports exactly one immutable raster source")
        intent_name = str(parameters.get("rendering_intent", "perceptual"))
        intent = {
            "perceptual": ImageCms.Intent.PERCEPTUAL,
            "relative_colorimetric": ImageCms.Intent.RELATIVE_COLORIMETRIC,
        }.get(intent_name)
        if intent is None:
            raise ValueError("rendering intent is unavailable")
        return target, intent, bool(parameters.get("black_point_compensation", True))

    def _apply_masks(
        self, item: Image.Image, layer: dict[str, Any], snapshot: dict[str, Any]
    ) -> Image.Image:
        content = layer.get("raster") or layer.get("vector") or {}
        mask_ids = [str(value) for value in content.get("mask_ids", [])]
        if not mask_ids:
            return item
        by_id = {str(mask.get("mask_id")): mask for mask in snapshot.get("masks", [])}
        combined = Image.new("L", item.size, 255)
        for mask_id in mask_ids:
            mask = by_id.get(mask_id)
            if mask is None:
                raise ValueError("native layer references a missing editable mask")
            if not mask.get("enabled", True):
                continue
            if mask.get("kind") != "shape" or float(mask.get("feather", 0)) != 0:
                raise ValueError("only unfeathered shape masks are approved for image export")
            path = str(mask.get("path_data") or "")
            match = re.fullmatch(
                r"(rect|ellipse)\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*"
                r"([0-9.]+)\s*,\s*([0-9.]+)\s*\)",
                path,
            )
            if match is None:
                raise ValueError("editable mask geometry is not supported")
            kind, x, y, width, height = match.groups()
            values = tuple(float(value) for value in (x, y, width, height))
            if any(value < 0 or value > 1 for value in values) or values[2] <= 0 or values[3] <= 0:
                raise ValueError("editable mask geometry is outside normalized bounds")
            bounds = (
                round(values[0] * item.width),
                round(values[1] * item.height),
                round((values[0] + values[2]) * item.width),
                round((values[1] + values[3]) * item.height),
            )
            if bounds[2] <= bounds[0] or bounds[3] <= bounds[1]:
                raise ValueError("editable mask has no visible area")
            layer_mask = Image.new("L", item.size, 0)
            draw = ImageDraw.Draw(layer_mask)
            if kind == "rect":
                draw.rectangle(bounds, fill=255)
            else:
                draw.ellipse(bounds, fill=255)
            if mask.get("inverted", False):
                layer_mask = ImageOps.invert(layer_mask)
            combined = ImageChops.multiply(combined, layer_mask)
        result = item.copy()
        result.putalpha(ImageChops.multiply(result.getchannel("A"), combined))
        return result

    def _raster_layer(
        self,
        asset: VerifiedRasterAsset,
        content: dict[str, Any],
        width: int,
        height: int,
        *,
        colour_settings: tuple[str, ImageCms.Intent, bool] = (
            "srgb",
            ImageCms.Intent.PERCEPTUAL,
            True,
        ),
        budget: ProcessingBudget | None = None,
    ) -> Image.Image:
        if (
            len(asset.data) != asset.byte_size
            or hashlib.sha256(asset.data).hexdigest() != asset.sha256
        ):
            raise ValueError("raster bytes do not match immutable source identity")
        if asset.byte_size > MAX_COMPRESSED_SOURCE_BYTES:
            raise ValueError("raster source exceeds processor byte capacity")
        if asset.bit_depth is None or asset.bit_depth > 8:
            raise ValueError("raster source lacks an approved 8-bit inspection fact")
        if asset.frame_count != 1:
            raise ValueError("raster source is not a verified single-frame image")
        if asset.colour_model not in {"grayscale", "rgb", "cmyk", "indexed"}:
            raise ValueError("raster source colour model is not verified")
        if asset.colour_model == "cmyk" and asset.has_icc_profile is not True:
            raise ValueError("CMYK source requires a validated embedded ICC profile")
        try:
            with Image.open(io.BytesIO(asset.data)) as opened:
                expected_format = {
                    "image/jpeg": "JPEG",
                    "image/png": "PNG",
                    "image/webp": "WEBP",
                    "image/tiff": "TIFF",
                }.get(asset.media_type)
                if opened.format != expected_format:
                    raise ValueError(
                        "decoded raster format does not match verified inspection facts"
                    )
                if opened.width != asset.width or opened.height != asset.height:
                    raise ValueError("raster dimensions do not match verified inspection facts")
                if int(getattr(opened, "n_frames", 1)) != asset.frame_count:
                    raise ValueError(
                        "animated sources are unavailable for deterministic still export"
                    )
                if opened.mode in {"I", "F"} or opened.mode.startswith("I;16"):
                    raise ValueError(
                        "high-precision source cannot be processed by the approved 8-bit engine"
                    )
                actual_colour_model = (
                    "cmyk"
                    if opened.mode == "CMYK"
                    else "indexed"
                    if opened.mode == "P"
                    else "grayscale"
                    if opened.mode in {"1", "L", "LA"}
                    else "rgb"
                    if opened.mode in {"RGB", "RGBA"}
                    else None
                )
                if actual_colour_model != asset.colour_model:
                    raise ValueError(
                        "decoded colour model does not match verified inspection facts"
                    )
                if bool(opened.info.get("icc_profile")) != asset.has_icc_profile:
                    raise ValueError("decoded ICC state does not match verified inspection facts")
                embedded_orientation = int(opened.getexif().get(274, 1) or 1)
                if asset.orientation is None:
                    if embedded_orientation != 1:
                        raise ValueError(
                            "source EXIF orientation lacks matching inspection evidence"
                        )
                elif embedded_orientation != asset.orientation:
                    raise ValueError("source EXIF orientation changed after inspection")
                self._guard_pixels(opened.width, opened.height)
                if budget is not None:
                    budget.check("raster-decode-start")
                opened.load()
                if budget is not None:
                    budget.check("raster-decode-complete")
                decoded = ImageOps.exif_transpose(opened)
                source = self._convert_to_working(decoded, colour_settings)
        except (UnidentifiedImageError, Image.DecompressionBombError, ImageCms.PyCMSError) as error:
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

    def _convert_to_working(
        self, source: Image.Image, colour_settings: tuple[str, ImageCms.Intent, bool]
    ) -> Image.Image:
        target, intent, black_point_compensation = colour_settings
        source_profile = source.info.get("icc_profile")
        if source.mode == "CMYK" and not source_profile:
            raise ValueError("CMYK source requires an embedded ICC profile for explicit conversion")
        if target == "preserve":
            if source.mode == "CMYK":
                raise ValueError("CMYK profile preservation is unavailable for RGBA composition")
            if source_profile:
                ImageCms.ImageCmsProfile(io.BytesIO(bytes(source_profile)))
            return source.convert("RGBA")
        if source_profile:
            input_profile = ImageCms.ImageCmsProfile(io.BytesIO(bytes(source_profile)))
            output_profile = ImageCms.ImageCmsProfile(io.BytesIO(CANONICAL_SRGB_PROFILE))
            alpha = source.getchannel("A") if "A" in source.getbands() else None
            base = source.convert("CMYK" if source.mode == "CMYK" else "RGB")
            flags = (
                ImageCms.Flags.BLACKPOINTCOMPENSATION
                if black_point_compensation
                else ImageCms.Flags.NONE
            )
            converted_image = ImageCms.profileToProfile(
                base,
                input_profile,
                output_profile,
                renderingIntent=intent,
                outputMode="RGB",
                flags=flags,
            )
            if converted_image is None:
                raise ValueError("ICC conversion did not produce an image")
            converted = converted_image.convert("RGBA")
            if alpha is not None:
                converted.putalpha(alpha)
            return converted
        return source.convert("RGBA")

    def _shape_layer(
        self, shape: dict[str, Any], width: int, height: int, *, unit: float = 1
    ) -> Image.Image:
        image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(image)
        fill = self._optional_colour(shape.get("fill"))
        stroke = self._optional_colour(shape.get("stroke"))
        raw_stroke_width = float(shape.get("stroke_width", 0))
        raw_corner_radius = float(shape.get("corner_radius", 0))
        if not math.isfinite(raw_stroke_width) or not math.isfinite(raw_corner_radius):
            raise ValueError("shape geometry contains a non-finite value")
        stroke_width = max(0, round(raw_stroke_width * unit))
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
                radius=max(0, round(raw_corner_radius * unit)),
                fill=fill,
                outline=stroke,
                width=stroke_width,
            )
        elif kind == "ellipse":
            draw.ellipse(bounds, fill=fill, outline=stroke, width=stroke_width)
        elif kind in {"line", "polygon"}:
            normalized_points = [
                (float(item["x"]), float(item["y"])) for item in shape.get("points", [])
            ]
            if any(
                not math.isfinite(x) or not math.isfinite(y) or not 0 <= x <= 1 or not 0 <= y <= 1
                for x, y in normalized_points
            ):
                raise ValueError("shape points are outside normalized bounds")
            points = [(round(x * width), round(y * height)) for x, y in normalized_points]
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
        del text, width, height
        raise ValueError(
            "native text export is unavailable until approved bundled fonts and browser-matched "
            "layout metrics are installed"
        )

    def _vector_layer(
        self, vector: dict[str, Any], width: int, height: int, *, unit: float = 1
    ) -> Image.Image:
        path = vector.get("path_data")
        if not isinstance(path, str) or not path.strip():
            raise ValueError("external vector assets require a separately approved renderer")
        path_grammar = r"[MLHVZCQmlhvzcq]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?"
        tokens = re.findall(path_grammar, path)
        residual = re.sub(path_grammar, "", path).replace(",", "")
        if not tokens or residual.strip():
            raise ValueError("vector path contains an unsupported command or token")
        points, closed = self._path_points(tokens)
        if len(points) < 2:
            raise ValueError("vector path has no drawable geometry")
        if any(not math.isfinite(x) or not math.isfinite(y) for x, y in points):
            raise ValueError("vector path contains non-finite geometry")
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
        raw_stroke_width = float(vector.get("stroke_width", 0))
        if not math.isfinite(raw_stroke_width):
            raise ValueError("vector stroke width is not finite")
        stroke_width = max(0, round(raw_stroke_width * unit))
        if closed:
            draw.polygon(scaled, fill=fill, outline=stroke, width=stroke_width)
        else:
            draw.line(scaled, fill=stroke or fill or "#3559E0", width=max(1, stroke_width))
        return image

    def _operations(
        self,
        image: Image.Image,
        operations: list[dict[str, Any]],
        budget: ProcessingBudget | None = None,
    ) -> Image.Image:
        result = image.convert("RGBA")
        for operation in sorted(operations, key=lambda item: int(item.get("order", 0))):
            if not operation.get("enabled", True):
                continue
            kind = str(operation.get("kind"))
            parameters = operation.get("parameters") or {}
            if budget is not None:
                budget.check(f"operation:{kind}")
            if kind == "orientation_normalize":
                if (
                    parameters.get("apply_exactly_once") is not True
                    or not 2 <= int(parameters.get("source_orientation", 0)) <= 8
                ):
                    raise ValueError("orientation normalization must match a measured EXIF value")
                # Immutable raster decode applies EXIF orientation exactly once before composition.
                continue
            if kind == "crop":
                result = self._crop_operation(result, parameters)
            elif kind == "rotate":
                degrees = float(parameters["degrees"])
                radians = math.radians(degrees)
                anticipated = (
                    math.ceil(
                        abs(result.width * math.cos(radians))
                        + abs(result.height * math.sin(radians))
                    ),
                    math.ceil(
                        abs(result.width * math.sin(radians))
                        + abs(result.height * math.cos(radians))
                    ),
                )
                if bool(parameters.get("expand_canvas", True)):
                    self._guard_pixels(*anticipated)
                result = result.rotate(
                    -degrees,
                    expand=bool(parameters.get("expand_canvas", True)),
                    resample=Image.Resampling.BICUBIC,
                )
            elif kind == "flip":
                if not parameters.get("horizontal") and not parameters.get("vertical"):
                    raise ValueError("flip must select at least one axis")
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
                rgb = result.convert("RGB")
                if parameters.get("method", "luminance") == "average":
                    gray = rgb.convert("L", matrix=(1 / 3, 1 / 3, 1 / 3, 0))
                elif parameters.get("method", "luminance") == "luminance":
                    gray = ImageOps.grayscale(rgb)
                else:
                    raise ValueError("grayscale method is unavailable")
                result = Image.merge("RGB", (gray, gray, gray)).convert("RGBA")
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
                    preserve_edges = int(parameters.get("preserve_edges", 70))
                    if preserve_edges < 0 or preserve_edges > 100:
                        raise ValueError("edge preservation is outside the supported range")
                    size = 3 if strength <= 35 else 5 if strength <= 70 else 7
                    denoised = result.filter(ImageFilter.MedianFilter(size=size))
                    result = Image.blend(denoised, result, preserve_edges / 100)
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
                self._guard_pixels(result.width * scale, result.height * scale)
                result = result.resize(
                    (result.width * scale, result.height * scale),
                    self._resampler(str(parameters.get("algorithm", "lanczos"))),
                )
            else:
                raise ValueError(f"operation {kind!r} has no approved deterministic processor")
            self._guard_pixels(result.width, result.height)
        return result

    def _crop_operation(self, image: Image.Image, value: dict[str, Any]) -> Image.Image:
        left = float(value["left"])
        top = float(value["top"])
        right = float(value["right"])
        bottom = float(value["bottom"])
        if not (0 <= left < right <= 1 and 0 <= top < bottom <= 1):
            raise ValueError("crop has no positive normalized area")
        box = [
            round(image.width * left),
            round(image.height * top),
            round(image.width * right),
            round(image.height * bottom),
        ]
        preset = value.get("aspect_preset")
        if preset:
            ratio = self._aspect_ratio(str(preset))
            width = box[2] - box[0]
            height = box[3] - box[1]
            if width / height > ratio:
                target_width = max(1, round(height * ratio))
                inset = (width - target_width) // 2
                box[0] += inset
                box[2] = box[0] + target_width
            else:
                target_height = max(1, round(width / ratio))
                inset = (height - target_height) // 2
                box[1] += inset
                box[3] = box[1] + target_height
        if box[2] <= box[0] or box[3] <= box[1]:
            raise ValueError("crop has no positive pixel area")
        return image.crop((box[0], box[1], box[2], box[3]))

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
            width = (
                round(float(profile["physical_width"]) * factor * ppi)
                if profile.get("physical_width") is not None
                else None
            )
            height = (
                round(float(profile["physical_height"]) * factor * ppi)
                if profile.get("physical_height") is not None
                else None
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
        budget: ProcessingBudget | None = None,
    ) -> RenderedImage:
        if int(profile.get("bit_depth", 8)) != 8:
            raise ValueError("16-bit colour output requires the future libvips capability gate")
        colour_profile = str(profile.get("colour_profile", "srgb"))
        if colour_profile == "display-p3":
            raise ValueError("Display P3 output requires the future colour-engine capability gate")
        source_icc = self._source_icc(assets)
        icc = CANONICAL_SRGB_PROFILE if colour_profile == "srgb" else source_icc
        if profile.get("alpha_behavior") == "flatten":
            image = self._flatten(image, str(profile.get("background") or "#FFFFFF"))
        format_name = str(profile["format"])
        output = io.BytesIO()
        kwargs: dict[str, Any] = {}
        if icc is not None:
            kwargs["icc_profile"] = icc
        if profile.get("physical_width") is not None or profile.get("physical_height") is not None:
            ppi = int(profile["ppi"])
            kwargs["dpi"] = (ppi, ppi)
        if format_name == "jpeg":
            if profile.get("lossless"):
                raise ValueError("JPEG does not provide a lossless output mode")
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
        if budget is not None:
            budget.check("encoder-write")
        save_image.save(output, **kwargs)
        data = output.getvalue()
        if not data or len(data) > MAX_OUTPUT_BYTES:
            raise ValueError("encoded output exceeds the bounded object limit")
        metadata_evidence = self._verify_encoded(
            data,
            format_name,
            image.width,
            image.height,
            profile,
            assets,
            expected_icc=icc,
        )
        if budget is not None:
            budget.check("encoder-verify")
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
            metadata_evidence,
            self._histogram(image),
            hashlib.sha256(parameters).hexdigest(),
        )

    @staticmethod
    def _source_icc(assets: dict[str, VerifiedRasterAsset]) -> bytes | None:
        if not assets:
            return None
        profiles: list[bytes] = []
        for asset in assets.values():
            with Image.open(io.BytesIO(asset.data)) as opened:
                raw = opened.info.get("icc_profile")
                if raw:
                    profile = bytes(raw)
                    ImageCms.ImageCmsProfile(io.BytesIO(profile))
                    profiles.append(profile)
        if not profiles:
            return None
        first = profiles[0]
        if any(profile != first for profile in profiles[1:]):
            raise ValueError("profile preservation cannot combine different source ICC profiles")
        return first

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
        return safe.tobytes() if len(safe) else None

    def _verify_encoded(
        self,
        data: bytes,
        format_name: str,
        width: int,
        height: int,
        profile: dict[str, Any],
        assets: dict[str, VerifiedRasterAsset],
        *,
        expected_icc: bytes | None,
    ) -> dict[str, str]:
        expected = {"jpeg": "JPEG", "png": "PNG", "webp": "WEBP", "tiff": "TIFF"}[format_name]
        source = self._metadata_inventory(assets)
        try:
            with Image.open(io.BytesIO(data)) as opened:
                if opened.format != expected or opened.size != (width, height):
                    raise ValueError("encoded output failed format verification")
                exif = opened.getexif()
                if 34853 in exif or exif.get(274, 1) != 1:
                    raise ValueError(
                        "encoded output retained prohibited location or orientation metadata"
                    )
                allowed_exif = {274}
                policy = profile.get("metadata_policy") or {}
                if policy.get("preserve_copyright", True):
                    allowed_exif.add(33432)
                if policy.get("preserve_description"):
                    allowed_exif.add(270)
                if policy.get("preserve_capture_time"):
                    allowed_exif.add(36867)
                if policy.get("preserve_camera"):
                    allowed_exif.update({271, 272})
                tiff_structural_tags = {
                    256,
                    257,
                    258,
                    259,
                    262,
                    273,
                    277,
                    278,
                    279,
                    282,
                    283,
                    284,
                    296,
                    338,
                    339,
                    34675,
                }
                if any(
                    tag not in allowed_exif
                    and (format_name != "tiff" or tag not in tiff_structural_tags)
                    for tag in exif
                ):
                    raise ValueError("encoded output retained an unapproved EXIF category")
                raw = data.lower()
                actual_icc = opened.info.get("icc_profile")
                if expected_icc is None and actual_icc:
                    raise ValueError("encoded output unexpectedly contains an ICC profile")
                if expected_icc is not None and bytes(actual_icc or b"") != expected_icc:
                    raise ValueError(
                        "encoded output ICC profile does not match the selected target"
                    )
                prohibited = {
                    "xmp": b"http://ns.adobe.com/xap/1.0/" in raw or b"xml:com.adobe.xmp" in raw,
                    "iptc": b"photoshop 3.0" in raw or bool(opened.info.get("iptc")),
                    "comments": "comment" in opened.info
                    or (format_name == "jpeg" and b"\xff\xfe" in data),
                    "maker_notes": 37500 in exif,
                    "private_blocks": any(
                        tag not in allowed_exif
                        and (format_name != "tiff" or tag not in tiff_structural_tags)
                        for tag in exif
                    ),
                    "software_device": 305 in exif
                    or (not policy.get("preserve_camera") and (271 in exif or 272 in exif)),
                    "embedded_thumbnails": 513 in exif or 514 in exif,
                }
                retained = [name for name, present in prohibited.items() if present]
                if retained:
                    raise ValueError(
                        f"encoded output retained prohibited metadata: {', '.join(retained)}"
                    )
                if (
                    profile.get("physical_width") is not None
                    or profile.get("physical_height") is not None
                ):
                    expected_ppi = int(profile["ppi"])
                    dpi = opened.info.get("dpi")
                    if not dpi or any(abs(float(value) - expected_ppi) > 1 for value in dpi[:2]):
                        raise ValueError("encoded output did not retain the requested physical PPI")
            with Image.open(io.BytesIO(data)) as verification:
                verification.verify()
        except (OSError, RuntimeError) as error:
            raise ValueError("encoded output failed decoder verification") from error
        policy = profile.get("metadata_policy") or {}
        kept_exif = any(
            (
                policy.get("preserve_copyright", True) and source["copyright"],
                policy.get("preserve_description") and source["description"],
                policy.get("preserve_capture_time") and source["capture_time"],
                policy.get("preserve_camera") and source["camera"],
            )
        )
        colour_profile = str(profile.get("colour_profile", "srgb"))
        return {
            "exif": "preserved-approved-fields"
            if kept_exif
            else ("removed" if source["exif"] else "absent"),
            "gps": "removed" if source["gps"] else "absent",
            "orientation": "normalized" if source["orientation"] else "absent",
            "xmp": "removed" if source["xmp"] else "absent",
            "iptc": "removed" if source["iptc"] else "absent",
            "comments": "removed" if source["comments"] else "absent",
            "maker_notes": "removed" if source["maker_notes"] else "absent",
            "private_blocks": "removed" if source["private_blocks"] else "absent",
            "software_device": (
                "preserved-approved-fields"
                if policy.get("preserve_camera") and source["camera"]
                else "removed"
                if source["software_device"]
                else "absent"
            ),
            "embedded_thumbnails": "removed" if source["embedded_thumbnails"] else "absent",
            "icc_profiles": (
                "converted-to-srgb"
                if colour_profile == "srgb" and source["icc_profiles"]
                else "assumed-srgb-and-tagged"
                if colour_profile == "srgb"
                else "preserved"
            ),
        }

    @staticmethod
    def _metadata_inventory(assets: dict[str, VerifiedRasterAsset]) -> dict[str, bool]:
        result = {
            "exif": False,
            "gps": False,
            "orientation": False,
            "xmp": False,
            "iptc": False,
            "comments": False,
            "maker_notes": False,
            "private_blocks": False,
            "software_device": False,
            "embedded_thumbnails": False,
            "icc_profiles": False,
            "copyright": False,
            "description": False,
            "capture_time": False,
            "camera": False,
        }
        for asset in assets.values():
            extension = {
                "image/jpeg": "jpg",
                "image/png": "png",
                "image/webp": "webp",
                "image/tiff": "tiff",
            }.get(asset.media_type)
            if extension is None:
                raise ValueError("metadata inspection received an unsupported raster format")
            inspected = inspect_bytes(
                asset.data,
                display_name=f"source.{extension}",
                expected_media_type=asset.media_type,
            )
            if not inspected.accepted or inspected.facts is None:
                raise ValueError("metadata inspection could not revalidate immutable source bytes")
            categories = set(inspected.facts.sensitive_metadata)
            result["exif"] |= "exif" in categories
            result["gps"] |= "gps" in categories
            result["xmp"] |= "xmp" in categories
            result["iptc"] |= "iptc" in categories
            result["comments"] |= "comments" in categories
            result["maker_notes"] |= "maker_notes" in categories
            result["software_device"] |= "software_device" in categories
            result["embedded_thumbnails"] |= "embedded_thumbnails" in categories
            result["icc_profiles"] |= bool(inspected.facts.has_icc_profile)
            result["orientation"] |= bool(
                inspected.facts.orientation and inspected.facts.orientation != 1
            )
            with Image.open(io.BytesIO(asset.data)) as opened:
                exif = opened.getexif()
                raw = asset.data.lower()
                exif_ifd = exif.get_ifd(34665) if 34665 in exif else {}
                result["exif"] |= bool(exif)
                result["gps"] |= bool(exif.get_ifd(34853)) if 34853 in exif else False
                result["orientation"] |= int(exif.get(274, 1)) != 1
                result["xmp"] |= (
                    b"http://ns.adobe.com/xap/1.0/" in raw or b"xml:com.adobe.xmp" in raw
                )
                result["iptc"] |= b"photoshop 3.0" in raw or bool(opened.info.get("iptc"))
                result["comments"] |= "comment" in opened.info or b"\xff\xfe" in asset.data
                result["maker_notes"] |= 37500 in exif or 37500 in exif_ifd
                public_tags = {270, 271, 272, 274, 33432, 34853, 36867, 37500, 513, 514}
                result["private_blocks"] |= any(tag not in public_tags for tag in exif) or bool(
                    set(exif_ifd) - {36867, 37500}
                )
                result["software_device"] |= 305 in exif or 271 in exif or 272 in exif
                result["embedded_thumbnails"] |= 513 in exif or 514 in exif
                result["icc_profiles"] |= bool(opened.info.get("icc_profile"))
                result["copyright"] |= 33432 in exif
                result["description"] |= 270 in exif
                result["capture_time"] |= 36867 in exif
                result["camera"] |= 271 in exif or 272 in exif
        return result

    @staticmethod
    def _histogram(image: Image.Image) -> dict[str, Any]:
        sample = image.copy()
        sample.thumbnail((256, 256), Image.Resampling.BILINEAR)
        rgb = sample.convert("RGB")
        channels = rgb.histogram()
        bins: list[list[int]] = []
        for offset in (0, 256, 512):
            bins.append(
                [sum(channels[offset + start : offset + start + 4]) for start in range(0, 256, 4)]
            )
        luminance = ImageOps.grayscale(rgb).histogram()
        samples = max(1, sample.width * sample.height)
        return {
            "red": bins[0],
            "green": bins[1],
            "blue": bins[2],
            "shadow_clipping": sum(luminance[:3]) / samples > 0.01,
            "highlight_clipping": sum(luminance[253:]) / samples > 0.01,
        }

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
        if value is None:
            return fallback
        if not isinstance(value, str) or not re.fullmatch(
            r"#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?", value
        ):
            raise ValueError("colour value is not a supported hexadecimal colour")
        return value

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
        if value not in resamplers:
            raise ValueError("resampling algorithm is unavailable")
        return resamplers[value]

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
        alpha = image.getchannel("A") if "A" in image.getbands() else None
        hsv = image.convert("RGB").convert("HSV")
        hue, saturation, value = hsv.split()
        saturation = saturation.point(
            lambda item: round(max(0, min(255, item + amount * (255 - item))))
        )
        result = Image.merge("HSV", (hue, saturation, value)).convert("RGBA")
        if alpha is not None:
            result.putalpha(alpha)
        return result

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
        if value.get("aspect_locked", True) is not True:
            raise ValueError("unlocked resize is unavailable in this build")
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
        preset = value.get("aspect_preset")
        if preset:
            ratio = self._aspect_ratio(str(preset))
            height = max(1, round(width / ratio))
        target = (self._bounded_dimension(width), self._bounded_dimension(height))
        self._guard_pixels(*target)
        resampler = self._resampler(str(value.get("algorithm", "lanczos")))
        fit = str(value.get("fit", "contain"))
        if fit == "cover":
            return ImageOps.fit(image, target, method=resampler)
        if fit != "contain":
            raise ValueError("resize fit mode is unavailable")
        contained = ImageOps.contain(image, target, method=resampler)
        result = Image.new("RGBA", target, (0, 0, 0, 0))
        result.alpha_composite(
            contained,
            ((target[0] - contained.width) // 2, (target[1] - contained.height) // 2),
        )
        return result

    @staticmethod
    def _aspect_ratio(value: str) -> float:
        match = re.fullmatch(r"([1-9][0-9]*):([1-9][0-9]*)", value)
        if match is None:
            raise ValueError("aspect preset is unavailable")
        return int(match.group(1)) / int(match.group(2))

    def _flatten(self, image: Image.Image, background: str) -> Image.Image:
        base = Image.new("RGBA", image.size, self._colour(background, "#FFFFFF"))
        base.alpha_composite(image)
        return base.convert("RGB").convert("RGBA")

    @staticmethod
    def _composite(canvas: Image.Image, item: Image.Image, left: int, top: int, mode: str) -> None:
        if mode == "normal":
            canvas.alpha_composite(item, (left, top))
            return
        x0, y0 = max(0, left), max(0, top)
        x1, y1 = min(canvas.width, left + item.width), min(canvas.height, top + item.height)
        if x1 <= x0 or y1 <= y0:
            return
        source = item.crop((x0 - left, y0 - top, x1 - left, y1 - top))
        base = canvas.crop((x0, y0, x1, y1))
        source_alpha = source.getchannel("A")
        base_alpha = base.getchannel("A")
        base_rgb, source_rgb = base.convert("RGB"), source.convert("RGB")
        if mode in {"multiply", "darken"}:
            mixed = (
                ImageChops.multiply(base_rgb, source_rgb)
                if mode == "multiply"
                else ImageChops.darker(base_rgb, source_rgb)
            )
        elif mode in {"screen", "lighten"}:
            mixed = (
                ImageChops.screen(base_rgb, source_rgb)
                if mode == "screen"
                else ImageChops.lighter(base_rgb, source_rgb)
            )
        elif mode == "overlay":
            mixed = ImageChops.overlay(base_rgb, source_rgb)
        else:
            raise ValueError("blend mode has no approved export implementation")
        # On a transparent backdrop the source colour is authoritative; as backdrop
        # alpha increases, the selected blend function contributes proportionally.
        effective = Image.composite(mixed, source_rgb, base_alpha).convert("RGBA")
        effective.putalpha(source_alpha)
        base.alpha_composite(effective)
        canvas.paste(base, (x0, y0))

    @staticmethod
    def _path_points(tokens: list[str]) -> tuple[list[tuple[float, float]], bool]:
        points: list[tuple[float, float]] = []
        index = 0
        command = ""
        current = (0.0, 0.0)
        start = current
        closed = False

        def coordinate(position: int) -> float:
            if position >= len(tokens) or tokens[position].isalpha():
                raise ValueError("vector path coordinate is incomplete")
            return float(tokens[position])

        def absolute(x: float, y: float, relative: bool) -> tuple[float, float]:
            return (current[0] + x, current[1] + y) if relative else (x, y)

        while index < len(tokens):
            token = tokens[index]
            if token.isalpha():
                command = token
                index += 1
                if command.lower() == "z":
                    if not points:
                        raise ValueError("vector path close command appears before geometry")
                    if points[-1] != start:
                        points.append(start)
                    current = start
                    closed = True
                continue
            if command.lower() in {"m", "l"}:
                x, y = coordinate(index), coordinate(index + 1)
                index += 2
                current = absolute(x, y, command.islower())
                points.append(current)
                if command.lower() == "m":
                    start = current
                    command = "l" if command.islower() else "L"
            elif command.lower() == "h":
                x = coordinate(index)
                index += 1
                current = (current[0] + x if command.islower() else x, current[1])
                points.append(current)
            elif command.lower() == "v":
                y = coordinate(index)
                index += 1
                current = (current[0], current[1] + y if command.islower() else y)
                points.append(current)
            elif command.lower() == "c":
                values = [coordinate(index + offset) for offset in range(6)]
                index += 6
                control_one = absolute(values[0], values[1], command.islower())
                control_two = absolute(values[2], values[3], command.islower())
                end = absolute(values[4], values[5], command.islower())
                origin = current
                for sample in range(1, 25):
                    ratio = sample / 24
                    inverse = 1 - ratio
                    points.append(
                        (
                            inverse**3 * origin[0]
                            + 3 * inverse**2 * ratio * control_one[0]
                            + 3 * inverse * ratio**2 * control_two[0]
                            + ratio**3 * end[0],
                            inverse**3 * origin[1]
                            + 3 * inverse**2 * ratio * control_one[1]
                            + 3 * inverse * ratio**2 * control_two[1]
                            + ratio**3 * end[1],
                        )
                    )
                current = end
            elif command.lower() == "q":
                values = [coordinate(index + offset) for offset in range(4)]
                index += 4
                control = absolute(values[0], values[1], command.islower())
                end = absolute(values[2], values[3], command.islower())
                origin = current
                for sample in range(1, 25):
                    ratio = sample / 24
                    inverse = 1 - ratio
                    points.append(
                        (
                            inverse**2 * origin[0]
                            + 2 * inverse * ratio * control[0]
                            + ratio**2 * end[0],
                            inverse**2 * origin[1]
                            + 2 * inverse * ratio * control[1]
                            + ratio**2 * end[1],
                        )
                    )
                current = end
            else:
                raise ValueError("vector path command is not supported")
        return points, closed

    @classmethod
    def _simple_path_points(cls, tokens: list[str]) -> list[tuple[float, float]]:
        return cls._path_points(tokens)[0]
