from __future__ import annotations

from ipw.contracts.operation import OperationKind
from ipw.contracts.product import JobKind, ProcessingJob, TraceContext
from ipw.processing_worker import DeterministicFakeProcessor, run_job


def job(operation: OperationKind | None = OperationKind.RESIZE) -> ProcessingJob:
    return ProcessingJob(
        job_id="job-001",
        workspace_id="workspace-001",
        kind=JobKind.PROCESS,
        trace=TraceContext(trace_id="trace-001", idempotency_key="idem-001"),
        idempotency_key="idem-001",
        source_refs=("source-001",),
        operation=operation,
    )


def test_fake_processor_returns_trace_idempotency_checkpoint_and_provenance() -> None:
    result = run_job(job(), DeterministicFakeProcessor())

    assert result.succeeded is True
    assert result.trace.trace_id == "trace-001"
    assert result.idempotency_key == "idem-001"
    assert result.checkpoint is not None
    assert result.checkpoint.completed_item_ids == ("source-001",)
    assert result.provenance is not None
    assert result.provenance.recipe_name == "deterministic-fake"


def test_unsupported_operation_returns_structured_error() -> None:
    result = run_job(job(OperationKind.SUPER_RESOLUTION), DeterministicFakeProcessor())

    assert result.succeeded is False
    assert result.error is not None
    assert result.error.code == "operation-unsupported"
    assert result.error.trace.trace_id == "trace-001"
