"""Narrow cross-platform image-signature rules for compatibility evidence.

Canonical Linux evidence remains byte-exact. These helpers are only for the
Windows compatibility lane, where an ICC profile records its creating platform
and native libvips downscaling can differ by a final integer rounding step.
"""

from __future__ import annotations

import hashlib


def portable_metadata_value(key: object, value: object) -> object:
    """Describe metadata while ignoring only an ICC profile's host-platform tag."""

    if isinstance(value, bytes):
        if key == "icc_profile" and len(value) >= 44 and value[36:40] == b"acsp":
            normalized = value[:40] + b"\0\0\0\0" + value[44:]
            return {
                "bytes": len(value),
                "sha256_without_platform_signature": hashlib.sha256(normalized).hexdigest(),
            }
        return {"bytes": len(value), "sha256": hashlib.sha256(value).hexdigest()}
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, (list, tuple)):
        return [portable_metadata_value(key, item) for item in value]
    return repr(value)


def native_downscale_rounding_matches(
    canonical: bytes, candidate: bytes, *, pixel_count: int
) -> bool:
    """Accept only the bounded integer round-off seen in native downscalers.

    A candidate must have the same decoded buffer shape (checked by equal byte
    length), no channel may move by more than two integer levels, and the total
    absolute error may not exceed one level per output pixel. Callers restrict
    this rule to the demonstrated libvips downscale operations.
    """

    if len(canonical) != len(candidate) or pixel_count <= 0:
        return False
    total_delta = 0
    for expected, actual in zip(canonical, candidate, strict=True):
        delta = abs(expected - actual)
        if delta > 2:
            return False
        total_delta += delta
        if total_delta > pixel_count:
            return False
    return True
