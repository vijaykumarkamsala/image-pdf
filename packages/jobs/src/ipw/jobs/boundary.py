"""Durable-job protocols shared by API and worker processes."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from ipw.contracts.product import JobCheckpoint, ProcessingJob, ProductError


@dataclass(frozen=True)
class JobLease:
    """A claimed job and its current checkpoint."""

    job: ProcessingJob
    checkpoint: JobCheckpoint | None = None


class JobHandler(Protocol):
    """Handle one durable job kind."""

    def handle(self, lease: JobLease) -> ProductError | None: ...
