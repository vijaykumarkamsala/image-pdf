"""Fetch pinned model weights, verifying them against recorded digests.

Gate B (D-039) in executable form. Every weight file is pinned by release tag,
byte count and SHA-256; both are checked before the file is written, and a
mismatch is reported as a supply-chain event rather than a transient error worth
retrying.

Weights are never committed. They land in a gitignored ``.tools/models`` directory
and are referenced from the licence register by hash, which is the same pattern
the corpus uses: Git holds the record, protected storage holds the bytes.

**Loading them is a separate risk from fetching them.** ``.pth`` is a Python
pickle, and unrestricted unpickling executes arbitrary code. The adapters load
with ``torch.load(weights_only=True)`` and verify the digest first - see
``ipw/processors/ai_adapters/common.py``.

    python tools/install_model_weights.py                    # fetch and verify
    python tools/install_model_weights.py --verify           # verify what is there
    python tools/install_model_weights.py --model swinir     # one model only
"""

from __future__ import annotations

import argparse
import hashlib
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path

REAL_ESRGAN = "https://github.com/xinntao/Real-ESRGAN/releases/download"
SWINIR = "https://github.com/JingyunLiang/SwinIR/releases/download"


@dataclass(frozen=True)
class PinnedWeight:
    """One weight file, pinned by tag, size and digest."""

    model: str
    component_id: str
    filename: str
    release_base: str
    release_tag: str
    sha256: str
    bytes_expected: int
    note: str

    @property
    def url(self) -> str:
        return f"{self.release_base}/{self.release_tag}/{self.filename}"


# Digests recorded on first fetch and pinned thereafter. A change here for the
# same release tag means the asset was replaced, which is a supply-chain event
# and not something to shrug at.
PINNED: tuple[PinnedWeight, ...] = (
    # --- Real-ESRGAN (POC-006) ------------------------------------------------
    PinnedWeight(
        model="real-esrgan",
        component_id="real-esrgan-weights-x4plus",
        filename="RealESRGAN_x4plus.pth",
        release_base=REAL_ESRGAN,
        release_tag="v0.1.0",
        sha256="4fa0d38905f75ac06eb49a7951b426670021be3018265fd191d2125df9d682f1",
        bytes_expected=67_040_989,
        note="RRDBNet generator, native x4",
    ),
    PinnedWeight(
        model="real-esrgan",
        component_id="real-esrgan-weights-x2plus",
        filename="RealESRGAN_x2plus.pth",
        release_base=REAL_ESRGAN,
        release_tag="v0.2.1",
        sha256="49fafd45f8fd7aa8d31ab2a22d14d91b536c34494a5cfe31eb5d89c2fa266abb",
        bytes_expected=67_061_725,
        note="RRDBNet generator, native x2",
    ),
    # --- SwinIR (POC-007) -----------------------------------------------------
    PinnedWeight(
        model="swinir",
        component_id="swinir-weights-realsr-m-x4-gan",
        filename="003_realSR_BSRGAN_DFO_s64w8_SwinIR-M_x4_GAN.pth",
        release_base=SWINIR,
        release_tag="v0.0",
        sha256="b9afb61e65e04eb7f8aba5095d070bbe9af28df76acd0c9405aeb33b814bcfc6",
        bytes_expected=67_129_861,
        note="real-world SR, GAN-trained, native x4",
    ),
    PinnedWeight(
        model="swinir",
        component_id="swinir-weights-realsr-m-x2-gan",
        filename="003_realSR_BSRGAN_DFO_s64w8_SwinIR-M_x2_GAN.pth",
        release_base=SWINIR,
        release_tag="v0.0",
        sha256="f397408977a3e07eb06afb7238d453a12ef35ebab7328a54241f307860dbe342",
        bytes_expected=66_974_517,
        note="real-world SR, GAN-trained, native x2",
    ),
    PinnedWeight(
        model="swinir",
        component_id="swinir-weights-colordn-noise15",
        filename="005_colorDN_DFWB_s128w8_SwinIR-M_noise15.pth",
        release_base=SWINIR,
        release_tag="v0.0",
        sha256="917cd972f7ba80786871add249ad43e4477ce2db59b4ad63e2fa446f7221d013",
        bytes_expected=122_905_743,
        note="colour denoise, trained for sigma 15",
    ),
    PinnedWeight(
        model="swinir",
        component_id="swinir-weights-colorcar-jpeg10",
        filename="006_colorCAR_DFWB_s126w7_SwinIR-M_jpeg10.pth",
        release_base=SWINIR,
        release_tag="v0.0",
        sha256="0005b707e0e6f75b4d13c7447e2f184858ddbdcec95aa7eb8c07e8afa1d26bd9",
        bytes_expected=102_873_665,
        note="colour JPEG artifact repair, trained for quality 10",
    ),
)

MODELS = tuple(dict.fromkeys(weight.model for weight in PINNED))


def repo_root_from_here() -> Path:
    return Path(__file__).resolve().parents[1]


def weights_dir(repo_root: Path) -> Path:
    return repo_root / ".tools" / "models"


