"""Run one durable job through deterministic local worker providers.

This is an acceptance-test entrypoint. Production task identity and provider
composition remain owned by ``ipw.processing_worker.task_server``.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

import pg8000.dbapi

from ipw.inspection import DeterministicMalwareScanner
from ipw.processing_worker.durable_intake import DispatchMessage, DurableIntakeProcessor
from ipw.processing_worker.preview import DurablePreviewProcessor
from ipw.processing_worker.repository import PostgresWorkerRepository
from ipw.storage import LocalWorkerPrivateObjectStore


def consume_local_dispatch(database_url: str, job_id: str) -> tuple[str, str]:
    """Bridge one durable outbox record into the deterministic local worker."""
    parsed = urlparse(database_url)
    connection: Any = pg8000.dbapi.connect(
        user=unquote(parsed.username or ""),
        password=unquote(parsed.password or ""),
        host=parsed.hostname,
        port=parsed.port or 5432,
        database=unquote(parsed.path.lstrip("/")),
        timeout=30,
    )
    cursor = connection.cursor()
    worker_id = "recovery-2d-local-dispatcher"
    try:
        cursor.execute(
            """SELECT outbox_id,trace_id,state,payload FROM job_outbox
               WHERE job_id=%s ORDER BY created_at FOR UPDATE""",
            (job_id,),
        )
        row = cursor.fetchone()
        if row is None or str(row[3].get("job_id")) != job_id:
            raise RuntimeError("durable process_job outbox record is missing or invalid")
        if row[2] == "pending":
            cursor.execute(
                """UPDATE job_outbox SET state='dispatching',lease_owner=%s,
                   lease_expires_at=now()+interval '30 seconds',delivery_attempts=delivery_attempts+1
                   WHERE outbox_id=%s AND state='pending'""",
                (worker_id, row[0]),
            )
            cursor.execute(
                """UPDATE job_outbox SET state='dispatched',dispatched_at=now(),
                   lease_owner=NULL,lease_expires_at=NULL
                   WHERE outbox_id=%s AND state='dispatching' AND lease_owner=%s""",
                (row[0], worker_id),
            )
        elif row[2] != "dispatched":
            raise RuntimeError(f"outbox record is not dispatchable: {row[2]}")
        connection.commit()
        return str(row[0]), str(row[1])
    except Exception:
        connection.rollback()
        raise
    finally:
        cursor.close()
        connection.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("job_id")
    parser.add_argument("--trace-id", default="trace-recovery-2d-acceptance")
    args = parser.parse_args()
    database_url = os.environ.get("IPW_TEST_DATABASE_URL")
    storage_root = os.environ.get("IPW_LOCAL_STORAGE_ROOT")
    if not database_url or not storage_root:
        raise RuntimeError("IPW_TEST_DATABASE_URL and IPW_LOCAL_STORAGE_ROOT are required")

    repository = PostgresWorkerRepository.connect(database_url)
    try:
        objects = LocalWorkerPrivateObjectStore(Path(storage_root))
        outbox_id, outbox_trace_id = consume_local_dispatch(database_url, args.job_id)
        kind = repository.job_kind(args.job_id)
        message = DispatchMessage(
            dispatch_id=outbox_id,
            job_id=args.job_id,
            trace_id=outbox_trace_id or args.trace_id,
        )
        if kind == "file_intake_inspection":
            processor = DurableIntakeProcessor(
                repository,
                objects,
                DeterministicMalwareScanner(),
                worker_id="recovery-2d-local-intake",
            )
        elif kind == "preview_generation":
            processor = DurablePreviewProcessor(
                repository,
                objects,
                worker_id="recovery-2d-local-preview",
            )
        else:
            raise RuntimeError(f"unsupported local acceptance job kind: {kind}")
        outcome = processor.process(message)
        print(json.dumps({"job_id": outcome.job_id, "outbox_id": outbox_id, "kind": kind, "state": outcome.state}))
        if outcome.state not in {"succeeded", "already_terminal"}:
            raise RuntimeError(f"local worker did not complete the job: {outcome.state}")
    finally:
        repository.close()


if __name__ == "__main__":
    main()
