"""Real-ESRGAN adapter (POC-006).

Acceptance criteria:

* Adapter passes processor-contract tests.
* 2x/4x behaviour is accurately described.
* Small and tiled inputs run reproducibly within documented tolerance.
* Failure and cleanup paths are tested.
* Results compare against deterministic resize, not only the original.

Inference is slow on CPU - roughly three seconds for a 64x64 image - so tests use
the smallest fixtures that still exercise the behaviour, and the loaded model is
shared across a module. Where a test does not need inference at all, it does not
run it.
"""

from __future__ import annotations

import hashlib
import io
import tempfile
import tomllib
from pathlib import Path
from typing import Literal

import pytest

from ipw.benchmark_runner.conformance import assert_processor_conforms
from ipw.contracts.failure import FailureCategory
from ipw.contracts.operation import (
    FAMILY_OF,
    AnySettings,
    NoopSettings,
    Operation,
    OperationFamily,
    OperationKind,
    ProcessingVariant,
    ResizeSettings,
    SuperResolutionSettings,
)
from ipw.contracts.processor import ProcessOutcome
from ipw.contracts.runtime import InputRef, RunContext, workspace
from ipw.processors.ai_adapters import PINNED_WEIGHTS, RealEsrganAdapter, no_network
from ipw.processors.ai_adapters.rrdbnet import build_rrdbnet
from ipw.processors.base import guarded_process
from ipw.processors.standard import pillow_processor

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "data" / "fixtures" / "images"
SMALL = FIXTURES / "synthetic-grey-16.jpg"  # 16x16: the cheapest real inference
NOISE = FIXTURES / "synthetic-noise-64.png"

torch = pytest.importorskip("torch", reason="the inference runtime is not installed")

WEIGHTS_PRESENT = all(
    (REPO_ROOT / ".tools" / "models" / spec.filename).is_file() for spec in PINNED_WEIGHTS.values()
)
needs_weights = pytest.mark.skipif(
    not WEIGHTS_PRESENT,
    reason="pinned weights not installed; run python tools/install_model_weights.py",
)


def ref_for(path: Path, asset_id: str = "ai-test") -> InputRef:
    payload = path.read_bytes()
    return InputRef(
        asset_id=asset_id,
        expected_sha256=hashlib.sha256(payload).hexdigest(),
        path=path,
        declared_bytes=len(payload),
    )


@pytest.fixture(scope="module")
def adapter_x4() -> RealEsrganAdapter:
    """One adapter for the module: loading the model costs about four seconds."""
    return RealEsrganAdapter(scale=4)


def run(
    adapter: RealEsrganAdapter, source: Path, scale: Literal[2, 4], ctx: RunContext
) -> ProcessOutcome:
    operation = Operation.build(
        SuperResolutionSettings(scale=scale, mode="natural"), ProcessingVariant.AI_NATURAL
    )
    with workspace(ctx.temp_root, "ai") as ws:
        return adapter.process(ref_for(source), operation, operation.settings, ws, ctx)


# ------------------------------------------------------------------ identity --


class TestIdentity:
    def test_declares_the_ai_family_and_pinned_weights(self, adapter_x4: RealEsrganAdapter) -> None:
        identity = adapter_x4.describe()
        assert identity.family is OperationFamily.AI
        assert identity.weights is not None
        assert identity.weights.sha256 == PINNED_WEIGHTS[4].sha256
        assert identity.weights.pinned_version == "v0.1.0"

    def test_an_ai_processor_cannot_exist_without_a_weight_hash(self) -> None:
        """The contract enforces it; this confirms the adapter satisfies it."""
        identity = RealEsrganAdapter(scale=2).describe()
        assert identity.weights is not None
        assert len(identity.weights.sha256) == 64

    def test_records_precision_and_tiling(self, adapter_x4: RealEsrganAdapter) -> None:
        identity = adapter_x4.describe()
        assert identity.precision == "fp32"
        assert identity.tile_size == 256
        assert identity.tile_overlap == 16

    def test_declares_no_network_requirement(self, adapter_x4: RealEsrganAdapter) -> None:
        assert adapter_x4.describe().requires_network is False

    def test_the_adapter_pins_match_the_installer(self) -> None:
        """The two lists are duplicated on purpose; drift between them is a defect."""
        installer = REPO_ROOT / "tools" / "install_model_weights.py"
        source = installer.read_text(encoding="utf-8")
        for spec in PINNED_WEIGHTS.values():
            assert spec.sha256 in source, f"{spec.filename} digest differs from the installer"
            assert spec.release_tag in source

    def test_the_weight_digest_matches_the_licence_register(self) -> None:
        from ipw.benchmark_runner.licence_register import load_register, register_path

        register = load_register(register_path(REPO_ROOT))
        for spec in PINNED_WEIGHTS.values():
            component = register.get(spec.component_id)
            assert component is not None, f"{spec.component_id} is not registered"
            assert component.weights_sha256 == spec.sha256


