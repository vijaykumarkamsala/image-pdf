import { Inject, Injectable, OnApplicationShutdown } from "@nestjs/common";
import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import type { EditorMutation, Permission } from "ipw-contracts-ts/product";

import { DomainError, requireId, requireText } from "../../kernel/errors.js";
import {
  PRODUCT_REPOSITORY,
  type CommandContext,
  type ProductKernelRepository,
} from "../../kernel/product.types.js";
import { requestDigest } from "../../kernel/runtime.js";
import { IdentityBoundary } from "../identity/identity.service.js";
import { INTAKE_REPOSITORY, type IntakeRepository, type StoredUploadSession } from "../intake/intake.types.js";
import { PRIVATE_OBJECT_STORE, type PrivateObjectStore } from "../intake/private-object-store.js";
import { sha256 } from "./document-model.js";
import { DOCUMENT_REPOSITORY, type DocumentRepository, type VerifiedRasterSource } from "./documents.types.js";

type Headers = Record<string, string | string[] | undefined>;
type Body = Record<string, unknown>;

const RASTER_MEDIA_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
]);

@Injectable()
export class DocumentsService implements OnApplicationShutdown {
  constructor(
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(PRODUCT_REPOSITORY) private readonly product: ProductKernelRepository,
    @Inject(INTAKE_REPOSITORY) private readonly intake: IntakeRepository,
    @Inject(PRIVATE_OBJECT_STORE) private readonly objects: PrivateObjectStore,
    private readonly identity: IdentityBoundary,
  ) {}

  async list(headers: Headers, workspaceId: string) {
    const access = await this.access(headers, workspaceId, "document.read");
    return { schema_version: PRODUCT_SCHEMA_VERSION, documents: await this.documents.list(access.principal.actorId, access.workspaceId) };
  }

  async get(headers: Headers, workspaceId: string, documentId: string) {
    const access = await this.access(headers, workspaceId, "document.read");
    const result = await this.documents.get(access.principal.actorId, access.workspaceId, requireId(documentId, "document id"));
    if (!result) throw new DomainError(404, "document-not-found", "Document was not found");
    return { schema_version: PRODUCT_SCHEMA_VERSION, editor: result };
  }

  async create(headers: Headers, workspaceId: string, body: Body) {
    const access = await this.access(headers, workspaceId, "document.create");
    const projectId = optionalId(body["project_id"], "project id");
    if (projectId) {
      const projects = await this.product.listProjects(access.principal.actorId, access.workspaceId);
      if (!projects.projects.some((item) => item.project_id === projectId)) throw new DomainError(404, "project-not-found", "Project was not found");
    }
    const sourceFileId = optionalId(body["source_file_id"], "source file id");
    const source = sourceFileId ? await this.verifiedSource(access.principal.actorId, access.workspaceId, sourceFileId) : undefined;
    const context = this.command(headers, access.principal, "document.create", { workspaceId: access.workspaceId, body });
    const name = requireText(body["name"] ?? source?.displayName ?? "Untitled graphic", "document name", 200);
    const intendedUse = intendedUseKind(body["intended_use"]);
    const result = await this.documents.create(context, {
      workspaceId: access.workspaceId,
      projectId,
      defaultFilesId: access.defaultFilesId,
      name,
      intendedUse,
      intendedUseLabel: requireText(body["intended_use_label"] ?? intendedUseLabel(intendedUse), "intended use label", 100),
      width: optionalDimension(body["width"]),
      height: optionalDimension(body["height"]),
      source,
    });
    if (!result.replayed) await this.audit(context, access.workspaceId, "document.created", result.value.document.document_id);
    return { schema_version: PRODUCT_SCHEMA_VERSION, editor: result.value, replayed: result.replayed };
  }

