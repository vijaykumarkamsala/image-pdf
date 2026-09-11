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


def _run(*arguments: str) -> int:
    return subprocess.run(  # noqa: S603 - fixed interpreter and fixed arguments only
        [sys.executable, "-m", "pytest", *arguments],
        check=False,
    ).returncode


def main() -> int:
    if os.environ.get("IPW_CANONICAL_LINUX") != "1":
        return _run()

    worker = _run(
        "services/processing-worker/tests",
        "--cov-report=",
        "--cov-fail-under=0",
    )
    remaining = _run(
        "--ignore=services/processing-worker/tests",
        "--cov-append",
    )
    return 1 if worker or remaining else 0


if __name__ == "__main__":
    raise SystemExit(main())
