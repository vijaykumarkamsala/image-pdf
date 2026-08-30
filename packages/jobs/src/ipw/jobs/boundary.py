"""Durable-job protocols shared by API and worker processes."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol

from ipw.contracts.product import JobCheckpoint, ProcessingJob, ProductError


@dataclass(frozen=True)
class JobLease:
    """A claimed job and its current checkpoint."""

    job: ProcessingJob
    checkpoint: JobCheckpoint | None = None


class DispatchKind(StrEnum):
    PROCESS_JOB = "process_job"


@dataclass(frozen=True)
class JobDispatch:
    """Opaque queue payload; the database remains the source of job truth."""

    dispatch_id: str
    job_id: str
    kind: DispatchKind = DispatchKind.PROCESS_JOB


@dataclass(frozen=True)
class JobHeartbeat:
    job_id: str
    lease_token: str
    attempt: int


@dataclass(frozen=True)
class DurableCheckpoint:
    job_id: str
    attempt: int
    checkpoint_key: str
    payload: dict[str, str]


class JobHandler(Protocol):
    """Handle one durable job kind."""

    def handle(self, lease: JobLease) -> ProductError | None: ...


class DispatchQueue(Protocol):
    """At-least-once dispatch boundary with provider-independent payloads."""

    def enqueue(self, dispatch: JobDispatch) -> None: ...


class LeaseStore(Protocol):
    def heartbeat(self, heartbeat: JobHeartbeat) -> None: ...

    def checkpoint(self, checkpoint: DurableCheckpoint) -> None: ...
