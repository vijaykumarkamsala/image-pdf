"""Database setup and evidence queries for the isolated Recovery 2D browser test."""

from __future__ import annotations

import argparse
import json
import os
import secrets
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


def grant_member(connection: Any, workspace_id: str, actor_id: str, role: str) -> None:
    cursor = connection.cursor()
    try:
        cursor.execute(
            "INSERT INTO actors(actor_id,display_name,created_at) VALUES(%s,%s,now()) "
            "ON CONFLICT(actor_id) DO NOTHING",
            (actor_id, "Recovery 2D collaborator"),
        )
        cursor.execute(
            """INSERT INTO memberships(membership_id,workspace_id,actor_id,role,created_at)
               VALUES(%s,%s,%s,%s,now()) ON CONFLICT(workspace_id,actor_id)
               DO UPDATE SET role=excluded.role""",
            (f"membership-{secrets.token_hex(12)}", workspace_id, actor_id, role),
        )
        connection.commit()
    finally:
        cursor.close()


def evidence(connection: Any, workspace_id: str, document_id: str) -> dict[str, Any]:
    cursor = connection.cursor()
    try:
        cursor.execute(
            "SELECT count(*) FROM audit_events WHERE workspace_id=%s AND resource_id=%s",
            (workspace_id, document_id),
        )
        audit_count = int(cursor.fetchone()[0])
        cursor.execute(
            """SELECT count(*),coalesce(sum(customer_amount),0),coalesce(sum(credit_debit),0)
               FROM usage_events WHERE workspace_id=%s""",
            (workspace_id,),
        )
        usage_count, amount, credit_debit = cursor.fetchone()
        cursor.execute(
            """SELECT count(*),coalesce(max(width),0),coalesce(max(height),0),
                      bool_and(authoritative=false)
               FROM preview_provenance WHERE document_id=%s""",
            (document_id,),
        )
        preview_count, preview_width, preview_height, previews_non_authoritative = cursor.fetchone()
        cursor.execute(
            "SELECT state,kind,attempt,progress_percent FROM processing_jobs "
            "WHERE document_id=%s ORDER BY created_at",
            (document_id,),
        )
        jobs = [
            {"state": row[0], "kind": row[1], "attempt": int(row[2]), "progress": int(row[3])}
            for row in cursor.fetchall()
        ]
        cursor.execute(
            """SELECT count(*),bool_and(outbox.state='dispatched'),
                      coalesce(sum(outbox.delivery_attempts),0)
               FROM job_outbox outbox JOIN processing_jobs job USING(job_id)
               WHERE job.document_id=%s""",
            (document_id,),
        )
        outbox_count, outbox_dispatched, delivery_attempts = cursor.fetchone()
        cursor.execute(
            """SELECT source.sha256,bool_and(preview.source_sha256=source.sha256)
               FROM editor_documents document
               JOIN source_versions version ON version.source_version_id=document.source_version_id
               JOIN object_references source
                 ON source.object_reference_id=version.object_reference_id
               LEFT JOIN preview_provenance preview ON preview.document_id=document.document_id
               WHERE document.document_id=%s GROUP BY source.sha256""",
            (document_id,),
        )
        source_row = cursor.fetchone()
        return {
            "audit_count": audit_count,
            "usage_count": int(usage_count),
            "customer_amount": int(amount),
            "credit_debit": int(credit_debit),
            "preview_count": int(preview_count),
            "preview_max_width": int(preview_width),
            "preview_max_height": int(preview_height),
            "previews_non_authoritative": bool(previews_non_authoritative),
            "jobs": jobs,
            "outbox_count": int(outbox_count),
            "outbox_dispatched": bool(outbox_dispatched),
            "outbox_delivery_attempts": int(delivery_attempts),
            "source_sha256": str(source_row[0]) if source_row else None,
            "preview_source_hashes_match": bool(source_row[1]) if source_row else False,
        }
    finally:
        cursor.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    subcommands = parser.add_subparsers(dest="command", required=True)
    grant = subcommands.add_parser("grant-member")
    grant.add_argument("workspace_id")
    grant.add_argument("actor_id")
    grant.add_argument("--role", choices=("owner", "admin", "member", "viewer"), default="member")
    report = subcommands.add_parser("evidence")
    report.add_argument("workspace_id")
    report.add_argument("document_id")
    args = parser.parse_args()
    connection = connect()
    try:
        if args.command == "grant-member":
            grant_member(connection, args.workspace_id, args.actor_id, args.role)
            print(
                json.dumps(
                    {
                        "state": "granted",
                        "workspace_id": args.workspace_id,
                        "actor_id": args.actor_id,
                        "role": args.role,
                    }
                )
            )
        else:
            print(json.dumps(evidence(connection, args.workspace_id, args.document_id)))
    finally:
        connection.close()


if __name__ == "__main__":
    main()
