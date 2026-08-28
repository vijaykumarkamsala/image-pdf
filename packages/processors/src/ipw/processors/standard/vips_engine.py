"""libvips implementation of the imaging engine.

The comparator to Pillow (D-045). libvips is demand-driven and streaming, so its
memory profile on large images is dramatically better - which is exactly what
POC-012's tiling and 100 MB professional path will need to measure.

**Availability is a runtime property, not an install-time one.** pyvips is only a
binding; the native library comes from a package manager or, on Windows, from
``tools/install_libvips.py``. When it is absent this engine reports
``available = False`` and the processor returns a normalised
``PROCESSOR.UNAVAILABLE`` failure. A host without libvips still runs the whole
suite - it simply records that one candidate could not execute there, which is
how a benchmark should behave.

Output will not be byte-identical to Pillow's: different resampling
implementations and different encoders. That is the point of running both, and it
is why each engine owns its own golden fixtures.
"""

from __future__ import annotations

from typing import Any, Literal

from ipw.processors.standard.engine import EngineError, ResampleFilter
from ipw.processors.standard.vips_runtime import libvips_version, load_pyvips

__all__ = ["VipsEngine"]

# libvips kernel names for our resample filters.
_KERNEL = {"bicubic": "cubic", "lanczos": "lanczos3", "nearest": "nearest"}


class VipsImage:
    """Adapter giving a ``pyvips.Image`` the engine's image interface."""

    __slots__ = ("image",)

    def __init__(self, image: Any) -> None:
        self.image = image

    @property
    def width(self) -> int:
        return int(self.image.width)

    @property
    def height(self) -> int:
        return int(self.image.height)

    @property
    def bands(self) -> int:
        return int(self.image.bands)

    @property
    def has_alpha(self) -> bool:
        return bool(self.image.hasalpha())


