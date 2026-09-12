import { createHash } from "node:crypto";
import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import type {
  EnhancementPreview,
  ExportZipBundle,
  ImageExportRequestRecord,
  ProcessingRecipeRecord,
  RecommendationDecision,
  RecommendationSet,
} from "ipw-contracts-ts/product";

import { DomainError } from "../../kernel/errors.js";
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

export class MemoryImageExportRepository implements ImageExportRepository {
  readonly recordsMutationsAtomically = false;
  private readonly recipes = new Map<string, ProcessingRecipeRecord[]>();
  private readonly recommendations = new Map<string, RecommendationSet>();
  private readonly recommendationDecisions = new Map<string, "accepted" | "declined">();
  private readonly exports = new Map<string, ImageExportRequestRecord>();
  private readonly bundles = new Map<string, ExportZipBundle>();
  private readonly previews = new Map<string, EnhancementPreview>();
  private readonly commands = new Map<string, { hash: string; value: unknown }>();

  constructor(private readonly runtime: RuntimeValues) {}

  async createRecipe(context: CommandContext, input: RecipeInput): Promise<ExportCommandResult<ProcessingRecipeRecord>> {
    const replay = this.replay<ProcessingRecipeRecord>(context);
    if (replay) return replay;
    const recipeId = input.recipeId ?? this.runtime.id("recipe");
    const key = `${input.workspaceId}:${recipeId}`;
    const existing = this.recipes.get(key) ?? [];
    const value: ProcessingRecipeRecord = {
      schema_version: PRODUCT_SCHEMA_VERSION,
      recipe_id: recipeId,
      workspace_id: input.workspaceId,
      document_id: input.documentId,
      version: existing.length + 1,
      name: input.name,
      operations: input.operations,
      deterministic: true,
      created_by_actor_id: context.principal.actorId,
      created_at: this.runtime.now(),
      updated_at: this.runtime.now(),
    };
    this.recipes.set(key, [...existing, value]);
    this.remember(context, value);
    return { value, replayed: false };
  }

  async listRecipes(_actorId: string, workspaceId: string, documentId: string): Promise<ProcessingRecipeRecord[]> {
    return [...this.recipes.values()].flat().filter((item) => item.workspace_id === workspaceId && item.document_id === documentId);
  }

  async getRecipe(_actorId: string, workspaceId: string, recipeId: string, version?: number): Promise<ProcessingRecipeRecord | null> {
    const values = this.recipes.get(`${workspaceId}:${recipeId}`) ?? [];
    return (version ? values.find((item) => item.version === version) : values.at(-1)) ?? null;
  }

  async recommend(context: CommandContext, input: RecommendationInput): Promise<ExportCommandResult<RecommendationSet>> {
    const replay = this.replay<RecommendationSet>(context);
    if (replay) return replay;
    const existing = [...this.recommendations.values()].find((item) => item.workspace_id === input.workspaceId
      && item.document_id === input.documentId
      && item.document_version_id === input.documentVersionId
      && item.intended_outcome === input.intendedOutcome);
    if (existing) {
      const value = this.projectRecommendationDecisions(existing, context.principal.actorId);
      this.remember(context, value);
      return { value, replayed: true };
    }
    const value: RecommendationSet = {
      schema_version: PRODUCT_SCHEMA_VERSION,
      recommendation_set_id: this.runtime.id("recommendations"),
      workspace_id: input.workspaceId,
      document_id: input.documentId,
      document_version_id: input.documentVersionId,
      intended_outcome: input.intendedOutcome,
      intended_outcome_required: input.intendedOutcome === null,
      source_facts_summary: ["No immutable source facts are available in the deterministic memory adapter."],
      recommendations: [],
      no_correction_needed: true,
      created_at: this.runtime.now(),
    };
    this.recommendations.set(value.recommendation_set_id, value);
    this.remember(context, value);
    return { value, replayed: false };
  }

