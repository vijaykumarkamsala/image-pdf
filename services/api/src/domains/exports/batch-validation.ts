import { createHash } from "node:crypto";
import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import type { BatchGroupApproval, ExportOutputProfile } from "ipw-contracts-ts/product";

import { DomainError, requireId, requireText } from "../../kernel/errors.js";
import { requireExportOutputs } from "./enhancement-validation.js";
import type { BatchCreateInput, BatchPlanInput, BatchSubmissionInputItem } from "./exports.types.js";

type Body = Record<string, unknown>;

const BATCH_ITEM_LIMIT = 50;
const OUTPUT_LIMIT = 64;
const BATCH_OUTPUT_LIMIT = 200;

export function requireBatchPlanInput(body: Body, workspaceId: string): BatchPlanInput {
  return {
    workspaceId,
    name: requireText(body["name"], "batch name", 200),
    items: requireBatchItems(body["items"]),
  };
}

export function requireBatchCreateInput(body: Body, workspaceId: string): BatchCreateInput {
  const input = requireBatchPlanInput(body, workspaceId);
  const planSha256 = body["plan_sha256"];
  if (typeof planSha256 !== "string" || !/^[0-9a-f]{64}$/.test(planSha256)) {
    throw invalid("A valid reviewed batch plan digest is required");
  }
  const rawApprovals = body["group_approvals"];
  if (!Array.isArray(rawApprovals) || rawApprovals.length < 1 || rawApprovals.length > BATCH_ITEM_LIMIT) {
    throw invalid("Approve every compatible group before starting the batch");
  }
  const groupApprovals = rawApprovals.map((value): BatchGroupApproval => {
    const approval = object(value, "batch group approval");
    if (approval["confirmation_state"] !== "confirmed") {
      throw invalid("Every batch group requires explicit preview confirmation");
    }
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      group_id: requireId(approval["group_id"], "batch group id"),
      representative_client_item_id: requireId(
        approval["representative_client_item_id"],
        "representative item id",
      ),
      representative_preview_id: requireId(
        approval["representative_preview_id"],
        "representative preview id",
      ),
      confirmation_state: "confirmed",
    };
  });
  if (new Set(groupApprovals.map((value) => value.group_id)).size !== groupApprovals.length) {
    throw invalid("Each batch group may be approved once");
  }
  if (new Set(groupApprovals.map((value) => value.representative_client_item_id)).size !== groupApprovals.length) {
    throw invalid("Each representative item may approve one batch group");
  }
  if (new Set(groupApprovals.map((value) => value.representative_preview_id)).size !== groupApprovals.length) {
    throw invalid("Each representative preview may approve one batch group");
  }
  const rawConfirmed = body["confirmed_client_item_ids"] ?? [];
  if (!Array.isArray(rawConfirmed) || rawConfirmed.length > BATCH_ITEM_LIMIT) {
    throw invalid("Confirmed batch item ids must be a list of no more than 50 items");
  }
  const confirmedClientItemIds = rawConfirmed.map((value) => requireId(value, "confirmed batch item id"));
  if (new Set(confirmedClientItemIds).size !== confirmedClientItemIds.length) {
    throw invalid("Each risky batch item may be confirmed once");
  }
  const includedIds = new Set(input.items.filter((item) => item.included).map((item) => item.clientItemId));
  if (groupApprovals.some((approval) => !includedIds.has(approval.representative_client_item_id))) {
    throw invalid("Batch group representatives must reference included items");
  }
  if (confirmedClientItemIds.some((itemId) => !includedIds.has(itemId))) {
    throw invalid("Confirmed batch items must reference included items");
  }
  return { ...input, planSha256, groupApprovals, confirmedClientItemIds };
}

export function stableBatchDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function batchGroupId(digest: string): string {
  return `group-${digest.slice(0, 24)}`;
}

export function batchOutputCompatibility(profile: ExportOutputProfile): Record<string, unknown> {
  return {
    purpose: profile.purpose,
    format: profile.format,
    width: profile.width ?? null,
    height: profile.height ?? null,
    percentage: profile.percentage ?? null,
    physical_width: profile.physical_width ?? null,
    physical_height: profile.physical_height ?? null,
    physical_unit: profile.physical_unit ?? null,
    ppi: profile.ppi ?? null,
    fit: profile.fit ?? "contain",
    quality: profile.quality ?? null,
    lossless: profile.lossless ?? false,
    resampling_algorithm: profile.resampling_algorithm ?? "lanczos",
    colour_profile: profile.colour_profile ?? "srgb",
    bit_depth: profile.bit_depth ?? 8,
    alpha_behavior: profile.alpha_behavior ?? "preserve",
    background: profile.background ?? null,
    metadata_policy: profile.metadata_policy ?? null,
    chroma_subsampling: profile.chroma_subsampling ?? null,
    collision_behavior: profile.collision_behavior ?? "suffix",
  };
}

function requireBatchItems(value: unknown): BatchSubmissionInputItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > BATCH_ITEM_LIMIT) {
    throw invalid(`Select between 1 and ${BATCH_ITEM_LIMIT} batch items`);
  }
  const items = value.map((raw): BatchSubmissionInputItem => {
    const item = object(raw, "batch item");
    const included = item["included"] === undefined ? true : requireBoolean(item["included"], "included");
    const exclusionReason = item["exclusion_reason"] === undefined || item["exclusion_reason"] === null
      ? null
      : requireText(item["exclusion_reason"], "exclusion reason", 500);
    if (included && exclusionReason !== null) throw invalid("Included items cannot have an exclusion reason");
    if (!included && exclusionReason === null) throw invalid("Excluded items require a reason");
    return {
      clientItemId: requireId(item["client_item_id"], "client item id"),
      displayName: requireText(item["display_name"], "item name", 300),
      documentId: requireId(item["document_id"], "document id"),
      documentVersionId: requireId(item["document_version_id"], "document version id"),
      recipeId: requireId(item["recipe_id"], "recipe id"),
      recipeVersion: positiveInteger(item["recipe_version"], "recipe version"),
      outputs: requireExportOutputs(item["outputs"], OUTPUT_LIMIT),
      included,
      exclusionReason,
    };
  });
  if (new Set(items.map((item) => item.clientItemId)).size !== items.length) {
    throw invalid("Batch client item ids must be unique");
  }
  const versions = items.map((item) => `${item.documentId}\u0000${item.documentVersionId}`);
  if (new Set(versions).size !== versions.length) {
    throw invalid("A document version may appear only once in a batch");
  }
  if (!items.some((item) => item.included)) throw invalid("A batch must include at least one item");
  const outputCount = items
    .filter((item) => item.included)
    .reduce((count, item) => count + item.outputs.length, 0);
  if (outputCount > BATCH_OUTPUT_LIMIT) {
    throw invalid(`A batch may create at most ${BATCH_OUTPUT_LIMIT} outputs`);
  }
  return items;
}

function object(value: unknown, field: string): Body {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`${field} must be an object`);
  return value as Body;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw invalid(`${field} must be true or false`);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw invalid(`${field} must be a positive integer`);
  return Number(value);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Body)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, canonical(item)]),
  );
}

function invalid(message: string): DomainError {
  return new DomainError(400, "batch-input-invalid", message);
}
