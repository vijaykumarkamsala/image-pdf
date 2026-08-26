"""Draft a corpus manifest from images on disk, leaving the rights answers blank.

Fills in everything a machine can determine - SHA-256, dimensions, channels, bit
depth, media type, byte count - by parsing headers only. No image is decoded, so a
malformed or oversized file is reported rather than loaded.

Deliberately does **not** guess the rights fields. ``permitted_benchmark_use``,
``public_demo_permitted``, ``contains_people`` and
``contains_sensitive_information`` are left as ``null`` for a human to answer, and
the manifest will fail validation until they are filled in. An asset with unknown
rights is not "probably fine", and a tool that defaulted these to ``true`` would
be quietly asserting permission nobody granted.

    python tools/draft_corpus_manifest.py
    python tools/draft_corpus_manifest.py --category old_photograph
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

CATEGORIES = (
    "old_photograph",
    "face_portrait",
    "document_screenshot",
    "modern_mobile_photo",
    "product_catalogue",
    "illustration_anime",
    "low_light_noisy",
    "background_removal",
    "large_professional",
)

RIGHTS_PLACEHOLDER = "ANSWER-REQUIRED"


def repo_root_from_here() -> Path:
    return Path(__file__).resolve().parents[1]


def corpus_dir(repo_root: Path) -> Path:
    return repo_root / "data" / "corpus"


def slugify(name: str) -> str:
    """Turn a filename into a valid asset id."""
    stem = "".join(c if c.isalnum() or c in "._-" else "-" for c in name.lower())
    stem = stem.strip("-.") or "asset"
    return stem if len(stem) >= 4 else f"asset-{stem}"


def draft(repo_root: Path, default_category: str) -> int:
    from ipw.contracts.runtime import InputRef
    from ipw.processors.inspection import inspect_input

    images = corpus_dir(repo_root) / "images"
    if not images.is_dir():
        images.mkdir(parents=True, exist_ok=True)
        sys.stdout.write(f"created {images}\nDrop your images there and run this again.\n")
        return 0

    files = sorted(p for p in images.rglob("*") if p.is_file() and not p.name.startswith("."))
    if not files:
        sys.stdout.write(f"no images found in {images}\n")
        return 0

    assets: list[dict[str, object]] = []
    rejected = 0

    for path in files:
        payload = path.read_bytes()
        ref = InputRef(
            asset_id="draft",
            expected_sha256=hashlib.sha256(payload).hexdigest(),
            path=path,
            declared_bytes=len(payload),
        )
        result = inspect_input(ref)

        if not result.accepted:
            code = result.failure.code.value if result.failure else "UNKNOWN"
            message = result.failure.message if result.failure else ""
            sys.stderr.write(f"SKIPPED {path.name}: [{code}] {message}\n")
            rejected += 1
            continue

        assets.append(
            {
                "asset_id": slugify(path.stem),
                "category": default_category,
                "relative_path": path.relative_to(repo_root).as_posix(),
                "sha256": result.sha256,
                "declared_media_type": result.detected_media_type.value
                if result.detected_media_type
                else "image/jpeg",
                "declared_extension": path.suffix.lower(),
                "declared_bytes": result.compressed_bytes,
                "declared_width": result.decoded_width,
                "declared_height": result.decoded_height,
                "declared_channels": result.decoded_channels,
                "declared_bit_depth": result.decoded_bit_depth,
                "ground_truth": "unpaired",
                "provenance": {
                    "source": RIGHTS_PLACEHOLDER,
                    "owner": RIGHTS_PLACEHOLDER,
                    "licence": RIGHTS_PLACEHOLDER,
                    # Left null on purpose: a tool must not assert permission.
                    "permitted_benchmark_use": None,
                    "public_demo_permitted": None,
                    "contains_people": None,
                    "contains_sensitive_information": None,
                },
                "notes": (
                    f"Drafted from headers. Handling tier: {result.decision.value}. "
                    f"Set the category and answer the rights fields before validating."
                ),
            }
        )
        sys.stdout.write(
            f"{path.name:<44} {result.decoded_width}x{result.decoded_height} "
            f"{result.decision.value:<14} {result.compressed_bytes:>10,} B\n"
        )

    target = corpus_dir(repo_root) / "corpus.manifest.json"
    document = {
        "schema_version": "1.1.0",
        "manifest_id": "evaluation-corpus",
        "name": "Evaluation corpus",
        "description": (
            "Product-owner supplied evaluation corpus. Images live in protected storage "
            "and are never committed; this manifest records ids, hashes and rights."
        ),
        "assets": assets,
    }
    target.write_text(
        json.dumps(document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n"
    )

    sys.stdout.write(f"\nwrote {target} with {len(assets)} asset(s)\n")
    if rejected:
        sys.stdout.write(f"{rejected} file(s) skipped - see the reasons above\n")
    sys.stdout.write(
        "\nNEXT: answer the rights fields marked ANSWER-REQUIRED and null, then run\n"
        "  bench validate-manifest data/corpus/corpus.manifest.json\n"
        "Validation fails until every asset has provenance. That is deliberate.\n"
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Draft a corpus manifest from images on disk.")
    parser.add_argument(
        "--category",
        choices=CATEGORIES,
        default="modern_mobile_photo",
        help="category applied to every drafted asset; edit per-asset afterwards",
    )
    parser.add_argument("--repo-root", type=Path, default=repo_root_from_here())
    args = parser.parse_args(argv)
    return draft(args.repo_root, args.category)


if __name__ == "__main__":
    raise SystemExit(main())
