"""Runtime half of the processor contract: clock, cancellation, workspace, input reference.

These objects are passed to processors but are never serialised, which is why
they live beside the serialisable contracts rather than inside them.

**This module is the only sanctioned place in the benchmark foundation that may
read ambient nondeterminism** (wall clock, monotonic counter, process id, temp
directory). Everything else takes those values from a :class:`RunContext`. That
single rule is what makes byte-identical report generation achievable, and it is
enforced by a ruff ``banned-api`` rule with a per-file exemption for this module.
"""

from __future__ import annotations

import hashlib
import logging
import os
import shutil
import tempfile
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from types import TracebackType
from typing import BinaryIO, Protocol, runtime_checkable

__all__ = [
    "CancellationToken",
    "Clock",
    "FixedClock",
    "InputRef",
    "OriginalMutatedError",
    "ProcessingCancelledError",
    "RunContext",
    "SystemClock",
    "Workspace",
    "workspace",
]

DEFAULT_MAX_READ_BYTES = 128 * 1024 * 1024
"""Hard ceiling on a single in-memory read. Prevents an oversized asset from
exhausting memory before POC-003's streaming inspection exists."""


class ProcessingCancelledError(Exception):
    """Raised when a cancellation token is observed as cancelled."""


class OriginalMutatedError(Exception):
    """Raised when an original asset's bytes change during processing.

    This is the loudest failure in the codebase. Product invariant #1 (D-006) is
    that an original is never overwritten or mutated; if this is raised, that
    invariant has been broken and the run is not trustworthy.
    """


# --------------------------------------------------------------------- clock --


@runtime_checkable
class Clock(Protocol):
    """Source of time. Injected so that determinism tests can pin it."""

    def now(self) -> datetime:
        """Current wall-clock time, timezone-aware UTC."""
        ...

    def monotonic_ns(self) -> int:
        """Monotonic counter in nanoseconds, for measuring durations."""
        ...


class SystemClock:
    """Real time. Used for every run that is not asserting determinism."""

    def now(self) -> datetime:
        return datetime.now(tz=UTC)

    def monotonic_ns(self) -> int:
        return time.perf_counter_ns()


@dataclass
class FixedClock:
    """Deterministic clock.

    ``now()`` always returns ``instant``. ``monotonic_ns()`` advances by a fixed
    step per call, so duration measurements are reproducible without being
    uniformly zero (which would hide ordering bugs).
    """

    instant: datetime = datetime(1970, 1, 1, tzinfo=UTC)
    step_ns: int = 1_000_000
    _ticks: int = field(default=0, init=False)

    def now(self) -> datetime:
        return self.instant

    def monotonic_ns(self) -> int:
        self._ticks += 1
        return self._ticks * self.step_ns


# -------------------------------------------------------------- cancellation --


class CancellationToken:
    """Cooperative cancellation.

    Gate D requires every candidate to support safe cancellation and timeouts.
    Putting the token in the processor signature from POC-001 means POC-006's
    adapters are shaped for it instead of being retrofitted.
    """

    __slots__ = ("_event",)

    def __init__(self) -> None:
        self._event = threading.Event()

    def cancel(self) -> None:
        self._event.set()

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    def raise_if_cancelled(self) -> None:
        if self._event.is_set():
            raise ProcessingCancelledError

    def wait(self, timeout_seconds: float) -> bool:
        """Block until cancelled or the timeout elapses. Returns True if cancelled."""
        return self._event.wait(timeout_seconds)


# ----------------------------------------------------------------- workspace --


class Workspace:
    """An isolated temporary directory for one processing call.

    Created by the runner, handed to the processor and removed on **every** exit
    path - success, failure, cancellation and unhandled exception (AGENTS.md:
    "Ensure temporary artifacts are isolated and removed after success, failure
    or cancellation").
    """

    __slots__ = ("root",)

    def __init__(self, root: Path) -> None:
        self.root = root

    def path(self, name: str) -> Path:
        """Resolve ``name`` inside the workspace, rejecting any escape attempt."""
        if not name or name in {".", ".."}:
            msg = f"invalid workspace entry name: {name!r}"
            raise ValueError(msg)
        candidate = (self.root / name).resolve()
        root = self.root.resolve()
        if candidate != root and root not in candidate.parents:
            msg = "workspace paths must stay inside the workspace root"
            raise ValueError(msg)
        return candidate

    def write_bytes(self, name: str, data: bytes) -> Path:
        target = self.path(name)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return target


@contextmanager
def workspace(temp_root: Path, label: str = "ws") -> Iterator[Workspace]:
    """Create an isolated workspace and guarantee its removal."""
    temp_root.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix=f"{label}-", dir=str(temp_root)))
    try:
        if os.name != "nt":
            root.chmod(0o700)
        yield Workspace(root)
    finally:
        shutil.rmtree(root, ignore_errors=True)


