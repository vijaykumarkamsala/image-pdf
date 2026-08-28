// GENERATED FILE - DO NOT EDIT.
//
// Produced by tools/generate_ts_contracts.py from packages/schemas/v1/*.json,
// which are themselves generated from the pydantic models in packages/contracts.
//
// The Python models are the single source of truth. Editing this file by hand
// creates exactly the drift the generation step exists to prevent: the browser
// lab and the benchmark runner would silently disagree about a field name, and
// the disagreement would surface as a fake measurement discrepancy.
//
// Regenerate with:  python tools/generate_ts_contracts.py
// Verify with:      python tools/generate_ts_contracts.py --check

// --------------------------------------------------------------- version --

/** The contract version. Mirrors ipw.contracts.version.SCHEMA_VERSION. */
export const SCHEMA_VERSION = "1.5.0";


// ---------------------------------------------------------------- shared --

export interface AdjustSettings {
  brightness_percent?: number;
  contrast_percent?: number;
  exposure_percent?: number;
  kind?: "adjust";
  saturation_percent?: number;
  white_balance?: "none" | "auto" | "daylight" | "tungsten";
}

/**
 * Learned denoising. Distinct from DenoiseSettings, which is a median filter.
 *
 * ``noise_sigma`` is the noise level the weights were *trained* for, not a
 * strength dial. SwinIR publishes separate checkpoints for sigma 15, 25 and 50,
 * and an adapter must refuse a level it has no weights for rather than
 * substituting the nearest one - the same rule as native scale for
 * super-resolution (benchmark plan section 7).
 */
export interface AiDenoiseSettings {
  kind?: "ai_denoise";
  mode?: "natural" | "strong";
  noise_sigma?: 15 | 25 | 50;
}

/** Evaluation corpus categories from the benchmark plan section 5.1. */
export type AssetCategory = "modern_mobile_photo" | "old_photograph" | "face_portrait" | "document_screenshot" | "product_catalogue" | "illustration_anime" | "low_light_noisy" | "background_removal" | "large_professional" | "synthetic_fixture";
export const AssetCategoryValues: readonly AssetCategory[] = ["modern_mobile_photo", "old_photograph", "face_portrait", "document_screenshot", "product_catalogue", "illustration_anime", "low_light_noisy", "background_removal", "large_professional", "synthetic_fixture"] as const;

/** What the manifest contains, counted. */
export interface AssetInventory {
  by_category?: Partial<Record<AssetCategory, number>>;
  external_references?: number;
  local_fixtures?: number;
  total?: number;
  total_declared_bytes?: number;
  total_declared_pixels?: number;
}

/**
 * One benchmark input asset, described by declared metadata only.
 *
 * POC-001 never decodes the image. The ``declared_*`` fields are assertions made
 * by the manifest author; POC-003 verifies them against the real bytes.
 */
export interface AssetManifestEntry {
  /** Stable, human-readable asset identifier, unique within a manifest. */
  asset_id: string;
  category: AssetCategory;
  declared_bit_depth: number;
  declared_bytes: number;
  declared_channels: number;
  declared_extension: string;
  declared_height: number;
  declared_media_type: MediaType;
  declared_width: number;
  degradation_recipe?: DegradationRecipe | null;
  external_ref?: ExternalRef | null;
  ground_truth?: GroundTruthRelationship;
  ground_truth_asset_id?: string | null;
  notes?: string | null;
  provenance?: Provenance | null;
  /** Path relative to the asset root. Mutually exclusive with external_ref. */
  relative_path?: string | null;
  /** SHA-256 of the original bytes. The provenance anchor. */
  sha256: string;
}

/** One asset processed by one processor under one operation. */
export interface AssetResult {
  /** Attempt counter. Deliberately OUTSIDE the identity so a retry reuses the same result_id and cannot duplicate a usage event. */
  attempt?: number;
  failure?: NormalizedFailure | null;
  finished_at?: string | null;
  identity: ResultIdentity;
  measurement?: Measurement;
  nondeterministic?: boolean;
  output?: OutputArtifact | null;
  /** Content-addressed identifier produced by ipw.benchmark_runner.ids. */
  result_id: string;
  started_at?: string | null;
  state: ResultState;
}

export interface BackgroundRemoveSettings {
  feather_px?: number;
  kind?: "background_remove";
  return_mask?: boolean;
}

export interface BackgroundReplaceSettings {
  kind?: "background_replace";
  mode: "solid" | "image" | "generated";
  solid_colour?: string | null;
}

export interface ColouriseSettings {
  /** D-010: colourisation must always be described as estimated colour, never as historical fact. The literal type makes disabling it impossible. */
  disclose_estimated_colour?: true;
  kind?: "colourise";
  saturation_percent?: number;
}

/** What is being licensed. Each is reviewed separately, never together. */
export type ComponentKind = "code" | "weights" | "dependency" | "dataset" | "service";
export const ComponentKindValues: readonly ComponentKind[] = ["code", "weights", "dependency", "dataset", "service"] as const;

export interface ConvertSettings {
  /** Required when converting transparency to a format without alpha. */
  flatten_background?: string | null;
  kind?: "convert";
  quality?: number;
  target_media_type: MediaType;
}

/**
 * Direct job cost components from the benchmark plan section 13.
 *
 * All amounts are exact decimal strings. Money is never a float.
 */