  async mutate(headers: Headers, workspaceId: string, documentId: string, body: Body) {
    const access = await this.access(headers, workspaceId, "document.edit");
    const id = requireId(documentId, "document id");
    const baseRevision = requiredRevision(body["base_revision"]);
    const mutation = requireMutation(body["mutation"]);
    const context = this.command(headers, access.principal, "document.mutate", { workspaceId: access.workspaceId, documentId: id, baseRevision, mutation });
    const result = await this.documents.mutate(context, {
      workspaceId: access.workspaceId, documentId: id, baseRevision, mutation,
      leaseTokenHash: this.leaseTokenHash(headers),
    });
    if (!result.replayed) await this.audit(context, access.workspaceId, mutation.kind, id);
    return { schema_version: PRODUCT_SCHEMA_VERSION, mutation: result };
  }

  async acquireLease(headers: Headers, workspaceId: string, documentId: string) {
    const access = await this.access(headers, workspaceId, "document.edit");
    const id = requireId(documentId, "document id");
    const context = this.command(headers, access.principal, "document.lease.acquire", { workspaceId: access.workspaceId, documentId: id });
    const grant = await this.documents.acquireLease(context, access.workspaceId, id);
    await this.audit(context, access.workspaceId, "document.lease.acquired", id);
    return { schema_version: PRODUCT_SCHEMA_VERSION, grant };
  }

