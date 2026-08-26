"""Guards applied around every processor call.

An adapter is allowed to be imperfect. The runner is not. Everything that crosses
the processor boundary passes through these guards, which enforce three product
invariants mechanically rather than by convention:

* **Originals are never mutated** (D-006). The original's SHA-256 is verified
  before *and* after every call. A change raises
  :class:`~ipw.contracts.runtime.OriginalMutatedError`, which is normalised into
  a ``SAFETY.ORIGINAL_MUTATED`` failure so the run records the violation loudly
  instead of continuing silently.
* **One failed input must not fail an entire batch.** Any exception escaping an
  adapter - including ``KeyboardInterrupt``-adjacent cancellation - is converted
  into a :class:`~ipw.contracts.failure.NormalizedFailure`. Nothing propagates.
* **Temporary artifacts are removed on all paths.** The workspace is created and
  destroyed by the caller's context manager; the guards never leak one.
"""

from __future__ import annotations

from ipw.contracts.failure import (
    FailureCategory,
    FailureCode,
    NextAction,
    NormalizedFailure,
    failure,
)
from ipw.contracts.measurement import Estimate
from ipw.contracts.operation import AnySettings, Operation
from ipw.contracts.processor import Processor, ProcessOutcome
from ipw.contracts.runtime import (
    InputRef,
    OriginalMutatedError,
    ProcessingCancelledError,
    RunContext,
    Workspace,
)
from ipw.contracts.safety import HandlingClass, InspectionResult

__all__ = [
    "guarded_estimate",
    "guarded_inspect",
    "guarded_process",
    "guarded_supports",
]


def _internal_error(exc: BaseException, stage: str, asset_id: str) -> NormalizedFailure:
    """Normalise an unexpected exception without leaking bytes or paths."""
    return failure(
        FailureCode.PROCESSOR_INTERNAL_ERROR,
        FailureCategory.PERMANENT_PROCESSING,
        f"processor raised {type(exc).__name__} during {stage}",
        retryable=False,
        next_action=NextAction.CONTACT_SUPPORT,
        remediation="Inspect the adapter. A processor should return a failed outcome "
        "rather than raise.",
        stage=stage,
        asset_id=asset_id,
        exception_type=type(exc).__name__,
    )


def _cancelled(stage: str, asset_id: str) -> NormalizedFailure:
    return failure(
        FailureCode.PROCESSOR_CANCELLED,
        FailureCategory.CANCELLED,
        f"processing cancelled during {stage}",
        retryable=True,
        next_action=NextAction.RETRY,
        stage=stage,
        asset_id=asset_id,
    )


def _original_mutated(asset_id: str) -> NormalizedFailure:
    return failure(
        FailureCode.SAFETY_ORIGINAL_MUTATED,
        FailureCategory.PERMANENT_PROCESSING,
        "the original asset changed during processing; product invariant D-006 was violated",
        retryable=False,
        next_action=NextAction.CONTACT_SUPPORT,
        remediation="Treat the whole run as untrustworthy and investigate the adapter "
        "before benchmarking again.",
        asset_id=asset_id,
    )


def _original_unreadable(exc: OSError, stage: str, asset_id: str) -> NormalizedFailure:
    """The original could not be read at all - missing, locked or permission-denied.

    Distinguished from a processor fault: nothing is wrong with the adapter, the
    input simply is not available. Reporting it as an internal processor error
    would send an operator to debug the wrong component.
    """
    return failure(
        FailureCode.MANIFEST_ASSET_FILE_MISSING,
        FailureCategory.INVALID_INPUT,
        f"the original asset could not be read during {stage} ({type(exc).__name__})",
        retryable=False,
        next_action=NextAction.CHANGE_SETTINGS,
        remediation="Confirm the asset exists under the configured asset root and is readable.",
        stage=stage,
        asset_id=asset_id,
        exception_type=type(exc).__name__,
    )


