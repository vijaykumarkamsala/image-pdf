from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from ipw.contracts.enhancement import (
    AlphaBackgroundParameters,
    CropParameters,
    CurvePoint,
    CurvesParameters,
    ExportOutputProfile,
    ExportPurpose,
    FlipParameters,
    ImageExportFormat,
    ImageOperation,
    LevelsParameters,
    MetadataPolicy,
    OutputSizeEstimate,
    ProcessingRecipeRecord,
    RecommendationEvidence,
    RecommendationEvidenceKind,
    RecommendationTargetKind,
    ResamplingScaleParameters,
    ResizeMode,
    ResizeParameters,
    SafeRecommendation,
)


def operation(kind: str, parameters: dict[str, Any], order: int = 0) -> ImageOperation:
    return ImageOperation.model_validate(
        {
            "operation_id": f"operation-{order + 1}",
            "kind": kind,
            "order": order,
            "enabled": True,
            "parameters": parameters,
        }
    )


@pytest.mark.parametrize(
    ("kind", "parameters"),
    [
        ("orientation_normalize", {"source_orientation": 6}),
        ("crop", {"left": 0, "top": 0, "right": 1, "bottom": 1}),
        ("rotate", {"degrees": 90}),
        ("flip", {"horizontal": True}),
        ("resize", {"mode": "pixels", "width": 1200, "height": 800}),
        ("exposure_brightness", {"exposure_ev": 0.5, "brightness": 4}),
        ("contrast", {"amount": 8}),
        ("highlights_shadows", {"highlights": -4, "shadows": 6}),
        ("white_balance_temperature", {"temperature_kelvin": 6200}),
        ("tint", {"amount": 3}),
        ("saturation_vibrance", {"saturation": 2, "vibrance": 8}),
        ("gamma", {"gamma": 1.1}),
        ("levels", {"black": 3, "white": 248, "midpoint": 1}),
        ("curves", {"points": [{"input": 0, "output": 0}, {"input": 1, "output": 1}]}),
        ("grayscale", {"method": "luminance"}),
        ("unsharp_mask", {"radius": 1.2, "amount": 90, "threshold": 3}),
        ("noise_reduction", {"strength": 15, "preserve_edges": 80}),
        ("colour_profile_conversion", {"target_profile": "srgb"}),
        ("alpha_background", {"behavior": "flatten", "background": "#ffffff"}),
        ("resampling_scale", {"scale": 2}),
    ],
)
def test_every_recovery_2e_operation_has_validated_parameters(
    kind: str, parameters: dict[str, Any]
) -> None:
    value = operation(kind, parameters)
    assert value.kind.value == kind


def test_operation_parameters_cannot_disagree_with_kind() -> None:
    with pytest.raises(ValidationError):
        operation("gamma", {"amount": 12})


def test_recipe_order_and_identifiers_are_stable() -> None:
    with pytest.raises(ValidationError, match="unique"):
        ProcessingRecipeRecord(
            recipe_id="recipe-001",
            workspace_id="workspace-001",
            document_id="document-001",
            version=1,
            name="Corrections",
            operations=(operation("contrast", {"amount": 4}), operation("gamma", {"gamma": 1.1})),
            created_by_actor_id="actor-001",
            created_at="2026-09-02T00:00:00Z",
            updated_at="2026-09-02T00:00:00Z",
        )


def test_standard_resampling_is_truthfully_labelled() -> None:
    value = operation("resampling_scale", {"scale": 4})
    assert isinstance(value.parameters, ResamplingScaleParameters)
    assert "not AI reconstruction" in value.parameters.label


def test_export_capabilities_fail_closed() -> None:
    with pytest.raises(ValidationError, match="JPEG requires"):
        ExportOutputProfile(
            profile_id="profile-web",
            name="Web JPEG",
            purpose=ExportPurpose.WEB,
            format=ImageExportFormat.JPEG,
            alpha_behavior="preserve",
        )

    with pytest.raises(ValidationError, match="16-bit"):
        ExportOutputProfile(
            profile_id="profile-webp",
            name="WebP",
            purpose=ExportPurpose.WEB,
            format=ImageExportFormat.WEBP,
            bit_depth=16,
        )


