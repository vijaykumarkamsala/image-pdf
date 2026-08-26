"""Reference implementation and test double for the processor contract.

**This is not a production processor.** It performs no image processing: it
derives a small deterministic byte string from the input digest and writes that
as its "derivative". Its purpose is to prove, before any model exists, that the
contract in :mod:`ipw.contracts.processor` is implementable and enforceable.

The behaviour modes below let one class exercise the whole contract, including
the paths a well-behaved processor should never take:

=============================  =========================================================
``DETERMINISTIC_SUCCESS``      identical output bytes and result id across runs
``UNSUPPORTED_OPERATION``      ``supports`` and ``process`` agree; normalised failure
``SAFETY_LIMIT_AT_INSPECT``    inspection rejects before any work is done
``RAISES_EXCEPTION``           the base guards normalise it; nothing escapes
``SLOW_CANCELLABLE``           honours the cancellation token; workspace still cleaned
``FAILS_ON_LISTED_ASSETS``     batch isolation: other assets still succeed
``FAILS_THEN_SUCCEEDS``        idempotent retry: same result id, one ledger entry
``MUTATES_ORIGINAL``           attempts to write to the original; must be caught
``NONDETERMINISTIC``           declares nondeterministic output, exercising the label
=============================  =========================================================
"""

from __future__ import annotations

import hashlib
import platform
from dataclasses import dataclass, field
from enum import StrEnum

from ipw.contracts.failure import (
    FailureCategory,
    FailureCode,
    NextAction,
    failure,
)
from ipw.contracts.measurement import Estimate, Measurement, ThermalState, Timing
from ipw.contracts.operation import (
    AnySettings,
    Operation,
    OperationFamily,
    OperationKind,
)
from ipw.contracts.processor import (
    OutputArtifact,
    ProcessorIdentity,
    ProcessOutcome,
    RuntimeIdentity,
    Support,
)
from ipw.contracts.runtime import InputRef, ProcessingCancelledError, RunContext, Workspace
from ipw.contracts.safety import HandlingClass, InspectionResult, RiskFlag

__all__ = ["FakeBehaviour", "FakeProcessor"]

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
    OperationKind.CONVERT,
)
"""Standard-family operations only. The fake processor never claims an AI
operation, so an accidental AI run through the fake is impossible."""


class FakeBehaviour(StrEnum):
    DETERMINISTIC_SUCCESS = "deterministic_success"
    UNSUPPORTED_OPERATION = "unsupported_operation"
    SAFETY_LIMIT_AT_INSPECT = "safety_limit_at_inspect"
    RAISES_EXCEPTION = "raises_exception"
    SLOW_CANCELLABLE = "slow_cancellable"
    FAILS_ON_LISTED_ASSETS = "fails_on_listed_assets"
    FAILS_THEN_SUCCEEDS = "fails_then_succeeds"
    MUTATES_ORIGINAL = "mutates_original"
    NONDETERMINISTIC = "nondeterministic"


