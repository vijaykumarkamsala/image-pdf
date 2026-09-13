from __future__ import annotations

import hashlib
import json
import os
import secrets
import struct
from io import BytesIO
from typing import Any
from urllib.parse import unquote, urlparse

import pg8000.dbapi
import pytest
from pypdf import PdfWriter

from ipw.contracts import PRODUCT_SCHEMA_VERSION
from ipw.inspection import DeterministicMalwareScanner, MalwareScan
from ipw.processing_worker.durable_intake import DispatchMessage, DurableIntakeProcessor
from ipw.processing_worker.repository import PostgresWorkerRepository
from ipw.storage import ObjectZone, PrivateObjectRef, PrivateObjectSnapshot

DATABASE_URL = os.environ.get("IPW_TEST_DATABASE_URL")


def _connect() -> Any:
    assert DATABASE_URL
    parsed = urlparse(DATABASE_URL)
    return pg8000.dbapi.connect(
        user=unquote(parsed.username or ""),
        password=unquote(parsed.password or ""),
        host=parsed.hostname,
        port=parsed.port or 5432,
        database=unquote(parsed.path.lstrip("/")),
    )


def _png() -> bytes:
    return (
        b"\x89PNG\r\n\x1a\n"
        + struct.pack(">I4sIIBBBBB", 13, b"IHDR", 2, 3, 8, 2, 0, 0, 0)
        + b"\x00\x00\x00\x00"
    )


def _active_pdf() -> bytes:
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    writer.add_js("app.alert('disabled')")
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


class Objects:
    def __init__(self, data: bytes, media_type: str = "image/png") -> None:
        self.data = data
        self.media_type = media_type
        self.deleted = False

    def read(
        self, ref: PrivateObjectRef, *, generation: str, max_bytes: int
    ) -> PrivateObjectSnapshot:
        assert generation == "17"
        assert len(self.data) <= max_bytes
        return PrivateObjectSnapshot(ref, generation, self.media_type, self.data)

    def promote(
        self,
        source: PrivateObjectRef,
        *,
        source_generation: str,
        sha256: str,
        max_bytes: int,
    ) -> PrivateObjectRef:
        assert source_generation == "17"
        assert len(self.data) <= max_bytes
        return PrivateObjectRef(
            source.owner_scope,
            f"immutable/{source.owner_scope}/{sha256}",
            ObjectZone.IMMUTABLE,
            sha256,
        )

    def delete(self, _ref: PrivateObjectRef, *, generation: str | None = None) -> None:
        assert generation == "17"
        self.deleted = True


@pytest.mark.skipif(not DATABASE_URL, reason="IPW_TEST_DATABASE_URL is required")
def test_real_postgres_worker_claim_checkpoint_completion_and_redelivery() -> None:
    database_url = DATABASE_URL
    assert database_url
    data = _png()
    digest = hashlib.sha256(data).hexdigest()
    connection = _connect()
    cursor = connection.cursor()
    suffix = secrets.token_hex(4)
    ids = {name: f"{name}-worker-pg-{suffix}" for name in ("guest", "upload", "job")}
    guest_token_hash = hashlib.sha256(f"guest-{suffix}".encode()).hexdigest()
    try:
        cursor.execute(
            """INSERT INTO guest_sessions(guest_session_id,token_hash,expires_at,created_at)
               VALUES (%s,%s,now()+interval '1 day',now())""",
            (ids["guest"], guest_token_hash),
        )
        cursor.execute(
            """INSERT INTO upload_sessions(
                 upload_session_id,owner_kind,guest_session_id,display_name,expected_media_type,
                 expected_byte_size,expected_sha256,bytes_received,state,constraints,
                 upload_token_hash,upload_token_expires_at,quarantine_object_key,
                 transfer_provider,provider_generation,provider_metadata,created_at,expires_at,updated_at)
               VALUES (%s,'guest',%s,'worker.png','image/png',%s,%s,%s,'finalising',%s::jsonb,
                 %s,now()+interval '1 hour',%s,'local_api','17',%s::jsonb,
                 now(),now()+interval '1 day',now())""",
            (
                ids["upload"],
                ids["guest"],
                len(data),
                digest,
                len(data),
                json.dumps(
                    {
                        "schema_version": "1.10.0",
                        "allowed_media_types": ["image/png"],
                        "max_bytes": 1024,
                        "max_pixels": 10_000,
                        "max_pages": 10,
                    }
                ),
                "b" * 64,
                f"quarantine/{ids['guest']}/{ids['upload']}",
                json.dumps({"byteSize": len(data), "generation": "17"}),
            ),
        )
        cursor.execute(
            """INSERT INTO processing_jobs(
                 job_id,kind,owner_kind,guest_session_id,upload_session_id,
                 state,attempt,max_attempts,progress_percent,created_at,updated_at)
               VALUES (%s,'file_intake_inspection','guest',%s,%s,'queued',0,3,0,now(),now())""",
            (ids["job"], ids["guest"], ids["upload"]),
        )
        cursor.execute(
            "UPDATE upload_sessions SET job_id=%s WHERE upload_session_id=%s",
            (ids["job"], ids["upload"]),
        )
        connection.commit()

        repository = PostgresWorkerRepository.connect(database_url)
        objects = Objects(data)
        processor = DurableIntakeProcessor(
            repository,
            objects,
            DeterministicMalwareScanner(),
            worker_id="worker-pg",
        )
        message = DispatchMessage("dispatch-worker-pg", ids["job"], "trace-worker-pg")
        assert processor.process(message).state == "succeeded"
        assert objects.deleted
        assert processor.process(message).state == "already_terminal"

        cursor.execute("SELECT state,attempt FROM processing_jobs WHERE job_id=%s", (ids["job"],))
        assert cursor.fetchone() == ["succeeded", 1]
        cursor.execute(
            """SELECT state,verified_sha256,asset_original_id,source_version_id
               FROM upload_sessions WHERE upload_session_id=%s""",
            (ids["upload"],),
        )
        state, verified, asset_id, source_id = cursor.fetchone()
        assert state == "ready"
        assert verified == digest
        assert asset_id
        assert source_id
        cursor.execute("SELECT count(*) FROM job_checkpoints WHERE job_id=%s", (ids["job"],))
        assert cursor.fetchone()[0] == 1
        cursor.execute(
            "SELECT event_kind FROM job_events WHERE job_id=%s ORDER BY cursor", (ids["job"],)
        )
        assert [row[0] for row in cursor.fetchall()] == [
            "job.leased",
            "inspection.started",
            "inspection.completed",
            "source.promoted",
        ]
    finally:
        cursor.close()
        connection.close()


