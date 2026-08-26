"""Canonical JSON serialisation.

An identity digest is only reproducible if the bytes fed to the hash are
reproducible. This module implements a deliberately **restricted** subset of RFC
8785 (JSON Canonicalization Scheme), chosen so that an equivalent implementation
in JavaScript - which the POC-005 browser lab will need - is a few lines rather
than a port.

Rules
-----
1. Permitted value types: ``dict``, ``list``/``tuple``, ``str``, ``int``,
   ``bool``, ``None``. **Floats are rejected**, not coerced. Float formatting
   differs across platforms and languages and is the single largest source of
   digest drift.
2. Object keys must be non-empty **ASCII** strings. Python sorts by code point
   and JavaScript sorts by UTF-16 code unit; for ASCII the two orders are
   identical, so restricting the alphabet removes the difference by construction.
3. Strings are NFC-normalised.
4. Integers must be exactly representable in IEEE-754 double precision
   (``|n| <= 2**53 - 1``) so JavaScript can reproduce them.
5. Output is compact (no whitespace), UTF-8, with no trailing newline.
"""

from __future__ import annotations

import json
import unicodedata
from collections.abc import Mapping, Sequence
from typing import Any

from ipw.contracts.common import SAFE_INT_MAX, SAFE_INT_MIN

__all__ = ["CanonicalisationError", "canonical_json", "canonical_text", "normalise"]


class CanonicalisationError(TypeError):
    """A value cannot be canonicalised deterministically."""


def _fail(path: str, message: str) -> CanonicalisationError:
    return CanonicalisationError(f"{path or '<root>'}: {message}")


def normalise(value: Any, path: str = "") -> Any:
    """Recursively validate and normalise ``value`` into canonical-safe form."""
    # bool must be tested before int: bool is a subclass of int in Python.
    if value is None or isinstance(value, bool):
        return value

    if isinstance(value, float):
        msg = (
            "float values are forbidden in canonical documents; use an integer "
            "(nanoseconds, bytes, percent) or a decimal string"
        )
        raise _fail(path, msg)

    if isinstance(value, int):
        if not (SAFE_INT_MIN <= value <= SAFE_INT_MAX):
            msg = f"integer {value} is outside the exactly-representable range"
            raise _fail(path, msg)
        return value

    if isinstance(value, str):
        return unicodedata.normalize("NFC", value)

    if isinstance(value, Mapping):
        out: dict[str, Any] = {}
        for raw_key, raw_value in value.items():
            if not isinstance(raw_key, str):
                raise _fail(path, f"object keys must be strings, found {type(raw_key).__name__}")
            if not raw_key:
                raise _fail(path, "object keys must be non-empty")
            if not raw_key.isascii():
                msg = (
                    f"object key {raw_key!r} must be ASCII so that key ordering is "
                    "identical in Python and JavaScript"
                )
                raise _fail(path, msg)
            if raw_key in out:
                raise _fail(path, f"duplicate object key {raw_key!r}")
            out[raw_key] = normalise(raw_value, f"{path}/{raw_key}")
        return out

    if isinstance(value, Sequence) and not isinstance(value, str | bytes | bytearray):
        return [normalise(item, f"{path}/{index}") for index, item in enumerate(value)]

    raise _fail(path, f"unsupported type {type(value).__name__}")


def canonical_text(value: Any) -> str:
    """Return the canonical JSON text for ``value``."""
    return json.dumps(
        normalise(value),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def canonical_json(value: Any) -> bytes:
    """Return the canonical UTF-8 bytes for ``value``. These are what get hashed."""
    return canonical_text(value).encode("utf-8")