export interface CostBreakdown {
  /** How the figures were derived, e.g. 'not_estimated', 'list_price_2026_08'. */
  basis?: string;
  /** Exact decimal value carried as a string to avoid float drift. */
  compute?: string;
  currency?: string;
  /** Exact decimal value carried as a string to avoid float drift. */
  external_provider_fee?: string;
  /** Exact decimal value carried as a string to avoid float drift. */
  model_load_allocation?: string;
  /** Exact decimal value carried as a string to avoid float drift. */
  output_bandwidth?: string;
  /** Exact decimal value carried as a string to avoid float drift. */
  payment_overhead_allocation?: string;
  /** Exact decimal value carried as a string to avoid float drift. */
  retained_storage_allocation?: string;
  /** Exact decimal value carried as a string to avoid float drift. */
  temporary_storage?: string;
  /** Exact decimal value carried as a string to avoid float drift. */
  total?: string;
}

export interface CropSettings {
  height: number;
  kind?: "crop";
  width: number;
  x: number;
  y: number;
}

export interface DamageRepairSettings {
  kind?: "damage_repair";
  strength_percent?: number;
  targets?: ("scratch" | "fold" | "stain" | "tear")[];
}

/**
 * How a synthetically degraded asset was produced from its ground truth.
 *
 * Benchmark plan section 5.2: synthetic degradation must vary blur, noise,
 * downsampling, JPEG compression and colour loss, and the recipe must be
 * recorded so the pair is reproducible.
 */
export interface DegradationRecipe {
  blur_radius_px?: number | null;
  colour_loss?: string | null;
  downsample_denominator?: number | null;
  downsample_numerator?: number | null;
  jpeg_quality?: number | null;
  method: string;
  noise_sigma_x100?: number | null;
  seed?: number | null;
}

export interface DenoiseSettings {
  kind?: "denoise";
  strength_percent?: number;
}

/**
 * Commercial standing of one component.
 *
 * ``UNKNOWN`` is the default and is deliberately *not* a synonym for "probably
 * fine": it permits research but blocks every commercial purpose.
 */
export type Disposition = "approved" | "review_required" | "non_commercial" | "unknown" | "blocked";
export const DispositionValues: readonly Disposition[] = ["approved", "review_required", "non_commercial", "unknown", "blocked"] as const;

/**
 * Flatten the lighting on a photograph of a page.
 *
 * A phone photograph of paper carries the room with it: the lamp as a bright
 * patch, its warmth across the page, a shadow down one edge. Those are
 * illumination rather than content, and they are removed by estimating the
 * light and dividing it out - which is why one setting fixes the shadow, the
 * colour cast and the lamp's gradient together.
 */
export interface DocumentCleanSettings {
  keep_ink_colour?: boolean;
  kind?: "document_clean";
  strength_percent?: number;
  whiten?: boolean;
}

/**
 * Make a picture larger, and better than a resize would.
 *
 * ``material`` is asked for because sharpening after enlargement is worth
 * +3.9 dB on printed text and costs -1.8 dB on woven cloth. One default would
 * be quietly wrong for whoever works in the other kind.
 */
export interface EnlargeSettings {
  iterations?: number;
  kind?: "enlarge";
  material?: "photo" | "text" | "texture";
  scale?: number;
}

/** Runtime, dependency and hardware description for one run. */
export interface EnvironmentRecord {
  contract_version?: string;
  /** Installed versions of the declared runtime dependencies. */
  dependency_versions?: Partial<Record<string, string>>;
  hardware?: HardwareRecord;
  notes?: string | null;
  os_name?: string;
  os_release?: string;
  platform?: string;
  python_implementation?: string;
  python_version?: string;
}

/**
 * Reference to an asset held outside Git in protected storage.
 *
 * Large or private benchmark assets are never committed. They are referenced by
 * id and hash and fetched by an operator-supplied credential at run time.
 */
export interface ExternalRef {
  /** Object key within that storage. Never a URL carrying credentials. */
  key: string;
  /** Logical storage name, e.g. 'corpus-private'. */
  storage: string;
}

export interface FaceRestoreSettings {
  apply_to_all_faces?: boolean;
  fidelity_percent?: number;
  kind?: "face_restore";
  mode?: "natural" | "strong";
}

/** The ten normalised categories from USER_FLOWS_AND_EDGE_CASES.md section 18. */
export type FailureCategory = "invalid_input" | "unsupported_format" | "unsupported_feature" | "safety_limit" | "entitlement_required" | "queue_capacity" | "processor_unavailable" | "processor_quality_failure" | "temporary_infrastructure" | "permanent_processing" | "cancelled";
export const FailureCategoryValues: readonly FailureCategory[] = ["invalid_input", "unsupported_format", "unsupported_feature", "safety_limit", "entitlement_required", "queue_capacity", "processor_unavailable", "processor_quality_failure", "temporary_infrastructure", "permanent_processing", "cancelled"] as const;

/**
 * Stable failure codes.
 *
 * Codes are namespaced by the subsystem that raises them and are part of the
 * public contract: tests, reports and (later) the browser lab assert on these
 * exact strings, so a code is never renamed, only deprecated.
 */
