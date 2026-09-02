from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from ipw.contracts.enhancement import (
    ExportOutputProfile,
    ImageOperation,
    ProcessingRecipeRecord,
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
    assert "not AI reconstruction" in value.parameters.label


def test_export_capabilities_fail_closed() -> None:
    with pytest.raises(ValidationError, match="JPEG requires"):
        ExportOutputProfile(
            profile_id="profile-web",
            name="Web JPEG",
            purpose="web",
            format="jpeg",
            alpha_behavior="preserve",
        )

    with pytest.raises(ValidationError, match="16-bit"):
        ExportOutputProfile(
            profile_id="profile-webp",
            name="WebP",
            purpose="web",
            format="webp",
            bit_depth=16,
        )
