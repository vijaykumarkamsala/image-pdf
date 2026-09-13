// GENERATED FILE - DO NOT EDIT.
//
// Produced by tools/generate_product_contracts.py from the Product V2
// product-kernel models in packages/contracts.
//
// Regenerate with:  python tools/generate_product_contracts.py
// Verify with:      python tools/generate_product_contracts.py --check

/** Production product-kernel contract version. */
export const PRODUCT_SCHEMA_VERSION = "1.21.0";

export interface Actor {
  schema_version?: string;
  actor_id: string;
  display_name: string;
}

export interface AlphaBackgroundParameters {
  schema_version?: string;
  behavior?: "preserve" | "flatten";
  background?: string | null;
}

export interface ArtboardBackground {
  schema_version?: string;
  kind?: "transparent" | "solid";
  color?: string | null;
}

export type ArtboardOrientation = "portrait" | "landscape" | "square";
export const ArtboardOrientationValues: readonly ArtboardOrientation[] = ["portrait", "landscape", "square"] as const;

export interface ArtboardRecord {
  schema_version?: string;
  artboard_id: string;
  name: string;
  order: number;
  width: number;
  height: number;
  unit?: ArtboardUnit;
  orientation: ArtboardOrientation;
  background: ArtboardBackground;
  intended_use: IntendedUseMetadata;
}

export type ArtboardUnit = "px" | "mm" | "in" | "pt";
export const ArtboardUnitValues: readonly ArtboardUnit[] = ["px", "mm", "in", "pt"] as const;

export type AssetInstanceMode = "linked" | "independent";
export const AssetInstanceModeValues: readonly AssetInstanceMode[] = ["linked", "independent"] as const;

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

export type BatchConfirmationState = "pending" | "not_required" | "confirmed";
export const BatchConfirmationStateValues: readonly BatchConfirmationState[] = ["pending", "not_required", "confirmed"] as const;

export interface BatchGroupApproval {
  schema_version?: string;
  group_id: string;
  representative_client_item_id: string;
  representative_preview_id: string;
  confirmation_state: "confirmed";
}

export interface BatchGroupRecord {
  schema_version?: string;
  group_id: string;
  batch_id: string;
  /** Lower-case hexadecimal SHA-256 digest. */
  compatibility_sha256: string;
  label: string;
  item_count: number;
  representative_item_id: string;
  representative_preview_id: string;
  exception_count: number;
}

export interface BatchGroupReport {
  schema_version?: string;
  group_id: string;
  label: string;
  /** Lower-case hexadecimal SHA-256 digest. */
  compatibility_sha256: string;
  representative_item_id: string;
  representative_preview_id: string;
  item_count: number;
  queued_count: number;
  running_count: number;
  succeeded_count: number;
  failed_count: number;
  cancelled_count: number;
  exception_count: number;
}

export interface BatchItemRecord {
  schema_version?: string;
  batch_item_id: string;
  batch_id: string;
  client_item_id: string;
  position: number;
  display_name: string;
  document_id: string;
  document_version_id: string;
  recipe_id: string;
  recipe_version: number;
  group_id: string | null;
  included: boolean;
  exclusion_reason: string | null;
  requires_individual_confirmation: boolean;
  confirmation_state: BatchConfirmationState;
  exception_codes: string[];
  export_request_id: string | null;
  job_id: string | null;
  state: BatchItemState;
  progress_percent: number;
  output_count: number;
  succeeded_output_count: number;
  failed_output_count: number;
  cancelled_output_count: number;
  failure_code: string | null;
  failure_message: string | null;
  last_checkpoint_key: string | null;
  updated_at: string;
}

export type BatchItemState = "excluded" | "queued" | "running" | "succeeded" | "failed" | "cancelled";
export const BatchItemStateValues: readonly BatchItemState[] = ["excluded", "queued", "running", "succeeded", "failed", "cancelled"] as const;

export interface BatchOutputReport {
  schema_version?: string;
  output_id: string;
  filename: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  sha256: string | null;
  byte_size?: number | null;
  failure_code: string | null;
  failure_message: string | null;
}

export interface BatchOutputSelection {
  schema_version?: string;
  artboard_id: string;
  profile: ExportOutputProfile;
  filename: string;
}

export interface BatchPlanGroup {
  schema_version?: string;
  group_id: string;
  /** Lower-case hexadecimal SHA-256 digest. */
  compatibility_sha256: string;
  label: string;
  client_item_ids: string[];
  representative_client_item_id: string;
  representative_preview_id?: string | null;
  exception_count: number;
}

export interface BatchPlanItem {
  schema_version?: string;
  client_item_id: string;
  group_id: string | null;
  included: boolean;
  requires_individual_confirmation: boolean;
  confirmation_state: BatchConfirmationState;
  exception_codes: string[];
}

export interface BatchReportItem {
  schema_version?: string;
  batch_item_id: string;
  client_item_id: string;
  group_id: string | null;
  display_name: string;
  state: BatchItemState;
  exception_codes: string[];
  outputs: BatchOutputReport[];
}

export type BatchRunState = "queued" | "running" | "partially_completed" | "completed" | "failed" | "cancelled";
export const BatchRunStateValues: readonly BatchRunState[] = ["queued", "running", "partially_completed", "completed", "failed", "cancelled"] as const;

export interface BatchSubmissionItem {
  schema_version?: string;
  client_item_id: string;
  display_name: string;
  document_id: string;
  document_version_id: string;
  recipe_id: string;
  recipe_version: number;
  outputs: BatchOutputSelection[];
  included?: boolean;
  exclusion_reason?: string | null;
}

