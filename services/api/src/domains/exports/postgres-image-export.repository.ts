import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import type {
  EnhancementPreview,
  ExportOutputProfile,
  ExportOutputRecord,
  ExportZipBundle,
  ImageExportRequestRecord,
  ImageOperation,
  MetadataPolicy,
  ProcessingRecipeRecord,
  RecommendationDecision,
  RecommendationSet,
  SafeRecommendation,
} from "ipw-contracts-ts/product";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

import { DomainError } from "../../kernel/errors.js";
import { runMigrations } from "../../kernel/migrations.js";
import type { CommandContext } from "../../kernel/product.types.js";
import type { RuntimeValues } from "../../kernel/runtime.js";
import type {
  ExportCommandResult,
  ExportDelivery,
  ImageExportRepository,
  PreviewInput,
  RecommendationDecisionInput,
  RecipeInput,
  RecommendationInput,
  SubmitExportInput,
} from "./exports.types.js";
import { assertExecutableExport, effectiveVisibleRasterAssetIds } from "./enhancement-validation.js";

function instant(value: Date | string | null): string | null {
  return value === null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function recipe(row: QueryResultRow): ProcessingRecipeRecord {
  return {
    schema_version: PRODUCT_SCHEMA_VERSION,
    recipe_id: String(row["recipe_id"]),
    workspace_id: String(row["workspace_id"]),
    document_id: String(row["document_id"]),
    version: Number(row["version"]),
    name: String(row["name"]),
    operations: row["operations"] as ImageOperation[],
    deterministic: true,
    created_by_actor_id: String(row["created_by_actor_id"]),
    created_at: instant(row["created_at"] as Date | string)!,
    updated_at: instant(row["updated_at"] as Date | string)!,
  };
}

function output(row: QueryResultRow): ExportOutputRecord {
  return {
    schema_version: PRODUCT_SCHEMA_VERSION,
    output_id: String(row["output_id"]),
    export_request_id: String(row["export_request_id"]),
    artboard_id: String(row["artboard_id"]),
    profile: row["profile"] as ExportOutputRecord["profile"],
    state: String(row["state"]) as ExportOutputRecord["state"],
    progress_percent: Number(row["progress_percent"]),
    filename: String(row["filename"]),
    object_reference_id: row["object_reference_id"] ? String(row["object_reference_id"]) : null,
    sha256: row["sha256"] ? String(row["sha256"]) : null,
    byte_size: row["byte_size"] === null ? null : Number(row["byte_size"]),
    width: row["width"] === null ? null : Number(row["width"]),
    height: row["height"] === null ? null : Number(row["height"]),
    media_type: row["media_type"] ? String(row["media_type"]) : null,
    metadata_verified: row["metadata_verified"] === null ? null : Boolean(row["metadata_verified"]),
    metadata_evidence: row["metadata_evidence"] as ExportOutputRecord["metadata_evidence"],
    histogram: row["histogram"] as ExportOutputRecord["histogram"],
    failure_code: row["failure_code"] ? String(row["failure_code"]) : null,
    failure_message: row["failure_message"] ? String(row["failure_message"]) : null,
    completed_at: instant(row["completed_at"] as Date | string | null),
  };
}

function recommendationSet(
  row: QueryResultRow,
  decisions: ReadonlyMap<string, SafeRecommendation["state"]> = new Map(),
): RecommendationSet {
  const recommendations = (row["recommendations"] as RecommendationSet["recommendations"]).map((item) => ({
    ...item,
    state: decisions.get(item.recommendation_id) ?? item.state,
  }));
  return {
    schema_version: PRODUCT_SCHEMA_VERSION,
    recommendation_set_id: String(row["recommendation_set_id"]),
    workspace_id: String(row["workspace_id"]),
    document_id: String(row["document_id"]),
    document_version_id: String(row["document_version_id"]),
    intended_outcome: row["intended_outcome"] as RecommendationSet["intended_outcome"],
    intended_outcome_required: Boolean(row["intended_outcome_required"]),
    source_facts_summary: row["source_facts_summary"] as RecommendationSet["source_facts_summary"],
    recommendations,
    no_correction_needed: Boolean(row["no_correction_needed"]),
    created_at: instant(row["created_at"] as Date | string)!,
  };
}

function enhancementPreview(row: QueryResultRow): EnhancementPreview {
  return {
    schema_version: PRODUCT_SCHEMA_VERSION,
    preview_id: String(row["preview_id"]),
    document_id: String(row["document_id"]),
    document_version_id: String(row["document_version_id"]),
    recipe_id: String(row["recipe_id"]),
    recipe_version: Number(row["recipe_version"]),
    mode: String(row["mode"]) as EnhancementPreview["mode"],
    state: String(row["state"]) as EnhancementPreview["state"],
    export_request_id: String(row["export_request_id"]),
    output_id: String(row["output_id"]),
    artboard_id: String(row["artboard_id"]),
    proxy: false,
    authoritative: true,
    quality_label: "Authoritative registered preview rendered from the immutable document version",
    width: Number(row["width"] ?? 1200),
    height: Number(row["height"] ?? 900),
    histogram: row["histogram"] as EnhancementPreview["histogram"],
    object_reference_id: row["object_reference_id"] ? String(row["object_reference_id"]) : null,
    sha256: row["sha256"] ? String(row["sha256"]) : null,
    byte_size: row["byte_size"] === null ? null : Number(row["byte_size"]),
    media_type: row["media_type"] ? String(row["media_type"]) : null,
    failure_code: row["failure_code"] ? String(row["failure_code"]) : null,
    failure_message: row["failure_message"] ? String(row["failure_message"]) : null,
    created_at: instant(row["created_at"] as Date | string)!,
  };
}

export class PostgresImageExportRepository implements ImageExportRepository {
  readonly recordsMutationsAtomically = true;

  constructor(private readonly pool: Pool, private readonly runtime: RuntimeValues) {}

  static async connect(connectionString: string, runtime: RuntimeValues, migrate = false): Promise<PostgresImageExportRepository> {
    const pool = new Pool({ connectionString, max: 5 });
    if (migrate) await runMigrations(pool);
    return new PostgresImageExportRepository(pool, runtime);
  }

  async createRecipe(context: CommandContext, input: RecipeInput): Promise<ExportCommandResult<ProcessingRecipeRecord>> {
    return this.transaction(async (client) => {
      const replay = await this.replay<ProcessingRecipeRecord>(client, context, input.workspaceId, "recipe.save");
      if (replay) return { value: replay, replayed: true };
      await this.requireDocument(client, context.principal.actorId, input.workspaceId, input.documentId);
      const recipeId = input.recipeId ?? this.runtime.id("recipe");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${input.workspaceId}:${recipeId}`]);
      const prior = await client.query(
        "SELECT COALESCE(MAX(version),0) AS version FROM processing_recipes WHERE workspace_id=$1 AND recipe_id=$2",
        [input.workspaceId, recipeId],
      );
      const version = Number(prior.rows[0]?.["version"] ?? 0) + 1;
      const now = this.runtime.now();
      const result = await client.query(
        `INSERT INTO processing_recipes(recipe_id,version,workspace_id,document_id,name,operations,
         deterministic,created_by_actor_id,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$8) RETURNING *`,
        [recipeId, version, input.workspaceId, input.documentId, input.name, JSON.stringify(input.operations), context.principal.actorId, now],
      );
      const value = recipe(result.rows[0]);
      await this.evidence(client, context, input.workspaceId, "recipe.saved", "processing_recipe", recipeId);
      await this.remember(client, context, input.workspaceId, "recipe.save", recipeId, value);
      return { value, replayed: false };
    });
  }

  async listRecipes(actorId: string, workspaceId: string, documentId: string): Promise<ProcessingRecipeRecord[]> {
    await this.requireDocument(this.pool, actorId, workspaceId, documentId);
    const result = await this.pool.query(
      "SELECT * FROM processing_recipes WHERE workspace_id=$1 AND document_id=$2 ORDER BY recipe_id,version",
      [workspaceId, documentId],
    );
    return result.rows.map(recipe);
  }

  async getRecipe(actorId: string, workspaceId: string, recipeId: string, version?: number): Promise<ProcessingRecipeRecord | null> {
    const result = await this.pool.query(
      `SELECT recipe.* FROM processing_recipes recipe
       JOIN editor_documents document ON document.document_id=recipe.document_id AND document.workspace_id=recipe.workspace_id
       JOIN memberships membership ON membership.workspace_id=recipe.workspace_id AND membership.actor_id=$1
       WHERE recipe.workspace_id=$2 AND recipe.recipe_id=$3
         AND ($4::integer IS NULL OR recipe.version=$4)
       ORDER BY recipe.version DESC LIMIT 1`,
      [actorId, workspaceId, recipeId, version ?? null],
    );
    return result.rows[0] ? recipe(result.rows[0]) : null;
  }

  async recommend(context: CommandContext, input: RecommendationInput): Promise<ExportCommandResult<RecommendationSet>> {
    return this.transaction(async (client) => {
      const replay = await this.replay<RecommendationSet>(client, context, input.workspaceId, "recommendations.request");
      if (replay) return { value: replay, replayed: true };
      const identity = `${input.workspaceId}:${input.documentId}:${input.documentVersionId}:${input.intendedOutcome ?? "none"}`;
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`recommendations:${identity}`]);
      const existing = await client.query(
        `SELECT * FROM recommendation_sets WHERE workspace_id=$1 AND document_id=$2
         AND document_version_id=$3 AND intended_outcome IS NOT DISTINCT FROM $4
         ORDER BY created_at DESC LIMIT 1`,
        [input.workspaceId, input.documentId, input.documentVersionId, input.intendedOutcome],
      );
      if (existing.rows[0]) {
        const value = await this.readRecommendationSet(
          client,
          context.principal.actorId,
          input.workspaceId,
          existing.rows[0],
        );
        await this.remember(client, context, input.workspaceId, "recommendations.request", value.recommendation_set_id, value);
        return { value, replayed: true };
      }
      const factsResult = await client.query(
        `SELECT document.current_version_id,facts.width,facts.height,facts.orientation,
                facts.has_alpha,facts.bit_depth,facts.has_icc_profile,facts.sensitive_metadata,
                facts.source_sha256
         FROM editor_documents document
         JOIN memberships membership ON membership.workspace_id=document.workspace_id AND membership.actor_id=$1
         LEFT JOIN source_inspection_facts facts ON facts.workspace_id=document.workspace_id
           AND facts.source_version_id=document.source_version_id
           AND facts.asset_original_id=document.source_asset_original_id
         WHERE document.workspace_id=$2 AND document.document_id=$3`,
        [context.principal.actorId, input.workspaceId, input.documentId],
      );
      const facts = factsResult.rows[0];
      if (!facts || String(facts["current_version_id"]) !== input.documentVersionId) {
        throw new DomainError(404, "document-version-not-found", "Document version was not found");
      }
      const summaries: string[] = [];
      const recommendations: SafeRecommendation[] = [];
      const width = facts["width"] === null ? null : Number(facts["width"]);
      const height = facts["height"] === null ? null : Number(facts["height"]);
      if (width && height) summaries.push(`Measured source dimensions are ${width} by ${height} pixels.`);
      const orientation = facts["orientation"] === null ? null : Number(facts["orientation"]);
      if (orientation && orientation !== 1) {
        summaries.push(`Measured EXIF orientation ${orientation} is normalized once during verified source decode.`);
      }
      const sensitive = Array.isArray(facts["sensitive_metadata"]) ? facts["sensitive_metadata"] as string[] : [];
      if (sensitive.length) {
        const policy: MetadataPolicy = {
          schema_version: PRODUCT_SCHEMA_VERSION,
          preserve_copyright: true,
          preserve_description: false,
          preserve_capture_time: false,
          preserve_camera: false,
          preserve_location: false,
          remove_embedded_thumbnails: true,
        };
        recommendations.push({
          schema_version: PRODUCT_SCHEMA_VERSION,
          recommendation_id: this.runtime.id("recommendation"),
          title: "Remove private metadata on export",
          explanation: "The original remains untouched; completed derivatives omit detected private metadata.",
          evidence: [{ schema_version: PRODUCT_SCHEMA_VERSION, kind: "measured", explanation: `Detected metadata categories: ${sensitive.join(", ")}.` }],
          target_kind: "metadata_policy",
          operation: null,
          metadata_policy: policy,
          state: "proposed",
        });
      }
      if (facts["has_alpha"] === true) {
        recommendations.push(this.warningRecommendation(
          "Keep transparency where the format supports it",
          "JPEG cannot preserve transparency and requires a confirmed background colour.",
          "The verified source contains an alpha channel.",
        ));
      }
      if (width && height && width * height < 1_000_000) {
        recommendations.push(this.warningRecommendation(
          "Review the intended output size",
          "This source may be suitable for smaller digital outputs; larger sizes use standard resampling and do not recreate detail.",
          "The measured source contains fewer than one million pixels.",
        ));
      }
      if (facts["has_icc_profile"] === false) summaries.push("No embedded ICC profile was detected; the source colour space is untagged.");
      const value: RecommendationSet = {
        schema_version: PRODUCT_SCHEMA_VERSION,
        recommendation_set_id: this.runtime.id("recommendations"),
        workspace_id: input.workspaceId,
        document_id: input.documentId,
        document_version_id: input.documentVersionId,
        intended_outcome: input.intendedOutcome,
        intended_outcome_required: input.intendedOutcome === null && Boolean(width && height && width * height < 1_000_000),
        source_facts_summary: summaries.length ? summaries : ["No additional measured correction facts are available."],
        recommendations,
        no_correction_needed: recommendations.every((item) => item.target_kind !== "processing_operation"),
        created_at: this.runtime.now(),
      };
      await client.query(
        `INSERT INTO recommendation_sets(recommendation_set_id,workspace_id,document_id,document_version_id,
         intended_outcome,intended_outcome_required,source_facts_summary,recommendations,no_correction_needed,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [value.recommendation_set_id, value.workspace_id, value.document_id, value.document_version_id,
          value.intended_outcome, value.intended_outcome_required, JSON.stringify(value.source_facts_summary),
          JSON.stringify(value.recommendations), value.no_correction_needed, value.created_at],
      );
      await this.evidence(client, context, input.workspaceId, "recommendations.generated", "editor_document", input.documentId);
      await this.remember(client, context, input.workspaceId, "recommendations.request", value.recommendation_set_id, value);
      return { value, replayed: false };
    });
  }

  async decideRecommendations(context: CommandContext, input: RecommendationDecisionInput): Promise<ExportCommandResult<RecommendationDecision[]>> {
    return this.transaction(async (client) => {
      const replay = await this.replay<RecommendationDecision[]>(client, context, input.workspaceId, "recommendations.decide");
      if (replay) return { value: replay, replayed: true };
      const result = await client.query(
        `SELECT recommendations FROM recommendation_sets recommendation
         JOIN memberships membership ON membership.workspace_id=recommendation.workspace_id
          AND membership.actor_id=$1
         WHERE recommendation.workspace_id=$2 AND recommendation.recommendation_set_id=$3`,
        [context.principal.actorId, input.workspaceId, input.recommendationSetId],
      );
      if (!result.rows[0]) throw new DomainError(404, "recommendation-set-not-found", "Recommendation set was not found");
      const available = new Set(
        ((result.rows[0]["recommendations"] as Array<{ recommendation_id?: string }>) ?? [])
          .map((item) => item.recommendation_id)
          .filter((value): value is string => Boolean(value)),
      );
      if (!input.decisions.length || input.decisions.some((item) => !available.has(item.recommendationId))) {
        throw new DomainError(400, "recommendation-decision-invalid", "Every decision must reference this recommendation set");
      }
      const now = this.runtime.now();
      const values: RecommendationDecision[] = [];
      for (const decision of input.decisions) {
        const value: RecommendationDecision = {
          schema_version: PRODUCT_SCHEMA_VERSION,
          decision_id: this.runtime.id("recommendation-decision"),
          workspace_id: input.workspaceId,
          recommendation_set_id: input.recommendationSetId,
          recommendation_id: decision.recommendationId,
          actor_id: context.principal.actorId,
          state: decision.state,
          created_at: now,
        };
        await client.query(
          `INSERT INTO recommendation_decisions(decision_id,workspace_id,recommendation_set_id,
           recommendation_id,actor_id,state,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [value.decision_id, value.workspace_id, value.recommendation_set_id,
            value.recommendation_id, value.actor_id, value.state, value.created_at],
        );
        values.push(value);
      }
      await this.evidence(client, context, input.workspaceId, "recommendations.decided", "recommendation_set", input.recommendationSetId);
      await this.remember(client, context, input.workspaceId, "recommendations.decide", input.recommendationSetId, values);
      return { value: values, replayed: false };
    });
  }

  async createPreview(context: CommandContext, input: PreviewInput): Promise<ExportCommandResult<EnhancementPreview>> {
    return this.transaction(async (client) => {
      const replay = await this.replay<EnhancementPreview>(client, context, input.workspaceId, "enhancement-preview.create");
      if (replay) return { value: replay, replayed: true };
      const document = await this.requireDocument(client, context.principal.actorId, input.workspaceId, input.documentId);
      const selectedRecipe = await this.getRecipe(context.principal.actorId, input.workspaceId, input.recipeId, input.recipeVersion ?? undefined);
      if (!selectedRecipe || selectedRecipe.document_id !== input.documentId) {
        throw new DomainError(404, "recipe-not-found", "Recipe was not found");
      }
      const snapshot = document["snapshot"] as { artboards?: Array<{ artboard_id: string; width: number; height: number }> };
      const artboards = [...(snapshot.artboards ?? [])].sort((left, right) => left.artboard_id.localeCompare(right.artboard_id));
      const artboardId = input.artboardId ?? artboards[0]?.artboard_id;
      if (!artboardId || !artboards.some((item) => item.artboard_id === artboardId)) {
        throw new DomainError(400, "export-artboard-invalid", "Choose an artboard from this document version");
      }
      const profile = {
        schema_version: PRODUCT_SCHEMA_VERSION,
        profile_id: "profile-authoritative-preview",
        preset_version: "recovery-2e-v1" as const,
        name: "Authoritative preview",
        purpose: "custom" as const,
        format: "png" as const,
        width: 1200,
        height: 900,
        percentage: null,
        physical_width: null,
        physical_height: null,
        physical_unit: null,
        ppi: null,
        fit: "contain" as const,
        quality: null,
        lossless: true,
        resampling_algorithm: "lanczos" as const,
        colour_profile: "srgb" as const,
        bit_depth: 8 as const,
        alpha_behavior: "preserve" as const,
        background: null,
        metadata_policy: {
          schema_version: PRODUCT_SCHEMA_VERSION,
          preserve_copyright: false,
          preserve_description: false,
          preserve_capture_time: false,
          preserve_camera: false,
          preserve_location: false as const,
          remove_embedded_thumbnails: true as const,
        },
        chroma_subsampling: null,
        filename_template: "preview",
        collision_behavior: "fail" as const,
      };
      const previewOperations = input.mode === "original" ? [] : selectedRecipe.operations;
      assertExecutableExport(snapshot, previewOperations, [{ artboardId, profile }]);
      await this.assertSourceCapabilities(client, input.workspaceId, snapshot, [artboardId], [profile]);
      const previewId = this.runtime.id("enhancement-preview");
      const exportId = this.runtime.id("preview-export");
      const outputId = this.runtime.id("preview-output");
      const jobId = this.runtime.id("job");
      const now = this.runtime.now();
      await client.query(
        `INSERT INTO image_export_requests(export_request_id,workspace_id,actor_id,document_id,
         document_version_id,recipe_id,recipe_version,job_id,state,estimated_min_bytes,
         estimated_max_bytes,estimate_explanation,request_kind,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued',1024,6480000,$9,'enhancement_preview',$10,$10)`,
        [exportId, input.workspaceId, context.principal.actorId, input.documentId,
          document["current_version_id"], selectedRecipe.recipe_id, selectedRecipe.version, jobId,
          "Authoritative preview is registered at a fixed 1200 by 900 comparison viewport.", now],
      );
      await client.query(
        `INSERT INTO image_export_outputs(output_id,export_request_id,artboard_id,profile,state,
         progress_percent,filename) VALUES ($1,$2,$3,$4,'queued',0,'preview.png')`,
        [outputId, exportId, artboardId, JSON.stringify(profile)],
      );
      await client.query(
        `INSERT INTO enhancement_previews(preview_id,workspace_id,actor_id,document_id,
         document_version_id,recipe_id,recipe_version,mode,export_request_id,output_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [previewId, input.workspaceId, context.principal.actorId, input.documentId,
          document["current_version_id"], selectedRecipe.recipe_id, selectedRecipe.version,
          input.mode, exportId, outputId, now],
      );
      await this.insertJob(client, context, {
        jobId, kind: "image_export", workspaceId: input.workspaceId,
        documentId: input.documentId, exportRequestId: exportId, bundleId: null, now,
      });
      await this.evidence(client, context, input.workspaceId, "enhancement-preview.queued", "enhancement_preview", previewId);
      const value = await this.readPreview(client, input.workspaceId, previewId);
      await this.remember(client, context, input.workspaceId, "enhancement-preview.create", previewId, value);
      return { value, replayed: false };
    });
  }

  async getPreview(actorId: string, workspaceId: string, previewId: string): Promise<EnhancementPreview | null> {
    const allowed = await this.pool.query(
      `SELECT 1 FROM enhancement_previews preview JOIN memberships membership
       ON membership.workspace_id=preview.workspace_id AND membership.actor_id=$1
       WHERE preview.workspace_id=$2 AND preview.preview_id=$3`,
      [actorId, workspaceId, previewId],
    );
    return allowed.rowCount ? this.readPreview(this.pool, workspaceId, previewId) : null;
  }

  async submit(context: CommandContext, input: SubmitExportInput): Promise<ExportCommandResult<ImageExportRequestRecord>> {
    return this.transaction(async (client) => {
      const replay = await this.replay<ImageExportRequestRecord>(client, context, input.workspaceId, "export.submit");
      if (replay) return { value: replay, replayed: true };
      const document = await this.requireDocument(client, context.principal.actorId, input.workspaceId, input.documentId);
      if (String(document["current_version_id"]) !== input.documentVersionId) {
        throw new DomainError(409, "document-version-changed", "Review the current document version before exporting");
      }
      const selectedRecipe = await this.getRecipe(context.principal.actorId, input.workspaceId, input.recipeId, input.recipeVersion);
      if (!selectedRecipe || selectedRecipe.document_id !== input.documentId) throw new DomainError(404, "recipe-not-found", "Recipe was not found");
      const snapshot = document["snapshot"] as { artboards?: Array<{ artboard_id: string; width: number; height: number }> };
      assertExecutableExport(snapshot, selectedRecipe.operations, input.outputs);
      await this.assertSourceCapabilities(
        client,
        input.workspaceId,
        snapshot,
        input.outputs.map((item) => item.artboardId),
        input.outputs.map((item) => item.profile),
      );
      const artboards = new Map((snapshot.artboards ?? []).map((item) => [item.artboard_id, item]));
      if (input.outputs.some((item) => !artboards.has(item.artboardId))) throw new DomainError(400, "export-artboard-invalid", "Every output must select an artboard in this document version");
      const exportId = this.runtime.id("export");
      const jobId = this.runtime.id("job");
      const now = this.runtime.now();
      const estimates = input.outputs.map((item) => {
        const board = artboards.get(item.artboardId)!;
        return this.estimatePixels(board.width, board.height, item.profile);
      });
      const minimum = Math.floor(estimates.reduce((sum, pixels) => sum + pixels * 0.08, 0));
      const maximum = Math.ceil(estimates.reduce((sum, pixels) => sum + pixels * 4.5, 0));
      await client.query(
        `INSERT INTO image_export_requests(export_request_id,workspace_id,actor_id,document_id,
         document_version_id,recipe_id,recipe_version,job_id,state,estimated_min_bytes,
         estimated_max_bytes,estimate_explanation,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9,$10,$11,$12,$12)`,
        [exportId, input.workspaceId, context.principal.actorId, input.documentId, input.documentVersionId,
          input.recipeId, input.recipeVersion, jobId, minimum, maximum,
          "Range reflects format, content and metadata uncertainty; it is not a promised byte count.", now],
      );
      for (const item of input.outputs) {
        await client.query(
          `INSERT INTO image_export_outputs(output_id,export_request_id,artboard_id,profile,state,
           progress_percent,filename) VALUES ($1,$2,$3,$4,'queued',0,$5)`,
          [this.runtime.id("output"), exportId, item.artboardId, JSON.stringify(item.profile), item.filename],
        );
      }
      await this.insertJob(client, context, {
        jobId,
        kind: "image_export",
        workspaceId: input.workspaceId,
        documentId: input.documentId,
        exportRequestId: exportId,
        bundleId: null,
        now,
      });
      await this.evidence(client, context, input.workspaceId, "export.submitted", "image_export", exportId);
      const value = await this.readExport(client, input.workspaceId, exportId);
      await this.remember(client, context, input.workspaceId, "export.submit", exportId, value);
      return { value, replayed: false };
    });
  }

  async list(actorId: string, workspaceId: string, documentId?: string): Promise<ImageExportRequestRecord[]> {
    const result = await this.pool.query(
      `SELECT request.export_request_id FROM image_export_requests request
       JOIN memberships membership ON membership.workspace_id=request.workspace_id AND membership.actor_id=$1
       WHERE request.workspace_id=$2 AND ($3::text IS NULL OR request.document_id=$3)
         AND request.request_kind='export'
       ORDER BY request.updated_at DESC,request.export_request_id DESC`,
      [actorId, workspaceId, documentId ?? null],
    );
    return Promise.all(result.rows.map((row) => this.readExport(this.pool, workspaceId, String(row["export_request_id"]))));
  }

  async get(actorId: string, workspaceId: string, exportRequestId: string): Promise<ImageExportRequestRecord | null> {
    const allowed = await this.pool.query(
      `SELECT 1 FROM image_export_requests request
       JOIN memberships membership ON membership.workspace_id=request.workspace_id AND membership.actor_id=$1
       WHERE request.workspace_id=$2 AND request.export_request_id=$3`,
      [actorId, workspaceId, exportRequestId],
    );
    return allowed.rowCount ? this.readExport(this.pool, workspaceId, exportRequestId) : null;
  }

  async cancel(context: CommandContext, workspaceId: string, exportRequestId: string): Promise<ExportCommandResult<ImageExportRequestRecord>> {
    return this.transaction(async (client) => {
      const replay = await this.replay<ImageExportRequestRecord>(client, context, workspaceId, "export.cancel");
      if (replay) return { value: replay, replayed: true };
      const result = await client.query(
        `SELECT request.*,job.state AS job_state FROM image_export_requests request
         JOIN processing_jobs job ON job.job_id=request.job_id
         WHERE request.workspace_id=$1 AND request.export_request_id=$2 FOR UPDATE OF request,job`,
        [workspaceId, exportRequestId],
      );
      const row = result.rows[0];
      if (!row) throw new DomainError(404, "export-not-found", "Export was not found");
      if (!["completed", "partially_completed", "failed", "cancelled"].includes(String(row["state"]))) {
        const immediate = ["queued", "retry_wait"].includes(String(row["job_state"]));
        await client.query("UPDATE processing_jobs SET state=$1,updated_at=$2 WHERE job_id=$3", [immediate ? "cancelled" : "cancel_requested", this.runtime.now(), row["job_id"]]);
        if (immediate) {
          await client.query("UPDATE image_export_outputs SET state='cancelled' WHERE export_request_id=$1 AND state='queued'", [exportRequestId]);
          await client.query("UPDATE image_export_requests SET state='cancelled',updated_at=$1 WHERE export_request_id=$2", [this.runtime.now(), exportRequestId]);
        }
        await this.evidence(client, context, workspaceId, "export.cancellation-requested", "image_export", exportRequestId);
      }
      const value = await this.readExport(client, workspaceId, exportRequestId);
      await this.remember(client, context, workspaceId, "export.cancel", exportRequestId, value);
      return { value, replayed: false };
    });
  }

  async retry(context: CommandContext, workspaceId: string, exportRequestId: string): Promise<ExportCommandResult<ImageExportRequestRecord>> {
    return this.transaction(async (client) => {
      const replay = await this.replay<ImageExportRequestRecord>(client, context, workspaceId, "export.retry");
      if (replay) return { value: replay, replayed: true };
      const current = await client.query("SELECT * FROM image_export_requests WHERE workspace_id=$1 AND export_request_id=$2 FOR UPDATE", [workspaceId, exportRequestId]);
      if (!current.rows[0]) throw new DomainError(404, "export-not-found", "Export was not found");
      if (!["failed", "partially_completed"].includes(String(current.rows[0]["state"]))) {
        throw new DomainError(409, "export-retry-unavailable", "Retry is available only after failed outputs reach a terminal state");
      }
      const failed = await client.query("SELECT 1 FROM image_export_outputs WHERE export_request_id=$1 AND state='failed' LIMIT 1", [exportRequestId]);
      if (!failed.rowCount) throw new DomainError(409, "export-retry-unavailable", "No failed outputs are eligible for retry");
      const jobId = this.runtime.id("job");
      const now = this.runtime.now();
      await client.query(
        `UPDATE image_export_outputs SET state='queued',progress_percent=0,failure_code=NULL,
         failure_message=NULL WHERE export_request_id=$1 AND state='failed'`,
        [exportRequestId],
      );
      await client.query("UPDATE image_export_requests SET job_id=$1,state='queued',updated_at=$2 WHERE export_request_id=$3", [jobId, now, exportRequestId]);
      await this.insertJob(client, context, {
        jobId,
        kind: "image_export",
        workspaceId,
        documentId: String(current.rows[0]["document_id"]),
        exportRequestId,
        bundleId: null,
        now,
      });
      await this.evidence(client, context, workspaceId, "export.retry-requested", "image_export", exportRequestId);
      const value = await this.readExport(client, workspaceId, exportRequestId);
      await this.remember(client, context, workspaceId, "export.retry", exportRequestId, value);
      return { value, replayed: false };
    });
  }

  async createBundle(context: CommandContext, workspaceId: string, exportRequestId: string): Promise<ExportCommandResult<ExportZipBundle>> {
    return this.transaction(async (client) => {
      const replay = await this.replay<ExportZipBundle>(client, context, workspaceId, "export.bundle");
      if (replay) return { value: replay, replayed: true };
      const completed = await client.query(
        `SELECT output_id,filename,sha256,byte_size FROM image_export_outputs output
         JOIN image_export_requests request USING(export_request_id)
         WHERE request.workspace_id=$1 AND output.export_request_id=$2 AND output.state='succeeded'
         ORDER BY output.output_id`,
        [workspaceId, exportRequestId],
      );
      if (!completed.rowCount) throw new DomainError(409, "bundle-empty", "Complete at least one output before creating a ZIP");
      if (completed.rowCount > 64 || completed.rows.reduce((sum, row) => sum + Number(row["byte_size"]), 0) > 96 * 1024 * 1024) {
        throw new DomainError(413, "bundle-limit-exceeded", "ZIP selection exceeds the safe file count or size limit");
      }
      const bundleId = this.runtime.id("bundle");
      const jobId = this.runtime.id("job");
      const now = this.runtime.now();
      const items = completed.rows.map((row) => ({
        schema_version: PRODUCT_SCHEMA_VERSION,
        output_id: String(row["output_id"]),
        filename: String(row["filename"]),
        sha256: String(row["sha256"]),
        byte_size: Number(row["byte_size"]),
      }));
      const expiresAt = new Date(Date.parse(now) + 7 * 86_400_000).toISOString();
      await client.query(
        `INSERT INTO export_bundles(bundle_id,workspace_id,export_request_id,job_id,state,items,expires_at,created_at)
         VALUES ($1,$2,$3,$4,'queued',$5,$6,$7)`,
        [bundleId, workspaceId, exportRequestId, jobId, JSON.stringify(items), expiresAt, now],
      );
      await this.insertJob(client, context, { jobId, kind: "export_bundle", workspaceId, documentId: null, exportRequestId, bundleId, now });
      await this.evidence(client, context, workspaceId, "export.bundle-requested", "export_bundle", bundleId);
      const value = await this.readBundle(client, workspaceId, bundleId);
      await this.remember(client, context, workspaceId, "export.bundle", bundleId, value);
      return { value, replayed: false };
    });
  }

  async getBundle(actorId: string, workspaceId: string, bundleId: string): Promise<ExportZipBundle | null> {
    const result = await this.pool.query(
      `SELECT 1 FROM export_bundles bundle JOIN memberships membership
       ON membership.workspace_id=bundle.workspace_id AND membership.actor_id=$1
       WHERE bundle.workspace_id=$2 AND bundle.bundle_id=$3`,
      [actorId, workspaceId, bundleId],
    );
    return result.rowCount ? this.readBundle(this.pool, workspaceId, bundleId) : null;
  }

  async delivery(actorId: string, workspaceId: string, outputId: string): Promise<ExportDelivery | null> {
    const result = await this.pool.query(
      `SELECT object.object_key,output.byte_size,output.media_type,output.filename,
              output.sha256,object.storage_generation
       FROM image_export_outputs output JOIN image_export_requests request USING(export_request_id)
       JOIN memberships membership ON membership.workspace_id=request.workspace_id AND membership.actor_id=$1
       JOIN object_references object ON object.object_reference_id=output.object_reference_id AND object.workspace_id=request.workspace_id
       WHERE request.workspace_id=$2 AND output.output_id=$3 AND output.state='succeeded'`,
      [actorId, workspaceId, outputId],
    );
    const row = result.rows[0];
    return row ? { objectKey: String(row["object_key"]), byteSize: Number(row["byte_size"]), mediaType: String(row["media_type"]), filename: String(row["filename"]), sha256: String(row["sha256"]), storageGeneration: String(row["storage_generation"]) } : null;
  }

  async bundleDelivery(actorId: string, workspaceId: string, bundleId: string): Promise<ExportDelivery | null> {
    const result = await this.pool.query(
      `SELECT object.object_key,bundle.byte_size,bundle.sha256,object.storage_generation FROM export_bundles bundle
       JOIN memberships membership ON membership.workspace_id=bundle.workspace_id AND membership.actor_id=$1
       JOIN object_references object ON object.object_reference_id=bundle.object_reference_id AND object.workspace_id=bundle.workspace_id
       WHERE bundle.workspace_id=$2 AND bundle.bundle_id=$3 AND bundle.state='succeeded' AND bundle.expires_at>now()`,
      [actorId, workspaceId, bundleId],
    );
    const row = result.rows[0];
    return row ? { objectKey: String(row["object_key"]), byteSize: Number(row["byte_size"]), mediaType: "application/zip", filename: `export-${bundleId}.zip`, sha256: String(row["sha256"]), storageGeneration: String(row["storage_generation"]) } : null;
  }

  async close(): Promise<void> { await this.pool.end(); }

  private async readRecommendationSet(
    client: Pool | PoolClient,
    actorId: string,
    workspaceId: string,
    row: QueryResultRow,
  ): Promise<RecommendationSet> {
    const result = await client.query(
      `SELECT DISTINCT ON (recommendation_id) recommendation_id,state
       FROM recommendation_decisions
       WHERE workspace_id=$1 AND recommendation_set_id=$2 AND actor_id=$3
       ORDER BY recommendation_id,created_at DESC,decision_id DESC`,
      [workspaceId, row["recommendation_set_id"], actorId],
    );
    return recommendationSet(row, new Map(result.rows.map((item) => [
      String(item["recommendation_id"]),
      String(item["state"]) as SafeRecommendation["state"],
    ])));
  }

  private async readExport(client: Pool | PoolClient, workspaceId: string, exportRequestId: string): Promise<ImageExportRequestRecord> {
    const [requestResult, outputsResult] = await Promise.all([
      client.query("SELECT * FROM image_export_requests WHERE workspace_id=$1 AND export_request_id=$2", [workspaceId, exportRequestId]),
      client.query("SELECT * FROM image_export_outputs WHERE export_request_id=$1 ORDER BY output_id", [exportRequestId]),
    ]);
    const row = requestResult.rows[0];
    if (!row) throw new DomainError(404, "export-not-found", "Export was not found");
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      export_request_id: String(row["export_request_id"]),
      workspace_id: String(row["workspace_id"]),
      document_id: String(row["document_id"]),
      document_version_id: String(row["document_version_id"]),
      recipe_id: String(row["recipe_id"]),
      recipe_version: Number(row["recipe_version"]),
      job_id: String(row["job_id"]),
      outputs: outputsResult.rows.map(output),
      state: String(row["state"]) as ImageExportRequestRecord["state"],
      estimated_size: {
        schema_version: PRODUCT_SCHEMA_VERSION,
        minimum_bytes: Number(row["estimated_min_bytes"]),
        maximum_bytes: Number(row["estimated_max_bytes"]),
        explanation: String(row["estimate_explanation"]),
      },
      zero_charge: true,
      created_by_actor_id: String(row["actor_id"]),
      created_at: instant(row["created_at"] as Date | string)!,
      updated_at: instant(row["updated_at"] as Date | string)!,
    };
  }

  private async readBundle(client: Pool | PoolClient, workspaceId: string, bundleId: string): Promise<ExportZipBundle> {
    const result = await client.query("SELECT * FROM export_bundles WHERE workspace_id=$1 AND bundle_id=$2", [workspaceId, bundleId]);
    const row = result.rows[0];
    if (!row) throw new DomainError(404, "bundle-not-found", "ZIP bundle was not found");
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      bundle_id: String(row["bundle_id"]),
      workspace_id: String(row["workspace_id"]),
      export_request_id: String(row["export_request_id"]),
      job_id: String(row["job_id"]),
      state: String(row["state"]) as ExportZipBundle["state"],
      items: row["items"] as ExportZipBundle["items"],
      object_reference_id: row["object_reference_id"] ? String(row["object_reference_id"]) : null,
      sha256: row["sha256"] ? String(row["sha256"]) : null,
      byte_size: row["byte_size"] === null ? null : Number(row["byte_size"]),
      expires_at: instant(row["expires_at"] as Date | string)!,
      created_at: instant(row["created_at"] as Date | string)!,
    };
  }

  private async readPreview(client: Pool | PoolClient, workspaceId: string, previewId: string): Promise<EnhancementPreview> {
    const result = await client.query(
      `SELECT preview.*,output.state,output.artboard_id,output.object_reference_id,
              output.sha256,output.byte_size,output.width,output.height,output.media_type,
              output.histogram,output.failure_code,output.failure_message
       FROM enhancement_previews preview
       JOIN image_export_outputs output ON output.output_id=preview.output_id
       WHERE preview.workspace_id=$1 AND preview.preview_id=$2`,
      [workspaceId, previewId],
    );
    if (!result.rows[0]) throw new DomainError(404, "enhancement-preview-not-found", "Enhancement preview was not found");
    return enhancementPreview(result.rows[0]);
  }

  private async requireDocument(client: Pool | PoolClient, actorId: string, workspaceId: string, documentId: string): Promise<QueryResultRow> {
    const result = await client.query(
      `SELECT document.*,version.snapshot FROM editor_documents document
       JOIN memberships membership ON membership.workspace_id=document.workspace_id AND membership.actor_id=$1
       JOIN document_versions version ON version.document_version_id=document.current_version_id
       WHERE document.workspace_id=$2 AND document.document_id=$3`,
      [actorId, workspaceId, documentId],
    );
    if (!result.rows[0]) throw new DomainError(404, "document-not-found", "Document was not found");
    return result.rows[0];
  }

  private async assertSourceCapabilities(
    client: Pool | PoolClient,
    workspaceId: string,
    snapshotValue: unknown,
    artboardIds: string[],
    profiles: ExportOutputProfile[],
  ): Promise<void> {
    const snapshot = snapshotValue && typeof snapshotValue === "object" && !Array.isArray(snapshotValue)
      ? snapshotValue as Record<string, unknown>
      : {};
    const sharedAssets = Array.isArray(snapshot["shared_assets"])
      ? snapshot["shared_assets"] as Array<Record<string, unknown>>
      : [];
    const referencedAssetIds = effectiveVisibleRasterAssetIds(snapshot, artboardIds);
    let totalBytes = 0;
    let totalPixels = 0;
    let referencedCount = 0;
    for (const asset of sharedAssets.filter((item) => item["kind"] === "raster"
      && referencedAssetIds.has(String(item["shared_asset_id"])))) {
      const sourceVersionId = typeof asset["source_version_id"] === "string" ? asset["source_version_id"] : "";
      const assetOriginalId = typeof asset["asset_original_id"] === "string" ? asset["asset_original_id"] : "";
      if (!sourceVersionId || !assetOriginalId) {
        throw new DomainError(422, "export-capability-unavailable", "A raster layer has incomplete immutable source identity");
      }
      const facts = await client.query(
        `SELECT orientation,bit_depth,frame_count,width,height,byte_size,media_type,
                has_icc_profile,colour_model FROM source_inspection_facts
         WHERE workspace_id=$1 AND source_version_id=$2 AND asset_original_id=$3`,
        [workspaceId, sourceVersionId, assetOriginalId],
      );
      const row = facts.rows[0];
      if (!row) throw new DomainError(422, "export-capability-unavailable", "A raster layer has no bound inspection evidence");
      const bitDepth = row["bit_depth"] == null ? null : Number(row["bit_depth"]);
      if (bitDepth === null || bitDepth > 8) {
        throw new DomainError(422, "export-capability-unavailable", "High-precision raster sources require a future approved processing path");
      }
      const frameCount = row["frame_count"] == null ? null : Number(row["frame_count"]);
      if (frameCount !== 1) {
        throw new DomainError(422, "export-capability-unavailable", "Animated raster sources are not executable as still-image exports in this build");
      }
      const width = row["width"] == null ? null : Number(row["width"]);
      const height = row["height"] == null ? null : Number(row["height"]);
      const byteSize = Number(row["byte_size"]);
      if (!width || !height || !Number.isSafeInteger(byteSize) || byteSize < 1
        || byteSize > 64 * 1024 * 1024 || width > 12_000 || height > 12_000
        || width * height > 16_000_000) {
        throw new DomainError(413, "export-source-capacity-exceeded", "A raster source exceeds the executable image processing limit");
      }
      if (!["image/jpeg", "image/png", "image/webp", "image/tiff"].includes(String(row["media_type"]))) {
        throw new DomainError(422, "export-capability-unavailable", "A raster source format has no executable export decoder");
      }
      const colourModel = row["colour_model"] == null ? null : String(row["colour_model"]);
      const hasIcc = row["has_icc_profile"] == null ? null : Boolean(row["has_icc_profile"]);
      if (!colourModel || hasIcc === null) {
        throw new DomainError(422, "export-capability-unavailable", "A raster source lacks complete colour inspection evidence");
      }
      if (colourModel === "cmyk" && !hasIcc) {
        throw new DomainError(422, "export-capability-unavailable", "CMYK sources require a validated embedded ICC profile");
      }
      if (profiles.some((profile) => profile.colour_profile === "preserve")
        && (!hasIcc || colourModel !== "rgb")) {
        throw new DomainError(422, "export-capability-unavailable", "Source profile preservation requires one validated RGB ICC profile");
      }
      totalBytes += byteSize;
      totalPixels += width * height;
      referencedCount += 1;
    }
    if (referencedCount !== referencedAssetIds.size) {
      throw new DomainError(422, "export-capability-unavailable", "A raster layer has no bound immutable source facts");
    }
    if (totalBytes > 64 * 1024 * 1024 || totalPixels > 16_000_000) {
      throw new DomainError(413, "export-source-capacity-exceeded", "Combined raster sources exceed the executable image processing limit");
    }
  }

  private async replay<T>(client: PoolClient, context: CommandContext, workspaceId: string, commandName: string): Promise<T | null> {
    const result = await client.query(
      "SELECT command_name,request_hash,response_body FROM export_idempotency_records WHERE workspace_id=$1 AND idempotency_key=$2 FOR UPDATE",
      [workspaceId, context.idempotencyKey],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row["command_name"] !== commandName || row["request_hash"] !== context.requestHash) {
      throw new DomainError(409, "idempotency-conflict", "Idempotency key was already used for another request");
    }
    return row["response_body"] as T;
  }

  private remember(client: PoolClient, context: CommandContext, workspaceId: string, commandName: string, resourceId: string, value: unknown): Promise<unknown> {
    return client.query(
      `INSERT INTO export_idempotency_records(workspace_id,idempotency_key,command_name,request_hash,
       resource_id,response_body,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [workspaceId, context.idempotencyKey, commandName, context.requestHash, resourceId, JSON.stringify(value), this.runtime.now()],
    );
  }

  private async evidence(client: PoolClient, context: CommandContext, workspaceId: string, action: string, resourceKind: string, resourceId: string): Promise<void> {
    const usageId = this.runtime.id("usage");
    await client.query(
      `INSERT INTO audit_events(audit_event_id,workspace_id,actor_id,action,resource_kind,resource_id,occurred_at,trace_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [this.runtime.id("audit"), workspaceId, context.principal.actorId, action, resourceKind, resourceId, this.runtime.now(), context.traceId],
    );
    await client.query(
      `INSERT INTO usage_events(usage_event_id,workspace_id,actor_id,event_kind,customer_amount,credit_debit,currency,occurred_at)
       VALUES ($1,$2,$3,$4,0,0,'USD',$5)`,
      [usageId, workspaceId, context.principal.actorId, action, this.runtime.now()],
    );
    await client.query("INSERT INTO usage_admin_dimensions(usage_event_id,dimensions) VALUES ($1,$2)", [usageId, { capability: "image_enhancement_export", action }]);
  }

  private insertJob(
    client: PoolClient,
    context: CommandContext,
    input: { jobId: string; kind: "image_export" | "export_bundle"; workspaceId: string; documentId: string | null; exportRequestId: string; bundleId: string | null; now: string },
  ): Promise<unknown> {
    return client.query(
      `WITH inserted AS (
         INSERT INTO processing_jobs(job_id,kind,owner_kind,workspace_id,actor_id,guest_session_id,
         upload_session_id,document_id,export_request_id,bundle_id,state,attempt,max_attempts,
         progress_percent,created_at,updated_at)
         VALUES ($1,$2,'actor',$3,$4,NULL,NULL,$5,$6,$7,'queued',0,3,0,$8,$8)
       )
       INSERT INTO job_outbox(outbox_id,job_id,dispatch_kind,payload,trace_id,available_at,created_at)
       VALUES ($9,$1,'process_job',$10,$11,$8,$8)`,
      [input.jobId, input.kind, input.workspaceId, context.principal.actorId, input.documentId,
        input.exportRequestId, input.bundleId, input.now, this.runtime.id("outbox"),
        { job_id: input.jobId }, context.traceId],
    );
  }

  private processingRecommendation(title: string, explanation: string, evidence: string, operation: ImageOperation): SafeRecommendation {
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      recommendation_id: this.runtime.id("recommendation"),
      title,
      explanation,
      evidence: [{ schema_version: PRODUCT_SCHEMA_VERSION, kind: "measured", explanation: evidence }],
      target_kind: "processing_operation",
      operation,
      metadata_policy: null,
      state: "proposed",
    };
  }

  private warningRecommendation(title: string, explanation: string, evidence: string): SafeRecommendation {
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      recommendation_id: this.runtime.id("recommendation"),
      title,
      explanation,
      evidence: [{ schema_version: PRODUCT_SCHEMA_VERSION, kind: "measured", explanation: evidence }],
      target_kind: "output_warning",
      operation: null,
      metadata_policy: null,
      state: "proposed",
    };
  }

  private estimatePixels(width: number, height: number, profile: SubmitExportInput["outputs"][number]["profile"]): number {
    if (profile.width || profile.height) {
      const nextWidth = profile.width ?? Math.round(width * Number(profile.height) / height);
      const nextHeight = profile.height ?? Math.round(height * Number(profile.width) / width);
      return nextWidth * nextHeight;
    }
    if (profile.percentage) return width * height * (profile.percentage / 100) ** 2;
    if ((profile.physical_width || profile.physical_height) && profile.ppi && profile.physical_unit) {
      const factor = profile.physical_unit === "in" ? 1 : profile.physical_unit === "cm" ? 1 / 2.54 : 1 / 25.4;
      const requestedWidth = profile.physical_width ? Math.ceil(profile.physical_width * factor * profile.ppi) : null;
      const requestedHeight = profile.physical_height ? Math.ceil(profile.physical_height * factor * profile.ppi) : null;
      const nextWidth = requestedWidth ?? Math.round(width * Number(requestedHeight) / height);
      const nextHeight = requestedHeight ?? Math.round(height * Number(requestedWidth) / width);
      return nextWidth * nextHeight;
    }
    return width * height;
  }

  private async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await callback(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
