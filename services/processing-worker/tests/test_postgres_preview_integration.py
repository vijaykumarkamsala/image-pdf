from __future__ import annotations

import hashlib
import io
import json
import os
import secrets
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

import pg8000.dbapi
import pytest
from PIL import Image

from ipw.processing_worker.durable_intake import DispatchMessage
from ipw.processing_worker.preview import DurablePreviewProcessor
from ipw.processing_worker.repository import PostgresWorkerRepository
from ipw.storage import LocalWorkerPrivateObjectStore

DATABASE_URL = os.environ.get("IPW_TEST_DATABASE_URL")


def connect() -> Any:
    assert DATABASE_URL
    parsed = urlparse(DATABASE_URL)
    return pg8000.dbapi.connect(
        user=unquote(parsed.username or ""), password=unquote(parsed.password or ""),
        host=parsed.hostname, port=parsed.port or 5432, database=unquote(parsed.path.lstrip("/")),
    )


def large_png() -> bytes:
    output = io.BytesIO()
    Image.new("RGB", (5000, 5000), (40, 110, 188)).save(output, "PNG", compress_level=1)
    return output.getvalue()


@pytest.mark.skipif(not DATABASE_URL, reason="IPW_TEST_DATABASE_URL is required")
def test_real_postgres_preview_job_records_provenance_audit_and_zero_charge(tmp_path: Path) -> None:
    assert DATABASE_URL
    data = large_png()
    digest = hashlib.sha256(data).hexdigest()
    suffix = secrets.token_hex(4)
    ids = {name: f"{name}-preview-pg-{suffix}" for name in (
        "actor", "workspace", "default", "object", "asset", "source", "file", "document", "version", "job"
    )}
    object_key = f"immutable/{ids['workspace']}/{digest}"
    source_path = tmp_path / object_key
    source_path.parent.mkdir(parents=True)
    source_path.write_bytes(data)
    connection = connect()
    cursor = connection.cursor()
    snapshot = {
        "schema_version": "1.16.0", "document_id": ids["document"], "revision": 0,
        "artboards": [{"artboard_id": "artboard-preview", "width": 5000, "height": 5000}],
        "layers": [], "masks": [], "shared_assets": [], "shared_styles": [],
    }
    try:
        cursor.execute("INSERT INTO actors(actor_id,display_name,created_at) VALUES(%s,'Preview actor',now())", (ids["actor"],))
        cursor.execute("INSERT INTO workspaces(workspace_id,name,created_at) VALUES(%s,'Preview workspace',now())", (ids["workspace"],))
        cursor.execute("INSERT INTO default_files_locations(default_files_id,workspace_id) VALUES(%s,%s)", (ids["default"], ids["workspace"]))
        cursor.execute(
            "INSERT INTO object_references(object_reference_id,workspace_id,object_key,sha256,media_type,byte_size,created_at) VALUES(%s,%s,%s,%s,'image/png',%s,now())",
            (ids["object"], ids["workspace"], object_key, digest, len(data)),
        )
        cursor.execute(
            "INSERT INTO asset_originals(asset_original_id,workspace_id,object_reference_id,original_filename,created_at) VALUES(%s,%s,%s,'large.png',now())",
            (ids["asset"], ids["workspace"], ids["object"]),
        )
        cursor.execute(
            "INSERT INTO source_versions(source_version_id,workspace_id,asset_original_id,object_reference_id,sequence,created_at) VALUES(%s,%s,%s,%s,1,now())",
            (ids["source"], ids["workspace"], ids["asset"], ids["object"]),
        )
        cursor.execute(
            """INSERT INTO workspace_files(file_id,workspace_id,asset_original_id,current_source_version_id,
                 display_name,canonical_location_kind,default_files_id,created_at,updated_at)
               VALUES(%s,%s,%s,%s,'large.png','default_files',%s,now(),now())""",
            (ids["file"], ids["workspace"], ids["asset"], ids["source"], ids["default"]),
        )
        cursor.execute(
            """INSERT INTO editor_documents(document_id,workspace_id,location_kind,default_files_id,kind,name,
                 source_file_id,source_asset_original_id,source_version_id,current_version_id,current_snapshot,
                 created_by_actor_id,created_at,updated_at,preview_state,preview_job_id)
               VALUES(%s,%s,'default_files',%s,'graphic','Large preview',%s,%s,%s,%s,%s::jsonb,%s,now(),now(),'preparing',%s)""",
            (ids["document"], ids["workspace"], ids["default"], ids["file"], ids["asset"], ids["source"],
             ids["version"], json.dumps(snapshot), ids["actor"], ids["job"]),
        )
        cursor.execute(
            """INSERT INTO document_versions(document_version_id,document_id,sequence,revision,kind,name,
                 snapshot_sha256,snapshot,created_by_actor_id,created_at)
               VALUES(%s,%s,1,0,'initial','Initial',%s,%s::jsonb,%s,now())""",
            (ids["version"], ids["document"], "a" * 64, json.dumps(snapshot), ids["actor"]),
        )
        cursor.execute(
            """INSERT INTO processing_jobs(job_id,kind,owner_kind,workspace_id,actor_id,document_id,
                 state,attempt,max_attempts,progress_percent,created_at,updated_at)
               VALUES(%s,'preview_generation','actor',%s,%s,%s,'queued',0,3,0,now(),now())""",
            (ids["job"], ids["workspace"], ids["actor"], ids["document"]),
        )
        connection.commit()

        repository = PostgresWorkerRepository.connect(DATABASE_URL)
        processor = DurablePreviewProcessor(repository, LocalWorkerPrivateObjectStore(tmp_path), worker_id="preview-worker-pg")
        message = DispatchMessage("dispatch-preview-pg", ids["job"], "trace-preview-pg")

        assert processor.process(message).state == "succeeded"
        assert processor.process(message).state == "already_terminal"
        assert source_path.read_bytes() == data

        cursor.execute("SELECT state,progress_percent FROM processing_jobs WHERE job_id=%s", (ids["job"],))
        assert cursor.fetchone() == ["succeeded", 100]
        cursor.execute("SELECT preview_state,current_preview_id FROM editor_documents WHERE document_id=%s", (ids["document"],))
        state, current_preview = cursor.fetchone()
        assert state == "ready" and current_preview
        cursor.execute(
            "SELECT zoom_level,width,height,source_sha256,authoritative FROM preview_provenance WHERE job_id=%s ORDER BY zoom_level",
            (ids["job"],),
        )
        provenance = cursor.fetchall()
        assert [row[0] for row in provenance] == ["thumbnail", "workspace"]
        assert all(row[1] <= 2048 and row[2] <= 2048 and row[3] == digest and row[4] is False for row in provenance)
        cursor.execute("SELECT count(*) FROM object_references WHERE workspace_id=%s AND object_key LIKE 'derivative/%%'", (ids["workspace"],))
        assert cursor.fetchone()[0] == 2
        cursor.execute("SELECT action FROM audit_events WHERE resource_id=%s", (ids["document"],))
        assert "preview.generated" in [row[0] for row in cursor.fetchall()]
        cursor.execute("SELECT customer_amount,credit_debit FROM usage_events WHERE event_kind='preview.generated' AND workspace_id=%s", (ids["workspace"],))
        assert cursor.fetchone() == [0, 0]
        repository.close()
    finally:
        cursor.close()
        connection.close()