# -------------------------------------------------------- never face restore --


class TestNeverInvokesFaceRestoration:
    """POC-006: 'Never silently invoke face restoration.'"""

    def test_declares_super_resolution_only(self, adapter_x4: RealEsrganAdapter) -> None:
        assert adapter_x4.describe().supported_operations == (OperationKind.SUPER_RESOLUTION,)

    @pytest.mark.parametrize(
        "settings",
        [NoopSettings(), ResizeSettings(target_width=32, target_height=32)],
    )
    def test_refuses_every_other_operation(
        self, adapter_x4: RealEsrganAdapter, settings: AnySettings
    ) -> None:
        operation = Operation.build(settings, ProcessingVariant.ORIGINAL_CONTROL)
        support = adapter_x4.supports(operation, settings)
        assert not support.supported
        assert support.failure is not None
        assert support.failure.code.value == "PROCESSOR.OPERATION_UNSUPPORTED"

    def test_face_restoration_is_not_a_declared_operation(
        self, adapter_x4: RealEsrganAdapter
    ) -> None:
        assert OperationKind.FACE_RESTORE not in adapter_x4.describe().supported_operations

    def test_no_face_model_is_importable_from_the_executed_path(self) -> None:
        """The structural guarantee: gfpgan is not installed at all.

        The official realesrgan package hard-depends on it. Reimplementing the
        generator means a face model cannot be invoked because it does not exist,
        rather than because this code chooses not to call it.
        """
        import importlib.util

        for module in ("gfpgan", "facexlib", "basicsr"):
            assert importlib.util.find_spec(module) is None, (
                f"{module} is installed; a face-restoration path exists in the environment"
            )


# --------------------------------------------------------------- scale rules --


class TestScaleIsDescribedAccurately:
    """Benchmark plan §7: never present a post-resized result as a native scale."""

    def test_the_x4_adapter_refuses_a_x2_request(self, adapter_x4: RealEsrganAdapter) -> None:
        settings = SuperResolutionSettings(scale=2)
        operation = Operation.build(settings, ProcessingVariant.AI_NATURAL)
        support = adapter_x4.supports(operation, settings)
        assert not support.supported
        assert support.failure is not None
        assert "native x4" in support.failure.message
        assert support.failure.remediation is not None
        assert "not equivalent" in support.failure.remediation

    def test_each_scale_has_its_own_pinned_checkpoint(self) -> None:
        """The native scale is the key, so a spec cannot disagree with its slot.

        POC-007 moved WeightSpec into the shared Gate B module, where a native
        scale has no meaning - SwinIR's denoise weights do not have one. Keying the
        table by scale says the same thing without a field that can drift out of
        step with the file it describes.
        """
        assert PINNED_WEIGHTS[2].sha256 != PINNED_WEIGHTS[4].sha256
        assert PINNED_WEIGHTS[2].bytes_expected != PINNED_WEIGHTS[4].bytes_expected
        for scale, spec in PINNED_WEIGHTS.items():
            assert f"x{scale}plus" in spec.filename, (
                f"the x{scale} slot holds {spec.filename}, which is not an x{scale} checkpoint"
            )

    def test_an_unpinned_scale_is_refused_at_construction(self) -> None:
        with pytest.raises(ValueError, match="no pinned weights"):
            RealEsrganAdapter(scale=3)


# ------------------------------------------------------------- architecture --


