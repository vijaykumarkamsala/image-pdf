"""Fixture integrity.

``data/fixtures/FIXTURES.sha256`` locks the bytes of every committed fixture.
It is checked by ``bench fixtures verify``, by CI, and - most importantly - by a
session-scoped pytest guard that runs at the **start and end** of every test
session.

That double check is what proves POC-001 acceptance criterion 6 ("Original
fixture hash is unchanged before and after all tests"): a processor that mutates
an original mid-session is caught even if it politely restores it later, because
``ipw.processors.base`` also verifies around every individual call.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

from ipw.benchmark_runner.workspace import fixtures_dir

__all__ = [
    "FIXTURE_LOCK_NAME",
    "compute_fixture_hashes",
    "fixture_images_dir",
    "fixture_lock_path",
    "format_lock",
    "parse_lock",
    "verify_fixtures",
]

FIXTURE_LOCK_NAME = "FIXTURES.sha256"


def fixture_images_dir(repo_root: Path) -> Path:
    return fixtures_dir(repo_root) / "images"


def fixture_lock_path(repo_root: Path) -> Path:
    return fixtures_dir(repo_root) / FIXTURE_LOCK_NAME


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def compute_fixture_hashes(repo_root: Path) -> dict[str, str]:
    """Map every committed fixture's POSIX-relative path to its SHA-256."""
    images = fixture_images_dir(repo_root)
    if not images.is_dir():
        return {}
    return {
        path.relative_to(repo_root).as_posix(): _sha256_file(path)
        for path in sorted(images.rglob("*"))
        if path.is_file()
    }


def format_lock(hashes: dict[str, str]) -> str:
    """Render the lock file: ``<sha256>  <path>`` per line, sorted, LF endings."""
    return "".join(f"{hashes[key]}  {key}\n" for key in sorted(hashes))


def parse_lock(text: str) -> dict[str, str]:
    entries: dict[str, str] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        digest, _, path = stripped.partition("  ")
        if not path:
            msg = f"malformed fixture lock line: {line!r}"
            raise ValueError(msg)
        entries[path.strip()] = digest.strip()
    return entries


def verify_fixtures(repo_root: Path) -> tuple[bool, list[str]]:
    """Compare on-disk fixtures against the lock. Returns ``(ok, problems)``."""
    lock_path = fixture_lock_path(repo_root)
    if not lock_path.is_file():
        return False, [f"fixture lock not found: {lock_path.name}"]

    expected = parse_lock(lock_path.read_text(encoding="utf-8"))
    actual = compute_fixture_hashes(repo_root)
    problems: list[str] = []

    for path in sorted(set(expected) | set(actual)):
        want = expected.get(path)
        have = actual.get(path)
        if want is None:
            problems.append(f"untracked fixture (not in the lock): {path}")
        elif have is None:
            problems.append(f"missing fixture (in the lock, not on disk): {path}")
        elif want != have:
            problems.append(f"fixture bytes changed: {path} expected {want} found {have}")

    return not problems, problems