@pytest.mark.skipif(not DATABASE_URL, reason="IPW_TEST_DATABASE_URL is required")
def test_real_postgres_worker_persists_source_bound_pdf_capability_evidence() -> None:
    database_url = DATABASE_URL
    assert database_url
    data = _active_pdf()
    digest = hashlib.sha256(data).hexdigest()
    connection = _connect()
    cursor = connection.cursor()
    suffix = secrets.token_hex(4)
    ids = {
        name: f"{name}-pdf-worker-pg-{suffix}"
        for name in ("actor", "workspace", "default", "upload", "job")
    }
    try:
        cursor.execute(
            "INSERT INTO actors(actor_id,display_name,created_at) VALUES (%s,'PDF actor',now())",
            (ids["actor"],),
        )
        cursor.execute(
            """INSERT INTO workspaces(workspace_id,name,created_at)
               VALUES (%s,'PDF workspace',now())""",
            (ids["workspace"],),
        )
        cursor.execute(
            """INSERT INTO default_files_locations(default_files_id,workspace_id,name)
               VALUES (%s,%s,'Default Files')""",
            (ids["default"], ids["workspace"]),
        )
        cursor.execute(
            """INSERT INTO upload_sessions(
                 upload_session_id,owner_kind,workspace_id,actor_id,display_name,
                 expected_media_type,expected_byte_size,expected_sha256,bytes_received,
                 state,constraints,upload_token_hash,upload_token_expires_at,
                 quarantine_object_key,transfer_provider,provider_generation,
                 provider_metadata,created_at,expires_at,updated_at)
               VALUES (%s,'actor',%s,%s,'active.pdf','application/pdf',%s,%s,%s,
                 'finalising',%s::jsonb,%s,now()+interval '1 hour',%s,'local_api','17',
                 %s::jsonb,now(),now()+interval '1 day',now())""",
            (
                ids["upload"],
                ids["workspace"],
                ids["actor"],
                len(data),
                digest,
                len(data),
                json.dumps(
                    {
                        "schema_version": PRODUCT_SCHEMA_VERSION,
                        "allowed_media_types": ["application/pdf"],
                        "max_bytes": len(data) + 1,
                        "max_pixels": 10_000,
                        "max_pages": 10,
                    }
                ),
                "d" * 64,
                f"quarantine/{ids['workspace']}/{ids['upload']}",
                json.dumps({"byteSize": len(data), "generation": "17"}),
            ),
        )
        cursor.execute(
            """INSERT INTO processing_jobs(
                 job_id,kind,owner_kind,workspace_id,actor_id,upload_session_id,
                 state,attempt,max_attempts,progress_percent,created_at,updated_at)
               VALUES (%s,'file_intake_inspection','actor',%s,%s,%s,
                 'queued',0,3,0,now(),now())""",
            (ids["job"], ids["workspace"], ids["actor"], ids["upload"]),
        )
        cursor.execute(
            "UPDATE upload_sessions SET job_id=%s WHERE upload_session_id=%s",
            (ids["job"], ids["upload"]),
        )
        connection.commit()

        repository = PostgresWorkerRepository.connect(database_url)
        objects = Objects(data, "application/pdf")
        processor = DurableIntakeProcessor(
            repository,
            objects,
            DeterministicMalwareScanner(),
            worker_id="pdf-worker-pg",
        )
        result = processor.process(
            DispatchMessage("dispatch-pdf-worker-pg", ids["job"], "trace-pdf-worker-pg")
        )
        assert result.state == "succeeded"
        assert objects.deleted

        cursor.execute(
            """SELECT state,pdf_capability_analysis,source_version_id
               FROM upload_sessions WHERE upload_session_id=%s""",
            (ids["upload"],),
        )
        state, upload_analysis, source_id = cursor.fetchone()
        assert state == "ready"
        assert upload_analysis["source_sha256"] == digest
        assert upload_analysis["classification"] == "view_only"
        assert upload_analysis["original_protected"] is True
        active = next(
            item for item in upload_analysis["findings"] if item["feature"] == "active_content"
        )
        assert active["state"] == "present"
        cursor.execute(
            """SELECT pdf_capability_analysis FROM source_inspection_facts
               WHERE source_version_id=%s""",
            (source_id,),
        )
        assert cursor.fetchone()[0] == upload_analysis
    finally:
        cursor.close()
        connection.close()


