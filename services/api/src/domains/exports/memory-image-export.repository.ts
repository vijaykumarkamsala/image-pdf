import { createHash } from "node:crypto";
import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import type {
  BatchGroupRecord,
  BatchItemRecord,
  BatchPlan,
  BatchReport,
  BatchRunRecord,
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
import { batchGroupId, batchOutputCompatibility, stableBatchDigest } from "./batch-validation.js";
import type {
  BatchCreateInput,
  BatchPlanInput,
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
  private readonly batches = new Map<string, BatchRunRecord>();
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
      : {
        ...value,
        state: "cancelled" as const,
        outputs: value.outputs.map((output) => ["queued", "running"].includes(output.state)
          ? { ...output, state: "cancelled" as const, progress_percent: 100 }
          : output),
        updated_at: this.runtime.now(),
      };
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

  async planBatch(_actorId: string, input: BatchPlanInput): Promise<BatchPlan> {
    const groupInputs = new Map<string, typeof input.items>();
    const groupIds = new Map<string, string>();
    const recipes = new Map<string, ProcessingRecipeRecord>();
    for (const item of input.items) {
      const selectedRecipe = await this.getRecipe("", input.workspaceId, item.recipeId, item.recipeVersion);
      if (!selectedRecipe || selectedRecipe.document_id !== item.documentId) {
        throw new DomainError(404, "recipe-not-found", `The selected recipe for ${item.displayName} was not found`);
      }
      recipes.set(item.clientItemId, selectedRecipe);
      if (!item.included) continue;
      const compatibility = batchCompatibility(item, selectedRecipe);
      const values = groupInputs.get(compatibility) ?? [];
      values.push(item);
      groupInputs.set(compatibility, values);
      groupIds.set(compatibility, batchGroupId(compatibility));
    }
    const groups = [...groupInputs.entries()].map(([compatibility, items]) => ({
      schema_version: PRODUCT_SCHEMA_VERSION,
      group_id: groupIds.get(compatibility)!,
      compatibility_sha256: compatibility,
      label: batchGroupLabel(items[0]!),
      client_item_ids: items.map((item) => item.clientItemId),
      representative_client_item_id: items[0]!.clientItemId,
      representative_preview_id: null,
      exception_count: 0,
    }));
    const items = input.items.map((item) => {
      const compatibility = item.included ? batchCompatibility(item, recipes.get(item.clientItemId)!) : null;
      return {
        schema_version: PRODUCT_SCHEMA_VERSION,
        client_item_id: item.clientItemId,
        group_id: compatibility ? groupIds.get(compatibility)! : null,
        included: item.included,
        requires_individual_confirmation: false,
        confirmation_state: "not_required" as const,
        exception_codes: [],
      };
    });
    const planShape = { workspace_id: input.workspaceId, name: input.name, items, groups };
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      plan_sha256: stableBatchDigest(planShape),
      name: input.name,
      items,
      groups,
      included_count: input.items.filter((item) => item.included).length,
      excluded_count: input.items.filter((item) => !item.included).length,
    };
  }

  async submitBatch(context: CommandContext, input: BatchCreateInput): Promise<ExportCommandResult<BatchRunRecord>> {
    const replay = this.replay<BatchRunRecord>(context);
    if (replay) return replay;
    const plan = await this.planBatch(context.principal.actorId, input);
    assertApprovedPlan(plan, input);
    const batchId = this.runtime.id("batch");
    const now = this.runtime.now();
    const approvalByGroup = new Map(input.groupApprovals.map((approval) => [approval.group_id, approval]));
    const batchItemIds = new Map(input.items.map((item) => [item.clientItemId, this.runtime.id("batch-item")]));
    const planItems = new Map(plan.items.map((item) => [item.client_item_id, item]));
    const items: BatchItemRecord[] = [];
    for (const [position, item] of input.items.entries()) {
      const planned = planItems.get(item.clientItemId)!;
      let exportRequest: ImageExportRequestRecord | null = null;
      if (item.included) {
        exportRequest = (await this.submit(
          childContext(context, item.clientItemId, "batch.item.submit", item),
          {
            workspaceId: input.workspaceId,
            documentId: item.documentId,
            documentVersionId: item.documentVersionId,
            recipeId: item.recipeId,
            recipeVersion: item.recipeVersion,
            outputs: item.outputs,
          },
        )).value;
      }
      items.push({
        schema_version: PRODUCT_SCHEMA_VERSION,
        batch_item_id: batchItemIds.get(item.clientItemId)!,
        batch_id: batchId,
        client_item_id: item.clientItemId,
        position,
        display_name: item.displayName,
        document_id: item.documentId,
        document_version_id: item.documentVersionId,
        recipe_id: item.recipeId,
        recipe_version: item.recipeVersion,
        group_id: planned.group_id,
        included: item.included,
        exclusion_reason: item.exclusionReason,
        requires_individual_confirmation: planned.requires_individual_confirmation,
        confirmation_state: planned.requires_individual_confirmation ? "confirmed" : "not_required",
        exception_codes: planned.exception_codes,
        export_request_id: exportRequest?.export_request_id ?? null,
        job_id: exportRequest?.job_id ?? null,
        state: item.included ? "queued" : "excluded",
        progress_percent: item.included ? 0 : 100,
        output_count: exportRequest?.outputs.length ?? 0,
        succeeded_output_count: 0,
        failed_output_count: 0,
        cancelled_output_count: 0,
        failure_code: null,
        failure_message: null,
        last_checkpoint_key: null,
        updated_at: now,
      });
    }
    const groups: BatchGroupRecord[] = plan.groups.map((group) => ({
      schema_version: PRODUCT_SCHEMA_VERSION,
      group_id: group.group_id,
      batch_id: batchId,
      compatibility_sha256: group.compatibility_sha256,
      label: group.label,
      item_count: group.client_item_ids.length,
      representative_item_id: batchItemIds.get(group.representative_client_item_id)!,
      representative_preview_id: approvalByGroup.get(group.group_id)!.representative_preview_id,
      exception_count: group.exception_count,
    }));
    const value = summarizeBatch({
      schema_version: PRODUCT_SCHEMA_VERSION,
      batch_id: batchId,
      workspace_id: input.workspaceId,
      name: input.name,
      plan_sha256: plan.plan_sha256,
      state: "queued",
      items,
      groups,
      item_count: items.length,
      included_count: items.filter((item) => item.included).length,
      excluded_count: items.filter((item) => !item.included).length,
      queued_count: 0,
      running_count: 0,
      succeeded_count: 0,
      failed_count: 0,
      cancelled_count: 0,
      cancellation_requested: false,
      zero_charge: true,
      created_by_actor_id: context.principal.actorId,
      created_at: now,
      updated_at: now,
    });
    this.batches.set(batchId, value);
    this.remember(context, value);
    return { value, replayed: false };
  }

  async listBatches(_actorId: string, workspaceId: string): Promise<BatchRunRecord[]> {
    return [...this.batches.values()]
      .filter((batch) => batch.workspace_id === workspaceId)
      .map((batch) => this.refreshBatch(batch))
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
      .slice(0, 50);
  }

  async getBatch(_actorId: string, workspaceId: string, batchId: string): Promise<BatchRunRecord | null> {
    const batch = this.batches.get(batchId);
    return batch?.workspace_id === workspaceId ? this.refreshBatch(batch) : null;
  }

  async cancelBatch(context: CommandContext, workspaceId: string, batchId: string): Promise<ExportCommandResult<BatchRunRecord>> {
    const replay = this.replay<BatchRunRecord>(context);
    if (replay) return replay;
    const batch = await this.getBatch(context.principal.actorId, workspaceId, batchId);
    if (!batch) throw new DomainError(404, "batch-not-found", "Batch was not found");
    for (const item of batch.items.filter((value) => value.export_request_id
      && ["queued", "running"].includes(value.state))) {
      await this.cancel(
        childContext(context, item.batch_item_id, "batch.item.cancel", item),
        workspaceId,
        item.export_request_id!,
      );
    }
    const value = this.refreshBatch({
      ...batch,
      cancellation_requested: true,
      updated_at: this.runtime.now(),
    });
    this.batches.set(batchId, value);
    this.remember(context, value);
    return { value, replayed: false };
  }

  async retryBatch(context: CommandContext, workspaceId: string, batchId: string): Promise<ExportCommandResult<BatchRunRecord>> {
    const replay = this.replay<BatchRunRecord>(context);
    if (replay) return replay;
    const batch = await this.getBatch(context.principal.actorId, workspaceId, batchId);
    if (!batch) throw new DomainError(404, "batch-not-found", "Batch was not found");
    const failed = batch.items.filter((item) => item.state === "failed" && item.export_request_id);
    if (!failed.length) throw new DomainError(409, "batch-retry-unavailable", "No failed batch items are eligible for retry");
    for (const item of failed) {
      await this.retry(
        childContext(context, item.batch_item_id, "batch.item.retry", item),
        workspaceId,
        item.export_request_id!,
      );
    }
    const value = this.refreshBatch({ ...batch, cancellation_requested: false, updated_at: this.runtime.now() });
    this.batches.set(batchId, value);
    this.remember(context, value);
    return { value, replayed: false };
  }

  async batchReport(actorId: string, workspaceId: string, batchId: string): Promise<BatchReport | null> {
    const batch = await this.getBatch(actorId, workspaceId, batchId);
    if (!batch) return null;
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      batch_id: batch.batch_id,
      workspace_id: batch.workspace_id,
      name: batch.name,
      state: batch.state,
      item_count: batch.item_count,
      queued_count: batch.queued_count,
      running_count: batch.running_count,
      succeeded_count: batch.succeeded_count,
      failed_count: batch.failed_count,
      cancelled_count: batch.cancelled_count,
      excluded_count: batch.excluded_count,
      groups: batch.groups.map((group) => batchGroupReport(batch, group)),
      items: batch.items.map((item) => ({
        schema_version: PRODUCT_SCHEMA_VERSION,
        batch_item_id: item.batch_item_id,
        client_item_id: item.client_item_id,
        group_id: item.group_id,
        display_name: item.display_name,
        state: item.state,
        exception_codes: item.exception_codes,
        outputs: item.export_request_id ? (this.exports.get(item.export_request_id)?.outputs ?? []).map((output) => ({
          schema_version: PRODUCT_SCHEMA_VERSION,
          output_id: output.output_id,
          filename: output.filename,
          state: output.state,
          sha256: output.sha256 ?? null,
          byte_size: output.byte_size ?? null,
          failure_code: output.failure_code ?? null,
          failure_message: output.failure_message ?? null,
        })) : [],
      })),
      generated_at: this.runtime.now(),
    };
  }

  async close(): Promise<void> {}

  private refreshBatch(batch: BatchRunRecord): BatchRunRecord {
    return summarizeBatch({
      ...batch,
      items: batch.items.map((item) => {
        const request = item.export_request_id ? this.exports.get(item.export_request_id) : null;
        return request ? batchItemFromExport(item, request) : item;
      }),
    });
  }

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

