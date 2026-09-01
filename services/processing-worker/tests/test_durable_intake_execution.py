from __future__ import annotations

import json
import struct
from typing import Any

import pytest
from google.oauth2 import id_token

import ipw.processing_worker.task_server as task_server
from ipw.inspection import DeterministicMalwareScanner, MalwareScan
from ipw.processing_worker.durable_intake import (
    DispatchMessage,
    DurableIntakeProcessor,
    WorkerOutcome,
)
from ipw.processing_worker.repository import LeasedIntakeJob
from ipw.processing_worker.task_server import (
    GoogleOidcTaskIdentityVerifier,
    IntakeTaskApplication,
    build_production_application,
)
from ipw.storage import ObjectZone, PrivateObjectRef, PrivateObjectSnapshot


def png() -> bytes:
    return (
        b"\x89PNG\r\n\x1a\n"
        + struct.pack(">I4sIIBBBBB", 13, b"IHDR", 2, 3, 8, 2, 0, 0, 0)
        + b"\x00\x00\x00\x00"
    )


class FakeRepository:
    def __init__(self, data: bytes) -> None:
        import hashlib

        self.calls: list[str] = []
        self.cancel = False
        self.terminal = False
        self.saved_checkpoint: tuple[str, dict[str, Any]] | None = None
        self.lease = LeasedIntakeJob(
            job_id="job-001",
            upload_session_id="upload-001",
            trace_id="trace-001",
            attempt=1,
            max_attempts=3,
            lease_token_hash="a" * 64,
            owner_kind="actor",
            owner_scope="workspace-001",
            workspace_id="workspace-001",
            actor_id="actor-001",
            display_name="source.png",
            expected_media_type="image/png",
            expected_byte_size=len(data),
            expected_sha256=hashlib.sha256(data).hexdigest(),
            object_key="quarantine/workspace-001/upload-001",
            object_generation="17",
            constraints={"max_bytes": 1024, "max_pixels": 10_000, "max_pages": 10},
        )

    def claim(
        self,
        *,
        job_id: str,
        worker_id: str,
        lease_token: str,
        trace_id: str,
    ) -> LeasedIntakeJob | None:
        assert job_id
        assert worker_id
        assert lease_token
        assert trace_id
        self.calls.append("claim")
        return None if self.terminal else self.lease

    def start(self, _lease: LeasedIntakeJob) -> None:
        self.calls.append("start")

    def heartbeat(self, _lease: LeasedIntakeJob) -> None:
        self.calls.append("heartbeat")

    def cancellation_requested(self, _lease: LeasedIntakeJob) -> bool:
        return self.cancel

    def latest_checkpoint(self, _lease: LeasedIntakeJob) -> tuple[str, dict[str, Any]] | None:
        self.calls.append("checkpoint.read")
        return self.saved_checkpoint

    def checkpoint(self, _lease: LeasedIntakeJob, key: str, payload: dict[str, Any]) -> None:
        self.calls.append("checkpoint.write")
        self.saved_checkpoint = (key, payload)

    def complete_accepted(
        self,
        lease: LeasedIntakeJob,
        *,
        immutable_object_key: str,
        immutable_storage_generation: str,
        facts: dict[str, Any],
    ) -> None:
        assert lease.job_id
        assert immutable_object_key
        assert immutable_storage_generation == "a" * 64
        assert facts
        self.calls.append("complete.accepted")
        self.terminal = True

    def complete_rejected(
        self,
        lease: LeasedIntakeJob,
        *,
        code: str,
        message: str,
    ) -> None:
        assert lease.job_id
        assert code
        assert message
        self.calls.append("complete.rejected")
        self.terminal = True

    def fail_or_cancel(
        self,
        lease: LeasedIntakeJob,
        *,
        code: str,
        message: str,
        retryable: bool,
    ) -> str:
        assert lease.job_id
        assert code
        assert message
        state = "cancelled" if self.cancel else "retry_wait" if retryable else "failed"
        self.calls.append(state)
        self.terminal = state in {"cancelled", "failed"}
        return state


