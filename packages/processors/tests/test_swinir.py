"""SwinIR adapter and the vendored architecture (POC-007).

Acceptance criteria:

* Licence gate passes for executed code, weights and dependencies.
* Results use identical manifest/report structures.
* Runtime and quality comparison against Real-ESRGAN and deterministic baselines.
* No winner is declared from objective metrics alone.

SwinIR is a transformer and is slower than Real-ESRGAN - roughly a second per
64x64 image on CPU - so tests use the smallest inputs that still exercise the
behaviour and share one loaded model per variant.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from ipw.benchmark_runner.conformance import assert_processor_conforms
from ipw.contracts.failure import FailureCategory
from ipw.contracts.operation import (
    FAMILY_OF,
    AiDenoiseSettings,
    AnySettings,
    DenoiseSettings,
    JpegArtifactRepairSettings,
    NoopSettings,
    Operation,
    OperationFamily,
    OperationKind,
    ProcessingVariant,
    SuperResolutionSettings,
)
from ipw.contracts.processor import ProcessOutcome
from ipw.contracts.runtime import InputRef, RunContext, workspace
from ipw.processors.ai_adapters import SWINIR_VARIANTS, SwinIrAdapter, variant_for
from ipw.processors.base import guarded_process

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "data" / "fixtures" / "images"
SMALL = FIXTURES / "synthetic-grey-16.jpg"
NOISE = FIXTURES / "synthetic-noise-64.png"

pytest.importorskip("torch", reason="the inference runtime is not installed")

WEIGHTS_PRESENT = all(
    (REPO_ROOT / ".tools" / "models" / variant.spec.filename).is_file()
    for variant in SWINIR_VARIANTS.values()
)
needs_weights = pytest.mark.skipif(
    not WEIGHTS_PRESENT,
    reason="pinned weights not installed; run python tools/install_model_weights.py",
)


def ref_for(path: Path, asset_id: str = "swinir-test") -> InputRef:
    payload = path.read_bytes()
    return InputRef(
        asset_id=asset_id,
        expected_sha256=hashlib.sha256(payload).hexdigest(),
        path=path,
        declared_bytes=len(payload),
    )


def run(
    adapter: SwinIrAdapter, source: Path, settings: AnySettings, ctx: RunContext
) -> ProcessOutcome:
    variant = (
        ProcessingVariant.AI_TASK_SPECIFIC
        if settings.kind is OperationKind.JPEG_ARTIFACT_REPAIR
        else ProcessingVariant.AI_NATURAL
    )
    operation = Operation.build(settings, variant)
    with workspace(ctx.temp_root, "swin") as ws:
        return adapter.process(ref_for(source), operation, settings, ws, ctx)


@pytest.fixture(scope="module")
def sr_x4() -> SwinIrAdapter:
    return SwinIrAdapter(variant_key="sr-x4")


# ------------------------------------------------------------------ variants --


class TestVariantTable:
    def test_every_variant_declares_one_operation(self) -> None:
        for key, variant in SWINIR_VARIANTS.items():
            assert variant.key == key
            assert FAMILY_OF[variant.operation] is OperationFamily.AI

    def test_the_three_poc007_task_types_are_covered(self) -> None:
        """POC-007's goal names super-resolution, denoise and JPEG artifacts."""
        covered = {variant.operation for variant in SWINIR_VARIANTS.values()}
        assert covered == {
            OperationKind.SUPER_RESOLUTION,
            OperationKind.AI_DENOISE,
            OperationKind.JPEG_ARTIFACT_REPAIR,
        }

    def test_each_variant_has_its_own_checkpoint(self) -> None:
        digests = {variant.spec.sha256 for variant in SWINIR_VARIANTS.values()}
        assert len(digests) == len(SWINIR_VARIANTS)

    def test_the_jpeg_variant_uses_the_upstream_window_and_range(self) -> None:
        """Copying the denoise configuration here would load and restore worse.

        Upstream uses window 7 for JPEG repair because JPEG's own blocks are 8x8,
        and img_range 255 rather than 1. Both differ from every other variant, and
        both load successfully under the wrong value - which is exactly why they
        are asserted.
        """
        jpeg = SWINIR_VARIANTS["jpeg-10"]
        assert jpeg.window_size == 7
        assert jpeg.img_range == 255.0
        assert jpeg.img_size == 126
        for key in ("sr-x4", "sr-x2", "denoise-15"):
            assert SWINIR_VARIANTS[key].window_size == 8
            assert SWINIR_VARIANTS[key].img_range == 1.0

    def test_the_gan_weights_read_the_ema_parameters(self) -> None:
        """realSR ships params_ema; the restoration weights ship params."""
        assert SWINIR_VARIANTS["sr-x4"].param_keys == ("params_ema",)
        assert SWINIR_VARIANTS["denoise-15"].param_keys == ("params",)

    def test_pins_match_the_installer(self) -> None:
        source = (REPO_ROOT / "tools" / "install_model_weights.py").read_text(encoding="utf-8")
        for variant in SWINIR_VARIANTS.values():
            assert variant.spec.sha256 in source
            assert str(variant.spec.bytes_expected) in source.replace("_", "")

    def test_pins_match_the_licence_register(self) -> None:
        from ipw.benchmark_runner.licence_register import load_register, register_path

        register = load_register(register_path(REPO_ROOT))
        for variant in SWINIR_VARIANTS.values():
            component = register.get(variant.spec.component_id)
            assert component is not None, f"{variant.spec.component_id} is not registered"
            assert component.weights_sha256 == variant.spec.sha256

    def test_tile_size_is_a_window_multiple_for_every_variant(self) -> None:
        """Upstream asserts it; constructing with defaults must never violate it."""
        for key, variant in SWINIR_VARIANTS.items():
            adapter = SwinIrAdapter(variant_key=key)
            assert adapter.tile_size is not None
            assert adapter.tile_size % variant.window_size == 0

    def test_an_unknown_variant_is_refused_at_construction(self) -> None:
        with pytest.raises(ValueError, match="unknown SwinIR variant"):
            SwinIrAdapter(variant_key="sr-x8")

    def test_a_tile_size_that_breaks_the_window_is_refused(self) -> None:
        with pytest.raises(ValueError, match="multiple of window_size"):
            SwinIrAdapter(variant_key="jpeg-10", tile_size=256)