class TestArchitecture:
    @needs_weights
    @pytest.mark.parametrize("scale", [2, 4])
    def test_the_official_checkpoint_loads_strictly(self, scale: int) -> None:
        """A wrong architecture cannot load; it fails rather than producing wrong output."""
        spec = PINNED_WEIGHTS[scale]
        checkpoint = torch.load(
            REPO_ROOT / ".tools" / "models" / spec.filename, map_location="cpu", weights_only=True
        )
        state = checkpoint.get("params_ema") or checkpoint.get("params") or checkpoint
        model = build_rrdbnet(scale)
        model.load_state_dict(state, strict=True)
        assert sum(p.numel() for p in model.parameters()) > 16_000_000

    @needs_weights
    def test_a_wrong_configuration_cannot_load_the_checkpoint(self) -> None:
        from ipw.processors.ai_adapters.rrdbnet import RRDBNet

        wrong = RRDBNet(features=32, blocks=5, scale=4)
        spec = PINNED_WEIGHTS[4]
        checkpoint = torch.load(
            REPO_ROOT / ".tools" / "models" / spec.filename, map_location="cpu", weights_only=True
        )
        state = checkpoint.get("params_ema") or checkpoint.get("params") or checkpoint
        with pytest.raises(RuntimeError):
            wrong.load_state_dict(state, strict=True)

    def test_odd_dimensions_are_refused_by_the_x2_path(self) -> None:
        """Pixel unshuffle needs even dimensions; the failure is explicit."""
        model = build_rrdbnet(2)
        with pytest.raises(ValueError, match="divisible by 2"):
            model(torch.zeros(1, 3, 7, 7))


# ----------------------------------------------------------------- gate B ----


class TestSupplyChainEnforcement:
    def test_a_tampered_weight_file_is_refused(self, tmp_path: Path) -> None:
        """Gate B is checked at the moment of use, not merely recorded.

        The substituted file is deliberately not a valid checkpoint. If the digest
        were checked after loading - or not at all - this would reach the
        unpickler, which is the exact failure this guard exists to prevent.
        """
        spec = PINNED_WEIGHTS[4]
        tampered_dir = tmp_path / "models"
        tampered_dir.mkdir()
        (tampered_dir / spec.filename).write_bytes(b"not the pinned weights")

        adapter = RealEsrganAdapter(scale=4, weights_dir=tampered_dir)
        with tempfile.TemporaryDirectory() as td:
            ctx = RunContext.create(temp_root=Path(td), deterministic=True)
            outcome = run(adapter, SMALL, 4, ctx)

        assert not outcome.succeeded
        assert outcome.failure is not None
        assert outcome.failure.code.value == "PROCESSOR.INTERNAL_ERROR"

    def test_missing_weights_report_unavailable_rather_than_crashing(self, tmp_path: Path) -> None:
        adapter = RealEsrganAdapter(scale=4, weights_dir=tmp_path / "absent")
        settings = SuperResolutionSettings(scale=4)
        operation = Operation.build(settings, ProcessingVariant.AI_NATURAL)
        support = adapter.supports(operation, settings)
        assert not support.supported
        assert support.failure is not None
        assert support.failure.category is FailureCategory.PROCESSOR_UNAVAILABLE
        assert support.failure.remediation is not None
        assert "install_model_weights" in support.failure.remediation

    def test_network_access_is_blocked_inside_the_guard(self) -> None:
        import socket

        with no_network(), pytest.raises(OSError, match="disabled during inference"):
            socket.create_connection(("example.invalid", 80), timeout=1)

    def test_network_access_is_restored_afterwards(self) -> None:
        import socket

        original = socket.create_connection
        with no_network():
            pass
        assert socket.create_connection is original


# --------------------------------------------------------------- inference ---


