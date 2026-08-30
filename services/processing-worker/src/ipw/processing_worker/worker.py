"""Worker boundary for durable processing jobs."""

from __future__ import annotations

from typing import Protocol

from ipw.contracts.failure import FailureCategory, NextAction
from ipw.contracts.licence import Disposition
from ipw.contracts.operation import OperationKind
from ipw.contracts.product import (
    JobCheckpoint,
    ProcessingJob,
    ProcessorFacts,
    ProductContractModel,
    ProductError,
    ProvenanceRecord,
    TraceContext,
)


class CancellationSignal(Protocol):
    """Cancellation interface owned by the queue/runtime, not the processor."""

    def is_cancelled(self) -> bool: ...


class CheckpointSink(Protocol):
    """Checkpoint interface used by retry-aware workers."""

    def record(self, checkpoint: JobCheckpoint) -> None: ...


class ProcessorAdapter(Protocol):
    """Minimal processor boundary for Recovery 1."""

    @property
    def facts(self) -> ProcessorFacts: ...

    def process(self, job: ProcessingJob) -> ProvenanceRecord: ...


class ProcessingWorkerResult(ProductContractModel):
    """Structured worker output."""

    job_id: str
    trace: TraceContext
    idempotency_key: str
    processor: ProcessorFacts
    checkpoint: JobCheckpoint | None = None
    provenance: ProvenanceRecord | None = None
    error: ProductError | None = None

    @property
    def succeeded(self) -> bool:
        return self.error is None


class NeverCancelled:
    """Default signal for synchronous tests and local probes."""

    def is_cancelled(self) -> bool:
        return False


class NoopCheckpointSink:
    """Default sink used until a durable queue is integrated."""

    def record(self, checkpoint: JobCheckpoint) -> None:
        _ = checkpoint


def _error(job: ProcessingJob, code: str, message: str, category: FailureCategory) -> ProductError:
    return ProductError(
        code=code,
        category=category,
        message=message,
        next_action=NextAction.RETRY
        if category is FailureCategory.TEMPORARY_INFRASTRUCTURE
        else NextAction.NONE,
        trace=job.trace,
    )


def run_job(
    job: ProcessingJob,
    processor: ProcessorAdapter,
    *,
    cancellation: CancellationSignal | None = None,
    checkpoints: CheckpointSink | None = None,
) -> ProcessingWorkerResult:
    """Run one job through the processor boundary.

    Recovery 1 intentionally supports only deterministic fake processing. Real
    image/PDF/AI adapters remain quarantined until later approved tasks.
    """

    signal = cancellation or NeverCancelled()
    sink = checkpoints or NoopCheckpointSink()

    if signal.is_cancelled():
        return ProcessingWorkerResult(
            job_id=job.job_id,
            trace=job.trace,
            idempotency_key=job.idempotency_key,
            processor=processor.facts,
            error=_error(
                job,
                "worker-cancelled",
                "Job was cancelled before processing.",
                FailureCategory.CANCELLED,
            ),
        )

    if job.operation is not None and job.operation not in processor.facts.supports_operations:
        return ProcessingWorkerResult(
            job_id=job.job_id,
            trace=job.trace,
            idempotency_key=job.idempotency_key,
            processor=processor.facts,
            error=_error(
                job,
                "operation-unsupported",
                "The selected processor does not support this operation.",
                FailureCategory.UNSUPPORTED_FEATURE,
            ),
        )

    checkpoint = JobCheckpoint(
        checkpoint_id=f"{job.job_id}-checkpoint",
        sequence=job.attempt,
        completed_item_ids=job.source_refs,
    )
    sink.record(checkpoint)

    provenance = processor.process(job)
    return ProcessingWorkerResult(
        job_id=job.job_id,
        trace=job.trace,
        idempotency_key=job.idempotency_key,
        processor=processor.facts,
        checkpoint=checkpoint,
        provenance=provenance,
    )


def fake_processor_facts() -> ProcessorFacts:
    """Facts for the Recovery 1 deterministic fake processor."""

    return ProcessorFacts(
        processor_id="recovery-fake",
        version="0.1.0",
        supports_operations=(OperationKind.RESIZE,),
        requires_gpu=False,
        deterministic=True,
        commercial_disposition=Disposition.APPROVED,
    )