# ------------------------------------------------------- trained levels only --


class TestTrainedLevelsAreNotDials:
    """A checkpoint trained for one level must not serve another."""

    @pytest.mark.parametrize(
        ("settings", "expected"),
        [
            (SuperResolutionSettings(scale=4), "sr-x4"),
            (SuperResolutionSettings(scale=2), "sr-x2"),
            (AiDenoiseSettings(noise_sigma=15), "denoise-15"),
            (JpegArtifactRepairSettings(quality_target=10), "jpeg-10"),
        ],
    )
    def test_variant_for_matches_exactly(self, settings: AnySettings, expected: str) -> None:
        matched = variant_for(settings)
        assert matched is not None, f"no variant answers {settings.kind.value}"
        assert matched.key == expected

    @pytest.mark.parametrize(
        "settings",
        [AiDenoiseSettings(noise_sigma=25), AiDenoiseSettings(noise_sigma=50)],
    )
    def test_an_untrained_noise_level_has_no_variant(self, settings: AnySettings) -> None:
        assert variant_for(settings) is None

    def test_the_denoise_adapter_refuses_an_untrained_sigma(self) -> None:
        adapter = SwinIrAdapter(variant_key="denoise-15")
        settings = AiDenoiseSettings(noise_sigma=50)
        support = adapter.supports(
            Operation.build(settings, ProcessingVariant.AI_NATURAL), settings
        )
        assert not support.supported
        assert support.failure is not None
        assert support.failure.code.value == "PROCESSOR.SETTINGS_UNSUPPORTED"
        assert support.failure.remediation is not None
        assert "never run" in support.failure.remediation

    def test_the_jpeg_adapter_refuses_an_untrained_quality(self) -> None:
        adapter = SwinIrAdapter(variant_key="jpeg-10")
        settings = JpegArtifactRepairSettings(quality_target=40)
        support = adapter.supports(
            Operation.build(settings, ProcessingVariant.AI_TASK_SPECIFIC), settings
        )
        assert not support.supported

    def test_the_x4_adapter_refuses_a_x2_request(self, sr_x4: SwinIrAdapter) -> None:
        settings = SuperResolutionSettings(scale=2)
        support = sr_x4.supports(Operation.build(settings, ProcessingVariant.AI_NATURAL), settings)
        assert not support.supported


