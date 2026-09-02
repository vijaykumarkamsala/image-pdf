import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import type {
  EnhancementPreview,
  ExportOutputRecord,
  ExportZipBundle,
  ImageExportRequestRecord,
  ImageOperation,
  MetadataPolicy,
  ProcessingRecipeRecord,
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
  RecipeInput,
  RecommendationInput,
  SubmitExportInput,
} from "./exports.types.js";

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
    failure_code: row["failure_code"] ? String(row["failure_code"]) : null,
    failure_message: row["failure_message"] ? String(row["failure_message"]) : null,
    completed_at: instant(row["completed_at"] as Date | string | null),
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
        recommendations.push(this.processingRecommendation(
          "Normalize orientation",
          "Apply the source orientation once so preview and export remain aligned.",
          "The verified source contains an EXIF orientation transform.",
          {
            schema_version: PRODUCT_SCHEMA_VERSION,
            operation_id: this.runtime.id("operation"),
            kind: "orientation_normalize",
            order: recommendations.length,
            enabled: true,
            parameters: { schema_version: PRODUCT_SCHEMA_VERSION, source_orientation: orientation, apply_exactly_once: true },
          },
        ));
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

  async preview(
    actorId: string,
    workspaceId: string,
    documentId: string,
    value: ProcessingRecipeRecord,
    mode: EnhancementPreview["mode"],
  ): Promise<EnhancementPreview> {
    const result = await this.pool.query(
      `SELECT document.current_version_id,version.snapshot->'artboards'->0 AS artboard
       FROM editor_documents document
       JOIN memberships membership ON membership.workspace_id=document.workspace_id AND membership.actor_id=$1
       JOIN document_versions version ON version.document_version_id=document.current_version_id
       WHERE document.workspace_id=$2 AND document.document_id=$3`,
      [actorId, workspaceId, documentId],
    );
    const row = result.rows[0];
    if (!row || value.workspace_id !== workspaceId || value.document_id !== documentId) {
      throw new DomainError(404, "document-not-found", "Document was not found");
    }
    const artboard = row["artboard"] as { width?: number; height?: number } | null;
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      preview_id: this.runtime.id("enhancement-preview"),
      document_id: documentId,
      document_version_id: String(row["current_version_id"]),
      recipe_id: value.recipe_id,
      recipe_version: value.version,
      mode,
      proxy: true,
      quality_label: "Interactive proxy; final output is rendered by a durable worker",
      width: Math.max(1, Math.round(artboard?.width ?? 1)),
      height: Math.max(1, Math.round(artboard?.height ?? 1)),
      histogram: null,
      created_at: this.runtime.now(),
    };
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
      if (!["completed", "failed", "cancelled"].includes(String(row["state"]))) {
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
      if (completed.rowCount > 64 || completed.rows.reduce((sum, row) => sum + Number(row["byte_size"]), 0) > 1_073_741_824) {
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
      `SELECT object.object_key,output.byte_size,output.media_type,output.filename
       FROM image_export_outputs output JOIN image_export_requests request USING(export_request_id)
       JOIN memberships membership ON membership.workspace_id=request.workspace_id AND membership.actor_id=$1
       JOIN object_references object ON object.object_reference_id=output.object_reference_id AND object.workspace_id=request.workspace_id
       WHERE request.workspace_id=$2 AND output.output_id=$3 AND output.state='succeeded'`,
      [actorId, workspaceId, outputId],
    );
    const row = result.rows[0];
    return row ? { objectKey: String(row["object_key"]), byteSize: Number(row["byte_size"]), mediaType: String(row["media_type"]), filename: String(row["filename"]) } : null;
  }

  async bundleDelivery(actorId: string, workspaceId: string, bundleId: string): Promise<ExportDelivery | null> {
    const result = await this.pool.query(
      `SELECT object.object_key,bundle.byte_size FROM export_bundles bundle
       JOIN memberships membership ON membership.workspace_id=bundle.workspace_id AND membership.actor_id=$1
       JOIN object_references object ON object.object_reference_id=bundle.object_reference_id AND object.workspace_id=bundle.workspace_id
       WHERE bundle.workspace_id=$2 AND bundle.bundle_id=$3 AND bundle.state='succeeded' AND bundle.expires_at>now()`,
      [actorId, workspaceId, bundleId],
    );
    const row = result.rows[0];
    return row ? { objectKey: String(row["object_key"]), byteSize: Number(row["byte_size"]), mediaType: "application/zip", filename: `export-${bundleId}.zip` } : null;
  }

  async close(): Promise<void> { await this.pool.end(); }

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
    if (profile.width && profile.height) return profile.width * profile.height;
    if (profile.percentage) return width * height * (profile.percentage / 100) ** 2;
    if (profile.physical_width && profile.physical_height && profile.ppi && profile.physical_unit) {
      const factor = profile.physical_unit === "in" ? 1 : profile.physical_unit === "cm" ? 1 / 2.54 : 1 / 25.4;
      return Math.ceil(profile.physical_width * factor * profile.ppi) * Math.ceil(profile.physical_height * factor * profile.ppi);
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
