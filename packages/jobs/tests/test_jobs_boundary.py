from __future__ import annotations

from ipw.contracts.product import JobKind, ProcessingJob, TraceContext
from ipw.jobs import DispatchKind, DurableCheckpoint, JobDispatch, JobHeartbeat, JobLease


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


def test_dispatch_contains_only_an_opaque_job_reference() -> None:
    dispatch = JobDispatch(dispatch_id="dispatch-001", job_id="job-001")
    heartbeat = JobHeartbeat(job_id="job-001", lease_token="lease-001", attempt=1)  # noqa: S106
    checkpoint = DurableCheckpoint(
        job_id="job-001",
        attempt=1,
        checkpoint_key="header-inspected",
        payload={"detected_media_type": "image/png"},
    )

    assert dispatch.kind == DispatchKind.PROCESS_JOB
    assert not hasattr(dispatch, "object_key")
    assert heartbeat.lease_token == "lease-001"  # noqa: S105
    assert checkpoint.payload["detected_media_type"] == "image/png"