export interface Collection {
  schema_version?: string;
  collection_id: string;
  workspace_id: string;
  name: string;
}

export interface ColourProfileConversionParameters {
  schema_version?: string;
  target_profile?: "preserve" | "srgb" | "display-p3";
  rendering_intent?: "perceptual" | "relative_colorimetric";
  black_point_compensation?: boolean;
}

export interface ContrastParameters {
  schema_version?: string;
  amount?: number;
}

export interface CropParameters {
  schema_version?: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  aspect_preset?: string | null;
}

export interface CropRegion {
  schema_version?: string;
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
}

export interface CurvePoint {
  schema_version?: string;
  input: number;
  output: number;
}

export interface CurvesParameters {
  schema_version?: string;
  channel?: "rgb" | "red" | "green" | "blue";
  points?: CurvePoint[];
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

export interface DocumentVariantRecord {
  schema_version?: string;
  variant_id: string;
  name: string;
  based_on_version_id: string;
  active?: boolean;
}

export type DocumentVersionKind = "initial" | "autosave_checkpoint" | "named" | "restore" | "save_as";
export const DocumentVersionKindValues: readonly DocumentVersionKind[] = ["initial", "autosave_checkpoint", "named", "restore", "save_as"] as const;

export interface DocumentVersionRecord {
  schema_version?: string;
  document_version_id: string;
  document_id: string;
  sequence: number;
  revision: number;
  kind: DocumentVersionKind;
  name?: string | null;
  based_on_version_id?: string | null;
  restored_from_version_id?: string | null;
  /** Lower-case hexadecimal SHA-256 digest. */
  snapshot_sha256: string;
  created_by_actor_id: string;
  created_at: string;
}

export interface EditableMaskRecord {
  schema_version?: string;
  mask_id: string;
  artboard_id: string;
  name: string;
  kind: MaskKind;
  enabled?: boolean;
  inverted?: boolean;
  feather?: number;
  path_data?: string | null;
  object_reference_id?: string | null;
}

export type EditorDocumentKind = "graphic" | "pdf";
export const EditorDocumentKindValues: readonly EditorDocumentKind[] = ["graphic", "pdf"] as const;

export interface EditorDocumentLocation {
  schema_version?: string;
  kind: EditorLocationKind;
  default_files_id?: string | null;
  project_id?: string | null;
}

export interface EditorDocumentRecord {
  schema_version?: string;
  document_id: string;
  workspace_id: string;
  project_id?: string | null;
  location: EditorDocumentLocation;
  kind: EditorDocumentKind;
  name: string;
  source_file_id?: string | null;
  source_asset_original_id?: string | null;
  source_version_id?: string | null;
  preview_state?: EditorPreviewState;
  preview_job_id?: string | null;
  current_preview_id?: string | null;
  current_version_id: string;
  current_revision: number;
  created_by_actor_id: string;
  created_at: string;
  updated_at: string;
}

export interface EditorDocumentSnapshot {
  schema_version?: string;
  document_id: string;
  revision: number;
  artboards: ArtboardRecord[];
  layers?: LayerRecord[];
  masks?: EditableMaskRecord[];
  shared_assets?: SharedAssetRecord[];
  shared_styles?: SharedStyleRecord[];
  variants?: DocumentVariantRecord[];
  pdf_settings?: PdfDocumentSettings | null;
}

export interface EditorLeaseGrant {
  schema_version?: string;
  lease: EditorLeaseRecord;
  lease_token: string;
  takeover_warning?: string | null;
}

export interface EditorLeaseRecord {
  schema_version?: string;
  lease_id: string;
  document_id: string;
  actor_id: string;
  actor_display_name: string;
  state: EditorLeaseState;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
  grace_expires_at: string;
}

export type EditorLeaseState = "active" | "grace" | "released" | "expired";
export const EditorLeaseStateValues: readonly EditorLeaseState[] = ["active", "grace", "released", "expired"] as const;

export type EditorLocationKind = "default_files" | "project";
export const EditorLocationKindValues: readonly EditorLocationKind[] = ["default_files", "project"] as const;

export interface EditorMutation {
  schema_version?: string;
  kind: EditorOperationKind;
  target_id?: string | null;
  target_ids?: string[];
  layer?: LayerRecord | null;
  artboard?: ArtboardRecord | null;
  mask?: EditableMaskRecord | null;
  shared_asset?: SharedAssetRecord | null;
  shared_style?: SharedStyleRecord | null;
  transform?: LayerTransform | null;
  crop?: CropRegion | null;
  adjustments?: VisualAdjustments | null;
  properties?: Partial<Record<string, string | number | boolean | null>>;
}

export type EditorOperationKind = "layer.add" | "layer.update" | "layer.remove" | "layer.reorder" | "layer.group" | "layer.ungroup" | "artboard.add" | "artboard.update" | "artboard.remove" | "mask.update" | "asset.add" | "style.upsert" | "style.detach" | "document.rename";
export const EditorOperationKindValues: readonly EditorOperationKind[] = ["layer.add", "layer.update", "layer.remove", "layer.reorder", "layer.group", "layer.ungroup", "artboard.add", "artboard.update", "artboard.remove", "mask.update", "asset.add", "style.upsert", "style.detach", "document.rename"] as const;

export type EditorPreviewState = "not_required" | "preparing" | "ready" | "failed" | "cancelled";
export const EditorPreviewStateValues: readonly EditorPreviewState[] = ["not_required", "preparing", "ready", "failed", "cancelled"] as const;

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

export interface ExportOutputProfile {
  schema_version?: string;
  profile_id: string;
  preset_version?: "recovery-2e-v1";
  name: string;
  purpose: ExportPurpose;
  format: ImageExportFormat;
  width?: number | null;
  height?: number | null;
  percentage?: number | null;
  physical_width?: number | null;
  physical_height?: number | null;
  physical_unit?: "in" | "mm" | "cm" | null;
  ppi?: number | null;
  fit?: "contain" | "cover" | "stretch";
  quality?: number | null;
  lossless?: boolean;
  resampling_algorithm?: ResamplingAlgorithm;
  colour_profile?: "preserve" | "srgb" | "display-p3";
  bit_depth?: 8 | 16;
  alpha_behavior?: "preserve" | "flatten";
  background?: string | null;
  metadata_policy?: MetadataPolicy;
  chroma_subsampling?: "4:4:4" | "4:2:2" | "4:2:0" | null;
  filename_template?: string;
  collision_behavior?: "suffix" | "fail";
}

export interface ExportOutputRecord {
  schema_version?: string;
  output_id: string;
  export_request_id: string;
  artboard_id: string;
  profile: ExportOutputProfile;
  state: ExportOutputState;
  progress_percent: number;
  filename: string;
  object_reference_id?: string | null;
  sha256?: string | null;
  byte_size?: number | null;
  width?: number | null;
  height?: number | null;
  media_type?: string | null;
  metadata_verified?: boolean | null;
  metadata_evidence?: MetadataDisposition | null;
  histogram?: HistogramSummary | null;
  failure_code?: string | null;
  failure_message?: string | null;
  completed_at?: string | null;
}

export type ExportOutputState = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export const ExportOutputStateValues: readonly ExportOutputState[] = ["queued", "running", "succeeded", "failed", "cancelled"] as const;

export type ExportPurpose = "archival_derivative" | "web" | "email" | "social" | "presentation" | "high_resolution_digital" | "custom";
export const ExportPurposeValues: readonly ExportPurpose[] = ["archival_derivative", "web", "email", "social", "presentation", "high_resolution_digital", "custom"] as const;

export interface ExposureBrightnessParameters {
  schema_version?: string;
  exposure_ev?: number;
  brightness?: number;
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

export interface FlipParameters {
  schema_version?: string;
  horizontal?: boolean;
  vertical?: boolean;
}

export interface GammaParameters {
  schema_version?: string;
  gamma?: number;
}

export interface GrayscaleParameters {
  schema_version?: string;
  method?: "luminance" | "average";
}

export interface GroupLayerData {
  schema_version?: string;
  collapsed?: boolean;
}

export interface GuestSessionRecord {
  schema_version?: string;
  guest_session_id: string;
  expires_at: string;
}

export interface HighlightsShadowsParameters {
  schema_version?: string;
  highlights?: number;
  shadows?: number;
}

export interface HistogramSummary {
  schema_version?: string;
  red: number[];
  green: number[];
  blue: number[];
  shadow_clipping: boolean;
  highlight_clipping: boolean;
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

export type ImageExportFormat = "jpeg" | "png" | "webp" | "tiff";
export const ImageExportFormatValues: readonly ImageExportFormat[] = ["jpeg", "png", "webp", "tiff"] as const;

export interface ImageOperation {
  schema_version?: string;
  operation_id: string;
  kind: ImageOperationKind;
  order: number;
  enabled?: boolean;
  parameters: OrientationNormalizeParameters | CropParameters | RotateParameters | FlipParameters | ResizeParameters | ExposureBrightnessParameters | ContrastParameters | HighlightsShadowsParameters | WhiteBalanceParameters | TintParameters | SaturationVibranceParameters | GammaParameters | LevelsParameters | CurvesParameters | GrayscaleParameters | UnsharpMaskParameters | NoiseReductionParameters | ColourProfileConversionParameters | AlphaBackgroundParameters | ResamplingScaleParameters;
}

export type ImageOperationKind = "orientation_normalize" | "crop" | "rotate" | "flip" | "resize" | "exposure_brightness" | "contrast" | "highlights_shadows" | "white_balance_temperature" | "tint" | "saturation_vibrance" | "gamma" | "levels" | "curves" | "grayscale" | "unsharp_mask" | "noise_reduction" | "colour_profile_conversion" | "alpha_background" | "resampling_scale";
export const ImageOperationKindValues: readonly ImageOperationKind[] = ["orientation_normalize", "crop", "rotate", "flip", "resize", "exposure_brightness", "contrast", "highlights_shadows", "white_balance_temperature", "tint", "saturation_vibrance", "gamma", "levels", "curves", "grayscale", "unsharp_mask", "noise_reduction", "colour_profile_conversion", "alpha_background", "resampling_scale"] as const;

export type ImportCompatibilityState = "compatible" | "limited" | "unsupported";
export const ImportCompatibilityStateValues: readonly ImportCompatibilityState[] = ["compatible", "limited", "unsupported"] as const;

export type ImportSourceKind = "raster" | "svg" | "psd" | "ai_compatible";
export const ImportSourceKindValues: readonly ImportSourceKind[] = ["raster", "svg", "psd", "ai_compatible"] as const;

export interface IntakeClassificationRecord {
  schema_version?: string;
  upload_session_id: string;
  inferred_category?: IntakeSourceCategory | null;
  evidence_label?: IntakeEvidenceLabel;
  /** Compatibility field. Numeric confidence is unavailable until a calibrated method is approved. */
  confidence_percent?: null;
  evidence?: string[];
  customer_category?: IntakeSourceCategory | null;
  updated_at: string;
}

export type IntakeDimensionState = "clear" | "attention";
export const IntakeDimensionStateValues: readonly IntakeDimensionState[] = ["clear", "attention"] as const;

export type IntakeEvidenceLabel = "verified" | "likely" | "unknown";
export const IntakeEvidenceLabelValues: readonly IntakeEvidenceLabel[] = ["verified", "likely", "unknown"] as const;

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

export type IntendedOutcome = "digital" | "archival" | "presentation" | "custom";
export const IntendedOutcomeValues: readonly IntendedOutcome[] = ["digital", "archival", "presentation", "custom"] as const;

export type IntendedUseKind = "source" | "digital" | "print" | "custom";
export const IntendedUseKindValues: readonly IntendedUseKind[] = ["source", "digital", "print", "custom"] as const;

export interface IntendedUseMetadata {
  schema_version?: string;
  kind: IntendedUseKind;
  label: string;
  attributes?: Partial<Record<string, string | number | boolean | null>>;
}

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

export interface LayerAccessibility {
  schema_version?: string;
  role: LayerAccessibilityRole;
  alt_text?: string | null;
}

export type LayerAccessibilityRole = "paragraph" | "heading_1" | "heading_2" | "heading_3" | "figure" | "decorative" | "artifact";
export const LayerAccessibilityRoleValues: readonly LayerAccessibilityRole[] = ["paragraph", "heading_1", "heading_2", "heading_3", "figure", "decorative", "artifact"] as const;

export interface LayerRecord {
  schema_version?: string;
  layer_id: string;
  artboard_id: string;
  parent_layer_id?: string | null;
  layer_type: LayerType;
  name: string;
  order: number;
  visible?: boolean;
  locked?: boolean;
  opacity?: number;
  blend_mode?: string;
  transform: LayerTransform;
  shared_style_ids?: string[];
  raster?: RasterLayerData | null;
  vector?: VectorLayerData | null;
  rich_text?: RichTextLayerData | null;
  shape?: ShapeLayerData | null;
  group?: GroupLayerData | null;
  accessibility?: LayerAccessibility | null;
  extension_payload?: Partial<Record<string, string | number | boolean | null>>;
}

export interface LayerTransform {
  schema_version?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation_degrees?: number;
  scale_x?: number;
  scale_y?: number;
  skew_x_degrees?: number;
  skew_y_degrees?: number;
  flip_x?: boolean;
  flip_y?: boolean;
}

export type LayerType = "raster_image" | "vector_svg" | "rich_text" | "shape" | "group" | "table" | "section" | "layout" | "mask" | "adjustment" | "pdf_object" | "interactive_field";
export const LayerTypeValues: readonly LayerType[] = ["raster_image", "vector_svg", "rich_text", "shape", "group", "table", "section", "layout", "mask", "adjustment", "pdf_object", "interactive_field"] as const;

export type LeaseTakeoverStatus = "requested" | "acquired";
export const LeaseTakeoverStatusValues: readonly LeaseTakeoverStatus[] = ["requested", "acquired"] as const;

export interface LevelsParameters {
  schema_version?: string;
  black?: number;
  white?: number;
  midpoint?: number;
}

export type MalwareScanState = "pending" | "clean" | "malicious" | "unavailable" | "timeout" | "error";
export const MalwareScanStateValues: readonly MalwareScanState[] = ["pending", "clean", "malicious", "unavailable", "timeout", "error"] as const;

export type MaskKind = "vector" | "raster" | "shape";
export const MaskKindValues: readonly MaskKind[] = ["vector", "raster", "shape"] as const;

export interface Membership {
  schema_version?: string;
  membership_id: string;
  workspace_id: string;
  actor_id: string;
  role: RolePreset;
}

export interface MetadataDisposition {
  schema_version?: string;
  exif: "preserved-approved-fields" | "removed" | "absent";
  gps: "removed" | "absent";
  orientation: "normalized" | "absent";
  xmp: "removed" | "absent";
  iptc: "removed" | "absent";
  comments: "removed" | "absent";
  maker_notes: "removed" | "absent";
  private_blocks: "removed" | "absent";
  software_device: "preserved-approved-fields" | "removed" | "absent";
  embedded_thumbnails: "removed" | "absent";
  icc_profiles: "converted-to-srgb" | "assumed-srgb-and-tagged" | "preserved";
}

export interface MetadataPolicy {
  schema_version?: string;
  preserve_copyright?: boolean;
  preserve_description?: boolean;
  preserve_capture_time?: boolean;
  preserve_camera?: boolean;
  preserve_location?: false;
  remove_embedded_thumbnails?: true;
}

export interface NoiseReductionParameters {
  schema_version?: string;
  strength?: number;
  preserve_edges?: number;
}

export type NotificationKind = "upload_accepted" | "upload_rejected" | "job_completed" | "job_failed" | "job_cancelled" | "retry_required" | "retry_completed" | "guest_handoff_completed" | "source_cleanup_required" | "lease_takeover_requested";
export const NotificationKindValues: readonly NotificationKind[] = ["upload_accepted", "upload_rejected", "job_completed", "job_failed", "job_cancelled", "retry_required", "retry_completed", "guest_handoff_completed", "source_cleanup_required", "lease_takeover_requested"] as const;

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

export interface OrientationNormalizeParameters {
  schema_version?: string;
  source_orientation: number;
  apply_exactly_once?: true;
}

export interface OutputSizeEstimate {
  schema_version?: string;
  minimum_bytes: number;
  maximum_bytes: number;
  explanation: string;
}

export interface PdfDocumentSettings {
  schema_version?: string;
  title: string;
  language?: string;
  subject?: string | null;
  page_size_policy?: PdfPageSizePolicy;
  default_page_name?: string;
  pages: PdfPageRecord[];
}

export type PdfExportState = "queued" | "running" | "succeeded" | "failed" | "cancellation_requested" | "cancelled";
export const PdfExportStateValues: readonly PdfExportState[] = ["queued", "running", "succeeded", "failed", "cancellation_requested", "cancelled"] as const;

export type PdfImagePlacement = "contain";
export const PdfImagePlacementValues: readonly PdfImagePlacement[] = ["contain"] as const;

export interface PdfOutputProfile {
  schema_version?: string;
  profile_id?: PdfOutputProfileId;
  profile_version?: string;
  label?: string;
  tagged_pdf?: false;
  archival_conformance?: null;
  colour_space?: "srgb";
  image_quality?: number;
  metadata_policy?: "safe";
}

export type PdfOutputProfileId = "screen";
export const PdfOutputProfileIdValues: readonly PdfOutputProfileId[] = ["screen"] as const;

export type PdfPageOrientation = "portrait" | "landscape";
export const PdfPageOrientationValues: readonly PdfPageOrientation[] = ["portrait", "landscape"] as const;

export type PdfPagePreset = "a4" | "letter";
export const PdfPagePresetValues: readonly PdfPagePreset[] = ["a4", "letter"] as const;

export interface PdfPageRecord {
  schema_version?: string;
  artboard_id: string;
  label: string;
  master_page_id?: string | null;
}

export type PdfPageSizePolicy = "uniform" | "mixed";
export const PdfPageSizePolicyValues: readonly PdfPageSizePolicy[] = ["uniform", "mixed"] as const;

export interface PdfPreflightIssue {
  schema_version?: string;
  code: string;
  severity: PdfPreflightSeverity;
  message: string;
  page_artboard_id?: string | null;
  layer_id?: string | null;
  blocks_export?: boolean;
}

export interface PdfPreflightReport {
  schema_version?: string;
  document_id: string;
  document_version_id: string;
  /** Lower-case hexadecimal SHA-256 digest. */
  snapshot_sha256: string;
  profile: PdfOutputProfile;
  state: PdfPreflightState;
  page_count: number;
  issues?: PdfPreflightIssue[];
  generated_at: string;
}

export type PdfPreflightSeverity = "info" | "warning" | "error";
export const PdfPreflightSeverityValues: readonly PdfPreflightSeverity[] = ["info", "warning", "error"] as const;

export type PdfPreflightState = "ready" | "blocked";
export const PdfPreflightStateValues: readonly PdfPreflightState[] = ["ready", "blocked"] as const;

export interface PdfRendererIdentity {
  schema_version?: string;
  name: string;
  version: string;
  licence_component_ids: string[];
  /** Lower-case hexadecimal SHA-256 digest. */
  standard_font_sha256: string;
}

export type Permission = "workspace.read" | "project.create" | "project.read" | "file.create" | "file.read" | "file.move" | "audit.read" | "usage.read" | "upload.create" | "upload.read" | "upload.cancel" | "job.read" | "job.cancel" | "job.retry" | "notification.read" | "notification.update" | "search.read" | "document.create" | "document.read" | "document.edit" | "document.version" | "document.lease.takeover" | "recipe.create" | "recipe.read" | "recipe.update" | "export.create" | "export.read" | "export.cancel" | "export.retry" | "batch.create" | "batch.read" | "batch.cancel" | "batch.retry";
export const PermissionValues: readonly Permission[] = ["workspace.read", "project.create", "project.read", "file.create", "file.read", "file.move", "audit.read", "usage.read", "upload.create", "upload.read", "upload.cancel", "job.read", "job.cancel", "job.retry", "notification.read", "notification.update", "search.read", "document.create", "document.read", "document.edit", "document.version", "document.lease.takeover", "recipe.create", "recipe.read", "recipe.update", "export.create", "export.read", "export.cancel", "export.retry", "batch.create", "batch.read", "batch.cancel", "batch.retry"] as const;

export type PermissionOrigin = "role" | "workspace_grant";
export const PermissionOriginValues: readonly PermissionOrigin[] = ["role", "workspace_grant"] as const;

export type ProcessingJobKind = "file_intake_inspection" | "preview_generation" | "image_export" | "pdf_export" | "export_bundle";
export const ProcessingJobKindValues: readonly ProcessingJobKind[] = ["file_intake_inspection", "preview_generation", "image_export", "pdf_export", "export_bundle"] as const;

export interface ProcessingJobRecord {
  schema_version?: string;
  job_id: string;
  kind: ProcessingJobKind;
  owner_kind: UploadOwnerKind;
  workspace_id?: string | null;
  actor_id?: string | null;
  guest_session_id?: string | null;
  upload_session_id?: string | null;
  document_id?: string | null;
  export_request_id?: string | null;
  pdf_export_request_id?: string | null;
  bundle_id?: string | null;
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

export interface RasterLayerData {
  schema_version?: string;
  shared_asset_id: string;
  instance_mode?: AssetInstanceMode;
  crop?: CropRegion;
  adjustments?: VisualAdjustments;
  mask_ids?: string[];
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

export type RecentWorkKind = "project" | "file" | "native_document";
export const RecentWorkKindValues: readonly RecentWorkKind[] = ["project", "file", "native_document"] as const;

export interface RecommendationEvidence {
  schema_version?: string;
  kind: RecommendationEvidenceKind;
  explanation: string;
}

export type RecommendationEvidenceKind = "measured" | "heuristic";
export const RecommendationEvidenceKindValues: readonly RecommendationEvidenceKind[] = ["measured", "heuristic"] as const;

export type RecommendationTargetKind = "processing_operation" | "metadata_policy" | "output_warning";
export const RecommendationTargetKindValues: readonly RecommendationTargetKind[] = ["processing_operation", "metadata_policy", "output_warning"] as const;

export type ResamplingAlgorithm = "nearest" | "bilinear" | "bicubic" | "lanczos";
export const ResamplingAlgorithmValues: readonly ResamplingAlgorithm[] = ["nearest", "bilinear", "bicubic", "lanczos"] as const;

export interface ResamplingScaleParameters {
  schema_version?: string;
  scale: 2 | 4;
  algorithm?: ResamplingAlgorithm;
  label?: "Standard resampling (not AI reconstruction)";
}

export type ResizeMode = "pixels" | "percent" | "physical";
export const ResizeModeValues: readonly ResizeMode[] = ["pixels", "percent", "physical"] as const;

export interface ResizeParameters {
  schema_version?: string;
  mode: ResizeMode;
  width: number;
  height: number;
  physical_unit?: "in" | "mm" | "cm" | null;
  ppi?: number | null;
  aspect_locked?: true;
  aspect_preset?: string | null;
  fit?: "contain" | "cover";
  algorithm?: ResamplingAlgorithm;
}

export interface RichTextLayerData {
  schema_version?: string;
  text: string;
  runs?: RichTextRun[];
  font_family?: string;
  font_size?: number;
  color?: string;
  text_align?: "left" | "center" | "right" | "justify";
}

export interface RichTextRun {
  schema_version?: string;
  start: number;
  end: number;
  style?: Partial<Record<string, string | number | boolean | null>>;
}

export type RolePreset = "owner" | "admin" | "member" | "viewer";
export const RolePresetValues: readonly RolePreset[] = ["owner", "admin", "member", "viewer"] as const;

export interface RotateParameters {
  schema_version?: string;
  degrees: number;
  expand_canvas?: boolean;
}

export interface SafeRecommendation {
  schema_version?: string;
  recommendation_id: string;
  title: string;
  explanation: string;
  evidence: RecommendationEvidence[];
  target_kind: RecommendationTargetKind;
  operation?: ImageOperation | null;
  metadata_policy?: MetadataPolicy | null;
  state?: "proposed" | "accepted" | "declined";
}

export interface SaturationVibranceParameters {
  schema_version?: string;
  saturation?: number;
  vibrance?: number;
}

export type SearchResultKind = "project" | "file" | "job" | "native_document";
export const SearchResultKindValues: readonly SearchResultKind[] = ["project", "file", "job", "native_document"] as const;

export type ShapeKind = "rectangle" | "ellipse" | "line" | "polygon";
export const ShapeKindValues: readonly ShapeKind[] = ["rectangle", "ellipse", "line", "polygon"] as const;

export interface ShapeLayerData {
  schema_version?: string;
  shape: ShapeKind;
  fill?: string | null;
  stroke?: string | null;
  stroke_width?: number;
  corner_radius?: number;
  points?: ShapePoint[];
}

export interface ShapePoint {
  schema_version?: string;
  x: number;
  y: number;
}

export type SharedAssetKind = "raster" | "vector" | "brand";
export const SharedAssetKindValues: readonly SharedAssetKind[] = ["raster", "vector", "brand"] as const;

export interface SharedAssetRecord {
  schema_version?: string;
  shared_asset_id: string;
  workspace_id: string;
  kind: SharedAssetKind;
  name: string;
  asset_original_id?: string | null;
  source_version_id?: string | null;
  object_reference_id?: string | null;
  preview_object_reference_id?: string | null;
  source_media_type?: string | null;
  source_width_px?: number | null;
  source_height_px?: number | null;
  source_byte_size?: number | null;
  source_orientation?: number | null;
  source_bit_depth?: number | null;
  source_frame_count?: number | null;
  source_has_icc_profile?: boolean | null;
  source_colour_model?: string | null;
  linked_by_default?: boolean;
}

export type SharedStyleKind = "fill" | "stroke" | "text" | "effect" | "brand";
export const SharedStyleKindValues: readonly SharedStyleKind[] = ["fill", "stroke", "text", "effect", "brand"] as const;

export interface SharedStyleRecord {
  schema_version?: string;
  shared_style_id: string;
  name: string;
  kind: SharedStyleKind;
  properties?: Partial<Record<string, string | number | boolean | null>>;
}

/** Header-verified source channel interpretation used for capability admission. */
export type SourceColourModel = "grayscale" | "rgb" | "cmyk" | "indexed";
export const SourceColourModelValues: readonly SourceColourModel[] = ["grayscale", "rgb", "cmyk", "indexed"] as const;

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
  colour_model?: SourceColourModel | null;
  has_icc_profile?: boolean | null;
  sensitive_metadata?: string[];
  malware_scan_state: MalwareScanState;
}

/** Formats with one executable inspection, preview and browser-editing path. */
export type StudioEditableMediaType = "image/jpeg" | "image/png" | "image/webp" | "image/tiff";
export const StudioEditableMediaTypeValues: readonly StudioEditableMediaType[] = ["image/jpeg", "image/png", "image/webp", "image/tiff"] as const;

export interface TintParameters {
  schema_version?: string;
  amount?: number;
}

export interface UnsharpMaskParameters {
  schema_version?: string;
  radius?: number;
  amount?: number;
  threshold?: number;
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

export interface VectorLayerData {
  schema_version?: string;
  shared_asset_id?: string | null;
  sanitised_svg_object_reference_id?: string | null;
  compatibility_report_id?: string | null;
  path_data?: string | null;
  fill?: string | null;
  stroke?: string | null;
  stroke_width?: number;
  mask_ids?: string[];
}

export interface VisualAdjustments {
  schema_version?: string;
  exposure?: number;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  temperature?: number;
  tint?: number;
  sharpness?: number;
}

export interface WhiteBalanceParameters {
  schema_version?: string;
  temperature_kelvin?: number;
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

export interface ZipManifestItem {
  schema_version?: string;
  output_id: string;
  filename: string;
  /** Lower-case hexadecimal SHA-256 digest. */
  sha256: string;
  byte_size: number;
}

export interface ApplicationSession {
  schema_version?: string;
  authenticated?: true;
  actor: Actor;
  expires_at: string;
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

export interface BatchCreateRequest {
  schema_version?: string;
  name: string;
  items: BatchSubmissionItem[];
  /** Lower-case hexadecimal SHA-256 digest. */
  plan_sha256: string;
  group_approvals: BatchGroupApproval[];
  confirmed_client_item_ids?: string[];
}

export interface BatchPlan {
  schema_version?: string;
  /** Lower-case hexadecimal SHA-256 digest. */
  plan_sha256: string;
  name: string;
  items: BatchPlanItem[];
  groups: BatchPlanGroup[];
  included_count: number;
  excluded_count: number;
}

export interface BatchPlanRequest {
  schema_version?: string;
  name: string;
  items: BatchSubmissionItem[];
}

export interface BatchReport {
  schema_version?: string;
  batch_id: string;
  workspace_id: string;
  name: string;
  state: BatchRunState;
  item_count: number;
  queued_count: number;
  running_count: number;
  succeeded_count: number;
  failed_count: number;
  cancelled_count: number;
  excluded_count: number;
  groups: BatchGroupReport[];
  items: BatchReportItem[];
  generated_at: string;
}

export interface BatchRunRecord {
  schema_version?: string;
  batch_id: string;
  workspace_id: string;
  name: string;
  /** Lower-case hexadecimal SHA-256 digest. */
  plan_sha256: string;
  state: BatchRunState;
  items: BatchItemRecord[];
  groups: BatchGroupRecord[];
  item_count: number;
  included_count: number;
  excluded_count: number;
  queued_count: number;
  running_count: number;
  succeeded_count: number;
  failed_count: number;
  cancelled_count: number;
  cancellation_requested: boolean;
  zero_charge?: true;
  created_by_actor_id: string;
  created_at: string;
  updated_at: string;
}

export interface CollectionProjectRelation {
  schema_version?: string;
  collection_id: string;
  project_id: string;
}

export interface DocumentReadModel {
  schema_version?: string;
  document: EditorDocumentRecord;
  snapshot: EditorDocumentSnapshot;
  versions: DocumentVersionRecord[];
}

export interface EditorOperationRecord {
  schema_version?: string;
  operation_id: string;
  document_id: string;
  base_revision: number;
  resulting_revision: number;
  mutation: EditorMutation;
  actor_id: string;
  idempotency_key: string;
  trace_id: string;
  occurred_at: string;
}

export interface EnhancementPreview {
  schema_version?: string;
  preview_id: string;
  document_id: string;
  document_version_id: string;
  recipe_id: string;
  recipe_version: number;
  mode: "original" | "current" | "recommended";
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  export_request_id: string;
  output_id: string;
  artboard_id: string;
  proxy?: false;
  authoritative?: true;
  quality_label?: "Authoritative registered preview rendered from the immutable document version";
  width: number;
  height: number;
  histogram?: HistogramSummary | null;
  object_reference_id?: string | null;
  sha256?: string | null;
  byte_size?: number | null;
  media_type?: string | null;
  failure_code?: string | null;
  failure_message?: string | null;
  created_at: string;
}

export interface ErrorEnvelope {
  schema_version?: string;
  error: ErrorDetail;
}

export interface ExportProvenance {
  schema_version?: string;
  provenance_id: string;
  output_id: string;
  workspace_id: string;
  document_id: string;
  document_version_id: string;
  source_version_ids: string[];
  recipe_id: string;
  recipe_version: number;
  processor_name: string;
  processor_version: string;
  deterministic: boolean;
  /** Lower-case hexadecimal SHA-256 digest. */
  parameters_sha256: string;
  /** Lower-case hexadecimal SHA-256 digest. */
  output_sha256: string;
  metadata_policy: MetadataPolicy;
  metadata_evidence: MetadataDisposition;
  trace_id: string;
  job_id: string;
  created_at: string;
}

export interface ExportZipBundle {
  schema_version?: string;
  bundle_id: string;
  workspace_id: string;
  export_request_id: string;
  job_id: string;
  state: ExportOutputState;
  items: ZipManifestItem[];
  object_reference_id?: string | null;
  sha256?: string | null;
  byte_size?: number | null;
  expires_at: string;
  created_at: string;
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
}

export interface IdentityReference {
  schema_version?: string;
  identity_id: string;
  actor_id: string;
  provider: IdentityProviderKind;
  provider_subject: string;
}

export interface ImageExportRequestRecord {
  schema_version?: string;
  export_request_id: string;
  workspace_id: string;
  document_id: string;
  document_version_id: string;
  recipe_id: string;
  recipe_version: number;
  job_id: string;
  outputs: ExportOutputRecord[];
  state: "queued" | "running" | "partially_completed" | "completed" | "failed" | "cancelled";
  estimated_size: OutputSizeEstimate;
  zero_charge?: true;
  created_by_actor_id: string;
  created_at: string;
  updated_at: string;
}

export interface ImportCompatibilityReport {
  schema_version?: string;
  compatibility_report_id: string;
  source_file_id: string;
  source_version_id: string;
  source_kind: ImportSourceKind;
  state: ImportCompatibilityState;
  source_preserved?: true;
  sanitisation_required?: boolean;
  preserved_structures?: string[];
  unsupported_structures?: string[];
  warnings?: string[];
  created_at: string;
}

export interface IntelligentIntakePresentation {
  schema_version?: string;
  upload_session_id: string;
  filename: string;
  source_facts: SourceFacts;
  classification: IntakeClassificationRecord;
  risk_dimensions: IntakeRiskDimension[];
  intake_explanation: string;
  quality_observations: string[];
  intended_use_requirements: string[];
  production_readiness: string;
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

export interface LeaseTakeoverResult {
  schema_version?: string;
  status: LeaseTakeoverStatus;
  current_editor?: EditorLeaseRecord | null;
  grant?: EditorLeaseGrant | null;
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

export interface PdfCreateRequest {
  schema_version?: string;
  name: string;
  project_id?: string | null;
  source_file_ids?: string[];
  page_preset?: PdfPagePreset;
  orientation?: PdfPageOrientation;
  image_placement?: PdfImagePlacement;
  language?: string;
}

export interface PdfExportRequestRecord {
  schema_version?: string;
  pdf_export_request_id: string;
  workspace_id: string;
  document_id: string;
  document_version_id: string;
  /** Lower-case hexadecimal SHA-256 digest. */
  snapshot_sha256: string;
  profile: PdfOutputProfile;
  preflight: PdfPreflightReport;
  state: PdfExportState;
  job_id: string;
  created_by_actor_id: string;
  created_at: string;
  updated_at: string;
  failure_code?: string | null;
  failure_message?: string | null;
}

export interface PdfExportResult {
  schema_version?: string;
  pdf_export_result_id: string;
  pdf_export_request_id: string;
  workspace_id: string;
  document_id: string;
  document_version_id: string;
  filename: string;
  media_type?: "application/pdf";
  byte_size: number;
  /** Lower-case hexadecimal SHA-256 digest. */
  sha256: string;
  page_count: number;
  renderer: PdfRendererIdentity;
  object_reference_id: string;
  created_at: string;
}

export interface PermissionGrant {
  schema_version?: string;
  grant_id: string;
  workspace_id: string;
  actor_id: string;
  permission: Permission;
  allowed: boolean;
}

export interface PreviewProvenance {
  schema_version?: string;
  preview_id: string;
  document_id: string;
  document_version_id?: string | null;
  source_version_id: string;
  object_reference_id: string;
  job_id: string;
  trace_id: string;
  processor_name: string;
  processor_version: string;
  zoom_level: "workspace" | "thumbnail";
  /** Lower-case hexadecimal SHA-256 digest. */
  source_sha256: string;
  /** Lower-case hexadecimal SHA-256 digest. */
  sha256: string;
  width: number;
  height: number;
  colour_decision: string;
  metadata_decision: string;
  authoritative?: false;
  created_at: string;
}

export interface ProcessingRecipeRecord {
  schema_version?: string;
  recipe_id: string;
  workspace_id: string;
  document_id: string;
  version: number;
  name: string;
  operations: ImageOperation[];
  deterministic?: true;
  created_by_actor_id: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectList {
  schema_version?: string;
  projects: ProjectRecord[];
  collections?: Collection[];
}

export interface RecommendationDecision {
  schema_version?: string;
  decision_id: string;
  workspace_id: string;
  recommendation_set_id: string;
  recommendation_id: string;
  actor_id: string;
  state: "accepted" | "declined";
  created_at: string;
}

export interface RecommendationSet {
  schema_version?: string;
  recommendation_set_id: string;
  workspace_id: string;
  document_id: string;
  document_version_id: string;
  intended_outcome?: IntendedOutcome | null;
  intended_outcome_required?: boolean;
  source_facts_summary: string[];
  recommendations: SafeRecommendation[];
  no_correction_needed?: boolean;
  created_at: string;
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

export interface StudioFormatCapability {
  schema_version?: string;
  editable_media_types?: StudioEditableMediaType[];
}

export interface StudioSourceCandidate {
  schema_version?: string;
  file_id: string;
  display_name: string;
  media_type: string;
  byte_size: number;
  width?: number | null;
  height?: number | null;
  editable: boolean;
  compatibility_message: string;
  requires_generated_preview: boolean;
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
