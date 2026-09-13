"""Product V2 contracts for safe imported-PDF capability inspection.

These contracts describe immutable-source evidence only.  They deliberately do
not authorise rewriting, rendering, unlocking, sanitising or reconstructing an
imported PDF.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Literal

from pydantic import Field, model_validator

from ipw.contracts.common import ContractModel, NonEmptyStr, Sha256Hex, SlugId
from ipw.contracts.editor import EditorContractModel


class PdfCapabilityClassification(StrEnum):
    FULLY_EDITABLE = "fully_editable"
    LIMITED = "limited"
    PAGE_MANAGEMENT_ONLY = "page_management_only"
    RECONSTRUCTABLE_COPY = "reconstructable_copy"
    VIEW_ONLY = "view_only"


class PdfCapabilityAnalysisState(StrEnum):
    COMPLETE = "complete"
    RESTRICTED = "restricted"
    UNREADABLE = "unreadable"


class PdfOpeningMode(StrEnum):
    SAFE_VIEW = "safe_view"
    RESTRICTED_SAFE_VIEW = "restricted_safe_view"
    CREDENTIAL_REQUIRED = "credential_required"


class PdfFeature(StrEnum):
    ENCRYPTION = "encryption"
    DOCUMENT_PERMISSIONS = "document_permissions"
    DIGITAL_SIGNATURES = "digital_signatures"
    FONTS = "fonts"
    TEXT = "text"
    IMAGES = "images"
    VECTOR_CONTENT = "vector_content"
    FORMS = "forms"
    ANNOTATIONS = "annotations"
    OPTIONAL_CONTENT_LAYERS = "optional_content_layers"
    TAGS = "tags"
    ATTACHMENTS = "attachments"
    ACTIVE_CONTENT = "active_content"
    MIXED_PAGE_SIZES = "mixed_page_sizes"


class PdfFeatureState(StrEnum):
    PRESENT = "present"
    ABSENT = "absent"
    UNKNOWN = "unknown"
    RESTRICTED = "restricted"


class PdfFeatureFinding(EditorContractModel):
    feature: PdfFeature
    state: PdfFeatureState
    summary: NonEmptyStr


class PdfOperation(StrEnum):
    VIEW_CAPABILITY_REPORT = "view_capability_report"
    DOWNLOAD_ORIGINAL = "download_original"
    MANAGE_PAGES = "manage_pages"
    EDIT_CONTENT = "edit_content"
    UNLOCK_WITH_PASSWORD = "unlock_with_password"  # noqa: S105 - operation identifier
    SANITIZE_COPY = "sanitize_copy"
    RECONSTRUCT_COPY = "reconstruct_copy"


class PdfOperationState(StrEnum):
    AVAILABLE = "available"
    BLOCKED = "blocked"
    NOT_RELEASED = "not_released"


class PdfOperationAvailability(EditorContractModel):
    operation: PdfOperation
    state: PdfOperationState
    creates_derivative: bool
    reason: NonEmptyStr


class PdfInspectorIdentity(EditorContractModel):
    name: NonEmptyStr
    version: NonEmptyStr
    library_name: NonEmptyStr
    library_version: NonEmptyStr
    max_object_visits: int = Field(ge=1)


class PdfCapabilityAnalysis(EditorContractModel):
    source_sha256: Sha256Hex
    pdf_version: str | None = Field(default=None, pattern=r"^1\.[0-9]$")
    page_count: int | None = Field(default=None, ge=1, le=500)
    analysis_state: PdfCapabilityAnalysisState
    classification: PdfCapabilityClassification
    opening_mode: PdfOpeningMode
    original_protected: Literal[True]
    findings: tuple[PdfFeatureFinding, ...]
    operations: tuple[PdfOperationAvailability, ...]
    compatibility_notes: tuple[NonEmptyStr, ...]
    inspector: PdfInspectorIdentity

    @model_validator(mode="after")
    def _evidence_is_complete_and_safe(self) -> PdfCapabilityAnalysis:
        features = [item.feature for item in self.findings]
        if len(features) != len(set(features)) or set(features) != set(PdfFeature):
            raise ValueError("PDF capability analysis must contain each feature exactly once")
        operations = [item.operation for item in self.operations]
        if len(operations) != len(set(operations)) or set(operations) != set(PdfOperation):
            raise ValueError("PDF capability analysis must contain each operation exactly once")
        report = next(
            item
            for item in self.operations
            if item.operation is PdfOperation.VIEW_CAPABILITY_REPORT
        )
        if report.state is not PdfOperationState.AVAILABLE:
            raise ValueError("the safe capability report must remain available")
        encryption = next(item for item in self.findings if item.feature is PdfFeature.ENCRYPTION)
        if encryption.state is PdfFeatureState.PRESENT and (
            self.opening_mode is not PdfOpeningMode.CREDENTIAL_REQUIRED
            or self.classification is not PdfCapabilityClassification.VIEW_ONLY
        ):
            raise ValueError("encrypted PDFs require credential-gated view-only handling")
        active = next(item for item in self.findings if item.feature is PdfFeature.ACTIVE_CONTENT)
        if active.state is PdfFeatureState.PRESENT and (
            self.opening_mode is PdfOpeningMode.SAFE_VIEW
            or self.classification is not PdfCapabilityClassification.VIEW_ONLY
        ):
            raise ValueError("active PDF content requires restricted view-only handling")
        return self


class PdfCapabilityReport(EditorContractModel):
    pdf_capability_report_id: SlugId
    workspace_id: SlugId
    file_id: SlugId
    asset_original_id: SlugId
    source_version_id: SlugId
    storage_generation: NonEmptyStr
    analysis: PdfCapabilityAnalysis
    inspected_at: NonEmptyStr


PDF_MANAGEMENT_SCHEMA_EXPORTS: dict[str, type[ContractModel]] = {
    "pdf-feature-finding": PdfFeatureFinding,
    "pdf-operation-availability": PdfOperationAvailability,
    "pdf-inspector-identity": PdfInspectorIdentity,
    "pdf-capability-analysis": PdfCapabilityAnalysis,
    "pdf-capability-report": PdfCapabilityReport,
}