  async heartbeat(headers: Headers, workspaceId: string, documentId: string) {
    const access = await this.access(headers, workspaceId, "document.edit");
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      lease: await this.documents.heartbeatLease(access.principal.actorId, access.workspaceId, requireId(documentId, "document id"), this.leaseTokenHash(headers)),
    };
  }

  async releaseLease(headers: Headers, workspaceId: string, documentId: string) {
    const access = await this.access(headers, workspaceId, "document.edit");
    const id = requireId(documentId, "document id");
    const context = this.command(headers, access.principal, "document.lease.release", { workspaceId: access.workspaceId, documentId: id });
    const lease = await this.documents.releaseLease(context, access.workspaceId, id, this.leaseTokenHash(headers));
    await this.audit(context, access.workspaceId, "document.lease.released", id);
    return { schema_version: PRODUCT_SCHEMA_VERSION, lease };
  }

  async takeover(headers: Headers, workspaceId: string, documentId: string, body: Body) {
    const access = await this.access(headers, workspaceId, "document.edit");
    const id = requireId(documentId, "document id");
    const force = body["force"] === true;
    if (force && !access.permissions.has("document.lease.takeover")) throw new DomainError(403, "access-denied", "Only workspace administrators can force a takeover");
    const context = this.command(headers, access.principal, "document.lease.takeover", { workspaceId: access.workspaceId, documentId: id, force });
    const result = await this.documents.takeoverLease(context, access.workspaceId, id, force);
    await this.audit(context, access.workspaceId, result.status === "acquired" ? "document.lease.taken-over" : "document.lease.takeover-requested", id);
    return { schema_version: PRODUCT_SCHEMA_VERSION, takeover: result };
  }

  async undo(headers: Headers, workspaceId: string, documentId: string) {
    return this.history(headers, workspaceId, documentId, "undo");
  }

  async redo(headers: Headers, workspaceId: string, documentId: string) {
    return this.history(headers, workspaceId, documentId, "redo");
  }

  async createVersion(headers: Headers, workspaceId: string, documentId: string, body: Body) {
    const access = await this.access(headers, workspaceId, "document.version");
    const id = requireId(documentId, "document id");
    const name = requireText(body["name"], "version name", 100);
    const context = this.command(headers, access.principal, "document.version", { workspaceId: access.workspaceId, documentId: id, name });
    const result = await this.documents.createVersion(context, access.workspaceId, id, name);
    if (!result.replayed) await this.audit(context, access.workspaceId, "document.version.created", id);
    return { schema_version: PRODUCT_SCHEMA_VERSION, version: result.value, replayed: result.replayed };
  }

  async restore(headers: Headers, workspaceId: string, documentId: string, versionId: string) {
    const access = await this.access(headers, workspaceId, "document.version");
    const id = requireId(documentId, "document id");
    const version = requireId(versionId, "version id");
    const context = this.command(headers, access.principal, "document.restore", { workspaceId: access.workspaceId, documentId: id, versionId: version });
    const result = await this.documents.restoreVersion(context, access.workspaceId, id, version, this.leaseTokenHash(headers));
    if (!result.replayed) await this.audit(context, access.workspaceId, "document.version.restored", id);
    return { schema_version: PRODUCT_SCHEMA_VERSION, editor: result.value, replayed: result.replayed };
  }

  async saveAs(headers: Headers, workspaceId: string, documentId: string, body: Body) {
    const access = await this.access(headers, workspaceId, "document.create");
    const id = requireId(documentId, "document id");
    const name = requireText(body["name"], "document name", 200);
    const projectId = optionalId(body["project_id"], "project id");
    if (projectId) {
      const projects = await this.product.listProjects(access.principal.actorId, access.workspaceId);
      if (!projects.projects.some((item) => item.project_id === projectId)) throw new DomainError(404, "project-not-found", "Project was not found");
    }
    const context = this.command(headers, access.principal, "document.save-as", { workspaceId: access.workspaceId, documentId: id, name, projectId });
    const result = await this.documents.saveAs(context, access.workspaceId, id, name, projectId, access.defaultFilesId);
    if (!result.replayed) await this.audit(context, access.workspaceId, "document.saved-as", result.value.document.document_id);
    return { schema_version: PRODUCT_SCHEMA_VERSION, editor: result.value, replayed: result.replayed };
  }

  async compatibility(headers: Headers, workspaceId: string, documentId: string) {
    const access = await this.access(headers, workspaceId, "document.read");
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      reports: await this.documents.compatibilityReports(access.principal.actorId, access.workspaceId, requireId(documentId, "document id")),
    };
  }

  async source(headers: Headers, workspaceId: string, documentId: string) {
    const access = await this.access(headers, workspaceId, "document.read");
    const editor = await this.documents.get(access.principal.actorId, access.workspaceId, requireId(documentId, "document id"));
    if (!editor?.document.source_file_id) throw new DomainError(404, "document-source-not-found", "This document has no source image");
    const { stored } = await this.verifiedSourceWithUpload(access.principal.actorId, access.workspaceId, editor.document.source_file_id);
    const byteSize = stored.record.source_facts!.byte_size;
    if (byteSize > 50 * 1024 * 1024) throw new DomainError(413, "editor-preview-too-large", "This source requires a server-generated preview before browser editing");
    return { bytes: await this.objects.read(stored.quarantineRef, byteSize), mediaType: stored.record.source_facts!.detected_media_type };
  }

  async onApplicationShutdown(): Promise<void> { await this.documents.close(); }

  private async history(headers: Headers, workspaceId: string, documentId: string, direction: "undo" | "redo") {
    const access = await this.access(headers, workspaceId, "document.edit");
    const id = requireId(documentId, "document id");
    const context = this.command(headers, access.principal, `document.${direction}`, { workspaceId: access.workspaceId, documentId: id });
    const result = direction === "undo"
      ? await this.documents.undo(context, access.workspaceId, id, this.leaseTokenHash(headers))
      : await this.documents.redo(context, access.workspaceId, id, this.leaseTokenHash(headers));
    if (!result.replayed) await this.audit(context, access.workspaceId, `document.${direction}`, id);
    return { schema_version: PRODUCT_SCHEMA_VERSION, history: result.value, replayed: result.replayed };
  }

  private async verifiedSource(actorId: string, workspaceId: string, fileId: string): Promise<VerifiedRasterSource> {
    return (await this.verifiedSourceWithUpload(actorId, workspaceId, fileId)).source;
  }

  private async verifiedSourceWithUpload(actorId: string, workspaceId: string, fileId: string): Promise<{ source: VerifiedRasterSource; stored: StoredUploadSession }> {
    const file = (await this.product.listFiles(actorId, workspaceId)).find((item) => item.file_id === fileId);
    if (!file) throw new DomainError(404, "file-not-found", "Source file was not found");
    const stored = (await this.intake.listWorkspaceUploads(workspaceId)).find((item) =>
      item.record.file_id === fileId
      || (item.record.asset_original_id === file.asset_original_id && item.record.source_version_id === file.current_source_version_id));
    const facts = stored?.record.source_facts;
    if (!stored || stored.record.state !== "ready" || !facts || facts.malware_scan_state !== "clean") {
      throw new DomainError(409, "source-not-ready", "The source must pass intake safety checks before editing");
    }
    if (!RASTER_MEDIA_TYPES.has(facts.detected_media_type)) {
      const message = facts.detected_media_type === "image/svg+xml"
        ? "SVG editing requires the approved sanitisation pipeline"
        : "This source format is not supported by Image & Graphic Studio";
      throw new DomainError(415, "editor-source-unsupported", message);
    }
    return {
      stored,
      source: {
        fileId: file.file_id, displayName: file.display_name, assetOriginalId: file.asset_original_id,
        sourceVersionId: file.current_source_version_id, objectReferenceId: null,
        mediaType: facts.detected_media_type, width: facts.width ?? null, height: facts.height ?? null,
      },
    };
  }

  private async access(headers: Headers, workspaceId: string, required: Permission) {
    const principal = await this.identity.resolve(headers);
    const id = requireId(workspaceId, "workspace id");
    const context = await this.product.workspaceContext(principal.actorId, id);
    if (!context) throw new DomainError(404, "workspace-not-found", "Workspace was not found");
    const permissions = new Set(context.effectivePermissions.filter((item) => item.allowed).map((item) => item.permission));
    if (!permissions.has(required)) throw new DomainError(403, "access-denied", "You do not have permission to use this document");
    return { principal, workspaceId: id, permissions, defaultFilesId: context.defaultFiles.default_files_id };
  }

  private command(headers: Headers, principal: { actorId: string; displayName: string }, name: string, payload: unknown): CommandContext {
    const idempotencyKey = requireId(this.header(headers, "idempotency-key"), "Idempotency-Key");
    const traceId = requireId(this.header(headers, "x-trace-id"), "trace id");
    return { principal, idempotencyKey, traceId, requestHash: requestDigest({ command: name, payload }) };
  }

  private leaseTokenHash(headers: Headers): string {
    const token = requireText(this.header(headers, "x-editor-lease"), "editor lease", 256);
    return sha256(token);
  }

  private header(headers: Headers, name: string): string | undefined {
    const value = headers[name];
    return (Array.isArray(value) ? value[0] : value)?.trim();
  }

  private audit(context: CommandContext, workspaceId: string, action: string, resourceId: string) {
    return this.product.recordExternalMutation(context, workspaceId, action, "editor_document", resourceId);
  }
}

