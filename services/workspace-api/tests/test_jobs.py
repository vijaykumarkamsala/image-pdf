"""The work queue, tested for the properties that make it safe.

A queue is easy to write and hard to write correctly, and the failures are all
concurrency failures: the same job running twice, a job nobody can see, a poison
job retried forever. None of those show up in a happy-path test, and none of
them need a database to check - they are properties of the SQL that gets sent.

So these tests read the statements. That is unusual, and it is deliberate: the
difference between a correct claim and a broken one is `FOR UPDATE SKIP LOCKED`
and whether it is one statement or two, and both are visible in the text.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from ipw.workspace_api.jobs import (
    MAX_BACKOFF_SECONDS,
    Job,
    backoff_seconds,
    claim,
    enqueue,
    fail,
    reap_stalled,
    succeed,
)


class FakeCursor:
    def __init__(self, connection: FakeConnection) -> None:
        self._connection = connection

    def execute(self, operation: str, args: Any = None) -> None:
        self._connection.statements.append((operation, args))

    def fetchall(self) -> list[Any]:
        return self._connection.rows

    def close(self) -> None:
        self._connection.cursors_closed += 1


class FakeConnection:
    def __init__(self, rows: list[Any] | None = None) -> None:
        self.rows = rows if rows is not None else []
        self.statements: list[tuple[str, Any]] = []
        self.commits = 0
        self.cursors_closed = 0

    def cursor(self) -> FakeCursor:
        return FakeCursor(self)

    def commit(self) -> None:
        self.commits += 1

    def rollback(self) -> None:
        pass

    @property
    def sql(self) -> str:
        return " ".join(sql for sql, _ in self.statements)

    @property
    def args(self) -> Any:
        return self.statements[-1][1]


def _job(*, attempts: int = 1, max_attempts: int = 3) -> Job:
    return Job(id=7, kind="compress", payload={}, attempts=attempts, max_attempts=max_attempts)


class TestBackoff:
    def test_no_attempts_means_no_wait(self) -> None:
        assert backoff_seconds(0) == 0
        assert backoff_seconds(-1) == 0

    def test_it_doubles(self) -> None:
        assert [backoff_seconds(n) for n in (1, 2, 3, 4)] == [4, 8, 16, 32]

    def test_it_is_capped(self) -> None:
        """An hour-long backoff is indistinguishable from a job that has stopped,
        and the queue is where people look to find out whether anything is
        happening."""
        assert backoff_seconds(50) == MAX_BACKOFF_SECONDS
        assert backoff_seconds(1000) == MAX_BACKOFF_SECONDS

    def test_it_never_overflows(self) -> None:
        """2 ** attempts with an unbounded attempts is an integer big enough to
        hang the process formatting it."""
        assert backoff_seconds(10**6) == MAX_BACKOFF_SECONDS


class TestEnqueue:
    def test_it_returns_the_new_id(self) -> None:
        connection = FakeConnection(rows=[(42,)])

        assert enqueue(connection, "compress", {"asset": 7}) == 42

    def test_it_does_not_commit(self) -> None:
        """The caller owns the transaction, and that is the whole reason the
        queue lives in Postgres: the job and the row it refers to must either
        both exist or neither. A commit here would break that."""
        connection = FakeConnection(rows=[(1,)])

        enqueue(connection, "compress")

        assert connection.commits == 0

    def test_the_payload_is_serialised_deterministically(self) -> None:
        """Two identical payloads must produce identical rows, or comparing them
        later - in a test, in a digest, by eye - stops working."""
        connection = FakeConnection(rows=[(1,)])

        enqueue(connection, "compress", {"b": 2, "a": 1})

        payload = next(a for a in connection.args if isinstance(a, str) and a.startswith("{"))
        assert payload == json.dumps({"a": 1, "b": 2}, sort_keys=True)

    def test_the_delay_becomes_an_interval_in_sql(self) -> None:
        """Not a timestamp computed in Python. The database owns the clock."""
        connection = FakeConnection(rows=[(1,)])

        enqueue(connection, "compress", delay_seconds=30)

        assert "now() + make_interval" in connection.sql
        assert 30 in connection.args

    def test_a_negative_delay_is_treated_as_none(self) -> None:
        connection = FakeConnection(rows=[(1,)])

        enqueue(connection, "compress", delay_seconds=-5)

        assert 0 in connection.args

    @pytest.mark.parametrize(("kind", "expected"), [("", "needs a kind"), ("   ", "needs a kind")])
    def test_a_job_without_a_kind_is_refused(self, kind: str, expected: str) -> None:
        with pytest.raises(ValueError, match=expected):
            enqueue(FakeConnection(), kind)

    def test_zero_attempts_is_refused(self) -> None:
        """A job that may never be attempted is not a job."""
        with pytest.raises(ValueError, match="max_attempts must be at least 1"):
            enqueue(FakeConnection(), "compress", max_attempts=0)

    def test_the_cursor_is_closed(self) -> None:
        connection = FakeConnection(rows=[(1,)])

        enqueue(connection, "compress")

        assert connection.cursors_closed == 1


class TestClaim:
    def _claimed(self) -> list[Any]:
        return [(7, "compress", {"asset": 1}, 1, 3, 55)]

    def test_it_is_one_statement(self) -> None:
        """Selecting and then updating is the classic way to hand one job to two
        workers: between the two statements another worker reads the same row."""
        connection = FakeConnection(rows=self._claimed())

        claim(connection, "worker-1")

        assert len(connection.statements) == 1

    def test_it_locks_and_skips(self) -> None:
        """SKIP LOCKED is what makes ten workers ten workers, rather than one
        worker and nine waiting behind the same row."""
        connection = FakeConnection(rows=self._claimed())

        claim(connection, "worker-1")

        assert "FOR UPDATE SKIP LOCKED" in connection.sql

    def test_it_takes_the_highest_priority_oldest_job(self) -> None:
        connection = FakeConnection(rows=self._claimed())

        claim(connection, "worker-1")

        assert "ORDER BY priority, run_after, id" in connection.sql
        assert "LIMIT 1" in connection.sql

    def test_it_does_not_claim_work_scheduled_for_later(self) -> None:
        connection = FakeConnection(rows=self._claimed())

        claim(connection, "worker-1")

        assert "run_after <= now()" in connection.sql
        assert "state = 'queued'" in connection.sql

    def test_attempts_increment_when_the_job_is_taken_not_when_it_fails(self) -> None:
        """A job that kills its worker never reports a failure. If the counter
        only moved on a clean failure, such a job would be retried forever, one
        dead instance at a time."""
        connection = FakeConnection(rows=self._claimed())

        claim(connection, "worker-1")

        assert "attempts = attempts + 1" in connection.sql

    def test_the_worker_records_who_it_is(self) -> None:
        """When a job is stuck the first question is which instance holds it,
        and 'some worker' is not an answer."""
        connection = FakeConnection(rows=self._claimed())

        claim(connection, "instance-abc")

        assert "locked_by = %s" in connection.sql
        assert "instance-abc" in connection.args

    def test_an_anonymous_worker_is_refused(self) -> None:
        with pytest.raises(ValueError, match="must identify itself"):
            claim(FakeConnection(), "  ")

    def test_nothing_to_do_returns_none(self) -> None:
        assert claim(FakeConnection(rows=[]), "worker-1") is None

    def test_the_claimed_job_is_returned_whole(self) -> None:
        job = claim(FakeConnection(rows=self._claimed()), "worker-1")

        assert job == Job(
            id=7, kind="compress", payload={"asset": 1}, attempts=1, max_attempts=3, account_id=55
        )

    def test_a_payload_returned_as_text_is_still_a_dict(self) -> None:
        """pg8000 decodes jsonb, but a handler must not have to know which driver
        it is running behind."""
        rows = [(7, "compress", '{"asset": 1}', 1, 3, None)]

        job = claim(FakeConnection(rows=rows), "worker-1")

        assert job is not None
        assert job.payload == {"asset": 1}
        assert job.account_id is None

    def test_a_worker_can_take_only_the_kinds_it_handles(self) -> None:
        """A machine with the OCR engine installed should be able to take OCR
        work without a second queue existing."""
        connection = FakeConnection(rows=self._claimed())

        claim(connection, "worker-1", kinds=("recognise", "redact"))

        assert ["recognise", "redact"] in connection.args

    def test_without_kinds_it_takes_anything(self) -> None:
        """The filter is switched off by passing NULL, not by building a
        different statement - so there is only ever one claim query."""
        connection = FakeConnection(rows=self._claimed())

        claim(connection, "worker-1")

        assert None in connection.args

    def test_the_claim_query_is_the_same_string_either_way(self) -> None:
        """SQL assembled from a condition is how an injectable query starts life
        looking safe. Only the arguments differ here."""
        anything = FakeConnection(rows=self._claimed())
        filtered = FakeConnection(rows=self._claimed())

        claim(anything, "worker-1")
        claim(filtered, "worker-1", kinds=("recognise",))

        assert anything.sql == filtered.sql


class TestFinishing:
    def test_success_clears_the_lock_and_the_error(self) -> None:
        connection = FakeConnection()

        succeed(connection, 7, {"bytes": 100})

        assert "state = 'succeeded'" in connection.sql
        assert "error = NULL" in connection.sql
        assert "locked_by = NULL" in connection.sql

    def test_failure_decides_retry_or_give_up_in_sql(self) -> None:
        """Against the row's own counters, not a number the worker passes in. A
        worker that has just failed is not the best source for how many times it
        has failed, and two workers cannot disagree about a value only the
        database holds."""
        connection = FakeConnection()

        fail(connection, _job(attempts=1), "decoder said no")

        assert (
            "CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END" in connection.sql
        )
        assert "decoder said no" in connection.args

    def test_a_retry_is_delayed_by_the_one_backoff_rule(self) -> None:
        """The delay must come from backoff_seconds, not from a second copy of
        the doubling rule written as a SQL expression. Two definitions of a
        retry policy is one too many, and the SQL copy is the one that runs
        while the Python copy is the one that gets tested."""
        connection = FakeConnection()

        fail(connection, _job(attempts=3), "boom")

        assert "run_after = now() + make_interval" in connection.sql
        assert backoff_seconds(3) in connection.args

    def test_the_delay_grows_with_the_attempt(self) -> None:
        first, later = FakeConnection(), FakeConnection()

        fail(first, _job(attempts=1), "boom")
        fail(later, _job(attempts=4), "boom")

        assert backoff_seconds(1) in first.args
        assert backoff_seconds(4) in later.args
        assert backoff_seconds(4) > backoff_seconds(1)


class TestReaping:
    def test_stalled_jobs_go_back_to_the_queue(self) -> None:
        """Cloud Run stops instances mid-request without warning. A job left in
        'running' is invisible to every other worker for as long as the table
        exists."""
        connection = FakeConnection(rows=[(1,), (2,)])

        assert reap_stalled(connection) == 2
        assert "state = 'running'" in connection.sql
        assert "locked_at < now() - make_interval" in connection.sql

    def test_a_job_out_of_attempts_is_failed_rather_than_requeued(self) -> None:
        """If it kills a worker every time, retrying it forever costs an instance
        each time and hides that something is wrong with the job itself."""
        connection = FakeConnection(rows=[])

        reap_stalled(connection)

        assert (
            "CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END" in connection.sql
        )

    def test_the_reason_is_recorded_without_overwriting_a_real_error(self) -> None:
        connection = FakeConnection(rows=[])

        reap_stalled(connection)

        assert "COALESCE(error," in connection.sql

    def test_a_nonsense_window_cannot_reap_live_jobs(self) -> None:
        """A zero-second window would return every running job to the queue,
        including the ones currently being worked on."""
        connection = FakeConnection(rows=[])

        reap_stalled(connection, older_than_seconds=0)

        assert 1 in connection.args


class TestTheModuleTakesNoClock:
    def test_it_never_reads_a_wall_clock(self) -> None:
        """Every time comes from the database.

        The repository bans datetime.now and time.time for determinism, and
        three Cloud Run instances comparing their own clocks is a bug waiting
        for a leap second. Checked as source because an import added later would
        pass every other test here.
        """
        from pathlib import Path

        import ipw.workspace_api.jobs as module

        source = Path(module.__file__).read_text(encoding="utf-8")

        for banned in ("datetime", "time.time", "utcnow"):
            assert banned not in source, f"{banned} appeared in the queue module"

    def test_every_statement_that_sets_a_time_uses_the_database_clock(self) -> None:
        connection = FakeConnection(rows=[(1,)])
        enqueue(connection, "k")
        claim(FakeConnection(rows=[]), "w")
        succeed(connection, 1)
        fail(connection, _job(), "e")
        reap_stalled(connection)

        for sql, _ in connection.statements:
            if "updated_at" in sql or "run_after" in sql or "locked_at" in sql:
                assert "now()" in sql, f"a time was set without the database clock: {sql[:60]}"
