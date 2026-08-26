"""Locate the libvips native library before ``pyvips`` is imported.

``pyvips`` is a cffi binding; the native library is found by the operating
system loader, not by pip. That means availability is a **runtime** property, and
it differs by platform:

* Linux / macOS - a package manager provides it, and the loader finds it.
* Windows - the DLLs live in a gitignored ``.tools/vips`` inside the repository
  (see ``tools/install_libvips.py``). ``cffi`` calls the legacy ``LoadLibraryW``,
  which searches ``PATH`` and ignores ``os.add_dll_directory``, so the directory
  must be prepended to ``PATH`` before the first import.

Absence is treated as a normal, reportable condition rather than an error. A host
without libvips still runs the whole suite: the adapter reports
``PROCESSOR.UNAVAILABLE`` and the run records it, which is exactly how a benchmark
should behave when one of its candidates cannot execute here.
"""

from __future__ import annotations

import os
import sys
from functools import lru_cache
from pathlib import Path
from typing import Any

__all__ = ["VIPS_MARKER", "libvips_version", "load_pyvips", "vips_available", "vips_bin_dir"]

VIPS_MARKER = "workspaces.toml"


def _repo_root() -> Path | None:
    """Walk upward for the monorepo marker. Returns ``None`` outside the repo."""
    current = Path(__file__).resolve()
    for candidate in [current, *current.parents]:
        if (candidate / VIPS_MARKER).is_file():
            return candidate
    return None


def vips_bin_dir() -> Path | None:
    """The bundled Windows DLL directory, when one is present."""
    root = _repo_root()
    if root is None:
        return None
    candidate = root / ".tools" / "vips" / "bin"
    return candidate if candidate.is_dir() else None


@lru_cache(maxsize=1)
def load_pyvips() -> Any | None:
    """Import and return ``pyvips``, or ``None`` when libvips is unavailable.

    Cached: the ``PATH`` mutation must happen exactly once, and a failed import
    should not be retried on every call.
    """
    if sys.platform == "win32":
        bundled = vips_bin_dir()
        if bundled is not None:
            resolved = str(bundled.resolve())
            if resolved not in os.environ.get("PATH", ""):
                os.environ["PATH"] = resolved + os.pathsep + os.environ.get("PATH", "")

    try:
        import pyvips
    except (ImportError, OSError):
        # ImportError: the binding is absent. OSError: the binding is present but
        # the native library could not be loaded. Both mean "unavailable here".
        return None
    return pyvips


def vips_available() -> bool:
    return load_pyvips() is not None


def libvips_version() -> str | None:
    """The native library version, e.g. ``'8.18.5'``. ``None`` when unavailable."""
    module = load_pyvips()
    if module is None:
        return None
    try:
        return ".".join(str(module.version(index)) for index in range(3))
    except Exception:  # noqa: BLE001 - version reporting must never be fatal
        return None