function batchCompatibility(
  item: BatchPlanInput["items"][number],
  recipe: ProcessingRecipeRecord,
): string {
  return stableBatchDigest({
    operations: recipe.operations,
    outputs: item.outputs.map((output) => batchOutputCompatibility(output.profile)),
  });
}

function batchGroupLabel(item: BatchPlanInput["items"][number]): string {
  const formats = [...new Set(item.outputs.map((output) => output.profile.format.toUpperCase()))];
  return `${formats.join(" + ")} · ${item.outputs.length} ${item.outputs.length === 1 ? "output" : "outputs"}`;
}

function assertApprovedPlan(plan: BatchPlan, input: BatchCreateInput): void {
  if (plan.plan_sha256 !== input.planSha256) {
    throw new DomainError(409, "batch-plan-changed", "Batch settings changed after review; review the refreshed plan");
  }
  const approvals = new Map(input.groupApprovals.map((approval) => [approval.group_id, approval]));
  if (approvals.size !== plan.groups.length || plan.groups.some((group) => {
    const approval = approvals.get(group.group_id);
    return !approval || approval.representative_client_item_id !== group.representative_client_item_id;
  })) {
    throw new DomainError(409, "batch-approval-incomplete", "Approve the representative preview for every batch group");
  }
  const required = plan.items
    .filter((item) => item.requires_individual_confirmation)
    .map((item) => item.client_item_id)
    .sort();
  const confirmed = [...input.confirmedClientItemIds].sort();
  if (required.length !== confirmed.length || required.some((item, index) => item !== confirmed[index])) {
    throw new DomainError(409, "batch-item-confirmation-incomplete", "Confirm every batch item with a surfaced exception");
  }
}

