// GENERATED FILE - DO NOT EDIT.
//
// Produced by tools/generate_product_contracts.py from the Recovery 2A
// product-kernel models in packages/contracts.
//
// Regenerate with:  python tools/generate_product_contracts.py
// Verify with:      python tools/generate_product_contracts.py --check

/** Production product-kernel contract version. */
export const PRODUCT_SCHEMA_VERSION = "1.7.0";

export interface Actor {
  schema_version?: string;
  actor_id: string;
  display_name: string;
}

export interface AuditEvent {
  schema_version?: string;
  audit_event_id: string;
  workspace_id: string;
  actor_id: string;
  action: string;
  resource_kind: string;
  resource_id: string;
  occurred_at: string;
  trace_id: string;
}

export interface Collection {
  schema_version?: string;
  collection_id: string;
  workspace_id: string;
  name: string;
}

export interface DefaultFilesLocation {
  schema_version?: string;
  default_files_id: string;
  workspace_id: string;
  name?: "Default Files";
}

export interface EffectivePermission {
  schema_version?: string;
  permission: Permission;
  allowed: boolean;
  origin: PermissionOrigin;
  role?: RolePreset | null;
  grant_id?: string | null;
}

export interface ErrorDetail {
  schema_version?: string;
  code: string;
  message: string;
  trace_id: string;
}

export type FileLocationKind = "default_files" | "project";
export const FileLocationKindValues: readonly FileLocationKind[] = ["default_files", "project"] as const;

export interface FileLocationRef {
  schema_version?: string;
  kind: FileLocationKind;
  default_files_id?: string | null;
  project_id?: string | null;
}

export type FileReferenceOwnerKind = "project" | "document";
export const FileReferenceOwnerKindValues: readonly FileReferenceOwnerKind[] = ["project", "document"] as const;

export type IdentityProviderKind = "local_test" | "oidc";
export const IdentityProviderKindValues: readonly IdentityProviderKind[] = ["local_test", "oidc"] as const;

export interface Membership {
  schema_version?: string;
  membership_id: string;
  workspace_id: string;
  actor_id: string;
  role: RolePreset;
}

export type Permission = "workspace.read" | "project.create" | "project.read" | "file.create" | "file.read" | "file.move" | "audit.read" | "usage.read";
export const PermissionValues: readonly Permission[] = ["workspace.read", "project.create", "project.read", "file.create", "file.read", "file.move", "audit.read", "usage.read"] as const;

export type PermissionOrigin = "role" | "workspace_grant";
export const PermissionOriginValues: readonly PermissionOrigin[] = ["role", "workspace_grant"] as const;

export interface ProjectRecord {
  schema_version?: string;
  project_id: string;
  workspace_id: string;
  name: string;
  parent_project_id?: string | null;
  archived?: boolean;
}

export type RolePreset = "owner" | "admin" | "member" | "viewer";
export const RolePresetValues: readonly RolePreset[] = ["owner", "admin", "member", "viewer"] as const;

export interface UsageEvent {
  schema_version?: string;
  usage_event_id: string;
  workspace_id: string;
  actor_id: string;
  event_kind: string;
  customer_amount?: "0.00";
  credit_debit?: 0;
  currency?: "USD";
  occurred_at: string;
}

export interface Workspace {
  schema_version?: string;
  workspace_id: string;
  name: string;
  personal_for_actor_id?: string | null;
  home_region?: string | null;
}

export interface WorkspaceFile {
  schema_version?: string;
  file_id: string;
  workspace_id: string;
  asset_original_id: string;
  current_source_version_id: string;
  display_name: string;
  canonical_location: FileLocationRef;
}

export interface WorkspaceProjectPolicy {
  schema_version?: string;
  workspace_id: string;
  allow_collections?: boolean;
  allow_subprojects?: boolean;
}

export interface AssetOriginalRecord {
  schema_version?: string;
  asset_original_id: string;
  workspace_id: string;
  object_reference_id: string;
  original_filename: string;
  created_at: string;
}

export interface AuditEventList {
  schema_version?: string;
  events: AuditEvent[];
}

export interface CollectionProjectRelation {
  schema_version?: string;
  collection_id: string;
  project_id: string;
}

export interface ErrorEnvelope {
  schema_version?: string;
  error: ErrorDetail;
}

export interface FileList {
  schema_version?: string;
  files: WorkspaceFile[];
}

export interface IdempotentCommandResult {
  schema_version?: string;
  idempotency_key: string;
  replayed: boolean;
  resource_kind: string;
  resource_id: string;
}

export interface IdentityReference {
  schema_version?: string;
  identity_id: string;
  actor_id: string;
  provider: IdentityProviderKind;
  provider_subject: string;
}

export interface ObjectReference {
  schema_version?: string;
  object_reference_id: string;
  workspace_id: string;
  object_key: string;
  /** Lower-case hexadecimal SHA-256 digest. */
  sha256: string;
  media_type: string;
  byte_size: number;
}

export interface PermissionGrant {
  schema_version?: string;
  grant_id: string;
  workspace_id: string;
  actor_id: string;
  permission: Permission;
  allowed: boolean;
}

export interface ProjectList {
  schema_version?: string;
  projects: ProjectRecord[];
  collections?: Collection[];
}

export interface ReusableFileReference {
  schema_version?: string;
  reference_id: string;
  workspace_id: string;
  file_id: string;
  owner_kind: FileReferenceOwnerKind;
  owner_id: string;
  purpose: string;
}

export interface SourceVersionRecord {
  schema_version?: string;
  source_version_id: string;
  workspace_id: string;
  asset_original_id: string;
  object_reference_id: string;
  sequence: number;
  previous_source_version_id?: string | null;
  created_at: string;
}

export interface UsageAdminDimensions {
  schema_version?: string;
  usage_event_id: string;
  dimensions?: Partial<Record<string, string>>;
}

export interface UsageSummary {
  schema_version?: string;
  events: UsageEvent[];
  customer_total?: "0.00";
  credit_debit_total?: 0;
}

export interface WorkspaceContext {
  schema_version?: string;
  actor: Actor;
  workspace: Workspace;
  membership: Membership;
  policy: WorkspaceProjectPolicy;
  default_files: DefaultFilesLocation;
  effective_permissions: EffectivePermission[];
}

export interface WorkspaceList {
  schema_version?: string;
  workspaces: Workspace[];
}
