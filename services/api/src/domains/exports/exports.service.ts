import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import type { ComparisonMode, IntendedOutcome, Permission } from "ipw-contracts-ts/product";

import { DomainError, requireId, requireText } from "../../kernel/errors.js";
import { PRODUCT_REPOSITORY, type CommandContext, type ProductKernelRepository } from "../../kernel/product.types.js";
import { requestDigest } from "../../kernel/runtime.js";
import { DOCUMENT_REPOSITORY, type DocumentRepository } from "../documents/documents.types.js";
import { IdentityBoundary } from "../identity/identity.service.js";
import { PRIVATE_OBJECT_STORE, type PrivateObjectStore } from "../intake/private-object-store.js";
import { requireExportFilename, requireOperations, requireOutputProfile } from "./enhancement-validation.js";
import { IMAGE_EXPORT_REPOSITORY, type ImageExportRepository } from "./exports.types.js";

type Headers = Record<string, string | string[] | undefined>;
type Body = Record<string, unknown>;

const MODES = new Set<ComparisonMode>(["original", "current", "recommended", "split", "side_by_side"]);
const OUTCOMES = new Set<IntendedOutcome>(["digital", "archival", "presentation", "custom"]);
const OUTPUT_LIMIT = 64;
const DELIVERY_LIMIT = 1_073_741_824;

@Injectable()
export class ExportsService implements OnApplicationShutdown {
  constructor(
    @Inject(IMAGE_EXPORT_REPOSITORY) private readonly exports: ImageExportRepository,
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(PRODUCT_REPOSITORY) private readonly product: ProductKernelRepository,
    @Inject(PRIVATE_OBJECT_STORE) private readonly objects: PrivateObjectStore,
    private readonly identity: IdentityBoundary,
  ) {}

  async listRecipes(headers: Headers, workspaceId: string, documentId: string) {
    const access = await this.access(headers, workspaceId, "recipe.read");
    const id = await this.document(access.principal.actorId, access.workspaceId, documentId);
    return { schema_version: PRODUCT_SCHEMA_VERSION, recipes: await this.exports.listRecipes(access.principal.actorId, access.workspaceId, id) };
  }

  async createRecipe(headers: Headers, workspaceId: string, documentId: string, body: Body) {
    return this.saveRecipe(headers, workspaceId, documentId, undefined, body, "recipe.create");
  }

  async updateRecipe(headers: Headers, workspaceId: string, documentId: string, recipeId: string, body: Body) {
    return this.saveRecipe(headers, workspaceId, documentId, requireId(recipeId, "recipe id"), body, "recipe.update");
  }

  async recommendations(headers: Headers, workspaceId: string, documentId: string, body: Body) {
    const access = await this.access(headers, workspaceId, "recipe.create");
    const id = await this.document(access.principal.actorId, access.workspaceId, documentId);
    const documentVersionId = requireId(body["document_version_id"], "document version id");
    const outcomeValue = body["intended_outcome"];
    const intendedOutcome = outcomeValue === undefined || outcomeValue === null
      ? null
      : requireOutcome(outcomeValue);
    const payload = { workspaceId: access.workspaceId, documentId: id, documentVersionId, intendedOutcome };
    const context = this.command(headers, access.principal, "recommendations.request", payload);
    const result = await this.exports.recommend(context, payload);
    if (!result.replayed) await this.auditUnlessAtomic(context, access.workspaceId, "recommendations.generated", id);
    return { schema_version: PRODUCT_SCHEMA_VERSION, recommendation_set: result.value, replayed: result.replayed };
  }

