"""Durable, cancellation-aware execution for one file-intake task."""

from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from typing import Any, Protocol

from google.api_core import exceptions as google_exceptions

from ipw.inspection import InspectionLimits, MalwareScanner, inspect_bytes
from ipw.processing_worker.repository import JobBusyError, LeasedIntakeJob
from ipw.storage import IntakePrivateObjectStore, ObjectZone, PrivateObjectRef


@dataclass(frozen=True)
class DispatchMessage:
    dispatch_id: str
    job_id: str
    trace_id: str
    kind: str = "process_job"


@dataclass(frozen=True)
class WorkerOutcome:
    state: str
    job_id: str


class WorkerCancelledError(RuntimeError):
    pass


class IntakeJobRepository(Protocol):
    def claim(
        self,
        *,
        job_id: str,
        worker_id: str,
        lease_token: str,
        trace_id: str,
    ) -> LeasedIntakeJob | None: ...
    def start(self, lease: LeasedIntakeJob) -> None: ...
    def heartbeat(self, lease: LeasedIntakeJob) -> None: ...
    def cancellation_requested(self, lease: LeasedIntakeJob) -> bool: ...
    def latest_checkpoint(self, lease: LeasedIntakeJob) -> tuple[str, dict[str, Any]] | None: ...
    def checkpoint(self, lease: LeasedIntakeJob, key: str, payload: dict[str, Any]) -> None: ...
    def complete_accepted(
        self,
        lease: LeasedIntakeJob,
        *,
        immutable_object_key: str,
        immutable_storage_generation: str,
        facts: dict[str, Any],
    ) -> None: ...
    def complete_rejected(
        self,
        lease: LeasedIntakeJob,
        *,
        code: str,
        message: str,
    ) -> None: ...
    def fail_or_cancel(
        self,
        lease: LeasedIntakeJob,
        *,
        code: str,
        message: str,
        retryable: bool,
    ) -> str: ...


