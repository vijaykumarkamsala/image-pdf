from __future__ import annotations

import hashlib
import io
from pathlib import Path
from typing import Any, cast

import numpy as np
import pytest
from PIL import Image, ImageChops

from ipw.processing_worker.image_quality_model import (
    MODEL_FILENAME,
    MODEL_ID,
    MODEL_SCALE,
    MODEL_SHA256,
    ImageQualityCancelledError,
    ImageQualityModelError,
    ImageQualitySource,
    PublicRealPlksrEngine,
    _inject_png_colour_chunks,
    _png_colour_chunks,
)


class NearestSession:
    def run(self, _outputs: object, inputs: dict[str, Any]) -> list[Any]:
        tensor = next(iter(inputs.values()))
        return [np.repeat(np.repeat(tensor, MODEL_SCALE, axis=2), MODEL_SCALE, axis=3)]


class BrightenedSession:
    def run(self, _outputs: object, inputs: dict[str, Any]) -> list[Any]:
        tensor = next(iter(inputs.values()))
        enlarged = np.repeat(np.repeat(tensor, MODEL_SCALE, axis=2), MODEL_SCALE, axis=3)
        return [np.clip(enlarged + 0.12, 0.0, 1.0)]


class ExplodingSession:
    def run(self, _outputs: object, _inputs: dict[str, Any]) -> list[Any]:
        raise AssertionError("a durable cached tile must not run inference again")


def source_png(*, size: tuple[int, int] = (19, 13)) -> bytes:
    image = Image.new("RGB", size)
    pixels = image.load()
    assert pixels is not None
    for y in range(size[1]):
        for x in range(size[0]):
            pixels[x, y] = (20 + x * 7, 40 + y * 8, 120 + (x + y) % 30)
    encoded = io.BytesIO()
    image.save(encoded, format="PNG")
    return encoded.getvalue()


def source_apng(*, size: tuple[int, int] = (12, 10)) -> bytes:
    first = Image.new("RGBA", size, (20, 50, 120, 255))
    second = Image.new("RGBA", size, (80, 100, 150, 180))
    encoded = io.BytesIO()
    first.save(
        encoded,
        format="PNG",
        save_all=True,
        append_images=[second],
        duration=[80, 120],
        loop=2,
    )
    return encoded.getvalue()


def source_apng_with_default_image(*, size: tuple[int, int] = (12, 10)) -> bytes:
    poster = Image.new("RGBA", size, (5, 10, 20, 255))
    first = Image.new("RGBA", size, (20, 50, 120, 255))
    second = Image.new("RGBA", size, (80, 100, 150, 180))
    encoded = io.BytesIO()
    poster.save(
        encoded,
        format="PNG",
        save_all=True,
        append_images=[first, second],
        default_image=True,
        duration=[90, 140],
        loop=3,
    )
    return encoded.getvalue()


def source_animated_webp(*, size: tuple[int, int] = (12, 10)) -> bytes:
    first = Image.new("RGBA", size, (20, 50, 120, 255))
    second = Image.new("RGBA", size, (80, 100, 150, 180))
    encoded = io.BytesIO()
    first.save(
        encoded,
        format="WEBP",
        save_all=True,
        append_images=[second],
        duration=[70, 130],
        loop=1,
        lossless=True,
    )
    return encoded.getvalue()


def source_record(
    payload: bytes,
    *,
    content_class: str = "photo",
    frame_count: int = 1,
) -> ImageQualitySource:
    with Image.open(io.BytesIO(payload)) as image:
        width, height = image.size
    return ImageQualitySource(
        data=payload,
        sha256=hashlib.sha256(payload).hexdigest(),
        media_type="image/png",
        width=width,
        height=height,
        frame_count=frame_count,
        bit_depth=8,
        content_class=content_class,  # type: ignore[arg-type]
        has_icc_profile=False,
    )