export type FailureCode = "MANIFEST.UNREADABLE" | "MANIFEST.FILE_TOO_LARGE" | "MANIFEST.NOT_JSON" | "MANIFEST.SCHEMA_INVALID" | "MANIFEST.UNKNOWN_FIELD" | "MANIFEST.MISSING_FIELD" | "MANIFEST.SCHEMA_VERSION_UNSUPPORTED" | "MANIFEST.DUPLICATE_ASSET_ID" | "MANIFEST.CONTENT_TYPE_MISMATCH" | "MANIFEST.UNSUPPORTED_MEDIA_TYPE" | "MANIFEST.DIMENSIONS_EXCEEDED" | "MANIFEST.BYTES_EXCEEDED" | "MANIFEST.MISSING_PROVENANCE" | "MANIFEST.INVALID_PATH" | "MANIFEST.ASSET_FILE_MISSING" | "MANIFEST.HASH_MISMATCH" | "MANIFEST.DECLARED_BYTES_MISMATCH" | "MANIFEST.GROUND_TRUTH_UNRESOLVED" | "MANIFEST.DEGRADATION_RECIPE_REQUIRED" | "PROCESSOR.OPERATION_UNSUPPORTED" | "PROCESSOR.SETTINGS_UNSUPPORTED" | "PROCESSOR.UNAVAILABLE" | "PROCESSOR.INTERNAL_ERROR" | "PROCESSOR.TIMEOUT" | "PROCESSOR.CANCELLED" | "PROCESSOR.QUALITY_GATE_FAILED" | "SAFETY.PIXELS_EXCEEDED" | "SAFETY.BYTES_EXCEEDED" | "SAFETY.DECOMPRESSION_BOMB" | "SAFETY.MEMORY_EXCEEDED" | "SAFETY.ORIGINAL_MUTATED" | "LICENCE.NOT_APPROVED" | "LICENCE.BLOCKED" | "LICENCE.REFERENCE_ONLY" | "LICENCE.COMPONENT_NOT_REGISTERED" | "LICENCE.SUPPLY_CHAIN_INCOMPLETE" | "LICENCE.DEPENDENCY_CYCLE" | "LICENCE.DEPENDENCY_NOT_REGISTERED" | "LICENCE.NO_APPROVED_FALLBACK" | "LICENCE.UNKNOWN_DISPOSITION" | "RIGHTS.BENCHMARK_USE_NOT_PERMITTED" | "RIGHTS.PUBLIC_DEMO_NOT_PERMITTED" | "RIGHTS.SENSITIVE_CONTENT" | "RIGHTS.PROVENANCE_MISSING";
export const FailureCodeValues: readonly FailureCode[] = ["MANIFEST.UNREADABLE", "MANIFEST.FILE_TOO_LARGE", "MANIFEST.NOT_JSON", "MANIFEST.SCHEMA_INVALID", "MANIFEST.UNKNOWN_FIELD", "MANIFEST.MISSING_FIELD", "MANIFEST.SCHEMA_VERSION_UNSUPPORTED", "MANIFEST.DUPLICATE_ASSET_ID", "MANIFEST.CONTENT_TYPE_MISMATCH", "MANIFEST.UNSUPPORTED_MEDIA_TYPE", "MANIFEST.DIMENSIONS_EXCEEDED", "MANIFEST.BYTES_EXCEEDED", "MANIFEST.MISSING_PROVENANCE", "MANIFEST.INVALID_PATH", "MANIFEST.ASSET_FILE_MISSING", "MANIFEST.HASH_MISMATCH", "MANIFEST.DECLARED_BYTES_MISMATCH", "MANIFEST.GROUND_TRUTH_UNRESOLVED", "MANIFEST.DEGRADATION_RECIPE_REQUIRED", "PROCESSOR.OPERATION_UNSUPPORTED", "PROCESSOR.SETTINGS_UNSUPPORTED", "PROCESSOR.UNAVAILABLE", "PROCESSOR.INTERNAL_ERROR", "PROCESSOR.TIMEOUT", "PROCESSOR.CANCELLED", "PROCESSOR.QUALITY_GATE_FAILED", "SAFETY.PIXELS_EXCEEDED", "SAFETY.BYTES_EXCEEDED", "SAFETY.DECOMPRESSION_BOMB", "SAFETY.MEMORY_EXCEEDED", "SAFETY.ORIGINAL_MUTATED", "LICENCE.NOT_APPROVED", "LICENCE.BLOCKED", "LICENCE.REFERENCE_ONLY", "LICENCE.COMPONENT_NOT_REGISTERED", "LICENCE.SUPPLY_CHAIN_INCOMPLETE", "LICENCE.DEPENDENCY_CYCLE", "LICENCE.DEPENDENCY_NOT_REGISTERED", "LICENCE.NO_APPROVED_FALLBACK", "LICENCE.UNKNOWN_DISPOSITION", "RIGHTS.BENCHMARK_USE_NOT_PERMITTED", "RIGHTS.PUBLIC_DEMO_NOT_PERMITTED", "RIGHTS.SENSITIVE_CONTENT", "RIGHTS.PROVENANCE_MISSING"] as const;

export interface FlipSettings {
  axis: "horizontal" | "vertical";
  kind?: "flip";
}

/**
 * Outcome of applying the gates for one purpose.
 *
 * Recorded on every run. ``markings`` travel with the results, which is what
 * makes it impossible for a reference-only run to be quietly re-presented as a
 * production recommendation.
 */
export interface GateDecision {
  effective_disposition: Disposition;
  failures?: NormalizedFailure[];
  markings?: string[];
  permitted: boolean;
  purpose: RunPurpose;
  reference_only?: boolean;
  warnings?: NormalizedFailure[];
}

export type GroundTruthRelationship = "paired" | "unpaired" | "reference";
export const GroundTruthRelationshipValues: readonly GroundTruthRelationship[] = ["paired", "unpaired", "reference"] as const;

/** Paired versus unpaired split (benchmark plan section 5.2). */
export interface GroundTruthSummary {
  by_relationship?: Partial<Record<GroundTruthRelationship, number>>;
  with_degradation_recipe?: number;
}

