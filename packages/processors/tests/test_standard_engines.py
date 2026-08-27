"""Engine-level behaviour, tested directly rather than through the processor.

These cover the operations and error paths that the golden matrix does not reach:
the white-balance presets, strong denoise, alpha flattening, mode conversions and
the encode/decode failure branches. Testing them at the engine seam keeps each
assertion about one library's behaviour, which is what the Pillow-versus-libvips
comparison ultimately rests on.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

import pytest
from PIL import Image

from ipw.processors.standard import EngineError, PillowEngine, VipsEngine, vips_available

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "data" / "fixtures" / "images"

SMOOTH = FIXTURES / "synthetic-gradient-64.png"
NOISE = FIXTURES / "synthetic-noise-64.png"
ALPHA = FIXTURES / "synthetic-alpha-32.png"
NOT_AN_IMAGE = FIXTURES / "not-an-image.png"

engines = pytest.mark.parametrize(
    "engine",
    [
        pytest.param(PillowEngine(), id="pillow"),
        pytest.param(
            VipsEngine(),
            id="libvips",
            marks=pytest.mark.skipif(
                not vips_available(), reason="libvips native library not installed on this host"
            ),
        ),
    ],
)


class TestEngineIdentity:
    @engines
    def test_reports_a_name_and_version(self, engine: Any) -> None:
        assert engine.name in {"pillow", "libvips"}
        assert engine.version
        assert engine.version != "unavailable"
        assert engine.available
        assert engine.deterministic


class TestGeometry:
    @engines
    @pytest.mark.parametrize("resample", ["bicubic", "lanczos", "nearest"])
    def test_every_resample_filter_works(self, engine: Any, resample: str) -> None:
        image = engine.load(str(SMOOTH))
        result = engine.resize(image, 16, 16, resample)
        assert (result.width, result.height) == (16, 16)

    @engines
    def test_a_non_square_resize_is_honoured(self, engine: Any) -> None:
        result = engine.resize(engine.load(str(SMOOTH)), 40, 10, "bicubic")
        assert (result.width, result.height) == (40, 10)

    @engines
    @pytest.mark.parametrize("degrees", [90, 180, 270])
    def test_rotation_preserves_the_pixel_count(self, engine: Any, degrees: int) -> None:
        image = engine.load(str(SMOOTH))
        rotated = engine.rotate(image, degrees)
        assert rotated.width * rotated.height == image.width * image.height

    @engines
    def test_rotating_a_non_square_image_swaps_axes(self, engine: Any) -> None:
        image = engine.resize(engine.load(str(SMOOTH)), 40, 10, "nearest")
        rotated = engine.rotate(image, 90)
        assert (rotated.width, rotated.height) == (10, 40)

    @engines
    @pytest.mark.parametrize("axis", ["horizontal", "vertical"])
    def test_flipping_preserves_dimensions(self, engine: Any, axis: str) -> None:
        image = engine.load(str(SMOOTH))
        flipped = engine.flip(image, axis)
        assert (flipped.width, flipped.height) == (image.width, image.height)

    @engines
    def test_flipping_twice_returns_the_original(self, engine: Any, tmp_path: Path) -> None:
        image = engine.load(str(SMOOTH))
        once = engine.flip(image, "horizontal")
        twice = engine.flip(once, "horizontal")

        original, restored = tmp_path / "a.png", tmp_path / "b.png"
        engine.save(image, str(original), "image/png", 95, optimise=True)
        engine.save(twice, str(restored), "image/png", 95, optimise=True)
        assert original.read_bytes() == restored.read_bytes()


class TestGeometryFailures:
    @engines
    def test_a_zero_resize_target_is_refused(self, engine: Any) -> None:
        with pytest.raises(EngineError, match="must be positive"):
            engine.resize(engine.load(str(SMOOTH)), 0, 10, "bicubic")

    @engines
    def test_a_crop_beyond_the_edge_is_refused(self, engine: Any) -> None:
        with pytest.raises(EngineError, match="extends beyond"):
            engine.crop(engine.load(str(SMOOTH)), 50, 50, 40, 40)

    @engines
    def test_an_unsupported_rotation_is_refused(self, engine: Any) -> None:
        with pytest.raises(EngineError, match="90, 180 or 270"):
            engine.rotate(engine.load(str(SMOOTH)), 45)

    @engines
    def test_an_unreadable_file_is_refused(self, engine: Any) -> None:
        with pytest.raises(EngineError, match="could not decode"):
            engine.load(str(NOT_AN_IMAGE))

    @engines
    def test_an_unsupported_output_format_is_refused(self, engine: Any, tmp_path: Path) -> None:
        with pytest.raises(EngineError, match="unsupported output media type"):
            engine.save(
                engine.load(str(SMOOTH)), str(tmp_path / "x.tif"), "image/tiff", 90, optimise=True
            )


class TestToneAndColour:
    @engines
    @pytest.mark.parametrize("mode", ["auto", "daylight", "tungsten"])
    def test_every_white_balance_mode_works(self, engine: Any, mode: str, tmp_path: Path) -> None:
        image = engine.load(str(SMOOTH))
        balanced = engine.adjust(
            image,
            brightness_percent=0,
            contrast_percent=0,
            saturation_percent=0,
            exposure_percent=0,
            white_balance=mode,
        )
        assert (balanced.width, balanced.height) == (image.width, image.height)

        before, after = tmp_path / "before.png", tmp_path / "after.png"
        engine.save(image, str(before), "image/png", 95, optimise=True)
        engine.save(balanced, str(after), "image/png", 95, optimise=True)
        assert before.read_bytes() != after.read_bytes(), (
            f"white balance '{mode}' left the image unchanged, so the test proves nothing"
        )

    @engines
    def test_an_unknown_white_balance_mode_is_refused(self, engine: Any) -> None:
        with pytest.raises(EngineError, match="unknown white balance"):
            engine.adjust(
                engine.load(str(SMOOTH)),
                brightness_percent=0,
                contrast_percent=0,
                saturation_percent=0,
                exposure_percent=0,
                white_balance="moonlight",
            )

    @engines
    def test_exposure_and_brightness_both_apply(self, engine: Any, tmp_path: Path) -> None:
        image = engine.load(str(SMOOTH))
        results = []
        for exposure, brightness in ((30, 0), (0, 30), (15, 15)):
            adjusted = engine.adjust(
                image,
                brightness_percent=brightness,
                contrast_percent=0,
                saturation_percent=0,
                exposure_percent=exposure,
                white_balance="none",
            )
            path = tmp_path / f"e{exposure}b{brightness}.png"
            engine.save(adjusted, str(path), "image/png", 95, optimise=True)
            results.append(path.read_bytes())
        assert len(set(results)) > 1, "exposure and brightness must have an observable effect"

    @engines
    def test_a_zero_adjustment_is_the_identity(self, engine: Any, tmp_path: Path) -> None:
        image = engine.load(str(SMOOTH))
        unchanged = engine.adjust(
            image,
            brightness_percent=0,
            contrast_percent=0,
            saturation_percent=0,
            exposure_percent=0,
            white_balance="none",
        )
        original, result = tmp_path / "a.png", tmp_path / "b.png"
        engine.save(image, str(original), "image/png", 95, optimise=True)
        engine.save(unchanged, str(result), "image/png", 95, optimise=True)
        assert original.read_bytes() == result.read_bytes()


class TestDetail:
    @engines
    @pytest.mark.parametrize("strength", [30, 80])
    def test_both_denoise_strengths_change_a_noisy_image(
        self, engine: Any, strength: int, tmp_path: Path
    ) -> None:
        """Strength selects the kernel size, so both branches need exercising."""
        image = engine.load(str(NOISE))
        denoised = engine.denoise(image, strength)
        before, after = tmp_path / "a.png", tmp_path / "b.png"
        engine.save(image, str(before), "image/png", 95, optimise=True)
        engine.save(denoised, str(after), "image/png", 95, optimise=True)
        assert before.read_bytes() != after.read_bytes()

    @engines
    def test_zero_strength_denoise_is_a_no_op(self, engine: Any) -> None:
        image = engine.load(str(NOISE))
        assert engine.denoise(image, 0) is image

    @engines
    def test_zero_amount_sharpen_is_a_no_op(self, engine: Any) -> None:
        image = engine.load(str(NOISE))
        assert engine.sharpen(image, 0, 100) is image

    @engines
    def test_sharpening_changes_a_noisy_image(self, engine: Any, tmp_path: Path) -> None:
        image = engine.load(str(NOISE))
        sharpened = engine.sharpen(image, 80, 200)
        before, after = tmp_path / "a.png", tmp_path / "b.png"
        engine.save(image, str(before), "image/png", 95, optimise=True)
        engine.save(sharpened, str(after), "image/png", 95, optimise=True)
        assert before.read_bytes() != after.read_bytes()


class TestTransparency:
    @engines
    def test_the_alpha_fixture_reports_alpha(self, engine: Any) -> None:
        image = engine.load(str(ALPHA))
        assert image.has_alpha
        assert image.bands == 4

    @engines
    def test_flattening_removes_alpha(self, engine: Any) -> None:
        flattened = engine.flatten_alpha(engine.load(str(ALPHA)), "#ff0000")
        assert not flattened.has_alpha

    @engines
    def test_flattening_an_opaque_image_is_a_no_op(self, engine: Any) -> None:
        image = engine.load(str(SMOOTH))
        assert engine.flatten_alpha(image, "#ffffff") is image

    @engines
    def test_the_background_colour_is_honoured(self, engine: Any, tmp_path: Path) -> None:
        """Different backgrounds must produce different results where alpha is zero."""
        outputs = []
        for colour in ("#ff0000", "#0000ff"):
            flattened = engine.flatten_alpha(engine.load(str(ALPHA)), colour)
            path = tmp_path / f"{colour[1:]}.png"
            engine.save(flattened, str(path), "image/png", 95, optimise=True)
            outputs.append(path.read_bytes())
        assert outputs[0] != outputs[1]

    @engines
    def test_saving_alpha_as_jpeg_is_refused(self, engine: Any, tmp_path: Path) -> None:
        with pytest.raises(EngineError, match="no alpha channel"):
            engine.save(
                engine.load(str(ALPHA)), str(tmp_path / "x.jpg"), "image/jpeg", 90, optimise=True
            )

    @engines
    def test_a_flattened_image_saves_as_jpeg(self, engine: Any, tmp_path: Path) -> None:
        flattened = engine.flatten_alpha(engine.load(str(ALPHA)), "#ffffff")
        path = tmp_path / "flat.jpg"
        engine.save(flattened, str(path), "image/jpeg", 90, optimise=True)
        with Image.open(path) as written:
            assert written.format == "JPEG"
            assert written.mode == "RGB"


class TestEncoding:
    @engines
    @pytest.mark.parametrize("quality", [60, 90, 100])
    def test_jpeg_quality_affects_the_output_size(
        self, engine: Any, quality: int, tmp_path: Path
    ) -> None:
        path = tmp_path / f"q{quality}.jpg"
        engine.save(engine.load(str(NOISE)), str(path), "image/jpeg", quality, optimise=True)
        with Image.open(path) as written:
            assert written.format == "JPEG"
        assert path.stat().st_size > 0

    @engines
    def test_higher_quality_produces_a_larger_file(self, engine: Any, tmp_path: Path) -> None:
        image = engine.load(str(NOISE))
        sizes = {}
        for quality in (40, 95):
            path = tmp_path / f"q{quality}.jpg"
            engine.save(image, str(path), "image/jpeg", quality, optimise=True)
            sizes[quality] = path.stat().st_size
        assert sizes[95] > sizes[40]

    @engines
    def test_png_output_is_reproducible(self, engine: Any, tmp_path: Path) -> None:
        image = engine.load(str(SMOOTH))
        first, second = tmp_path / "1.png", tmp_path / "2.png"
        engine.save(image, str(first), "image/png", 95, optimise=True)
        engine.save(image, str(second), "image/png", 95, optimise=True)
        assert first.read_bytes() == second.read_bytes()

    @engines
    def test_a_round_trip_preserves_dimensions(self, engine: Any, tmp_path: Path) -> None:
        image = engine.load(str(SMOOTH))
        path = tmp_path / "round.png"
        engine.save(image, str(path), "image/png", 95, optimise=True)
        reloaded = engine.load(str(path))
        assert (reloaded.width, reloaded.height) == (image.width, image.height)


class TestOriginalPreservation:
    @engines
    def test_no_engine_operation_touches_a_source_file(self, engine: Any, tmp_path: Path) -> None:
        before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in FIXTURES.iterdir()}

        image = engine.load(str(SMOOTH))
        engine.resize(image, 16, 16, "lanczos")
        engine.crop(image, 0, 0, 8, 8)
        engine.rotate(image, 180)
        engine.flip(image, "vertical")
        engine.sharpen(engine.load(str(NOISE)), 50, 150)
        engine.denoise(engine.load(str(NOISE)), 60)
        engine.flatten_alpha(engine.load(str(ALPHA)), "#000000")
        engine.save(image, str(tmp_path / "out.png"), "image/png", 95, optimise=True)

        after = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in FIXTURES.iterdir()}
        assert after == before


class TestCmykIsAJpegMode:
    """A print shop's file must survive the round trip.

    JPEG stores CMYK natively - Adobe writes them constantly - and a textile or
    print bureau sends them as a matter of course. The Pillow engine used an
    allowlist of RGB and L, so those files could not be resized at all, and the
    refusal blamed an alpha channel that CMYK does not have. libvips checked
    actual transparency and accepted them, so the same upload succeeded or
    failed depending on which engine was installed.
    """

    def _cmyk(self) -> Any:
        from PIL import Image

        return Image.new("CMYK", (40, 30), (10, 200, 180, 5))

    def test_pillow_saves_cmyk_as_jpeg(self, tmp_path: Path) -> None:
        from PIL import Image

        from ipw.processors.standard.pillow_engine import PillowEngine, PillowImage

        engine = PillowEngine()
        out = tmp_path / "print.jpg"
        engine.save(PillowImage(self._cmyk()), str(out), "image/jpeg", 90, optimise=False)

        assert out.is_file()
        assert Image.open(out).mode == "CMYK"

    def test_a_transparent_image_is_still_refused_for_jpeg(self, tmp_path: Path) -> None:
        """The real constraint, kept: JPEG cannot carry alpha, and flattening
        onto a colour nobody chose is how a logo silently gains a black box."""
        from PIL import Image

        from ipw.processors.standard.engine import EngineError
        from ipw.processors.standard.pillow_engine import PillowEngine, PillowImage

        engine = PillowEngine()
        image = PillowImage(Image.new("RGBA", (20, 20), (255, 0, 0, 0)))

        with pytest.raises(EngineError, match="no alpha channel"):
            engine.save(image, str(tmp_path / "x.jpg"), "image/jpeg", 90, optimise=False)

    def test_a_mode_jpeg_cannot_store_says_what_it_is(self, tmp_path: Path) -> None:
        """Not "no alpha channel" for something that has none."""
        from PIL import Image

        from ipw.processors.standard.engine import EngineError
        from ipw.processors.standard.pillow_engine import PillowEngine, PillowImage

        engine = PillowEngine()
        image = PillowImage(Image.new("I;16", (20, 20), 4096))

        with pytest.raises(EngineError, match="cannot store"):
            engine.save(image, str(tmp_path / "x.jpg"), "image/jpeg", 90, optimise=False)


class TestOrientationIsHonoured:
    """A portrait phone photo must not come back on its side.

    Phones in portrait write landscape pixels plus an EXIF flag meaning "rotate
    this to display". Viewers honour it, so the file looks upright everywhere -
    until a tool reads the pixels, ignores the flag, and writes the result
    without it. The output then has the right dimensions and the wrong picture,
    and nothing reports an error, which is why this needs a test rather than an
    eye.
    """

    def _portrait_photo(self, path: Path) -> None:
        """Landscape pixels - red left, blue right - flagged 'rotate 90 CW'."""
        from PIL import Image, ImageDraw

        canvas = Image.new("RGB", (400, 200), (255, 255, 255))
        draw = ImageDraw.Draw(canvas)
        draw.rectangle([0, 0, 199, 199], fill=(220, 20, 20))
        draw.rectangle([200, 0, 399, 199], fill=(20, 20, 220))
        exif = Image.Exif()
        exif[274] = 6
        canvas.save(path, format="JPEG", exif=exif, quality=95)

    def test_pillow_turns_the_photo_the_way_the_camera_said(self, tmp_path: Path) -> None:
        from ipw.processors.standard.pillow_engine import PillowEngine

        source = tmp_path / "IMG_2201.jpg"
        self._portrait_photo(source)

        loaded = PillowEngine().load(str(source))

        assert (loaded.width, loaded.height) == (200, 400), "the photo is still on its side"

        rgb = loaded.image.convert("RGB")

        def average(box: tuple[int, int, int, int]) -> tuple[int, ...]:
            pixel = rgb.crop(box).resize((1, 1)).getpixel((0, 0))
            assert isinstance(pixel, tuple)
            return pixel

        top = average((0, 0, 200, 200))
        bottom = average((0, 200, 200, 400))
        assert top[0] > top[2], "the red side should be at the top after rotating"
        assert bottom[2] > bottom[0], "the blue side should be at the bottom"

    def test_an_image_with_no_orientation_tag_is_untouched(self, tmp_path: Path) -> None:
        """Everything that was already correct must stay byte-for-byte correct -
        which is also why the committed goldens did not move."""
        from PIL import Image

        from ipw.processors.standard.pillow_engine import PillowEngine

        source = tmp_path / "plain.png"
        Image.new("RGB", (60, 40), (10, 200, 10)).save(source)

        loaded = PillowEngine().load(str(source))

        assert (loaded.width, loaded.height) == (60, 40)
        assert loaded.image.convert("RGB").getpixel((5, 5)) == (10, 200, 10)

    def test_orientation_one_means_leave_it_alone(self, tmp_path: Path) -> None:
        from PIL import Image

        from ipw.processors.standard.pillow_engine import PillowEngine

        source = tmp_path / "upright.jpg"
        exif = Image.Exif()
        exif[274] = 1
        Image.new("RGB", (80, 40), (30, 30, 200)).save(source, format="JPEG", exif=exif)

        loaded = PillowEngine().load(str(source))

        assert (loaded.width, loaded.height) == (80, 40)