@needs_weights
class TestInference:
    def test_x4_produces_four_times_the_dimensions(
        self, adapter_x4: RealEsrganAdapter, ctx: RunContext
    ) -> None:
        outcome = run(adapter_x4, SMALL, 4, ctx)
        assert outcome.succeeded, outcome.failure
        assert outcome.output is not None
        assert (outcome.output.width, outcome.output.height) == (64, 64)

    def test_x2_produces_double_the_dimensions(self, ctx: RunContext) -> None:
        outcome = run(RealEsrganAdapter(scale=2), SMALL, 2, ctx)
        assert outcome.succeeded, outcome.failure
        assert outcome.output is not None
        assert (outcome.output.width, outcome.output.height) == (32, 32)

    def test_output_is_authoritative_not_a_preview(
        self, adapter_x4: RealEsrganAdapter, ctx: RunContext
    ) -> None:
        outcome = run(adapter_x4, SMALL, 4, ctx)
        assert outcome.output is not None
        assert outcome.output.is_preview is False

    def test_repeated_inference_is_reproducible(
        self, adapter_x4: RealEsrganAdapter, ctx: RunContext
    ) -> None:
        """fp32 CPU convolution is deterministic within one build and thread count."""
        first = run(adapter_x4, SMALL, 4, ctx)
        second = run(adapter_x4, SMALL, 4, ctx)
        assert first.output is not None
        assert second.output is not None
        assert first.output.sha256 == second.output.sha256

    def test_timing_and_memory_populate_the_result(
        self, adapter_x4: RealEsrganAdapter, tmp_path: Path
    ) -> None:
        # A real clock: the deterministic clock is synthetic and would report
        # timings that mean nothing.
        ctx = RunContext.create(temp_root=tmp_path / "t", deterministic=False)
        outcome = run(adapter_x4, SMALL, 4, ctx)
        timing = outcome.measurement.timing
        assert timing.total_ns > 0
        assert timing.inference_ns > 0
        assert outcome.measurement.memory.peak_rss_bytes > 0
        assert outcome.measurement.memory.peak_vram_bytes is None, "no GPU on this host"

    def test_cold_and_warm_states_are_distinguished(
        self, adapter_x4: RealEsrganAdapter, tmp_path: Path
    ) -> None:
        ctx = RunContext.create(temp_root=tmp_path / "t", deterministic=False)
        run(adapter_x4, SMALL, 4, ctx)  # ensures the model is loaded
        warm = run(adapter_x4, SMALL, 4, ctx)
        assert warm.measurement.timing.cold_or_warm.value == "warm"
        assert warm.measurement.timing.cold_start_ns == 0

    def test_the_original_is_unchanged(
        self, adapter_x4: RealEsrganAdapter, ctx: RunContext
    ) -> None:
        ref = ref_for(SMALL)
        before = ref.compute_sha256()
        run(adapter_x4, SMALL, 4, ctx)
        assert ref.compute_sha256() == before

    def test_tiling_produces_the_same_dimensions_as_a_single_pass(self, tmp_path: Path) -> None:
        """A tile smaller than the image forces the tiled path."""
        ctx = RunContext.create(temp_root=tmp_path / "t", deterministic=True)
        tiled = RealEsrganAdapter(scale=4, tile_size=32, tile_overlap=8)
        outcome = run(tiled, NOISE, 4, ctx)
        assert outcome.succeeded, outcome.failure
        assert outcome.output is not None
        assert (outcome.output.width, outcome.output.height) == (256, 256)


# ------------------------------------------------------------- comparisons ---


@needs_weights
class TestComparedWithDeterministicResize:
    """Acceptance: results compare against deterministic resize, not only the original."""

    def test_both_paths_produce_the_same_dimensions(
        self, adapter_x4: RealEsrganAdapter, ctx: RunContext
    ) -> None:
        ai = run(adapter_x4, SMALL, 4, ctx)

        settings = ResizeSettings(algorithm="lanczos", target_width=64, target_height=64)
        operation = Operation.build(settings, ProcessingVariant.STANDARD_SERVER_AUTHORITATIVE)
        with workspace(ctx.temp_root, "std") as ws:
            baseline = pillow_processor().process(ref_for(SMALL), operation, settings, ws, ctx)

        assert ai.output is not None
        assert baseline.output is not None
        assert (ai.output.width, ai.output.height) == (
            baseline.output.width,
            baseline.output.height,
        )

    def test_the_two_paths_differ(self, adapter_x4: RealEsrganAdapter, ctx: RunContext) -> None:
        """If they matched, the model would be adding nothing over a resize."""
        ai = run(adapter_x4, SMALL, 4, ctx)

        settings = ResizeSettings(algorithm="lanczos", target_width=64, target_height=64)
        operation = Operation.build(settings, ProcessingVariant.STANDARD_SERVER_AUTHORITATIVE)
        with workspace(ctx.temp_root, "std") as ws:
            baseline = pillow_processor().process(ref_for(SMALL), operation, settings, ws, ctx)

        assert ai.output is not None
        assert baseline.output is not None
        assert ai.output.sha256 != baseline.output.sha256

    def test_the_families_are_recorded_distinctly(self, adapter_x4: RealEsrganAdapter) -> None:
        assert adapter_x4.describe().family is OperationFamily.AI
        assert pillow_processor().describe().family is OperationFamily.STANDARD
        assert FAMILY_OF[OperationKind.SUPER_RESOLUTION] is OperationFamily.AI


