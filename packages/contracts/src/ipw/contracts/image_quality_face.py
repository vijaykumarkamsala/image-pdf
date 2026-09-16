"""Additive, isolated Image Quality Editor face-work contracts.

These records do not authorize a model or replace ordinary Restore contracts.
Native composition consumes server-held proposals, never arbitrary client pixels.
"""

from __future__ import annotations

import builtins
import hashlib
import json
from typing import Annotated, Literal

from pydantic import Field, model_validator

from ipw.contracts.common import ContractModel, NonEmptyStr, Sha256Hex, SlugId

FaceCoordinate = Annotated[int, Field(strict=True, ge=0, le=2**31 - 1)]
FaceDimension = Annotated[int, Field(strict=True, ge=1, le=2**31 - 1)]
FaceFixedPoint = Annotated[int, Field(strict=True, ge=-(2**53 - 1), le=2**53 - 1)]


class NativeFaceAlignment(ContractModel):
    """Integer-only evidence: source pixels times 10**6; coefficients times 10**9."""

    detector_sha256: Sha256Hex
    confidence_permyriad: int = Field(strict=True, ge=8500, le=10_000)
    source_landmarks_micropixels: tuple[
        tuple[FaceFixedPoint, FaceFixedPoint],
        tuple[FaceFixedPoint, FaceFixedPoint],
        tuple[FaceFixedPoint, FaceFixedPoint],
        tuple[FaceFixedPoint, FaceFixedPoint],
        tuple[FaceFixedPoint, FaceFixedPoint],
    ]
    similarity_nanounits: tuple[FaceFixedPoint, FaceFixedPoint, FaceFixedPoint, FaceFixedPoint]
    reprojection_error_millipixels: int = Field(strict=True, ge=0, le=24_000)

    @model_validator(mode="after")
    def _nondegenerate(self) -> NativeFaceAlignment:
        a, b, _, _ = self.similarity_nanounits
        if not a and not b:
            raise ValueError("native face alignment must be invertible")
        return self


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
    alignment: NativeFaceAlignment | None = None

    @model_validator(mode="after")
    def _region_fits(self) -> NativeFaceCandidate:
        region, context = self.region, self.context
        if region.x + region.width > context.output_width or (
            region.y + region.height > context.output_height
        ):
            raise ValueError("reviewed face region must fit the base output")
        if self.alignment and any(
            not (0 <= x < context.source_width * 1_000_000)
            or not (0 <= y < context.source_height * 1_000_000)
            for x, y in self.alignment.source_landmarks_micropixels
        ):
            raise ValueError("native face landmarks must fit the immutable source")
        return self


def native_face_candidate_sha256(candidate: NativeFaceCandidate) -> str:
    """Versioned digest binds framing, native colour/precision and pixel/mask hashes.

    RGBA pixel hashes use row-major straight channels, uint8 or little-endian
    uint16; mask hashes use row-major uint8. Alignment uses integers only.
    Absent optional evidence is omitted to preserve pre-alignment v1 digests.
    """
    payload = ["ipw-native-face-candidate-v1", candidate.model_dump(mode="json", exclude_none=True)]
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
    native_jobs_integrated: Literal[True] = True
    native_animation_supported: Literal[False] = False
    supported_still_bit_depths: tuple[Literal[8, 16], ...] = (8, 16)
    preserves_base_alpha: Literal[True] = True
    blockers: tuple[NonEmptyStr, ...] = Field(min_length=1)


class FaceQualityCompositionIntent(FacePermissionRecord):
    contract_version: Literal["image-quality-face-v1"]
    candidate_request_id: SlugId
    candidate_sha256: Sha256Hex
    source_sha256: Sha256Hex
    base_output_sha256: Sha256Hex
    allow_reconstructed_face_detail: Literal[True]
    acknowledged_possible_identity_change: Literal[True]