class VipsEngine:
    """libvips-backed pixel operations."""

    name = "libvips"
    deterministic = True

    @property
    def version(self) -> str:
        return libvips_version() or "unavailable"

    @property
    def available(self) -> bool:
        return load_pyvips() is not None

    def _vips(self) -> Any:
        module = load_pyvips()
        if module is None:
            msg = (
                "libvips is not available on this host. Install it with "
                "'python tools/install_libvips.py' on Windows, or your package "
                "manager elsewhere."
            )
            raise EngineError(msg)
        return module

    # -- lifecycle --------------------------------------------------------

    def load(self, path: str) -> VipsImage:
        vips = self._vips()
        try:
            # access="sequential" would stream, but several operations below need
            # random access; "random" keeps behaviour correct and comparable.
            loaded = vips.Image.new_from_file(path, access="random")
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
            loaded = loaded.autorot()
            return VipsImage(loaded)
        except Exception as exc:
            msg = f"could not decode image: {type(exc).__name__}"
            raise EngineError(msg) from exc

    def save(
        self, image: VipsImage, path: str, media_type: str, quality: int, *, optimise: bool
    ) -> None:
        try:
            if media_type == "image/png":
                image.image.pngsave(path, compression=6, effort=1 if optimise else 0)
            elif media_type == "image/jpeg":
                if image.has_alpha:
                    msg = (
                        "JPEG has no alpha channel; flatten the image onto a background "
                        "before converting"
                    )
                    raise EngineError(msg)
                image.image.jpegsave(
                    path,
                    Q=quality,
                    subsample_mode="off",  # 4:4:4, matching the Pillow engine
                    optimize_coding=optimise,
                    interlace=False,
                    strip=True,  # no metadata carried over, so output is reproducible
                )
            else:
                msg = f"unsupported output media type: {media_type}"
                raise EngineError(msg)
        except EngineError:
            raise
        except Exception as exc:
            msg = f"could not encode image: {type(exc).__name__}"
            raise EngineError(msg) from exc

    # -- geometry ---------------------------------------------------------

    def resize(
        self, image: VipsImage, width: int, height: int, resample: ResampleFilter
    ) -> VipsImage:
        if width <= 0 or height <= 0:
            msg = f"resize target must be positive, got {width}x{height}"
            raise EngineError(msg)
        horizontal = width / image.width
        vertical = height / image.height
        resized = image.image.resize(horizontal, vscale=vertical, kernel=_KERNEL[resample])
        # Rounding inside libvips can land a pixel out; crop to the exact target so
        # both engines agree on dimensions even when they disagree on pixels.
        if resized.width != width or resized.height != height:
            resized = resized.crop(0, 0, min(width, resized.width), min(height, resized.height))
        return VipsImage(resized)

    def crop(self, image: VipsImage, x: int, y: int, width: int, height: int) -> VipsImage:
        if x + width > image.width or y + height > image.height:
            msg = (
                f"crop box {width}x{height} at ({x},{y}) extends beyond the "
                f"{image.width}x{image.height} source"
            )
            raise EngineError(msg)
        return VipsImage(image.image.crop(x, y, width, height))

    def rotate(self, image: VipsImage, degrees: int) -> VipsImage:
        vips = self._vips()
        angles = {
            90: vips.enums.Angle.D90,
            180: vips.enums.Angle.D180,
            270: vips.enums.Angle.D270,
        }
        if degrees not in angles:
            msg = f"rotation must be 90, 180 or 270 degrees, got {degrees}"
            raise EngineError(msg)
        return VipsImage(image.image.rot(angles[degrees]))

    def flip(self, image: VipsImage, axis: Literal["horizontal", "vertical"]) -> VipsImage:
        vips = self._vips()
        direction = (
            vips.enums.Direction.HORIZONTAL
            if axis == "horizontal"
            else vips.enums.Direction.VERTICAL
        )
        return VipsImage(image.image.flip(direction))

    # -- tone and colour --------------------------------------------------

    def adjust(
        self,
        image: VipsImage,
        *,
        brightness_percent: int,
        contrast_percent: int,
        saturation_percent: int,
        exposure_percent: int,
        white_balance: str,
    ) -> VipsImage:
        result = image.image
        alpha = result.extract_band(result.bands - 1) if image.has_alpha else None
        if alpha is not None:
            result = result.extract_band(0, n=result.bands - 1)

        luminance_gain = (1.0 + exposure_percent / 100.0) * (1.0 + brightness_percent / 100.0)
        contrast_gain = 1.0 + contrast_percent / 100.0

        # Contrast pivots around mid-grey; brightness is a plain gain. Applying
        # them as one linear pass keeps the order fixed and the result stable.
        if luminance_gain != 1.0 or contrast_gain != 1.0:
            scale = luminance_gain * contrast_gain
            offset = 128.0 * (1.0 - contrast_gain) * luminance_gain
            result = (result * scale + offset).cast("uchar")

        if saturation_percent and result.bands >= 3:
            saturation_gain = 1.0 + saturation_percent / 100.0
            colour = result.colourspace("lch")
            chroma = colour.extract_band(1) * saturation_gain
            result = (
                colour.extract_band(0)
                .bandjoin([chroma, colour.extract_band(2)])
                .copy(interpretation="lch")
                .colourspace("srgb")
            )

        if white_balance != "none":
            result = self._white_balance(result, white_balance)

        if alpha is not None:
            result = result.bandjoin(alpha)
        return VipsImage(result)

    @staticmethod
    def _white_balance(image: Any, mode: str) -> Any:
        """Grey-world white balance, matching the Pillow engine's approach."""
        if image.bands < 3:
            return image
        if mode == "auto":
            means = [image.extract_band(i).avg() for i in range(3)]
            target = sum(means) / 3.0
            scales = [target / m if m > 0 else 1.0 for m in means]
        elif mode == "daylight":
            scales = [1.0, 1.0, 1.05]
        elif mode == "tungsten":
            scales = [0.92, 1.0, 1.18]
        else:
            msg = f"unknown white balance mode: {mode}"
            raise EngineError(msg)
        return (image * scales).cast("uchar")

    # -- detail -----------------------------------------------------------

    def print_ready(
        self,
        image: VipsImage,
        *,
        scale: int,
        material: str,
        whiten: bool,
        keep_ink_colour: bool,
    ) -> VipsImage:
        """Clean first, then enlarge - and that order is the whole point.

        Enlarging a page that still carries a brown cast and a lamp gradient
        magnifies those along with the writing; the result is a bigger version
        of the problem. Flattening the light first means the enlargement is
        working on a flat white page, so every pixel it reconstructs is paper
        or ink rather than paper, ink and a shadow.
        """
        from PIL import Image as PilImage

        from ipw.processors.standard.document import clean_document
        from ipw.processors.standard.perspective import detect_page, flatten_page
        from ipw.processors.standard.upscale import upscale

        native = image.image
        if native.bands > 3:
            native = native.extract_band(0, n=3)
        buffer = PilImage.frombytes("RGB", (native.width, native.height), native.write_to_memory())

        # **Find the page first.**
        #
        # A photograph of a document includes the desk it was lying on. Left in,
        # the dark border is enlarged with the page and skews the illumination
        # estimate - the light gets measured across a frame that is part paper
        # and part table, so the paper comes out wrong. Cropping to the page is
        # the first step, not a cosmetic one.
        #
        # A photograph with no page in it is used whole rather than refused:
        # cleaning something that is not a document is a harmless no-op, and
        # refusing to clean one that is would not be.
        found = detect_page(buffer)
        if found is not None and found.confidence >= 0.45:
            buffer = flatten_page(buffer, found.corners)

        cleaned, _ = clean_document(
            buffer, whiten=whiten, keep_ink_colour=keep_ink_colour, lift_ink=True
        )
        result = cleaned if scale <= 1 else upscale(cleaned, scale, material=material)[0]
        vips = self._vips()
        return VipsImage(
            vips.Image.new_from_memory(result.tobytes(), result.width, result.height, 3, "uchar")
        )

    def straighten_page(self, image: VipsImage, corners: Any | None) -> VipsImage:
        """Shared with the Pillow engine - the geometry is one implementation."""
        from PIL import Image as PilImage

        from ipw.processors.standard.perspective import Corners, detect_page, flatten_page

        source = image.image
        if source.bands > 3:
            source = source.extract_band(0, n=3)
        buffer = PilImage.frombytes("RGB", (source.width, source.height), source.write_to_memory())

        if corners is None:
            found = detect_page(buffer)
            if found is None:
                msg = (
                    "no page could be found in this photograph. Give the four corners, "
                    "or photograph the page against a darker background."
                )
                raise EngineError(msg)
            quad = found.corners
        else:
            quad = Corners(*[(float(x), float(y)) for x, y in corners])

        flat = flatten_page(buffer, quad)
        vips = self._vips()
        return VipsImage(
            vips.Image.new_from_memory(flat.tobytes(), flat.width, flat.height, 3, "uchar")
        )

    def enlarge(self, image: VipsImage, *, scale: int, material: str, iterations: int) -> VipsImage:
        """Shared with the Pillow engine, for the same reason as clean_document:
        two engines disagreeing about a result is a bug this repository has
        already had once."""
        from PIL import Image as PilImage

        from ipw.processors.standard.upscale import upscale as run

        source = image.image
        if source.bands > 3:
            source = source.extract_band(0, n=3)
        buffer = PilImage.frombytes("RGB", (source.width, source.height), source.write_to_memory())
        bigger, _ = run(buffer, scale, iterations=iterations, material=material)
        vips = self._vips()
        return VipsImage(
            vips.Image.new_from_memory(bigger.tobytes(), bigger.width, bigger.height, 3, "uchar")
        )

    def clean_document(
        self, image: VipsImage, *, strength_percent: int, whiten: bool, keep_ink_colour: bool
    ) -> VipsImage:
        """Shared with the Pillow engine - see the note there.

        The image crosses to Pillow and back because the correction is per-pixel
        division that libvips has no single operation for, and because writing
        it twice would give two engines that disagree about what a cleaned page
        looks like. That is the bug already found in JPEG saving, and once is
        enough. The round trip costs memory, not quality: the pixels are
        identical either way.
        """
        from PIL import Image as PilImage

        from ipw.processors.standard.document import clean_document as run

        source = image.image
        if source.bands > 3:
            source = source.extract_band(0, n=3)
        buffer = PilImage.frombytes("RGB", (source.width, source.height), source.write_to_memory())
        cleaned, _ = run(
            buffer,
            whiten=whiten,
            strength_percent=strength_percent,
            keep_ink_colour=keep_ink_colour,
        )
        vips = self._vips()
        return VipsImage(
            vips.Image.new_from_memory(cleaned.tobytes(), cleaned.width, cleaned.height, 3, "uchar")
        )

    def sharpen(self, image: VipsImage, amount_percent: int, radius_x100: int) -> VipsImage:
        if amount_percent == 0:
            return image
        sharpened = image.image.sharpen(
            sigma=max(radius_x100 / 100.0, 0.1),
            m1=0.0,
            m2=amount_percent / 100.0 * 3.0,
        )
        return VipsImage(sharpened)

    def denoise(self, image: VipsImage, strength_percent: int) -> VipsImage:
        if strength_percent == 0:
            return image
        size = 3 if strength_percent <= 50 else 5
        return VipsImage(image.image.median(size))

    # -- format -----------------------------------------------------------

    def flatten_alpha(self, image: VipsImage, background: str) -> VipsImage:
        if not image.has_alpha:
            return image
        colour = [
            int(background[1:3], 16),
            int(background[3:5], 16),
            int(background[5:7], 16),
        ]
        return VipsImage(image.image.flatten(background=colour))