class FakeObjects:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.calls: list[str] = []

    def read(
        self, ref: PrivateObjectRef, *, generation: str, max_bytes: int
    ) -> PrivateObjectSnapshot:
        self.calls.append("read")
        assert generation == "17"
        assert len(self.data) <= max_bytes
        return PrivateObjectSnapshot(ref, generation, "image/png", self.data)

    def promote(
        self,
        source: PrivateObjectRef,
        *,
        source_generation: str,
        sha256: str,
        max_bytes: int,
    ) -> PrivateObjectRef:
        self.calls.append("promote")
        assert source_generation == "17"
        assert len(sha256) == 64
        assert len(self.data) <= max_bytes
        return PrivateObjectRef(
            source.owner_scope,
            "immutable/workspace-001/" + "a" * 64,
            ObjectZone.IMMUTABLE,
            "a" * 64,
        )

    def delete(self, _ref: PrivateObjectRef, *, generation: str | None = None) -> None:
        self.calls.append("delete")
        assert generation in {None, "17"}


class CountingScanner(DeterministicMalwareScanner):
    def __init__(self) -> None:
        self.calls = 0

    def scan(self, data: bytes) -> MalwareScan:
        self.calls += 1
        return super().scan(data)


def test_worker_claims_heartbeats_checkpoints_promotes_and_is_idempotent() -> None:
    data = png()
    repository = FakeRepository(data)
    objects = FakeObjects(data)
    scanner = CountingScanner()
    processor = DurableIntakeProcessor(repository, objects, scanner, worker_id="worker-001")
    message = DispatchMessage("dispatch-001", "job-001", "trace-001")

    assert processor.process(message).state == "succeeded"
    assert scanner.calls == 1
    assert repository.calls.count("heartbeat") >= 4
    assert "checkpoint.write" in repository.calls
    assert objects.calls == ["read", "promote", "delete"]
    assert processor.process(message).state == "already_terminal"


def test_safe_checkpoint_resume_skips_repeated_scanning_for_the_same_generation() -> None:
    data = png()
    first_repository = FakeRepository(data)
    first_objects = FakeObjects(data)
    first = DurableIntakeProcessor(
        first_repository, first_objects, CountingScanner(), worker_id="worker-001"
    )
    first.process(DispatchMessage("dispatch-001", "job-001", "trace-001"))
    assert first_repository.saved_checkpoint is not None

    resumed_repository = FakeRepository(data)
    resumed_repository.saved_checkpoint = first_repository.saved_checkpoint
    scanner = CountingScanner()
    resumed = DurableIntakeProcessor(
        resumed_repository, FakeObjects(data), scanner, worker_id="worker-002"
    )
    assert (
        resumed.process(DispatchMessage("dispatch-002", "job-001", "trace-001")).state
        == "succeeded"
    )
    assert scanner.calls == 0


def test_cancellation_after_scan_prevents_promotion_and_wins_the_terminal_race() -> None:
    data = png()
    repository = FakeRepository(data)
    objects = FakeObjects(data)

    class CancellingScanner:
        def scan(self, _data: bytes) -> MalwareScan:
            repository.cancel = True
            return MalwareScan("clean")

    processor = DurableIntakeProcessor(
        repository, objects, CancellingScanner(), worker_id="worker-001"
    )
    assert (
        processor.process(DispatchMessage("dispatch-001", "job-001", "trace-001")).state
        == "cancelled"
    )
    assert "cancelled" in repository.calls
    assert "promote" not in objects.calls


def test_scanner_unavailability_schedules_only_a_recoverable_retry() -> None:
    data = png()
    repository = FakeRepository(data)

    class UnavailableScanner:
        def scan(self, _data: bytes) -> MalwareScan:
            return MalwareScan("unavailable")

    processor = DurableIntakeProcessor(
        repository, FakeObjects(data), UnavailableScanner(), worker_id="worker-001"
    )
    assert (
        processor.process(DispatchMessage("dispatch-001", "job-001", "trace-001")).state
        == "retry_wait"
    )


