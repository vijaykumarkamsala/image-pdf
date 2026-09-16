"""Owned synthetic PostgreSQL/PNG mechanics, never real-face quality evidence."""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import numpy as np
import pytest

from ipw.contracts.image_quality_face import (
    FaceQualityCompositionIntent,
    NativeFaceContext,
    NativeFaceRegion,
    NativeFaceRelease,
)
from ipw.processing_worker import face_quality as module
from ipw.processing_worker.durable_intake import DispatchMessage
from ipw.processing_worker.face_quality import DurableNativeFaceProcessor, NativeFaceProposal
from ipw.processing_worker.face_quality_repository import PostgresFaceQualityWorkerRepository
from ipw.processing_worker.repository import JobBusyError
from ipw.processing_worker.task_server import DurableJobRouter
from ipw.storage import MaterializedPrivateObject, PrivateObjectSnapshot


def repository() -> PostgresFaceQualityWorkerRepository:
    address = os.environ.get("IPW_TEST_FACE_DATABASE_URL")
    assert address, "IPW_TEST_FACE_DATABASE_URL required; no silent skipped durable checks"
    parsed = urlparse(address)
    assert parsed.hostname in {"localhost", "127.0.0.1"}
    assert parsed.path == "/ipw_face_test"
    return PostgresFaceQualityWorkerRepository.connect(address)


def decoded(data: bytes) -> np.ndarray[Any, Any]:
    import pyvips

    image = pyvips.Image.new_from_buffer(data, "")
    return (
        np.frombuffer(
            image.write_to_memory(), dtype=np.uint16 if image.format == "ushort" else np.uint8
        )
        .reshape(image.height, image.width, image.bands)
        .copy()
    )


class Objects:
    def __init__(self) -> None:
        self.values: dict[str, bytes] = {}
        self.file_writes = 0
        self.file_error = False
        self.after_write: Any = None

    def read(self, ref: Any, *, generation: str, max_bytes: int) -> PrivateObjectSnapshot:
        data = self.values[ref.object_key]
        assert len(data) <= max_bytes
        return PrivateObjectSnapshot(ref, generation, "application/octet-stream", data)

    def materialize(
        self, ref: Any, *, generation: str, destination: Path, max_bytes: int
    ) -> MaterializedPrivateObject:
        data = self.values[ref.object_key]
        assert len(data) <= max_bytes
        destination.write_bytes(data)
        return MaterializedPrivateObject(
            ref, generation, "image/png", destination, len(data), hashlib.sha256(data).hexdigest()
        )

    def write_derivative(
        self, ref: Any, *, data: bytes, media_type: str, sha256: str, max_bytes: int
    ) -> PrivateObjectSnapshot:
        assert ref.object_key.startswith(f"derivative/{ref.owner_scope}/face/")
        assert len(data) <= max_bytes
        assert hashlib.sha256(data).hexdigest() == sha256
        previous = self.values.setdefault(ref.object_key, data)
        assert previous == data
        return PrivateObjectSnapshot(ref, sha256, media_type, b"")

    def write_derivative_file(
        self, ref: Any, *, source: Path, media_type: str, sha256: str, max_bytes: int
    ) -> PrivateObjectSnapshot:
        self.file_writes += 1
        if self.file_error:
            raise OSError("Owned synthetic storage failure")
        written = self.write_derivative(
            ref, data=source.read_bytes(), media_type=media_type, sha256=sha256, max_bytes=max_bytes
        )
        if self.after_write:
            self.after_write()
        return written

    def delete(self, *_args: Any, **_kwargs: Any) -> None:
        pytest.fail(
            "Durable face worker must not delete original, base or another worker's artefact"
        )


