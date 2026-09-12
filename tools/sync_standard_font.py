"""Materialise and verify the browser copy of the deterministic standard font."""

from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path
from typing import Any

from PIL import ImageFont

REPO_ROOT = Path(__file__).resolve().parents[1]
TARGET = REPO_ROOT / "apps" / "web" / "public" / "fonts" / "ipw-standard.ttf"
EXPECTED_SHA256 = "69853909b940023570964e29cffe30da95aea8de3627736b5cd15ab30143169f"


def bundled_font_bytes() -> bytes:
    """Return Pillow 12.3.0's CC0 Aileron Regular subset after identity checks."""

    font: Any = ImageFont.load_default(size=10)
    payload = getattr(font, "font_bytes", None)
    if font.getname() != ("Aileron", "Regular") or font.layout_engine != ImageFont.Layout.BASIC:
        raise RuntimeError("Pillow's standard font identity or layout engine changed")
    if not isinstance(payload, bytes) or hashlib.sha256(payload).hexdigest() != EXPECTED_SHA256:
        raise RuntimeError("Pillow's standard font bytes changed")
    return payload


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    expected = bundled_font_bytes()
    if args.check:
        if not TARGET.is_file() or TARGET.read_bytes() != expected:
            sys.stderr.write("standard font drift: run tools/sync_standard_font.py\n")
            return 1
        sys.stdout.write(f"standard font matches pinned Aileron subset ({EXPECTED_SHA256})\n")
        return 0
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_bytes(expected)
    sys.stdout.write(f"wrote {TARGET.relative_to(REPO_ROOT)} ({EXPECTED_SHA256})\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