class DurableIntakeProcessor:
    def __init__(
        self,
        repository: IntakeJobRepository,
        objects: IntakePrivateObjectStore,
        scanner: MalwareScanner,
        *,
        worker_id: str,
    ) -> None:
        self._repository = repository
        self._objects = objects
        self._scanner = scanner
        self._worker_id = worker_id

    def process(self, message: DispatchMessage) -> WorkerOutcome:
        lease_token = secrets.token_urlsafe(32)
        try:
            lease = self._repository.claim(
                job_id=message.job_id,
                worker_id=self._worker_id,
                lease_token=lease_token,
                trace_id=message.trace_id,
            )
        except JobBusyError:
            return WorkerOutcome("busy", message.job_id)
        if lease is None:
            return WorkerOutcome("already_terminal", message.job_id)

        source = PrivateObjectRef(lease.owner_scope, lease.object_key, ObjectZone.QUARANTINE)
        try:
            self._repository.start(lease)
            self._heartbeat_and_cancel(lease)
            snapshot = self._objects.read(
                source,
                generation=lease.object_generation,
                max_bytes=lease.expected_byte_size,
            )
            self._repository.heartbeat(lease)
            if len(snapshot.data) != lease.expected_byte_size:
                return self._reject(
                    lease,
                    source,
                    "upload-size-mismatch",
                    "The uploaded byte count changed before inspection",
                )
            digest = hashlib.sha256(snapshot.data).hexdigest()
            if lease.expected_sha256 and digest != lease.expected_sha256:
                return self._reject(
                    lease,
                    source,
                    "upload-checksum-mismatch",
                    "The uploaded file does not match its expected checksum",
                )

            facts = self._checkpoint_facts(lease, digest)
            if facts is None:
                self._heartbeat_and_cancel(lease)
                scan = self._scanner.scan(snapshot.data)
                if scan.state in {"unavailable", "timeout", "error"}:
                    state = self._repository.fail_or_cancel(
                        lease,
                        code=f"scanner-{scan.state}",
                        message="The required safety scanner could not complete this attempt",
                        retryable=True,
                    )
                    return WorkerOutcome(state, lease.job_id)
                outcome = inspect_bytes(
                    snapshot.data,
                    display_name=lease.display_name,
                    expected_media_type=lease.expected_media_type,
                    malware_state=scan.state,
                    limits=InspectionLimits(
                        max_bytes=int(lease.constraints["max_bytes"]),
                        max_pixels=int(lease.constraints["max_pixels"]),
                        max_pages=int(lease.constraints["max_pages"]),
                    ),
                )
                if not outcome.accepted or outcome.facts is None:
                    return self._reject(
                        lease,
                        source,
                        outcome.code or "inspection-rejected",
                        outcome.message or "The file did not pass inspection",
                    )
                facts = outcome.facts.model_dump(mode="json")
                self._repository.checkpoint(
                    lease,
                    "inspection-accepted",
                    {"generation": lease.object_generation, "sha256": digest, "facts": facts},
                )

            self._heartbeat_and_cancel(lease)
            immutable = self._objects.promote(
                source,
                source_generation=lease.object_generation,
                sha256=digest,
                max_bytes=lease.expected_byte_size,
            )
            if not immutable.generation:
                raise RuntimeError("immutable object storage generation is unavailable")
            self._heartbeat_and_cancel(lease)
            self._repository.complete_accepted(
                lease,
                immutable_object_key=immutable.object_key,
                immutable_storage_generation=immutable.generation,
                facts=facts,
            )
            self._objects.delete(source, generation=lease.object_generation)
            return WorkerOutcome("succeeded", lease.job_id)
        except JobBusyError:
            return WorkerOutcome("busy", lease.job_id)
        except WorkerCancelledError:
            return WorkerOutcome("cancelled", lease.job_id)
        except (
            google_exceptions.DeadlineExceeded,
            google_exceptions.InternalServerError,
            google_exceptions.ServiceUnavailable,
            google_exceptions.TooManyRequests,
            TimeoutError,
            ConnectionError,
        ):
            state = self._repository.fail_or_cancel(
                lease,
                code="worker-temporary-infrastructure",
                message="A temporary private processing dependency was unavailable",
                retryable=True,
            )
            return WorkerOutcome(state, lease.job_id)
        except (ValueError, LookupError) as error:
            state = self._repository.fail_or_cancel(
                lease,
                code="worker-input-invalid",
                message=str(error),
                retryable=False,
            )
            return WorkerOutcome(state, lease.job_id)

    def _checkpoint_facts(self, lease: LeasedIntakeJob, digest: str) -> dict[str, object] | None:
        checkpoint = self._repository.latest_checkpoint(lease)
        if checkpoint is None or checkpoint[0] != "inspection-accepted":
            return None
        payload = checkpoint[1]
        facts = payload.get("facts")
        if (
            payload.get("generation") == lease.object_generation
            and payload.get("sha256") == digest
            and isinstance(facts, dict)
            and facts.get("sha256") == digest
            and facts.get("malware_scan_state") == "clean"
        ):
            return facts
        return None

    def _heartbeat_and_cancel(self, lease: LeasedIntakeJob) -> None:
        self._repository.heartbeat(lease)
        if self._repository.cancellation_requested(lease):
            self._repository.fail_or_cancel(
                lease,
                code="worker-cancelled",
                message="The customer cancelled this file",
                retryable=False,
            )
            raise WorkerCancelledError("job was cancelled")

    def _reject(
        self,
        lease: LeasedIntakeJob,
        source: PrivateObjectRef,
        code: str,
        message: str,
    ) -> WorkerOutcome:
        self._repository.complete_rejected(lease, code=code, message=message)
        self._objects.delete(source, generation=lease.object_generation)
        return WorkerOutcome("rejected", lease.job_id)