def test_internal_task_requires_identity_task_header_and_an_exact_opaque_envelope() -> None:
    data = png()
    repository = FakeRepository(data)
    processor = DurableIntakeProcessor(
        repository, FakeObjects(data), CountingScanner(), worker_id="worker-001"
    )

    class Verifier:
        def verify(self, authorization: str | None) -> None:
            if authorization != "Bearer accepted":
                raise PermissionError

    app = IntakeTaskApplication(Verifier(), processor)
    payload = json.dumps(
        {
            "dispatchId": "dispatch-001",
            "jobId": "job-001",
            "traceId": "trace-001",
            "kind": "process_job",
        }
    ).encode()
    assert app.handle({}, payload).status == 401
    assert app.handle({"authorization": "Bearer accepted"}, payload).status == 401
    accepted = app.handle(
        {
            "authorization": "Bearer accepted",
            "x-cloudtasks-taskname": "projects/p/tasks/dispatch-001",
        },
        payload,
    )
    assert accepted.status == 200
    assert accepted.body["job_id"] == "job-001"
    assert (
        app.handle(
            {"authorization": "Bearer accepted", "x-cloudtasks-taskname": "task"},
            json.dumps({"jobId": "job-001", "kind": "process_job"}).encode(),
        ).status
        == 400
    )


def test_internal_task_rejects_large_malformed_and_invalid_payloads() -> None:
    class Verifier:
        def verify(self, _authorization: str | None) -> None:
            return

    class Processor:
        def __init__(self) -> None:
            self.state = "busy"

        def process(self, message: DispatchMessage) -> WorkerOutcome:
            return WorkerOutcome(self.state, message.job_id)

    processor = Processor()
    app = IntakeTaskApplication(Verifier(), processor)
    headers = {"x-cloudtasks-taskname": "projects/p/tasks/task-001"}
    assert app.handle(headers, b"x" * (16 * 1024 + 1)).status == 413
    assert app.handle(headers, b"not-json").status == 400
    assert app.handle(headers, b"[]").status == 400
    assert app.handle(headers, json.dumps({"unexpected": "value"}).encode()).status == 400
    for invalid in (
        {"dispatchId": "x", "jobId": "job-001", "traceId": "trace-001", "kind": "process_job"},
        {"dispatchId": "dispatch-001", "jobId": "job-001", "traceId": "trace-001", "kind": "other"},
    ):
        assert app.handle(headers, json.dumps(invalid).encode()).status == 400
    valid = json.dumps(
        {
            "dispatchId": "dispatch-001",
            "jobId": "job-001",
            "traceId": "trace-001",
            "kind": "process_job",
        }
    ).encode()
    assert app.handle(headers, valid) == task_server.TaskResponse(
        409, {"state": "busy", "job_id": "job-001"}
    )


def test_google_task_identity_verifier_validates_configuration_and_claims(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with pytest.raises(ValueError, match="audience must be HTTPS"):
        GoogleOidcTaskIdentityVerifier("http://worker", "worker@project.iam.gserviceaccount.com")
    with pytest.raises(ValueError, match="must be a service account"):
        GoogleOidcTaskIdentityVerifier("https://worker", "worker@example.com")

    verifier = GoogleOidcTaskIdentityVerifier(
        "https://worker.internal",
        "worker@project.iam.gserviceaccount.com",
    )
    with pytest.raises(PermissionError, match="bearer identity"):
        verifier.verify(None)

    claims: dict[str, object] = {
        "email": "worker@project.iam.gserviceaccount.com",
        "email_verified": True,
        "iss": "https://accounts.google.com",
    }

    def verify_token(token: str, _request: object, *, audience: str) -> dict[str, object]:
        assert token == "signed-token"  # noqa: S105 - deterministic fake OIDC token
        assert audience == "https://worker.internal"
        return claims

    monkeypatch.setattr(id_token, "verify_oauth2_token", verify_token)
    verifier.verify("Bearer signed-token")
    claims["email"] = "other@project.iam.gserviceaccount.com"
    with pytest.raises(PermissionError, match="identity is not authorised"):
        verifier.verify("Bearer signed-token")
    claims["email"] = "worker@project.iam.gserviceaccount.com"
    claims["iss"] = "https://issuer.invalid"
    with pytest.raises(PermissionError, match="issuer is not authorised"):
        verifier.verify("Bearer signed-token")


def test_production_worker_composition_fails_closed_when_configuration_is_missing() -> None:
    with pytest.raises(RuntimeError, match=r"IPW_DATABASE_URL.*IPW_GCS_BUCKET"):
        build_production_application({})
