"""Product V2 contracts for native PDF creation and truthful PDF export.

The native editor snapshot remains the editable master.  These models describe
the bounded quick-create policy, release-gated output profiles, preflight
evidence and durable export results; they do not make the rendered PDF the
authoritative document state.
"""

from __future__ import annotations

import re
from enum import StrEnum
from typing import Literal

from pydantic import Field, model_validator

from ipw.contracts.common import ContractModel, NonEmptyStr, Sha256Hex, SlugId
from ipw.contracts.editor import EditorContractModel


class PdfPagePreset(StrEnum):
    A4 = "a4"
    LETTER = "letter"


class PdfPageOrientation(StrEnum):
    PORTRAIT = "portrait"
    LANDSCAPE = "landscape"


class PdfImagePlacement(StrEnum):
    CONTAIN = "contain"


class PdfCreateRequest(EditorContractModel):
    name: NonEmptyStr
    project_id: SlugId | None = None
    source_file_ids: tuple[SlugId, ...] = Field(default=(), max_length=50)
    page_preset: PdfPagePreset = PdfPagePreset.A4
    orientation: PdfPageOrientation = PdfPageOrientation.PORTRAIT
    image_placement: PdfImagePlacement = PdfImagePlacement.CONTAIN
    language: str = Field(default="en", pattern=r"^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$")

    @model_validator(mode="after")
    def _sources_are_distinct(self) -> PdfCreateRequest:
        if len(set(self.source_file_ids)) != len(self.source_file_ids):
            raise ValueError("PDF source files must be distinct")
        return self


class PdfPreflightSeverity(StrEnum):
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"


class PdfPreflightIssue(EditorContractModel):
    code: SlugId
    severity: PdfPreflightSeverity
    message: NonEmptyStr
    page_artboard_id: SlugId | None = None
    layer_id: SlugId | None = None
    blocks_export: bool = False


class PdfOutputProfileId(StrEnum):
    SCREEN = "screen"


class PdfOutputProfile(EditorContractModel):
    profile_id: PdfOutputProfileId = PdfOutputProfileId.SCREEN
    profile_version: NonEmptyStr = "1.0.0"
    label: NonEmptyStr = "Screen PDF"
    tagged_pdf: Literal[False] = False
    archival_conformance: Literal[None] = None
    colour_space: Literal["srgb"] = "srgb"
    image_quality: int = Field(default=90, ge=1, le=100)
    metadata_policy: Literal["safe"] = "safe"


class PdfPreflightState(StrEnum):
    READY = "ready"
    BLOCKED = "blocked"


class PdfPreflightReport(EditorContractModel):
    document_id: SlugId
    document_version_id: SlugId
    snapshot_sha256: Sha256Hex
    profile: PdfOutputProfile
    state: PdfPreflightState
    page_count: int = Field(ge=1, le=500)
    issues: tuple[PdfPreflightIssue, ...] = ()
    generated_at: NonEmptyStr

    @model_validator(mode="after")
    def _state_matches_issues(self) -> PdfPreflightReport:
        blocked = any(item.blocks_export for item in self.issues)
        if blocked != (self.state is PdfPreflightState.BLOCKED):
            raise ValueError("PDF preflight state must match blocking issues")
        return self


class PdfExportState(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLATION_REQUESTED = "cancellation_requested"
    CANCELLED = "cancelled"


class PdfExportRequestRecord(EditorContractModel):
    pdf_export_request_id: SlugId
    workspace_id: SlugId
    document_id: SlugId
    document_version_id: SlugId
    snapshot_sha256: Sha256Hex
    profile: PdfOutputProfile
    preflight: PdfPreflightReport
    state: PdfExportState
    job_id: SlugId
    created_by_actor_id: SlugId
    created_at: NonEmptyStr
    updated_at: NonEmptyStr
    failure_code: SlugId | None = None
    failure_message: str | None = Field(default=None, max_length=1_000)


class PdfRendererIdentity(EditorContractModel):
    name: NonEmptyStr
    version: NonEmptyStr
    licence_component_ids: tuple[SlugId, ...] = Field(min_length=1)
    standard_font_sha256: Sha256Hex


class PdfExportResult(EditorContractModel):
    pdf_export_result_id: SlugId
    pdf_export_request_id: SlugId
    workspace_id: SlugId
    document_id: SlugId
    document_version_id: SlugId
    filename: NonEmptyStr
    media_type: Literal["application/pdf"] = "application/pdf"
    byte_size: int = Field(ge=1)
    sha256: Sha256Hex
    page_count: int = Field(ge=1, le=500)
    renderer: PdfRendererIdentity
    object_reference_id: SlugId
    created_at: NonEmptyStr

    @model_validator(mode="after")
    def _filename_is_safe(self) -> PdfExportResult:
        if not re.fullmatch(r"[^/\\\x00-\x1f]{1,240}\.pdf", self.filename, re.IGNORECASE):
            raise ValueError("PDF export filename must be a safe PDF filename")
        return self


PDF_SCHEMA_EXPORTS: dict[str, type[ContractModel]] = {
    "pdf-create-request": PdfCreateRequest,
    "pdf-output-profile": PdfOutputProfile,
    "pdf-preflight-issue": PdfPreflightIssue,
    "pdf-preflight-report": PdfPreflightReport,
    "pdf-export-request-record": PdfExportRequestRecord,
    "pdf-renderer-identity": PdfRendererIdentity,
    "pdf-export-result": PdfExportResult,
}