  async preview(headers: Headers, workspaceId: string, documentId: string, body: Body) {
    const access = await this.access(headers, workspaceId, "recipe.read");
    const id = await this.document(access.principal.actorId, access.workspaceId, documentId);
    const recipeId = requireId(body["recipe_id"], "recipe id");
    const version = optionalPositiveInteger(body["recipe_version"], "recipe version");
    const selected = await this.exports.getRecipe(access.principal.actorId, access.workspaceId, recipeId, version ?? undefined);
    if (!selected || selected.document_id !== id) throw new DomainError(404, "recipe-not-found", "Recipe was not found");
    const mode = requireMode(body["mode"] ?? "current");
    return { schema_version: PRODUCT_SCHEMA_VERSION, preview: await this.exports.preview(access.principal.actorId, access.workspaceId, id, selected, mode) };
  }

  async submit(headers: Headers, workspaceId: string, documentId: string, body: Body) {
    const access = await this.access(headers, workspaceId, "export.create");
    const id = await this.document(access.principal.actorId, access.workspaceId, documentId);
    const rawOutputs = body["outputs"];
    if (!Array.isArray(rawOutputs) || rawOutputs.length < 1 || rawOutputs.length > OUTPUT_LIMIT) {
      throw new DomainError(400, "export-outputs-invalid", `Select between 1 and ${OUTPUT_LIMIT} outputs`);
    }
    const usedNames = new Set<string>();
    const outputs = rawOutputs.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new DomainError(400, "export-output-invalid", "Each export output must be an object");
      const item = value as Body;
      const profile = requireOutputProfile(item["profile"]);
      let filename = ensureExtension(requireExportFilename(item["filename"]), profile.format);
      if (usedNames.has(filename.toLowerCase())) {
        if (profile.collision_behavior === "fail") throw new DomainError(409, "export-filename-collision", "Output filenames must be unique");
        filename = availableFilename(filename, usedNames);
      }
      usedNames.add(filename.toLowerCase());
      return { artboardId: requireId(item["artboard_id"], "artboard id"), profile, filename };
    });
    const payload = {
      workspaceId: access.workspaceId,
      documentId: id,
      documentVersionId: requireId(body["document_version_id"], "document version id"),
      recipeId: requireId(body["recipe_id"], "recipe id"),
      recipeVersion: positiveInteger(body["recipe_version"], "recipe version"),
      outputs,
    };
    const context = this.command(headers, access.principal, "export.submit", payload);
    const result = await this.exports.submit(context, payload);
    if (!result.replayed) await this.auditUnlessAtomic(context, access.workspaceId, "export.submitted", result.value.export_request_id);
    return { schema_version: PRODUCT_SCHEMA_VERSION, export_request: result.value, replayed: result.replayed };
  }

  async list(headers: Headers, workspaceId: string, documentId?: string) {
    const access = await this.access(headers, workspaceId, "export.read");
    const id = documentId ? await this.document(access.principal.actorId, access.workspaceId, documentId) : undefined;
    return { schema_version: PRODUCT_SCHEMA_VERSION, exports: await this.exports.list(access.principal.actorId, access.workspaceId, id) };
  }

  async get(headers: Headers, workspaceId: string, exportRequestId: string) {
    const access = await this.access(headers, workspaceId, "export.read");
    const id = requireId(exportRequestId, "export request id");
    const value = await this.exports.get(access.principal.actorId, access.workspaceId, id);
    if (!value) throw new DomainError(404, "export-not-found", "Export was not found");
    return { schema_version: PRODUCT_SCHEMA_VERSION, export_request: value };
  }

  async cancel(headers: Headers, workspaceId: string, exportRequestId: string) {
    const access = await this.access(headers, workspaceId, "export.cancel");
    const id = requireId(exportRequestId, "export request id");
    const payload = { workspaceId: access.workspaceId, exportRequestId: id };
    const context = this.command(headers, access.principal, "export.cancel", payload);
    const result = await this.exports.cancel(context, access.workspaceId, id);
    if (!result.replayed) await this.auditUnlessAtomic(context, access.workspaceId, "export.cancellation-requested", id);
    return { schema_version: PRODUCT_SCHEMA_VERSION, export_request: result.value, replayed: result.replayed };
  }

  async retry(headers: Headers, workspaceId: string, exportRequestId: string) {
    const access = await this.access(headers, workspaceId, "export.retry");
    const id = requireId(exportRequestId, "export request id");
    const payload = { workspaceId: access.workspaceId, exportRequestId: id };
    const context = this.command(headers, access.principal, "export.retry", payload);
    const result = await this.exports.retry(context, access.workspaceId, id);
    if (!result.replayed) await this.auditUnlessAtomic(context, access.workspaceId, "export.retry-requested", id);
    return { schema_version: PRODUCT_SCHEMA_VERSION, export_request: result.value, replayed: result.replayed };
  }

  async bundle(headers: Headers, workspaceId: string, exportRequestId: string) {
    const access = await this.access(headers, workspaceId, "export.create");
    const id = requireId(exportRequestId, "export request id");
    const payload = { workspaceId: access.workspaceId, exportRequestId: id };
    const context = this.command(headers, access.principal, "export.bundle", payload);
    const result = await this.exports.createBundle(context, access.workspaceId, id);
    if (!result.replayed) await this.auditUnlessAtomic(context, access.workspaceId, "export.bundle-requested", result.value.bundle_id);
    return { schema_version: PRODUCT_SCHEMA_VERSION, bundle: result.value, replayed: result.replayed };
  }

  async getBundle(headers: Headers, workspaceId: string, bundleId: string) {
    const access = await this.access(headers, workspaceId, "export.read");
    const id = requireId(bundleId, "bundle id");
    const value = await this.exports.getBundle(access.principal.actorId, access.workspaceId, id);
    if (!value) throw new DomainError(404, "bundle-not-found", "ZIP bundle was not found");
    return { schema_version: PRODUCT_SCHEMA_VERSION, bundle: value };
  }

  async outputDownload(headers: Headers, workspaceId: string, outputId: string) {
    const access = await this.access(headers, workspaceId, "export.read");
    const value = await this.exports.delivery(access.principal.actorId, access.workspaceId, requireId(outputId, "output id"));
    if (!value) throw new DomainError(404, "export-output-not-found", "Completed output was not found");
    return this.readDelivery(access.workspaceId, value);
  }

  async bundleDownload(headers: Headers, workspaceId: string, bundleId: string) {
    const access = await this.access(headers, workspaceId, "export.read");
    const value = await this.exports.bundleDelivery(access.principal.actorId, access.workspaceId, requireId(bundleId, "bundle id"));
    if (!value) throw new DomainError(404, "bundle-not-found", "ZIP bundle is unavailable or expired");
    return this.readDelivery(access.workspaceId, value);
  }

  async onApplicationShutdown(): Promise<void> { await this.exports.close(); }

  private async saveRecipe(headers: Headers, workspaceId: string, documentId: string, recipeId: string | undefined, body: Body, permission: Permission) {
    const access = await this.access(headers, workspaceId, permission);
    const id = await this.document(access.principal.actorId, access.workspaceId, documentId);
    if (recipeId) {
      const existing = await this.exports.getRecipe(access.principal.actorId, access.workspaceId, recipeId);
      if (!existing || existing.document_id !== id) throw new DomainError(404, "recipe-not-found", "Recipe was not found");
    }
    const payload = { workspaceId: access.workspaceId, documentId: id, recipeId, name: requireText(body["name"], "recipe name", 200), operations: requireOperations(body["operations"] ?? []) };
    const context = this.command(headers, access.principal, "recipe.save", payload);
    const result = await this.exports.createRecipe(context, payload);
    if (!result.replayed) await this.auditUnlessAtomic(context, access.workspaceId, "recipe.saved", result.value.recipe_id);
    return { schema_version: PRODUCT_SCHEMA_VERSION, recipe: result.value, replayed: result.replayed };
  }

  private async readDelivery(workspaceId: string, value: { objectKey: string; byteSize: number; mediaType: string; filename: string }) {
    if (!Number.isSafeInteger(value.byteSize) || value.byteSize < 1 || value.byteSize > DELIVERY_LIMIT) {
      throw new DomainError(413, "download-limit-exceeded", "This output exceeds the bounded API delivery limit");
    }
    const bytes = await this.objects.read({ ownerScope: workspaceId, objectKey: value.objectKey, zone: "derivative" }, value.byteSize);
    if (bytes.byteLength !== value.byteSize) throw new DomainError(409, "export-integrity-conflict", "Stored output size no longer matches its verified record");
    return { ...value, bytes };
  }

  private async document(actorId: string, workspaceId: string, documentId: string): Promise<string> {
    const id = requireId(documentId, "document id");
    if (!await this.documents.get(actorId, workspaceId, id)) throw new DomainError(404, "document-not-found", "Document was not found");
    return id;
  }

  private async access(headers: Headers, workspaceId: string, required: Permission) {
    const principal = await this.identity.resolve(headers);
    const id = requireId(workspaceId, "workspace id");
    const context = await this.product.workspaceContext(principal.actorId, id);
    if (!context) throw new DomainError(404, "workspace-not-found", "Workspace was not found");
    const allowed = context.effectivePermissions.some((item) => item.permission === required && item.allowed);
    if (!allowed) throw new DomainError(403, "access-denied", "You do not have permission to use image exports");
    return { principal, workspaceId: id };
  }

  private command(headers: Headers, principal: { actorId: string; displayName: string }, name: string, payload: unknown): CommandContext {
    const idempotencyKey = requireId(this.header(headers, "idempotency-key"), "Idempotency-Key");
    const traceId = requireId(this.header(headers, "x-trace-id"), "trace id");
    return { principal, idempotencyKey, traceId, requestHash: requestDigest({ command: name, payload }) };
  }

  private header(headers: Headers, name: string): string | undefined {
    const value = headers[name];
    return (Array.isArray(value) ? value[0] : value)?.trim();
  }

  private auditUnlessAtomic(context: CommandContext, workspaceId: string, action: string, resourceId: string) {
    return this.exports.recordsMutationsAtomically
      ? Promise.resolve()
      : this.product.recordExternalMutation(context, workspaceId, action, "image_export", resourceId);
  }
}

