"""The deterministic standard-processing baseline (POC-004).

One processor, two engines. Everything the contract requires - identity, support
checks, inspection, estimation, normalised failures, timing and memory - lives
here; only the pixel work is delegated. That is what makes a Pillow-versus-libvips
comparison attributable to the engines rather than to differences in plumbing.

**Non-generative by construction (D-009).** Every operation this processor
declares belongs to the standard family. It resizes, crops, adjusts, sharpens and
denoises; it never reconstructs detail that was not in the source. The contract
enforces that structurally: ``FAMILY_OF`` maps each operation to a fixed family,
and declaring an AI operation here would fail validation.
"""

from __future__ import annotations

import hashlib
import platform
from typing import Generic

from ipw.contracts.asset import MediaType
from ipw.contracts.failure import (
    FailureCategory,
    FailureCode,
    NextAction,
    failure,
)
from ipw.contracts.measurement import Estimate, Measurement, MemoryUsage, ThermalState, Timing
from ipw.contracts.operation import (
    AdjustSettings,
    AnySettings,
    ConvertSettings,
    CropSettings,
    DenoiseSettings,
    DocumentCleanSettings,
    EnlargeSettings,
    FlipSettings,
    Operation,
    OperationFamily,
    OperationKind,
    PrintReadySettings,
    ResizeSettings,
    RotateSettings,
    SharpenSettings,
    StraightenPageSettings,
)
from ipw.contracts.processor import (
    OutputArtifact,
    ProcessorIdentity,
    ProcessOutcome,
    RuntimeIdentity,
    Support,
)
from ipw.contracts.runtime import InputRef, RunContext, Workspace
from ipw.contracts.safety import DEFAULT_SAFETY_POLICY, InspectionResult, SafetyPolicy
from ipw.processors.inspection import inspect_input
from ipw.processors.standard.engine import EngineError, ImageEngine, ImageT
from ipw.processors.standard.measure import measure_memory
from ipw.processors.standard.pillow_engine import PillowEngine, PillowImage
from ipw.processors.standard.vips_engine import VipsEngine, VipsImage

__all__ = ["SUPPORTED_OPERATIONS", "StandardProcessor", "pillow_processor", "vips_processor"]

SUPPORTED_OPERATIONS: tuple[OperationKind, ...] = (
    OperationKind.NOOP,
    OperationKind.INSPECT_ONLY,
    OperationKind.RESIZE,
    OperationKind.CROP,
    OperationKind.ROTATE,
    OperationKind.FLIP,
    OperationKind.ADJUST,
    OperationKind.SHARPEN,
    OperationKind.DENOISE,
    OperationKind.DOCUMENT_CLEAN,
    OperationKind.ENLARGE,
    OperationKind.STRAIGHTEN_PAGE,
    OperationKind.PRINT_READY,
    OperationKind.CONVERT,
)
"""Standard-family operations only. No AI operation is declared, so this
processor cannot be selected for one even by mistake (D-007, D-009)."""

_EXTENSION = {MediaType.PNG: ".png", MediaType.JPEG: ".jpg"}


