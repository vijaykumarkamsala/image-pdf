"""Real-ESRGAN adapter: the first AI model behind the processor contract.

Everything the contract already provides - normalised failures, workspace
lifecycle, original-preservation guards, measurement - comes from
``ipw.processors.base`` and the same conformance suite the fake and standard
processors pass. This module adds only what is genuinely model-specific.

Four things it does that a naive wrapper would not:

**Verifies the weight digest before loading.** Gate B (D-039) is not satisfied by
having recorded a hash somewhere; it is satisfied by checking it at the moment of
use. A mismatch refuses to load.

**Loads with ``weights_only=True``.** ``.pth`` is a Python pickle, and
unrestricted unpickling executes arbitrary code from the file. Restricting
reconstruction to tensors is the difference between loading data and running a
stranger's program.

**Disables network access during inference.** Also Gate B. Enforced by replacing
the socket constructors for the duration of the call, so a model that tried to
phone home would fail loudly rather than succeed quietly.

**Declares only super-resolution.** POC-006: "Never silently invoke face
restoration." That is structural here rather than a policy note - the official
``realesrgan`` package hard-depends on ``gfpgan``, so this adapter reimplements
the generator instead (see :mod:`~ipw.processors.ai_adapters.rrdbnet`) and no face
model exists anywhere in the executed path.
"""

from __future__ import annotations

import hashlib
import platform
from pathlib import Path
from typing import TYPE_CHECKING, Any

