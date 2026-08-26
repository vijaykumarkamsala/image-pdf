"""Asset manifest entry, provenance/rights and ground-truth relationship.

Rights fields are **present but permissive** in POC-001: they are recorded and
structurally validated, but nothing is gated on them yet. POC-002 turns them into
execution gates. Defining them now means the example manifest and the fixture
never have to be rewritten when the gates arrive.
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import Field, model_validator

from ipw.contracts.common import (
    AssetId,
    ContractModel,
    NonEmptyStr,
    PositiveInt,
    RelativePosixPath,
    SafeInt,
    Sha256Hex,
)


class AssetCategory(StrEnum):
    """Evaluation corpus categories from the benchmark plan section 5.1."""

    MODERN_MOBILE_PHOTO = "modern_mobile_photo"
    OLD_PHOTOGRAPH = "old_photograph"
    FACE_PORTRAIT = "face_portrait"
    DOCUMENT_SCREENSHOT = "document_screenshot"
    PRODUCT_CATALOGUE = "product_catalogue"
    ILLUSTRATION_ANIME = "illustration_anime"
    LOW_LIGHT_NOISY = "low_light_noisy"
    BACKGROUND_REMOVAL = "background_removal"
    LARGE_PROFESSIONAL = "large_professional"
    SYNTHETIC_FIXTURE = "synthetic_fixture"


class MediaType(StrEnum):
    """Declared media types. The initial supported set is JPG and PNG.

    Additional members exist so a manifest can *declare* an unsupported type and
    be rejected with ``MANIFEST.UNSUPPORTED_MEDIA_TYPE`` rather than a generic
    schema error.
    """

    JPEG = "image/jpeg"
    PNG = "image/png"
    TIFF = "image/tiff"
    WEBP = "image/webp"
    HEIC = "image/heic"
    AVIF = "image/avif"
    BMP = "image/bmp"
    GIF = "image/gif"


class GroundTruthRelationship(StrEnum):
    PAIRED = "paired"
    UNPAIRED = "unpaired"
    REFERENCE = "reference"


class Provenance(ContractModel):
    """Where an asset came from and what may lawfully be done with it.

    Mirrors the rights manifest required by benchmark plan section 5.3.
    """

    source: NonEmptyStr = Field(description="Where the asset came from, e.g. 'generated-in-repo'.")
    owner: NonEmptyStr = Field(description="Rights holder.")
    licence: NonEmptyStr = Field(description="Licence or permission under which it is used.")
    permitted_benchmark_use: bool = Field(description="May this asset be processed in benchmarks?")
    public_demo_permitted: bool = Field(description="May results appear in a public demo?")
    contains_people: bool
    contains_sensitive_information: bool
    acquired_on: str | None = Field(
        default=None, pattern=r"^\d{4}-\d{2}-\d{2}$", description="ISO-8601 date."
    )
    notes: str | None = None


class DegradationRecipe(ContractModel):
    """How a synthetically degraded asset was produced from its ground truth.

    Benchmark plan section 5.2: synthetic degradation must vary blur, noise,
    downsampling, JPEG compression and colour loss, and the recipe must be
    recorded so the pair is reproducible.
    """

    method: NonEmptyStr
    blur_radius_px: SafeInt | None = None
    noise_sigma_x100: SafeInt | None = None
    downsample_numerator: PositiveInt | None = None
    downsample_denominator: PositiveInt | None = None
    jpeg_quality: SafeInt | None = Field(default=None, ge=1, le=100)
    colour_loss: str | None = None
    seed: SafeInt | None = None


class ExternalRef(ContractModel):
    """Reference to an asset held outside Git in protected storage.

    Large or private benchmark assets are never committed. They are referenced by
    id and hash and fetched by an operator-supplied credential at run time.
    """

    storage: NonEmptyStr = Field(description="Logical storage name, e.g. 'corpus-private'.")
    key: NonEmptyStr = Field(
        description="Object key within that storage. Never a URL carrying credentials."
    )


class AssetManifestEntry(ContractModel):
    """One benchmark input asset, described by declared metadata only.

    POC-001 never decodes the image. The ``declared_*`` fields are assertions made
    by the manifest author; POC-003 verifies them against the real bytes.
    """

    asset_id: AssetId
    category: AssetCategory
    relative_path: RelativePosixPath | None = Field(
        default=None,
        description="Path relative to the asset root. Mutually exclusive with external_ref.",
    )
    external_ref: ExternalRef | None = None

    sha256: Sha256Hex = Field(description="SHA-256 of the original bytes. The provenance anchor.")
    declared_media_type: MediaType
    declared_extension: str = Field(pattern=r"^\.[a-z0-9]{2,5}$")
    declared_bytes: PositiveInt
    declared_width: PositiveInt
    declared_height: PositiveInt
    declared_channels: int = Field(ge=1, le=4)
    declared_bit_depth: int = Field(ge=1, le=32)

    ground_truth: GroundTruthRelationship = GroundTruthRelationship.UNPAIRED
    ground_truth_asset_id: AssetId | None = None
    degradation_recipe: DegradationRecipe | None = None

    # Optional at the schema layer so that an omitted block produces the precise
    # MANIFEST.MISSING_PROVENANCE policy failure instead of a generic schema error.
    provenance: Provenance | None = None

    notes: str | None = None

    @model_validator(mode="after")
    def _exactly_one_location(self) -> AssetManifestEntry:
        if (self.relative_path is None) == (self.external_ref is None):
            msg = "exactly one of 'relative_path' or 'external_ref' must be set"
            raise ValueError(msg)
        return self

    @property
    def declared_pixels(self) -> int:
        return self.declared_width * self.declared_height

    @property
    def is_local(self) -> bool:
        return self.relative_path is not None
