"""Pillow implementation of the imaging engine.

Deterministic by construction: every encoder setting that affects output bytes is
pinned explicitly rather than left to a library default that could change between
versions. PNG uses a fixed compression level with no ancillary metadata; JPEG
uses a fixed quality and subsampling with no EXIF carried over.

The decompression-bomb guard is set even though POC-003 already rejects bombs
from the header, because defence in depth is cheap here and this engine may later
be handed bytes from a path that did not go through inspection.
"""

from __future__ import annotations

from typing import Any, Literal

from PIL import Image, ImageEnhance, ImageFilter, ImageOps, ImageStat

from ipw.processors.standard.engine import EngineError, ResampleFilter

__all__ = ["MAX_IMAGE_PIXELS", "PillowEngine"]

MAX_IMAGE_PIXELS = 400_000_000
"""Matches SafetyPolicy.extreme_max_pixels. Pillow raises above this."""

Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS

_RESAMPLE = {
    "bicubic": Image.Resampling.BICUBIC,
    "lanczos": Image.Resampling.LANCZOS,
    "nearest": Image.Resampling.NEAREST,
}

# Clockwise degrees -> Pillow transpose. Using TRANSPOSE constants rather than
# rotate() keeps 90/180/270 lossless: pixels move, none are resampled.
_ROTATION = {
    90: Image.Transpose.ROTATE_270,  # Pillow rotates anticlockwise
    180: Image.Transpose.ROTATE_180,
    270: Image.Transpose.ROTATE_90,
}

_FLIP = {
    "horizontal": Image.Transpose.FLIP_LEFT_RIGHT,
    "vertical": Image.Transpose.FLIP_TOP_BOTTOM,
}


class PillowImage:
    """Adapter giving a ``PIL.Image`` the engine's image interface."""

    __slots__ = ("image",)

    def __init__(self, image: Image.Image) -> None:
        self.image = image

    @property
    def width(self) -> int:
        return self.image.width

    @property
    def height(self) -> int:
        return self.image.height

    @property
    def bands(self) -> int:
        return len(self.image.getbands())

    @property
    def has_alpha(self) -> bool:
        return self.image.mode in {"RGBA", "LA", "PA"} or "transparency" in self.image.info


def _percent_to_factor(percent: int) -> float:
    """Map a signed percentage delta to a Pillow enhancement factor.

    ``0`` is identity, ``+100`` doubles, ``-100`` removes the property entirely.
    The float appears only inside the engine; settings and recorded measurements
    stay integer.
    """
    return 1.0 + (percent / 100.0)