@pytest.mark.skipif(not DATABASE_URL, reason="IPW_TEST_DATABASE_URL is required")
def test_real_postgres_worker_records_retry_request_and_performance_audits() -> None:
    database_url = DATABASE_URL
    assert database_url
    data = _png()
    digest = hashlib.sha256(data).hexdigest()
    connection = _connect()
    cursor = connection.cursor()
    suffix = secrets.token_hex(4)
    ids = {name: f"{name}-retry-pg-{suffix}" for name in ("actor", "workspace", "upload", "job")}

    class UnavailableScanner:
        def scan(self, _data: bytes) -> MalwareScan:
            return MalwareScan("unavailable")

    try:
        cursor.execute(
            "INSERT INTO actors(actor_id,display_name,created_at) VALUES (%s,'Retry actor',now())",
            (ids["actor"],),
        )
        cursor.execute(
            """INSERT INTO workspaces(workspace_id,name,created_at)
               VALUES (%s,'Retry workspace',now())""",
            (ids["workspace"],),
        )
        cursor.execute(
            """INSERT INTO upload_sessions(
                 upload_session_id,owner_kind,workspace_id,actor_id,display_name,expected_media_type,
                 expected_byte_size,expected_sha256,bytes_received,state,constraints,
                 upload_token_hash,upload_token_expires_at,quarantine_object_key,
                 transfer_provider,provider_generation,provider_metadata,created_at,expires_at,updated_at)
               VALUES (%s,'actor',%s,%s,'retry.png','image/png',%s,%s,%s,'finalising',%s::jsonb,
                 %s,now()+interval '1 hour',%s,'local_api','17',%s::jsonb,
                 now(),now()+interval '1 day',now())""",
            (
                ids["upload"],
                ids["workspace"],
                ids["actor"],
                len(data),
                digest,
                len(data),
                json.dumps(
                    {
                        "schema_version": "1.10.0",
                        "allowed_media_types": ["image/png"],
                        "max_bytes": 1024,
                        "max_pixels": 10_000,
                        "max_pages": 10,
                    }
                ),
                "c" * 64,
                f"quarantine/{ids['workspace']}/{ids['upload']}",
                json.dumps({"byteSize": len(data), "generation": "17"}),
            ),
        )
        cursor.execute(
            """INSERT INTO processing_jobs(
                 job_id,kind,owner_kind,workspace_id,actor_id,upload_session_id,
                 state,attempt,max_attempts,progress_percent,created_at,updated_at)
               VALUES (%s,'file_intake_inspection','actor',%s,%s,%s,'queued',0,3,0,now(),now())""",
            (ids["job"], ids["workspace"], ids["actor"], ids["upload"]),
        )
        cursor.execute(
            "UPDATE upload_sessions SET job_id=%s WHERE upload_session_id=%s",
            (ids["job"], ids["upload"]),
        )
        connection.commit()

        repository = PostgresWorkerRepository.connect(database_url)
        processor = DurableIntakeProcessor(
            repository,
            Objects(data),
            UnavailableScanner(),
            worker_id="worker-retry-pg",
        )
        message = DispatchMessage("dispatch-retry-pg", ids["job"], "trace-retry-pg")
        assert processor.process(message).state == "retry_wait"
        cursor.execute(
            "UPDATE processing_jobs SET next_attempt_at=now()-interval '1 second' WHERE job_id=%s",
            (ids["job"],),
        )
        connection.commit()
        assert processor.process(message).state == "retry_wait"

        cursor.execute(
            """SELECT action FROM audit_events WHERE workspace_id=%s
               ORDER BY occurred_at,audit_event_id""",
            (ids["workspace"],),
        )
        actions = [row[0] for row in cursor.fetchall()]
        assert actions.count("job.retry-requested") == 2
        assert actions.count("job.retry-performed") == 1
        assert actions.count("inspection.started") == 2
        cursor.execute(
            "SELECT count(*) FROM job_outbox WHERE job_id=%s AND dispatch_kind='process_job'",
            (ids["job"],),
        )
        assert cursor.fetchone()[0] == 2
        repository.close()
    finally:
        cursor.close()
        connection.close()