/**
 * Routing class assigned by inspection (PRODUCT_REQUIREMENTS.md section 14).
 *
 * ``EXTREME_CUSTOM`` is deliberately not ``INVALID``: D-022 requires an
 * actionable professional or custom path rather than a blunt rejection, while
 * hard safety ceilings still apply above it.
 */
export type HandlingClass = "standard" | "professional" | "extreme_custom" | "invalid";
export const HandlingClassValues: readonly HandlingClass[] = ["standard", "professional", "extreme_custom", "invalid"] as const;

/** Hardware description. GPU fields stay ``None`` until POC-006. */
export interface HardwareRecord {
  gpu_driver?: string | null;
  gpu_name?: string | null;
  gpu_vram_bytes?: number | null;
  logical_cpus?: number;
  machine?: string;
  processor?: string;
  total_memory_bytes?: number | null;
}

export interface InspectOnlySettings {
  kind?: "inspect_only";
}

/**
 * Learned JPEG compression-artifact reduction.
 *
 * ``quality_target`` is the JPEG quality the weights were trained against, in the
 * same sense as ``noise_sigma`` above: a property of the checkpoint, not a knob.
 */
export interface JpegArtifactRepairSettings {
  kind?: "jpeg_artifact_repair";
  quality_target?: 10 | 20 | 30 | 40;
}

/**
 * A usage event.
 *
 * The POC ledger stands in for production billing so that idempotency can be
 * proved before billing exists (benchmark plan section 12: "No duplicate
 * charging events in the POC ledger"). It is keyed by ``result_id``: recording
 * the same result twice is a no-op, never a second entry.
 */
export interface LedgerEntry {
  /** Stable, human-readable asset identifier, unique within a manifest. */
  asset_id: string;
  operation_kind: OperationKind;
  recorded_at?: string | null;
  /** Content-addressed identifier produced by ipw.benchmark_runner.ids. */
  result_id: string;
  /** Content-addressed identifier produced by ipw.benchmark_runner.ids. */
  run_id: string;
  /** Chargeable units. Output megapixels later. */
  units?: number;
}

/**
 * Licence posture of the register at report time (POC-002).
 *
 * Recorded in the deterministic identity section so that a report can be
 * audited long after the fact: what was registered, what was approved, and
 * which advertised operations had no approved fallback (D-040).
 */
export interface LicenceSummary {
  by_disposition?: Partial<Record<Disposition, number>>;
  component_count?: number;
  components_with_supply_chain_gaps?: number;
  operations_without_approved_fallback?: string[];
  reference_only_count?: number;
  register_name?: string;
}

/** Everything observed about one processing call. */
export interface Measurement {
  cost?: CostBreakdown;
  input_bytes?: number;
  input_height?: number | null;
  input_width?: number | null;
  memory?: MemoryUsage;
  output_bytes?: number;
  output_height?: number | null;
  output_width?: number | null;
  retry_count?: number;
  /** How the image was tiled, when it was. None means the question did not arise - a processor that does not tile, or a call that failed before it would have. */
  tiling?: TilingRecord | null;
  timing?: Timing;
}

/**
 * Declared media types. The initial supported set is JPG and PNG.
 *
 * Additional members exist so a manifest can *declare* an unsupported type and
 * be rejected with ``MANIFEST.UNSUPPORTED_MEDIA_TYPE`` rather than a generic
 * schema error.
 */
export type MediaType = "image/jpeg" | "image/png" | "image/tiff" | "image/webp" | "image/heic" | "image/avif" | "image/bmp" | "image/gif";
export const MediaTypeValues: readonly MediaType[] = ["image/jpeg", "image/png", "image/tiff", "image/webp", "image/heic", "image/avif", "image/bmp", "image/gif"] as const;

/**
 * Memory observed during a single processing call.
 *
 * Two figures, because on a shared process neither is trustworthy alone.
 * ``peak_rss_bytes`` is a **process-lifetime high-water mark**: it includes
 * native allocations, which dominate image work, but it never decreases. Run an
 * AI model and a resize in one process and both report the model's peak - which
 * is true of the process and false of the resize.
 *
 * ``python_peak_delta_bytes`` is the mirror image: genuinely per-call, but blind
 * to whatever a C library allocated. Read together they bracket the answer. A
 * single trustworthy per-call number needs process isolation, which is what the
 * containerised runtime exists to provide.
 */
export interface MemoryUsage {
  /** How the peak was obtained, e.g. 'tracemalloc', 'resource.getrusage', 'nvml'. */
  measurement_method?: string;
  peak_rss_bytes?: number;
  /** Peak video memory. None means no accelerator was present to measure, which is a different claim from zero VRAM used. */
  peak_vram_bytes?: number | null;
  /** Python-attributable peak allocation for this call alone. Unlike peak_rss_bytes this is not contaminated by earlier work in the same process, but it excludes native allocations. None means it was not measured. */
  python_peak_delta_bytes?: number | null;
}

/** What the caller (ultimately, the customer) can do about a failure. */
export type NextAction = "change_settings" | "retry" | "alternate_route" | "wait" | "purchase_capacity" | "contact_support" | "none";
export const NextActionValues: readonly NextAction[] = ["change_settings", "retry", "alternate_route", "wait", "purchase_capacity", "contact_support", "none"] as const;

export interface NoopSettings {
  kind?: "noop";
}

/**
 * A machine-actionable failure.
 *
 * ``message`` is safe to log and to show: it must never contain image bytes,
 * absolute paths, credentials or personal metadata (AGENTS.md security rules).
 * Use ``pointer`` to locate the offending field and ``context`` for redacted,
 * scalar-only detail.
 */
