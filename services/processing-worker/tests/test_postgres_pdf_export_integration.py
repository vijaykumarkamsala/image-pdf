from __future__ import annotations

import hashlib
import json
import os
import secrets
from pathlib import Path
from typing import Any, cast
from urllib.parse import unquote, urlparse

import pg8000.dbapi
import pytest

from ipw.processing_worker.durable_intake import DispatchMessage
from ipw.processing_worker.pdf_export import DurablePdfExportProcessor
from ipw.processing_worker.pdf_export_repository import PostgresPdfExportWorkerRepository
from ipw.storage import LocalWorkerPrivateObjectStore

DATABASE_URL = os.environ.get("IPW_TEST_DATABASE_URL")
ROOT = Path(__file__).parents[3]
FONT = ROOT / "apps" / "web" / "public" / "fonts" / "ipw-standard.ttf"


def connect() -> Any:
    assert DATABASE_URL
    parsed = urlparse(DATABASE_URL)
    return pg8000.dbapi.connect(
        user=unquote(parsed.username or ""),
        password=unquote(parsed.password or ""),
        host=parsed.hostname,
        port=parsed.port or 5432,
        database=unquote(parsed.path.lstrip("/")),
    )


def native_snapshot(document_id: str) -> dict[str, Any]:
    return {
        "schema_version": "1.21.0",
        "document_id": document_id,
        "revision": 0,
        "artboards": [
            {
                "schema_version": "1.21.0",
                "artboard_id": "page-pdf",
                "name": "Page 1",
                "order": 0,
                "width": 595.2756,
                "height": 841.8898,
                "unit": "pt",
                "orientation": "portrait",
                "background": {
                    "schema_version": "1.21.0",
                    "kind": "solid",
                    "color": "#ffffff",
                },
            }
        ],
        "layers": [],
        "masks": [],
        "shared_assets": [],
        "shared_styles": [],
        "variants": [],
        "pdf_settings": {
            "schema_version": "1.21.0",
            "title": "Canonical PDF",
            "language": "en",
            "subject": None,
            "page_size_policy": "uniform",
            "default_page_name": "A4",
            "pages": [
                {
                    "schema_version": "1.21.0",
                    "artboard_id": "page-pdf",
                    "label": "1",
                    "master_page_id": None,
                }
            ],
        },
    }


def screen_profile() -> dict[str, Any]:
    return {
        "schema_version": "1.21.0",
        "profile_id": "screen",
        "profile_version": "1.0.0",
        "label": "Screen PDF",
        "tagged_pdf": False,
        "archival_conformance": None,
        "colour_space": "srgb",
        "image_quality": 90,
        "metadata_policy": "safe",
    }