# ----------------------------------------------------------------- input ref --


class InputRef:
    """A read-only handle to an original asset.

    The contract deliberately exposes **no writable path**. A processor receives
    ``open_readonly()`` and ``read_bytes()`` and nothing else, so the ordinary way
    to use the API cannot mutate an original.

    Honest limitation: Python has no true private state, so a determined caller
    could reach ``_path`` by introspection. The API shape is a deterrent; the
    enforcement is :meth:`assert_unchanged`, which ``ipw.processors.base`` calls
    before **and** after every processing call.
    """

    __slots__ = ("_max_read_bytes", "_path", "asset_id", "declared_bytes", "expected_sha256")

    def __init__(
        self,
        *,
        asset_id: str,
        expected_sha256: str,
        path: Path,
        declared_bytes: int,
        max_read_bytes: int = DEFAULT_MAX_READ_BYTES,
    ) -> None:
        self.asset_id = asset_id
        self.expected_sha256 = expected_sha256
        self.declared_bytes = declared_bytes
        self._path = path
        self._max_read_bytes = max_read_bytes

    @property
    def exists(self) -> bool:
        return self._path.is_file()

    @property
    def size_bytes(self) -> int:
        return self._path.stat().st_size

    @property
    def suffix(self) -> str:
        return self._path.suffix.lower()

    def open_readonly(self) -> BinaryIO:
        """Open the original for reading. There is no writable counterpart."""
        return self._path.open("rb")

    def readonly_path(self) -> Path:
        """The filesystem path, for libraries that cannot take a file object.

        Pillow and libvips both decode most efficiently from a path, and libvips'
        streaming advantage disappears entirely if it is handed a bytes buffer -
        which is exactly the property POC-012 needs to measure. So a path has to
        cross the boundary.

        The name states the contract: **read from it, never write to it.** Python
        cannot enforce that, and pretending otherwise by hiding the attribute
        while callers reach through ``_path`` anyway would be worse - it would
        make the violation invisible rather than impossible. The real enforcement
        is :meth:`assert_unchanged`, which ``ipw.processors.base`` calls before
        and after every processing call, so a write is always caught.
        """
        return self._path

    def read_bytes(self) -> bytes:
        size = self.size_bytes
        if size > self._max_read_bytes:
            msg = f"asset {self.asset_id} is {size} bytes, above the {self._max_read_bytes} ceiling"
            raise ValueError(msg)
        with self.open_readonly() as handle:
            return handle.read()

    def compute_sha256(self) -> str:
        """Stream the file and return its digest. Never loads the whole file."""
        digest = hashlib.sha256()
        with self.open_readonly() as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    def matches_expected(self) -> bool:
        return self.compute_sha256() == self.expected_sha256

    def assert_unchanged(self, stage: str) -> None:
        """Raise :class:`OriginalMutatedError` if the bytes no longer match."""
        actual = self.compute_sha256()
        if actual != self.expected_sha256:
            msg = (
                f"original asset {self.asset_id} changed during {stage}: "
                f"expected {self.expected_sha256}, found {actual}"
            )
            raise OriginalMutatedError(msg)

    def __repr__(self) -> str:
        # Deliberately omits the filesystem path: logs must not carry paths.
        return f"InputRef(asset_id={self.asset_id!r}, sha256={self.expected_sha256[:12]}...)"


# --------------------------------------------------------------- run context --


@dataclass(frozen=True)
class RunContext:
    """Everything a processor may need that is not an input or a setting.

    ``deterministic`` tells report writers to omit observed, machine-specific
    values so that output is byte-reproducible.
    """

    clock: Clock
    temp_root: Path
    cancellation: CancellationToken
    logger: logging.Logger
    seed: int = 0
    deterministic: bool = False
    timeout_ns: int | None = None

    @classmethod
    def create(
        cls,
        *,
        temp_root: Path | None = None,
        deterministic: bool = False,
        seed: int = 0,
        logger: logging.Logger | None = None,
        clock: Clock | None = None,
    ) -> RunContext:
        resolved_root = temp_root or Path(tempfile.gettempdir()) / "ipw"
        resolved_clock: Clock = clock or (FixedClock() if deterministic else SystemClock())
        return cls(
            clock=resolved_clock,
            temp_root=resolved_root,
            cancellation=CancellationToken(),
            logger=logger or logging.getLogger("ipw.benchmark"),
            seed=seed,
            deterministic=deterministic,
        )

    @contextmanager
    def workspace(self, label: str = "ws") -> Iterator[Workspace]:
        with workspace(self.temp_root, label) as ws:
            yield ws

    def __enter__(self) -> RunContext:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        shutil.rmtree(self.temp_root, ignore_errors=True)