  async decideRecommendations(context: CommandContext, input: RecommendationDecisionInput): Promise<ExportCommandResult<RecommendationDecision[]>> {
    const replay = this.replay<RecommendationDecision[]>(context);
    if (replay) return replay;
    const set = this.recommendations.get(input.recommendationSetId);
    if (!set || set.workspace_id !== input.workspaceId) throw new DomainError(404, "recommendation-set-not-found", "Recommendation set was not found");
    const available = new Set(set.recommendations.map((item) => item.recommendation_id));
    if (!input.decisions.length || input.decisions.some((item) => !available.has(item.recommendationId))) {
      throw new DomainError(400, "recommendation-decision-invalid", "Every decision must reference this recommendation set");
    }
    const values = input.decisions.map((decision): RecommendationDecision => ({
      schema_version: PRODUCT_SCHEMA_VERSION,
      decision_id: this.runtime.id("recommendation-decision"),
      workspace_id: input.workspaceId,
      recommendation_set_id: input.recommendationSetId,
      recommendation_id: decision.recommendationId,
      actor_id: context.principal.actorId,
      state: decision.state,
      created_at: this.runtime.now(),
    }));
    for (const value of values) {
      this.recommendationDecisions.set(
        `${value.recommendation_set_id}:${value.actor_id}:${value.recommendation_id}`,
        value.state,
      );
    }
    this.remember(context, values);
    return { value: values, replayed: false };
  }

  async createPreview(context: CommandContext, input: PreviewInput): Promise<ExportCommandResult<EnhancementPreview>> {
    const replay = this.replay<EnhancementPreview>(context);
    if (replay) return replay;
    const recipe = await this.getRecipe(context.principal.actorId, input.workspaceId, input.recipeId, input.recipeVersion ?? undefined);
    if (!recipe || recipe.workspace_id !== input.workspaceId || recipe.document_id !== input.documentId) {
      throw new DomainError(404, "recipe-not-found", "Recipe was not found");
    }
    const value: EnhancementPreview = {
      schema_version: PRODUCT_SCHEMA_VERSION,
      preview_id: this.runtime.id("enhancement-preview"),
      document_id: input.documentId,
      document_version_id: "version-local-preview",
      recipe_id: recipe.recipe_id,
      recipe_version: recipe.version,
      mode: input.mode,
      state: "failed",
      export_request_id: this.runtime.id("preview-export"),
      output_id: this.runtime.id("preview-output"),
      artboard_id: input.artboardId ?? "artboard-local-preview",
      proxy: false,
      authoritative: true,
      quality_label: "Authoritative registered preview rendered from the immutable document version",
      width: 1200,
      height: 900,
      histogram: null,
      object_reference_id: null,
      sha256: null,
      byte_size: null,
      media_type: null,
      failure_code: "durable-preview-required",
      failure_message: "Authoritative previews require the PostgreSQL and worker runtime",
      created_at: this.runtime.now(),
    };
    this.previews.set(value.preview_id, value);
    this.remember(context, value);
    return { value, replayed: false };
  }

  async getPreview(_actorId: string, workspaceId: string, previewId: string): Promise<EnhancementPreview | null> {
    const value = this.previews.get(previewId);
    return value && value.document_id && workspaceId ? value : null;
  }

  async submit(context: CommandContext, input: SubmitExportInput): Promise<ExportCommandResult<ImageExportRequestRecord>> {
    const replay = this.replay<ImageExportRequestRecord>(context);
    if (replay) return replay;
    const exportId = this.runtime.id("export");
    const now = this.runtime.now();
    const value: ImageExportRequestRecord = {
      schema_version: PRODUCT_SCHEMA_VERSION,
      export_request_id: exportId,
      workspace_id: input.workspaceId,
      document_id: input.documentId,
      document_version_id: input.documentVersionId,
      recipe_id: input.recipeId,
      recipe_version: input.recipeVersion,
      job_id: this.runtime.id("job"),
      outputs: input.outputs.map((item) => ({
        schema_version: PRODUCT_SCHEMA_VERSION,
        output_id: this.runtime.id("output"),
        export_request_id: exportId,
        artboard_id: item.artboardId,
        profile: item.profile,
        state: "queued",
        progress_percent: 0,
        filename: item.filename,
        object_reference_id: null,
        sha256: null,
        byte_size: null,
        width: null,
        height: null,
        media_type: null,
        failure_code: null,
        failure_message: null,
        completed_at: null,
      })),
      state: "queued",
      estimated_size: { schema_version: PRODUCT_SCHEMA_VERSION, minimum_bytes: 0, maximum_bytes: 0, explanation: "Calculated by the durable worker after decode" },
      zero_charge: true,
      created_by_actor_id: context.principal.actorId,
      created_at: now,
      updated_at: now,
    };
    this.exports.set(exportId, value);
    this.remember(context, value);
    return { value, replayed: false };
  }

