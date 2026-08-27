"""A small, bounded pool of Postgres connections.

**Why a pool rather than connecting per request.** Opening a connection to Cloud
SQL costs a TCP handshake, a TLS handshake and a SCRAM exchange - tens of
milliseconds before any query runs, on every request. Worse, the server is
threaded and unbounded: a burst of thirty requests would open thirty
connections, and Cloud SQL's connection limit is a hard ceiling shared with
every other instance and with anything else pointed at that database. The way
that fails is not gradual - it is every instance refusing connections at once,
during the burst that caused it.

**Why bounded rather than elastic.** A pool that grows to meet demand
rediscovers the same ceiling with extra steps. The size is a budget: this
instance will use at most N connections no matter what arrives, and a request
that cannot get one waits briefly and then fails with a message saying so. A
clear refusal under load is worth more than an unbounded queue that turns a
spike into a database outage.

**Two things that make a pool dangerous, handled here.**

*A poisoned connection.* A connection whose transaction failed, or whose socket
died, is not reusable; handing it to the next borrower moves one request's
failure onto an unrelated one. Any connection that leaves the pool with an
exception is closed and discarded rather than returned.

*A leaked transaction.* pg8000 opens a transaction implicitly on first execute,
so a caller who neither commits nor rolls back leaves one open. The next
borrower would inherit its locks and its snapshot. Every connection is rolled
back on return, which is a no-op when the caller committed and the difference
between a bug and an outage when they did not.
"""

from __future__ import annotations

import contextlib
import threading
from collections import deque
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

__all__ = ["DEFAULT_POOL_SIZE", "DEFAULT_WAIT_SECONDS", "ConnectionPool", "PoolExhaustedError"]

# Deliberately small. Cloud Run is configured with concurrency 8 in
# deploy/README.md, and most requests never touch the database at all - the
# processing routes work on bytes. More connections per instance is a cost paid
# against a shared ceiling for capacity that is mostly idle.
DEFAULT_POOL_SIZE = 4

# Long enough to ride out a brief burst, short enough that a caller learns the
# system is saturated rather than sitting behind a request that already timed
# out at the other end.
DEFAULT_WAIT_SECONDS = 5.0


class PoolExhaustedError(RuntimeError):
    """Every connection is busy and none came free in time."""


class ConnectionPool:
    """Hands out connections one borrower at a time, and takes them back."""

    def __init__(
        self,
        connect: Callable[[], Any],
        size: int = DEFAULT_POOL_SIZE,
        wait_seconds: float = DEFAULT_WAIT_SECONDS,
    ) -> None:
        if size < 1:
            msg = f"a pool needs at least one connection, got {size}"
            raise ValueError(msg)

        self._connect = connect
        self._size = size
        self._wait_seconds = wait_seconds

        self._lock = threading.Condition()
        self._idle: deque[Any] = deque()
        self._in_use = 0
        self._closed = False

    @property
    def size(self) -> int:
        return self._size

    def _is_closed(self) -> bool:
        """Read the flag through a call, so a checker cannot narrow it.

        `_acquire` tests it, releases the lock to wait, and must test it again -
        another thread may have closed the pool in between. A type checker sees
        one function body and concludes the second test is dead code, which is
        true only in a single-threaded reading of it.
        """
        return self._closed

    def stats(self) -> dict[str, int]:
        """Idle, in use, and how many exist at all. For /api/health and tests."""
        with self._lock:
            return {"idle": len(self._idle), "in_use": self._in_use, "size": self._size}

    @contextmanager
    def connection(self) -> Iterator[Any]:
        """Borrow a connection for the duration of the block.

        Connections are created lazily: a service that never touches the database
        never opens one, which matters because most requests here do not.
        """
        connection = self._acquire()
        try:
            yield connection
        except BaseException:
            # Whatever went wrong, this connection's state is now unknown. Closing
            # it is cheaper than reasoning about what the next borrower inherits.
            self._discard(connection)
            raise
        else:
            self._release(connection)

    def _acquire(self) -> Any:
        with self._lock:
            if self._is_closed():
                msg = "the connection pool is closed"
                raise PoolExhaustedError(msg)

            if self._idle:
                self._in_use += 1
                return self._idle.popleft()

            if self._in_use < self._size:
                self._in_use += 1
                created = True
            else:
                created = False

        if created:
            try:
                return self._connect()
            except BaseException:
                # The slot was reserved before the connection existed; give it
                # back, or a failing database would shrink the pool to nothing
                # one failed connect at a time.
                with self._lock:
                    self._in_use -= 1
                    self._lock.notify()
                raise

        with self._lock:
            if not self._lock.wait_for(
                lambda: bool(self._idle) or self._closed, self._wait_seconds
            ):
                msg = (
                    f"all {self._size} database connections are busy and none came free "
                    f"within {self._wait_seconds:g}s"
                )
                raise PoolExhaustedError(msg)
            if self._is_closed():
                msg = "the connection pool is closed"
                raise PoolExhaustedError(msg)
            self._in_use += 1
            return self._idle.popleft()

    def _release(self, connection: Any) -> None:
        """Return a connection, first undoing anything the borrower left open."""
        try:
            connection.rollback()
        except Exception:  # noqa: BLE001 - a connection that cannot roll back is not reusable
            self._discard(connection)
            return

        with self._lock:
            self._in_use -= 1
            if self._closed:
                closing = connection
            else:
                self._idle.append(connection)
                closing = None
            self._lock.notify()

        if closing is not None:
            with contextlib.suppress(Exception):
                closing.close()

    def _discard(self, connection: Any) -> None:
        with self._lock:
            self._in_use -= 1
            self._lock.notify()
        with contextlib.suppress(Exception):
            connection.close()

    def close(self) -> None:
        """Close every idle connection and refuse further borrowing.

        Connections still out are closed as they come back, so a shutdown does
        not pull one out from under a request that is mid-query.
        """
        with self._lock:
            self._closed = True
            idle, self._idle = list(self._idle), deque()
            self._lock.notify_all()

        for connection in idle:
            with contextlib.suppress(Exception):
                connection.close()