function childContext(context: CommandContext, identity: string, command: string, payload: unknown): CommandContext {
  return {
    ...context,
    idempotencyKey: `${context.idempotencyKey}-${identity}`.slice(0, 200),
    requestHash: stableBatchDigest({ command, payload }),
  };
}

function batchItemFromExport(item: BatchItemRecord, request: ImageExportRequestRecord): BatchItemRecord {
  const state = request.state === "completed" ? "succeeded"
    : request.state === "partially_completed" ? "failed"
      : request.state;
  const failure = request.outputs.find((output) => output.state === "failed");
  return {
    ...item,
    job_id: request.job_id,
    state,
    progress_percent: request.outputs.length
      ? Math.floor(request.outputs.reduce((sum, output) => sum + output.progress_percent, 0) / request.outputs.length)
      : 0,
    output_count: request.outputs.length,
    succeeded_output_count: request.outputs.filter((output) => output.state === "succeeded").length,
    failed_output_count: request.outputs.filter((output) => output.state === "failed").length,
    cancelled_output_count: request.outputs.filter((output) => output.state === "cancelled").length,
    failure_code: failure?.failure_code ?? null,
    failure_message: failure?.failure_message ?? null,
    updated_at: request.updated_at,
  };
}

function summarizeBatch(batch: BatchRunRecord): BatchRunRecord {
  const count = (state: BatchItemRecord["state"]) => batch.items.filter((item) => item.state === state).length;
  const excluded = count("excluded");
  const queued = count("queued");
  const running = count("running");
  const succeeded = count("succeeded");
  const failed = count("failed");
  const cancelled = count("cancelled");
  const state = running > 0 || (queued > 0 && succeeded + failed + cancelled > 0) ? "running"
    : queued > 0 ? "queued"
      : succeeded === batch.items.length - excluded ? "completed"
        : succeeded > 0 ? "partially_completed"
          : failed > 0 ? "failed"
            : "cancelled";
  return {
    ...batch,
    state,
    item_count: batch.items.length,
    included_count: batch.items.length - excluded,
    excluded_count: excluded,
    queued_count: queued,
    running_count: running,
    succeeded_count: succeeded,
    failed_count: failed,
    cancelled_count: cancelled,
  };
}

function batchGroupReport(
  batch: BatchRunRecord,
  group: BatchRunRecord["groups"][number],
): BatchReport["groups"][number] {
  const items = batch.items.filter((item) => item.group_id === group.group_id);
  const count = (state: BatchItemRecord["state"]): number => items.filter((item) => item.state === state).length;
  return {
    schema_version: PRODUCT_SCHEMA_VERSION,
    group_id: group.group_id,
    label: group.label,
    compatibility_sha256: group.compatibility_sha256,
    representative_item_id: group.representative_item_id,
    representative_preview_id: group.representative_preview_id!,
    item_count: items.length,
    queued_count: count("queued"),
    running_count: count("running"),
    succeeded_count: count("succeeded"),
    failed_count: count("failed"),
    cancelled_count: count("cancelled"),
    exception_count: group.exception_count,
  };
}
