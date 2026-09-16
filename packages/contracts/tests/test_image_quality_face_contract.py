from __future__ import annotations

import pytest
from pydantic import ValidationError

from ipw.contracts.image_quality_face import (
    FaceQualityCandidateRequest,
    NativeFaceContext,
    NativeFaceRegion,
)


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
