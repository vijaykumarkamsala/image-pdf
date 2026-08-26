"""SwinIR adapter: the comparator, across three restoration tasks (POC-007).

One architecture, four pinned checkpoints, three operations. That is the reason
SwinIR is worth benchmarking beside Real-ESRGAN: it is not only a second
super-resolution model, it is the first candidate that also denoises and repairs
JPEG artifacts, which are separate advertised capabilities the standard pipeline
can only approximate.

**Each checkpoint is its own processor.** A variant is a weight file *plus* the
exact constructor arguments that load it, and those arguments are not
interchangeable - ``window_size`` is 8 for super-resolution and denoising and 7
for JPEG repair (because JPEG's own blocks are 8x8, and 7 avoids aligning with
them), ``img_range`` is 1.0 for the first two and 255.0 for the third, and the
state dict lives under ``params_ema`` for the GAN weights and ``params`` for the
rest. Getting any of these wrong produces a model that loads cleanly and computes
something else, so they are recorded per variant rather than inferred.

**Trained noise levels are not strength dials.** SwinIR publishes separate
checkpoints for sigma 15, 25 and 50 and for JPEG quality 10 to 40. An adapter that
served sigma 25 from the sigma 15 weights would be reporting a measurement of
something it did not run - the same misreporting that ``native_scale`` exists to
prevent for super-resolution. Requests for a level with no pinned weights are
refused with a remediation naming the variant that would satisfy them.

**Tiling follows upstream, and differs from Real-ESRGAN's.** SwinIR accumulates
overlapping tiles and divides by a coverage map, so overlap regions are averaged.
Real-ESRGAN's adapter discards overlap margins instead. Both are defensible and
they are not equivalent, which is worth knowing before either is used to explain a
quality difference between the two models.

The architecture itself is vendored, not reimplemented - see
``vendor/network_swinir.py`` and D-056.
"""

from __future__ import annotations

import hashlib
import platform
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from ipw.contracts.asset import MediaType
from ipw.contracts.failure import FailureCategory, FailureCode, NextAction, failure
from ipw.contracts.measurement import (
    Estimate,
    Measurement,
    MemoryUsage,
    ThermalState,
    TilingRecord,
    Timing,
)
from ipw.contracts.operation import (
    AiDenoiseSettings,
    AnySettings,
    JpegArtifactRepairSettings,
    Operation,
    OperationFamily,
    OperationKind,
    SuperResolutionSettings,
)
from ipw.contracts.processor import (
    OutputArtifact,
    ProcessorIdentity,
    ProcessOutcome,
    RuntimeIdentity,
    Support,
    WeightsIdentity,
)
from ipw.contracts.runtime import InputRef, RunContext, Workspace
from ipw.contracts.safety import DEFAULT_SAFETY_POLICY, InspectionResult, SafetyPolicy
from ipw.processors.ai_adapters.accelerator import peak_vram_bytes, reset_peak_vram
from ipw.processors.ai_adapters.common import (
    WeightSpec,
    checkpoint_state_dict,
    default_weights_dir,
    from_tensor,
    load_torch,
    no_network,
    to_tensor,
    verify_weight_digest,
)
from ipw.processors.inspection import inspect_input
from ipw.processors.standard.measure import measure_memory
from ipw.processors.tiling import DEFAULT_TILE_BUDGET_BYTES, TilePlan, plan_tiles

if TYPE_CHECKING:
    from torch import Tensor

__all__ = ["SWINIR_VARIANTS", "SwinIrAdapter", "SwinIrVariant", "variant_for"]

RELEASE = "https://github.com/JingyunLiang/SwinIR/releases/download/v0.0"

DEFAULT_TILE_BUDGET = 256
"""Nominal tile budget, rounded down to a window multiple per variant.

Matches the Real-ESRGAN adapter's tile size so a runtime comparison between
the two is not really a comparison of tile sizes."""
SWINIR_COMMIT = "6545850fbf8df298df73d81f3e8cba638787c8bd"


