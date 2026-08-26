"""Install the pinned libvips native library locally (Windows).

``pyvips`` is only a binding: pip does not ship libvips itself. On Linux and
macOS a package manager provides it (``apt install libvips``, ``brew install
vips``); on Windows it must be fetched from the official build repository.

This script does that **through the Gate B discipline** rather than around it
(D-039): the version and official source are pinned constants, the archive's
SHA-256 is verified against a recorded digest before anything is extracted, and
the result lands in a gitignored directory inside the repository rather than
touching the system PATH.

If the digest ever fails to match for the pinned version, that is a supply-chain
event, not a transient error. The script refuses and says so.

    python tools/install_libvips.py            # install
    python tools/install_libvips.py --verify   # check an existing install
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

# --- pinned, per D-039 --------------------------------------------------------
VERSION = "8.18.5"
ARCHIVE = f"vips-dev-x64-web-{VERSION}.zip"
OFFICIAL_SOURCE = (
    f"https://github.com/libvips/build-win64-mxe/releases/download/v{VERSION}/{ARCHIVE}"
)
ARCHIVE_SHA256 = "0b31bf577de68b2a97b38ade77023fbe63053a256d39e6f07bc439719f0fe0b6"
ARCHIVE_BYTES = 11_324_620

# The "web" build carries JPEG, PNG and WebP without the heavier format set,
# which matches the approved initial format list (PRODUCT_REQUIREMENTS.md s15).

REQUIRED_DLLS = ("libvips-42.dll",)


def install_root(repo_root: Path) -> Path:
    return repo_root / ".tools" / "vips"


def bin_dir(repo_root: Path) -> Path:
    return install_root(repo_root) / "bin"


def repo_root_from_here() -> Path:
    return Path(__file__).resolve().parents[1]


def verify(repo_root: Path) -> tuple[bool, list[str]]:
    """Check that an install is present and complete."""
    problems: list[str] = []
    target = bin_dir(repo_root)
    if not target.is_dir():
        return False, [f"libvips is not installed: {target} does not exist"]
    problems.extend(
        f"missing native library: {name}" for name in REQUIRED_DLLS if not (target / name).is_file()
    )
    provenance = install_root(repo_root).parent / "vips-provenance.json"
    if not provenance.is_file():
        problems.append("provenance record is missing")
    else:
        recorded = json.loads(provenance.read_text(encoding="utf-8"))
        if recorded.get("archive_sha256") != ARCHIVE_SHA256:
            problems.append(
                "recorded archive digest does not match the pinned digest; "
                "treat this as a supply-chain event"
            )
    return not problems, problems


def install(repo_root: Path) -> int:
    sys.stdout.write(f"official source : {OFFICIAL_SOURCE}\n")
    sys.stdout.write(f"pinned sha256   : {ARCHIVE_SHA256}\n")

    request = urllib.request.Request(
        OFFICIAL_SOURCE, headers={"User-Agent": "ipw-benchmark-runner"}
    )
    payload = urllib.request.urlopen(request, timeout=300).read()  # noqa: S310 - pinned https URL

    digest = hashlib.sha256(payload).hexdigest()
    sys.stdout.write(f"downloaded      : {len(payload):,} bytes\n")
    sys.stdout.write(f"actual sha256   : {digest}\n")

    if digest != ARCHIVE_SHA256:
        sys.stderr.write(
            "\nDIGEST MISMATCH. The pinned archive does not match what was served.\n"
            "This is a supply-chain event, not a transient error. Nothing was extracted.\n"
            f"  expected {ARCHIVE_SHA256}\n  actual   {digest}\n"
        )
        return 1

    target = install_root(repo_root)
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)

    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        archive.extractall(target)

    # The archive nests everything under a single versioned directory; flatten it
    # so the layout is stable across versions.
    inner = next(path for path in target.iterdir() if path.is_dir())
    for child in inner.iterdir():
        shutil.move(str(child), str(target / child.name))
    inner.rmdir()

    (target.parent / "vips-provenance.json").write_text(
        json.dumps(
            {
                "component_id": "libvips",
                "version": VERSION,
                "official_source": OFFICIAL_SOURCE,
                "archive_sha256": digest,
                "archive_bytes": len(payload),
                "note": "Verified against the digest pinned in tools/install_libvips.py (D-039).",
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    ok, problems = verify(repo_root)
    for problem in problems:
        sys.stderr.write(f"{problem}\n")
    if ok:
        count = len(list(bin_dir(repo_root).glob("*.dll")))
        sys.stdout.write(f"installed       : {count} DLLs into {bin_dir(repo_root)}\n")
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Install the pinned libvips native library.")
    parser.add_argument("--verify", action="store_true", help="check an existing install only")
    parser.add_argument("--repo-root", type=Path, default=repo_root_from_here())
    args = parser.parse_args(argv)

    if args.verify:
        ok, problems = verify(args.repo_root)
        for problem in problems:
            sys.stderr.write(f"{problem}\n")
        if ok:
            sys.stdout.write(f"libvips {VERSION} present and verified\n")
        return 0 if ok else 1

    return install(args.repo_root)


if __name__ == "__main__":
    raise SystemExit(main())