function requireMutation(value: unknown): EditorMutation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DomainError(400, "document-mutation-invalid", "A document mutation is required");
  const mutation = value as EditorMutation;
  const kinds: EditorMutation["kind"][] = ["layer.add", "layer.update", "layer.remove", "layer.reorder", "artboard.add", "artboard.update", "artboard.remove", "mask.update", "document.rename"];
  if (!kinds.includes(mutation.kind)) throw new DomainError(400, "document-mutation-invalid", "Document mutation kind is not supported");
  return mutation;
}

function optionalId(value: unknown, field: string): string | undefined {
  return value === undefined || value === null || value === "" ? undefined : requireId(value, field);
}

function optionalDimension(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const result = Number(value);
  if (!Number.isFinite(result) || result <= 0 || result > 100_000) throw new DomainError(400, "artboard-size-invalid", "Use an artboard dimension from 1 to 100,000 pixels");
  return result;
}

function requiredRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new DomainError(400, "document-revision-invalid", "A non-negative base revision is required");
  return Number(value);
}

function intendedUseKind(value: unknown): "source" | "digital" | "print" | "custom" {
  return value === "source" || value === "digital" || value === "print" || value === "custom" ? value : "digital";
}

function intendedUseLabel(value: "source" | "digital" | "print" | "custom") {
  return { source: "Source size", digital: "Digital design", print: "Print design", custom: "Custom size" }[value];
}