class StandardProcessor(Generic[ImageT]):
    """Deterministic standard processing, backed by a pluggable engine."""

    def __init__(
        self,
        engine: ImageEngine[ImageT],
        *,
        policy: SafetyPolicy = DEFAULT_SAFETY_POLICY,
        version: str = "0.1.0",
    ) -> None:
        self.engine = engine
        self.policy = policy
        self.version = version

    # ------------------------------------------------------------ identity --

    def describe(self) -> ProcessorIdentity:
        return ProcessorIdentity(
            name=f"standard-{self.engine.name}",
            version=self.version,
            family=OperationFamily.STANDARD,
            runtime=RuntimeIdentity(
                language="python",
                language_version=platform.python_version(),
                framework=self.engine.name,
                framework_version=self.engine.version,
            ),
            weights=None,  # a standard processor has no model weights
            precision="na",
            requires_network=False,
            deterministic_output=self.engine.deterministic,
            supported_operations=SUPPORTED_OPERATIONS,
            licence_ref=("standard-pillow" if self.engine.name == "pillow" else "standard-libvips"),
        )

    # ------------------------------------------------------------- support --

    def supports(self, operation: Operation, settings: AnySettings) -> Support:
        if not self.engine.available:
            return Support.no(
                failure(
                    FailureCode.PROCESSOR_UNAVAILABLE,
                    FailureCategory.PROCESSOR_UNAVAILABLE,
                    f"the {self.engine.name} engine is not available on this host",
                    next_action=NextAction.ALTERNATE_ROUTE,
                    retryable=False,
                    remediation="Install the native library, or route to the other engine. "
                    "The benchmark records this rather than failing the run.",
                    engine=self.engine.name,
                )
            )
        if operation.kind not in SUPPORTED_OPERATIONS:
            return Support.no(
                failure(
                    FailureCode.PROCESSOR_OPERATION_UNSUPPORTED,
                    FailureCategory.UNSUPPORTED_FEATURE,
                    f"standard-{self.engine.name} does not implement {operation.kind.value}; "
                    f"it is a non-generative standard processor",
                    next_action=NextAction.ALTERNATE_ROUTE,
                    operation=operation.kind.value,
                )
            )
        if settings.kind is not operation.kind:
            return Support.no(
                failure(
                    FailureCode.PROCESSOR_SETTINGS_UNSUPPORTED,
                    FailureCategory.INVALID_INPUT,
                    "settings do not match the requested operation",
                    operation=operation.kind.value,
                    settings=settings.kind.value,
                )
            )
        if isinstance(settings, ConvertSettings) and settings.target_media_type not in _EXTENSION:
            return Support.no(
                failure(
                    FailureCode.PROCESSOR_SETTINGS_UNSUPPORTED,
                    FailureCategory.UNSUPPORTED_FORMAT,
                    f"cannot write {settings.target_media_type.value}",
                    next_action=NextAction.CHANGE_SETTINGS,
                    remediation="JPEG and PNG are the validated output formats (O-007).",
                    target=settings.target_media_type.value,
                )
            )
        return Support.ok()

    # ------------------------------------------------------------- inspect --

    def inspect(self, ref: InputRef, ctx: RunContext) -> InspectionResult:
        """Delegate to the POC-003 inspector: header-first, no pixels decoded."""
        ctx.cancellation.raise_if_cancelled()
        return inspect_input(ref, policy=self.policy)

    # ------------------------------------------------------------ estimate --

    def estimate(
        self, ref: InputRef, operation: Operation, settings: AnySettings, ctx: RunContext
    ) -> Estimate:
        """Predict from the header alone - estimation must not decode."""
        inspection = inspect_input(ref, policy=self.policy)
        pixels = inspection.decoded_pixels or 0
        memory = inspection.estimated_working_memory_bytes

        # Rough per-megapixel costs, deliberately labelled low confidence until
        # POC-014 replaces them with measured figures.
        per_megapixel_ns = {
            OperationKind.RESIZE: 8_000_000,
            OperationKind.DENOISE: 40_000_000,
            OperationKind.SHARPEN: 20_000_000,
            # The light is estimated on a downscaled copy, so cost grows with
            # the divide rather than the filter - a phone photograph is well
            # inside this.
            OperationKind.DOCUMENT_CLEAN: 60_000_000,
            # Every pass resamples the full-size image twice, so the ceiling
            # is on the *output*: a 4x enlargement of this is 64 megapixels.
            OperationKind.ENLARGE: 16_000_000,
            # Detection walks a downscaled copy; the transform is one pass.
            OperationKind.STRAIGHTEN_PAGE: 60_000_000,
            # Bounded by the enlargement, which is the expensive half.
            OperationKind.PRINT_READY: 16_000_000,
        }.get(operation.kind, 4_000_000)

        return Estimate(
            estimated_duration_ns=1_000_000 + (pixels * per_megapixel_ns) // 1_000_000,
            estimated_peak_memory_bytes=memory,
            estimated_output_bytes=None,
            estimated_cost=None,
            confidence="low",
            notes=f"header-derived estimate for {self.engine.name}; not yet calibrated "
            f"against measurements (POC-014)",
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

        # Safety first: the same header inspection that guards every other path.
        inspection = inspect_input(ref, policy=self.policy)
        if not inspection.accepted:
            assert inspection.failure is not None
            return ProcessOutcome.failed(inspection.failure)
        preprocess_done = ctx.clock.monotonic_ns()

        try:
            with measure_memory() as memory:
                image = self.engine.load(str(ref.readonly_path()))
                result = self._apply(image, operation, settings)
                ctx.cancellation.raise_if_cancelled()
                inference_done = ctx.clock.monotonic_ns()

                media_type, quality = self._output_format(settings, inspection)
                output_path = ws.path(f"result{_EXTENSION[media_type]}")
                self.engine.save(result, str(output_path), media_type.value, quality, optimise=True)
        except EngineError as exc:
            return ProcessOutcome.failed(
                failure(
                    FailureCode.PROCESSOR_INTERNAL_ERROR,
                    FailureCategory.PERMANENT_PROCESSING,
                    f"{self.engine.name}: {exc}",
                    next_action=NextAction.CHANGE_SETTINGS,
                    engine=self.engine.name,
                    operation=operation.kind.value,
                ),
                self._measurement(ref, 0, started, started, started, ctx, None),
            )

        payload = output_path.read_bytes()

        return ProcessOutcome.success(
            OutputArtifact(
                relative_path=output_path.name,
                sha256=hashlib.sha256(payload).hexdigest(),
                bytes_written=len(payload),
                media_type=media_type.value,
                width=result.width,
                height=result.height,
                # Authoritative server output, not a preview (D-019).
                is_preview=False,
            ),
            self._measurement(
                ref, len(payload), started, preprocess_done, inference_done, ctx, memory, result
            ),
            nondeterministic=not self.engine.deterministic,
            notes=f"{self.engine.name} {self.engine.version}",
        )

    # ------------------------------------------------------------ internals --

    def _apply(self, image: ImageT, operation: Operation, settings: AnySettings) -> ImageT:
        """Dispatch one operation. Every branch is non-generative."""
        if isinstance(settings, ResizeSettings):
            width, height = self._resize_target(image, settings)
            return self.engine.resize(image, width, height, settings.algorithm)
        if isinstance(settings, CropSettings):
            return self.engine.crop(image, settings.x, settings.y, settings.width, settings.height)
        if isinstance(settings, RotateSettings):
            return self.engine.rotate(image, settings.degrees)
        if isinstance(settings, FlipSettings):
            return self.engine.flip(image, settings.axis)
        if isinstance(settings, AdjustSettings):
            return self.engine.adjust(
                image,
                brightness_percent=settings.brightness_percent,
                contrast_percent=settings.contrast_percent,
                saturation_percent=settings.saturation_percent,
                exposure_percent=settings.exposure_percent,
                white_balance=settings.white_balance,
            )
        if isinstance(settings, SharpenSettings):
            return self.engine.sharpen(image, settings.amount_percent, settings.radius_x100)
        if isinstance(settings, DenoiseSettings):
            return self.engine.denoise(image, settings.strength_percent)
        if isinstance(settings, PrintReadySettings):
            return self.engine.print_ready(
                image,
                scale=settings.scale,
                material=settings.material,
                whiten=settings.whiten,
                keep_ink_colour=settings.keep_ink_colour,
            )
        if isinstance(settings, StraightenPageSettings):
            return self.engine.straighten_page(image, settings.corners)
        if isinstance(settings, EnlargeSettings):
            return self.engine.enlarge(
                image,
                scale=settings.scale,
                material=settings.material,
                iterations=settings.iterations,
            )
        if isinstance(settings, DocumentCleanSettings):
            return self.engine.clean_document(
                image,
                strength_percent=settings.strength_percent,
                whiten=settings.whiten,
                keep_ink_colour=settings.keep_ink_colour,
            )
        if isinstance(settings, ConvertSettings):
            if settings.target_media_type is MediaType.JPEG and image.has_alpha:
                if settings.flatten_background is None:
                    msg = (
                        "converting a transparent image to JPEG loses transparency; "
                        "set flatten_background to choose the colour explicitly"
                    )
                    raise EngineError(msg)
                return self.engine.flatten_alpha(image, settings.flatten_background)
            return image
        # noop and inspect_only pass the image through unchanged.
        return image

    @staticmethod
    def _resize_target(image: ImageT, settings: ResizeSettings) -> tuple[int, int]:
        """Resolve target dimensions from explicit sizes or a rational scale."""
        if settings.scale_numerator and settings.scale_denominator:
            return (
                max(1, image.width * settings.scale_numerator // settings.scale_denominator),
                max(1, image.height * settings.scale_numerator // settings.scale_denominator),
            )
        width, height = settings.target_width, settings.target_height
        if settings.preserve_aspect_ratio:
            if width and not height:
                height = max(1, image.height * width // image.width)
            elif height and not width:
                width = max(1, image.width * height // image.height)
        return (width or image.width, height or image.height)

    @staticmethod
    def _output_format(
        settings: AnySettings, inspection: InspectionResult
    ) -> tuple[MediaType, int]:
        """Choose the output format: explicit for convert, otherwise the input's."""
        if isinstance(settings, ConvertSettings):
            return settings.target_media_type, settings.quality
        detected = inspection.detected_media_type
        if detected in _EXTENSION:
            return detected, 95
        return MediaType.PNG, 95

    def _measurement(
        self,
        ref: InputRef,
        output_bytes: int,
        started: int,
        preprocess_done: int,
        inference_done: int,
        ctx: RunContext,
        memory: measure_memory | None,
        result: ImageT | None = None,
    ) -> Measurement:
        finished = ctx.clock.monotonic_ns()
        sample = memory.sample if memory is not None else None
        return Measurement(
            timing=Timing(
                preprocess_ns=max(preprocess_done - started, 0),
                inference_ns=max(inference_done - preprocess_done, 0),
                postprocess_ns=max(finished - inference_done, 0),
                total_ns=max(finished - started, 0),
                cold_or_warm=ThermalState.WARM,
            ),
            memory=MemoryUsage(
                peak_rss_bytes=sample.reported_peak_bytes if sample else 0,
                # The standard path never touches an accelerator, so this is not
                # "unmeasured" - there is nothing there to measure.
                peak_vram_bytes=None,
                python_peak_delta_bytes=sample.python_peak_delta_bytes if sample else None,
                measurement_method=sample.method if sample else "not_measured",
            ),
            input_bytes=ref.size_bytes if ref.exists else 0,
            output_bytes=output_bytes,
            output_width=result.width if result else None,
            output_height=result.height if result else None,
        )


def pillow_processor(
    policy: SafetyPolicy = DEFAULT_SAFETY_POLICY,
) -> StandardProcessor[PillowImage]:
    """The primary deterministic baseline."""
    return StandardProcessor(PillowEngine(), policy=policy)


def vips_processor(policy: SafetyPolicy = DEFAULT_SAFETY_POLICY) -> StandardProcessor[VipsImage]:
    """The libvips comparator. Reports unavailable rather than failing when absent."""
    return StandardProcessor(VipsEngine(), policy=policy)