@dataclass
class FakeProcessor:
    """A configurable, non-production implementation of the processor contract."""

    behaviour: FakeBehaviour = FakeBehaviour.DETERMINISTIC_SUCCESS
    name: str = "fake-processor"
    version: str = "0.1.0"
    failing_asset_ids: frozenset[str] = frozenset()
    max_pixels: int = 400_000_000
    call_counts: dict[str, int] = field(default_factory=dict)

    # ------------------------------------------------------------ identity --

    def describe(self) -> ProcessorIdentity:
        return ProcessorIdentity(
            name=self.name,
            version=self.version,
            family=OperationFamily.STANDARD,
            runtime=RuntimeIdentity(
                language="python",
                language_version=platform.python_version(),
                framework=None,
                framework_version=None,
            ),
            weights=None,
            precision="na",
            requires_network=False,
            deterministic_output=self.behaviour is not FakeBehaviour.NONDETERMINISTIC,
            supported_operations=SUPPORTED_OPERATIONS,
            licence_ref=None,
        )

    # ------------------------------------------------------------- support --

    def supports(self, operation: Operation, settings: AnySettings) -> Support:
        if self.behaviour is FakeBehaviour.UNSUPPORTED_OPERATION:
            return Support.no(
                failure(
                    FailureCode.PROCESSOR_OPERATION_UNSUPPORTED,
                    FailureCategory.UNSUPPORTED_FEATURE,
                    f"{self.name} does not implement {operation.kind.value}",
                    next_action=NextAction.ALTERNATE_ROUTE,
                    remediation="Route this operation to a processor that declares it.",
                    operation=operation.kind.value,
                )
            )
        if operation.kind not in SUPPORTED_OPERATIONS:
            return Support.no(
                failure(
                    FailureCode.PROCESSOR_OPERATION_UNSUPPORTED,
                    FailureCategory.UNSUPPORTED_FEATURE,
                    f"{self.name} is a standard-family processor and does not implement "
                    f"{operation.kind.value}",
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
        return Support.ok()

    # ------------------------------------------------------------- inspect --

    def inspect(self, ref: InputRef, ctx: RunContext) -> InspectionResult:
        self._count("inspect")
        ctx.cancellation.raise_if_cancelled()

        if self.behaviour is FakeBehaviour.RAISES_EXCEPTION:
            msg = "fake processor was configured to raise during inspect"
            raise RuntimeError(msg)

        size = ref.size_bytes if ref.exists else 0
        if self.behaviour is FakeBehaviour.SAFETY_LIMIT_AT_INSPECT:
            return InspectionResult(
                asset_id=ref.asset_id,
                sha256=ref.expected_sha256,
                decision=HandlingClass.INVALID,
                compressed_bytes=size,
                risk_flags=(RiskFlag.EXCESSIVE_PIXELS,),
                failure=failure(
                    FailureCode.SAFETY_PIXELS_EXCEEDED,
                    FailureCategory.SAFETY_LIMIT,
                    "declared pixel count exceeds the configured ceiling",
                    next_action=NextAction.CONTACT_SUPPORT,
                    asset_id=ref.asset_id,
                ),
                inspected_without_decoding=True,
            )

        return InspectionResult(
            asset_id=ref.asset_id,
            sha256=ref.compute_sha256() if ref.exists else ref.expected_sha256,
            decision=HandlingClass.STANDARD,
            compressed_bytes=size,
            decoded_pixels=0,
            estimated_working_memory_bytes=size * 4,
            risk_flags=(),
            failure=None,
            # POC-001 never decodes. POC-003 sets this False.
            inspected_without_decoding=True,
        )

    # ------------------------------------------------------------ estimate --

    def estimate(
        self, ref: InputRef, operation: Operation, settings: AnySettings, ctx: RunContext
    ) -> Estimate:
        self._count("estimate")
        size = ref.size_bytes if ref.exists else 0
        return Estimate(
            estimated_duration_ns=1_000_000 + size * 10,
            estimated_peak_memory_bytes=size * 4,
            estimated_output_bytes=64,
            estimated_cost=None,
            confidence="low",
            notes="synthetic estimate from the fake processor; not a real cost model",
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
        attempts = self._count("process")
        started = ctx.clock.monotonic_ns()
        ctx.cancellation.raise_if_cancelled()

        if self.behaviour is FakeBehaviour.RAISES_EXCEPTION:
            msg = "fake processor was configured to raise during process"
            raise RuntimeError(msg)

        if self.behaviour is FakeBehaviour.SLOW_CANCELLABLE:
            # Cooperative cancellation: poll the token instead of sleeping blind.
            for _ in range(1000):
                if ctx.cancellation.cancelled:
                    raise ProcessingCancelledError
            ctx.cancellation.raise_if_cancelled()

        if self.behaviour is FakeBehaviour.MUTATES_ORIGINAL:
            self._attempt_to_mutate_original(ref)

        if (
            self.behaviour is FakeBehaviour.FAILS_ON_LISTED_ASSETS
            and ref.asset_id in self.failing_asset_ids
        ):
            return ProcessOutcome.failed(
                failure(
                    FailureCode.PROCESSOR_INTERNAL_ERROR,
                    FailureCategory.PERMANENT_PROCESSING,
                    "fake processor was configured to fail this asset",
                    next_action=NextAction.RETRY,
                    retryable=True,
                    asset_id=ref.asset_id,
                ),
                self._measure(ref, 0, started, ctx),
            )

        if self.behaviour is FakeBehaviour.FAILS_THEN_SUCCEEDS and attempts == 1:
            return ProcessOutcome.failed(
                failure(
                    FailureCode.PROCESSOR_INTERNAL_ERROR,
                    FailureCategory.TEMPORARY_INFRASTRUCTURE,
                    "transient failure on the first attempt",
                    next_action=NextAction.RETRY,
                    retryable=True,
                    asset_id=ref.asset_id,
                ),
                self._measure(ref, 0, started, ctx),
            )

        payload = self._derivative_bytes(ref, operation)
        ws.write_bytes("derivative.bin", payload)

        return ProcessOutcome.success(
            OutputArtifact(
                relative_path="derivative.bin",
                sha256=hashlib.sha256(payload).hexdigest(),
                bytes_written=len(payload),
                media_type="application/octet-stream",
                width=None,
                height=None,
                is_preview=True,
            ),
            self._measure(ref, len(payload), started, ctx),
            nondeterministic=self.behaviour is FakeBehaviour.NONDETERMINISTIC,
            notes="synthetic derivative; the fake processor performs no image processing",
        )

    # ------------------------------------------------------------ internals --

    @staticmethod
    def _derivative_bytes(ref: InputRef, operation: Operation) -> bytes:
        """A deterministic function of the input digest and the operation."""
        seed = f"{ref.expected_sha256}:{operation.kind.value}:{operation.variant.value}"
        return hashlib.sha256(seed.encode("utf-8")).digest()

    def _measure(
        self, ref: InputRef, output_bytes: int, started_ns: int, ctx: RunContext
    ) -> Measurement:
        elapsed = max(ctx.clock.monotonic_ns() - started_ns, 0)
        return Measurement(
            timing=Timing(
                total_ns=elapsed,
                inference_ns=elapsed,
                cold_or_warm=ThermalState.WARM,
            ),
            input_bytes=ref.size_bytes if ref.exists else 0,
            output_bytes=output_bytes,
        )

    @staticmethod
    def _attempt_to_mutate_original(ref: InputRef) -> None:
        """Deliberately try to corrupt the original, to prove the guard catches it.

        The contract exposes no writable handle, so this reaches through the
        private attribute on purpose. That is the point of the test: even a
        badly behaved adapter is caught by the pre/post hash check in
        ``ipw.processors.base``.
        """
        path = ref._path  # noqa: SLF001 - deliberate hostile-adapter simulation
        with path.open("ab") as handle:
            handle.write(b"corrupted")

    def _count(self, key: str) -> int:
        self.call_counts[key] = self.call_counts.get(key, 0) + 1
        return self.call_counts[key]