@dataclass(frozen=True)
class SwinIrVariant:
    """A pinned checkpoint and the exact configuration that loads it.

    Every field below is copied from ``define_model`` in the upstream
    ``main_test_swinir.py`` at the pinned commit, not inferred. Inferring them
    from a filename is how a benchmark ends up measuring a differently configured
    network and attributing the result to the published one.
    """

    key: str
    operation: OperationKind
    spec: WeightSpec
    param_keys: tuple[str, ...]
    upscale: int
    img_size: int
    window_size: int
    img_range: float
    upsampler: str
    depths: tuple[int, ...] = (6, 6, 6, 6, 6, 6)
    num_heads: tuple[int, ...] = (6, 6, 6, 6, 6, 6)
    embed_dim: int = 180
    mlp_ratio: float = 2.0
    resi_connection: str = "1conv"
    # The setting value this variant answers to: a scale, a noise sigma, or a
    # JPEG quality, depending on the operation.
    trained_for: int = 0
    label: str = ""

    def build(self) -> Any:
        from ipw.processors.ai_adapters.vendor.network_swinir import SwinIR

        return SwinIR(
            upscale=self.upscale,
            in_chans=3,
            img_size=self.img_size,
            window_size=self.window_size,
            img_range=self.img_range,
            depths=list(self.depths),
            embed_dim=self.embed_dim,
            num_heads=list(self.num_heads),
            mlp_ratio=self.mlp_ratio,
            upsampler=self.upsampler,
            resi_connection=self.resi_connection,
        )


def _spec(component_id: str, filename: str, sha256: str, size: int) -> WeightSpec:
    return WeightSpec(
        component_id=component_id,
        filename=filename,
        release_tag="v0.0",
        sha256=sha256,
        bytes_expected=size,
        source_url=f"{RELEASE}/{filename}",
    )


SWINIR_VARIANTS: dict[str, SwinIrVariant] = {
    "sr-x4": SwinIrVariant(
        key="sr-x4",
        operation=OperationKind.SUPER_RESOLUTION,
        spec=_spec(
            "swinir-weights-realsr-m-x4-gan",
            "003_realSR_BSRGAN_DFO_s64w8_SwinIR-M_x4_GAN.pth",
            "b9afb61e65e04eb7f8aba5095d070bbe9af28df76acd0c9405aeb33b814bcfc6",
            67_129_861,
        ),
        param_keys=("params_ema",),
        upscale=4,
        img_size=64,
        window_size=8,
        img_range=1.0,
        # 'nearest+conv' rather than pixelshuffle: upstream notes it avoids the
        # block artifacts pixelshuffle produces on real-world degraded input.
        upsampler="nearest+conv",
        trained_for=4,
        label="real-world SR, GAN-trained, native x4",
    ),
    "sr-x2": SwinIrVariant(
        key="sr-x2",
        operation=OperationKind.SUPER_RESOLUTION,
        spec=_spec(
            "swinir-weights-realsr-m-x2-gan",
            "003_realSR_BSRGAN_DFO_s64w8_SwinIR-M_x2_GAN.pth",
            "f397408977a3e07eb06afb7238d453a12ef35ebab7328a54241f307860dbe342",
            66_974_517,
        ),
        param_keys=("params_ema",),
        upscale=2,
        img_size=64,
        window_size=8,
        img_range=1.0,
        upsampler="nearest+conv",
        trained_for=2,
        label="real-world SR, GAN-trained, native x2",
    ),
    "denoise-15": SwinIrVariant(
        key="denoise-15",
        operation=OperationKind.AI_DENOISE,
        spec=_spec(
            "swinir-weights-colordn-noise15",
            "005_colorDN_DFWB_s128w8_SwinIR-M_noise15.pth",
            "917cd972f7ba80786871add249ad43e4477ce2db59b4ad63e2fa446f7221d013",
            122_905_743,
        ),
        param_keys=("params",),
        upscale=1,
        img_size=128,
        window_size=8,
        img_range=1.0,
        # Empty upsampler: the network restores at the input resolution.
        upsampler="",
        trained_for=15,
        label="colour denoise, trained for sigma 15",
    ),
    "jpeg-10": SwinIrVariant(
        key="jpeg-10",
        operation=OperationKind.JPEG_ARTIFACT_REPAIR,
        spec=_spec(
            "swinir-weights-colorcar-jpeg10",
            "006_colorCAR_DFWB_s126w7_SwinIR-M_jpeg10.pth",
            "0005b707e0e6f75b4d13c7447e2f184858ddbdcec95aa7eb8c07e8afa1d26bd9",
            102_873_665,
        ),
        param_keys=("params",),
        upscale=1,
        # 126 and 7, not 128 and 8. Upstream's note: JPEG encodes in 8x8 blocks,
        # so a window of 7 deliberately fails to align with them. Copying the
        # denoise configuration here would load and quietly restore worse.
        img_size=126,
        window_size=7,
        img_range=255.0,
        upsampler="",
        trained_for=10,
        label="colour JPEG artifact repair, trained for quality 10",
    ),
}
"""The pinned SwinIR checkpoints, one entry per weight file.

Deliberately a small subset. SwinIR publishes 46 release assets across six task
families and several sizes; pinning all of them would be 3 GB of unreviewed
downloads to answer a question nobody asked. These four cover the three task
types POC-007 names, all at SwinIR-M so runtime figures are comparable to each
other, and all colour rather than grayscale because the product handles colour
images.
"""


