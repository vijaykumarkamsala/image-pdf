"""Run Python evidence with production-worker resource isolation on Linux.

The canonical image contains CPU Torch only for benchmark compatibility, while
the Cloud Run worker image deliberately excludes it. Pytest imports every test
module during collection, so one monolithic process otherwise charges Torch's
resident memory to the worker's 768 MiB production budget before a worker test
starts. Two processes preserve the real runtime boundary; ``--cov-append``
still produces one repository-wide authoritative coverage result.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tomllib
from pathlib import Path

WORKER_TESTS = "services/processing-worker/tests"


def _run(*arguments: str) -> int:
    return subprocess.run(  # noqa: S603 - fixed interpreter and fixed arguments only
        [sys.executable, "-m", "pytest", *arguments],
        check=False,
    ).returncode


def main() -> int:
    if os.environ.get("IPW_CANONICAL_LINUX") != "1":
        return _run()

    worker = _run(
        WORKER_TESTS,
        "--cov-report=",
        "--cov-fail-under=0",
    )
    configuration = tomllib.loads(Path("pyproject.toml").read_text(encoding="utf-8"))
    testpaths = configuration["tool"]["pytest"]["ini_options"]["testpaths"]
    if not isinstance(testpaths, list) or WORKER_TESTS not in testpaths:
        raise RuntimeError("canonical worker tests are absent from pytest testpaths")
    remaining_testpaths = [str(path) for path in testpaths if path != WORKER_TESTS]
    remaining = _run(
        *remaining_testpaths,
        "--cov-append",
    )
    return 1 if worker or remaining else 0


if __name__ == "__main__":
    raise SystemExit(main())