# ------------------------------------------------------- family separation ---


class TestAiDenoiseIsNotStandardDenoise:
    """D-007/D-009: Standard Enhance must never silently invoke AI."""

    def test_the_two_denoise_kinds_are_in_different_families(self) -> None:
        assert FAMILY_OF[OperationKind.DENOISE] is OperationFamily.STANDARD
        assert FAMILY_OF[OperationKind.AI_DENOISE] is OperationFamily.AI

    def test_the_ai_adapter_refuses_a_standard_denoise_operation(self) -> None:
        adapter = SwinIrAdapter(variant_key="denoise-15")
        settings = DenoiseSettings(strength_percent=30)
        operation = Operation.build(settings, ProcessingVariant.STANDARD_SERVER_AUTHORITATIVE)
        support = adapter.supports(operation, settings)
        assert not support.supported
        assert support.failure is not None
        assert support.failure.code.value == "PROCESSOR.OPERATION_UNSUPPORTED"

    def test_the_standard_processor_refuses_ai_denoise(self) -> None:
        from ipw.processors.standard import pillow_processor

        settings = AiDenoiseSettings(noise_sigma=15)
        operation = Operation.build(settings, ProcessingVariant.AI_NATURAL)
        support = pillow_processor().supports(operation, settings)
        assert not support.supported

    def test_no_swinir_variant_claims_a_standard_operation(self) -> None:
        for variant in SWINIR_VARIANTS.values():
            assert FAMILY_OF[variant.operation] is not OperationFamily.STANDARD


# ------------------------------------------------------------ architecture ---


@needs_weights
class TestVendoredArchitecture:
    @pytest.mark.parametrize("key", sorted(SWINIR_VARIANTS))
    def test_every_checkpoint_loads_strictly(self, key: str) -> None:
        """A wrong configuration cannot load; it fails rather than restoring wrongly."""
        adapter = SwinIrAdapter(variant_key=key)
        model = adapter._verify_and_load()  # noqa: SLF001 - the behaviour under test
        assert sum(p.numel() for p in model.parameters()) > 11_000_000

    def test_a_wrong_window_size_cannot_load_the_jpeg_checkpoint(self) -> None:
        """The relative-position tables are window-sized, so this is caught."""
        import torch

        from ipw.processors.ai_adapters.common import checkpoint_state_dict
        from ipw.processors.ai_adapters.vendor.network_swinir import SwinIR

        variant = SWINIR_VARIANTS["jpeg-10"]
        state = checkpoint_state_dict(
            REPO_ROOT / ".tools" / "models" / variant.spec.filename, variant.param_keys
        )
        # Vendored source is deliberately unchecked (D-056), so this crosses into
        # untyped code on purpose.
        wrong = SwinIR(  # type: ignore[no-untyped-call]
            upscale=1,
            in_chans=3,
            img_size=128,
            window_size=8,  # the denoise window, not the JPEG one
            img_range=255.0,
            depths=[6] * 6,
            embed_dim=180,
            num_heads=[6] * 6,
            mlp_ratio=2,
            upsampler="",
            resi_connection="1conv",
        )
        with pytest.raises(RuntimeError):
            wrong.load_state_dict(state, strict=True)
        del torch


