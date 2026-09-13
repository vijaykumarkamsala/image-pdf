import { createHash } from "node:crypto";
import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import type { PdfCapabilityReport, Permission, WorkspaceFile } from "ipw-contracts-ts/product";

import { DomainError, requireId } from "../../kernel/errors.js";
import { PRODUCT_REPOSITORY, type CommandContext, type ProductKernelRepository } from "../../kernel/product.types.js";
import { requestDigest } from "../../kernel/runtime.js";
import { DOCUMENT_REPOSITORY, type DocumentRepository } from "../documents/documents.types.js";
import { IdentityBoundary } from "../identity/identity.service.js";
import { PRIVATE_OBJECT_STORE, type PrivateObjectStore } from "../intake/private-object-store.js";
import {
  INTAKE_REPOSITORY,
  type IntakeRepository,
  type StoredPdfCapabilityAnalysis,
} from "../intake/intake.types.js";
import { PDF_EXPORT_REPOSITORY, type PdfExportRepository } from "./pdf.types.js";
import { preflightScreenPdf } from "./pdf-preflight.js";

type Headers = Record<string, string | string[] | undefined>;

const DELIVERY_LIMIT = 256 * 1024 * 1024;

@Injectable()
export class PdfService implements OnApplicationShutdown {
  constructor(
    @Inject(PDF_EXPORT_REPOSITORY) private readonly exports: PdfExportRepository,
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(PRODUCT_REPOSITORY) private readonly product: ProductKernelRepository,
    @Inject(PRIVATE_OBJECT_STORE) private readonly objects: PrivateObjectStore,
    @Inject(INTAKE_REPOSITORY) private readonly intake: IntakeRepository,
    private readonly identity: IdentityBoundary,
  ) {}

  async capabilityReport(headers: Headers, workspaceId: string, fileId: string) {
    const access = await this.access(headers, workspaceId, "file.read");
    const id = requireId(fileId, "file id");
    const file = (await this.product.listFiles(access.principal.actorId, access.workspaceId))
      .find((candidate) => candidate.file_id === id);
    if (!file) throw new DomainError(404, "file-not-found", "File was not found");
    const evidence = await this.intake.findPdfCapabilityAnalysis(
      access.workspaceId,
      file.current_source_version_id,
    );
    if (!evidence) {
      throw new DomainError(
        404,
        "pdf-capability-report-not-found",
        "A verified imported-PDF capability report was not found",
      );
    }
    const report = this.report(access.workspaceId, file, evidence);
    return { schema_version: PRODUCT_SCHEMA_VERSION, capability_report: report };
  }

