"""The worker loop: what it claims, what it does when a handler explodes, and
how it behaves when Cloud Run asks it to stop.

The interesting cases are all the unhappy ones. A worker that runs a job and
marks it done is easy; a worker that leaves a job locked forever because a
handler raised, or that keeps claiming work after SIGTERM, is the one that costs
somebody an afternoon.
"""

from __future__ import annotations

import os
from typing import Any

import pytest

from ipw.workspace_api.jobs import Job
from ipw.workspace_api.worker import Worker, worker_name


class FakeCursor:
    def __init__(self, connection: FakeConnection) -> None:
        self._connection = connection

    def execute(self, operation: str, args: Any = None) -> None:
        self._connection.statements.append((operation, args))

    def fetchall(self) -> list[Any]:
        return self._connection.next_rows()

    def close(self) -> None:
        pass


class FakeConnection:
    """Hands out a queue of claim results, then nothing."""

    def __init__(self, claims: list[list[Any]] | None = None) -> None:
        self._claims = list(claims or [])
        self.statements: list[tuple[str, Any]] = []
        self.commits = 0
        self.closed = False

    def next_rows(self) -> list[Any]:
        return self._claims.pop(0) if self._claims else []

    def cursor(self) -> FakeCursor:
        return FakeCursor(self)

    def commit(self) -> None:
        self.commits += 1

    def rollback(self) -> None:
        pass

    def close(self) -> None:
        self.closed = True

    @property
    def sql(self) -> str:
        return " ".join(sql for sql, _ in self.statements)


def _claim_row(kind: str = "compress", attempts: int = 1) -> list[Any]:
    return [(7, kind, {"asset": 1}, attempts, 3, None)]


class TestWhatItClaims:
    def test_a_worker_claims_only_the_kinds_it_can_run(self) -> None:
        """So 'no handler for this kind' is not a failure at all - it is work
        this worker never takes, and another deployment can."""
        worker = Worker(handlers={"compress": lambda _job: None, "redact": lambda _job: None})

        assert worker.kinds == ("compress", "redact")

    def test_a_worker_with_no_handlers_is_refused(self) -> None:
        with pytest.raises(ValueError, match="no handlers"):
            Worker(handlers={})

    def test_the_kinds_are_passed_to_the_claim(self) -> None:
        connection = FakeConnection(claims=[_claim_row()])
        worker = Worker(handlers={"compress": lambda _job: None}, name="w1")

        worker.run_once(connection)

        first_args = next(args for _sql, args in connection.statements)
        assert ["compress"] in first_args


class TestRunningAJob:
    def test_a_successful_job_is_marked_succeeded(self) -> None:
        connection = FakeConnection(claims=[_claim_row()])
        worker = Worker(handlers={"compress": lambda _job: {"bytes": 10}}, name="w1")

        job = worker.run_once(connection)

        assert job is not None
        assert "state = 'succeeded'" in connection.sql

    def test_the_handler_receives_the_job(self) -> None:
        seen: list[Job] = []
        connection = FakeConnection(claims=[_claim_row()])
        worker = Worker(handlers={"compress": seen.append}, name="w1")

        worker.run_once(connection)

        assert seen[0].id == 7
        assert seen[0].payload == {"asset": 1}

    def test_the_claim_is_committed_before_the_handler_runs(self) -> None:
        """Otherwise the row stays locked for the length of the work, and every
        other worker's claim query steps over it for minutes."""
        commits_when_called: list[int] = []
        connection = FakeConnection(claims=[_claim_row()])

        def handler(_job: Job) -> None:
            commits_when_called.append(connection.commits)

        Worker(handlers={"compress": handler}, name="w1").run_once(connection)

        assert commits_when_called == [1]

    def test_nothing_to_do_returns_none(self) -> None:
        connection = FakeConnection(claims=[[]])
        worker = Worker(handlers={"compress": lambda _job: None}, name="w1")

        assert worker.run_once(connection) is None

    def test_a_handler_that_raises_records_a_failure_rather_than_escaping(self) -> None:
        """A worker that dies on a bad job leaves it locked until the reaper
        notices, and takes the instance with it."""
        connection = FakeConnection(claims=[_claim_row()])

        def explode(_job: Job) -> None:
            msg = "decoder said no"
            raise ValueError(msg)

        job = Worker(handlers={"compress": explode}, name="w1").run_once(connection)

        assert job is not None
        assert "state = CASE WHEN attempts >= max_attempts" in connection.sql
        assert any(
            "ValueError: decoder said no" in str(args) for _sql, args in connection.statements
        )

    def test_the_failure_names_the_exception_type(self) -> None:
        """'decoder said no' alone does not say whether this was a bad file or a
        bug; the type is the cheapest way to tell them apart later."""
        connection = FakeConnection(claims=[_claim_row()])

        def explode(_job: Job) -> None:
            raise KeyError("width")

        Worker(handlers={"compress": explode}, name="w1").run_once(connection)

        assert any("KeyError" in str(args) for _sql, args in connection.statements)


