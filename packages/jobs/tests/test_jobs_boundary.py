from __future__ import annotations

from ipw.contracts.product import JobKind, ProcessingJob, TraceContext
from ipw.jobs import JobLease


def test_job_lease_wraps_versioned_processing_job() -> None:
    job = ProcessingJob(
        job_id="job-001",
        workspace_id="workspace-001",
        kind=JobKind.PROCESS,
        trace=TraceContext(trace_id="trace-001"),
        idempotency_key="idem-001",
        source_refs=("source-001",),
    )

    lease = JobLease(job=job)

    assert lease.job.schema_version == job.schema_version
    assert lease.job.trace.trace_id == "trace-001"