export interface NormalizedFailure {
  category: FailureCategory;
  code: FailureCode;
  /** Redacted scalar detail. Never contains bytes, paths or personal data. */
  context?: Partial<Record<string, string | number | boolean>>;
  message: string;
  next_action: NextAction;
  /** RFC 6901 JSON Pointer to the offending field, when applicable. */
  pointer?: string | null;
  /** Short operator-facing hint on how to resolve the failure. */
  remediation?: string | null;
  retryable: boolean;
  severity?: Severity;
}

/** A fully specified unit of work: what to do, how, and under which variant. */
export interface Operation {
  family: OperationFamily;
  kind: OperationKind;
  route?: ProcessingRoute;
  settings: NoopSettings | InspectOnlySettings | ResizeSettings | CropSettings | RotateSettings | FlipSettings | AdjustSettings | SharpenSettings | DenoiseSettings | DocumentCleanSettings | EnlargeSettings | StraightenPageSettings | PrintReadySettings | ConvertSettings | SuperResolutionSettings | FaceRestoreSettings | DamageRepairSettings | ColouriseSettings | AiDenoiseSettings | JpegArtifactRepairSettings | BackgroundRemoveSettings | BackgroundReplaceSettings;
  variant: ProcessingVariant;
}

/** Standard (deterministic / non-generative) versus AI (may reconstruct). */
export type OperationFamily = "standard" | "ai" | "inspection";
export const OperationFamilyValues: readonly OperationFamily[] = ["standard", "ai", "inspection"] as const;

export type OperationKind = "noop" | "inspect_only" | "resize" | "crop" | "rotate" | "flip" | "adjust" | "sharpen" | "denoise" | "document_clean" | "enlarge" | "straighten_page" | "print_ready" | "convert" | "super_resolution" | "ai_denoise" | "jpeg_artifact_repair" | "face_restore" | "damage_repair" | "colourise" | "background_remove" | "background_replace";
export const OperationKindValues: readonly OperationKind[] = ["noop", "inspect_only", "resize", "crop", "rotate", "flip", "adjust", "sharpen", "denoise", "document_clean", "enlarge", "straighten_page", "print_ready", "convert", "super_resolution", "ai_denoise", "jpeg_artifact_repair", "face_restore", "damage_repair", "colourise", "background_remove", "background_replace"] as const;

/**
 * EXIF orientation, normalised **as metadata** - the original is never touched.
 *
 * POC-003 records the tag, derives the true display dimensions and states the
 * transform a later stage must apply. It does not rotate pixels: that is a
 * POC-004 processing step, and doing it here would mean writing to an original.
 *
 * Covers the ``USER_FLOWS_AND_EDGE_CASES.md`` section 5 case "orientation
 * metadata conflicts with pixels: normalize preview without mutating original".
 */
export interface Orientation {
  exif_tag?: number | null;
  /** Whether a horizontal flip is also required. */
  mirrored?: boolean;
  /** Clockwise rotation to apply: 0/90/180/270. */
  rotate_degrees?: number;
  /** True when the transform exchanges width and height, so stored dimensions are not display dimensions. */
  swaps_axes?: boolean;
}

/** A derivative produced by processing. Never an original. */
export interface OutputArtifact {
  bytes_written: number;
  height?: number | null;
  /** True unless the output explicitly qualifies as a final result. Browser output is a preview unless explicitly eligible (AGENTS.md product invariants). */
  is_preview?: boolean;
  media_type: string;
  /** Path relative to the workspace or output root. */
  relative_path: string;
  /** Lower-case hexadecimal SHA-256 digest. */
  sha256: string;
  width?: number | null;
}

/**
 * Clean a photographed page and enlarge it, in one step.
 *
 * The order is not a detail. Cleaning first means the enlargement works on a
 * flat white page instead of magnifying a brown cast and a lamp gradient
 * along with the writing.
 */
export interface PrintReadySettings {
  keep_ink_colour?: boolean;
  kind?: "print_ready";
  material?: "photo" | "text" | "texture";
  scale?: number;
  whiten?: boolean;
}

/** Where the work ran. Customer-facing wording is applied by the UI, not here. */
export type ProcessingRoute = "browser_local" | "cloud_cpu" | "cloud_gpu" | "not_applicable";
export const ProcessingRouteValues: readonly ProcessingRoute[] = ["browser_local", "cloud_cpu", "cloud_gpu", "not_applicable"] as const;

/** The processing variants from benchmark plan section 7. */
export type ProcessingVariant = "original_control" | "standard_browser_preview" | "standard_server_authoritative" | "ai_natural" | "ai_strong" | "ai_task_specific";
export const ProcessingVariantValues: readonly ProcessingVariant[] = ["original_control", "standard_browser_preview", "standard_server_authoritative", "ai_natural", "ai_strong", "ai_task_specific"] as const;

/** Everything needed to reproduce and to licence-check a processor. */
export interface ProcessorIdentity {
  /** False means output may vary between identical runs. Such results must be labelled nondeterministic in every report (AGENTS.md reproducibility rules). */
  deterministic_output?: boolean;
  family: OperationFamily;
  licence_ref?: string | null;
  name: string;
  precision?: string;
  /** Gate B requires inference-time network access to be disabled unless explicitly required. POC-001 records the declaration; POC-006 enforces it. */
  requires_network?: boolean;
  runtime: RuntimeIdentity;
  supported_operations: OperationKind[];
  tile_overlap?: number | null;
  tile_size?: number | null;
  version: string;
  weights?: WeightsIdentity | null;
}