class Engine:
    def __init__(self) -> None:
        self.calls = 0
        self.fail_at: int | None = None
        self.after: Any = None
        self.approval: NativeFaceRelease | None = NativeFaceRelease(
            model_id="owned-synthetic-not-production",
            model_version="1",
            model_sha256="a" * 64,
            dependency_lock_sha256="c" * 64,
            commercial_rights="approved",
            rights_evidence_id="test-only",
            quality_review="approved",
            quality_evidence_id="test-only-no-face-quality",
        )

    def release(self) -> NativeFaceRelease | None:
        return self.approval

    def propose(
        self,
        *,
        source_path: Path,
        base_path: Path,
        context: NativeFaceContext,
        fidelity_permyriad: int,
        cancelled: Any,
    ) -> NativeFaceProposal:
        self.calls += 1
        assert source_path.is_file()
        assert base_path.is_file()
        assert not cancelled()
        if self.calls == self.fail_at:
            raise RuntimeError("owned synthetic interrupted inference")
        dtype = np.uint16 if context.bit_depth == 16 else np.uint8
        pixels = np.full(
            (4, 5, 4),
            20000 + fidelity_permyriad
            if context.bit_depth == 16
            else 100 + fidelity_permyriad // 200,
            dtype=dtype,
        )
        mask = np.full((4, 5), 255, dtype=np.uint8)
        mask[0, 0] = 0
        if self.after:
            self.after()
        return NativeFaceProposal(NativeFaceRegion(x=4, y=3, width=5, height=4), pixels, mask)