# ------------------------------------------------------------- conformance ---


@needs_weights
class TestContractConformance:
    def test_conforms_to_the_processor_contract(self, tmp_path: Path) -> None:
        """The same suite the fake and standard processors pass."""
        assert_processor_conforms(lambda: RealEsrganAdapter(scale=4), tmp_path)

    def test_no_workspace_survives_a_run(self, tmp_path: Path) -> None:
        temp_root = tmp_path / "tmp"
        ctx = RunContext.create(temp_root=temp_root, deterministic=True)
        run(RealEsrganAdapter(scale=4), SMALL, 4, ctx)
        assert (list(temp_root.iterdir()) if temp_root.exists() else []) == []

    def test_a_hostile_input_is_refused_by_inspection(
        self, adapter_x4: RealEsrganAdapter, ctx: RunContext
    ) -> None:
        outcome = run(adapter_x4, FIXTURES / "decompression-bomb.png", 4, ctx)
        assert not outcome.succeeded
        assert outcome.failure is not None
        assert outcome.failure.code.value == "SAFETY.DECOMPRESSION_BOMB"

    def test_nothing_escapes_the_boundary_for_a_missing_input(
        self, adapter_x4: RealEsrganAdapter, ctx: RunContext
    ) -> None:
        missing = InputRef(
            asset_id="absent",
            expected_sha256="0" * 64,
            path=FIXTURES / "does-not-exist.png",
            declared_bytes=0,
        )
        settings = SuperResolutionSettings(scale=4)
        operation = Operation.build(settings, ProcessingVariant.AI_NATURAL)
        with workspace(ctx.temp_root, "ai") as ws:
            outcome = guarded_process(adapter_x4, missing, operation, settings, ws, ctx)
        assert not outcome.succeeded
        assert outcome.failure is not None


# ------------------------------------------------------------ licence gate ---


class TestLicenceGating:
    """The register decides what this adapter may be used for, not the adapter."""

    def test_research_is_permitted_and_marked(self) -> None:
        from ipw.benchmark_runner.licence_register import load_register, register_path
        from ipw.contracts.licence import RunPurpose

        register = load_register(register_path(REPO_ROOT))
        decision = register.evaluate("real-esrgan", RunPurpose.INTERNAL_BENCHMARK)
        assert decision.permitted
        assert not decision.eligible_for_commercial_recommendation
        assert decision.warnings, "a non-approved research run must warn, never pass silently"

    def test_production_is_blocked(self) -> None:
        from ipw.benchmark_runner.licence_register import load_register, register_path
        from ipw.contracts.licence import RunPurpose

        register = load_register(register_path(REPO_ROOT))
        for purpose in (RunPurpose.PUBLIC_DEMO, RunPurpose.STAGING, RunPurpose.PRODUCTION):
            assert not register.evaluate("real-esrgan", purpose).permitted

    def test_the_dataset_restriction_is_recorded(self) -> None:
        """DIV2K is research-only, and that propagates by inheritance."""
        from ipw.benchmark_runner.licence_register import load_register, register_path
        from ipw.contracts.licence import Disposition

        register = load_register(register_path(REPO_ROOT))
        div2k = register.get("div2k-dataset")
        assert div2k is not None
        assert div2k.disposition is Disposition.NON_COMMERCIAL
        assert div2k.evidence is not None
        assert "academic research purpose only" in div2k.evidence

        # The composite must not be more permissive than its training data.
        assert register.effective_disposition("real-esrgan") is not Disposition.APPROVED

    def test_the_workspace_declares_torch_as_a_dependency(self) -> None:
        config = tomllib.loads(
            (REPO_ROOT / "packages" / "processors" / "pyproject.toml").read_text(encoding="utf-8")
        )
        declared = " ".join(config["project"]["dependencies"]).lower()
        assert "torch" in declared
        assert "numpy" in declared


