"""Lease-fenced PostgreSQL persistence for isolated native face jobs."""

from __future__ import annotations

import hashlib
import json
import secrets
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import timedelta
from typing import Any, Literal, Self, cast

from ipw.contracts.image_quality_face import (
    FaceQualityCandidateRequest,
    FaceQualityCompositionIntent,
    FaceQualityObject,
    NativeFaceContext,
    NativeFaceOutput,
    NativeFaceRelease,
    StoredNativeFaceCandidate,
    native_face_candidate_sha256,
)
from ipw.processing_worker.repository import (
    DatabaseConnection,
    JobBusyError,
    PostgresWorkerRepository,
    utcnow,
)


@dataclass(frozen=True)
class NativeFaceLease:
    job_id: str
    face_id: str
    operation: Literal["candidates", "compose"]
    owner_scope: str
    source: FaceQualityObject
    base: FaceQualityObject
    source_width: int
    source_height: int
    output_width: int
    output_height: int
    bit_depth: Literal[8, 16]
    intent: FaceQualityCandidateRequest | FaceQualityCompositionIntent
    release: NativeFaceRelease
    lease_hash: str
    attempt: int
    max_attempts: int
    trace_id: str


class PostgresFaceQualityWorkerRepository(PostgresWorkerRepository):
    def __init__(self, connection: DatabaseConnection) -> None:
        super().__init__(connection)
        self._lock = threading.RLock()

    @classmethod
    def connect(cls, database_url: str) -> Self:
        return cast(Self, super().connect(database_url))

    @contextmanager
    def _transaction(self) -> Iterator[Any]:
        # Heartbeats may run on another thread, but never share an active transaction.
        with self._lock:
            cursor = self._connection.cursor()
            try:
                yield cursor
                self._connection.commit()
            except Exception:
                self._connection.rollback()
                raise
            finally:
                cursor.close()

    def claim_face(
        self, *, job_id: str, worker_id: str, lease_token: str, trace_id: str
    ) -> NativeFaceLease | None:
        now = utcnow()
        with self._transaction() as cursor:
            cursor.execute("SELECT * FROM processing_jobs WHERE job_id=%s FOR UPDATE", (job_id,))
            job = self._one(cursor)
            if not job or job["kind"] not in {"image_face_candidates", "image_face_compose"}:
                return None
            if job["state"] in {"succeeded", "failed", "cancelled"}:
                return None
            if (
                job["lease_expires_at"]
                and job["lease_expires_at"] > now
                and job["state"] in {"leased", "running", "cancel_requested"}
            ):
                raise JobBusyError(job_id)
            if job["state"] == "cancel_requested":
                self._finish(cursor, job_id, trace_id, "cancelled", None)
                return None
            if (
                job["state"] == "retry_wait"
                and job["next_attempt_at"]
                and job["next_attempt_at"] > now
            ):
                raise JobBusyError(job_id)
            if int(job["attempt"]) >= int(job["max_attempts"]):
                self._finish(
                    cursor,
                    job_id,
                    trace_id,
                    "failed",
                    self._failure("face-attempts-exhausted", True),
                )
                return None
            cursor.execute(
                """SELECT f.*,u.state AS upload_state,u.source_facts,u.immutable_object_key,
                u.immutable_provider_generation,u.expires_at AS upload_expires_at,
                i.state AS base_state,i.output_sha256,i.output_object_key,
                i.output_storage_generation,
                i.output_byte_size,i.output_width,i.output_height,i.output_bit_depth,
                i.output_frame_count,i.source_frame_count,i.source_byte_size,i.source_width,i.source_height,
                i.owner_scope AS base_owner,i.source_sha256 AS base_source_sha256,
                i.expires_at AS base_expires_at
                FROM face_quality_jobs f JOIN upload_sessions u USING(upload_session_id)
                JOIN image_quality_requests i
                  ON i.image_quality_request_id=f.base_image_quality_request_id
                WHERE f.face_quality_job_id=%s""",
                (job["face_quality_job_id"],),
            )
            row = self._one(cursor)
            if (
                not row
                or row["upload_state"] != "ready"
                or row["base_state"] != "succeeded"
                or (
                    (row["source_facts"] or {}).get("sha256") != row["source_sha256"]
                    or row["base_source_sha256"] != row["source_sha256"]
                    or row["output_sha256"] != row["base_output_sha256"]
                    or row["base_owner"] != row["owner_scope"]
                    or min(row["expires_at"], row["upload_expires_at"], row["base_expires_at"])
                    <= now
                    or row["source_frame_count"] != 1
                    or row["output_frame_count"] != 1
                    or row["output_bit_depth"] not in {8, 16}
                )
            ):
                self._finish(
                    cursor,
                    job_id,
                    trace_id,
                    "failed",
                    self._failure("face-source-or-base-stale", False),
                )
                return None
            token_hash = hashlib.sha256(lease_token.encode()).hexdigest()
            try:
                lease = self._snapshot(row, job, token_hash, trace_id)
            except (ValueError, TypeError):
                self._finish(
                    cursor,
                    job_id,
                    trace_id,
                    "failed",
                    self._failure("face-native-snapshot-rejected", False),
                )
                return None
            cursor.execute(
                """UPDATE processing_jobs SET state='leased',attempt=attempt+1,
                lease_owner=%s,lease_token_hash=%s,lease_expires_at=%s,heartbeat_at=%s,
                next_attempt_at=NULL,updated_at=%s WHERE job_id=%s""",
                (worker_id, token_hash, now + timedelta(seconds=90), now, now, job_id),
            )
            self._face_event(cursor, job_id, trace_id, "leased", int(job["progress_percent"]))
            return lease

    @staticmethod
    def _snapshot(
        row: dict[str, Any], job: dict[str, Any], token_hash: str, trace_id: str
    ) -> NativeFaceLease:
        context = NativeFaceContext(
            source_sha256=row["source_sha256"],
            base_output_sha256=row["base_output_sha256"],
            source_width=row["source_width"],
            source_height=row["source_height"],
            output_width=row["output_width"],
            output_height=row["output_height"],
            bit_depth=row["output_bit_depth"],
            colour_authority_sha256="0" * 64,
        )  # Actual colour authority is read from the verified native PNG before inference.
        release = NativeFaceRelease.model_validate(row["release"])
        intent = (
            FaceQualityCandidateRequest
            if row["operation"] == "candidates"
            else FaceQualityCompositionIntent
        ).model_validate(row["intent"])
        scope = str(row["owner_scope"])
        source = FaceQualityObject(
            owner_scope=scope,
            object_key=row["immutable_object_key"],
            generation=row["immutable_provider_generation"],
            sha256=context.source_sha256,
            byte_size=row["source_byte_size"],
        )
        base = FaceQualityObject(
            owner_scope=scope,
            object_key=row["output_object_key"],
            generation=row["output_storage_generation"],
            sha256=context.base_output_sha256,
            byte_size=row["output_byte_size"],
        )
        if not source.object_key.startswith("immutable/") or not base.object_key.startswith(
            "derivative/"
        ):
            raise ValueError("native source/base zones do not match their immutable roles")
        return NativeFaceLease(
            str(job["job_id"]),
            str(row["face_quality_job_id"]),
            row["operation"],
            scope,
            source,
            base,
            context.source_width,
            context.source_height,
            context.output_width,
            context.output_height,
            context.bit_depth,
            intent,
            release,
            token_hash,
            int(job["attempt"]) + 1,
            int(job["max_attempts"]),
            trace_id,
        )

    def _require(self, cursor: Any, lease: NativeFaceLease) -> dict[str, Any]:
        cursor.execute(
            """SELECT * FROM processing_jobs WHERE job_id=%s AND face_quality_job_id=%s
            AND lease_token_hash=%s AND lease_expires_at>%s
            AND state IN ('leased','running','cancel_requested') FOR UPDATE""",
            (lease.job_id, lease.face_id, lease.lease_hash, utcnow()),
        )
        row = self._one(cursor)
        if not row:
            raise JobBusyError(lease.job_id)
        return row

    def start_face(self, lease: NativeFaceLease) -> None:
        with self._transaction() as cursor:
            row = self._require(cursor, lease)
            if row["state"] == "cancel_requested":
                return
            cursor.execute(
                "UPDATE processing_jobs SET state='running',updated_at=%s WHERE job_id=%s",
                (utcnow(), lease.job_id),
            )
            self._face_event(
                cursor, lease.job_id, lease.trace_id, "running", int(row["progress_percent"])
            )

    def heartbeat_face(self, lease: NativeFaceLease) -> None:
        with self._transaction() as cursor:
            self._require(cursor, lease)
            now = utcnow()
            cursor.execute(
                "UPDATE processing_jobs SET heartbeat_at=%s,lease_expires_at=%s WHERE job_id=%s",
                (now, now + timedelta(seconds=90), lease.job_id),
            )

    def cancelled_face(self, lease: NativeFaceLease) -> bool:
        with self._transaction() as cursor:
            return bool(self._require(cursor, lease)["state"] == "cancel_requested")

    def candidates_face(self, lease: NativeFaceLease) -> list[StoredNativeFaceCandidate]:
        with self._transaction() as cursor:
            self._require(cursor, lease)
            parent = (
                lease.face_id
                if lease.operation == "candidates"
                else cast(FaceQualityCompositionIntent, lease.intent).candidate_request_id
            )
            cursor.execute(
                "SELECT stored_candidate FROM face_quality_candidates "
                "WHERE face_quality_job_id=%s ORDER BY ordinal",
                (parent,),
            )
            return [StoredNativeFaceCandidate.model_validate(row[0]) for row in cursor.fetchall()]

    def checkpoint_candidate(
        self, lease: NativeFaceLease, ordinal: int, stored: StoredNativeFaceCandidate
    ) -> None:
        if lease.operation != "candidates" or stored.pixels.owner_scope != lease.owner_scope:
            raise ValueError("candidate checkpoint does not belong to this generation")
        candidate = stored.candidate
        if (
            not 0 <= ordinal < cast(FaceQualityCandidateRequest, lease.intent).candidate_count
            or (candidate.context.source_width, candidate.context.source_height)
            != (lease.source_width, lease.source_height)
            or (
                candidate.context.output_width,
                candidate.context.output_height,
                candidate.context.bit_depth,
            )
            != (lease.output_width, lease.output_height, lease.bit_depth)
            or candidate.context.source_sha256 != lease.source.sha256
            or candidate.context.base_output_sha256 != lease.base.sha256
            or (
                candidate.model_sha256 != lease.release.model_sha256
                or candidate.dependency_lock_sha256 != lease.release.dependency_lock_sha256
            )
        ):
            raise ValueError("candidate checkpoint is stale")
        digest = native_face_candidate_sha256(candidate)
        with self._transaction() as cursor:
            if self._require(cursor, lease)["state"] != "running":
                raise JobBusyError(lease.job_id)
            cursor.execute(
                "SELECT candidate_sha256 FROM face_quality_candidates "
                "WHERE face_quality_job_id=%s AND ordinal=%s",
                (lease.face_id, ordinal),
            )
            previous = cursor.fetchone()
            if previous:
                if previous[0] != digest:
                    raise ValueError("an immutable candidate checkpoint already exists")
                return
            cursor.execute(
                "INSERT INTO face_quality_candidates VALUES(%s,%s,%s,%s::jsonb,%s)",
                (lease.face_id, digest, ordinal, stored.model_dump_json(), utcnow()),
            )
            cursor.execute(
                """INSERT INTO job_checkpoints(job_id,attempt,checkpoint_key,payload,created_at)
                VALUES(%s,%s,%s,%s::jsonb,%s)""",
                (
                    lease.job_id,
                    lease.attempt,
                    f"face-candidate-{ordinal}",
                    stored.model_dump_json(),
                    utcnow(),
                ),
            )
            progress = (
                (ordinal + 1)
                * 90
                // cast(FaceQualityCandidateRequest, lease.intent).candidate_count
            )
            cursor.execute(
                "UPDATE processing_jobs SET progress_percent=GREATEST(progress_percent,%s),"
                "updated_at=%s WHERE job_id=%s",
                (progress, utcnow(), lease.job_id),
            )
            self._face_event(cursor, lease.job_id, lease.trace_id, "running", progress)

    def complete_face(self, lease: NativeFaceLease, output: NativeFaceOutput | None = None) -> None:
        if output is not None:
            output = NativeFaceOutput.model_validate_json(output.model_dump_json())
        with self._transaction() as cursor:
            if self._require(cursor, lease)["state"] != "running":
                raise JobBusyError(lease.job_id)
            if lease.operation == "candidates":
                cursor.execute(
                    "SELECT count(*) FROM face_quality_candidates WHERE face_quality_job_id=%s",
                    (lease.face_id,),
                )
                if (
                    output is not None
                    or cursor.fetchone()[0]
                    != cast(FaceQualityCandidateRequest, lease.intent).candidate_count
                ):
                    raise ValueError("candidate set is incomplete")
            else:
                if (
                    output is None
                    or output.object.owner_scope != lease.owner_scope
                    or (
                        (output.width, output.height, output.bit_depth)
                        != (lease.output_width, lease.output_height, lease.bit_depth)
                        or not output.object.object_key.startswith(
                            f"derivative/{lease.owner_scope}/"
                        )
                        or output.evidence.get("kind") != "explicit-face-recreate"
                        or output.evidence.get("candidate_sha256")
                        != cast(FaceQualityCompositionIntent, lease.intent).candidate_sha256
                    )
                ):
                    raise ValueError("face output does not belong to the exact reviewed candidate")
                cursor.execute(
                    "UPDATE face_quality_jobs SET output=%s::jsonb WHERE face_quality_job_id=%s",
                    (output.model_dump_json(), lease.face_id),
                )
            self._finish(cursor, lease.job_id, lease.trace_id, "succeeded", None)

    def yield_face(self, lease: NativeFaceLease) -> None:
        with self._transaction() as cursor:
            row = self._require(cursor, lease)
            if row["state"] == "cancel_requested":
                self._finish(cursor, lease.job_id, lease.trace_id, "cancelled", None)
                return
            cursor.execute(
                """UPDATE processing_jobs SET state='retry_wait',attempt=GREATEST(attempt-1,0),
                lease_token_hash=NULL,lease_owner=NULL,lease_expires_at=NULL,heartbeat_at=NULL,
                next_attempt_at=%s,updated_at=%s WHERE job_id=%s""",
                (utcnow(), utcnow(), lease.job_id),
            )
            self._dispatch(cursor, lease)
            self._face_event(
                cursor, lease.job_id, lease.trace_id, "retry_wait", int(row["progress_percent"])
            )

    def fail_face(
        self, lease: NativeFaceLease, *, code: str, retryable: bool, cancelled: bool = False
    ) -> str:
        with self._transaction() as cursor:
            row = self._require(cursor, lease)
            if cancelled or row["state"] == "cancel_requested":
                state = "cancelled"
            else:
                state = (
                    "retry_wait" if retryable and lease.attempt < lease.max_attempts else "failed"
                )
            self._finish(
                cursor,
                lease.job_id,
                lease.trace_id,
                state,
                None if state == "cancelled" else self._failure(code, retryable),
            )
            if state == "retry_wait":
                self._dispatch(cursor, lease)
            return state

    @staticmethod
    def _failure(code: str, retryable: bool) -> dict[str, object]:
        return {
            "code": code,
            "message": "Native face processing could not finish; "
            "your original and base remain unchanged.",
            "retryable": retryable,
        }

    def _finish(
        self, cursor: Any, job_id: str, trace_id: str, state: str, failure: dict[str, object] | None
    ) -> None:
        now = utcnow()
        cursor.execute(
            """UPDATE processing_jobs SET state=%s,failure=%s::jsonb,
            progress_percent=CASE WHEN %s='succeeded' THEN 100 ELSE progress_percent END,
            lease_owner=NULL,lease_token_hash=NULL,lease_expires_at=NULL,heartbeat_at=NULL,
            next_attempt_at=CASE WHEN %s='retry_wait' THEN %s::timestamptz ELSE NULL END,
            updated_at=%s WHERE job_id=%s""",
            (
                state,
                json.dumps(failure) if failure else None,
                state,
                state,
                now + timedelta(seconds=30),
                now,
                job_id,
            ),
        )
        self._face_event(cursor, job_id, trace_id, state, 100 if state == "succeeded" else 0)

    @staticmethod
    def _face_event(cursor: Any, job_id: str, trace_id: str, state: str, progress: int) -> None:
        cursor.execute(
            """INSERT INTO job_events(job_event_id,job_id,event_kind,state,progress_percent,
            occurred_at,trace_id)
            VALUES(%s,%s,%s,%s,%s,%s,%s)""",
            (
                f"event-{secrets.token_hex(16)}",
                job_id,
                f"job.{state}",
                state,
                progress,
                utcnow(),
                trace_id,
            ),
        )

    @staticmethod
    def _dispatch(cursor: Any, lease: NativeFaceLease) -> None:
        cursor.execute(
            """INSERT INTO job_outbox(outbox_id,job_id,dispatch_kind,payload,trace_id,
            available_at,created_at)
            SELECT %s,job_id,'process_job',%s::jsonb,%s,next_attempt_at,%s
            FROM processing_jobs WHERE job_id=%s""",
            (
                f"outbox-{secrets.token_hex(16)}",
                json.dumps({"job_id": lease.job_id}),
                lease.trace_id,
                utcnow(),
                lease.job_id,
            ),
        )