class Fixture:
    def __init__(self, tmp_path: Path, *, depth: int = 8) -> None:
        import pyvips

        self.repo = repository()
        self.connection = self.repo._connection  # noqa: SLF001 -- Owned integration-test connection.
        self.objects = Objects()
        self.engine = Engine()
        self.ids = {
            name: f"{name}-face-{secrets.token_hex(6)}"
            for name in ("guest", "upload", "base", "basejob", "face", "job")
        }
        pixels = np.full(
            (12, 18, 4), 16023 if depth == 16 else 63, dtype=np.uint16 if depth == 16 else np.uint8
        )
        pixels[..., 3] = 65535 if depth == 16 else 255
        pixels[4, 5, 3] = 0
        pixels[5, 6, 3] = 32123 if depth == 16 else 127
        native = tmp_path / "owned-synthetic.png"
        pyvips.Image.new_from_memory(
            memoryview(pixels), 18, 12, 4, "ushort" if depth == 16 else "uchar"
        ).copy(interpretation="rgb16" if depth == 16 else "srgb").pngsave(
            str(native), bitdepth=depth
        )
        self.bytes = native.read_bytes()
        self.sha = hashlib.sha256(self.bytes).hexdigest()
        self.source_key = f"immutable/{self.ids['guest']}/{self.sha}"
        self.base_key = f"derivative/{self.ids['guest']}/synthetic/base.png"
        self.objects.values[self.source_key] = self.bytes
        self.objects.values[self.base_key] = self.bytes
        self.intent = {
            "contract_version": "image-quality-face-v1",
            "base_image_quality_request_id": self.ids["base"],
            "source_sha256": self.sha,
            "base_output_sha256": self.sha,
            "allow_reconstructed_face_detail": True,
            "fidelity_permyriad": 10000,
            "candidate_count": 2,
        }
        cursor = self.connection.cursor()
        cursor.execute(
            "INSERT INTO guest_sessions(guest_session_id,token_hash,expires_at,created_at) "
            "VALUES(%s,%s,now()+interval '1 day',now())",
            (self.ids["guest"], hashlib.sha256(self.ids["guest"].encode()).hexdigest()),
        )
        cursor.execute(
            """INSERT INTO upload_sessions(upload_session_id,owner_kind,guest_session_id,
            display_name,expected_media_type,expected_byte_size,bytes_received,state,constraints,
            upload_token_hash,upload_token_expires_at,quarantine_object_key,immutable_object_key,
            immutable_provider_generation,source_version_id,source_facts,created_at,expires_at,
            updated_at,transfer_provider)
            VALUES(%s,'guest',%s,'owned-synthetic.png','image/png',%s,%s,'ready','{}',%s,
            now()+interval '1 hour',%s,%s,%s,%s,%s::jsonb,now(),
            now()+interval '1 day',now(),'local_api')""",
            (
                self.ids["upload"],
                self.ids["guest"],
                len(self.bytes),
                len(self.bytes),
                self.sha,
                f"quarantine/{self.ids['guest']}/{self.ids['upload']}",
                self.source_key,
                self.sha,
                "source-test",
                json.dumps({"sha256": self.sha}),
            ),
        )
        cursor.execute(
            """INSERT INTO image_quality_requests(image_quality_request_id,owner_kind,owner_scope,
            guest_session_id,upload_session_id,source_version_id,source_object_key,
            source_storage_generation,source_sha256,source_media_type,source_byte_size,
            source_width,source_height,source_frame_count,source_bit_depth,source_has_icc_profile,
            content_class,strength,job_id,state,expires_at,created_at,updated_at)
            VALUES(%s,'guest',%s,%s,%s,'source-test',%s,%s,%s,'image/png',%s,18,12,1,%s,
            false,'photo',80,%s,'queued',now()+interval '1 day',now(),now())""",
            (
                self.ids["base"],
                self.ids["guest"],
                self.ids["guest"],
                self.ids["upload"],
                self.source_key,
                self.sha,
                self.sha,
                len(self.bytes),
                depth,
                self.ids["basejob"],
            ),
        )
        cursor.execute(
            """INSERT INTO processing_jobs(job_id,kind,owner_kind,guest_session_id,
            upload_session_id,image_quality_request_id,state,attempt,max_attempts,
            progress_percent,created_at,updated_at)
            VALUES(%s,'image_quality_restore','guest',%s,%s,%s,'succeeded',0,3,100,now(),now())""",
            (self.ids["basejob"], self.ids["guest"], self.ids["upload"], self.ids["base"]),
        )
        cursor.execute(
            """UPDATE image_quality_requests SET state='succeeded',output_object_key=%s,
            output_storage_generation=%s,output_sha256=%s,output_media_type='image/png',
            output_byte_size=%s,output_width=18,output_height=12,output_frame_count=1,
            output_bit_depth=%s,output_has_icc_profile=false,output_colour_policy='synthetic-only',
            model_id='owned-synthetic',model_version='1',model_sha256=%s,
            model_usage='deterministic',deterministic=true,processor_name='owned-synthetic-test',
            processor_version='1',output_fidelity='{}' WHERE image_quality_request_id=%s""",
            (self.base_key, self.sha, self.sha, len(self.bytes), depth, self.sha, self.ids["base"]),
        )
        cursor.close()
        self.connection.commit()
        self.seed("candidates", self.ids["face"], self.ids["job"], self.intent)

    def seed(self, operation: str, face_id: str, job_id: str, intent: dict[str, Any]) -> None:
        cursor = self.connection.cursor()
        assert self.engine.approval
        cursor.execute(
            """INSERT INTO face_quality_jobs(face_quality_job_id,job_id,operation,owner_kind,
            owner_scope,guest_session_id,upload_session_id,
            base_image_quality_request_id,source_sha256,base_output_sha256,candidate_request_id,candidate_sha256,intent,release,expires_at,created_at)
            VALUES(%s,%s,%s,'guest',%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb,
            now()+interval '1 day',now())""",
            (
                face_id,
                job_id,
                operation,
                self.ids["guest"],
                self.ids["guest"],
                self.ids["upload"],
                self.ids["base"],
                self.sha,
                self.sha,
                intent.get("candidate_request_id"),
                intent.get("candidate_sha256"),
                json.dumps(intent),
                self.engine.approval.model_dump_json(),
            ),
        )
        cursor.execute(
            """INSERT INTO processing_jobs(job_id,kind,owner_kind,guest_session_id,
            upload_session_id,face_quality_job_id,state,attempt,max_attempts,
            progress_percent,created_at,updated_at)
            VALUES(%s,%s,'guest',%s,%s,%s,'queued',0,3,0,now(),now())""",
            (
                job_id,
                "image_face_candidates" if operation == "candidates" else "image_face_compose",
                self.ids["guest"],
                self.ids["upload"],
                face_id,
            ),
        )
        cursor.close()
        self.connection.commit()

    def sql(self, query: str, args: tuple[Any, ...] = ()) -> Any:
        cursor = self.connection.cursor()
        cursor.execute(query, args)
        value = cursor.fetchall() if cursor.description else None
        cursor.close()
        self.connection.commit()
        return value

    def run(self, job: str | None = None, **options: Any) -> str:
        worker = DurableNativeFaceProcessor(
            self.repo, self.objects, self.engine, worker_id="test-native-face", **options
        )
        return worker.process(
            DispatchMessage("dispatch-face-test", job or self.ids["job"], "trace-face-test")
        ).state

    def compose(self) -> tuple[str, str]:
        cursor = self.connection.cursor()
        cursor.execute(
            "SELECT candidate_sha256 FROM face_quality_candidates "
            "WHERE face_quality_job_id=%s ORDER BY ordinal LIMIT 1",
            (self.ids["face"],),
        )
        digest = cursor.fetchone()[0]
        cursor.close()
        self.connection.commit()
        intent = FaceQualityCompositionIntent(
            contract_version="image-quality-face-v1",
            candidate_request_id=self.ids["face"],
            candidate_sha256=digest,
            source_sha256=self.sha,
            base_output_sha256=self.sha,
            allow_reconstructed_face_detail=True,
            acknowledged_possible_identity_change=True,
        )
        face = f"compose-face-{secrets.token_hex(6)}"
        job = f"compose-job-{secrets.token_hex(6)}"
        self.seed("compose", face, job, intent.model_dump())
        return face, job