class FaceQualityObject(ContractModel):
    owner_scope: SlugId
    object_key: str = Field(pattern=r"^(immutable|derivative)/[a-z0-9._/-]+$", max_length=1024)
    generation: NonEmptyStr
    sha256: Sha256Hex
    byte_size: int = Field(strict=True, ge=1, le=4 * 1024**4)

    @model_validator(mode="after")
    def _private_key(self) -> FaceQualityObject:
        parts = self.object_key.split("/")
        if (
            len(parts) < 3
            or len(parts) > 7
            or parts[1] != self.owner_scope
            or any(not part or part in {".", ".."} for part in parts)
        ):
            raise ValueError("face object must stay in its owner's private storage")
        return self


class StoredNativeFaceCandidate(ContractModel):
    candidate: NativeFaceCandidate
    pixels: FaceQualityObject
    mask: FaceQualityObject

    @model_validator(mode="after")
    def _exact_region_storage(self) -> StoredNativeFaceCandidate:
        candidate = self.candidate
        area = candidate.region.width * candidate.region.height
        if self.pixels.owner_scope != self.mask.owner_scope or (
            self.pixels.sha256 != candidate.pixels_sha256
            or self.mask.sha256 != candidate.mask_sha256
            or self.pixels.byte_size != area * 4 * (candidate.context.bit_depth // 8)
            or self.mask.byte_size != area
            or not self.pixels.object_key.startswith("derivative/")
            or not self.mask.object_key.startswith("derivative/")
        ):
            raise ValueError("stored face pixels/mask must bind exact native region bytes")
        return self


class NativeFaceOutput(ContractModel):
    object: FaceQualityObject
    width: FaceDimension
    height: FaceDimension
    bit_depth: Literal[8, 16]
    changed_pixels: int = Field(strict=True, ge=1, le=4_000_000)
    evidence: dict[str, builtins.object]

    @model_validator(mode="after")
    def _reviewed_native_output(self) -> NativeFaceOutput:
        request = NativeFaceCompositionRequest(
            candidate=NativeFaceCandidate.model_validate(self.evidence.get("candidate")),
            review=NativeFaceReview.model_validate(self.evidence.get("review")),
        )
        context = request.candidate.context
        if (
            self.evidence.get("kind") != "explicit-face-recreate"
            or self.evidence.get("candidate_sha256") != request.review.candidate_sha256
            or self.evidence.get("changed_pixels") != self.changed_pixels
            or (self.width, self.height, self.bit_depth)
            != (context.output_width, context.output_height, context.bit_depth)
            or not self.object.object_key.startswith("derivative/")
        ):
            raise ValueError("native face output must bind its exact review and geometry")
        return self


class FaceQualityJobView(ContractModel):
    contract_version: Literal["image-quality-face-v1"] = "image-quality-face-v1"
    face_quality_job_id: SlugId
    job_id: SlugId
    operation: Literal["candidates", "compose"]
    state: Literal[
        "queued",
        "leased",
        "running",
        "retry_wait",
        "cancel_requested",
        "succeeded",
        "failed",
        "cancelled",
    ]
    progress_percent: int = Field(strict=True, ge=0, le=100)
    source_sha256: Sha256Hex
    base_output_sha256: Sha256Hex
    candidates: tuple[NativeFaceCandidate, ...]
    output_sha256: Sha256Hex | None
    failure: dict[str, object] | None
    expires_at: NonEmptyStr


IMAGE_QUALITY_FACE_SCHEMA_EXPORTS: dict[str, type[ContractModel]] = {
    "native-face-composition-request": NativeFaceCompositionRequest,
    "native-face-release": NativeFaceRelease,
    "face-quality-candidate-request": FaceQualityCandidateRequest,
    "face-quality-capabilities": FaceQualityCapabilities,
    "face-quality-composition-intent": FaceQualityCompositionIntent,
    "stored-native-face-candidate": StoredNativeFaceCandidate,
    "native-face-output": NativeFaceOutput,
    "face-quality-job-view": FaceQualityJobView,
}