  async capabilityReports(headers: Headers, workspaceId: string) {
    const access = await this.access(headers, workspaceId, "file.read");
    const files = await this.product.listFiles(access.principal.actorId, access.workspaceId);
    const evidence = await this.intake.listPdfCapabilityAnalyses(
      access.workspaceId,
      files.map((file) => file.current_source_version_id),
    );
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      capability_reports: files.flatMap((file) => {
        const item = evidence.get(file.current_source_version_id);
        return item ? [this.report(access.workspaceId, file, item)] : [];
      }),
    };
  }

  private report(
    workspaceId: string,
    file: WorkspaceFile,
    evidence: StoredPdfCapabilityAnalysis,
  ): PdfCapabilityReport {
    const reportKey = createHash("sha256").update(file.current_source_version_id).digest("hex");
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      pdf_capability_report_id: `pdfcap-${reportKey.slice(0, 48)}`,
      workspace_id: workspaceId,
      file_id: file.file_id,
      asset_original_id: file.asset_original_id,
      source_version_id: file.current_source_version_id,
      storage_generation: evidence.storageGeneration,
      analysis: evidence.analysis,
      inspected_at: evidence.inspectedAt,
    };
  }

  async preflight(headers: Headers, workspaceId: string, documentId: string) {
    const access = await this.access(headers, workspaceId, "export.read");
    const editor = await this.document(access.principal.actorId, access.workspaceId, documentId);
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      preflight: preflightScreenPdf(editor, new Date().toISOString()),
    };
  }

  async createExport(headers: Headers, workspaceId: string, documentId: string) {
    const access = await this.access(headers, workspaceId, "export.create");
    const editor = await this.document(access.principal.actorId, access.workspaceId, documentId);
    const preflight = preflightScreenPdf(editor, new Date().toISOString());
    if (preflight.state !== "ready") {
      throw new DomainError(409, "pdf-preflight-blocked", "Resolve blocking PDF preflight issues before export");
    }
    const input = { workspaceId: access.workspaceId, preflight };
    const context = this.command(headers, access.principal, "pdf-export.create", {
      workspaceId: access.workspaceId,
      documentId: preflight.document_id,
      documentVersionId: preflight.document_version_id,
      snapshotSha256: preflight.snapshot_sha256,
      profile: preflight.profile,
    });
    const result = await this.exports.create(context, input);
    if (!result.replayed) await this.auditUnlessAtomic(context, access.workspaceId, "pdf.export-submitted", result.value.request.pdf_export_request_id);
    return { schema_version: PRODUCT_SCHEMA_VERSION, pdf_export: result.value, replayed: result.replayed };
  }

  async list(headers: Headers, workspaceId: string, documentId?: string) {
    const access = await this.access(headers, workspaceId, "export.read");
    const id = documentId
      ? (await this.document(access.principal.actorId, access.workspaceId, documentId)).document.document_id
      : undefined;
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      pdf_exports: await this.exports.list(access.principal.actorId, access.workspaceId, id),
    };
  }

  async get(headers: Headers, workspaceId: string, requestId: string) {
    const access = await this.access(headers, workspaceId, "export.read");
    const id = requireId(requestId, "PDF export request id");
    const value = await this.exports.get(access.principal.actorId, access.workspaceId, id);
    if (!value) throw new DomainError(404, "pdf-export-not-found", "PDF export was not found");
    return { schema_version: PRODUCT_SCHEMA_VERSION, pdf_export: value };
  }

  async cancel(headers: Headers, workspaceId: string, requestId: string) {
    return this.mutate(headers, workspaceId, requestId, "export.cancel", "pdf-export.cancel", "pdf.export-cancellation-requested");
  }

  async retry(headers: Headers, workspaceId: string, requestId: string) {
    return this.mutate(headers, workspaceId, requestId, "export.retry", "pdf-export.retry", "pdf.export-retry-requested");
  }

  async download(headers: Headers, workspaceId: string, requestId: string) {
    const access = await this.access(headers, workspaceId, "export.read");
    const value = await this.exports.delivery(access.principal.actorId, access.workspaceId, requireId(requestId, "PDF export request id"));
    if (!value) throw new DomainError(404, "pdf-export-not-ready", "Completed PDF export was not found");
    if (!Number.isSafeInteger(value.byteSize) || value.byteSize < 1 || value.byteSize > DELIVERY_LIMIT) {
      throw new DomainError(413, "download-limit-exceeded", "This PDF exceeds the bounded API delivery limit");
    }
    let bytes: Uint8Array;
    try {
      bytes = await this.objects.read({ ownerScope: access.workspaceId, objectKey: value.objectKey, zone: "derivative", generation: value.storageGeneration }, value.byteSize);
    } catch {
      throw new DomainError(409, "pdf-export-integrity-conflict", "Stored PDF generation no longer matches its verified result");
    }
    if (bytes.byteLength !== value.byteSize || createHash("sha256").update(bytes).digest("hex") !== value.sha256) {
      throw new DomainError(409, "pdf-export-integrity-conflict", "Stored PDF bytes no longer match their verified result");
    }
    return { ...value, bytes };
  }

  async onApplicationShutdown(): Promise<void> { await this.exports.close(); }

  private async mutate(
    headers: Headers,
    workspaceId: string,
    requestId: string,
    permission: Permission,
    commandName: "pdf-export.cancel" | "pdf-export.retry",
    auditAction: string,
  ) {
    const access = await this.access(headers, workspaceId, permission);
    const id = requireId(requestId, "PDF export request id");
    const payload = { workspaceId: access.workspaceId, pdfExportRequestId: id };
    const context = this.command(headers, access.principal, commandName, payload);
    const result = commandName === "pdf-export.cancel"
      ? await this.exports.cancel(context, access.workspaceId, id)
      : await this.exports.retry(context, access.workspaceId, id);
    if (!result.replayed) await this.auditUnlessAtomic(context, access.workspaceId, auditAction, id);
    return { schema_version: PRODUCT_SCHEMA_VERSION, pdf_export: result.value, replayed: result.replayed };
  }

  private async document(actorId: string, workspaceId: string, documentId: string) {
    const value = await this.documents.get(actorId, workspaceId, requireId(documentId, "document id"));
    if (!value || value.document.kind !== "pdf") {
      throw new DomainError(404, "pdf-document-not-found", "Native PDF document was not found");
    }
    return value;
  }

  private async access(headers: Headers, workspaceId: string, required: Permission) {
    const principal = await this.identity.resolve(headers);
    const id = requireId(workspaceId, "workspace id");
    const context = await this.product.workspaceContext(principal.actorId, id);
    if (!context) throw new DomainError(404, "workspace-not-found", "Workspace was not found");
    if (!context.effectivePermissions.some((item) => item.permission === required && item.allowed)) {
      throw new DomainError(403, "access-denied", "You do not have permission for this PDF operation");
    }
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

  private auditUnlessAtomic(context: CommandContext, workspaceId: string, action: string, requestId: string) {
    return this.exports.recordsMutationsAtomically
      ? Promise.resolve()
      : this.product.recordExternalMutation(context, workspaceId, action, "pdf_export", requestId);
  }
}