/**
 * The processor fields that make a run reproducible.
 *
 * A narrower projection of :class:`~ipw.contracts.processor.ProcessorIdentity`:
 * descriptive fields (display names, notes) are excluded so that editorial
 * changes do not silently change a ``run_id``.
 */
export interface ProcessorIdentityDigest {
  container_digest?: string | null;
  family: OperationFamily;
  name: string;
  precision: string;
  runtime_framework?: string | null;
  runtime_framework_version?: string | null;
  runtime_language: string;
  runtime_language_version: string;
  tile_overlap?: number | null;
  tile_size?: number | null;
  version: string;
  weights_sha256?: string | null;
}

/**
 * Where an asset came from and what may lawfully be done with it.
 *
 * Mirrors the rights manifest required by benchmark plan section 5.3.
 */
export interface Provenance {
  /** ISO-8601 date. */
  acquired_on?: string | null;
  contains_people: boolean;
  contains_sensitive_information: boolean;
  /** Licence or permission under which it is used. */
  licence: string;
  notes?: string | null;
  /** Rights holder. */
  owner: string;
  /** May this asset be processed in benchmarks? */
  permitted_benchmark_use: boolean;
  /** May results appear in a public demo? */
  public_demo_permitted: boolean;
  /** Where the asset came from, e.g. 'generated-in-repo'. */
  source: string;
}

/** Fully deterministic report content, derived from validated metadata only. */
export interface ReportIdentity {
  ground_truth?: GroundTruthSummary;
  inventory?: AssetInventory;
  licences?: LicenceSummary;
  /** Content-addressed identifier produced by ipw.benchmark_runner.ids. */
  manifest_digest: string;
  manifest_id: string;
  manifest_name: string;
  /** Lower-case hexadecimal SHA-256 digest. */
  manifest_sha256: string;
  planned_variants?: ProcessingVariant[];
  /** Content-addressed identifier produced by ipw.benchmark_runner.ids. */
  policy_digest: string;
  rights?: RightsSummary;
  runs?: RunReference[];
  schema_version?: string;
  validation_failure_codes?: string[];
  validation_passed?: boolean;
}

export interface ResizeSettings {
  algorithm?: "bicubic" | "lanczos" | "nearest";
  kind?: "resize";
  preserve_aspect_ratio?: boolean;
  scale_denominator?: number | null;
  scale_numerator?: number | null;
  target_height?: number | null;
  target_width?: number | null;
}

/**
 * The exact document hashed to produce a ``result_id``.
 *
 * Every field here is a **declared input**. Nothing observed appears.
 */
export interface ResultIdentity {
  /** Stable, human-readable asset identifier, unique within a manifest. */
  asset_id: string;
  effective_settings: NoopSettings | InspectOnlySettings | ResizeSettings | CropSettings | RotateSettings | FlipSettings | AdjustSettings | SharpenSettings | DenoiseSettings | DocumentCleanSettings | EnlargeSettings | StraightenPageSettings | PrintReadySettings | ConvertSettings | SuperResolutionSettings | FaceRestoreSettings | DamageRepairSettings | ColouriseSettings | AiDenoiseSettings | JpegArtifactRepairSettings | BackgroundRemoveSettings | BackgroundReplaceSettings;
  /** Lower-case hexadecimal SHA-256 digest. */
  input_sha256: string;
  operation_kind: OperationKind;
  /** Content-addressed identifier produced by ipw.benchmark_runner.ids. */
  run_id: string;
  schema_version?: string;
  variant: ProcessingVariant;
}

/** Per-item batch state (PRODUCT_REQUIREMENTS.md section 13). */
export type ResultState = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "skipped";
export const ResultStateValues: readonly ResultState[] = ["queued", "running", "succeeded", "failed", "cancelled", "skipped"] as const;

/**
 * Rights posture of the corpus.
 *
 * Recorded from POC-001 so that the corpus approval conversation can happen
 * before models exist. POC-002 turns these counts into gates.
 */
export interface RightsSummary {
  contains_people?: number;
  contains_sensitive_information?: number;
  missing_provenance?: number;
  permitted_benchmark_use?: number;
  public_demo_permitted?: number;
}

/** Detected input risks. Recorded even when the asset is still accepted. */
export type RiskFlag = "decompression_bomb" | "extension_signature_mismatch" | "declared_metadata_mismatch" | "unsupported_bit_depth" | "unsupported_channel_count" | "unsupported_colour_profile" | "unsupported_encoding" | "malformed_metadata" | "orientation_metadata_present" | "orientation_metadata_conflict" | "excessive_pixels" | "excessive_bytes" | "excessive_working_memory" | "transparency_present" | "animated_content" | "interlaced" | "progressive" | "truncated";
export const RiskFlagValues: readonly RiskFlag[] = ["decompression_bomb", "extension_signature_mismatch", "declared_metadata_mismatch", "unsupported_bit_depth", "unsupported_channel_count", "unsupported_colour_profile", "unsupported_encoding", "malformed_metadata", "orientation_metadata_present", "orientation_metadata_conflict", "excessive_pixels", "excessive_bytes", "excessive_working_memory", "transparency_present", "animated_content", "interlaced", "progressive", "truncated"] as const;

export interface RotateSettings {
  degrees: 90 | 180 | 270;
  expand?: boolean;
  kind?: "rotate";
}

