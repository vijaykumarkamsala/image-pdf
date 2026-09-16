"""Additive, isolated Image Quality Editor face-work contracts.

These records do not authorize a model or replace ordinary Restore contracts.
Native composition consumes server-held proposals, never arbitrary client pixels.
"""

from __future__ import annotations

import hashlib
import json
from typing import Annotated, Literal

from pydantic import Field, model_validator

from ipw.contracts.common import ContractModel, NonEmptyStr, Sha256Hex, SlugId

FaceCoordinate = Annotated[int, Field(strict=True, ge=0, le=2**31 - 1)]
FaceDimension = Annotated[int, Field(strict=True, ge=1, le=2**31 - 1)]


class FacePermissionRecord(ContractModel):
    @model_validator(mode="before")
    @classmethod
    def _literal_permission(cls, value: object) -> object:
        if isinstance(value, dict):
            for field in (
                "allow_reconstructed_face_detail",
                "acknowledged_possible_identity_change",
            ):
                if field in value and value[field] is not True:
                    raise ValueError("face permission and acknowledgement require literal true")
            if "candidate_count" in value and type(value["candidate_count"]) is not int:
                raise ValueError("face candidate count must be an integer")
        return value


class NativeFaceContext(ContractModel):
    source_sha256: Sha256Hex
    base_output_sha256: Sha256Hex
    source_width: FaceDimension
    source_height: FaceDimension
    output_width: FaceDimension
    output_height: FaceDimension
    bit_depth: Literal[8, 16]
    colour_authority_sha256: Sha256Hex

    @model_validator(mode="after")
    def _same_source_framing(self) -> NativeFaceContext:
        if self.output_width * self.source_height != self.output_height * self.source_width:
            raise ValueError("native face composition cannot change source framing")
        if self.output_width * self.output_height * 8 > 2**53 - 1:
            raise ValueError("native face dimensions exceed safe addressing")
        return self


class NativeFaceRegion(ContractModel):
    x: FaceCoordinate
    y: FaceCoordinate
    width: FaceDimension
    height: FaceDimension

    @model_validator(mode="after")
    def _bounded_patch(self) -> NativeFaceRegion:
        if self.width * self.height > 4_000_000:
            raise ValueError("face proposal exceeds the bounded region budget")
        return self


class NativeFaceCandidate(ContractModel):
    candidate_id: SlugId
    context: NativeFaceContext
    model_sha256: Sha256Hex
    dependency_lock_sha256: Sha256Hex
    fidelity_permyriad: int = Field(strict=True, ge=0, le=10_000)
    region: NativeFaceRegion
    pixels_sha256: Sha256Hex
    mask_sha256: Sha256Hex

    @model_validator(mode="after")
    def _region_fits(self) -> NativeFaceCandidate:
        region, context = self.region, self.context
        if region.x + region.width > context.output_width or (
            region.y + region.height > context.output_height
        ):
            raise ValueError("reviewed face region must fit the base output")
        return self


def native_face_candidate_sha256(candidate: NativeFaceCandidate) -> str:
    """Versioned digest binds framing, native colour/precision and pixel/mask hashes.

    RGBA pixel hashes use row-major straight channels, uint8 or little-endian
    uint16; mask hashes use row-major uint8. No floats enter this identity.
    """
    payload = ["ipw-native-face-candidate-v1", candidate.model_dump(mode="json")]
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(encoded.encode("ascii")).hexdigest()


class NativeFaceReview(FacePermissionRecord):
    source_sha256: Sha256Hex
    base_output_sha256: Sha256Hex
    candidate_sha256: Sha256Hex
    allow_reconstructed_face_detail: Literal[True]
    acknowledged_possible_identity_change: Literal[True]


class NativeFaceCompositionRequest(ContractModel):
    contract_version: Literal["image-quality-face-v1"] = "image-quality-face-v1"
    operation: Literal["explicit-reviewed-face-compose"] = "explicit-reviewed-face-compose"
    candidate: NativeFaceCandidate
    review: NativeFaceReview

    @model_validator(mode="after")
    def _review_matches(self) -> NativeFaceCompositionRequest:
        candidate, review = self.candidate, self.review
        if (
            review.source_sha256 != candidate.context.source_sha256
            or (review.base_output_sha256 != candidate.context.base_output_sha256)
            or review.candidate_sha256 != native_face_candidate_sha256(candidate)
        ):
            raise ValueError("native face review is stale or belongs to different pixels")
        return self


class NativeFaceRelease(ContractModel):
    model_id: NonEmptyStr
    model_version: NonEmptyStr
    model_sha256: Sha256Hex
    dependency_lock_sha256: Sha256Hex
    commercial_rights: Literal["pending", "approved", "rejected"]
    rights_evidence_id: NonEmptyStr | None = None
    quality_review: Literal["pending", "approved", "rejected"]
    quality_evidence_id: NonEmptyStr | None = None


class FaceQualityCandidateRequest(FacePermissionRecord):
    contract_version: Literal["image-quality-face-v1"]
    base_image_quality_request_id: SlugId
    source_sha256: Sha256Hex
    base_output_sha256: Sha256Hex
    allow_reconstructed_face_detail: Literal[True]
    fidelity_permyriad: int = Field(strict=True, ge=0, le=10_000)
    candidate_count: Literal[2, 3]


class FaceQualityCapabilities(ContractModel):
    contract_version: Literal["image-quality-face-v1"] = "image-quality-face-v1"
    available: Literal[False] = False
    native_still_renderer_implemented: Literal[True] = True
    native_jobs_integrated: Literal[False] = False
    native_animation_supported: Literal[False] = False
    supported_still_bit_depths: tuple[Literal[8, 16], ...] = (8, 16)
    preserves_base_alpha: Literal[True] = True
    blockers: tuple[NonEmptyStr, ...] = Field(min_length=1)


IMAGE_QUALITY_FACE_SCHEMA_EXPORTS: dict[str, type[ContractModel]] = {
    "native-face-composition-request": NativeFaceCompositionRequest,
    "native-face-release": NativeFaceRelease,
    "face-quality-candidate-request": FaceQualityCandidateRequest,
    "face-quality-capabilities": FaceQualityCapabilities,
}
