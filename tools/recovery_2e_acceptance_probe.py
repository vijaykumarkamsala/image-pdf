"""Read deterministic Recovery 2E real-stack evidence from PostgreSQL."""

from __future__ import annotations

import argparse
import json
import os
from typing import Any
from urllib.parse import unquote, urlparse

import pg8000.dbapi


def connect() -> Any:
    value = os.environ.get("IPW_TEST_DATABASE_URL")
    if not value:
        raise RuntimeError("IPW_TEST_DATABASE_URL is required")
    parsed = urlparse(value)
    if parsed.scheme not in {"postgres", "postgresql"} or not parsed.hostname:
        raise RuntimeError("IPW_TEST_DATABASE_URL must be a PostgreSQL URL")
    return pg8000.dbapi.connect(
        user=unquote(parsed.username or ""),
        password=unquote(parsed.password or ""),
        host=parsed.hostname,
        port=parsed.port or 5432,
        database=unquote(parsed.path.lstrip("/")),
        timeout=30,
    )


def evidence(connection: Any, workspace_id: str, export_request_id: str) -> dict[str, Any]:
    cursor = connection.cursor()
    try:
        cursor.execute(
            """SELECT request.state,job.state,outbox.state,outbox.delivery_attempts,
                      output.state,output.sha256,output.byte_size,
                      provenance.processor_name,provenance.processor_version,
                      provenance.metadata_verified,provenance.deterministic,
                      provenance.source_version_ids,
                      document.source_version_id
               FROM image_export_requests request
               JOIN processing_jobs job ON job.job_id=request.job_id
               JOIN job_outbox outbox ON outbox.job_id=job.job_id
               JOIN image_export_outputs output
                 ON output.export_request_id=request.export_request_id
               JOIN export_provenance provenance ON provenance.output_id=output.output_id
               JOIN editor_documents document ON document.document_id=request.document_id
               WHERE request.workspace_id=%s AND request.export_request_id=%s""",
            (workspace_id, export_request_id),
        )
        row = cursor.fetchone()
        if row is None:
            raise RuntimeError("completed export evidence was not found")
        source_ids = row[11] if isinstance(row[11], list) else json.loads(row[11])
        cursor.execute(
            """SELECT count(*) FROM audit_events
               WHERE workspace_id=%s AND resource_id=%s
                 AND action IN ('export.submitted','export.completed')""",
            (workspace_id, export_request_id),
        )
        audit_count = int(cursor.fetchone()[0])
        cursor.execute(
            """SELECT count(*),coalesce(sum(customer_amount),0),coalesce(sum(credit_debit),0)
               FROM usage_events WHERE workspace_id=%s
                 AND event_kind IN ('export.submitted','export.completed')""",
            (workspace_id,),
        )
        usage_count, amount, credit_debit = cursor.fetchone()
        cursor.execute(
            """SELECT bundle.state FROM export_bundles bundle
               WHERE bundle.workspace_id=%s AND bundle.export_request_id=%s
               ORDER BY bundle.created_at DESC LIMIT 1""",
            (workspace_id, export_request_id),
        )
        bundle = cursor.fetchone()
        return {
            "request_state": str(row[0]),
            "job_state": str(row[1]),
            "outbox_state": str(row[2]),
            "outbox_delivery_attempts": int(row[3]),
            "output_state": str(row[4]),
            "output_sha256": str(row[5]),
            "output_byte_size": int(row[6]),
            "processor_name": str(row[7]),
            "processor_version": str(row[8]),
            "metadata_verified": bool(row[9]),
            "deterministic": bool(row[10]),
            "source_identity_matches": str(row[12]) in source_ids,
            "audit_count": audit_count,
            "usage_count": int(usage_count),
            "customer_amount": int(amount),
            "credit_debit": int(credit_debit),
            "bundle_state": str(bundle[0]) if bundle else None,
        }
    finally:
        cursor.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("workspace_id")
    parser.add_argument("export_request_id")
    args = parser.parse_args()
    connection = connect()
    try:
        print(json.dumps(evidence(connection, args.workspace_id, args.export_request_id)))
    finally:
        connection.close()


if __name__ == "__main__":
    main()