class TestVendoredSourceIsUntouched:
    """Apache-2.0 section 4: notices retained, modifications stated."""

    VENDOR = (
        REPO_ROOT
        / "packages"
        / "processors"
        / "src"
        / "ipw"
        / "processors"
        / "ai_adapters"
        / "vendor"
        / "network_swinir.py"
    )

    def test_the_attribution_header_is_present(self) -> None:
        source = self.VENDOR.read_text(encoding="utf-8")
        for required in (
            "VENDORED THIRD-PARTY SOURCE",
            "Apache-2.0",
            "Jingyun Liang",
            "Ze Liu",
            "Microsoft Corporation",
            "Kai Zhang",
            "MODIFICATIONS MADE",
        ):
            assert required in source, f"the vendored file lost its {required!r} notice"

    def test_the_upstream_commit_and_digest_are_recorded(self) -> None:
        from ipw.processors.ai_adapters.swinir import SWINIR_COMMIT

        source = self.VENDOR.read_text(encoding="utf-8")
        assert SWINIR_COMMIT in source, "the vendored file does not name the commit it came from"
        assert "SHA-256  :" in source

    def test_timm_is_not_imported(self) -> None:
        """The stated modification, verified rather than trusted.

        Parsed rather than grepped. Apache-2.0 section 4(b) requires the header to
        *state* the modification, so the string "from timm.models.layers import
        ..." legitimately appears in the docstring describing what was removed. A
        substring check would fail on the very notice that makes the removal
        lawful; the question is about executable imports, so it is asked of the
        syntax tree.
        """
        import ast

        tree = ast.parse(self.VENDOR.read_text(encoding="utf-8"))
        imported: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.level == 0:
                imported.add((node.module or "").split(".")[0])
        assert "timm" not in imported, "the vendored file still imports timm"
        assert "torch" in imported, "the vendored file should still import torch"

    def test_the_replacements_exist(self) -> None:
        source = self.VENDOR.read_text(encoding="utf-8")
        for name in ("def to_2tuple", "class DropPath", "trunc_normal_"):
            assert name in source

    def test_drop_path_is_inert_at_inference(self) -> None:
        """It exists to match parameter names, not to do anything during a run."""
        import torch

        from ipw.processors.ai_adapters.vendor.network_swinir import DropPath

        layer = DropPath(0.5).eval()  # type: ignore[no-untyped-call]
        x = torch.arange(24, dtype=torch.float32).reshape(2, 3, 2, 2)
        assert torch.equal(layer(x), x)


# ----------------------------------------------------------------- gate B ----


class TestSupplyChainEnforcement:
    def test_a_tampered_weight_file_is_refused(self, tmp_path: Path, ctx: RunContext) -> None:
        tampered = tmp_path / "models"
        tampered.mkdir()
        variant = SWINIR_VARIANTS["sr-x4"]
        (tampered / variant.spec.filename).write_bytes(b"not the pinned weights")

        adapter = SwinIrAdapter(variant_key="sr-x4", weights_dir=tampered)
        outcome = run(adapter, SMALL, SuperResolutionSettings(scale=4), ctx)
        assert not outcome.succeeded
        assert outcome.failure is not None
        assert outcome.failure.code.value == "PROCESSOR.INTERNAL_ERROR"

    def test_a_truncated_file_fails_on_size_before_hashing(self, tmp_path: Path) -> None:
        """The size check is free and catches truncation without hashing 67 MB."""
        from ipw.processors.ai_adapters.common import verify_weight_digest

        variant = SWINIR_VARIANTS["sr-x4"]
        short = tmp_path / variant.spec.filename
        short.write_bytes(b"0" * 100)
        with pytest.raises(RuntimeError, match="size mismatch"):
            verify_weight_digest(short, variant.spec)

    def test_missing_weights_report_unavailable(self, tmp_path: Path) -> None:
        adapter = SwinIrAdapter(variant_key="sr-x4", weights_dir=tmp_path / "absent")
        settings = SuperResolutionSettings(scale=4)
        support = adapter.supports(
            Operation.build(settings, ProcessingVariant.AI_NATURAL), settings
        )
        assert not support.supported
        assert support.failure is not None
        assert support.failure.category is FailureCategory.PROCESSOR_UNAVAILABLE

    def test_network_is_blocked_during_inference(self) -> None:
        import socket

        from ipw.processors.ai_adapters import no_network

        with no_network(), pytest.raises(OSError, match="disabled during inference"):
            socket.create_connection(("example.invalid", 80), timeout=1)

    def test_the_adapter_declares_no_network_requirement(self, sr_x4: SwinIrAdapter) -> None:
        assert sr_x4.describe().requires_network is False


# --------------------------------------------------------------- inference ---


