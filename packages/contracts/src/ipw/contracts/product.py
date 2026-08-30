"""Product V2 foundation contracts.

These models describe the durable production-facing vocabulary introduced at
Recovery 1. They are deliberately domain contracts, not implementations: the
React app, NestJS API and Python workers can agree on these documents without
depending on benchmark-runner helpers or on each other's runtime code.
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import Field, model_validator

from ipw.contracts.common import ContractModel, NonEmptyStr, Sha256Hex, SlugId
from ipw.contracts.failure import FailureCategory, NextAction, Severity
from ipw.contracts.licence import Disposition, RunPurpose
from ipw.contracts.operation import OperationKind
from ipw.contracts.version import SCHEMA_VERSION

__all__ = [
    "AssetOriginal",
    "DocumentVersion",
    "ExportRequest",
    "ExportResult",
    "ExportState",
    "JobCheckpoint",
    "JobKind",
    "JobState",
    "LicenceReleaseGate",
    "ProcessingJob",
    "ProcessorFacts",
    "ProductContractModel",
    "ProductError",
    "Project",
    "ProjectNodeKind",
    "ProvenanceRecord",
    "SourceVersion",
    "StorageObjectRef",
    "TraceContext",
    "WorkspaceReference",
]


class ProductContractModel(ContractModel):
    """Base class for versioned Product V2 contract documents."""

    schema_version: str = Field(
        default=SCHEMA_VERSION,
        description="Contract version. Unsupported versions must be rejected before work starts.",
    )

    @model_validator(mode="after")
    def _schema_version_is_supported(self) -> ProductContractModel:
        if self.schema_version != SCHEMA_VERSION:
            msg = f"unsupported contract version {self.schema_version!r}; expected {SCHEMA_VERSION}"
            raise ValueError(msg)
        return self


class TraceContext(ProductContractModel):
    """Trace context propagated across browser, API, queue, worker and notification paths."""

    trace_id: SlugId
    request_id: SlugId | None = None
    idempotency_key: SlugId | None = None


class WorkspaceReference(ProductContractModel):
    """Stable reference to a workspace without classifying it as individual or business."""

    workspace_id: SlugId
    home_region: str | None = Field(
        default=None,
        description="Workspace home region where storage/processing should stay when supported.",
    )
    default_project_id: SlugId | None = None


class ProjectNodeKind(StrEnum):
    """Project hierarchy node type."""

    PROJECT = "project"
    COLLECTION = "collection"
    SUBPROJECT = "subproject"


class Project(ProductContractModel):
    """Project, collection or subproject metadata."""

    project_id: SlugId
    workspace_id: SlugId
    kind: ProjectNodeKind = ProjectNodeKind.PROJECT
    name: NonEmptyStr
    parent_id: SlugId | None = None
    archived: bool = False


class StorageObjectRef(ProductContractModel):
    """Reference to immutable bytes held outside the relational database."""

    storage_id: SlugId
    object_name: NonEmptyStr
    sha256: Sha256Hex
    media_type: NonEmptyStr
    byte_size: int = Field(ge=0)
    region: str | None = None


class AssetOriginal(ProductContractModel):
    """An immutable uploaded/source asset."""

    asset_id: SlugId
    workspace_id: SlugId
    project_id: SlugId | None = None
    original: StorageObjectRef
    filename: NonEmptyStr
    detected_media_type: NonEmptyStr
    sensitive_metadata_removed_by_default: bool = True


class SourceVersion(ProductContractModel):
    """A source version created from an original, cloud-linked update or imported file."""

    source_version_id: SlugId
    asset_id: SlugId
    source: StorageObjectRef
    previous_source_version_id: SlugId | None = None
    external_source_id: SlugId | None = None
    frozen: bool = False


class DocumentVersion(ProductContractModel):
    """Editable native project/document version."""

    document_version_id: SlugId
    workspace_id: SlugId
    project_id: SlugId
    source_version_ids: tuple[SlugId, ...] = ()
    package_ref: StorageObjectRef
    parent_document_version_id: SlugId | None = None
    approval_state: str = "draft"


class ProvenanceRecord(ProductContractModel):
    """Lineage for a derivative, export, processor result or document version."""

    provenance_id: SlugId
    input_refs: tuple[SlugId, ...]
    recipe_name: NonEmptyStr
    processor_id: SlugId | None = None
    processor_version: str | None = None
    model_weight_sha256: Sha256Hex | None = None
    ai_region_map_ref: StorageObjectRef | None = None


class ProductError(ProductContractModel):
    """Structured customer-safe error envelope."""

    code: SlugId
    category: FailureCategory
    severity: Severity = Severity.ERROR
    message: NonEmptyStr
    next_action: NextAction
    trace: TraceContext


class JobKind(StrEnum):
    """Durable background job type."""

    INSPECT = "inspect"
    PROCESS = "process"
    EXPORT = "export"
    OCR = "ocr"
    PDF = "pdf"


class JobState(StrEnum):
    """Durable job state."""

    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class JobCheckpoint(ProductContractModel):
    """Checkpoint interface used by retry and cancellation-aware workers."""

    checkpoint_id: SlugId
    sequence: int = Field(ge=0)
    state_ref: StorageObjectRef | None = None
    completed_item_ids: tuple[SlugId, ...] = ()


class ProcessingJob(ProductContractModel):
    """Versioned queue message for processing/export work."""

    job_id: SlugId
    workspace_id: SlugId
    kind: JobKind
    state: JobState = JobState.QUEUED
    trace: TraceContext
    idempotency_key: SlugId
    source_refs: tuple[SlugId, ...]
    operation: OperationKind | None = None
    checkpoint: JobCheckpoint | None = None
    attempt: int = Field(default=0, ge=0)


class ExportState(StrEnum):
    """Export result state."""

    REQUESTED = "requested"
    RENDERED = "rendered"
    FAILED = "failed"
    CANCELLED = "cancelled"


class ExportRequest(ProductContractModel):
    """Request to render one or more outputs from the editable master."""

    export_request_id: SlugId
    workspace_id: SlugId
    document_version_id: SlugId
    trace: TraceContext
    profile_id: SlugId
    requested_formats: tuple[str, ...]
    idempotency_key: SlugId


class ExportResult(ProductContractModel):
    """Rendered export or failed export outcome."""

    export_result_id: SlugId
    request_id: SlugId
    state: ExportState
    outputs: tuple[StorageObjectRef, ...] = ()
    error: ProductError | None = None
    provenance: ProvenanceRecord | None = None


class ProcessorFacts(ProductContractModel):
    """Worker-reported processor facts for routing, provenance and support."""

    processor_id: SlugId
    version: NonEmptyStr
    supports_operations: tuple[OperationKind, ...]
    requires_gpu: bool = False
    deterministic: bool = True
    commercial_disposition: Disposition = Disposition.UNKNOWN


class LicenceReleaseGate(ProductContractModel):
    """Release eligibility decision for a component, processor, model, font or provider."""

    gate_id: SlugId
    purpose: RunPurpose
    component_ids: tuple[SlugId, ...]
    permitted: bool
    effective_disposition: Disposition
    blockers: tuple[ProductError, ...] = ()
