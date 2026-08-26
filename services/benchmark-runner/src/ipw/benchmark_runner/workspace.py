"""Monorepo layout: where things live, and how to find the repository root.

Every path in the repository is derived from here rather than from the current
working directory, so ``bench`` behaves identically no matter where it is invoked
from. That matters for reproducibility: a report generated from
``services/benchmark-runner/`` must be byte-identical to one generated from the
repository root.

The root is located by walking upward for ``workspaces.toml`` — the monorepo
manifest. Deriving it from ``__file__`` would break the moment a package moves,
which is exactly the kind of change a monorepo invites.
"""

from __future__ import annotations

from importlib import metadata
from pathlib import Path

__all__ = [
    "ROOT_MARKER",
    "TOOL_VERSION",
    "find_repo_root",
    "fixtures_dir",
    "manifests_dir",
    "reports_dir",
    "schemas_dir",
]

ROOT_MARKER = "workspaces.toml"
"""The monorepo manifest. Its presence defines the repository root."""

DISTRIBUTION = "ipw-benchmark-runner"


def _resolve_tool_version() -> str:
    try:
        return metadata.version(DISTRIBUTION)
    except metadata.PackageNotFoundError:  # pragma: no cover - only when uninstalled
        return "0.0.0+unknown"


TOOL_VERSION = _resolve_tool_version()
"""Version of the benchmark runner, read from installed package metadata."""


def find_repo_root(start: Path | None = None) -> Path:
    """Walk upward from ``start`` (default: this module) until ``workspaces.toml``."""
    current = (start or Path(__file__)).resolve()
    for candidate in [current, *current.parents]:
        if (candidate / ROOT_MARKER).is_file():
            return candidate
    msg = (
        f"could not locate the repository root: no {ROOT_MARKER} found above "
        f"{current}. Run from inside the repository."
    )
    raise FileNotFoundError(msg)


# ------------------------------------------------------------- data locations --
# Benchmark data is not code. It lives under data/ at the repository root so that
# a manifest path means the same thing to the Python runner and to the TypeScript
# browser lab (POC-005).


def manifests_dir(repo_root: Path) -> Path:
    return repo_root / "data" / "manifests"


def fixtures_dir(repo_root: Path) -> Path:
    return repo_root / "data" / "fixtures"


def reports_dir(repo_root: Path) -> Path:
    return repo_root / "data" / "reports"


def schemas_dir(repo_root: Path, major: str) -> Path:
    """Generated JSON Schema. Language-neutral, consumed by every workspace."""
    return repo_root / "packages" / "schemas" / major
