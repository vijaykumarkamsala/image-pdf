"""Deterministic, collision-resistant identifiers.

Identifiers are **content-addressed**: an id is the digest of the declared inputs
that define the thing it names. Two identical runs on two machines produce the
same ``run_id``; a retry of a failed asset produces the same ``result_id``.

Construction
------------
1. Build an identity document containing only declared inputs.
2. Prepend ``_id_kind`` and ``_schema_version`` for **domain separation**, so a
   run identity can never collide with a result identity that happens to have the
   same field values.
3. Canonicalise (:mod:`ipw.benchmark_runner.canonical`).
4. SHA-256, then base32-lower, unpadded, truncated to 32 characters = **160
   bits**. Collision-resistant far beyond benchmark scale, and short enough to
   read in a log line.

What is deliberately excluded
-----------------------------
Timestamps, hostnames, durations, memory readings, attempt counters and output
paths never enter an identity document. If they did, a retry would mint a new id
and the idempotency guarantee - and with it the "no duplicate billing" rule -
would be unprovable.
"""

from __future__ import annotations

import base64
import hashlib
from collections.abc import Mapping
from typing import Any, Final

from ipw.benchmark_runner.canonical import canonical_json
from ipw.contracts.version import SCHEMA_VERSION

__all__ = [
    "ID_BODY_LENGTH",
    "IdKind",
    "digest_hex",
    "digest_id",
    "identity_document",
    "manifest_id_of",
    "policy_id_of",
    "report_id_of",
    "result_id_of",
    "run_id_of",
]

ID_BODY_LENGTH: Final = 32
"""Base32 characters after the prefix. 32 x 5 bits = 160 bits of digest."""

_PREFIX: Final[dict[str, str]] = {
    "run": "run",
    "result": "res",
    "report": "rep",
    "manifest": "mfst",
    "policy": "pol",
    "runtime": "rt",
    "asset": "ast",
}

IdKind = str


def identity_document(kind: IdKind, payload: Mapping[str, Any]) -> dict[str, Any]:
    """Wrap ``payload`` with domain-separation fields."""
    if kind not in _PREFIX:
        msg = f"unknown identity kind {kind!r}; expected one of {sorted(_PREFIX)}"
        raise ValueError(msg)
    if "_id_kind" in payload or "_schema_version" in payload:
        msg = "payload must not define reserved keys '_id_kind' or '_schema_version'"
        raise ValueError(msg)
    return {"_id_kind": kind, "_schema_version": SCHEMA_VERSION, **payload}


def digest_hex(payload: Mapping[str, Any], kind: IdKind) -> str:
    """Full 64-character SHA-256 hex digest of a domain-separated identity."""
    return hashlib.sha256(canonical_json(identity_document(kind, payload))).hexdigest()


def digest_id(kind: IdKind, payload: Mapping[str, Any]) -> str:
    """Return the prefixed, truncated, base32 identifier."""
    raw = hashlib.sha256(canonical_json(identity_document(kind, payload))).digest()
    body = base64.b32encode(raw).decode("ascii").rstrip("=").lower()[:ID_BODY_LENGTH]
    return f"{_PREFIX[kind]}_{body}"


# --------------------------------------------------------------- convenience --


def manifest_id_of(manifest_json: Mapping[str, Any]) -> str:
    """Digest id for a manifest's *content*, independent of file formatting."""
    return digest_id("manifest", {"manifest": manifest_json})


def policy_id_of(policy_json: Mapping[str, Any]) -> str:
    """Digest id for the validation policy in force."""
    return digest_id("policy", {"policy": policy_json})


def run_id_of(run_identity_json: Mapping[str, Any]) -> str:
    """Digest id for a :class:`~ipw.contracts.run.RunIdentity`."""
    return digest_id("run", {"identity": run_identity_json})


def result_id_of(result_identity_json: Mapping[str, Any]) -> str:
    """Digest id for a :class:`~ipw.contracts.result.ResultIdentity`."""
    return digest_id("result", {"identity": result_identity_json})


def report_id_of(report_identity_json: Mapping[str, Any]) -> str:
    """Digest id for a :class:`~ipw.contracts.report.ReportIdentity`."""
    return digest_id("report", {"identity": report_identity_json})