@pytest.mark.parametrize("depth", [8, 16])
def test_restart_checkpoints_and_actual_native_png_composition(tmp_path: Path, depth: int) -> None:
    sample = Fixture(tmp_path, depth=depth)
    try:
        sample.engine.fail_at = 2
        assert sample.run() == "retry_wait"
        assert (
            sample.sql(
                "SELECT count(*) FROM face_quality_candidates WHERE face_quality_job_id=%s",
                (sample.ids["face"],),
            )[0][0]
            == 1
        )
        assert sample.objects.file_writes == 0
        sample.repo.close()
        sample.repo = repository()
        sample.connection = sample.repo._connection  # noqa: SLF001
        sample.engine = Engine()
        sample.sql(
            "UPDATE processing_jobs SET next_attempt_at=now()-interval '1 second' WHERE job_id=%s",
            (sample.ids["job"],),
        )
        assert sample.run() == "succeeded"
        assert sample.engine.calls == 1
        assert sample.run() == "already_terminal"
        assert sample.engine.calls == 1
        face, job = sample.compose()
        assert sample.run(job) == "succeeded"
        assert sample.run(job) == "already_terminal"
        assert sample.objects.file_writes == 1
        output = sample.sql(
            "SELECT output FROM face_quality_jobs WHERE face_quality_job_id=%s", (face,)
        )[0][0]
        actual = sample.objects.values[output["object"]["object_key"]]
        before, after = decoded(sample.bytes), decoded(actual)
        outside = np.ones((12, 18), dtype=bool)
        outside[3:7, 4:9] = False
        assert after.dtype == before.dtype
        assert np.array_equal(after[outside], before[outside])
        assert np.array_equal(after[..., 3], before[..., 3])
        assert np.array_equal(after[4, 5], before[4, 5])
        assert np.array_equal(after[3, 4], before[3, 4])
        assert np.any(after != before)
        assert hashlib.sha256(actual).hexdigest() == output["object"]["sha256"]
        assert output["evidence"]["kind"] == "explicit-face-recreate"
        assert sample.objects.values[sample.source_key] == sample.bytes
        assert sample.objects.values[sample.base_key] == sample.bytes
        assert (
            sample.sql(
                "SELECT state FROM upload_sessions WHERE upload_session_id=%s",
                (sample.ids["upload"],),
            )[0][0]
            == "ready"
        )
    finally:
        sample.repo.close()


@pytest.mark.parametrize("target", ["pixels", "mask", "source", "base"])
def test_stored_patch_mask_and_immutable_objects_cannot_be_changed(
    tmp_path: Path, target: str
) -> None:
    sample = Fixture(tmp_path)
    try:
        assert sample.run() == "succeeded"
        face, job = sample.compose()
        row = sample.sql(
            "SELECT stored_candidate FROM face_quality_candidates "
            "WHERE face_quality_job_id=%s ORDER BY ordinal LIMIT 1",
            (sample.ids["face"],),
        )[0][0]
        key = (
            sample.source_key
            if target == "source"
            else sample.base_key
            if target == "base"
            else row[target]["object_key"]
        )
        data = bytearray(sample.objects.values[key])
        data[-1] ^= 1
        sample.objects.values[key] = bytes(data)
        assert sample.run(job) == "failed"
        assert sample.objects.file_writes == 0
        assert (
            sample.sql(
                "SELECT output FROM face_quality_jobs WHERE face_quality_job_id=%s", (face,)
            )[0][0]
            is None
        )
    finally:
        sample.repo.close()