def weight_path(repo_root: Path, weight: PinnedWeight) -> Path:
    return weights_dir(repo_root) / weight.filename


def digest_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def selected(model: str | None) -> tuple[PinnedWeight, ...]:
    if model is None:
        return PINNED
    return tuple(weight for weight in PINNED if weight.model == model)


def verify(repo_root: Path, model: str | None = None) -> tuple[list[str], list[str]]:
    """Check what is on disk against the pinned size and digest.

    Returns ``(mismatches, missing)`` as two lists, because they are two different
    events. A **mismatch** means the bytes on disk are not the bytes we pinned - a
    supply-chain event and a hard failure. **Missing** means the file was never
    fetched, which is the normal state of a fresh clone and of any host that never
    runs inference. Collapsing the two would either make the check suite
    unrunnable without a 500 MB download, or - far worse - train everyone to
    ignore the one failure that actually matters.
    """
    mismatches: list[str] = []
    missing: list[str] = []
    for weight in selected(model):
        path = weight_path(repo_root, weight)
        if not path.is_file():
            missing.append(f"{weight.filename}: not installed")
            continue
        # Size first: free, and it catches a truncated file before hashing 100 MB.
        actual_bytes = path.stat().st_size
        if actual_bytes != weight.bytes_expected:
            mismatches.append(
                f"{weight.filename}: SIZE MISMATCH - expected {weight.bytes_expected:,} "
                f"bytes, found {actual_bytes:,}. Treat this as a supply-chain event."
            )
            continue
        actual = digest_of(path)
        if actual != weight.sha256:
            mismatches.append(
                f"{weight.filename}: DIGEST MISMATCH - expected {weight.sha256}, found {actual}. "
                "Treat this as a supply-chain event."
            )
    return mismatches, missing


def install(repo_root: Path, model: str | None = None) -> int:
    target = weights_dir(repo_root)
    target.mkdir(parents=True, exist_ok=True)
    failures = 0
    chosen = selected(model)

    for weight in chosen:
        path = weight_path(repo_root, weight)
        if (
            path.is_file()
            and path.stat().st_size == weight.bytes_expected
            and digest_of(path) == weight.sha256
        ):
            sys.stdout.write(f"{weight.filename[:56]:<58} present and verified\n")
            continue

        sys.stdout.write(f"{weight.filename[:56]:<58} fetching {weight.release_tag}...\n")
        sys.stdout.flush()
        # The URL is built from pinned constants, never from caller input, and both
        # checks happen before anything is written.
        request = urllib.request.Request(  # noqa: S310
            weight.url, headers={"User-Agent": "ipw-benchmark-runner"}
        )
        payload = urllib.request.urlopen(request, timeout=900).read()  # noqa: S310

        if len(payload) != weight.bytes_expected:
            sys.stderr.write(
                f"\nSIZE MISMATCH for {weight.filename}. Nothing was written.\n"
                f"  expected {weight.bytes_expected:,}\n  actual   {len(payload):,}\n"
            )
            failures += 1
            continue

        actual = hashlib.sha256(payload).hexdigest()
        if actual != weight.sha256:
            sys.stderr.write(
                f"\nDIGEST MISMATCH for {weight.filename}. Nothing was written.\n"
                f"  expected {weight.sha256}\n  actual   {actual}\n"
                "The pinned asset does not match what was served. This is a supply-chain "
                "event, not a transient error.\n"
            )
            failures += 1
            continue

        path.write_bytes(payload)
        sys.stdout.write(f"{'':<58} verified {len(payload):,} bytes - {weight.note}\n")

    if failures:
        return 1

    total = sum(weight.bytes_expected for weight in chosen)
    sys.stdout.write(
        f"\n{len(chosen)} weight file(s), {total / 2**20:,.0f} MiB, in {target}\n"
        "Gitignored and never committed. Loaded with weights_only=True, digest verified "
        "first, so unpickling cannot execute code.\n"
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Fetch and verify pinned model weights.")
    parser.add_argument("--verify", action="store_true", help="verify without fetching")
    parser.add_argument(
        "--require-present",
        action="store_true",
        help="with --verify, also fail when a pinned file is absent (for inference hosts)",
    )
    parser.add_argument(
        "--model",
        choices=MODELS,
        default=None,
        help="restrict to one model (default: all)",
    )
    parser.add_argument("--repo-root", type=Path, default=repo_root_from_here())
    args = parser.parse_args(argv)

    if args.verify:
        mismatches, missing = verify(args.repo_root, args.model)
        for problem in mismatches:
            sys.stderr.write(f"{problem}\n")
        if mismatches:
            return 1
        if missing and args.require_present:
            for problem in missing:
                sys.stderr.write(f"{problem}\n")
            sys.stderr.write("weights are required on this host but are not installed\n")
            return 1
        for problem in missing:
            sys.stdout.write(f"{problem} (not a failure; run without --verify to fetch)\n")
        chosen = selected(args.model)
        sys.stdout.write(
            f"{len(chosen) - len(missing)}/{len(chosen)} pinned weight file(s) verified\n"
        )
        return 0

    return install(args.repo_root, args.model)


if __name__ == "__main__":
    raise SystemExit(main())