class PillowEngine:
    """Pillow-backed pixel operations."""

    name = "pillow"
    deterministic = True

    @property
    def version(self) -> str:
        from PIL import __version__

        return str(__version__)

    @property
    def available(self) -> bool:
        return True

    # -- lifecycle --------------------------------------------------------

    def load(self, path: str) -> PillowImage:
        try:
            with Image.open(path) as handle:
                handle.load()
                # **Turn the picture the way the camera said to.**
                #
                # A phone in portrait writes landscape pixels plus an EXIF flag
                # meaning "rotate this to display". Viewers honour the flag, so the
                # file looks upright everywhere until a tool reads the pixels,
                # ignores the flag, and writes the result without it - which is what
                # happened here: a portrait photo came back on its side, at the
                # right dimensions, with nothing reporting an error.
                #
                # Both engines strip metadata so output is reproducible. Stripping
                # orientation without applying it first is precisely how the picture
                # gets lost, so it is applied at the point of decode and every
                # operation downstream sees the image the way a person sees it.
                #
                # A file with no orientation tag, or one set to 1, comes back
                # untouched, so nothing that was already correct moves.
                upright = ImageOps.exif_transpose(handle)
                # copy() detaches from the file so the handle closes immediately;
                # the source is never held open or written.
                return PillowImage((upright if upright is not None else handle).copy())
        except Image.DecompressionBombError as exc:
            msg = f"decompression bomb refused by the decoder: {exc}"
            raise EngineError(msg) from exc
        except (OSError, ValueError) as exc:
            msg = f"could not decode image: {type(exc).__name__}"
            raise EngineError(msg) from exc

    def save(
        self, image: PillowImage, path: str, media_type: str, quality: int, *, optimise: bool
    ) -> None:
        target = image.image
        try:
            if media_type == "image/png":
                if target.mode not in {"RGB", "RGBA", "L", "LA", "P"}:
                    target = target.convert("RGBA" if image.has_alpha else "RGB")
                target.save(
                    path,
                    format="PNG",
                    optimize=optimise,
                    compress_level=6,  # pinned: affects output bytes
                )
            elif media_type == "image/jpeg":
                # **CMYK is a JPEG mode, and refusing it turned print work away.**
                #
                # This was an allowlist of RGB and L, so a CMYK JPEG - what a
                # print shop or a textile bureau sends as a matter of course -
                # could not even be resized. Worse, it was refused with "JPEG
                # has no alpha channel", which is about transparency that CMYK
                # does not have, so the message sent somebody looking for a
                # problem that was not there.
                #
                # The libvips engine had this right all along: it refuses on
                # actual alpha. Two engines disagreeing about which files are
                # acceptable is its own bug - the same upload succeeded or
                # failed depending on which one was installed.
                if image.has_alpha:
                    msg = (
                        "JPEG has no alpha channel; flatten the image onto a background "
                        "before converting"
                    )
                    raise EngineError(msg)
                if target.mode not in {"RGB", "L", "CMYK"}:
                    msg = (
                        f"JPEG cannot store {target.mode} data; convert the image to RGB "
                        f"or greyscale first"
                    )
                    raise EngineError(msg)
                target.save(
                    path,
                    format="JPEG",
                    quality=quality,
                    optimize=optimise,
                    subsampling=0,  # pinned: 4:4:4, no chroma loss beyond quality
                    progressive=False,
                )
            else:
                msg = f"unsupported output media type: {media_type}"
                raise EngineError(msg)
        except OSError as exc:
            msg = f"could not encode image: {type(exc).__name__}"
            raise EngineError(msg) from exc

    # -- geometry ---------------------------------------------------------

    def resize(
        self, image: PillowImage, width: int, height: int, resample: ResampleFilter
    ) -> PillowImage:
        if width <= 0 or height <= 0:
            msg = f"resize target must be positive, got {width}x{height}"
            raise EngineError(msg)
        return PillowImage(image.image.resize((width, height), _RESAMPLE[resample]))

    def crop(self, image: PillowImage, x: int, y: int, width: int, height: int) -> PillowImage:
        if x + width > image.width or y + height > image.height:
            msg = (
                f"crop box {width}x{height} at ({x},{y}) extends beyond the "
                f"{image.width}x{image.height} source"
            )
            raise EngineError(msg)
        return PillowImage(image.image.crop((x, y, x + width, y + height)))

    def rotate(self, image: PillowImage, degrees: int) -> PillowImage:
        if degrees not in _ROTATION:
            msg = f"rotation must be 90, 180 or 270 degrees, got {degrees}"
            raise EngineError(msg)
        return PillowImage(image.image.transpose(_ROTATION[degrees]))

    def flip(self, image: PillowImage, axis: Literal["horizontal", "vertical"]) -> PillowImage:
        return PillowImage(image.image.transpose(_FLIP[axis]))

    # -- tone and colour --------------------------------------------------

    def adjust(
        self,
        image: PillowImage,
        *,
        brightness_percent: int,
        contrast_percent: int,
        saturation_percent: int,
        exposure_percent: int,
        white_balance: str,
    ) -> PillowImage:
        result = image.image
        if result.mode not in {"RGB", "RGBA", "L", "LA"}:
            result = result.convert("RGBA" if image.has_alpha else "RGB")

        # Exposure and brightness both scale luminance; applying exposure first
        # keeps the order fixed and therefore the output reproducible.
        if exposure_percent:
            result = ImageEnhance.Brightness(result).enhance(_percent_to_factor(exposure_percent))
        if brightness_percent:
            result = ImageEnhance.Brightness(result).enhance(_percent_to_factor(brightness_percent))
        if contrast_percent:
            result = ImageEnhance.Contrast(result).enhance(_percent_to_factor(contrast_percent))
        if saturation_percent and result.mode not in {"L", "LA"}:
            result = ImageEnhance.Color(result).enhance(_percent_to_factor(saturation_percent))
        if white_balance != "none":
            result = self._white_balance(result, white_balance)
        return PillowImage(result)

    @staticmethod
    def _white_balance(image: Image.Image, mode: str) -> Image.Image:
        """Grey-world white balance, plus fixed illuminant presets.

        Non-generative and fully determined by the source statistics: each channel
        is scaled so the mean becomes neutral. No detail is invented.
        """
        if image.mode in {"L", "LA"}:
            return image  # greyscale has no colour cast to correct

        working = image.convert("RGB") if image.mode != "RGB" else image
        if mode == "auto":
            means = ImageStat.Stat(working).mean[:3]
            target = sum(means) / 3.0
            scales = [target / m if m > 0 else 1.0 for m in means]
        elif mode == "daylight":
            scales = [1.0, 1.0, 1.05]
        elif mode == "tungsten":
            scales = [0.92, 1.0, 1.18]
        else:
            msg = f"unknown white balance mode: {mode}"
            raise EngineError(msg)

        lut: list[int] = []
        for scale in scales:
            lut.extend(min(255, max(0, round(value * scale))) for value in range(256))
        balanced = working.point(lut)

        if image.mode == "RGBA":
            balanced.putalpha(image.getchannel("A"))
        return balanced

    # -- detail -----------------------------------------------------------

    def straighten_page(self, image: PillowImage, corners: Any | None) -> PillowImage:
        """Detect the page when no corners are given, then map it to a rectangle."""
        from ipw.processors.standard.perspective import Corners, detect_page, flatten_page

        if corners is None:
            found = detect_page(image.image)
            if found is None:
                msg = (
                    "no page could be found in this photograph. Give the four corners, "
                    "or photograph the page against a darker background."
                )
                raise EngineError(msg)
            quad = found.corners
        else:
            points = [(float(x), float(y)) for x, y in corners]
            quad = Corners(*points)

        return PillowImage(flatten_page(image.image, quad))

    def enlarge(
        self, image: PillowImage, *, scale: int, material: str, iterations: int
    ) -> PillowImage:
        """Shared with the libvips engine - one implementation, two callers."""
        from ipw.processors.standard.upscale import upscale as run

        bigger, _ = run(image.image, scale, iterations=iterations, material=material)
        return PillowImage(bigger)

    def clean_document(
        self, image: PillowImage, *, strength_percent: int, whiten: bool, keep_ink_colour: bool
    ) -> PillowImage:
        """Both engines share one implementation, deliberately.

        The correction is array arithmetic - estimate the light, divide it out -
        and neither Pillow nor libvips has an operation for it. Writing it twice
        would give two engines that disagree about what a cleaned page looks
        like, which is the bug already found in JPEG saving. One function, two
        callers, identical output.
        """
        from ipw.processors.standard.document import clean_document as run

        cleaned, _ = run(
            image.image,
            whiten=whiten,
            strength_percent=strength_percent,
            keep_ink_colour=keep_ink_colour,
        )
        return PillowImage(cleaned)

    def sharpen(self, image: PillowImage, amount_percent: int, radius_x100: int) -> PillowImage:
        if amount_percent == 0:
            return image
        return PillowImage(
            image.image.filter(
                ImageFilter.UnsharpMask(
                    radius=radius_x100 / 100.0,
                    percent=amount_percent,
                    threshold=3,  # pinned: leaves flat areas untouched
                )
            )
        )

    def denoise(self, image: PillowImage, strength_percent: int) -> PillowImage:
        if strength_percent == 0:
            return image
        # Median filter size grows with strength: 3 up to 50%, then 5. Odd sizes
        # only, which is what MedianFilter requires.
        size = 3 if strength_percent <= 50 else 5
        return PillowImage(image.image.filter(ImageFilter.MedianFilter(size=size)))

    # -- format -----------------------------------------------------------

    def flatten_alpha(self, image: PillowImage, background: str) -> PillowImage:
        if not image.has_alpha:
            return image
        colour = (
            int(background[1:3], 16),
            int(background[3:5], 16),
            int(background[5:7], 16),
        )
        source = image.image.convert("RGBA")
        canvas = Image.new("RGB", source.size, colour)
        canvas.paste(source, mask=source.getchannel("A"))
        return PillowImage(canvas)