@pytest.mark.skipif(not DATABASE_URL, reason="IPW_TEST_DATABASE_URL is required")
def test_real_postgres_pdf_export_is_durable_verified_and_zero_charge(tmp_path: Path) -> None:
    assert DATABASE_URL
    suffix = secrets.token_hex(5)
    ids = {
        name: f"{name}-pdf-worker-{suffix}"
        for name in (
            "actor",
            "workspace",
            "membership",
            "default",
            "document",
            "version",
            "request",
            "job",
        )
    }
    snapshot = native_snapshot(ids["document"])
    profile = screen_profile()
    snapshot_sha256 = hashlib.sha256(
        json.dumps(
            snapshot,
            separators=(",", ":"),
            sort_keys=True,
            ensure_ascii=False,
        ).encode()
    ).hexdigest()
    preflight = {
        "schema_version": "1.21.0",
        "document_id": ids["document"],
        "document_version_id": ids["version"],
        "snapshot_sha256": snapshot_sha256,
        "profile": profile,
        "state": "ready",
        "page_count": 1,
        "issues": [],
        "generated_at": "2026-09-12T09:00:00.000Z",
    }
    connection = connect()
    cursor = connection.cursor()
    repository: PostgresPdfExportWorkerRepository | None = None
    try:
        cursor.execute(
            "INSERT INTO actors(actor_id,display_name,created_at) "
            "VALUES(%s,'PDF worker actor',now())",
            (ids["actor"],),
        )
        cursor.execute(
            "INSERT INTO workspaces(workspace_id,name,created_at) "
            "VALUES(%s,'PDF worker workspace',now())",
            (ids["workspace"],),
        )
        cursor.execute(
            """INSERT INTO memberships(membership_id,workspace_id,actor_id,role,created_at)
               VALUES(%s,%s,%s,'owner',now())""",
            (ids["membership"], ids["workspace"], ids["actor"]),
        )
        cursor.execute(
            "INSERT INTO default_files_locations(default_files_id,workspace_id) VALUES(%s,%s)",
            (ids["default"], ids["workspace"]),
        )
        cursor.execute(
            """INSERT INTO editor_documents(
                 document_id,workspace_id,location_kind,default_files_id,kind,name,
                 current_version_id,current_snapshot,created_by_actor_id,created_at,updated_at,
                 preview_state)
               VALUES(%s,%s,'default_files',%s,'pdf','Canonical PDF',%s,%s::jsonb,%s,
                 now(),now(),'not_required')""",
            (
                ids["document"],
                ids["workspace"],
                ids["default"],
                ids["version"],
                json.dumps(snapshot, sort_keys=True),
                ids["actor"],
            ),
        )
        cursor.execute(
            """INSERT INTO document_versions(
                 document_version_id,document_id,sequence,revision,kind,name,snapshot_sha256,
                 snapshot,created_by_actor_id,created_at)
               VALUES(%s,%s,1,0,'initial','Initial',%s,%s::jsonb,%s,now())""",
            (
                ids["version"],
                ids["document"],
                snapshot_sha256,
                json.dumps(snapshot, sort_keys=True),
                ids["actor"],
            ),
        )
        cursor.execute(
            """INSERT INTO pdf_export_requests(
                 pdf_export_request_id,workspace_id,actor_id,document_id,document_version_id,
                 snapshot_sha256,profile,preflight,job_id,state,created_at,updated_at)
               VALUES(%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb,%s,'queued',now(),now())""",
            (
                ids["request"],
                ids["workspace"],
                ids["actor"],
                ids["document"],
                ids["version"],
                snapshot_sha256,
                json.dumps(profile, sort_keys=True),
                json.dumps(preflight, sort_keys=True),
                ids["job"],
            ),
        )
        cursor.execute(
            """INSERT INTO processing_jobs(
                 job_id,kind,owner_kind,workspace_id,actor_id,document_id,pdf_export_request_id,
                 state,attempt,max_attempts,progress_percent,created_at,updated_at)
               VALUES(%s,'pdf_export','actor',%s,%s,%s,%s,'queued',0,3,0,now(),now())""",
            (
                ids["job"],
                ids["workspace"],
                ids["actor"],
                ids["document"],
                ids["request"],
            ),
        )
        connection.commit()

        repository = cast(
            PostgresPdfExportWorkerRepository,
            PostgresPdfExportWorkerRepository.connect(DATABASE_URL),
        )
        processor = DurablePdfExportProcessor(
            repository,
            LocalWorkerPrivateObjectStore(tmp_path),
            worker_id="pdf-worker-pg",
            font_path=FONT,
        )
        message = DispatchMessage("dispatch-pdf-pg", ids["job"], "trace-pdf-pg")

        assert processor.process(message).state == "succeeded"
        assert processor.process(message).state == "already_terminal"
        cursor.execute(
            """SELECT request.state,job.state,job.attempt,result.filename,result.page_count,
                      result.media_type,object.sha256,object.storage_generation
               FROM pdf_export_requests request
               JOIN processing_jobs job ON job.job_id=request.job_id
               JOIN pdf_export_results result
                 ON result.pdf_export_request_id=request.pdf_export_request_id
               JOIN object_references object
                 ON object.object_reference_id=result.object_reference_id
               WHERE request.pdf_export_request_id=%s""",
            (ids["request"],),
        )
        state = cursor.fetchone()
        assert state[:6] == ["succeeded", "succeeded", 1, "Canonical PDF.pdf", 1, "application/pdf"]
        assert state[6]
        assert state[7]
        cursor.execute(
            "SELECT event_kind FROM job_events WHERE job_id=%s ORDER BY cursor",
            (ids["job"],),
        )
        assert [row[0] for row in cursor.fetchall()] == [
            "pdf-export.leased",
            "pdf-export.started",
            "pdf-export.succeeded",
        ]
        cursor.execute(
            "SELECT action FROM audit_events WHERE workspace_id=%s AND resource_id=%s",
            (ids["workspace"], ids["request"]),
        )
        assert cursor.fetchone() == ["pdf.export-succeeded"]
        cursor.execute(
            """SELECT usage.customer_amount,usage.credit_debit,dimensions.dimensions
               FROM usage_events usage
               JOIN usage_admin_dimensions dimensions USING(usage_event_id)
               WHERE usage.workspace_id=%s AND usage.event_kind='pdf.export-succeeded'""",
            (ids["workspace"],),
        )
        usage = cursor.fetchone()
        assert usage[:2] == [0, 0]
        assert usage[2]["zero_charge"] is True
    finally:
        if repository is not None:
            repository.close()
        cursor.close()
        connection.close()