def variant_for(settings: AnySettings) -> SwinIrVariant | None:
    """The variant that answers these settings exactly, or None.

    Exactly: a request for sigma 25 does not fall back to the sigma 15 weights.
    Serving a neighbouring checkpoint would make the result a measurement of
    something that was never asked for.
    """
    for variant in SWINIR_VARIANTS.values():
        if variant.operation is not settings.kind:
            continue
        if isinstance(settings, SuperResolutionSettings) and settings.scale == variant.trained_for:
            return variant
        if isinstance(settings, AiDenoiseSettings) and settings.noise_sigma == variant.trained_for:
            return variant
        if (
            isinstance(settings, JpegArtifactRepairSettings)
            and settings.quality_target == variant.trained_for
        ):
            return variant
    return None


@dataclass
class SwinIrAdapter:
    """One SwinIR variant behind the standard processor contract."""

    variant_key: str = "sr-x4"
    weights_dir: Path | None = None
    policy: SafetyPolicy = DEFAULT_SAFETY_POLICY
    # None means "derive from the variant's window size". A fixed default cannot
    # be right for every variant: upstream requires tile % window_size == 0, and
    # the JPEG-repair weights use window 7 while the others use 8. 256 would be
    # valid for three variants and refuse to construct the fourth.
    tile_size: int | None = None
    tile_overlap: int = 32
    tile_budget_bytes: int = DEFAULT_TILE_BUDGET_BYTES
    version: str = "0.1.0"
    _model: Any = field(default=None, init=False, repr=False)

    def __post_init__(self) -> None:
        if self.variant_key not in SWINIR_VARIANTS:
            msg = (
                f"unknown SwinIR variant {self.variant_key!r}; available: {sorted(SWINIR_VARIANTS)}"
            )
            raise ValueError(msg)
        window = self.variant.window_size
        if self.tile_size is None:
            # The largest window multiple that fits the nominal 256 budget.
            self.tile_size = (DEFAULT_TILE_BUDGET // window) * window
        # Upstream asserts tile % window_size == 0. Failing here, at construction,
        # beats failing several seconds into a batch.
        if self.tile_size % window:
            msg = (
                f"tile_size {self.tile_size} must be a multiple of window_size {window} "
                f"for variant {self.variant_key!r}"
            )
            raise ValueError(msg)
        if self.weights_dir is None:
            self.weights_dir = default_weights_dir()

    @property
    def variant(self) -> SwinIrVariant:
        return SWINIR_VARIANTS[self.variant_key]

    @property
    def weights_path(self) -> Path:
        assert self.weights_dir is not None
        return self.weights_dir / self.variant.spec.filename

    # ------------------------------------------------------------ identity --

    def describe(self) -> ProcessorIdentity:
        torch = load_torch()
        variant = self.variant
        return ProcessorIdentity(
            name=f"swinir-{self.variant_key}",
            version=self.version,
            family=OperationFamily.AI,
            runtime=RuntimeIdentity(
                language="python",
                language_version=platform.python_version(),
                framework="torch",
                framework_version=getattr(torch, "__version__", "unavailable"),
            ),
            weights=WeightsIdentity(
                name=variant.spec.filename,
                sha256=variant.spec.sha256,
                source_url=variant.spec.source_url,
                pinned_version=f"{variant.spec.release_tag}@{SWINIR_COMMIT[:12]}",
                licence_ref=variant.spec.component_id,
            ),
            precision="fp32",
            tile_size=self.tile_size,
            tile_overlap=self.tile_overlap,
            requires_network=False,
            deterministic_output=True,
            supported_operations=(variant.operation,),
            licence_ref="swinir",
        )

    # ------------------------------------------------------------- support --

    def available(self) -> bool:
        return load_torch() is not None and self.weights_path.is_file()

    def supports(self, operation: Operation, settings: AnySettings) -> Support:
        variant = self.variant
        if load_torch() is None:
            return Support.no(
                failure(
                    FailureCode.PROCESSOR_UNAVAILABLE,
                    FailureCategory.PROCESSOR_UNAVAILABLE,
                    "the torch runtime is not installed on this host",
                    next_action=NextAction.ALTERNATE_ROUTE,
                    remediation="Install the pinned runtime, or route to a host that has it.",
                )
            )
        if not self.weights_path.is_file():
            return Support.no(
                failure(
                    FailureCode.PROCESSOR_UNAVAILABLE,
                    FailureCategory.PROCESSOR_UNAVAILABLE,
                    f"pinned weights {variant.spec.filename} are not installed",
                    next_action=NextAction.ALTERNATE_ROUTE,
                    remediation="Run: python tools/install_model_weights.py",
                    component_id=variant.spec.component_id,
                )
            )
        if operation.kind is not variant.operation:
            return Support.no(
                failure(
                    FailureCode.PROCESSOR_OPERATION_UNSUPPORTED,
                    FailureCategory.UNSUPPORTED_FEATURE,
                    f"swinir-{self.variant_key} performs {variant.operation.value} only; it "
                    f"does not implement {operation.kind.value}",
                    next_action=NextAction.ALTERNATE_ROUTE,
                    remediation="Each SwinIR checkpoint is trained for one task. Select the "
                    "variant for the operation you want; there is no general checkpoint.",
                    operation=operation.kind.value,
                )
            )
        matched = variant_for(settings)
        if matched is None or matched.key != self.variant_key:
            return Support.no(
                failure(
                    FailureCode.PROCESSOR_SETTINGS_UNSUPPORTED,
                    FailureCategory.UNSUPPORTED_FEATURE,
                    f"these weights are trained for {variant.operation.value} at "
                    f"{variant.trained_for}; the request asks for something else",
                    next_action=NextAction.ALTERNATE_ROUTE,
                    remediation=(
                        f"Use the variant trained for it. SwinIR publishes one checkpoint per "
                        f"level; serving a neighbouring one would report a measurement of a "
                        f"model that was never run. Available: {sorted(SWINIR_VARIANTS)}."
                    ),
                    trained_for=variant.trained_for,
                )
            )
        return Support.ok()

    # ------------------------------------------------------------- loading --

    def _verify_and_load(self) -> Any:
        if self._model is not None:
            return self._model

        variant = self.variant
        verify_weight_digest(self.weights_path, variant.spec)
        state = checkpoint_state_dict(self.weights_path, variant.param_keys)

        model = variant.build()
        # strict=True: every parameter name and shape must match the published
        # checkpoint. A misconfigured variant cannot load rather than quietly
        # computing something else.
        model.load_state_dict(state, strict=True)
        model.eval()

        self._model = model
        return model

    # ------------------------------------------------------------- inspect --

    def inspect(self, ref: InputRef, ctx: RunContext) -> InspectionResult:
        ctx.cancellation.raise_if_cancelled()
        return inspect_input(ref, policy=self.policy)

    def estimate(
        self, ref: InputRef, operation: Operation, settings: AnySettings, ctx: RunContext
    ) -> Estimate:
        inspection = inspect_input(ref, policy=self.policy)
        pixels = inspection.decoded_pixels or 0
        scale = self.variant.upscale
        return Estimate(
            # SwinIR is a transformer and is markedly slower than the
            # convolutional baseline; the constant reflects that and is still
            # uncalibrated until POC-014.
            estimated_duration_ns=2_000_000_000 + pixels * 400_000,
            estimated_peak_memory_bytes=pixels * scale * scale * 3 * 16,
            estimated_output_bytes=None,
            estimated_cost=None,
            confidence="low",
            notes=f"CPU transformer inference, {self.variant.label}; not calibrated (POC-014)",
        )

    # ------------------------------------------------------------- process --

    def process(
        self,
        ref: InputRef,
        operation: Operation,
        settings: AnySettings,
        ws: Workspace,
        ctx: RunContext,
    ) -> ProcessOutcome:
        support = self.supports(operation, settings)
        if not support.supported:
            assert support.failure is not None
            return ProcessOutcome.failed(support.failure)

        ctx.cancellation.raise_if_cancelled()
        started = ctx.clock.monotonic_ns()
        inspection = inspect_input(ref, policy=self.policy)
        if not inspection.accepted:
            assert inspection.failure is not None
            return ProcessOutcome.failed(inspection.failure)

        was_cold = self._model is None
        preprocess_done = ctx.clock.monotonic_ns()

        try:
            from PIL import Image

            reset_peak_vram()
            with measure_memory() as memory:
                model = self._verify_and_load()
                load_done = ctx.clock.monotonic_ns()

                with Image.open(ref.readonly_path()) as handle:
                    handle.load()
                    source = handle.convert("RGB")

                ctx.cancellation.raise_if_cancelled()
                assert self.tile_size is not None
                plan = plan_tiles(
                    source.width,
                    source.height,
                    scale=self.variant.upscale,
                    budget_bytes=self.tile_budget_bytes,
                    max_tile=self.tile_size,
                    multiple_of=self.variant.window_size,
                )
                with no_network():
                    restored = self._infer(model, source, plan)
                inference_done = ctx.clock.monotonic_ns()

                output_path = ws.path("result.png")
                restored.save(output_path, format="PNG", optimize=True, compress_level=6)
        except Exception as exc:  # noqa: BLE001 - normalised at the boundary
            return ProcessOutcome.failed(
                failure(
                    FailureCode.PROCESSOR_INTERNAL_ERROR,
                    FailureCategory.PERMANENT_PROCESSING,
                    f"swinir-{self.variant_key}: {type(exc).__name__}",
                    next_action=NextAction.ALTERNATE_ROUTE,
                    exception_type=type(exc).__name__,
                    variant=self.variant_key,
                )
            )

        payload = output_path.read_bytes()
        finished = ctx.clock.monotonic_ns()

        return ProcessOutcome.success(
            OutputArtifact(
                relative_path=output_path.name,
                sha256=hashlib.sha256(payload).hexdigest(),
                bytes_written=len(payload),
                media_type=MediaType.PNG.value,
                width=restored.width,
                height=restored.height,
                is_preview=False,
            ),
            Measurement(
                timing=Timing(
                    cold_start_ns=max(load_done - preprocess_done, 0) if was_cold else 0,
                    preprocess_ns=max(preprocess_done - started, 0),
                    inference_ns=max(inference_done - load_done, 0),
                    postprocess_ns=max(finished - inference_done, 0),
                    total_ns=max(finished - started, 0),
                    cold_or_warm=ThermalState.COLD if was_cold else ThermalState.WARM,
                ),
                memory=MemoryUsage(
                    peak_rss_bytes=memory.sample.reported_peak_bytes,
                    peak_vram_bytes=peak_vram_bytes(),
                    python_peak_delta_bytes=memory.sample.python_peak_delta_bytes,
                    measurement_method=memory.sample.method,
                ),
                input_bytes=ref.size_bytes,
                output_bytes=len(payload),
                input_width=inspection.decoded_width,
                input_height=inspection.decoded_height,
                output_width=restored.width,
                output_height=restored.height,
                tiling=TilingRecord(**plan.as_record()),  # type: ignore[arg-type]
            ),
            nondeterministic=False,
            notes=(
                f"{self.variant.label}, fp32, window {self.variant.window_size}, "
                f"tile {plan.tile_size}/{plan.overlap} x{plan.tile_count} ({plan.reason.value})"
            ),
        )

    # ------------------------------------------------------------ inference --

    def _infer(self, model: Any, image: Any, plan: TilePlan) -> Any:
        """Run the network, tiling according to the plan.

        No manual padding: the vendored network pads to a window multiple in
        ``check_image_size`` and crops the result back in ``forward``. Duplicating
        that here would pad twice and crop once.
        """
        import torch

        tensor = to_tensor(image)
        with torch.no_grad():
            # Left as if/else: the two branches call different functions, and a
            # ternary would bury that behind a condition.
            if not plan.is_tiled:  # noqa: SIM108
                output = model(tensor)
            else:
                output = self._infer_tiled(model, tensor, plan)
        return from_tensor(output)

    def _infer_tiled(self, model: Any, tensor: Tensor, plan: TilePlan) -> Tensor:
        """Upstream's tiling: accumulate overlapping tiles, divide by coverage.

        Deliberately not Real-ESRGAN's discard-the-margin approach. This one
        averages the overlap, which softens a seam rather than choosing one side
        of it. Both are reasonable; they are not the same, and a quality
        difference between the two models must not be attributed to the model when
        the tiling differs too. POC-012 measures both.
        """
        import torch

        _, _, height, width = tensor.shape
        scale = self.variant.upscale
        tile = min(plan.tile_size, height, width)
        # Re-checked here as well as in the planner: `min` above can lower the
        # tile to an image dimension that is not a window multiple.
        tile -= tile % self.variant.window_size
        tile = max(tile, self.variant.window_size)
        stride = max(tile - plan.overlap, 1)

        top_positions = [*range(0, height - tile, stride), height - tile]
        left_positions = [*range(0, width - tile, stride), width - tile]

        accumulator = torch.zeros(1, 3, height * scale, width * scale, dtype=tensor.dtype)
        coverage = torch.zeros_like(accumulator)

        for top in top_positions:
            for left in left_positions:
                patch = tensor[..., top : top + tile, left : left + tile]
                out = model(patch)
                accumulator[
                    ...,
                    top * scale : (top + tile) * scale,
                    left * scale : (left + tile) * scale,
                ].add_(out)
                coverage[
                    ...,
                    top * scale : (top + tile) * scale,
                    left * scale : (left + tile) * scale,
                ].add_(torch.ones_like(out))

        return accumulator.div_(coverage)