def engine(session: object) -> PublicRealPlksrEngine:
    return PublicRealPlksrEngine(
        Path("unused-test-model.onnx"),
        providers=("CPUExecutionProvider",),
        session_factory=lambda _path, _providers: session,  # type: ignore[arg-type,return-value]
        verify_model=False,
    )


def test_restoration_creates_new_real_pixels_and_provenance() -> None:
    payload = source_png()
    original = bytes(payload)
    seen_progress: list[tuple[int, int]] = []
    result = engine(BrightenedSession()).restore(
        source_record(payload),
        strength=80,
        progress=lambda completed, total: seen_progress.append((completed, total)),
    )

    assert payload == original
    assert result.source_sha256 == hashlib.sha256(payload).hexdigest()
    assert result.sha256 == hashlib.sha256(result.data).hexdigest()
    assert result.model_id == MODEL_ID
    assert result.model_sha256 == MODEL_SHA256
    assert result.model_usage == "restore"
    assert result.deterministic is False
    assert result.width == 38
    assert result.height == 26
    assert result.tile_count == 1
    assert seen_progress == [(1, 1)]
    with Image.open(io.BytesIO(result.data)) as restored:
        reference = Image.open(io.BytesIO(payload)).resize(restored.size, Image.Resampling.LANCZOS)
        assert restored.format == "PNG"
        assert restored.info.get("icc_profile")
        assert ImageChops.difference(restored.convert("RGB"), reference.convert("RGB")).getbbox()


def test_source_colour_fidelity_limits_background_shift() -> None:
    payload = source_png(size=(32, 32))
    result = engine(BrightenedSession()).restore(source_record(payload), strength=100)
    with Image.open(io.BytesIO(payload)) as source, Image.open(io.BytesIO(result.data)) as restored:
        reference = source.resize(restored.size, Image.Resampling.LANCZOS).convert("RGB")
        reference_pixel = cast(tuple[int, int, int], reference.getpixel((30, 30)))
        restored_pixel = cast(tuple[int, int, int], restored.convert("RGB").getpixel((30, 30)))
    reference_chroma = (
        reference_pixel[0] - reference_pixel[2],
        reference_pixel[1] - (reference_pixel[0] + reference_pixel[2]) / 2,
    )
    restored_chroma = (
        restored_pixel[0] - restored_pixel[2],
        restored_pixel[1] - (restored_pixel[0] + restored_pixel[2]) / 2,
    )
    assert restored_chroma == pytest.approx(reference_chroma, abs=2)


def test_flat_graphics_use_deterministic_restoration_without_model_inference() -> None:
    payload = source_png()
    result = engine(ExplodingSession()).restore(
        source_record(payload, content_class="flat-graphic"), strength=60
    )

    assert result.deterministic
    assert result.model_usage == "deterministic"
    assert result.width == 19 * 4
    assert result.height == 13 * 4
    with Image.open(io.BytesIO(result.data)) as restored:
        assert restored.size == (19 * 4, 13 * 4)


def test_animation_restores_every_frame_and_preserves_timing() -> None:
    payload = source_apng()
    seen_progress: list[tuple[int, int]] = []
    result = engine(BrightenedSession()).restore(
        source_record(payload, frame_count=2),
        strength=60,
        progress=lambda completed, total: seen_progress.append((completed, total)),
    )

    assert result.frame_count == 2
    assert result.tile_count == 2
    assert seen_progress == [(1, 2), (2, 2)]
    with Image.open(io.BytesIO(result.data)) as restored:
        assert restored.format == "PNG"
        assert restored.n_frames == 2
        assert restored.info["loop"] == 2
        durations = []
        for index in range(restored.n_frames):
            restored.seek(index)
            durations.append(restored.info["duration"])
            assert restored.size == (24, 20)
        assert durations == [80.0, 120.0]


