"""Contract-level invariants: operation families and processor identity.

These test the contract itself (:mod:`ipw.contracts`), not any adapter, so they
live in the contracts workspace. The rules they lock down are approved product
decisions, enforced structurally rather than by review:

* **D-007 / D-009** — Standard Enhance and AI reconstruction are separate, and an
  AI operation cannot be declared as ``standard``.
* **D-010** — colourisation is always disclosed as estimated colour.
* **AGENTS.md reproducibility** — an AI processor cannot exist without a pinned
  weight hash.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from ipw.contracts.operation import (
    FAMILY_OF,
    ColouriseSettings,
    NoopSettings,
    Operation,
    OperationFamily,
    OperationKind,
    ProcessingVariant,
    SuperResolutionSettings,
)
from ipw.contracts.processor import (
    ProcessorIdentity,
    RuntimeIdentity,
    WeightsIdentity,
)


class TestOperationFamilySeparation:
    """D-007 and D-009: Standard Enhance can never silently invoke AI."""

    def test_every_operation_has_exactly_one_family(self) -> None:
        assert set(FAMILY_OF) == set(OperationKind)

    def test_ai_operations_cannot_be_declared_standard(self) -> None:
        with pytest.raises(ValueError, match="Standard Enhance must never silently"):
            Operation(
                kind=OperationKind.SUPER_RESOLUTION,
                family=OperationFamily.STANDARD,
                variant=ProcessingVariant.STANDARD_SERVER_AUTHORITATIVE,
                settings=SuperResolutionSettings(scale=2),
            )

    def test_settings_must_match_the_operation(self) -> None:
        with pytest.raises(ValueError, match="does not match"):
            Operation(
                kind=OperationKind.RESIZE,
                family=OperationFamily.STANDARD,
                variant=ProcessingVariant.STANDARD_SERVER_AUTHORITATIVE,
                settings=NoopSettings(),
            )

    def test_build_derives_the_family(self) -> None:
        operation = Operation.build(SuperResolutionSettings(scale=4), ProcessingVariant.AI_NATURAL)
        assert operation.family is OperationFamily.AI

    def test_colourisation_cannot_disable_its_estimated_colour_disclosure(self) -> None:
        """D-010: colourisation is always described as estimated colour."""
        with pytest.raises(ValidationError):
            ColouriseSettings(disclose_estimated_colour=False)  # type: ignore[arg-type]


class TestProcessorIdentity:
    def test_an_ai_processor_must_declare_weights(self) -> None:
        with pytest.raises(ValidationError, match="weights identity"):
            ProcessorIdentity(
                name="unpinned-ai",
                version="1.0.0",
                family=OperationFamily.AI,
                runtime=RuntimeIdentity(language_version="3.11.0"),
                weights=None,
                supported_operations=(OperationKind.SUPER_RESOLUTION,),
            )

    def test_an_ai_processor_with_pinned_weights_is_accepted(self) -> None:
        identity = ProcessorIdentity(
            name="pinned-ai",
            version="1.0.0",
            family=OperationFamily.AI,
            runtime=RuntimeIdentity(language_version="3.11.0"),
            weights=WeightsIdentity(
                name="example-weights",
                sha256="a" * 64,
                source_url="https://example.invalid/weights",
                pinned_commit="0" * 40,
            ),
            supported_operations=(OperationKind.SUPER_RESOLUTION,),
        )
        assert identity.weights is not None
        assert identity.weights.sha256 == "a" * 64