class TestTheLoop:
    def test_it_handles_what_is_there_and_counts_it(self) -> None:
        connection = FakeConnection(claims=[_claim_row(), _claim_row(), []])
        worker = Worker(handlers={"compress": lambda _job: None}, name="w1", poll_seconds=0)

        handled = worker.run_forever(lambda: connection, max_iterations=3, reap_every=1000)

        assert handled == 2

    def test_it_stops_when_asked(self) -> None:
        """SIGTERM arrives as a request to stop, not as a failure."""
        connection = FakeConnection(claims=[_claim_row(), _claim_row(), _claim_row()])
        worker = Worker(handlers={"compress": lambda _job: None}, name="w1", poll_seconds=0)

        def handler(_job: Job) -> None:
            worker.stop()

        worker.handlers["compress"] = handler
        handled = worker.run_forever(lambda: connection, max_iterations=10, reap_every=1000)

        assert handled == 1
        assert worker.is_stopping

    def test_it_reaps_abandoned_jobs_on_a_schedule(self) -> None:
        """Done in this loop rather than a separate scheduled process: there is
        no second thing to deploy, and no window where every worker is running
        but nothing is reaping."""
        connection = FakeConnection(claims=[[], [], []])
        worker = Worker(handlers={"compress": lambda _job: None}, name="w1", poll_seconds=0)

        worker.run_forever(lambda: connection, max_iterations=3, reap_every=1)

        assert "locked_at < now() - make_interval" in connection.sql

    def test_the_connection_is_closed_even_if_the_loop_raises(self) -> None:
        connection = FakeConnection(claims=[_claim_row()])

        def explode(_job: Job) -> None:
            raise RuntimeError("boom")

        worker = Worker(handlers={"compress": explode}, name="w1", poll_seconds=0)
        worker.run_forever(lambda: connection, max_iterations=1, reap_every=1000)

        assert connection.closed


class TestItsName:
    def test_a_worker_names_itself_after_its_host_and_process(self) -> None:
        """Not a random identifier: uuid4 is banned here, and a name that can be
        matched against an instance in the logs is more useful anyway."""
        name = worker_name()

        assert name
        assert str(os.getpid()) in name

    def test_under_cloud_run_the_revision_leads(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """'Which deployment was running this' is the other half of the question
        asked when a job is stuck."""
        monkeypatch.setenv("K_REVISION", "ipw-dev-00042-abc")

        assert worker_name().startswith("ipw-dev-00042-abc/")

    def test_a_blank_revision_is_ignored(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("K_REVISION", "   ")

        assert not worker_name().startswith("/")


class TestKnowingItIsTheLastTry:
    def test_a_job_with_attempts_left_is_not_final(self) -> None:
        job = Job(id=1, kind="k", payload={}, attempts=1, max_attempts=3)

        assert not job.is_final_attempt

    def test_the_last_attempt_says_so(self) -> None:
        """Worth knowing inside a handler: this is the attempt where a good
        error message is worth the time, because nobody will see a better one."""
        job = Job(id=1, kind="k", payload={}, attempts=3, max_attempts=3)

        assert job.is_final_attempt


class TestSignals:
    """SIGTERM is how Cloud Run says 'this instance is going away'.

    A worker that dies where it stands leaves a job in `running` for the reaper
    to find twenty minutes later. One that finishes what it started leaves
    nothing behind, so the handling is worth testing rather than assuming.
    """

    def test_sigterm_asks_the_worker_to_stop_rather_than_killing_it(self) -> None:
        import signal

        worker = Worker(handlers={"compress": lambda _job: None}, name="w1")
        original = {number: signal.getsignal(number) for number in (signal.SIGTERM, signal.SIGINT)}
        try:
            worker.install_signal_handlers()
            installed = signal.getsignal(signal.SIGTERM)
            assert callable(installed)

            assert not worker.is_stopping
            installed(signal.SIGTERM, None)
            assert worker.is_stopping
        finally:
            for number, handler in original.items():
                signal.signal(number, handler)

    def test_interrupt_is_treated_the_same_way(self) -> None:
        """Ctrl+C on a developer machine should drain, not abandon."""
        import signal

        worker = Worker(handlers={"compress": lambda _job: None}, name="w1")
        original = {number: signal.getsignal(number) for number in (signal.SIGTERM, signal.SIGINT)}
        try:
            worker.install_signal_handlers()
            handler = signal.getsignal(signal.SIGINT)
            assert callable(handler)

            handler(signal.SIGINT, None)
            assert worker.is_stopping
        finally:
            for number, restored in original.items():
                signal.signal(number, restored)