def test_apng_default_poster_and_animation_timing_are_preserved() -> None:
    payload = source_apng_with_default_image()
    result = engine(NearestSession()).restore(
        source_record(payload, frame_count=2),
        strength=60,
    )

    assert result.frame_count == 2
    with Image.open(io.BytesIO(result.data)) as restored:
        assert restored.info["default_image"] is True
        assert restored.n_frames == 3
        assert restored.info["loop"] == 3
        restored.seek(1)
        assert restored.info["duration"] == 90.0
        restored.seek(2)
        assert restored.info["duration"] == 140.0


def test_animated_webp_is_processed_frame_by_frame_into_apng() -> None:
    payload = source_animated_webp()
    source = ImageQualitySource(
        data=payload,
        sha256=hashlib.sha256(payload).hexdigest(),
        media_type="image/webp",
        width=12,
        height=10,
        frame_count=2,
        bit_depth=8,
        content_class="illustration",
        has_icc_profile=False,
    )

    result = engine(NearestSession()).restore(source, strength=60)

    with Image.open(io.BytesIO(result.data)) as restored:
        assert restored.format == "PNG"
        assert restored.n_frames == 2
        assert restored.info["loop"] == 1
    assert result.frame_count == 2


def test_materialized_animation_is_frame_timed_and_tile_resumable(tmp_path: Path) -> None:
    pytest.importorskip("pyvips")
    payload = source_apng(size=(18, 14))
    input_path = tmp_path / "source.apng"
    input_path.write_bytes(payload)
    source = source_record(payload, content_class="illustration", frame_count=2)
    cached: dict[str, Any] = {}
    first_output = tmp_path / "first.apng"

    first = engine(BrightenedSession()).restore_path(
        source,
        input_path=str(input_path),
        output_path=str(first_output),
        strength=70,
        load_tile=lambda key: cached.get(key),
        save_tile=lambda key, tile: cached.__setitem__(key, tile),
    )

    assert first.frame_count == 2
    assert {key[:10] for key in cached} == {"f00000000-", "f00000001-"}
    resumed_output = tmp_path / "resumed.apng"
    resumed = engine(ExplodingSession()).restore_path(
        source,
        input_path=str(input_path),
        output_path=str(resumed_output),
        strength=70,
        load_tile=lambda key: cached.get(key),
        save_tile=lambda _key, _tile: pytest.fail("cached animation tile was rewritten"),
    )

    assert resumed.sha256 == first.sha256
    assert resumed_output.read_bytes() == first_output.read_bytes()
    with Image.open(resumed_output) as restored:
        assert restored.n_frames == 2
        assert restored.info["loop"] == 2
        restored.seek(0)
        assert restored.info["duration"] == 80.0
        restored.seek(1)
        assert restored.info["duration"] == 120.0


def test_materialized_flat_animation_never_uses_neural_model(tmp_path: Path) -> None:
    pytest.importorskip("pyvips")
    payload = source_animated_webp(size=(14, 9))
    input_path = tmp_path / "flat.webp"
    input_path.write_bytes(payload)
    source = ImageQualitySource(
        data=b"",
        sha256=hashlib.sha256(payload).hexdigest(),
        media_type="image/webp",
        width=14,
        height=9,
        frame_count=2,
        bit_depth=8,
        content_class="flat-graphic",
        has_icc_profile=False,
    )
    output_path = tmp_path / "flat.apng"

    result = engine(ExplodingSession()).restore_path(
        source,
        input_path=str(input_path),
        output_path=str(output_path),
        strength=90,
    )

    assert result.deterministic
    assert result.model_usage == "deterministic"
    assert result.frame_count == 2
    assert (result.width, result.height) == (56, 36)
    with Image.open(output_path) as restored:
        assert restored.n_frames == 2
        assert restored.info["loop"] == 1


def test_cancellation_happens_before_first_model_tile() -> None:
    payload = source_png()
    with pytest.raises(ImageQualityCancelledError, match="cancelled"):
        engine(NearestSession()).restore(
            source_record(payload), strength=60, cancelled=lambda: True
        )


