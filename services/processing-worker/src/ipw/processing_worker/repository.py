"""PostgreSQL authority for Recovery 2B intake workers."""

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol, cast
from urllib.parse import unquote, urlparse

import pg8000.dbapi


class DatabaseConnection(Protocol):
    def cursor(self) -> Any: ...
    def commit(self) -> None: ...
    def rollback(self) -> None: ...
    def close(self) -> None: ...


class JobBusyError(RuntimeError):
    """A valid unexpired lease already owns this job."""


@dataclass(frozen=True)
class LeasedIntakeJob:
    job_id: str
    upload_session_id: str
    trace_id: str
    attempt: int
    max_attempts: int
    lease_token_hash: str
    owner_kind: str
    owner_scope: str
    workspace_id: str | None
    actor_id: str | None
    display_name: str
    expected_media_type: str
    expected_byte_size: int
    expected_sha256: str | None
    object_key: str
    object_generation: str
    constraints: dict[str, Any]


def utcnow() -> datetime:
    return datetime.now(UTC)


def _id(prefix: str, job_id: str) -> str:
    return f"{prefix}-{uuid.uuid5(uuid.NAMESPACE_URL, f'ipw:{prefix}:{job_id}')}"


class PostgresWorkerRepository:
    def __init__(self, connection: DatabaseConnection) -> None:
        self._connection = connection

    @classmethod
    def connect(cls, database_url: str) -> PostgresWorkerRepository:
        parsed = urlparse(database_url)
        if parsed.scheme not in {"postgres", "postgresql"} or not parsed.hostname:
            raise ValueError("IPW_DATABASE_URL must be a PostgreSQL URL")
        connection = pg8000.dbapi.connect(
            user=unquote(parsed.username or ""),
            password=unquote(parsed.password or ""),
            host=parsed.hostname,
            port=parsed.port or 5432,
            database=unquote(parsed.path.lstrip("/")),
            timeout=30,
        )
        return cls(cast(DatabaseConnection, connection))

    def claim(
        self,
        *,
        job_id: str,
        worker_id: str,
        lease_token: str,
        trace_id: str,
        now: datetime | None = None,
        lease_seconds: int = 90,
    ) -> LeasedIntakeJob | None:
        instant = now or utcnow()
        token_hash = hashlib.sha256(lease_token.encode()).hexdigest()
        cursor = self._connection.cursor()
        try:
            cursor.execute("BEGIN")
            cursor.execute(
                """SELECT job.*, upload.display_name, upload.expected_media_type,
                          upload.expected_byte_size, upload.expected_sha256,
                          upload.quarantine_object_key, upload.provider_generation,
                          upload.constraints
                   FROM processing_jobs job
                   JOIN upload_sessions upload USING(upload_session_id)
                   WHERE job.job_id=%s FOR UPDATE""",
                (job_id,),
            )
            row = self._one(cursor)
            if row is None:
                self._connection.rollback()
                raise LookupError("job was not found")
            state = str(row["state"])
            if state in {"succeeded", "failed", "cancelled"}:
                self._connection.commit()
                return None
            if state == "cancel_requested":
                self._cancel_locked(cursor, row, instant, trace_id)
                self._connection.commit()
                return None
            lease_expiry = row["lease_expires_at"]
            eligible = (
                state == "queued"
                or (
                    state == "retry_wait"
                    and (row["next_attempt_at"] is None or row["next_attempt_at"] <= instant)
                )
                or (
                    state in {"leased", "running"}
                    and lease_expiry is not None
                    and lease_expiry <= instant
                )
            )
            if not eligible:
                self._connection.commit()
                raise JobBusyError("job is not eligible for a new lease")
            if int(row["attempt"]) >= int(row["max_attempts"]):
                cursor.execute(
                    "UPDATE processing_jobs SET state='failed',updated_at=%s WHERE job_id=%s",
                    (instant, job_id),
                )
                self._connection.commit()
                return None
            expires = instant + timedelta(seconds=lease_seconds)
            cursor.execute(
                """UPDATE processing_jobs SET state='leased',attempt=attempt+1,lease_owner=%s,
                          lease_token_hash=%s,lease_expires_at=%s,heartbeat_at=%s,
                          next_attempt_at=NULL,updated_at=%s
                   WHERE job_id=%s RETURNING attempt,max_attempts""",
                (worker_id, token_hash, expires, instant, instant, job_id),
            )
            attempt, max_attempts = cursor.fetchone()
            self._event(cursor, job_id, "job.leased", "leased", 0, instant, trace_id)
            if int(attempt) > 1:
                self._audit_row(
                    cursor,
                    row,
                    "job.retry-performed",
                    "processing_job",
                    job_id,
                    instant,
                    trace_id,
                )
            self._connection.commit()
            owner_kind = str(row["owner_kind"])
            workspace_id = str(row["workspace_id"]) if row["workspace_id"] else None
            actor_id = str(row["actor_id"]) if row["actor_id"] else None
            guest_id = str(row["guest_session_id"]) if row["guest_session_id"] else None
            generation = str(row["provider_generation"] or "")
            if not generation:
                raise RuntimeError("reconciled provider generation is required before dispatch")
            return LeasedIntakeJob(
                job_id=job_id,
                upload_session_id=str(row["upload_session_id"]),
                trace_id=trace_id,
                attempt=int(attempt),
                max_attempts=int(max_attempts),
                lease_token_hash=token_hash,
                owner_kind=owner_kind,
                owner_scope=(workspace_id or "") if owner_kind == "actor" else (guest_id or ""),
                workspace_id=workspace_id,
                actor_id=actor_id,
                display_name=str(row["display_name"]),
                expected_media_type=str(row["expected_media_type"]),
                expected_byte_size=int(row["expected_byte_size"]),
                expected_sha256=str(row["expected_sha256"]) if row["expected_sha256"] else None,
                object_key=str(row["quarantine_object_key"]),
                object_generation=generation,
                constraints=dict(row["constraints"]),
            )
        except Exception:
            self._connection.rollback()
            raise
        finally:
            cursor.close()

    def start(self, lease: LeasedIntakeJob, now: datetime | None = None) -> None:
        instant = now or utcnow()
        cursor = self._connection.cursor()
        try:
            cursor.execute("BEGIN")
            cursor.execute(
                """UPDATE processing_jobs SET state='running',progress_percent=10,updated_at=%s
                   WHERE job_id=%s AND lease_token_hash=%s AND state='leased'""",
                (instant, lease.job_id, lease.lease_token_hash),
            )
            if cursor.rowcount != 1:
                raise JobBusyError("job lease changed before start")
            cursor.execute(
                """UPDATE upload_sessions SET state='inspecting',updated_at=%s
                   WHERE upload_session_id=%s AND state='finalising'""",
                (instant, lease.upload_session_id),
            )
            self._event(
                cursor, lease.job_id, "inspection.started", "running", 10, instant, lease.trace_id
            )
            self._audit(
                cursor,
                lease,
                "inspection.started",
                "upload_session",
                lease.upload_session_id,
                instant,
            )
            self._connection.commit()
        except Exception:
            self._connection.rollback()
            raise
        finally:
            cursor.close()

    def heartbeat(self, lease: LeasedIntakeJob, now: datetime | None = None) -> None:
        instant = now or utcnow()
        cursor = self._connection.cursor()
        cursor.execute(
            """UPDATE processing_jobs SET heartbeat_at=%s,lease_expires_at=%s,updated_at=%s
               WHERE job_id=%s AND lease_token_hash=%s
                 AND state IN ('leased','running','cancel_requested')""",
            (
                instant,
                instant + timedelta(seconds=90),
                instant,
                lease.job_id,
                lease.lease_token_hash,
            ),
        )
        if cursor.rowcount != 1:
            self._connection.rollback()
            raise JobBusyError("job heartbeat lost its lease")
        self._connection.commit()
        cursor.close()

    def cancellation_requested(self, lease: LeasedIntakeJob) -> bool:
        cursor = self._connection.cursor()
        cursor.execute("SELECT state FROM processing_jobs WHERE job_id=%s", (lease.job_id,))
        row = cursor.fetchone()
        cursor.close()
        return row is None or row[0] in {"cancel_requested", "cancelled"}

    def latest_checkpoint(self, lease: LeasedIntakeJob) -> tuple[str, dict[str, Any]] | None:
        cursor = self._connection.cursor()
        cursor.execute(
            """SELECT checkpoint_key,payload FROM job_checkpoints
               WHERE job_id=%s ORDER BY attempt DESC,created_at DESC LIMIT 1""",
            (lease.job_id,),
        )
        row = cursor.fetchone()
        cursor.close()
        return (str(row[0]), dict(row[1])) if row else None

    def checkpoint(
        self, lease: LeasedIntakeJob, key: str, payload: dict[str, Any], now: datetime | None = None
    ) -> None:
        instant = now or utcnow()
        cursor = self._connection.cursor()
        cursor.execute(
            """INSERT INTO job_checkpoints(job_id,attempt,checkpoint_key,payload,created_at)
               SELECT job_id,attempt,%s,%s::jsonb,%s FROM processing_jobs
               WHERE job_id=%s AND lease_token_hash=%s AND state IN ('running','cancel_requested')
               ON CONFLICT(job_id,attempt,checkpoint_key)
               DO UPDATE SET payload=EXCLUDED.payload,created_at=EXCLUDED.created_at""",
            (key, json.dumps(payload), instant, lease.job_id, lease.lease_token_hash),
        )
        if cursor.rowcount != 1:
            self._connection.rollback()
            raise JobBusyError("checkpoint lost its job lease")
        cursor.execute(
            "UPDATE processing_jobs SET progress_percent=GREATEST(progress_percent,60),updated_at=%s WHERE job_id=%s",
            (instant, lease.job_id),
        )
        self._connection.commit()
        cursor.close()

    def complete_accepted(
        self,
        lease: LeasedIntakeJob,
        *,
        immutable_object_key: str,
        facts: dict[str, Any],
        now: datetime | None = None,
    ) -> None:
        instant = now or utcnow()
        object_id = _id("object", lease.job_id)
        asset_id = _id("asset", lease.job_id)
        source_id = _id("source", lease.job_id)
        file_id = _id("file", lease.job_id) if lease.owner_kind == "actor" else None
        cursor = self._connection.cursor()
        try:
            cursor.execute("BEGIN")
            self._lock_running(cursor, lease)
            if lease.owner_kind == "actor":
                assert lease.workspace_id
                assert lease.actor_id
                assert file_id
                cursor.execute(
                    """INSERT INTO object_references(object_reference_id,workspace_id,object_key,sha256,media_type,byte_size,created_at)
                       VALUES (%s,%s,%s,%s,%s,%s,%s)
                       ON CONFLICT(workspace_id,object_key) DO NOTHING""",
                    (
                        object_id,
                        lease.workspace_id,
                        immutable_object_key,
                        facts["sha256"],
                        facts["detected_media_type"],
                        facts["byte_size"],
                        instant,
                    ),
                )
                cursor.execute(
                    "SELECT object_reference_id,sha256,byte_size FROM object_references WHERE workspace_id=%s AND object_key=%s",
                    (lease.workspace_id, immutable_object_key),
                )
                object_id, existing_sha, existing_size = cursor.fetchone()
                if existing_sha != facts["sha256"] or int(existing_size) != int(facts["byte_size"]):
                    raise RuntimeError("immutable object identity conflict")
                cursor.execute(
                    """INSERT INTO asset_originals(asset_original_id,workspace_id,object_reference_id,original_filename,created_at)
                       VALUES (%s,%s,%s,%s,%s)""",
                    (asset_id, lease.workspace_id, object_id, lease.display_name, instant),
                )
                cursor.execute(
                    """INSERT INTO source_versions(source_version_id,workspace_id,asset_original_id,object_reference_id,sequence,created_at)
                       VALUES (%s,%s,%s,%s,1,%s)""",
                    (source_id, lease.workspace_id, asset_id, object_id, instant),
                )
                cursor.execute(
                    "SELECT default_files_id FROM default_files_locations WHERE workspace_id=%s",
                    (lease.workspace_id,),
                )
                default_files_id = cursor.fetchone()[0]
                cursor.execute(
                    """INSERT INTO workspace_files(file_id,workspace_id,asset_original_id,current_source_version_id,
                         display_name,canonical_location_kind,default_files_id,created_at,updated_at)
                       VALUES (%s,%s,%s,%s,%s,'default_files',%s,%s,%s)""",
                    (
                        file_id,
                        lease.workspace_id,
                        asset_id,
                        source_id,
                        lease.display_name,
                        default_files_id,
                        instant,
                        instant,
                    ),
                )
            cursor.execute(
                """UPDATE upload_sessions SET state='ready',immutable_object_key=%s,asset_original_id=%s,
                     source_version_id=%s,file_id=%s,source_facts=%s::jsonb,verified_sha256=%s,updated_at=%s
                   WHERE upload_session_id=%s AND state='inspecting'""",
                (
                    immutable_object_key,
                    asset_id,
                    source_id,
                    file_id,
                    json.dumps(facts),
                    facts["sha256"],
                    instant,
                    lease.upload_session_id,
                ),
            )
            if cursor.rowcount != 1:
                raise JobBusyError("upload state changed before acceptance")
            cursor.execute(
                """UPDATE processing_jobs SET state='succeeded',progress_percent=100,lease_owner=NULL,
                     lease_token_hash=NULL,lease_expires_at=NULL,updated_at=%s
                   WHERE job_id=%s AND lease_token_hash=%s AND state='running'""",
                (instant, lease.job_id, lease.lease_token_hash),
            )
            if cursor.rowcount != 1:
                raise JobBusyError("job state changed before acceptance")
            self._event(
                cursor,
                lease.job_id,
                "inspection.completed",
                "succeeded",
                100,
                instant,
                lease.trace_id,
            )
            self._event(
                cursor, lease.job_id, "source.promoted", "succeeded", 100, instant, lease.trace_id
            )
            self._audit(
                cursor,
                lease,
                "inspection.completed",
                "upload_session",
                lease.upload_session_id,
                instant,
            )
            self._audit(cursor, lease, "source.promoted", "asset_original", asset_id, instant)
            if lease.owner_kind == "actor" and lease.workspace_id and lease.actor_id:
                usage_id = f"usage-{uuid.uuid4()}"
                cursor.execute(
                    """INSERT INTO usage_events(usage_event_id,workspace_id,actor_id,event_kind,
                         customer_amount,credit_debit,currency,occurred_at)
                       VALUES (%s,%s,%s,'file.intake-ready',0,0,'USD',%s)""",
                    (usage_id, lease.workspace_id, lease.actor_id, instant),
                )
                cursor.execute(
                    """INSERT INTO usage_admin_dimensions(usage_event_id,dimensions)
                       VALUES (%s,%s::jsonb)""",
                    (
                        usage_id,
                        json.dumps(
                            {
                                "resource_kind": "file",
                                "operation": "secure_intake",
                                "storage_bytes": str(facts["byte_size"]),
                                "high_cost_processing": "false",
                            }
                        ),
                    ),
                )
            self._connection.commit()
        except Exception:
            self._connection.rollback()
            raise
        finally:
            cursor.close()

    def complete_rejected(
        self,
        lease: LeasedIntakeJob,
        *,
        code: str,
        message: str,
        now: datetime | None = None,
    ) -> None:
        instant = now or utcnow()
        failure = {"schema_version": "1.10.0", "code": code, "message": message, "retryable": False}
        cursor = self._connection.cursor()
        try:
            cursor.execute("BEGIN")
            self._lock_running(cursor, lease)
            cursor.execute(
                """UPDATE upload_sessions SET state='rejected',failure=%s::jsonb,updated_at=%s
                   WHERE upload_session_id=%s AND state='inspecting'""",
                (json.dumps(failure), instant, lease.upload_session_id),
            )
            cursor.execute(
                """UPDATE processing_jobs SET state='succeeded',progress_percent=100,lease_owner=NULL,
                     lease_token_hash=NULL,lease_expires_at=NULL,updated_at=%s
                   WHERE job_id=%s AND lease_token_hash=%s AND state='running'""",
                (instant, lease.job_id, lease.lease_token_hash),
            )
            if cursor.rowcount != 1:
                raise JobBusyError("job state changed before rejection")
            self._event(
                cursor,
                lease.job_id,
                "inspection.rejected",
                "succeeded",
                100,
                instant,
                lease.trace_id,
            )
            self._audit(
                cursor,
                lease,
                f"inspection.rejected.{code}",
                "upload_session",
                lease.upload_session_id,
                instant,
            )
            self._connection.commit()
        except Exception:
            self._connection.rollback()
            raise
        finally:
            cursor.close()

    def fail_or_cancel(
        self,
        lease: LeasedIntakeJob,
        *,
        code: str,
        message: str,
        retryable: bool,
        now: datetime | None = None,
    ) -> str:
        instant = now or utcnow()
        cursor = self._connection.cursor()
        try:
            cursor.execute("BEGIN")
            cursor.execute(
                "SELECT * FROM processing_jobs WHERE job_id=%s AND lease_token_hash=%s FOR UPDATE",
                (lease.job_id, lease.lease_token_hash),
            )
            row = self._one(cursor)
            if row is None:
                raise JobBusyError("job lease is no longer valid")
            if row["state"] == "cancel_requested":
                self._cancel_locked(cursor, row, instant, lease.trace_id)
                self._connection.commit()
                return "cancelled"
            will_retry = retryable and int(row["attempt"]) < int(row["max_attempts"])
            state = "retry_wait" if will_retry else "failed"
            retry_at = (
                instant + timedelta(seconds=min(300, 2 ** int(row["attempt"])))
                if will_retry
                else None
            )
            failure = {
                "schema_version": "1.10.0",
                "code": code,
                "message": message,
                "retryable": retryable,
            }
            cursor.execute(
                """UPDATE processing_jobs SET state=%s,failure=%s::jsonb,next_attempt_at=%s,
                     lease_owner=NULL,lease_token_hash=NULL,lease_expires_at=NULL,updated_at=%s
                   WHERE job_id=%s""",
                (state, json.dumps(failure), retry_at, instant, lease.job_id),
            )
            self._event(
                cursor,
                lease.job_id,
                "job.retry-scheduled" if will_retry else "job.failed",
                state,
                60,
                instant,
                lease.trace_id,
            )
            if will_retry:
                self._audit(
                    cursor,
                    lease,
                    "job.retry-requested",
                    "processing_job",
                    lease.job_id,
                    instant,
                )
                cursor.execute(
                    """INSERT INTO job_outbox(outbox_id,job_id,dispatch_kind,payload,trace_id,available_at,created_at)
                       VALUES (%s,%s,'process_job',%s::jsonb,%s,%s,%s)""",
                    (
                        f"outbox-{uuid.uuid4()}",
                        lease.job_id,
                        json.dumps({"job_id": lease.job_id}),
                        lease.trace_id,
                        retry_at,
                        instant,
                    ),
                )
            else:
                cursor.execute(
                    """UPDATE upload_sessions SET state='rejected',failure=%s::jsonb,updated_at=%s
                       WHERE upload_session_id=%s AND state='inspecting'""",
                    (json.dumps(failure), instant, lease.upload_session_id),
                )
                self._audit(
                    cursor,
                    lease,
                    f"inspection.rejected.{code}",
                    "upload_session",
                    lease.upload_session_id,
                    instant,
                )
            self._connection.commit()
            return state
        except Exception:
            self._connection.rollback()
            raise
        finally:
            cursor.close()

    def close(self) -> None:
        self._connection.close()

    def _lock_running(self, cursor: Any, lease: LeasedIntakeJob) -> None:
        cursor.execute(
            "SELECT state FROM processing_jobs WHERE job_id=%s AND lease_token_hash=%s FOR UPDATE",
            (lease.job_id, lease.lease_token_hash),
        )
        row = cursor.fetchone()
        if row is None or row[0] != "running":
            raise JobBusyError("job is no longer running")

    def _cancel_locked(
        self, cursor: Any, row: dict[str, Any], instant: datetime, trace_id: str
    ) -> None:
        cursor.execute(
            """UPDATE processing_jobs SET state='cancelled',failure=NULL,lease_owner=NULL,
                 lease_token_hash=NULL,lease_expires_at=NULL,updated_at=%s WHERE job_id=%s""",
            (instant, row["job_id"]),
        )
        cursor.execute(
            """UPDATE upload_sessions SET state='cancelled',updated_at=%s
               WHERE upload_session_id=%s AND state IN ('finalising','inspecting')""",
            (instant, row["upload_session_id"]),
        )
        self._event(cursor, str(row["job_id"]), "job.cancelled", "cancelled", 0, instant, trace_id)
        self._audit_row(
            cursor,
            row,
            "job.cancelled",
            "processing_job",
            str(row["job_id"]),
            instant,
            trace_id,
        )

    def _event(
        self,
        cursor: Any,
        job_id: str,
        kind: str,
        state: str,
        progress: int,
        instant: datetime,
        trace_id: str,
    ) -> None:
        cursor.execute(
            """INSERT INTO job_events(job_event_id,job_id,event_kind,state,progress_percent,occurred_at,trace_id)
               VALUES (%s,%s,%s,%s,%s,%s,%s)""",
            (f"event-{uuid.uuid4()}", job_id, kind, state, progress, instant, trace_id),
        )

    def _audit(
        self,
        cursor: Any,
        lease: LeasedIntakeJob,
        action: str,
        resource_kind: str,
        resource_id: str,
        instant: datetime,
    ) -> None:
        if lease.owner_kind != "actor" or not lease.workspace_id or not lease.actor_id:
            return
        cursor.execute(
            """INSERT INTO audit_events(audit_event_id,workspace_id,actor_id,action,resource_kind,resource_id,occurred_at,trace_id)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
            (
                f"audit-{uuid.uuid4()}",
                lease.workspace_id,
                lease.actor_id,
                action,
                resource_kind,
                resource_id,
                instant,
                lease.trace_id,
            ),
        )

    def _audit_row(
        self,
        cursor: Any,
        row: dict[str, Any],
        action: str,
        resource_kind: str,
        resource_id: str,
        instant: datetime,
        trace_id: str,
    ) -> None:
        if row["owner_kind"] != "actor" or not row["workspace_id"] or not row["actor_id"]:
            return
        cursor.execute(
            """INSERT INTO audit_events(audit_event_id,workspace_id,actor_id,action,resource_kind,resource_id,occurred_at,trace_id)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
            (
                f"audit-{uuid.uuid4()}",
                row["workspace_id"],
                row["actor_id"],
                action,
                resource_kind,
                resource_id,
                instant,
                trace_id,
            ),
        )

    @staticmethod
    def _one(cursor: Any) -> dict[str, Any] | None:
        row = cursor.fetchone()
        if row is None:
            return None
        return {
            description[0]: value
            for description, value in zip(cursor.description, row, strict=True)
        }
