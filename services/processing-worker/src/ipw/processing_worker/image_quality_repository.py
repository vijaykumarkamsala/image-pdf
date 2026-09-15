"""PostgreSQL lease/checkpoint repository for image-quality jobs."""

from __future__ import annotations

import hashlib
import json
import secrets
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timedelta
from typing import Any, Self, cast

from ipw.processing_worker.image_quality import LeasedImageQualityJob
from ipw.processing_worker.image_quality_model import RestoredImage
from ipw.processing_worker.repository import JobBusyError, PostgresWorkerRepository, utcnow


class PostgresImageQualityWorkerRepository(PostgresWorkerRepository):
    @classmethod
    def connect(cls, database_url: str) -> Self:
        return cast(Self, super().connect(database_url))

    def claim_image_quality(
        self,
        *,
        job_id: str,
        worker_id: str,
        lease_token: str,
        trace_id: str,
    ) -> LeasedImageQualityJob | None:
        now = utcnow()
        lease_expires = now + timedelta(seconds=90)
        token_hash = hashlib.sha256(lease_token.encode()).hexdigest()
        with self._quality_transaction() as cursor:
            cursor.execute("SELECT * FROM processing_jobs WHERE job_id=%s FOR UPDATE", (job_id,))
            job = cursor.fetchone()
            if not job or job["kind"] != "image_quality_restore":
                return None
            if job["state"] in {"succeeded", "failed", "cancelled"}:
                return None
            if (
                job["state"] in {"leased", "running", "cancel_requested"}
                and job["lease_expires_at"]
                and job["lease_expires_at"] > now
            ):
                raise JobBusyError(job_id)
            if job["state"] == "retry_wait" and job["next_attempt_at"] > now:
                raise JobBusyError(job_id)
            if int(job["attempt"]) >= int(job["max_attempts"]):
                self._terminal_failure(cursor, job_id, now, "image-quality-attempts-exhausted")
                return None
            cursor.execute(
                """UPDATE processing_jobs SET state='leased',attempt=attempt+1,lease_owner=%s,
                   lease_token_hash=%s,lease_expires_at=%s,heartbeat_at=%s,next_attempt_at=NULL,
                   trace_id=%s,updated_at=%s WHERE job_id=%s RETURNING *""",
                (worker_id, token_hash, lease_expires, now, trace_id, now, job_id),
            )
            leased = cursor.fetchone()
            cursor.execute(
                "SELECT * FROM image_quality_requests WHERE image_quality_request_id=%s FOR UPDATE",
                (leased["image_quality_request_id"],),
            )
            request = cursor.fetchone()
            if not request:
                raise ValueError("image quality request is unavailable")
            return LeasedImageQualityJob(
                job_id=job_id,
                request_id=str(request["image_quality_request_id"]),
                owner_scope=str(request["owner_scope"]),
                source_version_id=str(request["source_version_id"]),
                source_object_key=str(request["source_object_key"]),
                source_storage_generation=str(request["source_storage_generation"]),
                source_sha256=str(request["source_sha256"]),
                source_media_type=str(request["source_media_type"]),
                source_byte_size=int(request["source_byte_size"]),
                source_width=int(request["source_width"]),
                source_height=int(request["source_height"]),
                source_frame_count=int(request["source_frame_count"]),
                source_bit_depth=int(request["source_bit_depth"]),
                source_has_icc_profile=bool(request["source_has_icc_profile"]),
                source_colour_primaries=(
                    str(request["source_colour_primaries"])
                    if request["source_colour_primaries"]
                    else None
                ),
                source_dynamic_range=(
                    str(request["source_dynamic_range"])
                    if request["source_dynamic_range"]
                    else None
                ),
                content_class=str(request["content_class"]),
                strength=int(request["strength"]),
                lease_token_hash=token_hash,
                trace_id=trace_id,
                attempt=int(leased["attempt"]),
                max_attempts=int(leased["max_attempts"]),
            )

    def start_image_quality(self, lease: LeasedImageQualityJob) -> None:
        now = utcnow()
        with self._quality_transaction() as cursor:
            self._require_lease(cursor, lease)
            cursor.execute(
                """UPDATE processing_jobs SET state='running',progress_percent=5,updated_at=%s
                   WHERE job_id=%s""",
                (now, lease.job_id),
            )
            cursor.execute(
                """UPDATE image_quality_requests
                   SET state='running',progress_percent=5,updated_at=%s
                   WHERE image_quality_request_id=%s""",
                (now, lease.request_id),
            )
            self._quality_event(cursor, lease, "job.running", "running", 5, now)

    def heartbeat_image_quality(self, lease: LeasedImageQualityJob) -> None:
        now = utcnow()
        expires = now + timedelta(seconds=90)
        with self._quality_transaction() as cursor:
            cursor.execute(
                """UPDATE processing_jobs SET heartbeat_at=%s,lease_expires_at=%s,updated_at=%s
                   WHERE job_id=%s AND lease_token_hash=%s""",
                (now, expires, now, lease.job_id, lease.lease_token_hash),
            )
            if cursor.rowcount != 1:
                raise JobBusyError(lease.job_id)

    def cancellation_requested_image_quality(self, lease: LeasedImageQualityJob) -> bool:
        with self._quality_transaction() as cursor:
            cursor.execute(
                "SELECT state FROM processing_jobs WHERE job_id=%s AND lease_token_hash=%s",
                (lease.job_id, lease.lease_token_hash),
            )
            row = cursor.fetchone()
            if not row:
                raise JobBusyError(lease.job_id)
            return bool(row["state"] == "cancel_requested")

    def checkpoint_image_quality(
        self,
        lease: LeasedImageQualityJob,
        key: str,
        payload: dict[str, Any],
        progress_percent: int,
    ) -> None:
        now = utcnow()
        with self._quality_transaction() as cursor:
            self._require_lease(cursor, lease)
            cursor.execute(
                """INSERT INTO job_checkpoints(job_id,attempt,checkpoint_key,payload,created_at)
                   VALUES(%s,%s,%s,%s::jsonb,%s) ON CONFLICT DO NOTHING""",
                (lease.job_id, lease.attempt, key, json.dumps(payload), now),
            )
            cursor.execute(
                """UPDATE processing_jobs SET progress_percent=GREATEST(progress_percent,%s),
                   updated_at=%s WHERE job_id=%s""",
                (progress_percent, now, lease.job_id),
            )
            cursor.execute(
                """UPDATE image_quality_requests SET progress_percent=GREATEST(progress_percent,%s),
                   updated_at=%s WHERE image_quality_request_id=%s""",
                (progress_percent, now, lease.request_id),
            )

    def restored_tiles_image_quality(
        self, lease: LeasedImageQualityJob
    ) -> dict[str, dict[str, Any]]:
        with self._quality_transaction() as cursor:
            self._require_lease(cursor, lease)
            cursor.execute(
                """SELECT DISTINCT ON (checkpoint_key) checkpoint_key,payload
                   FROM job_checkpoints WHERE job_id=%s
                     AND checkpoint_key LIKE 'restore-tile-%%'
                   ORDER BY checkpoint_key,attempt DESC,created_at DESC""",
                (lease.job_id,),
            )
            return {
                str(row["checkpoint_key"]).removeprefix("restore-tile-"): dict(
                    row["payload"]
                )
                for row in cursor.fetchall()
            }

    def yield_image_quality(self, lease: LeasedImageQualityJob) -> None:
        now = utcnow()
        with self._quality_transaction() as cursor:
            self._require_lease(cursor, lease)
            cursor.execute(
                """UPDATE processing_jobs SET state='queued',attempt=GREATEST(attempt-1,0),
                   lease_owner=NULL,lease_token_hash=NULL,lease_expires_at=NULL,heartbeat_at=NULL,
                   updated_at=%s WHERE job_id=%s""",
                (now, lease.job_id),
            )
            cursor.execute(
                """UPDATE image_quality_requests SET state='queued',updated_at=%s
                   WHERE image_quality_request_id=%s""",
                (now, lease.request_id),
            )
            cursor.execute(
                """INSERT INTO job_outbox(outbox_id,job_id,dispatch_kind,payload,trace_id,
                   available_at,created_at) VALUES(%s,%s,'process_job',%s::jsonb,%s,%s,%s)""",
                (
                    f"outbox-{secrets.token_hex(16)}",
                    lease.job_id,
                    json.dumps({"job_id": lease.job_id}),
                    lease.trace_id,
                    now,
                    now,
                ),
            )
            self._quality_event(cursor, lease, "job.slice-yielded", "queued", 10, now)

    def complete_image_quality(
        self,
        lease: LeasedImageQualityJob,
        *,
        object_key: str,
        storage_generation: str,
        result: RestoredImage,
    ) -> None:
        now = utcnow()
        with self._quality_transaction() as cursor:
            self._require_lease(cursor, lease)
            cursor.execute(
                """UPDATE image_quality_requests SET state='succeeded',progress_percent=100,
                   output_object_key=%s,output_storage_generation=%s,output_sha256=%s,
                   output_media_type=%s,output_byte_size=%s,output_width=%s,output_height=%s,
                   output_frame_count=%s,output_bit_depth=%s,output_has_icc_profile=%s,
                   output_colour_policy=%s,output_colour_primaries=%s,output_dynamic_range=%s,
                   model_id=%s,model_version=%s,model_sha256=%s,model_usage=%s,
                   deterministic=%s,processor_name=%s,
                   processor_version=%s,output_fidelity=%s::jsonb,failure=NULL,updated_at=%s
                   WHERE image_quality_request_id=%s""",
                (
                    object_key,
                    storage_generation,
                    result.sha256,
                    result.media_type,
                    result.byte_size,
                    result.width,
                    result.height,
                    result.frame_count,
                    result.bit_depth,
                    result.has_icc_profile,
                    result.colour_policy,
                    result.colour_primaries,
                    result.dynamic_range,
                    result.model_id,
                    result.model_version,
                    result.model_sha256,
                    result.model_usage,
                    result.deterministic,
                    result.processor_name,
                    result.processor_version,
                    json.dumps(
                        {
                            "low_texture_mean_rgb_shift": (
                                result.fidelity.low_texture_mean_rgb_shift
                            ),
                            "high_drift_fraction": result.fidelity.high_drift_fraction,
                            "alpha_mismatch_fraction": result.fidelity.alpha_mismatch_fraction,
                            "overall_mean_rgb_difference": (
                                result.fidelity.overall_mean_rgb_difference
                            ),
                            "passed": result.fidelity.passed,
                        }
                    ),
                    now,
                    lease.request_id,
                ),
            )
            cursor.execute(
                """INSERT INTO image_quality_provenance(
                   image_quality_request_id,source_version_id,source_sha256,output_sha256,
                   model_id,model_version,model_sha256,model_usage,deterministic,
                   processor_name,processor_version,parameters,colour_policy,trace_id,job_id,created_at)
                   VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s,%s,%s)
                   ON CONFLICT DO NOTHING""",
                (
                    lease.request_id,
                    lease.source_version_id,
                    result.source_sha256,
                    result.sha256,
                    result.model_id,
                    result.model_version,
                    result.model_sha256,
                    result.model_usage,
                    result.deterministic,
                    result.processor_name,
                    result.processor_version,
                    json.dumps({"strength": result.strength, "tile_count": result.tile_count}),
                    result.colour_policy,
                    lease.trace_id,
                    lease.job_id,
                    now,
                ),
            )
            cursor.execute(
                """UPDATE processing_jobs SET state='succeeded',progress_percent=100,failure=NULL,
                   lease_owner=NULL,lease_token_hash=NULL,lease_expires_at=NULL,heartbeat_at=NULL,
                   updated_at=%s WHERE job_id=%s""",
                (now, lease.job_id),
            )
            self._quality_event(cursor, lease, "job.succeeded", "succeeded", 100, now)

    def fail_image_quality(
        self,
        lease: LeasedImageQualityJob,
        *,
        code: str,
        message: str,
        retryable: bool,
    ) -> str:
        now = utcnow()
        cancelled = code == "image-quality-cancelled"
        can_retry = retryable and lease.attempt < lease.max_attempts and not cancelled
        state = "retry_wait" if can_retry else "cancelled" if cancelled else "failed"
        retry_at = now + timedelta(seconds=min(300, 30 * lease.attempt)) if can_retry else None
        failure = {"code": code, "message": message[:500], "retryable": can_retry}
        with self._quality_transaction() as cursor:
            self._require_lease(cursor, lease)
            cursor.execute(
                """UPDATE processing_jobs SET state=%s,progress_percent=CASE WHEN %s='retry_wait'
                   THEN progress_percent ELSE 100 END,failure=%s::jsonb,next_attempt_at=%s,
                   lease_owner=NULL,lease_token_hash=NULL,lease_expires_at=NULL,heartbeat_at=NULL,
                   updated_at=%s WHERE job_id=%s""",
                (state, state, json.dumps(failure), retry_at, now, lease.job_id),
            )
            cursor.execute(
                """UPDATE image_quality_requests SET state=%s,
                   progress_percent=CASE WHEN %s='retry_wait' THEN progress_percent ELSE 100 END,
                   failure=%s::jsonb,updated_at=%s WHERE image_quality_request_id=%s""",
                (state, state, json.dumps(failure), now, lease.request_id),
            )
            self._quality_event(
                cursor,
                lease,
                f"job.{state}",
                state,
                100 if not can_retry else 5,
                now,
            )
        return state

    @contextmanager
    def _quality_transaction(self) -> Iterator[Any]:
        cursor = self._connection.cursor()
        try:
            yield cursor
            self._connection.commit()
        except Exception:
            self._connection.rollback()
            raise
        finally:
            cursor.close()

    def _require_lease(self, cursor: Any, lease: LeasedImageQualityJob) -> None:
        cursor.execute(
            """SELECT 1 FROM processing_jobs WHERE job_id=%s AND lease_token_hash=%s
               AND state IN ('leased','running','cancel_requested') FOR UPDATE""",
            (lease.job_id, lease.lease_token_hash),
        )
        if not cursor.fetchone():
            raise JobBusyError(lease.job_id)

    @staticmethod
    def _quality_event(
        cursor: Any,
        lease: LeasedImageQualityJob,
        kind: str,
        state: str,
        progress: int,
        now: datetime,
    ) -> None:
        cursor.execute(
            """INSERT INTO job_events(job_event_id,job_id,event_kind,state,progress_percent,
               occurred_at,trace_id) VALUES(%s,%s,%s,%s,%s,%s,%s)""",
            (
                f"event-{secrets.token_hex(16)}",
                lease.job_id,
                kind,
                state,
                progress,
                now,
                lease.trace_id,
            ),
        )

    @staticmethod
    def _terminal_failure(cursor: Any, job_id: str, now: datetime, code: str) -> None:
        failure = json.dumps(
            {
                "code": code,
                "message": "Image enhancement attempts were exhausted",
                "retryable": False,
            }
        )
        cursor.execute(
            """UPDATE processing_jobs SET state='failed',failure=%s::jsonb,updated_at=%s
               WHERE job_id=%s""",
            (failure, now, job_id),
        )
        cursor.execute(
            """UPDATE image_quality_requests SET state='failed',failure=%s::jsonb,updated_at=%s
               WHERE job_id=%s""",
            (failure, now, job_id),
        )