from ipw.contracts.asset import MediaType
from ipw.contracts.failure import (
    FailureCategory,
    FailureCode,
    NextAction,
    failure,
)
from ipw.contracts.measurement import (
    Estimate,
    Measurement,
    MemoryUsage,
    ThermalState,
    TilingRecord,
    Timing,
)
from ipw.contracts.operation import (
    AnySettings,
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
from ipw.processors.ai_adapters.accelerator import (
    peak_vram_bytes,
    probe_accelerator,
    reset_peak_vram,
)
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

__all__ = ["PINNED_WEIGHTS", "RealEsrganAdapter", "WeightSpec", "no_network"]


# Mirrors tools/install_model_weights.py. Duplicated deliberately: the installer
# must not be importable from the inference path, and a mismatch between the two
# is caught by a test.
RELEASE = "https://github.com/xinntao/Real-ESRGAN/releases/download"

PINNED_WEIGHTS: dict[int, WeightSpec] = {
    4: WeightSpec(
        component_id="real-esrgan-weights-x4plus",
        filename="RealESRGAN_x4plus.pth",
        release_tag="v0.1.0",
        sha256="4fa0d38905f75ac06eb49a7951b426670021be3018265fd191d2125df9d682f1",
        bytes_expected=67_040_989,
        source_url=f"{RELEASE}/v0.1.0/RealESRGAN_x4plus.pth",
    ),
    2: WeightSpec(
        component_id="real-esrgan-weights-x2plus",
        filename="RealESRGAN_x2plus.pth",
        release_tag="v0.2.1",
        sha256="49fafd45f8fd7aa8d31ab2a22d14d91b536c34494a5cfe31eb5d89c2fa266abb",
        bytes_expected=67_061_725,
        source_url=f"{RELEASE}/v0.2.1/RealESRGAN_x2plus.pth",
    ),
}


class RealEsrganAdapter:
    """Real-ESRGAN super-resolution behind the standard processor contract."""

    def __init__(
        self,
        *,
        scale: int = 4,
        weights_dir: Path | None = None,
        policy: SafetyPolicy = DEFAULT_SAFETY_POLICY,
        tile_size: int = 256,
        tile_overlap: int = 16,
        tile_budget_bytes: int = DEFAULT_TILE_BUDGET_BYTES,
        version: str = "0.1.0",
    ) -> None:
        if scale not in PINNED_WEIGHTS:
            msg = f"no pinned weights for scale x{scale}; available: {sorted(PINNED_WEIGHTS)}"
            raise ValueError(msg)
        self.spec = PINNED_WEIGHTS[scale]
        self.scale = scale
        self.policy = policy
        self.tile_size = tile_size
        self.tile_overlap = tile_overlap
        # The ceiling a plan may not exceed, not the tile itself. The tile is
        # chosen per image by the planner and recorded on the result.
        self.tile_budget_bytes = tile_budget_bytes
        self.version = version
        self.weights_dir = weights_dir or default_weights_dir()
        self._model: Any = None
        self._loaded_cold = False

    @property
    def weights_path(self) -> Path:
        return self.weights_dir / self.spec.filename

    # ------------------------------------------------------------ identity --

    def describe(self) -> ProcessorIdentity:
        torch = load_torch()
        return ProcessorIdentity(
            name=f"real-esrgan-x{self.scale}",
            version=self.version,
            family=OperationFamily.AI,
            runtime=RuntimeIdentity(
                language="python",
                language_version=platform.python_version(),
                framework="torch",
                framework_version=getattr(torch, "__version__", "unavailable"),
            ),
            weights=WeightsIdentity(
                name=self.spec.filename,
                sha256=self.spec.sha256,
                source_url=(
                    f"https://github.com/xinntao/Real-ESRGAN/releases/download/"
                    f"{self.spec.release_tag}/{self.spec.filename}"
                ),
                pinned_version=self.spec.release_tag,
                licence_ref=self.spec.component_id,
            ),
            precision="fp32",
            tile_size=self.tile_size,
            tile_overlap=self.tile_overlap,
            requires_network=False,
            # Convolutional inference in fp32 is deterministic for a fixed build,
            # but not across torch versions or thread counts - so results carry
            # the runtime version and comparisons stay within a build.
            deterministic_output=True,
            supported_operations=(OperationKind.SUPER_RESOLUTION,),
            licence_ref="real-esrgan",
        )

    # ------------------------------------------------------------- support --

    def available(self) -> bool:
        return load_torch() is not None and self.weights_path.is_file()

    def supports(self, operation: Operation, settings: AnySettings) -> Support:
        # **Capability before availability, deliberately.**
        #
        # "This adapter performs super-resolution only" is true whether or not
        # weights are installed; "the weights are missing" is true only until
        # somebody installs them. Reporting the temporary problem first tells a
        # caller asking for a resize to download sixty megabytes of model that
        # will still refuse them - and tells a router that an adapter which can
        # never do the job might be able to later.
        #
        # It also makes the permanent facts testable without a model present,
        # which is how a clean CI runner found this ordering in the first place.
        if operation.kind is not OperationKind.SUPER_RESOLUTION:
            return Support.no(
                failure(
                    FailureCode.PROCESSOR_OPERATION_UNSUPPORTED,
                    FailureCategory.UNSUPPORTED_FEATURE,
                    f"real-esrgan-x{self.scale} performs super-resolution only; it does not "
                    f"implement {operation.kind.value}",
                    next_action=NextAction.ALTERNATE_ROUTE,
                    remediation="Face restoration is a separate, explicitly chosen operation "
                    "and is not reachable from this adapter (POC-006).",
                    operation=operation.kind.value,
                )
            )
        if not isinstance(settings, SuperResolutionSettings):
            return Support.no(
                failure(
                    FailureCode.PROCESSOR_SETTINGS_UNSUPPORTED,
                    FailureCategory.INVALID_INPUT,
                    "settings do not match the requested operation",
                )
            )
        if settings.scale != self.scale:
            return Support.no(
                failure(
                    FailureCode.PROCESSOR_SETTINGS_UNSUPPORTED,
                    FailureCategory.UNSUPPORTED_FEATURE,
                    f"these weights are native x{self.scale}; x{settings.scale} was requested",
                    next_action=NextAction.ALTERNATE_ROUTE,
                    remediation=f"Use the x{settings.scale} adapter. Post-resizing an x"
                    f"{self.scale} result is not equivalent to a native x{settings.scale} "
                    "model and must never be reported as one (benchmark plan section 7).",
                    native_scale=self.scale,
                    requested_scale=settings.scale,
                )
            )
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
                    f"pinned weights {self.spec.filename} are not installed",
                    next_action=NextAction.ALTERNATE_ROUTE,
                    remediation="Run: python tools/install_model_weights.py",
                    component_id=self.spec.component_id,
                )
            )
        return Support.ok()

    # ------------------------------------------------------------- loading --

    def _verify_and_load(self) -> Any:
        """Verify size and digest, then load with unpickling restricted to tensors."""
        if self._model is not None:
            return self._model

        from ipw.processors.ai_adapters.rrdbnet import build_rrdbnet

        verify_weight_digest(self.weights_path, self.spec)
        state = checkpoint_state_dict(self.weights_path, ("params_ema", "params"))

        model = build_rrdbnet(self.scale)
        model.load_state_dict(state, strict=True)
        model.eval()

        self._model = model
        self._loaded_cold = True
        return model

    # ------------------------------------------------------------ inspect ---

    def inspect(self, ref: InputRef, ctx: RunContext) -> InspectionResult:
        ctx.cancellation.raise_if_cancelled()
        return inspect_input(ref, policy=self.policy)

    def estimate(
        self, ref: InputRef, operation: Operation, settings: AnySettings, ctx: RunContext
    ) -> Estimate:
        inspection = inspect_input(ref, policy=self.policy)
        pixels = inspection.decoded_pixels or 0
        # Measured on this machine at roughly 1.2 s per 10k input pixels on 4 CPU
        # threads. Wildly hardware-dependent, hence low confidence until POC-014.
        return Estimate(
            estimated_duration_ns=1_000_000_000 + pixels * 120_000,
            estimated_peak_memory_bytes=pixels * self.scale * self.scale * 3 * 8,
            estimated_output_bytes=None,
            estimated_cost=None,
            confidence="low",
            notes=f"CPU inference at native x{self.scale}; not calibrated (POC-014)",
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

        # Checked before anything expensive. Loading the model costs seconds, and
        # a caller who has already cancelled should not pay for them.
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
                plan = plan_tiles(
                    source.width,
                    source.height,
                    scale=self.scale,
                    budget_bytes=self.tile_budget_bytes,
                    max_tile=self.tile_size,
                )
                # Gate B: nothing in here may reach the network.
                with no_network():
                    upscaled = self._infer(model, source, plan)
                inference_done = ctx.clock.monotonic_ns()

                output_path = ws.path("result.png")
                upscaled.save(output_path, format="PNG", optimize=True, compress_level=6)
        except Exception as exc:  # noqa: BLE001 - normalised at the boundary
            return ProcessOutcome.failed(
                failure(
                    FailureCode.PROCESSOR_INTERNAL_ERROR,
                    FailureCategory.PERMANENT_PROCESSING,
                    f"real-esrgan-x{self.scale}: {type(exc).__name__}",
                    next_action=NextAction.ALTERNATE_ROUTE,
                    exception_type=type(exc).__name__,
                    scale=self.scale,
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
                width=upscaled.width,
                height=upscaled.height,
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
                    # Queried, not assumed. None means "no accelerator to measure",
                    # which is not the same claim as zero VRAM used.
                    peak_vram_bytes=peak_vram_bytes(),
                    python_peak_delta_bytes=memory.sample.python_peak_delta_bytes,
                    measurement_method=memory.sample.method,
                ),
                input_bytes=ref.size_bytes,
                output_bytes=len(payload),
                input_width=inspection.decoded_width,
                input_height=inspection.decoded_height,
                output_width=upscaled.width,
                output_height=upscaled.height,
                tiling=TilingRecord(**plan.as_record()),  # type: ignore[arg-type]
            ),
            nondeterministic=False,
            notes=(
                f"native x{self.scale}, fp32, "
                f"tile {plan.tile_size}/{plan.overlap} x{plan.tile_count} ({plan.reason.value}), "
                f"backend {probe_accelerator().backend}"
            ),
        )

    # ------------------------------------------------------------ inference --

    def _infer(self, model: Any, image: Any, plan: TilePlan) -> Any:
        """Run the generator, tiling according to the plan.

        The plan decides, not a comparison against a constructor default: it has
        already accounted for the memory budget and for the fact that output area
        grows with the square of the scale.
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
        """Tile with overlap, blending seams by discarding the overlap margins.

        Overlap exists because a convolutional network sees a limited context; a
        tile boundary with no margin produces a visible seam. Discarding the
        margin after inference means every output pixel came from a tile that had
        real context around it.

        POC-012 measures whether the seams are actually invisible. This records
        the tile size and overlap on every result so that measurement has
        something to attribute a finding to.
        """
        import torch

        _, _, height, width = tensor.shape
        scale, tile, overlap = self.scale, plan.tile_size, plan.overlap
        output = torch.zeros((1, 3, height * scale, width * scale), dtype=tensor.dtype)

        for top in range(0, height, tile):
            for left in range(0, width, tile):
                # Expand the read window by the overlap, clamped to the image.
                read_top = max(top - overlap, 0)
                read_left = max(left - overlap, 0)
                read_bottom = min(top + tile + overlap, height)
                read_right = min(left + tile + overlap, width)

                patch = tensor[:, :, read_top:read_bottom, read_left:read_right]
                upscaled = model(patch)

                # Discard the margins that existed only to give context.
                trim_top = (top - read_top) * scale
                trim_left = (left - read_left) * scale
                keep_height = min(tile, height - top) * scale
                keep_width = min(tile, width - left) * scale

                output[
                    :,
                    :,
                    top * scale : top * scale + keep_height,
                    left * scale : left * scale + keep_width,
                ] = upscaled[
                    :, :, trim_top : trim_top + keep_height, trim_left : trim_left + keep_width
                ]

        return output
