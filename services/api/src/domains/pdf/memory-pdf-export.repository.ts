import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import type { PdfExportRequestRecord } from "ipw-contracts-ts/product";

import { DomainError } from "../../kernel/errors.js";
import type { CommandContext } from "../../kernel/product.types.js";
import type { RuntimeValues } from "../../kernel/runtime.js";
import type { PdfExportReadModel, PdfExportRepository } from "./pdf.types.js";

interface Receipt {
  requestHash: string;
  response: PdfExportReadModel;
}

export class MemoryPdfExportRepository implements PdfExportRepository {
  readonly recordsMutationsAtomically = false;
  private readonly exports = new Map<string, PdfExportReadModel>();
  private readonly receipts = new Map<string, Receipt>();

  constructor(private readonly runtime: RuntimeValues) {}

  async create(context: CommandContext, input: Parameters<PdfExportRepository["create"]>[1]) {
    return this.idempotent(context, input.workspaceId, "pdf-export.create", () => {
      const now = this.runtime.now();
      const preflight = input.preflight;
      const request: PdfExportRequestRecord = {
        schema_version: PRODUCT_SCHEMA_VERSION,
        pdf_export_request_id: this.runtime.id("pdf-export"),
        workspace_id: input.workspaceId,
        document_id: preflight.document_id,
        document_version_id: preflight.document_version_id,
        snapshot_sha256: preflight.snapshot_sha256,
        profile: structuredClone(preflight.profile),
        preflight: structuredClone(preflight),
        state: "queued",
        job_id: this.runtime.id("job"),
        created_by_actor_id: context.principal.actorId,
        created_at: now,
        updated_at: now,
        failure_code: null,
        failure_message: null,
      };
      const value = { request, result: null };
      this.exports.set(request.pdf_export_request_id, structuredClone(value));
      return value;
    });
  }

  async list(_actorId: string, workspaceId: string, documentId?: string) {
    return [...this.exports.values()]
      .filter((item) => item.request.workspace_id === workspaceId && (!documentId || item.request.document_id === documentId))
      .sort((left, right) => right.request.updated_at.localeCompare(left.request.updated_at))
      .map((item) => structuredClone(item));
  }

  async get(_actorId: string, workspaceId: string, requestId: string) {
    const value = this.exports.get(requestId);
    return value?.request.workspace_id === workspaceId ? structuredClone(value) : null;
  }

  async cancel(context: CommandContext, workspaceId: string, requestId: string) {
    return this.idempotent(context, workspaceId, "pdf-export.cancel", () => {
      const value = this.require(workspaceId, requestId);
      if (["succeeded", "failed", "cancelled"].includes(value.request.state)) return value;
      value.request.state = value.request.state === "running" ? "cancellation_requested" : "cancelled";
      value.request.updated_at = this.runtime.now();
      return value;
    });
  }

  async retry(context: CommandContext, workspaceId: string, requestId: string) {
    return this.idempotent(context, workspaceId, "pdf-export.retry", () => {
      const value = this.require(workspaceId, requestId);
      if (!["failed", "cancelled"].includes(value.request.state)) {
        throw new DomainError(409, "pdf-export-not-retryable", "Only failed or cancelled PDF exports can be retried");
      }
      value.request.job_id = this.runtime.id("job");
      value.request.state = "queued";
      value.request.failure_code = null;
      value.request.failure_message = null;
      value.request.updated_at = this.runtime.now();
      return value;
    });
  }

  async delivery(): Promise<null> { return null; }
  async close(): Promise<void> {}

  private require(workspaceId: string, requestId: string): PdfExportReadModel {
    const value = this.exports.get(requestId);
    if (!value || value.request.workspace_id !== workspaceId) {
      throw new DomainError(404, "pdf-export-not-found", "PDF export was not found");
    }
    return value;
  }

  private async idempotent(
    context: CommandContext,
    workspaceId: string,
    command: string,
    operation: () => PdfExportReadModel,
  ): Promise<{ value: PdfExportReadModel; replayed: boolean }> {
    const key = `${workspaceId}:${command}:${context.idempotencyKey}`;
    const existing = this.receipts.get(key);
    if (existing) {
      if (existing.requestHash !== context.requestHash) {
        throw new DomainError(409, "idempotency-conflict", "This idempotency key was already used for different PDF export work");
      }
      return { value: structuredClone(existing.response), replayed: true };
    }
    const value = operation();
    this.receipts.set(key, { requestHash: context.requestHash, response: structuredClone(value) });
    return { value: structuredClone(value), replayed: false };
  }
}
