"""Recovery 2A product-kernel contracts.

This contract line is intentionally separate from the benchmark contract. It
can evolve without changing benchmark result identifiers or modifying the
verified POC schema evidence.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Literal

from pydantic import Field, model_validator

from ipw.contracts.common import ContractModel, NonEmptyStr, Sha256Hex, SlugId
from ipw.contracts.version import PRODUCT_SCHEMA_VERSION


class ProductKernelContractModel(ContractModel):
    """Base for production product-kernel documents."""

    schema_version: str = PRODUCT_SCHEMA_VERSION

    @model_validator(mode="after")
    def _schema_version_is_supported(self) -> ProductKernelContractModel:
        if self.schema_version != PRODUCT_SCHEMA_VERSION:
            msg = (
                f"unsupported product contract version {self.schema_version!r}; "
                f"expected {PRODUCT_SCHEMA_VERSION}"
            )
            raise ValueError(msg)
        return self


class Actor(ProductKernelContractModel):
    actor_id: SlugId
    display_name: NonEmptyStr


class IdentityProviderKind(StrEnum):
    LOCAL_TEST = "local_test"
    OIDC = "oidc"


class IdentityReference(ProductKernelContractModel):
    identity_id: SlugId
    actor_id: SlugId
    provider: IdentityProviderKind
    provider_subject: NonEmptyStr


class Workspace(ProductKernelContractModel):
    workspace_id: SlugId
    name: NonEmptyStr
    personal_for_actor_id: SlugId | None = None
    home_region: str | None = None


class RolePreset(StrEnum):
    OWNER = "owner"
    ADMIN = "admin"
    MEMBER = "member"
    VIEWER = "viewer"


class Membership(ProductKernelContractModel):
    membership_id: SlugId
    workspace_id: SlugId
    actor_id: SlugId
    role: RolePreset


class Permission(StrEnum):
    WORKSPACE_READ = "workspace.read"
    PROJECT_CREATE = "project.create"
    PROJECT_READ = "project.read"
    FILE_CREATE = "file.create"
    FILE_READ = "file.read"
    FILE_MOVE = "file.move"
    AUDIT_READ = "audit.read"
    USAGE_READ = "usage.read"
    UPLOAD_CREATE = "upload.create"
    UPLOAD_READ = "upload.read"
    UPLOAD_CANCEL = "upload.cancel"
    JOB_READ = "job.read"
    JOB_CANCEL = "job.cancel"


class PermissionOrigin(StrEnum):
    ROLE = "role"
    WORKSPACE_GRANT = "workspace_grant"


class PermissionGrant(ProductKernelContractModel):
    grant_id: SlugId
    workspace_id: SlugId
    actor_id: SlugId
    permission: Permission
    allowed: bool


class EffectivePermission(ProductKernelContractModel):
    permission: Permission
    allowed: bool
    origin: PermissionOrigin
    role: RolePreset | None = None
    grant_id: SlugId | None = None


class WorkspaceProjectPolicy(ProductKernelContractModel):
    workspace_id: SlugId
    allow_collections: bool = True
    allow_subprojects: bool = True


class Collection(ProductKernelContractModel):
    collection_id: SlugId
    workspace_id: SlugId
    name: NonEmptyStr


class ProjectRecord(ProductKernelContractModel):
    project_id: SlugId
    workspace_id: SlugId
    name: NonEmptyStr
    parent_project_id: SlugId | None = None
    archived: bool = False


class CollectionProjectRelation(ProductKernelContractModel):
    collection_id: SlugId
    project_id: SlugId


class DefaultFilesLocation(ProductKernelContractModel):
    default_files_id: SlugId
    workspace_id: SlugId
    name: Literal["Default Files"] = "Default Files"


class ObjectReference(ProductKernelContractModel):
    object_reference_id: SlugId
    workspace_id: SlugId
    object_key: NonEmptyStr
    sha256: Sha256Hex
    media_type: NonEmptyStr
    byte_size: int = Field(ge=0)


class AssetOriginalRecord(ProductKernelContractModel):
    asset_original_id: SlugId
    workspace_id: SlugId
    object_reference_id: SlugId
    original_filename: NonEmptyStr
    created_at: NonEmptyStr


class SourceVersionRecord(ProductKernelContractModel):
    source_version_id: SlugId
    workspace_id: SlugId
    asset_original_id: SlugId
    object_reference_id: SlugId
    sequence: int = Field(ge=1)
    previous_source_version_id: SlugId | None = None
    created_at: NonEmptyStr


class FileLocationKind(StrEnum):
    DEFAULT_FILES = "default_files"
    PROJECT = "project"


class FileLocationRef(ProductKernelContractModel):
    kind: FileLocationKind
    default_files_id: SlugId | None = None
    project_id: SlugId | None = None

    @model_validator(mode="after")
    def _location_matches_kind(self) -> FileLocationRef:
        valid = (
            self.kind == FileLocationKind.DEFAULT_FILES
            and self.default_files_id is not None
            and self.project_id is None
        ) or (
            self.kind == FileLocationKind.PROJECT
            and self.project_id is not None
            and self.default_files_id is None
        )
        if not valid:
            raise ValueError("canonical location must identify exactly one location of its kind")
        return self


class WorkspaceFile(ProductKernelContractModel):
    file_id: SlugId
    workspace_id: SlugId
    asset_original_id: SlugId
    current_source_version_id: SlugId
    display_name: NonEmptyStr
    canonical_location: FileLocationRef


class FileReferenceOwnerKind(StrEnum):
    PROJECT = "project"
    DOCUMENT = "document"


class ReusableFileReference(ProductKernelContractModel):
    reference_id: SlugId
    workspace_id: SlugId
    file_id: SlugId
    owner_kind: FileReferenceOwnerKind
    owner_id: SlugId
    purpose: NonEmptyStr


class AuditEvent(ProductKernelContractModel):
    audit_event_id: SlugId
    workspace_id: SlugId
    actor_id: SlugId
    action: NonEmptyStr
    resource_kind: NonEmptyStr
    resource_id: SlugId
    occurred_at: NonEmptyStr
    trace_id: SlugId


class UsageEvent(ProductKernelContractModel):
    usage_event_id: SlugId
    workspace_id: SlugId
    actor_id: SlugId
    event_kind: NonEmptyStr
    customer_amount: Literal["0.00"] = "0.00"
    credit_debit: Literal[0] = 0
    currency: Literal["USD"] = "USD"
    occurred_at: NonEmptyStr


class UsageAdminDimensions(ProductKernelContractModel):
    usage_event_id: SlugId
    dimensions: dict[str, str] = Field(default_factory=dict)


class IdempotentCommandResult(ProductKernelContractModel):
    idempotency_key: SlugId
    replayed: bool
    resource_kind: NonEmptyStr
    resource_id: SlugId


class ErrorDetail(ProductKernelContractModel):
    code: SlugId
    message: NonEmptyStr
    trace_id: SlugId


class ErrorEnvelope(ProductKernelContractModel):
    error: ErrorDetail


class WorkspaceContext(ProductKernelContractModel):
    actor: Actor
    workspace: Workspace
    membership: Membership
    policy: WorkspaceProjectPolicy
    default_files: DefaultFilesLocation
    effective_permissions: tuple[EffectivePermission, ...]


class WorkspaceList(ProductKernelContractModel):
    workspaces: tuple[Workspace, ...]


class ProjectList(ProductKernelContractModel):
    projects: tuple[ProjectRecord, ...]
    collections: tuple[Collection, ...] = ()


class FileList(ProductKernelContractModel):
    files: tuple[WorkspaceFile, ...]


class AuditEventList(ProductKernelContractModel):
    events: tuple[AuditEvent, ...]


class UsageSummary(ProductKernelContractModel):
    events: tuple[UsageEvent, ...]
    customer_total: Literal["0.00"] = "0.00"
    credit_debit_total: Literal[0] = 0


class UploadOwnerKind(StrEnum):
    ACTOR = "actor"
    GUEST = "guest"


class UploadTransferKind(StrEnum):
    SINGLE = "single"
    RESUMABLE = "resumable"


class UploadTransferProvider(StrEnum):
    LOCAL_API = "local_api"
    GOOGLE_CLOUD_STORAGE = "google_cloud_storage"


class UploadTransferProtocol(StrEnum):
    IPW_OFFSET_JSON = "ipw_offset_json"
    GCS_RESUMABLE = "gcs_resumable"


class UploadSessionState(StrEnum):
    INITIATED = "initiated"
    UPLOADING = "uploading"
    FINALISING = "finalising"
    INSPECTING = "inspecting"
    READY = "ready"
    REJECTED = "rejected"
    EXPIRED = "expired"
    CANCELLED = "cancelled"


class ProcessingJobKind(StrEnum):
    FILE_INTAKE_INSPECTION = "file_intake_inspection"


class ProcessingJobState(StrEnum):
    QUEUED = "queued"
    LEASED = "leased"
    RUNNING = "running"
    RETRY_WAIT = "retry_wait"
    CANCEL_REQUESTED = "cancel_requested"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class MalwareScanState(StrEnum):
    PENDING = "pending"
    CLEAN = "clean"
    MALICIOUS = "malicious"
    UNAVAILABLE = "unavailable"
    TIMEOUT = "timeout"
    ERROR = "error"


class UploadConstraints(ProductKernelContractModel):
    allowed_media_types: tuple[NonEmptyStr, ...]
    max_bytes: int = Field(ge=1)
    max_pixels: int = Field(ge=1)
    max_pages: int = Field(ge=1)


class GuestSessionRecord(ProductKernelContractModel):
    guest_session_id: SlugId
    expires_at: NonEmptyStr


class GuestSessionAuthorization(ProductKernelContractModel):
    guest_session: GuestSessionRecord
    token: NonEmptyStr


class SourceFacts(ProductKernelContractModel):
    sha256: Sha256Hex
    detected_media_type: NonEmptyStr
    byte_size: int = Field(ge=1)
    width: int | None = Field(default=None, ge=1)
    height: int | None = Field(default=None, ge=1)
    megapixels_milli: int | None = Field(default=None, ge=0)
    orientation: int | None = Field(default=None, ge=1, le=8)
    frame_count: int | None = Field(default=None, ge=1)
    page_count: int | None = Field(default=None, ge=1)
    has_alpha: bool | None = None
    bit_depth: int | None = Field(default=None, ge=1)
    has_icc_profile: bool | None = None
    sensitive_metadata: tuple[NonEmptyStr, ...] = ()
    malware_scan_state: MalwareScanState


class IntakeFailure(ProductKernelContractModel):
    code: SlugId
    message: NonEmptyStr
    retryable: bool = False


class UploadAuthorization(ProductKernelContractModel):
    transfer_kind: UploadTransferKind
    provider: UploadTransferProvider
    protocol: UploadTransferProtocol
    method: Literal["PUT"] = "PUT"
    upload_url: NonEmptyStr
    expires_at: NonEmptyStr
    resume_token: NonEmptyStr
    required_headers: dict[str, str] = Field(default_factory=dict)


class UploadSessionRecord(ProductKernelContractModel):
    upload_session_id: SlugId
    owner_kind: UploadOwnerKind
    workspace_id: SlugId | None = None
    actor_id: SlugId | None = None
    guest_session_id: SlugId | None = None
    display_name: NonEmptyStr
    expected_media_type: NonEmptyStr
    expected_byte_size: int = Field(ge=1)
    expected_sha256: Sha256Hex | None = None
    verified_sha256: Sha256Hex | None = None
    bytes_received: int = Field(ge=0)
    state: UploadSessionState
    constraints: UploadConstraints
    job_id: SlugId | None = None
    asset_original_id: SlugId | None = None
    source_version_id: SlugId | None = None
    file_id: SlugId | None = None
    source_facts: SourceFacts | None = None
    failure: IntakeFailure | None = None
    created_at: NonEmptyStr
    expires_at: NonEmptyStr
    updated_at: NonEmptyStr

    @model_validator(mode="after")
    def _owner_is_unambiguous(self) -> UploadSessionRecord:
        actor_owned = (
            self.owner_kind == UploadOwnerKind.ACTOR
            and self.workspace_id is not None
            and self.actor_id is not None
            and self.guest_session_id is None
        )
        guest_owned = (
            self.owner_kind == UploadOwnerKind.GUEST
            and self.guest_session_id is not None
            and self.workspace_id is None
            and self.actor_id is None
        )
        if not (actor_owned or guest_owned):
            raise ValueError("upload session must identify exactly one owner boundary")
        return self


class UploadSessionCreated(ProductKernelContractModel):
    upload_session: UploadSessionRecord
    authorization: UploadAuthorization
    command: IdempotentCommandResult


class ProcessingJobRecord(ProductKernelContractModel):
    job_id: SlugId
    kind: ProcessingJobKind
    owner_kind: UploadOwnerKind
    workspace_id: SlugId | None = None
    actor_id: SlugId | None = None
    guest_session_id: SlugId | None = None
    upload_session_id: SlugId
    state: ProcessingJobState
    attempt: int = Field(ge=0)
    max_attempts: int = Field(ge=1)
    progress_percent: int = Field(ge=0, le=100)
    lease_owner: str | None = None
    lease_expires_at: str | None = None
    heartbeat_at: str | None = None
    next_attempt_at: str | None = None
    failure: IntakeFailure | None = None
    created_at: NonEmptyStr
    updated_at: NonEmptyStr


class JobEventRecord(ProductKernelContractModel):
    job_event_id: SlugId
    job_id: SlugId
    cursor: int = Field(ge=1)
    event_kind: NonEmptyStr
    state: ProcessingJobState
    progress_percent: int = Field(ge=0, le=100)
    occurred_at: NonEmptyStr
    trace_id: SlugId


class JobEventList(ProductKernelContractModel):
    events: tuple[JobEventRecord, ...]
    next_cursor: int = Field(ge=0)


PRODUCT_SCHEMA_EXPORTS: dict[str, type[ProductKernelContractModel]] = {
    "actor": Actor,
    "identity-reference": IdentityReference,
    "workspace": Workspace,
    "membership": Membership,
    "permission-grant": PermissionGrant,
    "effective-permission": EffectivePermission,
    "workspace-project-policy": WorkspaceProjectPolicy,
    "collection": Collection,
    "project-record": ProjectRecord,
    "collection-project-relation": CollectionProjectRelation,
    "default-files-location": DefaultFilesLocation,
    "object-reference": ObjectReference,
    "asset-original-record": AssetOriginalRecord,
    "source-version-record": SourceVersionRecord,
    "file-location-ref": FileLocationRef,
    "workspace-file": WorkspaceFile,
    "reusable-file-reference": ReusableFileReference,
    "audit-event": AuditEvent,
    "usage-event": UsageEvent,
    "usage-admin-dimensions": UsageAdminDimensions,
    "idempotent-command-result": IdempotentCommandResult,
    "error-envelope": ErrorEnvelope,
    "workspace-context": WorkspaceContext,
    "workspace-list": WorkspaceList,
    "project-list": ProjectList,
    "file-list": FileList,
    "audit-event-list": AuditEventList,
    "usage-summary": UsageSummary,
    "upload-constraints": UploadConstraints,
    "guest-session-record": GuestSessionRecord,
    "guest-session-authorization": GuestSessionAuthorization,
    "source-facts": SourceFacts,
    "intake-failure": IntakeFailure,
    "upload-authorization": UploadAuthorization,
    "upload-session-record": UploadSessionRecord,
    "upload-session-created": UploadSessionCreated,
    "processing-job-record": ProcessingJobRecord,
    "job-event-record": JobEventRecord,
    "job-event-list": JobEventList,
}
