"""Memory measurement, with its limitations stated rather than hidden.

Measuring "how much memory did this one operation use" is harder than it looks,
and reporting a confident number that does not mean what a reader assumes is
worse than reporting a modest one honestly.

Two figures are captured, because neither alone is trustworthy:

**Process peak working set.** Real, and it includes native allocations inside
Pillow's C code and libvips - which is most of the memory that actually matters.
Its limitation is that the operating system reports a *process-lifetime* peak: it
never decreases, so after several images it reflects the largest so far, not the
current call. Useful as an upper bound for a run; misleading if read as per-call.

**Python-attributable delta.** ``tracemalloc`` measures allocations the CPython
allocator made during this call only, so it *is* per-call. Its limitation is the
mirror image: it sees nothing that a C library allocated, which for image
decoding is the bulk of it.

Together they bracket the truth. A trustworthy per-call figure needs process
isolation, which arrives with POC-006's containerised runs where the container's
own peak is the measurement. Until then, ``Measurement.memory.measurement_method``
records exactly which technique produced the number, so no later reader has to
guess.
"""

from __future__ import annotations

import ctypes
import sys
import tracemalloc
from dataclasses import dataclass

__all__ = ["MEASUREMENT_METHOD", "MemorySample", "measure_memory", "process_peak_rss"]

MEASUREMENT_METHOD = "process_peak_working_set+tracemalloc_delta"


class _WindowsProcessMemoryCounters(ctypes.Structure):
    """``PROCESS_MEMORY_COUNTERS`` from psapi.h."""

    _fields_ = (
        ("cb", ctypes.c_uint32),
        ("PageFaultCount", ctypes.c_uint32),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
    )


def process_peak_rss() -> int:
    """Peak resident set of this process, in bytes. ``0`` when unavailable.

    Process-lifetime peak, not per-call - see the module docstring. Returns ``0``
    rather than raising on any platform that cannot report it: a missing
    measurement must never fail a benchmark.
    """
    if sys.platform == "win32":
        try:
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

            # argtypes and restype are mandatory here, not optional hygiene. Without
            # them ctypes assumes a 32-bit int return, so the HANDLE from
            # GetCurrentProcess truncates on 64-bit and the call silently fails,
            # returning zero. That is how this first shipped, and a memory figure
            # that quietly falls back to a Python-only number is worse than none.
            kernel32.GetCurrentProcess.restype = ctypes.c_void_p
            kernel32.GetCurrentProcess.argtypes = []

            # K32GetProcessMemoryInfo lives in kernel32 on Windows 7 and later, which
            # avoids depending on psapi.dll being present.
            get_memory_info = kernel32.K32GetProcessMemoryInfo
            get_memory_info.restype = ctypes.c_int
            get_memory_info.argtypes = [
                ctypes.c_void_p,
                ctypes.POINTER(_WindowsProcessMemoryCounters),
                ctypes.c_uint32,
            ]

            counters = _WindowsProcessMemoryCounters()
            counters.cb = ctypes.sizeof(counters)
            ok = get_memory_info(kernel32.GetCurrentProcess(), ctypes.byref(counters), counters.cb)
            return int(counters.PeakWorkingSetSize) if ok else 0
        except (AttributeError, OSError):  # pragma: no cover - platform dependent
            return 0

    try:
        import resource
    except ImportError:  # pragma: no cover - platform dependent
        return 0

    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    # Linux reports kibibytes; macOS reports bytes.
    return int(peak) if sys.platform == "darwin" else int(peak) * 1024


@dataclass(frozen=True)
class MemorySample:
    """What was observed around one operation."""

    process_peak_bytes: int
    python_peak_delta_bytes: int
    method: str = MEASUREMENT_METHOD

    @property
    def reported_peak_bytes(self) -> int:
        """The figure recorded as ``peak_rss_bytes``.

        Prefers the process peak because it includes native allocations, which
        dominate image work. Falls back to the Python-attributable figure on a
        platform that cannot report a process peak, so the field is never a
        silent zero when something was in fact measured.
        """
        return self.process_peak_bytes or self.python_peak_delta_bytes


class measure_memory:  # noqa: N801 - used as a context manager, reads as a verb
    """Context manager capturing both figures around a block.

    ``tracemalloc`` is started only if it is not already running, and stopped only
    if this instance started it, so nesting and an externally profiled process
    both behave.
    """

    __slots__ = ("_started_tracing", "_tracemalloc_baseline", "sample")

    def __init__(self) -> None:
        self.sample = MemorySample(0, 0)
        self._started_tracing = False
        self._tracemalloc_baseline = 0

    def __enter__(self) -> measure_memory:
        if not tracemalloc.is_tracing():
            tracemalloc.start()
            self._started_tracing = True
        self._tracemalloc_baseline = tracemalloc.get_traced_memory()[0]
        tracemalloc.reset_peak()
        return self

    def __exit__(self, *exc: object) -> None:
        python_peak = tracemalloc.get_traced_memory()[1]
        if self._started_tracing:
            tracemalloc.stop()
        self.sample = MemorySample(
            process_peak_bytes=process_peak_rss(),
            python_peak_delta_bytes=max(python_peak - self._tracemalloc_baseline, 0),
        )