@needs_weights
class TestInference:
    def test_super_resolution_scales_by_four(self, sr_x4: SwinIrAdapter, ctx: RunContext) -> None:
        outcome = run(sr_x4, SMALL, SuperResolutionSettings(scale=4), ctx)
        assert outcome.succeeded, outcome.failure
        assert outcome.output is not None
        assert (outcome.output.width, outcome.output.height) == (64, 64)

    def test_denoise_preserves_dimensions(self, ctx: RunContext) -> None:
        """Restoration is not resampling: the output is the same size as the input."""
        adapter = SwinIrAdapter(variant_key="denoise-15")
        outcome = run(adapter, SMALL, AiDenoiseSettings(noise_sigma=15), ctx)
        assert outcome.succeeded, outcome.failure
        assert outcome.output is not None
        assert (outcome.output.width, outcome.output.height) == (16, 16)

    def test_jpeg_repair_preserves_dimensions(self, ctx: RunContext) -> None:
        adapter = SwinIrAdapter(variant_key="jpeg-10")
        outcome = run(adapter, SMALL, JpegArtifactRepairSettings(quality_target=10), ctx)
        assert outcome.succeeded, outcome.failure
        assert outcome.output is not None
        assert (outcome.output.width, outcome.output.height) == (16, 16)

    def test_a_non_window_multiple_input_is_handled(self, ctx: RunContext) -> None:
        """16x16 is not a multiple of 7; the vendored network pads and crops."""
        adapter = SwinIrAdapter(variant_key="jpeg-10")
        outcome = run(adapter, SMALL, JpegArtifactRepairSettings(quality_target=10), ctx)
        assert outcome.succeeded, outcome.failure
        assert outcome.output is not None
        assert (outcome.output.width, outcome.output.height) == (16, 16)

    def test_repeated_inference_is_reproducible(
        self, sr_x4: SwinIrAdapter, ctx: RunContext
    ) -> None:
        first = run(sr_x4, SMALL, SuperResolutionSettings(scale=4), ctx)
        second = run(sr_x4, SMALL, SuperResolutionSettings(scale=4), ctx)
        assert first.output is not None
        assert second.output is not None
        assert first.output.sha256 == second.output.sha256

    def test_the_original_is_unchanged(self, sr_x4: SwinIrAdapter, ctx: RunContext) -> None:
        ref = ref_for(SMALL)
        before = ref.compute_sha256()
        run(sr_x4, SMALL, SuperResolutionSettings(scale=4), ctx)
        assert ref.compute_sha256() == before

    def test_output_is_authoritative_not_preview(
        self, sr_x4: SwinIrAdapter, ctx: RunContext
    ) -> None:
        outcome = run(sr_x4, SMALL, SuperResolutionSettings(scale=4), ctx)
        assert outcome.output is not None
        assert outcome.output.is_preview is False

    def test_timing_and_memory_are_recorded(self, sr_x4: SwinIrAdapter, tmp_path: Path) -> None:
        ctx = RunContext.create(temp_root=tmp_path / "t", deterministic=False)
        outcome = run(sr_x4, SMALL, SuperResolutionSettings(scale=4), ctx)
        assert outcome.measurement.timing.total_ns > 0
        assert outcome.measurement.timing.inference_ns > 0
        assert outcome.measurement.memory.peak_rss_bytes > 0
        assert outcome.measurement.memory.peak_vram_bytes is None, "no GPU on this host"

    def test_tiling_produces_the_expected_dimensions(self, ctx: RunContext) -> None:
        tiled = SwinIrAdapter(variant_key="sr-x4", tile_size=32, tile_overlap=8)
        outcome = run(tiled, NOISE, SuperResolutionSettings(scale=4), ctx)
        assert outcome.succeeded, outcome.failure
        assert outcome.output is not None
        assert (outcome.output.width, outcome.output.height) == (256, 256)


# ------------------------------------------------------------- conformance ---


