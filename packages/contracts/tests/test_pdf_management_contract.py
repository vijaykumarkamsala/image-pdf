from __future__ import annotations

import pytest
from pydantic import ValidationError

from ipw.contracts.pdf_management import (
    PdfCapabilityAnalysis,
    PdfCapabilityAnalysisState,
    PdfCapabilityClassification,
    PdfFeature,
    PdfFeatureFinding,
    PdfFeatureState,
    PdfInspectorIdentity,
    PdfOpeningMode,
    PdfOperation,
    PdfOperationAvailability,
    PdfOperationState,
)


def analysis(**changes: object) -> PdfCapabilityAnalysis:
    values: dict[str, object] = {
        "source_sha256": "a" * 64,
        "pdf_version": "1.7",
        "page_count": 2,
        "analysis_state": PdfCapabilityAnalysisState.COMPLETE,
        "classification": PdfCapabilityClassification.PAGE_MANAGEMENT_ONLY,
        "opening_mode": PdfOpeningMode.SAFE_VIEW,
        "original_protected": True,
        "findings": tuple(
            PdfFeatureFinding(
                feature=feature,
                state=PdfFeatureState.ABSENT,
                summary="No matching structure was found.",
            )
            for feature in PdfFeature
        ),
        "operations": tuple(
            PdfOperationAvailability(
                operation=operation,
                state=(
                    PdfOperationState.AVAILABLE
                    if operation is PdfOperation.VIEW_CAPABILITY_REPORT
                    else PdfOperationState.NOT_RELEASED
                ),
                creates_derivative=False,
                reason="Availability is explicit.",
            )
            for operation in PdfOperation
        ),
        "compatibility_notes": ("The original remains immutable.",),
        "inspector": PdfInspectorIdentity(
            name="Inspector",
            version="1.0.0",
            library_name="pypdf",
            library_version="6.18.1",
            max_object_visits=20_000,
        ),
    }
    values.update(changes)
    return PdfCapabilityAnalysis.model_validate(values)


def test_capability_analysis_requires_complete_unique_evidence() -> None:
    value = analysis()
    assert value.classification is PdfCapabilityClassification.PAGE_MANAGEMENT_ONLY
    with pytest.raises(ValidationError, match="each feature exactly once"):
        analysis(findings=value.findings[:-1])
    with pytest.raises(ValidationError, match="each operation exactly once"):
        analysis(operations=value.operations[:-1])
    with pytest.raises(ValidationError):
        analysis(original_protected=False)


def test_active_and_encrypted_content_cannot_claim_standard_editability() -> None:
    value = analysis()
    active = tuple(
        finding.model_copy(
            update={"state": PdfFeatureState.PRESENT}
            if finding.feature is PdfFeature.ACTIVE_CONTENT
            else {},
        )
        for finding in value.findings
    )
    with pytest.raises(ValidationError, match="active PDF content"):
        analysis(findings=active)

    encrypted = tuple(
        finding.model_copy(
            update={"state": PdfFeatureState.PRESENT}
            if finding.feature is PdfFeature.ENCRYPTION
            else {},
        )
        for finding in value.findings
    )
    with pytest.raises(ValidationError, match="encrypted PDFs"):
        analysis(findings=encrypted)