@pytest.mark.parametrize("approval", ["unregistered", "pending", "wrong-model"])
def test_unregistered_revoked_or_wrong_model_never_infers(tmp_path: Path, approval: str) -> None:
    sample = Fixture(tmp_path)
    try:
        assert sample.engine.approval
        sample.engine.approval = (
            None
            if approval == "unregistered"
            else sample.engine.approval.model_copy(
                update={"commercial_rights": "pending"}
                if approval == "pending"
                else {"model_sha256": "d" * 64}
            )
        )
        assert sample.run() == "failed"
        assert sample.engine.calls == 0
        assert sample.objects.file_writes == 0
    finally:
        sample.repo.close()


def test_expired_worker_cannot_heartbeat_or_complete_after_reclaim(tmp_path: Path) -> None:
    sample = Fixture(tmp_path)
    other = repository()
    try:
        old = sample.repo.claim_face(
            job_id=sample.ids["job"],
            worker_id="old-worker",
            lease_token=secrets.token_urlsafe(32),
            trace_id="trace-face-test",
        )
        assert old
        sample.repo.start_face(old)
        sample.sql(
            "UPDATE processing_jobs SET lease_expires_at=now()-interval '1 second' WHERE job_id=%s",
            (old.job_id,),
        )
        new = other.claim_face(
            job_id=old.job_id,
            worker_id="new-worker",
            lease_token=secrets.token_urlsafe(32),
            trace_id="trace-face-test",
        )
        assert new
        with pytest.raises(JobBusyError):
            sample.repo.heartbeat_face(old)
        with pytest.raises(JobBusyError):
            sample.repo.complete_face(old)
        assert (
            sample.sql(
                "SELECT lease_token_hash FROM processing_jobs WHERE job_id=%s", (old.job_id,)
            )[0][0]
            == new.lease_hash
        )
    finally:
        sample.repo.close()
        other.close()


def test_cancel_between_inference_and_checkpoint_keeps_original_and_no_reviewable_output(
    tmp_path: Path,
) -> None:
    sample = Fixture(tmp_path)
    control = repository()
    try:

        def cancel() -> None:
            cursor = control._connection.cursor()  # noqa: SLF001 -- Separate synthetic control connection.
            cursor.execute(
                "UPDATE processing_jobs SET state='cancel_requested' WHERE job_id=%s",
                (sample.ids["job"],),
            )
            cursor.close()
            control._connection.commit()  # noqa: SLF001

        sample.engine.after = cancel
        assert sample.run() == "cancelled"
        assert (
            sample.sql(
                "SELECT count(*) FROM face_quality_candidates WHERE face_quality_job_id=%s",
                (sample.ids["face"],),
            )[0][0]
            == 0
        )
        assert sample.objects.values[sample.source_key] == sample.bytes
        assert sample.objects.file_writes == 0
    finally:
        sample.repo.close()
        control.close()