@needs_weights
class TestContractConformance:
    def test_conforms_to_the_processor_contract(self, tmp_path: Path) -> None:
        """The same suite the fake, standard and Real-ESRGAN processors pass."""
        assert_processor_conforms(lambda: SwinIrAdapter(variant_key="sr-x2"), tmp_path)

    def test_a_hostile_input_is_refused_by_inspection(
        self, sr_x4: SwinIrAdapter, ctx: RunContext
    ) -> None:
        outcome = run(
            sr_x4, FIXTURES / "decompression-bomb.png", SuperResolutionSettings(scale=4), ctx
        )
        assert not outcome.succeeded
        assert outcome.failure is not None
        assert outcome.failure.code.value == "SAFETY.DECOMPRESSION_BOMB"

    def test_nothing_escapes_the_boundary_for_a_missing_input(
        self, sr_x4: SwinIrAdapter, ctx: RunContext
    ) -> None:
        missing = InputRef(
            asset_id="absent-asset",
            expected_sha256="0" * 64,
            path=FIXTURES / "does-not-exist.png",
            declared_bytes=0,
        )
        settings = SuperResolutionSettings(scale=4)
        operation = Operation.build(settings, ProcessingVariant.AI_NATURAL)
        with workspace(ctx.temp_root, "swin") as ws:
            outcome = guarded_process(sr_x4, missing, operation, settings, ws, ctx)
        assert not outcome.succeeded
        assert outcome.failure is not None

    def test_no_workspace_survives_a_run(self, tmp_path: Path) -> None:
        temp_root = tmp_path / "tmp"
        ctx = RunContext.create(temp_root=temp_root, deterministic=True)
        run(SwinIrAdapter(variant_key="sr-x2"), SMALL, SuperResolutionSettings(scale=2), ctx)
        assert (list(temp_root.iterdir()) if temp_root.exists() else []) == []

    def test_refuses_a_foreign_operation(self, sr_x4: SwinIrAdapter) -> None:
        settings = NoopSettings()
        operation = Operation.build(settings, ProcessingVariant.ORIGINAL_CONTROL)
        assert not sr_x4.supports(operation, settings).supported


# ------------------------------------------------------------ licence gate ---


class TestLicenceGating:
    def test_the_code_chain_is_approved(self) -> None:
        """Apache-2.0 over MIT over MIT, all read directly."""
        from ipw.benchmark_runner.licence_register import load_register, register_path
        from ipw.contracts.licence import Disposition

        register = load_register(register_path(REPO_ROOT))
        for component_id in ("swinir-code", "swin-transformer-code", "kair-code"):
            component = register.get(component_id)
            assert component is not None, f"{component_id} is not registered"
            assert component.disposition is Disposition.APPROVED
            assert component.evidence
            assert "PRELIMINARY" not in component.evidence
            assert component.required_notices, f"{component_id} is vendored with no notices"

    def test_research_is_permitted_and_marked(self) -> None:
        from ipw.benchmark_runner.licence_register import load_register, register_path
        from ipw.contracts.licence import RunPurpose

        register = load_register(register_path(REPO_ROOT))
        decision = register.evaluate("swinir", RunPurpose.INTERNAL_BENCHMARK)
        assert decision.permitted
        assert not decision.eligible_for_commercial_recommendation
        assert decision.warnings

    def test_commercial_purposes_are_blocked(self) -> None:
        from ipw.benchmark_runner.licence_register import load_register, register_path
        from ipw.contracts.licence import RunPurpose

        register = load_register(register_path(REPO_ROOT))
        for purpose in (RunPurpose.PUBLIC_DEMO, RunPurpose.STAGING, RunPurpose.PRODUCTION):
            assert not register.evaluate("swinir", purpose).permitted

    def test_a_clean_code_licence_does_not_rescue_the_weights(self) -> None:
        """The POC-007 finding, asserted.

        SwinIR's code is approved and its composite is not, because the weights are
        trained on DIV2K. Both model candidates now sit in the same place for the
        same upstream reason - so switching models is not a route around it.
        """
        from ipw.benchmark_runner.licence_register import load_register, register_path
        from ipw.contracts.licence import Disposition

        register = load_register(register_path(REPO_ROOT))
        swinir_code = register.get("swinir-code")
        assert swinir_code is not None
        assert swinir_code.disposition is Disposition.APPROVED
        assert register.effective_disposition("swinir") is not Disposition.APPROVED
        assert register.effective_disposition("real-esrgan") is not Disposition.APPROVED

        for variant in SWINIR_VARIANTS.values():
            component = register.get(variant.spec.component_id)
            assert component is not None
            assert "div2k-dataset" in component.depends_on, (
                f"{variant.spec.component_id} does not record its DIV2K derivation"
            )
