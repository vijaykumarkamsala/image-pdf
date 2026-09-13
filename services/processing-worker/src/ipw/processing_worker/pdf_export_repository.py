"""PostgreSQL authority for durable native Screen PDF exports."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta
from typing import Any

from ipw.processing_worker.export_repository import (
    PostgresImageExportWorkerRepository,
    deterministic_id,
)
from ipw.processing_worker.pdf_export import LeasedPdfExportJob, StoredPdfExport
from ipw.processing_worker.repository import JobBusyError, utcnow

SCHEMA_VERSION = "1.21.0"


class PostgresPdfExportWorkerRepository(PostgresImageExportWorkerRepository):
    def claim_pdf_export(
        self,
        *,
        job_id: str,
        worker_id: str,
        lease_token: str,
        trace_id: str,
        now: datetime | None = None,
        lease_seconds: int = 90,
    ) -> LeasedPdfExportJob | None:
        instant = now or utcnow()
        token_hash = hashlib.sha256(lease_token.encode()).hexdigest()
        cursor = self._connection.cursor()
        try:
            cursor.execute("BEGIN")
            cursor.execute(
                """SELECT job.*,request.pdf_export_request_id,request.document_id,
                          request.document_version_id,request.snapshot_sha256,request.profile,
                          request.preflight,request.state AS request_state,
                          document.name AS document_name,
                          version.snapshot_sha256 AS version_snapshot_sha256,version.snapshot
                   FROM processing_jobs job
                   JOIN pdf_export_requests request
                     ON request.workspace_id=job.workspace_id
                    AND request.pdf_export_request_id=job.pdf_export_request_id
                   JOIN editor_documents document
                     ON document.workspace_id=request.workspace_id
                    AND document.document_id=request.document_id
                   JOIN document_versions version
                     ON version.document_id=request.document_id
                    AND version.document_version_id=request.document_version_id
                   WHERE job.job_id=%s AND job.kind='pdf_export'
                   FOR UPDATE OF job,request""",
                (job_id,),
            )
            row = self._one(cursor)
            if row is None:
                raise LookupError("PDF export job was not found")
            if not self._claimable_pdf(
                cursor, row, worker_id, token_hash, trace_id, instant, lease_seconds
            ):
                self._connection.commit()
                return None
            if row["snapshot_sha256"] != row["version_snapshot_sha256"]:
                raise RuntimeError("PDF request no longer matches its immutable document version")
            snapshot = self._json(row["snapshot"])
            preflight = self._json(row["preflight"])
            profile = self._json(row["profile"])
            if (
                preflight.get("state") != "ready"
                or preflight.get("snapshot_sha256") != row["snapshot_sha256"]
                or preflight.get("document_version_id") != row["document_version_id"]
                or preflight.get("profile") != profile
            ):
                raise RuntimeError("PDF preflight evidence no longer matches the queued request")
            selected = {str(page["artboard_id"]) for page in snapshot.get("artboards", [])}
            assets = self._verified_assets(cursor, str(row["workspace_id"]), snapshot, selected)
            snapshot_assets = {
                str(asset.get("shared_asset_id")): asset
                for asset in snapshot.get("shared_assets", [])
            }
            for source in assets:
                recorded = snapshot_assets.get(source.shared_asset_id, {})
                display_width, display_height = (
                    (source.height, source.width)
                    if source.orientation in {5, 6, 7, 8}
                    else (source.width, source.height)
                )
                if (
                    recorded.get("source_version_id") != source.source_version_id
                    or recorded.get("source_media_type") != source.media_type
                    or recorded.get("source_width_px") != display_width
                    or recorded.get("source_height_px") != display_height
                    or recorded.get("source_byte_size") != source.byte_size
                    or recorded.get("source_orientation") != source.orientation
                    or recorded.get("source_bit_depth") != source.bit_depth
                    or recorded.get("source_frame_count") != source.frame_count
                    or recorded.get("source_has_icc_profile") != source.has_icc_profile
                    or recorded.get("source_colour_model") != source.colour_model
                ):
                    raise RuntimeError("PDF snapshot source facts no longer match storage")
            self._connection.commit()
            return LeasedPdfExportJob(
                job_id=job_id,
                pdf_export_request_id=str(row["pdf_export_request_id"]),
                workspace_id=str(row["workspace_id"]),
                actor_id=str(row["actor_id"]),
                document_id=str(row["document_id"]),
                document_version_id=str(row["document_version_id"]),
                document_name=str(row["document_name"]),
                snapshot_sha256=str(row["snapshot_sha256"]),
                profile=profile,
                preflight=preflight,
                snapshot=snapshot,
                assets=assets,
                lease_token_hash=token_hash,
                trace_id=trace_id,
                attempt=int(row["claimed_attempt"]),
                max_attempts=int(row["max_attempts"]),
            )
        except Exception:
            self._connection.rollback()
            raise
        finally:
            cursor.close()

    def start_pdf_export(self, lease: LeasedPdfExportJob, now: datetime | None = None) -> None:
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
                raise JobBusyError("PDF export lease changed before start")
            cursor.execute(
                """UPDATE pdf_export_requests SET state='running',updated_at=%s
                   WHERE pdf_export_request_id=%s AND state='queued'""",
                (instant, lease.pdf_export_request_id),
            )
            if cursor.rowcount != 1:
                raise JobBusyError("PDF export request changed before start")
            self._event(
                cursor, lease.job_id, "pdf-export.started", "running", 10, instant, lease.trace_id
            )
            self._connection.commit()
        except Exception:
            self._connection.rollback()
            raise
        finally:
            cursor.close()

    def heartbeat_pdf_export(self, lease: LeasedPdfExportJob, now: datetime | None = None) -> None:
        self._heartbeat(lease.job_id, lease.lease_token_hash, now)

    def cancellation_requested_pdf_export(self, lease: LeasedPdfExportJob) -> bool:
        return self._cancellation_requested(lease.job_id)

    def complete_pdf_export(
        self,
        lease: LeasedPdfExportJob,
        stored: StoredPdfExport,
        now: datetime | None = None,
    ) -> None:
        instant = now or utcnow()
        cursor = self._connection.cursor()
        try:
            cursor.execute("BEGIN")
            self._require_running(cursor, lease.job_id, lease.lease_token_hash)
            object_id = deterministic_id(
                "pdf-object",
                f"{lease.pdf_export_request_id}:{stored.object_key}:"
                f"{stored.storage_generation}:{stored.rendered.sha256}",
            )
            cursor.execute(
                """INSERT INTO object_references(object_reference_id,workspace_id,object_key,
                   sha256,media_type,byte_size,storage_generation,created_at)
                   VALUES(%s,%s,%s,%s,'application/pdf',%s,%s,%s)
                   ON CONFLICT(workspace_id,object_key) DO NOTHING""",
                (
                    object_id,
                    lease.workspace_id,
                    stored.object_key,
                    stored.rendered.sha256,
                    len(stored.rendered.data),
                    stored.storage_generation,
                    instant,
                ),
            )
            cursor.execute(
                """SELECT object_reference_id,sha256,byte_size,storage_generation
                   FROM object_references WHERE workspace_id=%s AND object_key=%s""",
                (lease.workspace_id, stored.object_key),
            )
            object_id, digest, size, generation = cursor.fetchone()
            if (
                digest != stored.rendered.sha256
                or int(size) != len(stored.rendered.data)
                or generation != stored.storage_generation
            ):
                raise RuntimeError("PDF object identity conflict")
            cursor.execute(
                """INSERT INTO pdf_export_results(pdf_export_result_id,pdf_export_request_id,
                   workspace_id,document_id,document_version_id,filename,media_type,byte_size,
                   sha256,page_count,renderer,object_reference_id,created_at)
                   VALUES(%s,%s,%s,%s,%s,%s,'application/pdf',%s,%s,%s,%s::jsonb,%s,%s)""",
                (
                    deterministic_id("pdf-result", lease.pdf_export_request_id),
                    lease.pdf_export_request_id,
                    lease.workspace_id,
                    lease.document_id,
                    lease.document_version_id,
                    stored.filename,
                    len(stored.rendered.data),
                    stored.rendered.sha256,
                    stored.rendered.page_count,
                    json.dumps(stored.rendered.renderer, sort_keys=True),
                    object_id,
                    instant,
                ),
            )
            cursor.execute(
                """UPDATE pdf_export_requests SET state='succeeded',failure_code=NULL,
                   failure_message=NULL,updated_at=%s WHERE pdf_export_request_id=%s""",
                (instant, lease.pdf_export_request_id),
            )
            cursor.execute(
                """UPDATE processing_jobs SET state='succeeded',progress_percent=100,failure=NULL,
                   lease_owner=NULL,lease_token_hash=NULL,lease_expires_at=NULL,updated_at=%s
                   WHERE job_id=%s""",
                (instant, lease.job_id),
            )
            cursor.execute(
                """INSERT INTO job_checkpoints(job_id,attempt,checkpoint_key,payload,created_at)
                   VALUES(%s,%s,'pdf-result',%s::jsonb,%s)""",
                (
                    lease.job_id,
                    lease.attempt,
                    json.dumps(
                        {
                            "sha256": stored.rendered.sha256,
                            "byte_size": len(stored.rendered.data),
                            "page_count": stored.rendered.page_count,
                        },
                        sort_keys=True,
                    ),
                    instant,
                ),
            )
            self._event(
                cursor,
                lease.job_id,
                "pdf-export.succeeded",
                "succeeded",
                100,
                instant,
                lease.trace_id,
            )
            self._audit_usage(
                cursor,
                lease.workspace_id,
                lease.actor_id,
                lease.trace_id,
                "pdf.export-succeeded",
                "pdf_export",
                lease.pdf_export_request_id,
                instant,
                {
                    "capability": "native_pdf_creation",
                    "profile": "screen",
                    "page_count": stored.rendered.page_count,
                    "zero_charge": True,
                },
            )
            self._connection.commit()
        except Exception:
            self._connection.rollback()
            raise
        finally:
            cursor.close()

    def fail_pdf_export(
        self,
        lease: LeasedPdfExportJob,
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
                raise JobBusyError("PDF export lease is no longer valid")
            cancelled = row["state"] == "cancel_requested" or code == "pdf-export-cancelled"
            will_retry = (
                not cancelled and retryable and int(row["attempt"]) < int(row["max_attempts"])
            )
            job_state = "cancelled" if cancelled else "retry_wait" if will_retry else "failed"
            request_state = "cancelled" if cancelled else "queued" if will_retry else "failed"
            cursor.execute(
                """UPDATE pdf_export_requests SET state=%s,failure_code=%s,failure_message=%s,
                   updated_at=%s WHERE pdf_export_request_id=%s""",
                (
                    request_state,
                    None if will_retry or cancelled else code[:100],
                    None if will_retry or cancelled else message[:1000],
                    instant,
                    lease.pdf_export_request_id,
                ),
            )
            failure = {
                "schema_version": SCHEMA_VERSION,
                "code": code,
                "message": message[:500],
                "retryable": will_retry,
            }
            cursor.execute(
                """UPDATE processing_jobs SET state=%s,failure=%s::jsonb,next_attempt_at=%s,
                   lease_owner=NULL,lease_token_hash=NULL,lease_expires_at=NULL,updated_at=%s
                   WHERE job_id=%s""",
                (
                    job_state,
                    json.dumps(failure, sort_keys=True),
                    instant + timedelta(seconds=30) if will_retry else None,
                    instant,
                    lease.job_id,
                ),
            )
            self._event(
                cursor,
                lease.job_id,
                "pdf-export.retry-scheduled" if will_retry else f"pdf-export.{job_state}",
                job_state,
                int(row["progress_percent"]),
                instant,
                lease.trace_id,
            )
            self._connection.commit()
            return job_state
        except Exception:
            self._connection.rollback()
            raise
        finally:
            cursor.close()

    def _claimable_pdf(
        self,
        cursor: Any,
        row: dict[str, Any],
        worker_id: str,
        token_hash: str,
        trace_id: str,
        instant: datetime,
        lease_seconds: int,
    ) -> bool:
        state = str(row["state"])
        if state in {"succeeded", "failed", "cancelled"}:
            return False
        if state == "cancel_requested":
            cursor.execute(
                """UPDATE pdf_export_requests SET state='cancelled',updated_at=%s
                   WHERE pdf_export_request_id=%s""",
                (instant, row["pdf_export_request_id"]),
            )
            cursor.execute(
                """UPDATE processing_jobs SET state='cancelled',lease_owner=NULL,
                   lease_token_hash=NULL,lease_expires_at=NULL,updated_at=%s WHERE job_id=%s""",
                (instant, row["job_id"]),
            )
            self._event(
                cursor,
                str(row["job_id"]),
                "pdf-export.cancelled",
                "cancelled",
                int(row["progress_percent"]),
                instant,
                trace_id,
            )
            return False
        eligible = (
            state == "queued"
            or (
                state == "retry_wait"
                and (row["next_attempt_at"] is None or row["next_attempt_at"] <= instant)
            )
            or (
                state in {"leased", "running"}
                and row["lease_expires_at"] is not None
                and row["lease_expires_at"] <= instant
            )
        )
        if not eligible:
            raise JobBusyError("job is not eligible for a new PDF export lease")
        if int(row["attempt"]) >= int(row["max_attempts"]):
            failure = {
                "schema_version": SCHEMA_VERSION,
                "code": "job-attempts-exhausted",
                "message": "The durable PDF export exhausted its approved attempts",
                "retryable": False,
            }
            cursor.execute(
                """UPDATE processing_jobs SET state='failed',failure=%s::jsonb,
                   lease_owner=NULL,lease_token_hash=NULL,lease_expires_at=NULL,updated_at=%s
                   WHERE job_id=%s""",
                (json.dumps(failure), instant, row["job_id"]),
            )
            cursor.execute(
                """UPDATE pdf_export_requests SET state='failed',
                   failure_code='job-attempts-exhausted',
                   failure_message='The durable PDF export exhausted its approved attempts',
                   updated_at=%s
                   WHERE pdf_export_request_id=%s""",
                (instant, row["pdf_export_request_id"]),
            )
            return False
        cursor.execute(
            """UPDATE processing_jobs SET state='leased',attempt=attempt+1,lease_owner=%s,
               lease_token_hash=%s,lease_expires_at=%s,heartbeat_at=%s,next_attempt_at=NULL,
               updated_at=%s WHERE job_id=%s RETURNING attempt""",
            (
                worker_id,
                token_hash,
                instant + timedelta(seconds=lease_seconds),
                instant,
                instant,
                row["job_id"],
            ),
        )
        row["claimed_attempt"] = int(cursor.fetchone()[0])
        self._event(
            cursor,
            str(row["job_id"]),
            "pdf-export.leased",
            "leased",
            int(row["progress_percent"]),
            instant,
            trace_id,
        )
        return True
