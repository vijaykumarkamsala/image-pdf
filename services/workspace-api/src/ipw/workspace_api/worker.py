"""The process that takes jobs off the queue and runs them.

**A worker only claims what it can run.** The kinds it claims are the keys of its
own handler table, so "no handler for this kind" is not a runtime failure - it is
a job this worker never takes. A different deployment with the OCR engine
installed can register `recognise` and take those, and neither needs to know
about the other or about a second queue.

**SIGTERM is not an error.** Cloud Run sends it before it stops an instance, with
a grace period, and it is the normal way a worker ends. So it stops claiming new
work and returns; the job in flight is left to finish. Anything it cannot finish
in the grace period is reclaimed by `reap_stalled` later, which is the same path
that covers an instance killed with no warning at all.

**One connection, one job, one transaction.** A handler that raises leaves the
database untouched except for the failure record, because the claim and the
result are the only things this module writes.
"""

from __future__ import annotations

import os
import signal
import socket
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from types import FrameType
from typing import Any

from ipw.workspace_api.jobs import Job, claim, fail, reap_stalled, succeed

__all__ = ["DEFAULT_POLL_SECONDS", "Worker", "worker_name"]

# How long to wait before asking for work again when there was none.
#
# Short enough that a queued job starts promptly, long enough that an idle
# worker is not a steady stream of queries. A LISTEN/NOTIFY wake-up would remove
# the delay entirely and is the obvious later improvement; polling is what does
# not need to be right first time.
DEFAULT_POLL_SECONDS = 2.0

Handler = Callable[[Job], "dict[str, Any] | None"]


def worker_name() -> str:
    """Something that identifies this process when a job is stuck.

    Host and process id rather than a random identifier: the repository bans
    uuid4, and a name that survives being written down is more useful anyway -
    it can be matched against a Cloud Run instance in the logs. Under Cloud Run
    the revision is included, because "which deployment was running this" is the
    other half of the question.
    """
    parts = [socket.gethostname(), str(os.getpid())]
    revision = os.environ.get("K_REVISION", "").strip()
    if revision:
        parts.insert(0, revision)
    return "/".join(parts)


@dataclass
class Worker:
    """Claims jobs of the kinds it can handle, and runs them one at a time."""

    handlers: dict[str, Handler]
    name: str = field(default_factory=worker_name)
    poll_seconds: float = DEFAULT_POLL_SECONDS

    def __post_init__(self) -> None:
        if not self.handlers:
            msg = "a worker with no handlers would claim nothing and do nothing"
            raise ValueError(msg)
        self._stopping = False

    @property
    def kinds(self) -> tuple[str, ...]:
        """Exactly what this worker can run, in a stable order."""
        return tuple(sorted(self.handlers))

    def stop(self) -> None:
        """Finish the current job, then return from run_forever."""
        self._stopping = True

    @property
    def is_stopping(self) -> bool:
        return self._stopping

    def run_once(self, connection: Any) -> Job | None:
        """Claim one job and run it. Returns the job, or None if there was none.

        The handler's return value is stored as the job's result, so it should be
        a summary - what was produced, how big it was, where it went - and never
        the bytes themselves. Those belong in Cloud Storage; the whole schema is
        built on that split.
        """
        job = claim(connection, self.name, self.kinds)
        if job is None:
            connection.commit()
            return None

        # Committed before the handler runs, so the claim is visible to everyone
        # else immediately. Holding the transaction open for the length of the
        # work would keep a row locked for minutes and make every other worker's
        # claim query step over it.
        connection.commit()

        try:
            result = self.handlers[job.kind](job)
        except Exception as exc:  # noqa: BLE001 - a handler may raise anything
            fail(connection, job, f"{type(exc).__name__}: {exc}")
            connection.commit()
            return job

        succeed(connection, job.id, result or {})
        connection.commit()
        return job

    def run_forever(
        self,
        connect: Callable[[], Any],
        *,
        reap_every: int = 60,
        max_iterations: int | None = None,
    ) -> int:
        """Poll until asked to stop. Returns how many jobs were handled.

        ``max_iterations`` exists so this can be tested and so a deployment can
        choose to recycle a worker periodically; without it the loop runs until
        SIGTERM.
        """
        handled = 0
        iterations = 0
        since_reap = 0

        with self._connection(connect) as connection:
            while not self._stopping:
                if max_iterations is not None and iterations >= max_iterations:
                    break
                iterations += 1

                # Returning abandoned jobs is this loop's job too. Doing it here
                # rather than in a separate scheduled process means there is no
                # second thing to deploy, and no window where every worker is
                # running but nothing is reaping.
                if since_reap >= reap_every:
                    reap_stalled(connection)
                    connection.commit()
                    since_reap = 0
                since_reap += 1

                job = self.run_once(connection)
                if job is not None:
                    handled += 1
                    continue

                if not self._stopping:
                    time.sleep(self.poll_seconds)

        return handled

    @contextmanager
    def _connection(self, connect: Callable[[], Any]) -> Iterator[Any]:
        connection = connect()
        try:
            yield connection
        finally:
            connection.close()

    def install_signal_handlers(self) -> None:
        """Treat SIGTERM and SIGINT as 'stop after this job'.

        Cloud Run sends SIGTERM before stopping an instance. A worker that dies
        on the spot leaves a job in `running` for the reaper to find twenty
        minutes later; one that finishes what it started leaves nothing behind.

        Separate from __init__ because installing a signal handler is a global
        side effect, and a test or an embedding process should not get one
        because it constructed an object.
        """

        def handle(signum: int, _frame: FrameType | None) -> None:
            self.stop()

        for received in (signal.SIGTERM, signal.SIGINT):
            signal.signal(received, handle)