/** The exact document hashed to produce a ``run_id``. */
export interface RunIdentity {
  /** Selected assets, sorted, so selection order cannot change the id. */
  asset_ids: string[];
  component_ids?: string[];
  licence_disposition?: Disposition;
  /** Content-addressed identifier produced by ipw.benchmark_runner.ids. */
  manifest_digest: string;
  manifest_id: string;
  operation: Operation;
  /** Content-addressed identifier produced by ipw.benchmark_runner.ids. */
  policy_digest: string;
  processor: ProcessorIdentityDigest;
  purpose?: RunPurpose;
  reference_only?: boolean;
  run_label?: string;
  /** Set to deliberately distinguish an otherwise identical repeat run. */
  run_nonce?: string;
  schema_version?: string;
}

/** What a run is for. This is the axis the gate turns on (D-038). */
export type RunPurpose = "local_research" | "internal_benchmark" | "public_demo" | "staging" | "production";
export const RunPurposeValues: readonly RunPurpose[] = ["local_research", "internal_benchmark", "public_demo", "staging", "production"] as const;

/** A run included in this report. Empty in POC-001: nothing has been processed. */
export interface RunReference {
  operation_kind: OperationKind;
  processor_name: string;
  /** Content-addressed identifier produced by ipw.benchmark_runner.ids. */
  run_id: string;
  summary?: RunSummary;
}

/** Per-state counts. Proves batch isolation at a glance. */
export interface RunSummary {
  cancelled?: number;
  failed?: number;
  skipped?: number;
  succeeded?: number;
  total?: number;
}

/**
 * Exact runtime a processor executes in.
 *
 * Recorded per AGENTS.md reproducibility rules: "Runtime and dependency
 * versions". Two results are only comparable when this matches or the
 * difference is stated.
 */
export interface RuntimeIdentity {
  container_digest?: string | null;
  container_image?: string | null;
  /** Digest of the pinned dependency set actually installed. */
  dependency_lock_digest?: string | null;
  framework?: string | null;
  framework_version?: string | null;
  language?: string;
  language_version: string;
}

export type Severity = "error" | "warning";
export const SeverityValues: readonly Severity[] = ["error", "warning"] as const;

export interface SharpenSettings {
  amount_percent?: number;
  kind?: "sharpen";
  radius_x100?: number;
}

/**
 * Flatten a page photographed at an angle into a rectangle.
 *
 * Corners are found automatically when none are given. They can be supplied
 * instead - four (x, y) pairs clockwise from the top left - because a detector
 * that is usually right still has to be correctable by hand.
 */
export interface StraightenPageSettings {
  /** Four points clockwise from the top left; detected when omitted. */
  corners?: unknown[][] | null;
  kind?: "straighten_page";
}

export interface SuperResolutionSettings {
  kind?: "super_resolution";
  mode?: "natural" | "strong";
  /** True when the model natively produces this scale. Benchmark plan section 7 forbids presenting post-resized output as equivalent to a native scale. */
  native_scale?: boolean;
  scale: 2 | 4;
}

export type ThermalState = "cold" | "warm" | "unknown";
export const ThermalStateValues: readonly ThermalState[] = ["cold", "warm", "unknown"] as const;

/**
 * The tiling decision made for one call, and why (POC-012).
 *
 * Recorded per *result*, not per processor. ``ProcessorIdentity.tile_size`` is
 * the configured budget and feeds the run digest, which is correct - it
 * describes how the processor was set up. The tile actually used depends on the
 * image, so putting it in the identity would give two images processed by the
 * same processor two different processor identities.
 *
 * Every field is an integer or a string. Tiling changes output (POC-006
 * measured 54% of subpixels differing at tile 32/overlap 8), so this record is
 * part of explaining a result, and a float would make it platform-dependent.
 */
export interface TilingRecord {
  budget_bytes?: number;
  columns?: number;
  estimated_peak_bytes?: number;
  /** True when the minimum safe tile still exceeds the budget. The job ran above its configured budget, and its memory figures should be read knowing that rather than discovering it later. */
  exceeds_budget?: boolean;
  overlap: number;
  /** Why this size was chosen: whole_image, budget, max_tile or floor. */
  reason?: string;
  rows?: number;
  scale?: number;
  tile_count?: number;
  tile_size: number;
}

/** Wall-clock phase durations in integer nanoseconds. */
export interface Timing {
  cold_or_warm?: ThermalState;
  cold_start_ns?: number;
  inference_ns?: number;
  postprocess_ns?: number;
  preprocess_ns?: number;
  queue_wait_ns?: number;
  total_ns?: number;
}

/**
 * Serialisation format of a weight file.
 *
 * ``PICKLE`` covers ``.pth``/``.pt``/``.ckpt``: loading one executes arbitrary
 * code. Permitted only inside an isolated container with no network (D-039).
 *
 * ``TRAINEDDATA`` is Tesseract's own container - an indexed bundle of a
 * character set, dictionaries and LSTM weights. It is listed separately rather
 * than folded into ``NOT_APPLICABLE`` because it *is* a weight file and its
 * provenance matters exactly as much as any other model's; and separately from
 * ``PICKLE`` because parsing one does not execute code, so it does not carry
 * that format's isolation requirement.
 */
export type WeightFormat = "safetensors" | "onnx" | "pickle" | "traineddata" | "not_applicable";
export const WeightFormatValues: readonly WeightFormat[] = ["safetensors", "onnx", "pickle", "traineddata", "not_applicable"] as const;

/** Exact model weights. Never optional for an AI processor. */
export interface WeightsIdentity {
  licence_ref?: string | null;
  name: string;
  pinned_commit?: string | null;
  pinned_version?: string | null;
  /** Lower-case hexadecimal SHA-256 digest. */
  sha256: string;
  source_url: string;
}


