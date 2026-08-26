"""Validation policy: every threshold in one place.

POC-003 acceptance criterion: "25 MB/100 MB policies are configurable, not
hard-coded throughout the codebase." Building that in now costs nothing;
retrofitting it later means touching every rule. POC-001 therefore reads every
limit from this object and never from a literal at the call site.

The policy is content-addressed (:meth:`ValidationPolicy.digest`) and its digest
is part of the run identity, so changing a threshold changes the ``run_id`` and
results produced under different policies never silently compare equal.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pydantic import Field

from ipw.benchmark_runner.ids import policy_id_of
from ipw.contracts.asset import MediaType
from ipw.contracts.common import ContractModel, NonEmptyStr, PositiveInt

__all__ = ["DEFAULT_POLICY", "ValidationPolicy", "load_policy"]

MB = 1024 * 1024


class ValidationPolicy(ContractModel):
    """Configurable limits applied to declared manifest metadata."""

    name: NonEmptyStr = "default"

    allowed_media_types: tuple[MediaType, ...] = (MediaType.JPEG, MediaType.PNG)
    """PRODUCT_REQUIREMENTS.md section 15: JPG and PNG initially. O-007 will widen this."""

    extension_media_types: dict[str, MediaType] = Field(
        default_factory=lambda: {
            ".jpg": MediaType.JPEG,
            ".jpeg": MediaType.JPEG,
            ".png": MediaType.PNG,
            ".tif": MediaType.TIFF,
            ".tiff": MediaType.TIFF,
            ".webp": MediaType.WEBP,
            ".heic": MediaType.HEIC,
            ".avif": MediaType.AVIF,
            ".bmp": MediaType.BMP,
            ".gif": MediaType.GIF,
        }
    )
    """Known extension-to-media-type mapping. Used to detect declared mismatches."""

    standard_max_bytes: PositiveInt = 25 * MB
    """D-021 standard path target."""

    professional_max_bytes: PositiveInt = 100 * MB
    """D-021 professional path target."""

    max_declared_bytes: PositiveInt = 100 * MB
    """Hard ceiling for a manifest-declared asset. Above this, an operator must use the
    custom/professional path (D-022), which POC-003 implements as a classification
    rather than a rejection."""

    max_declared_pixels: PositiveInt = 400_000_000
    """Decoded-pixel ceiling. Protects against manifests that declare a decompression
    bomb before POC-003's real decode guard exists."""

    max_manifest_bytes: PositiveInt = 2 * MB
    """Parser denial-of-service guard on the manifest document itself."""

    require_provenance: bool = True
    require_rights_decision: bool = True
    verify_local_hashes: bool = True
    verify_local_declared_bytes: bool = True
    allow_external_refs: bool = True

    def digest(self) -> str:
        """Content-addressed policy identifier."""
        return policy_id_of(self.model_dump(mode="json"))

    def as_json(self) -> dict[str, Any]:
        return dict(self.model_dump(mode="json"))


DEFAULT_POLICY = ValidationPolicy()


def load_policy(path: Path | None) -> ValidationPolicy:
    """Load a policy from JSON, or return the default when ``path`` is ``None``."""
    if path is None:
        return DEFAULT_POLICY
    raw = path.read_text(encoding="utf-8")
    return ValidationPolicy.model_validate(json.loads(raw))
