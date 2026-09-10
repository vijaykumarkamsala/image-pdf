"""PostgreSQL authority for durable image export and ZIP workers."""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime, timedelta
from typing import Any, cast
from urllib.parse import unquote, urlparse

import pg8000.dbapi

from ipw.processing_worker.enhancement_engine import PROCESSOR_NAME, PROCESSOR_VERSION
from ipw.processing_worker.image_export import (
    BundleItem,
    ExportAssetReference,
    ExportOutputTarget,
    LeasedExportBundleJob,
    LeasedImageExportJob,
    StoredExportBundle,
    StoredExportOutput,
)
from ipw.processing_worker.repository import DatabaseConnection, JobBusyError, utcnow

SCHEMA_VERSION = "1.18.0"


def deterministic_id(prefix: str, value: str) -> str:
    return f"{prefix}-{uuid.uuid5(uuid.NAMESPACE_URL, f'ipw:{prefix}:{value}')}"


def effectively_visible_raster_ids(
    snapshot: dict[str, Any], selected_artboard_ids: set[str]
) -> set[str]:
    layers = [
        layer
        for layer in snapshot.get("layers", [])
        if str(layer.get("artboard_id")) in selected_artboard_ids
    ]
    by_id = {str(layer.get("layer_id")): layer for layer in layers}

    def visible(layer: dict[str, Any]) -> bool:
        current: dict[str, Any] | None = layer
        visited: set[str] = set()
        while current is not None:
            if not current.get("visible", True):
                return False
            layer_id = str(current.get("layer_id", ""))
            if not layer_id or layer_id in visited:
                raise RuntimeError("native document contains a cyclic layer hierarchy")
            visited.add(layer_id)
            parent_id = current.get("parent_layer_id")
            if parent_id is None:
                return True
            current = by_id.get(str(parent_id))
            if current is None:
                raise RuntimeError("native document layer parent is outside the selected artboard")
        return False

    result = {
        str((layer.get("raster") or {}).get("shared_asset_id"))
        for layer in layers
        if layer.get("layer_type") == "raster_image" and visible(layer)
    }
    if "" in result or "None" in result:
        raise RuntimeError("native document raster source identity is incomplete")
    return result