// ----------------------------------------------------------- root types --

/**
 * A curated set of benchmark inputs.
 *
 * Git stores manifests, hashes and small rights-cleared fixtures. Large or
 * private assets are referenced through ``external_ref`` and live in protected
 * storage (AGENTS.md; benchmark plan section 15).
 */
export interface AssetManifest {
  assets: AssetManifestEntry[];
  description?: string | null;
  manifest_id: string;
  name: string;
  /** Contract version. */
  schema_version?: string;
}

/** The document written by ``bench report``. */
export interface BenchmarkReport {
  default_purpose?: RunPurpose;
  deterministic?: boolean;
  environment?: EnvironmentRecord | null;
  generated_at: string;
  identity: ReportIdentity;
  /** Lower-case hexadecimal SHA-256 digest. */
  identity_digest: string;
  /** Content-addressed identifier produced by ipw.benchmark_runner.ids. */
  report_id: string;
  schema_version?: string;
  tool_version: string;
}

/** One processor, one operation, one selection of assets. */
export interface BenchmarkRun {
  /** Observed. Omitted in deterministic mode. */
  environment?: EnvironmentRecord | null;
  finished_at?: string | null;
  identity: RunIdentity;
  ledger?: LedgerEntry[];
  /** Gate outcome at execution time, including the markings that must travel with every result of this run. */
  licence?: GateDecision | null;
  notes?: string | null;
  processor: ProcessorIdentity;
  results?: AssetResult[];
  /** Content-addressed identifier produced by ipw.benchmark_runner.ids. */
  run_id: string;
  schema_version?: string;
  started_at?: string | null;
  summary?: RunSummary;
}

/** Result of ``Processor.estimate`` - a prediction, not an observation. */
export interface Estimate {
  confidence?: string;
  estimated_cost?: CostBreakdown | null;
  estimated_duration_ns: number;
  estimated_output_bytes?: number | null;
  estimated_peak_memory_bytes: number;
  notes?: string | null;
}

/**
 * Metadata and safety decision for one input asset.
 *
 * ``sha256`` is recomputed from the bytes actually read, never copied from the
 * manifest. A mismatch against the manifest is what proves an original has not
 * been altered in storage.
 */
export interface InspectionResult {
  /** Stable, human-readable asset identifier, unique within a manifest. */
  asset_id: string;
  colour_profile?: string | null;
  compressed_bytes?: number;
  decision: HandlingClass;
  decoded_bit_depth?: number | null;
  decoded_channels?: number | null;
  decoded_height?: number | null;
  decoded_pixels?: number;
  decoded_width?: number | null;
  /** Sub-format actually found, e.g. 'jpeg-baseline', 'png'. */
  detected_encoding?: string | null;
  detected_media_type?: MediaType | null;
  display_height?: number | null;
  /** Width after orientation normalisation. May swap with height. */
  display_width?: number | null;
  estimated_working_memory_bytes?: number;
  /** Estimated decoded bytes divided by compressed bytes, as an integer. */
  expansion_ratio?: number;
  failure?: NormalizedFailure | null;
  has_alpha?: boolean | null;
  /** How many bytes were parsed to reach this decision. */
  header_bytes_read?: number;
  /** True when only manifest-declared metadata was examined, with no file read. POC-001 set this True; POC-003 reads real bytes and sets it False. */
  inspected_without_decoding?: boolean;
  orientation?: Orientation;
  /** Whether any pixel buffer was allocated. POC-003 always reports False: it parses headers only, so an oversized image is rejected before allocation. */
  pixels_decoded?: boolean;
  risk_flags?: RiskFlag[];
  /** Lower-case hexadecimal SHA-256 digest. */
  sha256: string;
  warnings?: NormalizedFailure[];
}

/** One reviewed component: its commercial standing and its supply chain. */
export interface LicenceDisposition {
  accepted_terms_reference?: string | null;
  /** Where written commercial permission is recorded, when the licence itself does not grant it. */
  commercial_permission_reference?: string | null;
  component_id: string;
  /** Component ids whose dispositions this component inherits. A component is never more permissive than the least permissive component it executes. */
  depends_on?: string[];
  display_name: string;
  disposition?: Disposition;
  /** True for gated downloads. Accepting the terms IS entering the licence, so what was accepted must be recorded in accepted_terms_reference. */
  download_requires_terms_acceptance?: boolean;
  /** Where the reviewer read the terms. Auditable, not hearsay. */
  evidence?: string | null;
  kind: ComponentKind;
  /** SPDX identifier where one exists, e.g. 'BSD-3-Clause'. */
  licence_id?: string | null;
  licence_text_url?: string | null;
  /** Gate B requires inference-time network access to be disabled unless the operation explicitly needs it. */
  network_disabled_at_inference?: boolean;
  notes?: string | null;
  /** Official repository or vendor URL. Never a mirror. */
  official_source?: string | null;
  /** Exact released version, tag or commit SHA. */
  pinned_version?: string | null;
  /** Executable for research comparison but never eligible for a commercial recommendation, regardless of disposition. SUPIR is the motivating case. */
  reference_only?: boolean;
  required_notices?: string[];
  reviewed_by?: string | null;
  reviewed_on?: string | null;
  weight_format?: WeightFormat;
  weights_sha256?: string | null;
}

/** The result of one ``process`` call. Success and failure are both normal. */
export interface ProcessOutcome {
  failure?: NormalizedFailure | null;
  measurement?: Measurement;
  nondeterministic?: boolean;
  notes?: string | null;
  output?: OutputArtifact | null;
  succeeded: boolean;
}