def test_source_integrity_failure_does_not_decode_or_process() -> None:
    payload = source_png()
    source = source_record(payload)
    changed = ImageQualitySource(**{**source.__dict__, "sha256": "0" * 64})
    with pytest.raises(ImageQualityModelError, match="source checksum"):
        engine(NearestSession()).restore(changed, strength=60)


def test_model_integrity_is_fail_closed(tmp_path: Path) -> None:
    path = tmp_path / MODEL_FILENAME
    path.write_bytes(b"not-the-approved-model")
    with pytest.raises(ImageQualityModelError, match="byte count"):
        PublicRealPlksrEngine(path)


def test_real_approved_model_smoke() -> None:
    model = Path(__file__).resolve().parents[3] / ".tools" / "models" / MODEL_FILENAME
    if not model.is_file():
        pytest.skip("approved model is not installed in this checkout")
    payload = source_png(size=(12, 10))
    result = PublicRealPlksrEngine(
        model, providers=("CPUExecutionProvider",)
    ).restore(source_record(payload, content_class="illustration"), strength=65)
    assert result.width == 24
    assert result.height == 20
    assert result.sha256 != hashlib.sha256(payload).hexdigest()


def test_file_pipeline_preserves_16_bit_icc_output(tmp_path: Path) -> None:
    pyvips = pytest.importorskip("pyvips")
    from ipw.processing_worker.enhancement_engine import CANONICAL_SRGB_PROFILE

    width, height = 18, 14
    pixels = np.zeros((height, width, 3), dtype=np.uint16)
    pixels[..., 0] = np.arange(width, dtype=np.uint16)[None, :] * 2200
    pixels[..., 1] = np.arange(height, dtype=np.uint16)[:, None] * 2600
    pixels[..., 2] = 24_000
    profile = tmp_path / "source.icc"
    profile.write_bytes(CANONICAL_SRGB_PROFILE)
    input_path = tmp_path / "source-16.png"
    pyvips.Image.new_from_memory(
        memoryview(pixels), width, height, 3, "ushort"
    ).copy(interpretation="rgb16").pngsave(
        str(input_path), bitdepth=16, profile=str(profile)
    )
    payload = input_path.read_bytes()
    source = ImageQualitySource(
        data=b"",
        sha256=hashlib.sha256(payload).hexdigest(),
        media_type="image/png",
        width=width,
        height=height,
        frame_count=1,
        bit_depth=16,
        content_class="illustration",
        has_icc_profile=True,
    )
    output_path = tmp_path / "enhanced-16.png"

    result = engine(BrightenedSession()).restore_path(
        source,
        input_path=str(input_path),
        output_path=str(output_path),
        strength=70,
    )

    restored = pyvips.Image.new_from_file(str(output_path))
    assert (restored.width, restored.height) == (width * 2, height * 2)
    assert restored.format == "ushort"
    assert "icc-profile-data" in restored.get_fields()
    assert result.bit_depth == 16
    assert result.has_icc_profile
    assert result.colour_policy == "source-icc-preserved/16-bit"
    assert result.sha256 == hashlib.sha256(output_path.read_bytes()).hexdigest()


def test_file_pipeline_resumes_from_verified_durable_tiles(tmp_path: Path) -> None:
    payload = source_png(size=(18, 14))
    input_path = tmp_path / "source.png"
    input_path.write_bytes(payload)
    source = source_record(payload, content_class="illustration")
    cached: dict[str, Any] = {}
    first_output = tmp_path / "first.png"
    first = engine(BrightenedSession()).restore_path(
        source,
        input_path=str(input_path),
        output_path=str(first_output),
        strength=70,
        load_tile=lambda key: cached.get(key),
        save_tile=lambda key, tile: cached.__setitem__(key, tile),
    )
    assert cached
    second_output = tmp_path / "resumed.png"

    resumed = engine(ExplodingSession()).restore_path(
        source,
        input_path=str(input_path),
        output_path=str(second_output),
        strength=70,
        load_tile=lambda key: cached.get(key),
        save_tile=lambda _key, _tile: pytest.fail("cached tile was unexpectedly rewritten"),
    )

    assert resumed.sha256 == first.sha256
    assert second_output.read_bytes() == first_output.read_bytes()