class PostgresImageExportWorkerRepository:
    def __init__(self, connection: DatabaseConnection) -> None:
        self._connection = connection

    @classmethod
    def connect(cls, database_url: str) -> PostgresImageExportWorkerRepository:
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

    def claim_image_export(
        self,
        *,
        job_id: str,
        worker_id: str,
        lease_token: str,
        trace_id: str,
        now: datetime | None = None,
        lease_seconds: int = 90,
    ) -> LeasedImageExportJob | None:
        instant = now or utcnow()
        token_hash = hashlib.sha256(lease_token.encode()).hexdigest()
        cursor = self._connection.cursor()
        try:
            cursor.execute("BEGIN")
            cursor.execute(
                """SELECT job.*,request.document_id,request.document_version_id,
                          request.recipe_id,request.recipe_version,request.state AS request_state,
                          recipe.operations,version.snapshot,preview.mode AS preview_mode
                   FROM processing_jobs job
                   JOIN image_export_requests request
                     ON request.export_request_id=job.export_request_id
                    AND request.workspace_id=job.workspace_id
                   JOIN processing_recipes recipe ON recipe.recipe_id=request.recipe_id
                    AND recipe.version=request.recipe_version
                    AND recipe.workspace_id=request.workspace_id
                    AND recipe.document_id=request.document_id
                   JOIN document_versions version
                     ON version.document_version_id=request.document_version_id
                    AND version.document_id=request.document_id
                   LEFT JOIN enhancement_previews preview
                     ON preview.export_request_id=request.export_request_id
                   WHERE job.job_id=%s AND job.kind='image_export'
                   FOR UPDATE OF job,request""",
                (job_id,),
            )
            row = self._one(cursor)
            if row is None:
                raise LookupError("image export job was not found")
            if not self._claimable(
                cursor, row, worker_id, token_hash, trace_id, instant, lease_seconds
            ):
                self._connection.commit()
                return None
            cursor.execute(
                """UPDATE image_export_outputs SET state='queued',progress_percent=0
                   WHERE export_request_id=%s AND state='running'""",
                (row["export_request_id"],),
            )
            cursor.execute(
                """SELECT output_id,artboard_id,filename,profile
                   FROM image_export_outputs
                   WHERE export_request_id=%s AND state='queued'
                   ORDER BY output_id""",
                (row["export_request_id"],),
            )
            outputs = tuple(
                ExportOutputTarget(str(item[0]), str(item[1]), str(item[2]), self._json(item[3]))
                for item in cursor.fetchall()
            )
            snapshot = self._json(row["snapshot"])
            assets = self._verified_assets(
                cursor,
                str(row["workspace_id"]),
                snapshot,
                {output.artboard_id for output in outputs},
            )
            self._connection.commit()
            return LeasedImageExportJob(
                job_id=job_id,
                export_request_id=str(row["export_request_id"]),
                workspace_id=str(row["workspace_id"]),
                actor_id=str(row["actor_id"]),
                document_id=str(row["document_id"]),
                document_version_id=str(row["document_version_id"]),
                recipe_id=str(row["recipe_id"]),
                recipe_version=int(row["recipe_version"]),
                operations=(
                    []
                    if row.get("preview_mode") == "original"
                    else list(self._json_array(row["operations"]))
                ),
                snapshot=snapshot,
                assets=assets,
                outputs=outputs,
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

    def start_image_export(self, lease: LeasedImageExportJob, now: datetime | None = None) -> None:
        instant = now or utcnow()
        cursor = self._connection.cursor()
        try:
            cursor.execute("BEGIN")
            cursor.execute(
                """UPDATE processing_jobs SET state='running',progress_percent=5,updated_at=%s
                   WHERE job_id=%s AND lease_token_hash=%s AND state='leased'""",
                (instant, lease.job_id, lease.lease_token_hash),
            )
            if cursor.rowcount != 1:
                raise JobBusyError("image export lease changed before start")
            cursor.execute(
                """UPDATE image_export_requests SET state='running',updated_at=%s
                   WHERE export_request_id=%s""",
                (instant, lease.export_request_id),
            )
            self._event(
                cursor,
                lease.job_id,
                "export.started",
                "running",
                5,
                instant,
                lease.trace_id,
            )
            self._connection.commit()
        except Exception:
            self._connection.rollback()
            raise
        finally:
            cursor.close()

    def heartbeat_image_export(
        self, lease: LeasedImageExportJob, now: datetime | None = None
    ) -> None:
        self._heartbeat(lease.job_id, lease.lease_token_hash, now)

    def cancellation_requested_image_export(self, lease: LeasedImageExportJob) -> bool:
        return self._cancellation_requested(lease.job_id)

    def start_export_output(
        self, lease: LeasedImageExportJob, output_id: str, now: datetime | None = None
    ) -> None:
        instant = now or utcnow()
        cursor = self._connection.cursor()
        cursor.execute("BEGIN")
        try:
            self._require_running(cursor, lease.job_id, lease.lease_token_hash)
            cursor.execute(
                """UPDATE image_export_outputs SET state='running',progress_percent=10
                   WHERE output_id=%s AND export_request_id=%s AND state='queued'""",
                (output_id, lease.export_request_id),
            )
            if cursor.rowcount != 1:
                raise JobBusyError("export output is no longer queued")
            cursor.execute(
                "UPDATE processing_jobs SET updated_at=%s WHERE job_id=%s",
                (instant, lease.job_id),
            )
            self._connection.commit()
        except Exception:
            self._connection.rollback()
            raise
        finally:
            cursor.close()

    def complete_export_output(
        self,
        lease: LeasedImageExportJob,
        stored: StoredExportOutput,
        now: datetime | None = None,
    ) -> None:
        instant = now or utcnow()
        target = next((item for item in lease.outputs if item.output_id == stored.output_id), None)
        if target is None:
            raise ValueError("completed output is outside the leased output set")
        cursor = self._connection.cursor()
        try:
            cursor.execute("BEGIN")
            self._require_running(cursor, lease.job_id, lease.lease_token_hash)
            object_id = deterministic_id(
                "export-object",
                f"{stored.output_id}:{stored.object_key}:{stored.storage_generation}:"
                f"{stored.rendered.sha256}",
            )
            cursor.execute(
                """INSERT INTO object_references(object_reference_id,workspace_id,object_key,
                   sha256,media_type,byte_size,storage_generation,created_at)
                   VALUES(%s,%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT(workspace_id,object_key) DO NOTHING""",
                (
                    object_id,
                    lease.workspace_id,
                    stored.object_key,
                    stored.rendered.sha256,
                    stored.rendered.media_type,
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
                raise RuntimeError("export object identity conflict")
            cursor.execute(
                """UPDATE image_export_outputs SET state='succeeded',progress_percent=100,
                   object_reference_id=%s,sha256=%s,byte_size=%s,width=%s,height=%s,
                   media_type=%s,metadata_verified=%s,metadata_evidence=%s::jsonb,
                   histogram=%s::jsonb,failure_code=NULL,failure_message=NULL,completed_at=%s
                   WHERE output_id=%s AND export_request_id=%s AND state='running'""",
                (
                    object_id,
                    stored.rendered.sha256,
                    len(stored.rendered.data),
                    stored.rendered.width,
                    stored.rendered.height,
                    stored.rendered.media_type,
                    stored.rendered.metadata_verified,
                    json.dumps(stored.rendered.metadata_evidence, sort_keys=True),
                    json.dumps(stored.rendered.histogram, sort_keys=True),
                    instant,
                    stored.output_id,
                    lease.export_request_id,
                ),
            )
            if cursor.rowcount != 1:
                raise JobBusyError("export output changed before completion")
            source_ids = sorted({item.source_version_id for item in lease.assets})
            cursor.execute(
                """INSERT INTO export_provenance(provenance_id,output_id,workspace_id,
                   document_id,document_version_id,source_version_ids,recipe_id,recipe_version,
                   processor_name,processor_version,deterministic,parameters_sha256,output_sha256,
                   metadata_policy,metadata_verified,metadata_evidence,trace_id,job_id,created_at)
                   VALUES(%s,%s,%s,%s,%s,%s::jsonb,%s,%s,%s,%s,true,%s,%s,%s::jsonb,
                          %s,%s::jsonb,%s,%s,%s)
                   ON CONFLICT(output_id) DO NOTHING""",
                (
                    deterministic_id("provenance", stored.output_id),
                    stored.output_id,
                    lease.workspace_id,
                    lease.document_id,
                    lease.document_version_id,
                    json.dumps(source_ids),
                    lease.recipe_id,
                    lease.recipe_version,
                    PROCESSOR_NAME,
                    PROCESSOR_VERSION,
                    stored.rendered.parameters_sha256,
                    stored.rendered.sha256,
                    json.dumps(target.profile.get("metadata_policy", {})),
                    stored.rendered.metadata_verified,
                    json.dumps(stored.rendered.metadata_evidence, sort_keys=True),
                    lease.trace_id,
                    lease.job_id,
                    instant,
                ),
            )
            self._connection.commit()
        except Exception:
            self._connection.rollback()
            raise
        finally:
            cursor.close()

    def fail_export_output(
        self,
        lease: LeasedImageExportJob,
        output_id: str,
        *,
        code: str,
        message: str,
    ) -> None:
        cursor = self._connection.cursor()
        try:
            cursor.execute("BEGIN")
            self._require_running(cursor, lease.job_id, lease.lease_token_hash)
            cursor.execute(
                """UPDATE image_export_outputs SET state='failed',progress_percent=100,
                   failure_code=%s,failure_message=%s
                   WHERE output_id=%s AND export_request_id=%s AND state='running'""",
                (code[:100], message[:500], output_id, lease.export_request_id),
            )
            if cursor.rowcount != 1:
                raise JobBusyError("export output changed before failure was recorded")
            self._connection.commit()
        except Exception:
            self._connection.rollback()
            raise
        finally:
            cursor.close()

    def checkpoint_image_export(
        self,
        lease: LeasedImageExportJob,
        key: str,
        payload: dict[str, Any],
        now: datetime | None = None,
    ) -> None:
        instant = now or utcnow()
        cursor = self._connection.cursor()
        cursor.execute(
            """INSERT INTO job_checkpoints(job_id,attempt,checkpoint_key,payload,created_at)
               SELECT job_id,attempt,%s,%s::jsonb,%s FROM processing_jobs
               WHERE job_id=%s AND lease_token_hash=%s AND state='running'
               ON CONFLICT(job_id,attempt,checkpoint_key)
               DO UPDATE SET payload=EXCLUDED.payload,created_at=EXCLUDED.created_at""",
            (
                key[:100],
                json.dumps(payload),
                instant,
                lease.job_id,
                lease.lease_token_hash,
            ),
        )
        if cursor.rowcount != 1:
            self._connection.rollback()
            cursor.close()
            raise JobBusyError("export checkpoint lost its lease")
        cursor.execute(
            """UPDATE processing_jobs SET progress_percent=(
                 SELECT LEAST(95,5 + ROUND(90.0 * COUNT(*) / GREATEST(1,%s)))
                 FROM image_export_outputs
                 WHERE export_request_id=%s AND state IN ('succeeded','failed','cancelled')
               ),updated_at=%s WHERE job_id=%s""",
            (len(lease.outputs), lease.export_request_id, instant, lease.job_id),
        )
        self._connection.commit()
        cursor.close()

    def finish_image_export(self, lease: LeasedImageExportJob, now: datetime | None = None) -> str:
        instant = now or utcnow()
        cursor = self._connection.cursor()
        try:
            cursor.execute("BEGIN")
            self._require_running(cursor, lease.job_id, lease.lease_token_hash)
            cursor.execute(
                """SELECT state,COUNT(*) FROM image_export_outputs
                   WHERE export_request_id=%s GROUP BY state""",
                (lease.export_request_id,),
            )
            counts = {str(state): int(count) for state, count in cursor.fetchall()}
            if counts.get("queued", 0) or counts.get("running", 0):
                raise RuntimeError("export cannot finish with pending outputs")
            succeeded = counts.get("succeeded", 0)
            failed = counts.get("failed", 0)
            if succeeded and failed:
                request_state, job_state = "partially_completed", "succeeded"
            elif succeeded:
                request_state, job_state = "completed", "succeeded"
            else:
                request_state, job_state = "failed", "failed"
            cursor.execute(
                """UPDATE image_export_requests SET state=%s,updated_at=%s
                   WHERE export_request_id=%s""",
                (request_state, instant, lease.export_request_id),
            )
            cursor.execute(
                """UPDATE processing_jobs SET state=%s,progress_percent=100,failure=NULL,
                   lease_owner=NULL,lease_token_hash=NULL,lease_expires_at=NULL,updated_at=%s
                   WHERE job_id=%s""",
                (job_state, instant, lease.job_id),
            )
            self._event(
                cursor,
                lease.job_id,
                "export.completed" if succeeded else "export.failed",
                job_state,
                100,
                instant,
                lease.trace_id,
            )
            self._audit_usage(
                cursor,
                lease.workspace_id,
                lease.actor_id,
                lease.trace_id,
                "export.completed" if succeeded else "export.failed",
                "image_export",
                lease.export_request_id,
                instant,
                {"outputs_succeeded": succeeded, "outputs_failed": failed},
            )
            self._connection.commit()
            return request_state
        except Exception:
            self._connection.rollback()
            raise
        finally:
            cursor.close()

    def fail_image_export(
        self,
        lease: LeasedImageExportJob,
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
                raise JobBusyError("image export lease is no longer valid")
            cancelled = row["state"] == "cancel_requested" or code == "export-cancelled"
            if cancelled:
                state = "cancelled"
                cursor.execute(
                    """UPDATE image_export_outputs SET state='cancelled',progress_percent=100
                       WHERE export_request_id=%s AND state IN ('queued','running')""",
                    (lease.export_request_id,),
                )
                cursor.execute(
                    """UPDATE image_export_requests SET state='cancelled',updated_at=%s
                       WHERE export_request_id=%s""",
                    (instant, lease.export_request_id),
                )
            else:
                will_retry = retryable and int(row["attempt"]) < int(row["max_attempts"])
                state = "retry_wait" if will_retry else "failed"
                if will_retry:
                    cursor.execute(
                        """UPDATE image_export_outputs SET state='queued',progress_percent=0
                           WHERE export_request_id=%s AND state='running'""",
                        (lease.export_request_id,),
                    )
                    cursor.execute(
                        """UPDATE image_export_requests SET state='queued',updated_at=%s
                           WHERE export_request_id=%s""",
                        (instant, lease.export_request_id),
                    )
                else:
                    cursor.execute(
                        """UPDATE image_export_outputs SET state='failed',progress_percent=100,
                           failure_code=%s,failure_message=%s
                           WHERE export_request_id=%s AND state IN ('queued','running')""",
                        (code[:100], message[:500], lease.export_request_id),
                    )
                    cursor.execute(
                        """UPDATE image_export_requests SET state='failed',updated_at=%s
                           WHERE export_request_id=%s""",
                        (instant, lease.export_request_id),
                    )
            failure = {
                "schema_version": SCHEMA_VERSION,
                "code": code,
                "message": message[:500],
                "retryable": state == "retry_wait",
            }
            cursor.execute(
                """UPDATE processing_jobs SET state=%s,failure=%s::jsonb,next_attempt_at=%s,
                   lease_owner=NULL,lease_token_hash=NULL,lease_expires_at=NULL,updated_at=%s
                   WHERE job_id=%s""",
                (
                    state,
                    json.dumps(failure),
                    instant + timedelta(seconds=30) if state == "retry_wait" else None,
                    instant,
                    lease.job_id,
                ),
            )
            self._event(
                cursor,
                lease.job_id,
                "export.retry-scheduled" if state == "retry_wait" else f"export.{state}",
                state,
                int(row["progress_percent"]),
                instant,
                lease.trace_id,
            )
            self._connection.commit()
            return state
        except Exception:
            self._connection.rollback()
            raise
        finally:
            cursor.close()

    def claim_export_bundle(
        self,
        *,
        job_id: str,
        worker_id: str,
        lease_token: str,
        trace_id: str,
        now: datetime | None = None,
        lease_seconds: int = 90,
    ) -> LeasedExportBundleJob | None:
        instant = now or utcnow()
        token_hash = hashlib.sha256(lease_token.encode()).hexdigest()
        cursor = self._connection.cursor()
        try:
            cursor.execute("BEGIN")
            cursor.execute(
                """SELECT job.*,bundle.export_request_id,bundle.items,bundle.expires_at,
                          bundle.state AS bundle_state
                   FROM processing_jobs job JOIN export_bundles bundle
                     ON bundle.bundle_id=job.bundle_id AND bundle.workspace_id=job.workspace_id
                   WHERE job.job_id=%s AND job.kind='export_bundle'
                   FOR UPDATE OF job,bundle""",
                (job_id,),
            )
            row = self._one(cursor)
            if row is None:
                raise LookupError("export bundle job was not found")
            if row["expires_at"] <= instant:
                self._terminal_bundle(cursor, row, "failed", "bundle-expired", instant, trace_id)
                self._connection.commit()
                return None
            if not self._claimable(
                cursor, row, worker_id, token_hash, trace_id, instant, lease_seconds
            ):
                self._connection.commit()
                return None
            declared = {str(item["output_id"]): item for item in self._json_array(row["items"])}
            cursor.execute(
                """SELECT output.output_id,output.filename,object.object_key,
                          object.storage_generation,output.sha256,output.byte_size,output.media_type
                   FROM image_export_outputs output
                   JOIN object_references object
                     ON object.object_reference_id=output.object_reference_id
                   WHERE output.export_request_id=%s AND output.state='succeeded'
                   ORDER BY output.output_id""",
                (row["export_request_id"],),
            )
            items = tuple(
                BundleItem(
                    str(item[0]),
                    str(item[1]),
                    str(item[2]),
                    str(item[3]),
                    str(item[4]),
                    int(item[5]),
                    str(item[6]),
                )
                for item in cursor.fetchall()
                if str(item[0]) in declared
            )
            if len(items) != len(declared):
                raise RuntimeError("ZIP manifest references an unavailable output")
            self._connection.commit()
            return LeasedExportBundleJob(
                job_id=job_id,
                bundle_id=str(row["bundle_id"]),
                export_request_id=str(row["export_request_id"]),
                workspace_id=str(row["workspace_id"]),
                actor_id=str(row["actor_id"]),
                items=items,
                expires_at=row["expires_at"].isoformat(),
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

    def start_export_bundle(
        self, lease: LeasedExportBundleJob, now: datetime | None = None
    ) -> None:
        instant = now or utcnow()
        cursor = self._connection.cursor()
        cursor.execute("BEGIN")
        try:
            cursor.execute(
                """UPDATE processing_jobs SET state='running',progress_percent=10,updated_at=%s
                   WHERE job_id=%s AND lease_token_hash=%s AND state='leased'""",
                (instant, lease.job_id, lease.lease_token_hash),
            )
            if cursor.rowcount != 1:
                raise JobBusyError("bundle lease changed before start")
            cursor.execute(
                "UPDATE export_bundles SET state='running' WHERE bundle_id=%s",
                (lease.bundle_id,),
            )
            self._event(
                cursor,
                lease.job_id,
                "bundle.started",
                "running",
                10,
                instant,
                lease.trace_id,
            )
            self._connection.commit()
        except Exception:
            self._connection.rollback()
            raise
        finally:
            cursor.close()

    def heartbeat_export_bundle(
        self, lease: LeasedExportBundleJob, now: datetime | None = None
    ) -> None:
        self._heartbeat(lease.job_id, lease.lease_token_hash, now)

    def cancellation_requested_export_bundle(self, lease: LeasedExportBundleJob) -> bool:
        return self._cancellation_requested(lease.job_id)

    def complete_export_bundle(
        self,
        lease: LeasedExportBundleJob,
        stored: StoredExportBundle,
        now: datetime | None = None,
    ) -> None:
        instant = now or utcnow()
        cursor = self._connection.cursor()
        try:
            cursor.execute("BEGIN")
            self._require_running(cursor, lease.job_id, lease.lease_token_hash)
            object_id = deterministic_id(
                "bundle-object",
                f"{lease.bundle_id}:{stored.object_key}:{stored.storage_generation}:{stored.sha256}",
            )
            cursor.execute(
                """INSERT INTO object_references(object_reference_id,workspace_id,object_key,
                   sha256,media_type,byte_size,storage_generation,created_at)
                   VALUES(%s,%s,%s,%s,'application/zip',%s,%s,%s)
                   ON CONFLICT(workspace_id,object_key) DO NOTHING""",
                (
                    object_id,
                    lease.workspace_id,
                    stored.object_key,
                    stored.sha256,
                    stored.byte_size,
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
                digest != stored.sha256
                or int(size) != stored.byte_size
                or generation != stored.storage_generation
            ):
                raise RuntimeError("bundle object identity conflict")
            cursor.execute(
                """UPDATE export_bundles SET state='succeeded',object_reference_id=%s,
                   sha256=%s,byte_size=%s WHERE bundle_id=%s AND state='running'""",
                (object_id, stored.sha256, stored.byte_size, lease.bundle_id),
            )
            if cursor.rowcount != 1:
                raise JobBusyError("bundle target changed before completion")
            cursor.execute(
                """UPDATE processing_jobs SET state='succeeded',progress_percent=100,failure=NULL,
                   lease_owner=NULL,lease_token_hash=NULL,lease_expires_at=NULL,updated_at=%s
                   WHERE job_id=%s""",
                (instant, lease.job_id),
            )
            self._event(
                cursor,
                lease.job_id,
                "bundle.completed",
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
                "export.bundle-completed",
                "export_bundle",
                lease.bundle_id,
                instant,
                {"item_count": len(lease.items)},
            )
            self._connection.commit()
        except Exception:
            self._connection.rollback()
            raise
        finally:
            cursor.close()

    def fail_export_bundle(
        self,
        lease: LeasedExportBundleJob,
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
                raise JobBusyError("bundle lease is no longer valid")
            cancelled = row["state"] == "cancel_requested" or code == "bundle-cancelled"
            retry = retryable and not cancelled and int(row["attempt"]) < int(row["max_attempts"])
            state = "cancelled" if cancelled else "retry_wait" if retry else "failed"
            bundle_state = "queued" if retry else state
            cursor.execute(
                "UPDATE export_bundles SET state=%s WHERE bundle_id=%s",
                (bundle_state, lease.bundle_id),
            )
            failure = {
                "schema_version": SCHEMA_VERSION,
                "code": code,
                "message": message[:500],
                "retryable": retry,
            }
            cursor.execute(
                """UPDATE processing_jobs SET state=%s,failure=%s::jsonb,next_attempt_at=%s,
                   lease_owner=NULL,lease_token_hash=NULL,lease_expires_at=NULL,updated_at=%s
                   WHERE job_id=%s""",
                (
                    state,
                    json.dumps(failure),
                    instant + timedelta(seconds=30) if retry else None,
                    instant,
                    lease.job_id,
                ),
            )
            self._event(
                cursor,
                lease.job_id,
                "bundle.retry-scheduled" if retry else f"bundle.{state}",
                state,
                int(row["progress_percent"]),
                instant,
                lease.trace_id,
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

    def _claimable(
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
            if row["kind"] == "image_export":
                cursor.execute(
                    """UPDATE image_export_outputs SET state='cancelled',progress_percent=100
                       WHERE export_request_id=%s AND state IN ('queued','running')""",
                    (row["export_request_id"],),
                )
                cursor.execute(
                    """UPDATE image_export_requests SET state='cancelled',updated_at=%s
                       WHERE export_request_id=%s""",
                    (instant, row["export_request_id"]),
                )
            else:
                cursor.execute(
                    "UPDATE export_bundles SET state='cancelled' WHERE bundle_id=%s",
                    (row["bundle_id"],),
                )
            cursor.execute(
                """UPDATE processing_jobs SET state='cancelled',lease_owner=NULL,
                   lease_token_hash=NULL,lease_expires_at=NULL,updated_at=%s WHERE job_id=%s""",
                (instant, row["job_id"]),
            )
            self._event(
                cursor,
                str(row["job_id"]),
                "job.cancelled",
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
            raise JobBusyError("job is not eligible for a new export lease")
        if int(row["attempt"]) >= int(row["max_attempts"]):
            failure = json.dumps(
                {
                    "schema_version": SCHEMA_VERSION,
                    "code": "job-attempts-exhausted",
                    "message": "The durable job exhausted its approved attempts",
                    "retryable": False,
                }
            )
            cursor.execute(
                """UPDATE processing_jobs SET state='failed',failure=%s::jsonb,
                   lease_owner=NULL,lease_token_hash=NULL,lease_expires_at=NULL,updated_at=%s
                   WHERE job_id=%s""",
                (failure, instant, row["job_id"]),
            )
            if row["kind"] == "image_export":
                cursor.execute(
                    """UPDATE image_export_outputs SET state='failed',progress_percent=100,
                       failure_code='job-attempts-exhausted',
                       failure_message='The durable export exhausted its approved attempts'
                       WHERE export_request_id=%s AND state IN ('queued','running')""",
                    (row["export_request_id"],),
                )
                cursor.execute(
                    """UPDATE image_export_requests SET state=CASE
                         WHEN EXISTS(SELECT 1 FROM image_export_outputs
                           WHERE export_request_id=%s AND state='succeeded')
                         THEN 'partially_completed' ELSE 'failed' END,updated_at=%s
                       WHERE export_request_id=%s""",
                    (row["export_request_id"], instant, row["export_request_id"]),
                )
            else:
                cursor.execute(
                    "UPDATE export_bundles SET state='failed' WHERE bundle_id=%s",
                    (row["bundle_id"],),
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
            f"{row['kind']}.leased",
            "leased",
            int(row["progress_percent"]),
            instant,
            trace_id,
        )
        return True

    def _verified_assets(
        self,
        cursor: Any,
        workspace_id: str,
        snapshot: dict[str, Any],
        selected_artboard_ids: set[str],
    ) -> tuple[ExportAssetReference, ...]:
        result: list[ExportAssetReference] = []
        referenced_asset_ids = effectively_visible_raster_ids(snapshot, selected_artboard_ids)
        for asset in snapshot.get("shared_assets", []):
            if (
                asset.get("kind") != "raster"
                or str(asset.get("shared_asset_id")) not in referenced_asset_ids
            ):
                continue
            source_version_id = asset.get("source_version_id")
            asset_original_id = asset.get("asset_original_id")
            if not source_version_id or not asset_original_id:
                raise RuntimeError("native document raster source identity is incomplete")
            cursor.execute(
                """SELECT source.object_reference_id,
                          object.object_key,object.storage_generation,object.sha256,
                          object.media_type,object.byte_size,facts.width,facts.height,facts.orientation,
                          facts.storage_generation,facts.source_sha256,facts.media_type,
                          facts.byte_size,facts.malware_scan_state,facts.bit_depth,
                          facts.frame_count,facts.has_icc_profile,facts.colour_model
                   FROM source_versions source
                   JOIN object_references object
                     ON object.object_reference_id=source.object_reference_id
                    AND object.workspace_id=source.workspace_id
                   JOIN source_inspection_facts facts
                     ON facts.source_version_id=source.source_version_id
                    AND facts.workspace_id=source.workspace_id
                    AND facts.asset_original_id=source.asset_original_id
                    AND facts.object_reference_id=source.object_reference_id
                   WHERE source.workspace_id=%s AND source.source_version_id=%s
                     AND source.asset_original_id=%s""",
                (
                    workspace_id,
                    source_version_id,
                    asset_original_id,
                ),
            )
            row = cursor.fetchone()
            if row is None:
                raise RuntimeError("native document references an unverified raster source")
            (
                object_reference_id,
                key,
                generation,
                digest,
                media_type,
                byte_size,
                width,
                height,
                orientation,
                facts_generation,
                facts_digest,
                facts_media_type,
                facts_byte_size,
                scan_state,
                bit_depth,
                frame_count,
                has_icc_profile,
                colour_model,
            ) = row
            snapshot_reference_id = asset.get("object_reference_id")
            if (
                (snapshot_reference_id is not None and snapshot_reference_id != object_reference_id)
                or generation != facts_generation
                or digest != facts_digest
                or media_type != facts_media_type
                or int(byte_size) != int(facts_byte_size)
                or scan_state != "clean"
                or width is None
                or height is None
                or bit_depth is None
                or frame_count is None
                or has_icc_profile is None
                or colour_model is None
            ):
                raise RuntimeError("native document source facts no longer match storage")
            result.append(
                ExportAssetReference(
                    str(asset["shared_asset_id"]),
                    str(asset["source_version_id"]),
                    str(key),
                    str(generation),
                    str(digest),
                    str(media_type),
                    int(byte_size),
                    int(width),
                    int(height),
                    None if orientation is None else int(orientation),
                    int(bit_depth),
                    int(frame_count),
                    bool(has_icc_profile),
                    str(colour_model),
                )
            )
        if referenced_asset_ids != {item.shared_asset_id for item in result}:
            raise RuntimeError("native document references an unavailable verified raster source")
        return tuple(result)

    def _heartbeat(self, job_id: str, token_hash: str, now: datetime | None = None) -> None:
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
                job_id,
                token_hash,
            ),
        )
        if cursor.rowcount != 1:
            self._connection.rollback()
            cursor.close()
            raise JobBusyError("export heartbeat lost its lease")
        self._connection.commit()
        cursor.close()

    def _cancellation_requested(self, job_id: str) -> bool:
        cursor = self._connection.cursor()
        cursor.execute("SELECT state FROM processing_jobs WHERE job_id=%s", (job_id,))
        row = cursor.fetchone()
        cursor.close()
        return row is None or row[0] in {"cancel_requested", "cancelled"}

    @staticmethod
    def _require_running(cursor: Any, job_id: str, token_hash: str) -> None:
        cursor.execute(
            """SELECT 1 FROM processing_jobs WHERE job_id=%s AND lease_token_hash=%s
               AND state='running' FOR UPDATE""",
            (job_id, token_hash),
        )
        if cursor.fetchone() is None:
            raise JobBusyError("export job is no longer running")

    def _terminal_bundle(
        self,
        cursor: Any,
        row: dict[str, Any],
        state: str,
        code: str,
        instant: datetime,
        trace_id: str,
    ) -> None:
        failure = {
            "schema_version": SCHEMA_VERSION,
            "code": code,
            "message": "ZIP bundle expired before it could be prepared",
            "retryable": False,
        }
        cursor.execute(
            "UPDATE export_bundles SET state=%s WHERE bundle_id=%s",
            (state, row["bundle_id"]),
        )
        cursor.execute(
            "UPDATE processing_jobs SET state=%s,failure=%s::jsonb,updated_at=%s WHERE job_id=%s",
            (state, json.dumps(failure), instant, row["job_id"]),
        )
        self._event(
            cursor,
            str(row["job_id"]),
            "bundle.failed",
            state,
            int(row["progress_percent"]),
            instant,
            trace_id,
        )

    @staticmethod
    def _event(
        cursor: Any,
        job_id: str,
        kind: str,
        state: str,
        progress: int,
        instant: datetime,
        trace_id: str,
    ) -> None:
        cursor.execute(
            """INSERT INTO job_events(job_event_id,job_id,event_kind,state,
               progress_percent,occurred_at,trace_id) VALUES(%s,%s,%s,%s,%s,%s,%s)""",
            (
                deterministic_id(
                    "event", f"{job_id}:{kind}:{state}:{progress}:{instant.isoformat()}"
                ),
                job_id,
                kind,
                state,
                progress,
                instant,
                trace_id,
            ),
        )

    @staticmethod
    def _audit_usage(
        cursor: Any,
        workspace_id: str,
        actor_id: str,
        trace_id: str,
        action: str,
        resource_kind: str,
        resource_id: str,
        instant: datetime,
        dimensions: dict[str, Any],
    ) -> None:
        evidence_key = (
            f"{workspace_id}:{actor_id}:{action}:{resource_kind}:{resource_id}:"
            f"{trace_id}:{instant.isoformat()}"
        )
        usage_id = deterministic_id("usage", evidence_key)
        cursor.execute(
            """INSERT INTO audit_events(audit_event_id,workspace_id,actor_id,action,
               resource_kind,resource_id,occurred_at,trace_id)
               VALUES(%s,%s,%s,%s,%s,%s,%s,%s)""",
            (
                deterministic_id("audit", evidence_key),
                workspace_id,
                actor_id,
                action,
                resource_kind,
                resource_id,
                instant,
                trace_id,
            ),
        )
        cursor.execute(
            """INSERT INTO usage_events(usage_event_id,workspace_id,actor_id,event_kind,
               customer_amount,credit_debit,currency,occurred_at)
               VALUES(%s,%s,%s,%s,0,0,'USD',%s)""",
            (usage_id, workspace_id, actor_id, action, instant),
        )
        cursor.execute(
            "INSERT INTO usage_admin_dimensions(usage_event_id,dimensions) VALUES(%s,%s::jsonb)",
            (usage_id, json.dumps(dimensions)),
        )

    @staticmethod
    def _json(value: Any) -> dict[str, Any]:
        parsed = json.loads(value) if isinstance(value, str) else value
        if not isinstance(parsed, dict):
            raise ValueError("expected a JSON object")
        return parsed

    @staticmethod
    def _json_array(value: Any) -> list[dict[str, Any]]:
        parsed = json.loads(value) if isinstance(value, str) else value
        if not isinstance(parsed, list) or not all(isinstance(item, dict) for item in parsed):
            raise ValueError("expected a JSON object array")
        return parsed

    @staticmethod
    def _one(cursor: Any) -> dict[str, Any] | None:
        row = cursor.fetchone()
        if row is None:
            return None
        return {
            description[0]: value
            for description, value in zip(cursor.description, row, strict=True)
        }