function requireMode(value: unknown): ComparisonMode {
  if (typeof value !== "string" || !MODES.has(value as ComparisonMode)) throw new DomainError(400, "comparison-mode-invalid", "Comparison mode is not supported");
  return value as ComparisonMode;
}

function requireOutcome(value: unknown): IntendedOutcome {
  if (typeof value !== "string" || !OUTCOMES.has(value as IntendedOutcome)) throw new DomainError(400, "intended-outcome-invalid", "Choose a supported intended outcome");
  return value as IntendedOutcome;
}

function optionalPositiveInteger(value: unknown, field: string): number | null {
  return value === undefined || value === null ? null : positiveInteger(value, field);
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new DomainError(400, "invalid-input", `${field} must be a positive integer`);
  return Number(value);
}

function ensureExtension(filename: string, format: "jpeg" | "png" | "webp" | "tiff"): string {
  const allowed = format === "jpeg" ? [".jpg", ".jpeg"] : format === "tiff" ? [".tif", ".tiff"] : [`.${format}`];
  if (allowed.some((extension) => filename.toLowerCase().endsWith(extension))) return filename;
  if (/\.[a-z0-9]{1,8}$/i.test(filename)) throw new DomainError(400, "export-extension-mismatch", `Filename extension does not match ${format.toUpperCase()}`);
  return `${filename}${allowed[0]}`;
}

function availableFilename(filename: string, used: Set<string>): string {
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : "";
  for (let suffix = 2; suffix <= OUTPUT_LIMIT; suffix += 1) {
    const candidate = `${stem}-${suffix}${extension}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  throw new DomainError(409, "export-filename-collision", "Output filenames could not be made unique");
}
