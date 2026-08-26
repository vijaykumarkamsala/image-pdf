"""Asset manifest document."""

from __future__ import annotations

from pydantic import Field

from ipw.contracts.asset import AssetManifestEntry
from ipw.contracts.common import ContractModel, NonEmptyStr, SlugId
from ipw.contracts.version import SCHEMA_VERSION


class AssetManifest(ContractModel):
    """A curated set of benchmark inputs.

    Git stores manifests, hashes and small rights-cleared fixtures. Large or
    private assets are referenced through ``external_ref`` and live in protected
    storage (AGENTS.md; benchmark plan section 15).
    """

    schema_version: str = Field(
        default=SCHEMA_VERSION, pattern=r"^\d+\.\d+\.\d+$", description="Contract version."
    )
    manifest_id: SlugId
    name: NonEmptyStr
    description: str | None = None
    assets: tuple[AssetManifestEntry, ...] = Field(min_length=1)

    @property
    def asset_ids(self) -> tuple[str, ...]:
        return tuple(a.asset_id for a in self.assets)
