"""Inject or repair one queued export profile for real-stack isolation tests.

This command is deliberately gated and is never imported by production code.
It simulates a persisted capability mismatch after API preflight so the real
worker's output isolation and retry path can be exercised without mocking it.
"""

from __future__ import annotations

import argparse
import json
import os
from typing import Any
from urllib.parse import unquote, urlparse

import pg8000.dbapi


def connect(database_url: str) -> Any:
    parsed = urlparse(database_url)
    return pg8000.dbapi.connect(
        user=unquote(parsed.username or ""),
        password=unquote(parsed.password or ""),
        host=parsed.hostname,
        port=parsed.port or 5432,
        database=unquote(parsed.path.lstrip("/")),
        timeout=30,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("output_id")
    parser.add_argument("format", choices=("avif", "png"))
    args = parser.parse_args()
    if os.environ.get("IPW_RECOVERY_2E_FAULT_INJECTION") != "1":
        raise RuntimeError("Recovery 2E fault injection is not enabled for this test process")
    database_url = os.environ.get("IPW_TEST_DATABASE_URL")
    if not database_url:
        raise RuntimeError("IPW_TEST_DATABASE_URL is required")
    connection = connect(database_url)
    cursor = connection.cursor()
    try:
        cursor.execute(
            """UPDATE image_export_outputs
               SET profile=jsonb_set(profile,'{format}',to_jsonb(%s::text),false)
               WHERE output_id=%s AND state='queued'
               RETURNING export_request_id,profile""",
            (args.format, args.output_id),
        )
        row = cursor.fetchone()
        if row is None:
            raise RuntimeError("fault target must be one queued export output")
        connection.commit()
        print(
            json.dumps(
                {
                    "output_id": args.output_id,
                    "export_request_id": str(row[0]),
                    "format": str(row[1]["format"]),
                },
                sort_keys=True,
            )
        )
    except Exception:
        connection.rollback()
        raise
    finally:
        cursor.close()
        connection.close()


if __name__ == "__main__":
    main()
