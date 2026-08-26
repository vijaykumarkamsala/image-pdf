"""Generate cross-language canonicalisation vectors.

The single most important artifact in POC-005. Two independent implementations of
the canonicalisation and digest rules now exist - Python in the benchmark runner,
TypeScript in the browser lab - and a benchmark whose two halves disagree about
identity is worse than one with a single half.

This writes a committed file of inputs and their expected canonical text and
digest. Both languages verify against the *same* file, so agreement is proved
rather than assumed, and a divergence fails whichever side drifted.

The vectors deliberately include the cases where the two languages could plausibly
differ:

* non-ASCII string values (Python `ensure_ascii=False` versus `JSON.stringify`)
* combining characters (NFC normalisation on both sides)
* control characters and quotes (escape-sequence spelling)
* key ordering, including keys that sort differently as bytes than as text
* integers at the edge of exact representation
* deeply nested and empty structures

...and the cases both must reject:

* non-integer numbers
* non-ASCII object keys
* out-of-range integers

    python tools/make_canonical_vectors.py
    python tools/make_canonical_vectors.py --check
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

VALID_CASES: list[tuple[str, str, Any]] = [
    ("empty-object", "the degenerate case", {}),
    ("empty-array", "an empty list is not null", {"items": []}),
    ("flat", "plain scalars", {"a": 1, "b": True, "c": None, "d": "text"}),
    (
        "key-order",
        "declaration order must not affect output",
        {"zebra": 1, "alpha": 2, "Mango": 3, "_under": 4, "0digit": 5},
    ),
    (
        "key-order-punctuation",
        "keys whose ASCII order differs from a naive alphabetical order",
        {"a-b": 1, "a_b": 2, "a.b": 3, "aB": 4, "ab": 5},
    ),
    ("nested", "nesting must sort at every level", {"outer": {"z": {"y": 1, "a": 2}, "a": 3}}),
    ("array-of-objects", "arrays keep order; their objects sort", [{"b": 1, "a": 2}, {"d": 3}]),
    ("integers", "integer edges", {"zero": 0, "neg": -42, "big": 9007199254740991}),
    ("integer-min", "the negative edge", {"n": -9007199254740991}),
    (
        "unicode-values",
        "non-ASCII values must not be escaped by either language",
        {"name": "café", "city": "München", "emoji": "photo 📷", "cjk": "画像"},
    ),
    (
        "unicode-nfc",
        "a decomposed sequence must normalise to the composed form",
        {"composed": "é", "decomposed": "é"},
    ),
    (
        "escapes",
        "quotes, backslashes and control characters",
        {"quote": 'say "hi"', "backslash": "a\\b", "newline": "a\nb", "tab": "a\tb"},
    ),
    (
        "control-chars",
        "control characters below 0x20 have exactly one correct escape spelling",
        {"bell": "\u0007", "nul": "\u0000", "vertical_tab": "\u000b", "esc": "\u001b"},
    ),
    (
        "realistic-result-identity",
        "the shape an actual result identity takes",
        {
            "schema_version": "1.1.0",
            "run_id": "run_" + "a" * 32,
            "asset_id": "fixture-synthetic-gradient-64",
            "input_sha256": "ab8dbedf1a0e3bb82496203c6b9f8a1239dca680884f318012bc99d45e0ab5fd",
            "operation_kind": "resize",
            "variant": "standard_browser_preview",
            "effective_settings": {
                "kind": "resize",
                "algorithm": "lanczos",
                "target_width": 32,
                "target_height": 32,
                "preserve_aspect_ratio": True,
                "scale_numerator": None,
                "scale_denominator": None,
            },
        },
    ),
]

# Inputs both implementations must refuse, and the reason.
REJECT_CASES: list[tuple[str, str, Any]] = [
    ("float", "non-integer numbers are the largest source of cross-platform drift", {"n": 1.5}),
    ("float-zero", "even 0.5 must be refused, not rounded", {"n": 0.5}),
    ("non-ascii-key", "key ordering would differ between the languages", {"clé": 1}),
    ("emoji-key", "same reason, above the basic plane", {"📷": 1}),
    ("integer-too-large", "beyond exact representation in a JS number", {"n": 9007199254740992}),
    ("integer-too-small", "the negative counterpart", {"n": -9007199254740992}),
    ("empty-key", "an empty key is not addressable", {"": 1}),
]


def canonical_text(value: Any) -> str:
    from ipw.benchmark_runner.canonical import canonical_text as impl

    return impl(value)


def repo_root_from_here() -> Path:
    return Path(__file__).resolve().parents[1]


def vectors_path(repo_root: Path) -> Path:
    return repo_root / "data" / "contract-vectors" / "canonical-vectors.json"


def build(repo_root: Path) -> dict[str, Any]:
    from ipw.benchmark_runner.ids import digest_id, identity_document
    from ipw.contracts.version import SCHEMA_VERSION

    valid: list[dict[str, Any]] = []
    for name, why, value in VALID_CASES:
        text = canonical_text(value)
        encoded = text.encode("utf-8")
        valid.append(
            {
                "name": name,
                "why": why,
                "input": value,
                "canonical_text": text,
                "canonical_bytes_sha256": hashlib.sha256(encoded).hexdigest(),
                "canonical_byte_length": len(encoded),
            }
        )

    # One payload, four kinds: proves domain separation produces four distinct ids
    # from identical content, in both languages.
    payload: dict[str, Any] = {"identity": {"example": "value", "n": 7}}
    identities: list[dict[str, Any]] = []
    for kind in ("run", "result", "report", "manifest"):
        identities.append(
            {
                "kind": kind,
                "payload": payload,
                "identity_document": identity_document(kind, payload),
                "id": digest_id(kind, payload),
            }
        )

    return {
        "schema_version": SCHEMA_VERSION,
        "note": (
            "Cross-language canonicalisation vectors. Both the Python benchmark runner and "
            "the TypeScript browser lab verify against this file, so agreement between the "
            "two implementations is proved rather than assumed. Regenerate with "
            "tools/make_canonical_vectors.py after any change to the canonicalisation rules, "
            "and expect the TypeScript tests to fail until that side is updated too."
        ),
        "valid": valid,
        "reject": [{"name": name, "why": why, "input": value} for name, why, value in REJECT_CASES],
        "identities": identities,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate cross-language canonical vectors.")
    parser.add_argument("--check", action="store_true", help="verify without writing")
    parser.add_argument("--repo-root", type=Path, default=repo_root_from_here())
    args = parser.parse_args(argv)

    document = build(args.repo_root)
    rendered = json.dumps(document, indent=2, ensure_ascii=False, sort_keys=True) + "\n"
    target = vectors_path(args.repo_root)

    if args.check:
        if not target.is_file():
            sys.stderr.write(f"vectors missing: {target}\n")
            return 1
        if target.read_text(encoding="utf-8") != rendered:
            sys.stderr.write(
                "canonical vectors are out of date.\n"
                "Run: python tools/make_canonical_vectors.py\n"
                "Then re-run the TypeScript tests - both sides must agree.\n"
            )
            return 1
        sys.stdout.write(
            f"canonical vectors current: {len(document['valid'])} valid, "
            f"{len(document['reject'])} rejected, {len(document['identities'])} identities\n"
        )
        return 0

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(rendered, encoding="utf-8", newline="\n")
    sys.stdout.write(
        f"wrote {target.relative_to(args.repo_root).as_posix()}: "
        f"{len(document['valid'])} valid, {len(document['reject'])} rejected, "
        f"{len(document['identities'])} identities\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
