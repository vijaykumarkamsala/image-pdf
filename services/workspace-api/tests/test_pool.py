"""The connection pool, tested for the failures that make pools dangerous.

A pool that hands out connections and takes them back is easy. The ones that
cost an afternoon are subtler: a connection returned with an open transaction
whose locks the next borrower inherits, a dead connection handed to somebody
whose own query was fine, or a slot leaked on every failed connect until the
pool has none left and the database looks down.
"""

from __future__ import annotations

import threading
from typing import Any

import pytest

from ipw.workspace_api.pool import ConnectionPool, PoolExhaustedError


class FakeConnection:
    def __init__(self, number: int) -> None:
        self.number = number
        self.rollbacks = 0
        self.closed = False
        self.rollback_fails = False

    def rollback(self) -> None:
        if self.rollback_fails:
            msg = "connection is broken"
            raise RuntimeError(msg)
        self.rollbacks += 1

    def close(self) -> None:
        self.closed = True


class Factory:
    """Counts how many connections were opened, and can be made to fail."""

    def __init__(self, fail_after: int | None = None) -> None:
        self.made: list[FakeConnection] = []
        self.fail_after = fail_after

    def __call__(self) -> FakeConnection:
        if self.fail_after is not None and len(self.made) >= self.fail_after:
            msg = "database refused the connection"
            raise ConnectionError(msg)
        connection = FakeConnection(len(self.made))
        self.made.append(connection)
        return connection


class TestBorrowing:
    def test_nothing_is_opened_until_a_connection_is_wanted(self) -> None:
        """Most requests here never touch the database - the processing routes
        work on bytes - so a pool that connects eagerly pays for capacity that
        is mostly idle."""
        factory = Factory()

        ConnectionPool(factory, size=3)

        assert factory.made == []

    def test_a_returned_connection_is_reused(self) -> None:
        factory = Factory()
        pool = ConnectionPool(factory, size=3)

        with pool.connection() as first:
            pass
        with pool.connection() as second:
            pass

        assert first is second
        assert len(factory.made) == 1

    def test_concurrent_borrowers_get_different_connections(self) -> None:
        factory = Factory()
        pool = ConnectionPool(factory, size=3)

        with pool.connection() as first, pool.connection() as second:
            assert first is not second

    def test_the_pool_never_exceeds_its_size(self) -> None:
        """The size is a budget against a ceiling shared with every other
        instance, not a starting point."""
        factory = Factory()
        pool = ConnectionPool(factory, size=2, wait_seconds=0.05)

        with pool.connection(), pool.connection():
            assert pool.stats() == {"idle": 0, "in_use": 2, "size": 2}
            with (
                pytest.raises(PoolExhaustedError, match="all 2 database connections are busy"),
                pool.connection(),
            ):
                pass

        assert len(factory.made) == 2

    def test_a_pool_must_have_at_least_one_connection(self) -> None:
        with pytest.raises(ValueError, match="at least one connection"):
            ConnectionPool(Factory(), size=0)


class TestReturningSafely:
    def test_a_connection_is_rolled_back_when_returned(self) -> None:
        """pg8000 opens a transaction implicitly on first execute. A caller who
        neither commits nor rolls back would otherwise leave one open, and the
        next borrower inherits its locks and its snapshot."""
        factory = Factory()
        pool = ConnectionPool(factory, size=1)

        with pool.connection():
            pass

        assert factory.made[0].rollbacks == 1

    def test_a_connection_that_raised_is_discarded_not_reused(self) -> None:
        """Its state is now unknown, and handing it on moves one request's
        failure onto an unrelated one."""
        factory = Factory()
        pool = ConnectionPool(factory, size=2)

        with pytest.raises(RuntimeError), pool.connection() as connection:
            raise RuntimeError("query blew up")

        assert connection.closed
        assert pool.stats() == {"idle": 0, "in_use": 0, "size": 2}

    def test_a_connection_that_cannot_roll_back_is_discarded(self) -> None:
        factory = Factory()
        pool = ConnectionPool(factory, size=2)

        with pool.connection() as connection:
            connection.rollback_fails = True

        assert connection.closed
        assert pool.stats()["idle"] == 0

    def test_the_slot_comes_back_when_a_discarded_connection_frees_one(self) -> None:
        """A pool that leaked a slot per failure would shrink to nothing and the
        database would look down when it was fine."""
        pool = ConnectionPool(Factory(), size=1, wait_seconds=0.05)

        with pytest.raises(RuntimeError), pool.connection():
            raise RuntimeError("boom")

        with pool.connection() as recovered:
            assert recovered is not None


class TestWhenConnectingFails:
    def test_a_failed_connect_does_not_consume_a_slot(self) -> None:
        """Otherwise a database that is briefly down permanently shrinks the
        pool, one failed connect at a time, and never recovers."""
        factory = Factory(fail_after=0)
        pool = ConnectionPool(factory, size=2, wait_seconds=0.05)

        with pytest.raises(ConnectionError), pool.connection():
            pass

        assert pool.stats() == {"idle": 0, "in_use": 0, "size": 2}

        factory.fail_after = None
        with pool.connection() as recovered:
            assert recovered is not None


class TestShutdown:
    def test_closing_closes_idle_connections(self) -> None:
        factory = Factory()
        pool = ConnectionPool(factory, size=2)

        with pool.connection():
            pass
        pool.close()

        assert factory.made[0].closed

    def test_a_closed_pool_refuses_to_lend(self) -> None:
        pool = ConnectionPool(Factory(), size=1)
        pool.close()

        with pytest.raises(PoolExhaustedError, match="closed"), pool.connection():
            pass  # pragma: no cover - the borrow raises before the body runs

    def test_a_connection_still_out_is_closed_when_it_comes_back(self) -> None:
        """Shutdown must not pull a connection out from under a request that is
        halfway through a query."""
        factory = Factory()
        pool = ConnectionPool(factory, size=1)

        with pool.connection() as connection:
            pool.close()
            assert not connection.closed

        assert connection.closed


class TestUnderThreads:
    def test_many_threads_never_exceed_the_budget(self) -> None:
        """The server is one thread per request and unbounded, so this is the
        condition the pool exists for."""
        factory = Factory()
        pool = ConnectionPool(factory, size=3, wait_seconds=5.0)
        peak = 0
        peak_lock = threading.Lock()
        barrier = threading.Barrier(8)

        def worker() -> None:
            nonlocal peak
            barrier.wait()
            for _ in range(20):
                with pool.connection(), peak_lock:
                    peak = max(peak, pool.stats()["in_use"])

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)

        assert not any(thread.is_alive() for thread in threads), "a borrower never returned"
        assert peak <= 3
        assert len(factory.made) <= 3

    def test_a_waiting_borrower_is_woken_when_one_is_returned(self) -> None:
        pool = ConnectionPool(Factory(), size=1, wait_seconds=5.0)
        got: list[Any] = []
        holding = threading.Event()
        release = threading.Event()

        def holder() -> None:
            with pool.connection():
                holding.set()
                release.wait(timeout=5)

        def waiter() -> None:
            with pool.connection() as connection:
                got.append(connection)

        first = threading.Thread(target=holder)
        first.start()
        assert holding.wait(timeout=5)

        second = threading.Thread(target=waiter)
        second.start()
        release.set()

        first.join(timeout=5)
        second.join(timeout=5)
        assert len(got) == 1, "the waiting borrower was never handed the freed connection"
