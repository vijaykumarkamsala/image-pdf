"""The work queue: putting jobs in, claiming them, and finishing them.

**Why Postgres and not a queue product.** Cloud Tasks, Pub/Sub and Redis all do
this well, and every one of them is a second system that can be up when the
database is down, or hold a job whose row was rolled back. Enqueuing in the same
transaction as the row the job is about is worth more than the throughput any of
them would add: a job that says "compress asset 412" cannot exist unless asset
412 does. `SELECT ... FOR UPDATE SKIP LOCKED` has been the right tool for this
since Postgres 9.5, and the whole queue is one table.

**The claim is a single statement.** Selecting a job and then updating it in a
second statement is the classic way to hand the same job to two workers: between
the two, another worker reads the same row. Doing it in one `UPDATE ... WHERE id
= (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1)` makes the lock and the state
change the same event. SKIP LOCKED is what lets the second worker step over a
locked row instead of queueing behind it, which is the difference between ten
workers and one worker with nine spectators.

**Nothing here reads a clock.** Every time comes from the database - `now()` in
SQL - because the repository bans wall-clock reads for determinism, and because
three Cloud Run instances comparing their own clocks is a bug waiting for a leap
second. Backoff is arithmetic on the attempt count, turned into an interval by
Postgres.

**Workers die.** Cloud Run stops instances whenever it likes: mid-job, without
warning, with no chance to tidy up. A job left in `running` by a killed worker is
invisible to every other worker forever, so `reap_stalled` exists and is not
optional. That is also why `attempts` is incremented at claim time rather than at
completion - a job that kills its worker each time must eventually stop being
retried, and a counter that only increments on a clean failure never notices.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Protocol

__all__ = [
    "MAX_BACKOFF_SECONDS",
    "STALLED_AFTER_SECONDS",
    "Job",
    "backoff_seconds",
    "claim",
    "enqueue",
    "fail",
    "reap_stalled",
    "succeed",
]

# How long a job may sit in `running` before it is assumed abandoned.
#
# Longer than the longest job that legitimately runs, or a slow job is reaped
# while still working and runs twice. Cloud Run's request timeout is set to 600
# seconds in deploy/README.md, so anything past twice that is not slow, it is
# gone.
STALLED_AFTER_SECONDS = 1_200

# Retries back off exponentially, but not indefinitely: past a few minutes the
# delay stops being backoff and starts being a job nobody notices has stalled.
MAX_BACKOFF_SECONDS = 600


class _Cursor(Protocol):
    def execute(self, operation: str, args: Any = ...) -> Any: ...
    def fetchall(self) -> list[Any]: ...
    def close(self) -> None: ...


class _Connection(Protocol):
    def cursor(self) -> _Cursor: ...
    def commit(self) -> None: ...
    def rollback(self) -> None: ...


@dataclass(frozen=True)
class Job:
    """A claimed unit of work, with what the worker needs to decide about it."""

    id: int
    kind: str
    payload: dict[str, Any]
    attempts: int
    max_attempts: int
    account_id: int | None = None

    @property
    def is_final_attempt(self) -> bool:
        """Whether failing now means failing for good.

        Worth knowing inside a handler: the last attempt is the one where it is
        worth spending time on a good error message, because nobody will see a
        better one later.
        """
        return self.attempts >= self.max_attempts


def backoff_seconds(attempts: int) -> int:
    """How long to wait before retrying, given how many attempts have happened.

    Doubling from four seconds, capped. Pure arithmetic so it is testable and so
    the value that goes into the database is not a wall-clock read: Postgres
    turns it into an instant with ``now() + interval``.

    Capped because an hour-long backoff is indistinguishable from a job that has
    silently stopped, and the queue is also the place people look to find out
    whether anything is happening.
    """
    if attempts < 1:
        return 0
    return min(MAX_BACKOFF_SECONDS, int(2 ** min(attempts + 1, 20)))


def enqueue(
    connection: _Connection,
    kind: str,
    payload: dict[str, Any] | None = None,
    *,
    account_id: int | None = None,
    priority: int = 100,
    max_attempts: int = 3,
    delay_seconds: int = 0,
) -> int:
    """Add a job and return its id.

    Deliberately does **not** commit. The caller decides the transaction, which
    is the entire reason for keeping the queue in Postgres: enqueuing the job
    and writing the row it refers to should either both happen or neither.
    """
    if not kind.strip():
        msg = "a job needs a kind"
        raise ValueError(msg)
    if max_attempts < 1:
        msg = f"max_attempts must be at least 1, got {max_attempts}"
        raise ValueError(msg)

    cursor = connection.cursor()
    try:
        cursor.execute(
            "INSERT INTO jobs (account_id, kind, payload, priority, max_attempts, run_after) "
            "VALUES (%s, %s, %s, %s, %s, now() + make_interval(secs => %s)) "
            "RETURNING id",
            (
                account_id,
                kind,
                json.dumps(payload or {}, sort_keys=True),
                priority,
                max_attempts,
                max(0, delay_seconds),
            ),
        )
        rows = cursor.fetchall()
    finally:
        cursor.close()
    return int(rows[0][0])


def claim(connection: _Connection, worker: str, kinds: tuple[str, ...] = ()) -> Job | None:
    """Take the next job for this worker, or None if there is nothing to do.

    One statement, on purpose: selecting and then updating lets another worker
    read the same row in between and run the job twice. SKIP LOCKED steps over
    rows another worker already holds rather than waiting behind them.

    ``kinds`` lets a worker take only what it can handle - a machine with the
    OCR engine installed, say - without a second queue. An empty tuple means
    anything.
    """
    if not worker.strip():
        msg = "a worker must identify itself, so a stuck job can name who holds it"
        raise ValueError(msg)

    # A constant statement with a nullable filter, rather than SQL assembled
    # from a condition. The assembled version was not injectable - the fragment
    # was a literal - but "this string is safe because of where it came from" is
    # exactly the reasoning that stops being true after somebody refactors it.
    # Passing NULL for "no filter" keeps the decision in the arguments.
    selector = list(kinds) if kinds else None

    cursor = connection.cursor()
    try:
        cursor.execute(
            "UPDATE jobs SET "
            "  state = 'running', "
            "  locked_at = now(), "
            "  locked_by = %s, "
            "  attempts = attempts + 1, "
            "  updated_at = now() "
            "WHERE id = ( "
            "  SELECT id FROM jobs "
            "  WHERE state = 'queued' AND run_after <= now() "
            "    AND (%s::text[] IS NULL OR kind = ANY(%s::text[])) "
            "  ORDER BY priority, run_after, id "
            "  FOR UPDATE SKIP LOCKED "
            "  LIMIT 1 "
            ") "
            "RETURNING id, kind, payload, attempts, max_attempts, account_id",
            (worker, selector, selector),
        )
        rows = cursor.fetchall()
    finally:
        cursor.close()

    if not rows:
        return None

    row = rows[0]
    payload = row[2]
    return Job(
        id=int(row[0]),
        kind=str(row[1]),
        # pg8000 returns jsonb already decoded; a driver that hands back text
        # should not change what a handler receives.
        payload=json.loads(payload) if isinstance(payload, str) else dict(payload or {}),
        attempts=int(row[3]),
        max_attempts=int(row[4]),
        account_id=None if row[5] is None else int(row[5]),
    )


def succeed(connection: _Connection, job_id: int, result: dict[str, Any] | None = None) -> None:
    """Mark a job done. The result is a summary, never the output bytes."""
    cursor = connection.cursor()
    try:
        cursor.execute(
            "UPDATE jobs SET state = 'succeeded', result = %s, error = NULL, "
            "locked_by = NULL, locked_at = NULL, updated_at = now() "
            "WHERE id = %s",
            (json.dumps(result or {}, sort_keys=True), job_id),
        )
    finally:
        cursor.close()


def fail(connection: _Connection, job: Job, error: str) -> None:
    """Record a failure, and either schedule a retry or give up.

    **Takes the claimed job rather than an id**, so the backoff is computed once,
    in Python, by ``backoff_seconds``. Writing the same doubling rule a second
    time as a SQL expression would give the retry policy two definitions that
    nothing forces to agree - and the SQL one is the copy that actually runs
    while the Python one is the copy that gets tested.

    The *state* decision stays in SQL, deliberately: whether this failure was the
    last one is a question about the row's own counters, and a worker that has
    just failed is not the most reliable source for how many times it has failed.
    Two workers cannot disagree about a number only the database holds.
    """
    cursor = connection.cursor()
    try:
        cursor.execute(
            "UPDATE jobs SET "
            "  state = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END, "
            "  error = %s, "
            "  locked_by = NULL, "
            "  locked_at = NULL, "
            "  run_after = now() + make_interval(secs => %s), "
            "  updated_at = now() "
            "WHERE id = %s",
            (error, backoff_seconds(job.attempts), job.id),
        )
    finally:
        cursor.close()


def reap_stalled(connection: _Connection, older_than_seconds: int = STALLED_AFTER_SECONDS) -> int:
    """Return jobs abandoned by dead workers to the queue. Returns how many.

    Not optional. Cloud Run stops instances mid-request without warning, and a
    job left in `running` is invisible to every other worker for as long as the
    table exists.

    A job that has already used its attempts is failed rather than requeued: if
    it kills a worker every time, retrying it forever costs an instance each
    time and hides the fact that something is wrong with the job itself.
    """
    cursor = connection.cursor()
    try:
        cursor.execute(
            "UPDATE jobs SET "
            "  state = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END, "
            "  error = COALESCE(error, 'worker stopped without reporting a result'), "
            "  locked_by = NULL, "
            "  locked_at = NULL, "
            "  updated_at = now() "
            "WHERE state = 'running' "
            "  AND locked_at < now() - make_interval(secs => %s) "
            "RETURNING id",
            (max(1, older_than_seconds),),
        )
        rows = cursor.fetchall()
    finally:
        cursor.close()
    return len(rows)