def test_slice_yield_resumes_committed_candidate_without_reinference(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    sample = Fixture(tmp_path)
    clock = [100.0]
    try:
        monkeypatch.setattr(module.time, "monotonic", lambda: clock[0])
        sample.engine.after = lambda: clock.__setitem__(0, 200.0)
        assert sample.run(max_slice_seconds=60) == "retry_wait"
        assert sample.sql(
            "SELECT attempt,progress_percent FROM processing_jobs WHERE job_id=%s",
            (sample.ids["job"],),
        )[0] == [0, 45]
        sample.engine = Engine()
        assert sample.run(max_slice_seconds=60) == "succeeded"
        assert sample.engine.calls == 1
    finally:
        sample.repo.close()


def test_composition_storage_failure_is_retryable_without_candidate_reinference(
    tmp_path: Path,
) -> None:
    sample = Fixture(tmp_path)
    try:
        assert sample.run() == "succeeded"
        face, job = sample.compose()
        sample.objects.file_error = True
        assert sample.run(job) == "retry_wait"
        assert (
            sample.sql(
                "SELECT output FROM face_quality_jobs WHERE face_quality_job_id=%s", (face,)
            )[0][0]
            is None
        )
        sample.objects.file_error = False
        sample.sql(
            "UPDATE processing_jobs SET next_attempt_at=now()-interval '1 second' WHERE job_id=%s",
            (job,),
        )
        assert sample.run(job) == "succeeded"
        assert (
            sample.engine.calls == 2
        )  # Original proposal set, never inferred again for composition.
        assert sample.objects.values[sample.base_key] == sample.bytes
    finally:
        sample.repo.close()


def test_release_revocation_after_private_write_prevents_publication(tmp_path: Path) -> None:
    sample = Fixture(tmp_path)
    try:
        assert sample.run() == "succeeded"
        face, job = sample.compose()
        sample.objects.after_write = lambda: setattr(sample.engine, "approval", None)
        assert sample.run(job) == "failed"
        assert sample.objects.file_writes == 1
        assert (
            sample.sql(
                "SELECT output FROM face_quality_jobs WHERE face_quality_job_id=%s", (face,)
            )[0][0]
            is None
        )
        assert sample.objects.values[sample.source_key] == sample.bytes
    finally:
        sample.repo.close()


def test_heartbeat_renews_long_candidate_work_without_losing_checkpoints(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    sample = Fixture(tmp_path)
    calls: list[str] = []
    original = sample.repo.heartbeat_face
    try:

        def heartbeat(lease: Any) -> None:
            original(lease)
            calls.append(lease.job_id)

        monkeypatch.setattr(sample.repo, "heartbeat_face", heartbeat)
        sample.engine.after = lambda: time.sleep(0.08)
        assert sample.run(heartbeat_seconds=0.01) == "succeeded"
        assert calls
        assert set(calls) == {sample.ids["job"]}
        assert (
            sample.sql(
                "SELECT lease_token_hash FROM processing_jobs WHERE job_id=%s", (sample.ids["job"],)
            )[0][0]
            is None
        )
    finally:
        sample.repo.close()


def test_invalid_persisted_native_intent_fails_terminally_before_inference(tmp_path: Path) -> None:
    sample = Fixture(tmp_path)
    try:
        face = f"invalid-face-{secrets.token_hex(6)}"
        job = f"invalid-job-{secrets.token_hex(6)}"
        sample.seed("candidates", face, job, {**sample.intent, "fidelity_permyriad": -1})
        assert sample.run(job) == "already_terminal"
        assert sample.engine.calls == 0
        assert sample.sql(
            "SELECT state,failure->>'retryable' FROM processing_jobs WHERE job_id=%s", (job,)
        )[0] == ["failed", "false"]
    finally:
        sample.repo.close()


def test_slice_without_progress_consumes_bounded_retry_instead_of_refunding_forever(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    sample = Fixture(tmp_path)
    clock = [100.0]
    original = sample.objects.materialize
    try:
        monkeypatch.setattr(module.time, "monotonic", lambda: clock[0])

        def materialize(*args: Any, **kwargs: Any) -> MaterializedPrivateObject:
            result = original(*args, **kwargs)
            clock[0] += 100.0
            return result

        monkeypatch.setattr(sample.objects, "materialize", materialize)
        for attempt in range(1, 4):
            assert sample.run(max_slice_seconds=60) == ("failed" if attempt == 3 else "retry_wait")
            assert (
                sample.sql(
                    "SELECT attempt FROM processing_jobs WHERE job_id=%s", (sample.ids["job"],)
                )[0][0]
                == attempt
            )
            sample.sql(
                "UPDATE processing_jobs SET next_attempt_at=now()-interval '1 second' "
                "WHERE job_id=%s",
                (sample.ids["job"],),
            )
        assert sample.engine.calls == 0
        assert sample.objects.file_writes == 0
    finally:
        sample.repo.close()


@pytest.mark.parametrize("kind", ["image_face_candidates", "image_face_compose"])
def test_native_job_router_uses_only_the_face_processor(kind: str) -> None:
    from ipw.processing_worker.durable_intake import WorkerOutcome

    class Repository:
        def job_kind(self, _job_id: str) -> str:
            return kind

    class Processor:
        def __init__(self) -> None:
            self.calls: list[str] = []

        def process(self, message: DispatchMessage) -> WorkerOutcome:
            self.calls.append(message.job_id)
            return WorkerOutcome("succeeded", message.job_id)

    old, face = Processor(), Processor()
    router = DurableJobRouter(Repository(), old, old, old, old, old, old, face)  # type: ignore[arg-type]
    message = DispatchMessage("dispatch-face-test", "job-owned-face", "trace-face-test")
    assert router.process(message) == WorkerOutcome("succeeded", message.job_id)
    assert face.calls == [message.job_id]
    assert old.calls == []
