"""Verify the pinned Linux processing and visual-evidence environment.

The production worker target contains only its approved runtime dependencies.
The canonical CI target inherits that target and adds benchmark/test tooling.
This verifier makes a moved tag, wrong wheel, CUDA Torch build, browser drift or
font substitution fail before any authoritative output is accepted.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import subprocess
import sys
from pathlib import Path
from typing import Any

from PIL import ImageFont

PYTHON_VERSION = (3, 14, 5)
RUNTIME_DISTRIBUTIONS = {
    "Pillow": "12.3.0",
    "pypdf": "6.18.1",
    "reportlab": "5.0.1",
}
CANONICAL_DISTRIBUTIONS = {
    **RUNTIME_DISTRIBUTIONS,
    "numpy": "2.5.2",
    "pyvips": "3.1.1",
    "torch": "2.13.0+cpu",
}
NODE_VERSION = "v24.10.0"
PLAYWRIGHT_VERSION = "1.62.1"
CHROMIUM_VERSION = "151.0.7922.34"
LIBVIPS_VERSION = "8.18.5"
FONT_SHA256 = "69853909b940023570964e29cffe30da95aea8de3627736b5cd15ab30143169f"
THREADS = "1"


def _run(*command: str) -> str:
    # Every caller supplies repository-owned constant argv; no input crosses
    # this boundary and no shell is involved.
    result = subprocess.run(  # noqa: S603
        command, check=True, capture_output=True, text=True
    )
    return result.stdout.strip()


def _assert_distributions(expected: dict[str, str]) -> None:
    for name, version in expected.items():
        actual = importlib.metadata.version(name)
        if actual != version:
            raise RuntimeError(f"{name} must be {version}, found {actual}")


def _assert_font(repo_root: Path) -> None:
    browser_font = repo_root / "apps" / "web" / "public" / "fonts" / "ipw-standard.ttf"
    payload: Any = getattr(ImageFont.load_default(size=10), "font_bytes", None)
    if not isinstance(payload, bytes) or hashlib.sha256(payload).hexdigest() != FONT_SHA256:
        raise RuntimeError("Pillow's bundled IPW Standard font bytes do not match the pin")
    if not browser_font.is_file() or browser_font.read_bytes() != payload:
        raise RuntimeError("browser and worker IPW Standard font bytes differ")


def _assert_no_cuda_packages() -> None:
    forbidden_prefixes = ("nvidia-", "cuda-")
    offenders = sorted(
        distribution.metadata["Name"]
        for distribution in importlib.metadata.distributions()
        if str(distribution.metadata["Name"]).lower().startswith(forbidden_prefixes)
        or str(distribution.metadata["Name"]).lower() == "triton"
    )
    if offenders:
        raise RuntimeError(f"unapproved CUDA packages are installed: {offenders}")


def _assert_canonical_tools() -> dict[str, object]:
    import pyvips
    import torch

    if torch.version.cuda is not None or torch.cuda.is_available():
        raise RuntimeError("canonical Torch must be the CPU-only build")
    for name in ("OMP_NUM_THREADS", "MKL_NUM_THREADS"):
        if os.environ.get(name) != THREADS:
            raise RuntimeError(f"{name} must be pinned to {THREADS}")
    if torch.get_num_threads() != int(THREADS):
        raise RuntimeError(f"Torch must use {THREADS} CPU threads")
    native_vips = ".".join(str(pyvips.version(index)) for index in range(3))
    if native_vips != LIBVIPS_VERSION:
        raise RuntimeError(f"libvips must be {LIBVIPS_VERSION}, found {native_vips}")
    node = _run("node", "--version")
    if node != NODE_VERSION:
        raise RuntimeError(f"Node must be {NODE_VERSION}, found {node}")
    playwright = json.loads(
        _run(
            "node",
            "-e",
            "const p=require('./node_modules/@playwright/test/package.json');"
            "process.stdout.write(JSON.stringify({version:p.version}));",
        )
    )["version"]
    if playwright != PLAYWRIGHT_VERSION:
        raise RuntimeError(f"Playwright must be {PLAYWRIGHT_VERSION}, found {playwright}")
    chromium = _run(
        "node",
        "-e",
        "const {chromium}=require('@playwright/test');"
        "const {execFileSync}=require('node:child_process');"
        "process.stdout.write(execFileSync(chromium.executablePath(),['--version'],"
        "{encoding:'utf8'}).trim());",
    )
    if CHROMIUM_VERSION not in chromium:
        raise RuntimeError(f"Chromium must be {CHROMIUM_VERSION}, found {chromium}")
    _assert_no_cuda_packages()
    return {
        "node": node,
        "playwright": playwright,
        "chromium": chromium,
        "libvips": native_vips,
        "torch": torch.__version__,
        "torch_cpu_threads": torch.get_num_threads(),
        "torch_cuda": torch.version.cuda,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--runtime-only",
        action="store_true",
        help="verify only the dependency-minimal Cloud Run worker target",
    )
    args = parser.parse_args()
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        raise RuntimeError("canonical processing evidence requires Linux x86_64")
    if sys.version_info[:3] != PYTHON_VERSION:
        raise RuntimeError(f"Python must be {'.'.join(map(str, PYTHON_VERSION))}")
    repo_root = Path(__file__).resolve().parents[1]
    _assert_distributions(RUNTIME_DISTRIBUTIONS if args.runtime_only else CANONICAL_DISTRIBUTIONS)
    _assert_font(repo_root)
    evidence: dict[str, object] = {
        "platform": platform.platform(),
        "python": platform.python_version(),
        "distributions": RUNTIME_DISTRIBUTIONS if args.runtime_only else CANONICAL_DISTRIBUTIONS,
        "font_sha256": FONT_SHA256,
    }
    if not args.runtime_only:
        evidence.update(_assert_canonical_tools())
    sys.stdout.write(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
