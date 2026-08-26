"""Deterministic standard baseline (POC-004).

Acceptance criteria:

* Golden fixtures verify expected dimensions and stable hashes/tolerances.
* Metadata/orientation/transparency behaviour is tested.
* Original files remain unchanged.
* Invalid combinations return normalised failures.
* Timing and memory measurements populate the report.

Both engines run the same tests. Where libvips is unavailable the engine tests
skip and the *unavailability* behaviour is asserted instead - a benchmark should
record that a candidate could not execute here, not pretend it passed.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from ipw.benchmark_runner.conformance import assert_processor_conforms
from ipw.contracts.asset import MediaType
from ipw.contracts.failure import FailureCategory
from ipw.contracts.operation import (
    AdjustSettings,
    AnySettings,
    ConvertSettings,
    CropSettings,
    DenoiseSettings,
    FlipSettings,
    Operation,
    OperationFamily,
    OperationKind,
    ProcessingVariant,
    ResizeSettings,
    RotateSettings,
    SharpenSettings,
    SuperResolutionSettings,
)
from ipw.contracts.runtime import InputRef, RunContext, workspace
from ipw.processors.base import guarded_process
from ipw.processors.standard import (
    EngineError,
    PillowEngine,
    StandardProcessor,
    VipsEngine,
    pillow_processor,
    vips_available,
    vips_processor,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "data" / "fixtures" / "images"
GOLDENS = REPO_ROOT / "data" / "goldens"

SMOOTH = "synthetic-gradient-64.png"
NOISE = "synthetic-noise-64.png"
ALPHA = "synthetic-alpha-32.png"

# The operation matrix, mirrored from tools/make_goldens.py. Duplicated on
# purpose: if the two ever drift, one of them is wrong and this test says so.
GOLDEN_OPERATIONS = frozenset(
    {
        "resize-bicubic-32",
        "resize-lanczos-32",
        "resize-lanczos-128-upscale",
        "resize-scale-half",
        "crop-centre-32",
        "rotate-90",
        "rotate-180",
        "rotate-270",
        "flip-horizontal",
        "flip-vertical",
        "adjust-brighter",
        "adjust-contrast",
        "adjust-saturation",
        "adjust-white-balance-auto",
        "sharpen-moderate",
        "denoise-moderate",
        "convert-to-jpeg-q90",
        "convert-to-png",
    }
)

ENGINES = ["pillow", "libvips"]


def ref_for(name: str) -> InputRef:
    path = FIXTURES / name
    payload = path.read_bytes()
    return InputRef(
        asset_id="baseline-source",
        expected_sha256=hashlib.sha256(payload).hexdigest(),
        path=path,
        declared_bytes=len(payload),
    )


def processor_for(engine: str) -> StandardProcessor:  # type: ignore[type-arg]
    return pillow_processor() if engine == "pillow" else vips_processor()


def run(
    engine: str, settings: AnySettings, ctx: RunContext, source: str = SMOOTH
) -> tuple[bytes | None, object]:
    """Process one operation and return (output bytes, outcome)."""
    processor = processor_for(engine)
    operation = Operation.build(settings, ProcessingVariant.STANDARD_SERVER_AUTHORITATIVE)
    with workspace(ctx.temp_root, "t") as ws:
        outcome = processor.process(ref_for(source), operation, settings, ws, ctx)
        payload = None
        if outcome.succeeded and outcome.output is not None:
            payload = (ws.root / outcome.output.relative_path).read_bytes()
    return payload, outcome


available = pytest.mark.parametrize(
    "engine",
    [
        pytest.param("pillow"),
        pytest.param(
            "libvips",
            marks=pytest.mark.skipif(
                not vips_available(), reason="libvips native library not installed on this host"
            ),
        ),
    ],
)


class TestEngineAvailability:
    def test_pillow_is_always_available(self) -> None:
        assert PillowEngine().available

    def test_an_unavailable_engine_reports_rather_than_crashes(self) -> None:
        """A missing native library is a recorded outcome, not an exception."""
        engine = VipsEngine()
        if engine.available:
            pytest.skip("libvips is installed here; the unavailable path is covered on CI")
        processor = vips_processor()
        operation = Operation.build(
            ResizeSettings(target_width=8, target_height=8), ProcessingVariant.ORIGINAL_CONTROL
        )
        support = processor.supports(operation, operation.settings)
        assert not support.supported
        assert support.failure is not None
        assert support.failure.category is FailureCategory.PROCESSOR_UNAVAILABLE

    def test_the_engine_version_is_recorded_in_the_identity(self) -> None:
        identity = pillow_processor().describe()
        assert identity.runtime.framework == "pillow"
        assert identity.runtime.framework_version is not None
        assert identity.runtime.framework_version.count(".") >= 1


class TestContractConformance:
    @available
    def test_conforms_to_the_processor_contract(self, engine: str, tmp_path: Path) -> None:
        assert_processor_conforms(lambda: processor_for(engine), tmp_path)

    @available
    def test_declares_only_standard_operations(self, engine: str) -> None:
        """D-007 / D-009: a standard processor can never be chosen for an AI operation."""
        identity = processor_for(engine).describe()
        assert identity.family is OperationFamily.STANDARD
        assert identity.weights is None
        assert OperationKind.SUPER_RESOLUTION not in identity.supported_operations

    @available
    def test_refuses_an_ai_operation(self, engine: str) -> None:
        processor = processor_for(engine)
        operation = Operation.build(SuperResolutionSettings(scale=2), ProcessingVariant.AI_NATURAL)
        support = processor.supports(operation, operation.settings)
        assert not support.supported
        assert support.failure is not None
        assert support.failure.code.value == "PROCESSOR.OPERATION_UNSUPPORTED"

    @available
    def test_declares_deterministic_output(self, engine: str) -> None:
        assert processor_for(engine).describe().deterministic_output


class TestGoldenOutputs:
    """Exact-hash goldens (D-046). Dimensions and bytes both pinned."""

    @staticmethod
    def index() -> dict[str, dict[str, dict[str, object]]]:
        document = json.loads((GOLDENS / "index.json").read_text(encoding="utf-8"))
        engines: dict[str, dict[str, dict[str, object]]] = document["engines"]
        return engines

    @available
    def test_every_operation_has_a_golden(self, engine: str) -> None:
        assert set(self.index()[engine]) == GOLDEN_OPERATIONS, (
            "the committed goldens and the operation matrix disagree; regenerate with "
            "tools/make_goldens.py"
        )

    @available
    def test_golden_files_match_their_recorded_hashes(self, engine: str) -> None:
        for name, entry in sorted(self.index()[engine].items()):
            path = REPO_ROOT / str(entry["file"])
            assert path.is_file(), f"{engine}/{name}: golden file missing"
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            assert digest == entry["sha256"], f"{engine}/{name}: golden file was modified"

    @available
    @pytest.mark.parametrize(
        ("name", "settings", "source", "expected_size"),
        [
            (
                "resize-bicubic-32",
                ResizeSettings(algorithm="bicubic", target_width=32, target_height=32),
                SMOOTH,
                (32, 32),
            ),
            (
                "resize-lanczos-32",
                ResizeSettings(algorithm="lanczos", target_width=32, target_height=32),
                SMOOTH,
                (32, 32),
            ),
            (
                "resize-lanczos-128-upscale",
                ResizeSettings(algorithm="lanczos", target_width=128, target_height=128),
                SMOOTH,
                (128, 128),
            ),
            ("crop-centre-32", CropSettings(x=16, y=16, width=32, height=32), SMOOTH, (32, 32)),
            ("rotate-90", RotateSettings(degrees=90), SMOOTH, (64, 64)),
            ("flip-horizontal", FlipSettings(axis="horizontal"), SMOOTH, (64, 64)),
            ("adjust-brighter", AdjustSettings(brightness_percent=20), SMOOTH, (64, 64)),
            (
                "sharpen-moderate",
                SharpenSettings(amount_percent=80, radius_x100=200),
                NOISE,
                (64, 64),
            ),
            ("denoise-moderate", DenoiseSettings(strength_percent=30), NOISE, (64, 64)),
            (
                "convert-to-jpeg-q90",
                ConvertSettings(target_media_type=MediaType.JPEG, quality=90),
                SMOOTH,
                (64, 64),
            ),
        ],
    )
    def test_output_matches_the_golden_exactly(
        self,
        engine: str,
        name: str,
        settings: AnySettings,
        source: str,
        expected_size: tuple[int, int],
        ctx: RunContext,
    ) -> None:
        payload, outcome = run(engine, settings, ctx, source)
        assert payload is not None, f"{engine}/{name} failed: {outcome.failure}"  # type: ignore[attr-defined]

        entry = self.index()[engine][name]
        assert (outcome.output.width, outcome.output.height) == expected_size  # type: ignore[attr-defined]
        assert hashlib.sha256(payload).hexdigest() == entry["sha256"], (
            f"{engine}/{name} output changed. Either a library version moved or a "
            f"regression landed. Run 'python tools/make_goldens.py --check', review the "
            f"visual diff, then regenerate deliberately."
        )

    @available
    def test_repeated_runs_are_byte_identical(self, engine: str, ctx: RunContext) -> None:
        settings = ResizeSettings(algorithm="lanczos", target_width=32, target_height=32)
        first, _ = run(engine, settings, ctx)
        second, _ = run(engine, settings, ctx)
        assert first is not None
        assert first == second

    def test_the_two_engines_differ(self, ctx: RunContext) -> None:
        """Not a defect: different resampling and encoders is why both are benchmarked."""
        if not vips_available():
            pytest.skip("libvips not installed on this host")
        settings = ResizeSettings(algorithm="lanczos", target_width=32, target_height=32)
        pillow_bytes, _ = run("pillow", settings, ctx)
        vips_bytes, _ = run("libvips", settings, ctx)
        assert pillow_bytes != vips_bytes


class TestNormalisedFailures:
    """Invalid combinations return failures, never exceptions."""

    @available
    def test_a_crop_outside_the_image_fails_normally(self, engine: str, ctx: RunContext) -> None:
        payload, outcome = run(engine, CropSettings(x=0, y=0, width=999, height=999), ctx)
        assert payload is None
        assert not outcome.succeeded  # type: ignore[attr-defined]
        assert outcome.failure is not None  # type: ignore[attr-defined]
        assert outcome.failure.code.value == "PROCESSOR.INTERNAL_ERROR"  # type: ignore[attr-defined]

    @available
    def test_an_unsupported_output_format_is_refused_before_processing(self, engine: str) -> None:
        processor = processor_for(engine)
        settings = ConvertSettings(target_media_type=MediaType.TIFF, quality=90)
        operation = Operation.build(settings, ProcessingVariant.STANDARD_SERVER_AUTHORITATIVE)
        support = processor.supports(operation, settings)
        assert not support.supported
        assert support.failure is not None
        assert support.failure.code.value == "PROCESSOR.SETTINGS_UNSUPPORTED"

    @available
    def test_a_hostile_input_is_refused_by_inspection(self, engine: str, ctx: RunContext) -> None:
        """The POC-003 header guard runs before any decode."""
        processor = processor_for(engine)
        settings = ResizeSettings(target_width=8, target_height=8)
        operation = Operation.build(settings, ProcessingVariant.STANDARD_SERVER_AUTHORITATIVE)
        with workspace(ctx.temp_root, "t") as ws:
            outcome = processor.process(
                ref_for("decompression-bomb.png"), operation, settings, ws, ctx
            )
        assert not outcome.succeeded
        assert outcome.failure is not None
        assert outcome.failure.code.value == "SAFETY.DECOMPRESSION_BOMB"

    @available
    def test_nothing_escapes_the_processor_boundary(self, engine: str, ctx: RunContext) -> None:
        missing = InputRef(
            asset_id="absent",
            expected_sha256="0" * 64,
            path=FIXTURES / "does-not-exist.png",
            declared_bytes=0,
        )
        settings = ResizeSettings(target_width=8, target_height=8)
        operation = Operation.build(settings, ProcessingVariant.STANDARD_SERVER_AUTHORITATIVE)
        with workspace(ctx.temp_root, "t") as ws:
            outcome = guarded_process(processor_for(engine), missing, operation, settings, ws, ctx)
        assert not outcome.succeeded
        assert outcome.failure is not None

    def test_the_engine_raises_engine_error_not_a_library_error(self) -> None:
        """The seam normalises library-specific exceptions."""
        with pytest.raises(EngineError, match="could not decode"):
            PillowEngine().load(str(FIXTURES / "not-an-image.png"))


class TestTransparencyAndMetadata:
    @available
    def test_converting_transparency_to_jpeg_requires_an_explicit_background(
        self, engine: str, ctx: RunContext
    ) -> None:
        """USER_FLOWS section 5: transparency loss must be a stated choice."""
        settings = ConvertSettings(target_media_type=MediaType.JPEG, quality=90)
        payload, outcome = run(engine, settings, ctx, ALPHA)
        assert payload is None, "converting alpha to JPEG must not silently drop transparency"
        assert outcome.failure is not None  # type: ignore[attr-defined]
        assert "transparen" in outcome.failure.message.lower()  # type: ignore[attr-defined]

    @available
    def test_an_explicit_background_flattens_successfully(
        self, engine: str, ctx: RunContext
    ) -> None:
        settings = ConvertSettings(
            target_media_type=MediaType.JPEG, quality=90, flatten_background="#ffffff"
        )
        payload, outcome = run(engine, settings, ctx, ALPHA)
        assert payload is not None, outcome.failure  # type: ignore[attr-defined]
        assert outcome.output.media_type == "image/jpeg"  # type: ignore[attr-defined]

    @available
    def test_alpha_survives_a_png_round_trip(self, engine: str, ctx: RunContext) -> None:
        import io

        from PIL import Image

        settings = ConvertSettings(target_media_type=MediaType.PNG, quality=95)
        payload, outcome = run(engine, settings, ctx, ALPHA)
        assert payload is not None, outcome.failure  # type: ignore[attr-defined]
        with Image.open(io.BytesIO(payload)) as written:
            assert written.mode in {"RGBA", "LA", "P"}, "PNG output must keep transparency"

    @available
    def test_output_is_authoritative_not_a_preview(self, engine: str, ctx: RunContext) -> None:
        """D-019: server-side standard output is the authoritative result."""
        _, outcome = run(engine, ResizeSettings(target_width=32, target_height=32), ctx)
        assert outcome.output is not None  # type: ignore[attr-defined]
        assert outcome.output.is_preview is False  # type: ignore[attr-defined]


class TestOriginalPreservation:
    @available
    def test_every_operation_leaves_the_source_unchanged(
        self, engine: str, ctx: RunContext
    ) -> None:
        before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in FIXTURES.iterdir()}
        for settings in (
            ResizeSettings(target_width=32, target_height=32),
            CropSettings(x=0, y=0, width=16, height=16),
            RotateSettings(degrees=180),
            AdjustSettings(brightness_percent=10),
            DenoiseSettings(strength_percent=30),
        ):
            run(engine, settings, ctx)
        after = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in FIXTURES.iterdir()}
        assert after == before

    @available
    def test_no_workspace_survives(self, engine: str, tmp_path: Path) -> None:
        temp_root = tmp_path / "tmp"
        ctx = RunContext.create(temp_root=temp_root, deterministic=True)
        run(engine, ResizeSettings(target_width=32, target_height=32), ctx)
        leftovers = list(temp_root.iterdir()) if temp_root.exists() else []
        assert leftovers == []


class TestMeasurement:
    """Timing and memory must populate the report, with honest methods."""

    @available
    def test_timing_is_recorded(self, engine: str, ctx: RunContext) -> None:
        _, outcome = run(engine, ResizeSettings(target_width=32, target_height=32), ctx)
        timing = outcome.measurement.timing  # type: ignore[attr-defined]
        assert timing.total_ns > 0
        assert timing.preprocess_ns > 0, "header inspection should be measured"
        assert timing.total_ns >= timing.inference_ns

    @available
    def test_memory_is_recorded_with_its_method(self, engine: str, ctx: RunContext) -> None:
        _, outcome = run(engine, ResizeSettings(target_width=32, target_height=32), ctx)
        memory = outcome.measurement.memory  # type: ignore[attr-defined]
        assert memory.peak_rss_bytes > 0
        assert memory.measurement_method != "not_measured", (
            "a measurement must say how it was taken, so a later reader is not misled"
        )
        assert memory.peak_vram_bytes is None, "a standard CPU processor uses no VRAM"

    @available
    def test_byte_counts_are_recorded(self, engine: str, ctx: RunContext) -> None:
        payload, outcome = run(engine, ResizeSettings(target_width=32, target_height=32), ctx)
        assert payload is not None
        measurement = outcome.measurement  # type: ignore[attr-defined]
        assert measurement.input_bytes == (FIXTURES / SMOOTH).stat().st_size
        assert measurement.output_bytes == len(payload)
        assert measurement.output_width == 32

    @available
    def test_estimation_does_not_decode(self, engine: str, ctx: RunContext) -> None:
        settings = ResizeSettings(target_width=32, target_height=32)
        operation = Operation.build(settings, ProcessingVariant.STANDARD_SERVER_AUTHORITATIVE)
        estimate = processor_for(engine).estimate(ref_for(SMOOTH), operation, settings, ctx)
        assert estimate.estimated_duration_ns > 0
        assert estimate.estimated_peak_memory_bytes > 0
        assert estimate.confidence == "low", "uncalibrated until POC-014 measures the real cost"


class TestResizeSemantics:
    @available
    def test_a_rational_scale_matches_the_equivalent_target(
        self, engine: str, ctx: RunContext
    ) -> None:
        by_target, _ = run(
            engine, ResizeSettings(algorithm="bicubic", target_width=32, target_height=32), ctx
        )
        by_scale, _ = run(
            engine,
            ResizeSettings(algorithm="bicubic", scale_numerator=1, scale_denominator=2),
            ctx,
        )
        assert by_target == by_scale

    @available
    def test_aspect_ratio_is_preserved_when_one_axis_is_given(
        self, engine: str, ctx: RunContext
    ) -> None:
        _, outcome = run(engine, ResizeSettings(target_width=32), ctx)
        assert outcome.output is not None  # type: ignore[attr-defined]
        assert (outcome.output.width, outcome.output.height) == (32, 32)  # type: ignore[attr-defined]

    @available
    def test_upscaling_does_not_claim_added_detail(self, engine: str, ctx: RunContext) -> None:
        """D-024 / blueprint section 8: standard upscaling adds pixels, not detail."""
        _, outcome = run(
            engine, ResizeSettings(algorithm="lanczos", target_width=128, target_height=128), ctx
        )
        identity = processor_for(engine).describe()
        assert identity.family is OperationFamily.STANDARD
        assert outcome.output is not None  # type: ignore[attr-defined]
        assert (outcome.output.width, outcome.output.height) == (128, 128)  # type: ignore[attr-defined]