  async list(_actorId: string, workspaceId: string, documentId?: string): Promise<ImageExportRequestRecord[]> {
    return [...this.exports.values()].filter((item) => item.workspace_id === workspaceId && (!documentId || item.document_id === documentId));
  }

  async get(_actorId: string, workspaceId: string, exportRequestId: string): Promise<ImageExportRequestRecord | null> {
    const value = this.exports.get(exportRequestId);
    return value?.workspace_id === workspaceId ? value : null;
  }

  async cancel(context: CommandContext, workspaceId: string, exportRequestId: string): Promise<ExportCommandResult<ImageExportRequestRecord>> {
    const replay = this.replay<ImageExportRequestRecord>(context);
    if (replay) return replay;
    const value = await this.get("", workspaceId, exportRequestId);
    if (!value) throw new DomainError(404, "export-not-found", "Export was not found");
    const updated = ["completed", "partially_completed", "failed", "cancelled"].includes(value.state)
      ? value
      : { ...value, state: "cancelled" as const, updated_at: this.runtime.now() };
    this.exports.set(exportRequestId, updated);
    this.remember(context, updated);
    return { value: updated, replayed: false };
  }

  async retry(context: CommandContext, workspaceId: string, exportRequestId: string): Promise<ExportCommandResult<ImageExportRequestRecord>> {
    const replay = this.replay<ImageExportRequestRecord>(context);
    if (replay) return replay;
    const current = await this.get(context.principal.actorId, workspaceId, exportRequestId);
    if (!current) throw new DomainError(404, "export-not-found", "Export was not found");
    if (!["failed", "partially_completed"].includes(current.state)
      || !current.outputs.some((item) => item.state === "failed")) {
      throw new DomainError(409, "export-retry-unavailable", "No terminal failed outputs are eligible for retry");
    }
    const value = { ...current, state: "queued" as const, updated_at: this.runtime.now(), outputs: current.outputs.map((item) => item.state === "failed" ? { ...item, state: "queued" as const, progress_percent: 0 } : item) };
    this.exports.set(exportRequestId, value);
    this.remember(context, value);
    return { value, replayed: false };
  }

  async createBundle(context: CommandContext, workspaceId: string, exportRequestId: string): Promise<ExportCommandResult<ExportZipBundle>> {
    const replay = this.replay<ExportZipBundle>(context);
    if (replay) return replay;
    const bundleId = this.runtime.id("bundle");
    const value: ExportZipBundle = {
      schema_version: PRODUCT_SCHEMA_VERSION,
      bundle_id: bundleId,
      workspace_id: workspaceId,
      export_request_id: exportRequestId,
      job_id: this.runtime.id("job"),
      state: "queued",
      items: [],
      object_reference_id: null,
      sha256: null,
      byte_size: null,
      expires_at: new Date(Date.parse(this.runtime.now()) + 7 * 86_400_000).toISOString(),
      created_at: this.runtime.now(),
    };
    this.bundles.set(bundleId, value);
    this.remember(context, value);
    return { value, replayed: false };
  }

  async getBundle(_actorId: string, workspaceId: string, bundleId: string): Promise<ExportZipBundle | null> {
    const value = this.bundles.get(bundleId);
    return value?.workspace_id === workspaceId ? value : null;
  }

  async delivery(): Promise<ExportDelivery | null> { return null; }
  async bundleDelivery(): Promise<ExportDelivery | null> { return null; }
  async close(): Promise<void> {}

  private projectRecommendationDecisions(value: RecommendationSet, actorId: string): RecommendationSet {
    return {
      ...value,
      recommendations: value.recommendations.map((item) => ({
        ...item,
        state: this.recommendationDecisions.get(
          `${value.recommendation_set_id}:${actorId}:${item.recommendation_id}`,
        ) ?? item.state,
      })),
    };
  }

  private replay<T>(context: CommandContext): ExportCommandResult<T> | null {
    const prior = this.commands.get(context.idempotencyKey);
    if (!prior) return null;
    if (prior.hash !== context.requestHash) throw new DomainError(409, "idempotency-conflict", "Idempotency key was already used for another request");
    return { value: prior.value as T, replayed: true };
  }

  private remember(context: CommandContext, value: unknown): void {
    this.commands.set(context.idempotencyKey, { hash: context.requestHash, value });
  }
}

export function stableParametersDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
