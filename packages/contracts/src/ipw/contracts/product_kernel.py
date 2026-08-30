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
}
