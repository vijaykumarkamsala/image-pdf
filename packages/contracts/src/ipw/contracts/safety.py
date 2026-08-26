"""Input inspection: safety policy, detected metadata and handling decision.

Design decision that shapes this whole module: **POC-003 parses headers, it never
decodes pixels.**

The acceptance criterion is "excessive decoded dimensions are caught *before
unsafe allocation* where possible". A library that decodes first and reports
dimensions afterwards has already allocated by the time you can check. Reading
the PNG ``IHDR`` chunk or the JPEG ``SOF`` segment gives exact dimensions, bit
depth and channel count from a few hundred bytes, so the decision is made before
a single pixel buffer exists.

Two consequences worth stating plainly:

* There is **no decode-bomb surface at all** in POC-003. A file declaring three
  gigapixels is rejected after ~30 bytes.
* No imaging dependency enters the repository. The runtime licence register stays
  at one entry. Pillow or libvips arrives with POC-004, which genuinely needs
  pixels, and enters the register with a proper disposition record (D-039).

Every threshold lives in :class:`SafetyPolicy`, never as a literal at a call
site - the POC-003 acceptance criterion requires the 25 MB / 100 MB policies to
be configurable rather than hard-coded throughout the codebase.
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import Field, model_validator

from ipw.contracts.asset import MediaType
from ipw.contracts.common import AssetId, ContractModel, NonNegInt, PositiveInt, SafeInt, Sha256Hex
from ipw.contracts.failure import NormalizedFailure

__all__ = [
    "DEFAULT_SAFETY_POLICY",
    "HandlingClass",
    "InspectionResult",
    "Orientation",
    "RiskFlag",
    "SafetyPolicy",
]

MB = 1024 * 1024


class HandlingClass(StrEnum):
    """Routing class assigned by inspection (PRODUCT_REQUIREMENTS.md section 14).

    ``EXTREME_CUSTOM`` is deliberately not ``INVALID``: D-022 requires an
    actionable professional or custom path rather than a blunt rejection, while
    hard safety ceilings still apply above it.
    """

    STANDARD = "standard"
    PROFESSIONAL = "professional"
    EXTREME_CUSTOM = "extreme_custom"
    INVALID = "invalid"


class RiskFlag(StrEnum):
    """Detected input risks. Recorded even when the asset is still accepted."""

    DECOMPRESSION_BOMB = "decompression_bomb"
    EXTENSION_SIGNATURE_MISMATCH = "extension_signature_mismatch"
    DECLARED_METADATA_MISMATCH = "declared_metadata_mismatch"
    UNSUPPORTED_BIT_DEPTH = "unsupported_bit_depth"
    UNSUPPORTED_CHANNEL_COUNT = "unsupported_channel_count"
    UNSUPPORTED_COLOUR_PROFILE = "unsupported_colour_profile"
    UNSUPPORTED_ENCODING = "unsupported_encoding"
    MALFORMED_METADATA = "malformed_metadata"
    ORIENTATION_METADATA_PRESENT = "orientation_metadata_present"
    ORIENTATION_METADATA_CONFLICT = "orientation_metadata_conflict"
    EXCESSIVE_PIXELS = "excessive_pixels"
    EXCESSIVE_BYTES = "excessive_bytes"
    EXCESSIVE_WORKING_MEMORY = "excessive_working_memory"
    TRANSPARENCY_PRESENT = "transparency_present"
    ANIMATED_CONTENT = "animated_content"
    INTERLACED = "interlaced"
    PROGRESSIVE = "progressive"
    TRUNCATED = "truncated"


class Orientation(ContractModel):
    """EXIF orientation, normalised **as metadata** - the original is never touched.

    POC-003 records the tag, derives the true display dimensions and states the
    transform a later stage must apply. It does not rotate pixels: that is a
    POC-004 processing step, and doing it here would mean writing to an original.

    Covers the ``USER_FLOWS_AND_EDGE_CASES.md`` section 5 case "orientation
    metadata conflicts with pixels: normalize preview without mutating original".
    """

    exif_tag: int | None = Field(default=None, ge=1, le=8)
    rotate_degrees: int = Field(default=0, description="Clockwise rotation to apply: 0/90/180/270.")
    mirrored: bool = Field(default=False, description="Whether a horizontal flip is also required.")
    swaps_axes: bool = Field(
        default=False,
        description="True when the transform exchanges width and height, so stored dimensions "
        "are not display dimensions.",
    )

    @classmethod
    def from_exif(cls, tag: int | None) -> Orientation:
        """Map an EXIF orientation tag to its normalisation transform."""
        table: dict[int, tuple[int, bool, bool]] = {
            1: (0, False, False),
            2: (0, True, False),
            3: (180, False, False),
            4: (180, True, False),
            5: (90, True, True),
            6: (90, False, True),
            7: (270, True, True),
            8: (270, False, True),
        }
        if tag is None or tag not in table:
            return cls()
        rotate, mirrored, swaps = table[tag]
        return cls(exif_tag=tag, rotate_degrees=rotate, mirrored=mirrored, swaps_axes=swaps)

    @property
    def is_identity(self) -> bool:
        return self.rotate_degrees == 0 and not self.mirrored


class SafetyPolicy(ContractModel):
    """Every inspection threshold, in one configurable place.

    POC-003 acceptance criterion: "25 MB/100 MB policies are configurable, not
    hard-coded throughout the codebase."
    """

    name: str = "default"

    # -- accepted encodings ------------------------------------------------
    supported_media_types: tuple[MediaType, ...] = (MediaType.JPEG, MediaType.PNG)
    supported_bit_depths: tuple[int, ...] = (8,)
    """PRODUCT_REQUIREMENTS.md section 15: preserve depth "where supported and
    tested". 16-bit is recorded as a risk until POC-012 validates it."""
    supported_channel_counts: tuple[int, ...] = (1, 3, 4)

    # -- tiers (D-021) -----------------------------------------------------
    standard_max_bytes: PositiveInt = 25 * MB
    professional_max_bytes: PositiveInt = 100 * MB
    extreme_max_bytes: PositiveInt = 512 * MB
    """Above this, no path exists: a hard ceiling protecting the platform."""

    standard_max_pixels: PositiveInt = 50_000_000
    professional_max_pixels: PositiveInt = 200_000_000
    extreme_max_pixels: PositiveInt = 400_000_000

    max_working_memory_bytes: PositiveInt = 8 * 1024 * MB
    """Hard ceiling on the estimated working set, independent of pixels and bytes."""

    # -- estimation --------------------------------------------------------
    working_memory_multiplier: PositiveInt = Field(
        default=3,
        description="Buffers a pipeline needs at once: input, output and scratch. Integer so "
        "the estimate never introduces a float into a contract document.",
    )

    # -- bomb detection ----------------------------------------------------
    decompression_bomb_ratio: PositiveInt = Field(
        default=1000,
        description="Flag when estimated decoded bytes exceed compressed bytes by this factor. "
        "A tiny file declaring enormous dimensions is the classic attack.",
    )
    decompression_bomb_min_pixels: PositiveInt = Field(
        default=8_000_000,
        description="Below this, a high expansion ratio is normal for flat images and is not "
        "treated as an attack.",
    )

    # -- read limits -------------------------------------------------------
    max_header_bytes: PositiveInt = Field(
        default=1 * MB,
        description="Upper bound on bytes read to parse headers. Inspection never reads the "
        "whole file except to hash it, and never allocates a pixel buffer.",
    )
    verify_declared_metadata: bool = Field(
        default=True,
        description="Cross-check manifest-declared metadata against what the bytes actually say.",
    )

    def bytes_per_sample(self, bit_depth: int) -> int:
        """Bytes one channel sample occupies once decoded, rounded up."""
        return max(1, (bit_depth + 7) // 8)

    def estimate_working_memory(self, pixels: int, channels: int, bit_depth: int) -> int:
        """Estimated peak working set for decoding this image.

        Integer arithmetic throughout: this figure is recorded in contract
        documents, and floats are forbidden there.
        """
        return pixels * channels * self.bytes_per_sample(bit_depth) * self.working_memory_multiplier

    @model_validator(mode="after")
    def _tiers_ascend(self) -> SafetyPolicy:
        if not (self.standard_max_bytes <= self.professional_max_bytes <= self.extreme_max_bytes):
            msg = "byte tiers must ascend: standard <= professional <= extreme"
            raise ValueError(msg)
        if not (
            self.standard_max_pixels <= self.professional_max_pixels <= self.extreme_max_pixels
        ):
            msg = "pixel tiers must ascend: standard <= professional <= extreme"
            raise ValueError(msg)
        return self


DEFAULT_SAFETY_POLICY = SafetyPolicy()


class InspectionResult(ContractModel):
    """Metadata and safety decision for one input asset.

    ``sha256`` is recomputed from the bytes actually read, never copied from the
    manifest. A mismatch against the manifest is what proves an original has not
    been altered in storage.
    """

    asset_id: AssetId
    sha256: Sha256Hex
    decision: HandlingClass

    detected_media_type: MediaType | None = None
    detected_encoding: str | None = Field(
        default=None, description="Sub-format actually found, e.g. 'jpeg-baseline', 'png'."
    )
    decoded_width: SafeInt | None = None
    decoded_height: SafeInt | None = None
    display_width: SafeInt | None = Field(
        default=None, description="Width after orientation normalisation. May swap with height."
    )
    display_height: SafeInt | None = None
    decoded_channels: int | None = Field(default=None, ge=1, le=4)
    decoded_bit_depth: int | None = Field(default=None, ge=1, le=32)
    has_alpha: bool | None = None
    orientation: Orientation = Orientation()
    colour_profile: str | None = None

    compressed_bytes: NonNegInt = 0
    decoded_pixels: NonNegInt = 0
    estimated_working_memory_bytes: NonNegInt = 0
    expansion_ratio: NonNegInt = Field(
        default=0, description="Estimated decoded bytes divided by compressed bytes, as an integer."
    )

    risk_flags: tuple[RiskFlag, ...] = ()
    failure: NormalizedFailure | None = None
    warnings: tuple[NormalizedFailure, ...] = ()

    header_bytes_read: NonNegInt = Field(
        default=0, description="How many bytes were parsed to reach this decision."
    )
    pixels_decoded: bool = Field(
        default=False,
        description="Whether any pixel buffer was allocated. POC-003 always reports False: it "
        "parses headers only, so an oversized image is rejected before allocation.",
    )
    inspected_without_decoding: bool = Field(
        default=False,
        description="True when only manifest-declared metadata was examined, with no file read. "
        "POC-001 set this True; POC-003 reads real bytes and sets it False.",
    )

    @property
    def accepted(self) -> bool:
        return self.decision is not HandlingClass.INVALID and self.failure is None

    @property
    def requires_professional_path(self) -> bool:
        return self.decision in {HandlingClass.PROFESSIONAL, HandlingClass.EXTREME_CUSTOM}
