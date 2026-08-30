// GENERATED FILE - DO NOT EDIT.
//
// Produced by tools/generate_product_contracts.py from the Product V2
// product-kernel models in packages/contracts.
//
// Regenerate with:  python tools/generate_product_contracts.py
// Verify with:      python tools/generate_product_contracts.py --check

/** Production product-kernel contract version. */
export const PRODUCT_SCHEMA_VERSION = "1.10.0";

export interface Actor {
  schema_version?: string;
  actor_id: string;
  display_name: string;
}

export interface AttentionItem {
  schema_version?: string;
  kind: AttentionKind;
  resource_id: string;
  title: string;
  message: string;
  path: string;
  occurred_at: string;
}

export type AttentionKind = "job_retry" | "job_failed" | "upload_interrupted" | "upload_rejected" | "source_expiring";
export const AttentionKindValues: readonly AttentionKind[] = ["job_retry", "job_failed", "upload_interrupted", "upload_rejected", "source_expiring"] as const;

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

export interface CustomerUsageActivity {
  schema_version?: string;
  event_kind: string;
  occurred_at: string;
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

export interface FeatureStateRecord {
  schema_version?: string;
  feature: string;
  active: boolean;
  customer_visible: boolean;
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

export interface GuestSessionRecord {
  schema_version?: string;
  guest_session_id: string;
  expires_at: string;
}

export interface IdempotentCommandResult {
  schema_version?: string;
  idempotency_key: string;
  replayed: boolean;
  resource_kind: string;
  resource_id: string;
}

export type IdentityProviderKind = "local_test" | "oidc";
export const IdentityProviderKindValues: readonly IdentityProviderKind[] = ["local_test", "oidc"] as const;

export interface IntakeClassificationRecord {
  schema_version?: string;
  upload_session_id: string;
  inferred_category?: IntakeSourceCategory | null;
  confidence_percent?: number | null;
  evidence?: string[];
  customer_category?: IntakeSourceCategory | null;
  updated_at: string;
}

export type IntakeDimensionState = "clear" | "attention";
export const IntakeDimensionStateValues: readonly IntakeDimensionState[] = ["clear", "attention"] as const;

export interface IntakeFailure {
  schema_version?: string;
  code: string;
  message: string;
  retryable?: boolean;
}

export interface IntakeRiskDimension {
  schema_version?: string;
  dimension: "safety" | "structure" | "privacy";
  state: IntakeDimensionState;
  summary: string;
}

export type IntakeSourceCategory = "photograph" | "graphic" | "document" | "scan" | "animation" | "other" | "unsure";
export const IntakeSourceCategoryValues: readonly IntakeSourceCategory[] = ["photograph", "graphic", "document", "scan", "animation", "other", "unsure"] as const;

export interface JobEventRecord {
  schema_version?: string;
  job_event_id: string;
  job_id: string;
  cursor: number;
  event_kind: string;
  state: ProcessingJobState;
  progress_percent: number;
  occurred_at: string;
  trace_id: string;
}

export type MalwareScanState = "pending" | "clean" | "malicious" | "unavailable" | "timeout" | "error";
export const MalwareScanStateValues: readonly MalwareScanState[] = ["pending", "clean", "malicious", "unavailable", "timeout", "error"] as const;

export interface Membership {
  schema_version?: string;
  membership_id: string;
  workspace_id: string;
  actor_id: string;
  role: RolePreset;
}

export type NotificationKind = "upload_accepted" | "upload_rejected" | "job_completed" | "job_failed" | "job_cancelled" | "retry_required" | "retry_completed" | "guest_handoff_completed" | "source_cleanup_required";
export const NotificationKindValues: readonly NotificationKind[] = ["upload_accepted", "upload_rejected", "job_completed", "job_failed", "job_cancelled", "retry_required", "retry_completed", "guest_handoff_completed", "source_cleanup_required"] as const;

export interface NotificationRecord {
  schema_version?: string;
  notification_id: string;
  workspace_id: string;
  kind: NotificationKind;
  title: string;
  message: string;
  resource_kind: string;
  resource_id: string;
  occurred_at: string;
  read_at?: string | null;
}

export type Permission = "workspace.read" | "project.create" | "project.read" | "file.create" | "file.read" | "file.move" | "audit.read" | "usage.read" | "upload.create" | "upload.read" | "upload.cancel" | "job.read" | "job.cancel" | "job.retry" | "notification.read" | "notification.update" | "search.read";
export const PermissionValues: readonly Permission[] = ["workspace.read", "project.create", "project.read", "file.create", "file.read", "file.move", "audit.read", "usage.read", "upload.create", "upload.read", "upload.cancel", "job.read", "job.cancel", "job.retry", "notification.read", "notification.update", "search.read"] as const;

export type PermissionOrigin = "role" | "workspace_grant";
export const PermissionOriginValues: readonly PermissionOrigin[] = ["role", "workspace_grant"] as const;

export type ProcessingJobKind = "file_intake_inspection";
export const ProcessingJobKindValues: readonly ProcessingJobKind[] = ["file_intake_inspection"] as const;

export interface ProcessingJobRecord {
  schema_version?: string;
  job_id: string;
  kind: ProcessingJobKind;
  owner_kind: UploadOwnerKind;
  workspace_id?: string | null;
  actor_id?: string | null;
  guest_session_id?: string | null;
  upload_session_id: string;
  state: ProcessingJobState;
  attempt: number;
  max_attempts: number;
  progress_percent: number;
  lease_owner?: string | null;
  lease_expires_at?: string | null;
  heartbeat_at?: string | null;
  next_attempt_at?: string | null;
  failure?: IntakeFailure | null;
  created_at: string;
  updated_at: string;
}

export type ProcessingJobState = "queued" | "leased" | "running" | "retry_wait" | "cancel_requested" | "succeeded" | "failed" | "cancelled";
export const ProcessingJobStateValues: readonly ProcessingJobState[] = ["queued", "leased", "running", "retry_wait", "cancel_requested", "succeeded", "failed", "cancelled"] as const;

export type ProductOutcome = "image-graphic-studio" | "create-pdf" | "edit-manage-pdf" | "print-production";
export const ProductOutcomeValues: readonly ProductOutcome[] = ["image-graphic-studio", "create-pdf", "edit-manage-pdf", "print-production"] as const;

export interface ProjectRecord {
  schema_version?: string;
  project_id: string;
  workspace_id: string;
  name: string;
  parent_project_id?: string | null;
  archived?: boolean;
}

export interface RecentWorkItem {
  schema_version?: string;
  kind: RecentWorkKind;
  resource_id: string;
  title: string;
  description: string;
  path: string;
  updated_at: string;
}

export type RecentWorkKind = "project" | "file";
export const RecentWorkKindValues: readonly RecentWorkKind[] = ["project", "file"] as const;

export type RolePreset = "owner" | "admin" | "member" | "viewer";
export const RolePresetValues: readonly RolePreset[] = ["owner", "admin", "member", "viewer"] as const;

export type SearchResultKind = "project" | "file" | "job";
export const SearchResultKindValues: readonly SearchResultKind[] = ["project", "file", "job"] as const;

export interface SourceFacts {
  schema_version?: string;
  /** Lower-case hexadecimal SHA-256 digest. */
  sha256: string;
  detected_media_type: string;
  byte_size: number;
  width?: number | null;
  height?: number | null;
  megapixels_milli?: number | null;
  orientation?: number | null;
  frame_count?: number | null;
  page_count?: number | null;
  has_alpha?: boolean | null;
  bit_depth?: number | null;
  has_icc_profile?: boolean | null;
  sensitive_metadata?: string[];
  malware_scan_state: MalwareScanState;
}

export interface UploadAuthorization {
  schema_version?: string;
  transfer_kind: UploadTransferKind;
  provider: UploadTransferProvider;
  protocol: UploadTransferProtocol;
  method?: "PUT";
  upload_url: string;
  expires_at: string;
  resume_token: string;
  required_headers?: Partial<Record<string, string>>;
}

export interface UploadConstraints {
  schema_version?: string;
  allowed_media_types: string[];
  max_bytes: number;
  max_pixels: number;
  max_pages: number;
}

export type UploadOwnerKind = "actor" | "guest";
export const UploadOwnerKindValues: readonly UploadOwnerKind[] = ["actor", "guest"] as const;

export interface UploadSessionRecord {
  schema_version?: string;
  upload_session_id: string;
  owner_kind: UploadOwnerKind;
  workspace_id?: string | null;
  actor_id?: string | null;
  guest_session_id?: string | null;
  display_name: string;
  expected_media_type: string;
  expected_byte_size: number;
  expected_sha256?: string | null;
  verified_sha256?: string | null;
  bytes_received: number;
  state: UploadSessionState;
  constraints: UploadConstraints;
  job_id?: string | null;
  asset_original_id?: string | null;
  source_version_id?: string | null;
  file_id?: string | null;
  source_facts?: SourceFacts | null;
  failure?: IntakeFailure | null;
  created_at: string;
  expires_at: string;
  updated_at: string;
}

export type UploadSessionState = "initiated" | "uploading" | "finalising" | "inspecting" | "ready" | "rejected" | "expired" | "cancelled";
export const UploadSessionStateValues: readonly UploadSessionState[] = ["initiated", "uploading", "finalising", "inspecting", "ready", "rejected", "expired", "cancelled"] as const;

export type UploadTransferKind = "single" | "resumable";
export const UploadTransferKindValues: readonly UploadTransferKind[] = ["single", "resumable"] as const;

export type UploadTransferProtocol = "ipw_offset_json" | "gcs_resumable";
export const UploadTransferProtocolValues: readonly UploadTransferProtocol[] = ["ipw_offset_json", "gcs_resumable"] as const;

export type UploadTransferProvider = "local_api" | "google_cloud_storage";
export const UploadTransferProviderValues: readonly UploadTransferProvider[] = ["local_api", "google_cloud_storage"] as const;

export interface UsageSummary {
  schema_version?: string;
  files: number;
  storage_bytes: number;
  jobs: number;
  high_cost_processing: number;
  activities?: CustomerUsageActivity[];
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

export interface WorkspaceSearchResult {
  schema_version?: string;
  kind: SearchResultKind;
  resource_id: string;
  title: string;
  description: string;
  path: string;
  updated_at: string;
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

export interface FeatureStateList {
  schema_version?: string;
  features: FeatureStateRecord[];
}

export interface FileList {
  schema_version?: string;
  files: WorkspaceFile[];
}

export interface GuestSessionAuthorization {
  schema_version?: string;
  guest_session: GuestSessionRecord;
  token: string;
}

export interface IdentityReference {
  schema_version?: string;
  identity_id: string;
  actor_id: string;
  provider: IdentityProviderKind;
  provider_subject: string;
}

export interface IntelligentIntakePresentation {
  schema_version?: string;
  upload_session_id: string;
  filename: string;
  source_facts: SourceFacts;
  classification: IntakeClassificationRecord;
  risk_dimensions: IntakeRiskDimension[];
  suitable_explanation: string;
  recommended_outcome: ProductOutcome;
  recommendation_rationale: string;
}

export interface JobEventList {
  schema_version?: string;
  events: JobEventRecord[];
  next_cursor: number;
}

export interface JobList {
  schema_version?: string;
  jobs: ProcessingJobRecord[];
  next_cursor?: string | null;
}

export interface NotificationList {
  schema_version?: string;
  notifications: NotificationRecord[];
  next_cursor?: string | null;
  unread_count: number;
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

export interface UploadSessionCreated {
  schema_version?: string;
  upload_session: UploadSessionRecord;
  authorization: UploadAuthorization;
  command: IdempotentCommandResult;
}

export interface UsageAdminDimensions {
  schema_version?: string;
  usage_event_id: string;
  dimensions?: Partial<Record<string, string>>;
}

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

export interface WorkspaceContext {
  schema_version?: string;
  actor: Actor;
  workspace: Workspace;
  membership: Membership;
  policy: WorkspaceProjectPolicy;
  default_files: DefaultFilesLocation;
  effective_permissions: EffectivePermission[];
}

export interface WorkspaceHome {
  schema_version?: string;
  recent_work: RecentWorkItem[];
  attention: AttentionItem[];
  active_jobs: ProcessingJobRecord[];
  recent_jobs: ProcessingJobRecord[];
  notifications: NotificationRecord[];
  unread_notification_count: number;
  usage: UsageSummary;
}

export interface WorkspaceList {
  schema_version?: string;
  workspaces: Workspace[];
}

export interface WorkspaceSearchPage {
  schema_version?: string;
  results: WorkspaceSearchResult[];
  next_cursor?: string | null;
}