def guarded_supports(
    processor: Processor, operation: Operation, settings: AnySettings
) -> tuple[bool, NormalizedFailure | None]:
    """Ask a processor whether it supports a combination, tolerating a broken answer."""
    try:
        support = processor.supports(operation, settings)
    except Exception as exc:  # noqa: BLE001 - deliberate boundary normalisation
        return False, _internal_error(exc, "supports", "-")
    return support.supported, support.failure


def guarded_inspect(processor: Processor, ref: InputRef, ctx: RunContext) -> InspectionResult:
    """Inspect an input, guaranteeing the original is unchanged afterwards."""
    try:
        ref.assert_unchanged("pre-inspect")
        result = processor.inspect(ref, ctx)
        ref.assert_unchanged("post-inspect")
    except OriginalMutatedError:
        return InspectionResult(
            asset_id=ref.asset_id,
            sha256=ref.expected_sha256,
            decision=HandlingClass.INVALID,
            failure=_original_mutated(ref.asset_id),
            inspected_without_decoding=True,
        )
    except ProcessingCancelledError:
        return InspectionResult(
            asset_id=ref.asset_id,
            sha256=ref.expected_sha256,
            decision=HandlingClass.INVALID,
            failure=_cancelled("inspect", ref.asset_id),
            inspected_without_decoding=True,
        )
    except OSError as exc:
        return InspectionResult(
            asset_id=ref.asset_id,
            sha256=ref.expected_sha256,
            decision=HandlingClass.INVALID,
            failure=_original_unreadable(exc, "inspect", ref.asset_id),
            inspected_without_decoding=True,
        )
    except Exception as exc:  # noqa: BLE001 - deliberate boundary normalisation
        return InspectionResult(
            asset_id=ref.asset_id,
            sha256=ref.expected_sha256,
            decision=HandlingClass.INVALID,
            failure=_internal_error(exc, "inspect", ref.asset_id),
            inspected_without_decoding=True,
        )
    return result


def guarded_estimate(
    processor: Processor,
    ref: InputRef,
    operation: Operation,
    settings: AnySettings,
    ctx: RunContext,
) -> Estimate:
    """Estimate cost/time/memory. A broken estimator degrades to a zero estimate."""
    try:
        return processor.estimate(ref, operation, settings, ctx)
    except Exception:  # noqa: BLE001 - an estimate is advisory, never fatal
        return Estimate(
            estimated_duration_ns=0,
            estimated_peak_memory_bytes=0,
            confidence="low",
            notes="estimate unavailable: the processor raised during estimation",
        )


def guarded_process(
    processor: Processor,
    ref: InputRef,
    operation: Operation,
    settings: AnySettings,
    ws: Workspace,
    ctx: RunContext,
) -> ProcessOutcome:
    """Run a processor with full boundary normalisation and original-preservation checks."""
    try:
        ref.assert_unchanged("pre-process")
    except OriginalMutatedError:
        return ProcessOutcome.failed(_original_mutated(ref.asset_id))
    except OSError as exc:
        return ProcessOutcome.failed(_original_unreadable(exc, "pre-process", ref.asset_id))

    try:
        outcome = processor.process(ref, operation, settings, ws, ctx)
    except ProcessingCancelledError:
        outcome = ProcessOutcome.failed(_cancelled("process", ref.asset_id))
    except OriginalMutatedError:
        return ProcessOutcome.failed(_original_mutated(ref.asset_id))
    except Exception as exc:  # noqa: BLE001 - deliberate boundary normalisation
        outcome = ProcessOutcome.failed(_internal_error(exc, "process", ref.asset_id))

    # Checked after every path, including failure: a processor that corrupts an
    # original and then reports a clean failure must still be caught.
    try:
        ref.assert_unchanged("post-process")
    except OriginalMutatedError:
        return ProcessOutcome.failed(_original_mutated(ref.asset_id), outcome.measurement)
    except OSError as exc:
        return ProcessOutcome.failed(
            _original_unreadable(exc, "post-process", ref.asset_id), outcome.measurement
        )

    if ctx.cancellation.cancelled and outcome.succeeded:
        return ProcessOutcome.failed(_cancelled("process", ref.asset_id), outcome.measurement)

    return outcome