@needs_weights
class TestTilingIsNotFree:
    """Tiling changes the output, and the benchmark must not pretend otherwise.

    A convolutional network sees a limited context. Splitting an image into tiles
    gives every tile less context than the whole image had, and the overlap
    margins reduce that penalty without removing it. Measured on the 64x64 noise
    fixture at x4:

    ==================  ====================  ==========  ===========
    tiling              subpixels differing   max delta   mean delta
    ==================  ====================  ==========  ===========
    tile 32, overlap 8  105,999 / 196,608     8 / 255     0.71
    tile 16, overlap 4  165,888 / 196,608     16 / 255    2.22
    ==================  ====================  ==========  ===========

    Small, bounded, and real. POC-012 measures whether it is visible; what matters
    here is that a tiled result and a whole-image result are **different results**
    and must never be averaged into one figure.
    """

    def test_tiling_changes_the_output(self, ctx: RunContext) -> None:
        whole = run(RealEsrganAdapter(scale=4), NOISE, 4, ctx)
        tiled = run(RealEsrganAdapter(scale=4, tile_size=32, tile_overlap=8), NOISE, 4, ctx)
        assert whole.output is not None
        assert tiled.output is not None
        assert whole.output.sha256 != tiled.output.sha256, (
            "tiled and whole-image inference produced identical bytes; either the tiled "
            "path was not taken or it is not doing what this test believes it does"
        )

    def test_the_difference_stays_bounded(self, ctx: RunContext) -> None:
        """A seam would show up as a large delta on a few pixels, not a small one."""
        from PIL import Image

        outputs: list[bytes] = []
        for adapter in (
            RealEsrganAdapter(scale=4),
            RealEsrganAdapter(scale=4, tile_size=32, tile_overlap=8),
        ):
            operation = Operation.build(
                SuperResolutionSettings(scale=4, mode="natural"), ProcessingVariant.AI_NATURAL
            )
            with workspace(ctx.temp_root, "ai") as ws:
                outcome = adapter.process(ref_for(NOISE), operation, operation.settings, ws, ctx)
                assert outcome.succeeded, outcome.failure
                assert outcome.output is not None
                outputs.append((ws.root / outcome.output.relative_path).read_bytes())

        channels: list[bytes] = []
        for payload in outputs:
            with Image.open(io.BytesIO(payload)) as handle:
                handle.load()
                channels.append(handle.convert("RGB").tobytes())

        deltas = [abs(a - b) for a, b in zip(*channels, strict=True)]
        assert max(deltas) <= 16, f"tiling shifted a subpixel by {max(deltas)}/255; check the seams"
        assert sum(deltas) / len(deltas) < 2.0, "mean tiling deviation is larger than measured"

    def test_tiling_settings_are_part_of_the_run_identity(self) -> None:
        """Two runs with different tiling are visibly different runs, not one.

        Without this the benchmark could compare a tiled result against a
        whole-image result under a single identifier and report the difference as
        a model property.
        """
        import hashlib

        from ipw.benchmark_runner.canonical import canonical_json
        from ipw.contracts.run import ProcessorIdentityDigest

        def digest(adapter: RealEsrganAdapter) -> str:
            document = ProcessorIdentityDigest.of(adapter.describe()).model_dump(mode="json")
            return hashlib.sha256(canonical_json(document)).hexdigest()

        digests = {
            digest(RealEsrganAdapter(scale=4, tile_size=256, tile_overlap=16)),
            digest(RealEsrganAdapter(scale=4, tile_size=32, tile_overlap=8)),
            digest(RealEsrganAdapter(scale=4, tile_size=32, tile_overlap=4)),
        }
        assert len(digests) == 3, "tile size and overlap must both reach the run identity"