def test_enhancement_contract_rejection_boundaries_are_executable() -> None:
    invalid_calls = (
        lambda: CropParameters(left=0.8, top=0, right=0.2, bottom=1),
        lambda: FlipParameters(),
        lambda: ResizeParameters(mode=ResizeMode.PHYSICAL, width=2, height=1),
        lambda: ResizeParameters(mode=ResizeMode.PIXELS, width=200, height=100, physical_unit="in"),
        lambda: LevelsParameters(black=200, white=100),
        lambda: CurvesParameters(points=()),
        lambda: CurvesParameters(
            points=(
                CurvePoint(input=0, output=0),
                CurvePoint(input=0.8, output=1),
                CurvePoint(input=0.4, output=0.5),
                CurvePoint(input=1, output=1),
            )
        ),
        lambda: CurvesParameters(
            points=(CurvePoint(input=0.1, output=0), CurvePoint(input=1, output=1))
        ),
        lambda: AlphaBackgroundParameters(behavior="flatten"),
        lambda: AlphaBackgroundParameters(behavior="preserve", background="#ffffff"),
        lambda: OutputSizeEstimate(minimum_bytes=20, maximum_bytes=10, explanation="Invalid"),
        lambda: ExportOutputProfile(
            profile_id="profile-flat",
            name="Flat PNG",
            purpose=ExportPurpose.WEB,
            format=ImageExportFormat.PNG,
            alpha_behavior="flatten",
        ),
        lambda: ExportOutputProfile(
            profile_id="profile-chroma",
            name="PNG chroma",
            purpose=ExportPurpose.WEB,
            format=ImageExportFormat.PNG,
            chroma_subsampling="4:4:4",
        ),
        lambda: ExportOutputProfile(
            profile_id="profile-sizing",
            name="Mixed sizing",
            purpose=ExportPurpose.WEB,
            format=ImageExportFormat.PNG,
            width=100,
            percentage=50,
        ),
        lambda: ExportOutputProfile(
            profile_id="profile-physical",
            name="Physical PNG",
            purpose=ExportPurpose.WEB,
            format=ImageExportFormat.PNG,
            physical_width=2,
        ),
        lambda: ExportOutputProfile(
            profile_id="profile-webp-physical",
            name="Physical WebP",
            purpose=ExportPurpose.WEB,
            format=ImageExportFormat.WEBP,
            physical_width=2,
            physical_unit="in",
            ppi=300,
            lossless=True,
        ),
    )
    for call in invalid_calls:
        with pytest.raises(ValidationError):
            call()

    with pytest.raises(ValidationError, match="unsupported product contract version"):
        FlipParameters(schema_version="1.18.0", horizontal=True)
    with pytest.raises(ValidationError, match="operation kind is required"):
        ImageOperation.model_validate({"operation_id": "op-no-kind", "order": 0, "parameters": {}})
    with pytest.raises(ValidationError):
        ImageOperation.model_validate("not-an-operation")


def test_recommendations_require_exactly_the_matching_action() -> None:
    evidence = (
        RecommendationEvidence(
            kind=RecommendationEvidenceKind.MEASURED,
            explanation="Measured source evidence",
        ),
    )
    base = {
        "recommendation_id": "recommendation-1",
        "title": "Recommendation",
        "explanation": "An explicit action is required",
        "evidence": evidence,
    }
    with pytest.raises(ValidationError, match="exactly one operation"):
        SafeRecommendation.model_validate(
            {**base, "target_kind": RecommendationTargetKind.PROCESSING_OPERATION}
        )
    with pytest.raises(ValidationError, match="exactly one metadata policy"):
        SafeRecommendation.model_validate(
            {**base, "target_kind": RecommendationTargetKind.METADATA_POLICY}
        )
    warning = SafeRecommendation.model_validate(
        {**base, "target_kind": RecommendationTargetKind.OUTPUT_WARNING}
    )
    assert warning.operation is None
    assert warning.metadata_policy is None
    metadata = SafeRecommendation.model_validate(
        {
            **base,
            "target_kind": RecommendationTargetKind.METADATA_POLICY,
            "metadata_policy": MetadataPolicy(),
        }
    )
    assert metadata.metadata_policy is not None


def test_recipe_rejects_duplicate_identifiers_as_well_as_duplicate_order() -> None:
    first = operation("contrast", {"amount": 4}, order=0)
    duplicate_identifier = operation("gamma", {"gamma": 1.1}, order=1).model_copy(
        update={"operation_id": first.operation_id}
    )
    with pytest.raises(ValidationError, match="unique"):
        ProcessingRecipeRecord(
            recipe_id="recipe-duplicate-id",
            workspace_id="workspace-001",
            document_id="document-001",
            version=1,
            name="Corrections",
            operations=(first, duplicate_identifier),
            created_by_actor_id="actor-001",
            created_at="2026-09-02T00:00:00Z",
            updated_at="2026-09-02T00:00:00Z",
        )

    valid = ProcessingRecipeRecord(
        recipe_id="recipe-valid",
        workspace_id="workspace-001",
        document_id="document-001",
        version=1,
        name="Valid corrections",
        operations=(first,),
        created_by_actor_id="actor-001",
        created_at="2026-09-02T00:00:00Z",
        updated_at="2026-09-02T00:00:00Z",
    )
    assert valid.operations == (first,)
    assert (
        OutputSizeEstimate(minimum_bytes=10, maximum_bytes=20, explanation="Bounded").maximum_bytes
        == 20
    )
