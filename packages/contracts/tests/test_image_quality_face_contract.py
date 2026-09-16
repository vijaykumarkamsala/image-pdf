from __future__ import annotations

import pytest
from pydantic import ValidationError

from ipw.contracts.image_quality_face import (
    FaceQualityCandidateRequest,
    FaceQualityCompositionIntent,
    FaceQualityObject,
    NativeFaceContext,
    NativeFaceRegion,
)
from ipw.contracts.product_kernel import ProcessingJobRecord


def intent() -> dict[str, object]:
    return {
        "contract_version": "image-quality-face-v1",
        "base_image_quality_request_id": "quality-owned-base",
        "source_sha256": "a" * 64,
        "base_output_sha256": "b" * 64,
        "allow_reconstructed_face_detail": True,
        "fidelity_permyriad": 8000,
        "candidate_count": 3,
    }


def test_source_bound_face_intent_is_additive_and_requires_exact_permission() -> None:
    assert FaceQualityCandidateRequest.model_validate(intent()).candidate_count == 3
    for updates in [
        {"allow_reconstructed_face_detail": False},
        {"fidelity_permyriad": "8000"},
        {"allow_reconstructed_face_detail": 1},
        {"allow_reconstructed_face_detail": "true"},
        {"candidate_count": 3.0},
        {"fidelity_permyriad": 10_001},
        {"candidate_count": 4},
        {"contract_version": "later"},
        {"source_sha256": "invalid"},
        {"model_release_approved": True},
        {"pixels": [1, 2, 3]},
    ]:
        with pytest.raises(ValidationError):
            FaceQualityCandidateRequest.model_validate({**intent(), **updates})


def test_native_framing_rejects_stretching_and_unbounded_patch() -> None:
    context = {
        "source_sha256": "a" * 64,
        "base_output_sha256": "b" * 64,
        "source_width": 100,
        "source_height": 200,
        "output_width": 400,
        "output_height": 800,
        "bit_depth": 16,
        "colour_authority_sha256": "c" * 64,
    }
    assert NativeFaceContext.model_validate(context).bit_depth == 16
    for updates in [{"output_height": 801}, {"output_width": 0}, {"output_width": "400"}]:
        with pytest.raises(ValidationError):
            NativeFaceContext.model_validate({**context, **updates})
    with pytest.raises(ValidationError, match="budget"):
        NativeFaceRegion(x=0, y=0, width=4000, height=4000)


def test_composition_requires_exact_candidate_permission_without_client_pixels() -> None:
    review = {
        "contract_version": "image-quality-face-v1",
        "candidate_request_id": "face-owned",
        "candidate_sha256": "c" * 64,
        "source_sha256": "a" * 64,
        "base_output_sha256": "b" * 64,
        "allow_reconstructed_face_detail": True,
        "acknowledged_possible_identity_change": True,
    }
    assert FaceQualityCompositionIntent.model_validate(review).candidate_request_id == "face-owned"
    for updates in [
        {"acknowledged_possible_identity_change": 1},
        {"pixels": [1]},
        {"model_release_approved": True},
        {"candidate_sha256": "wrong"},
    ]:
        with pytest.raises(ValidationError):
            FaceQualityCompositionIntent.model_validate({**review, **updates})


def test_native_object_refs_are_owner_private_and_bounded_without_traversal() -> None:
    stored = {
        "owner_scope": "guest-owned",
        "object_key": "derivative/guest-owned/face/pixels",
        "generation": "1",
        "sha256": "a" * 64,
        "byte_size": 32,
    }
    assert FaceQualityObject.model_validate(stored).byte_size == 32
    for updates in [
        {"object_key": "derivative/guest-other/face/pixels"},
        {"object_key": "derivative/guest-owned/../pixels"},
        {"object_key": "derivative/guest-owned//pixels"},
        {"object_key": "https://public.example/image.png"},
        {"byte_size": 0},
        {"byte_size": "32"},
    ]:
        with pytest.raises(ValidationError):
            FaceQualityObject.model_validate({**stored, **updates})


@pytest.mark.parametrize("kind", ["image_face_candidates", "image_face_compose"])
def test_durable_face_kind_cannot_target_an_ordinary_editor_record(kind: str) -> None:
    job = {
        "job_id": "job-owned",
        "kind": kind,
        "owner_kind": "guest",
        "guest_session_id": "guest-owned",
        "upload_session_id": "upload-owned",
        "face_quality_job_id": "face-owned",
        "state": "queued",
        "attempt": 0,
        "max_attempts": 3,
        "progress_percent": 0,
        "created_at": "2026-09-16T00:00:00Z",
        "updated_at": "2026-09-16T00:00:00Z",
    }
    assert ProcessingJobRecord.model_validate(job).face_quality_job_id == "face-owned"
    for updates in [
        {"document_id": "document-other"},
        {"image_quality_request_id": "quality-other"},
        {"upload_session_id": None},
        {"face_quality_job_id": None},
        {"kind": "file_intake_inspection"},
    ]:
        with pytest.raises(ValidationError):
            ProcessingJobRecord.model_validate({**job, **updates})