def test_file_pipeline_preserves_hdr_cicp_and_mastering_metadata(tmp_path: Path) -> None:
    pyvips = pytest.importorskip("pyvips")
    width, height = 16, 12
    pixels = np.full((height, width, 3), 32_000, dtype=np.uint16)
    input_path = tmp_path / "hdr-source.png"
    pyvips.Image.new_from_memory(
        memoryview(pixels), width, height, 3, "ushort"
    ).copy(interpretation="rgb16").pngsave(str(input_path), bitdepth=16)
    colour_chunks = [
        (b"cICP", bytes((9, 16, 0, 1))),
        (b"mDCV", bytes(range(24))),
        (b"cLLI", bytes(range(8))),
    ]
    _inject_png_colour_chunks(input_path, colour_chunks)
    payload = input_path.read_bytes()
    source = ImageQualitySource(
        data=b"",
        sha256=hashlib.sha256(payload).hexdigest(),
        media_type="image/png",
        width=width,
        height=height,
        frame_count=1,
        bit_depth=16,
        content_class="photo",
        has_icc_profile=False,
        colour_primaries="bt2020",
        dynamic_range="hdr-pq",
    )
    output_path = tmp_path / "hdr-enhanced.png"

    result = engine(NearestSession()).restore_path(
        source,
        input_path=str(input_path),
        output_path=str(output_path),
        strength=60,
    )

    assert _png_colour_chunks(output_path) == colour_chunks
    assert result.bit_depth == 16
    assert not result.has_icc_profile
    assert result.colour_primaries == "bt2020"
    assert result.dynamic_range == "hdr-pq"
    assert result.colour_policy == "source-cicp-hdr-pq-preserved/16-bit"


def test_file_pipeline_preserves_display_p3_cicp_without_forcing_srgb(
    tmp_path: Path,
) -> None:
    pyvips = pytest.importorskip("pyvips")
    width, height = 17, 11
    pixels = np.zeros((height, width, 3), dtype=np.uint16)
    pixels[..., 0] = 48_000
    pixels[..., 1] = np.arange(width, dtype=np.uint16)[None, :] * 2400
    pixels[..., 2] = np.arange(height, dtype=np.uint16)[:, None] * 3100
    input_path = tmp_path / "display-p3-source.png"
    pyvips.Image.new_from_memory(
        memoryview(pixels), width, height, 3, "ushort"
    ).copy(interpretation="rgb16").pngsave(str(input_path), bitdepth=16)
    colour_chunks = [(b"cICP", bytes((12, 13, 0, 1)))]
    _inject_png_colour_chunks(input_path, colour_chunks)
    payload = input_path.read_bytes()
    source = ImageQualitySource(
        data=b"",
        sha256=hashlib.sha256(payload).hexdigest(),
        media_type="image/png",
        width=width,
        height=height,
        frame_count=1,
        bit_depth=16,
        content_class="illustration",
        has_icc_profile=False,
        colour_primaries="display-p3",
        dynamic_range="sdr",
    )
    output_path = tmp_path / "display-p3-enhanced.png"

    result = engine(NearestSession()).restore_path(
        source,
        input_path=str(input_path),
        output_path=str(output_path),
        strength=60,
    )

    restored = pyvips.Image.new_from_file(str(output_path))
    assert _png_colour_chunks(output_path) == colour_chunks
    assert restored.format == "ushort"
    assert "icc-profile-data" not in restored.get_fields()
    assert result.bit_depth == 16
    assert not result.has_icc_profile
    assert result.colour_primaries == "display-p3"
    assert result.dynamic_range == "sdr"
    assert result.colour_policy == "source-cicp-sdr-preserved/16-bit"
