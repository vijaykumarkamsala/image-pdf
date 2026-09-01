import { Inject, Injectable, OnApplicationShutdown } from "@nestjs/common";
import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import type { EditorDocumentSnapshot, EditorMutation, LayerRecord, Permission, SharedAssetRecord } from "ipw-contracts-ts/product";

import { DomainError, requireId, requireText } from "../../kernel/errors.js";
import {
  PRODUCT_REPOSITORY,
  RUNTIME_VALUES,
  type CommandContext,
  type ProductKernelRepository,
} from "../../kernel/product.types.js";
import { requestDigest } from "../../kernel/runtime.js";
import type { RuntimeValues } from "../../kernel/runtime.js";
import { IdentityBoundary } from "../identity/identity.service.js";
import { INTAKE_REPOSITORY, type IntakeRepository, type StoredUploadSession } from "../intake/intake.types.js";
import { PRIVATE_OBJECT_STORE, type PrivateObjectStore } from "../intake/private-object-store.js";
import { sha256, validateSnapshot } from "./document-model.js";
import { DOCUMENT_REPOSITORY, type DocumentRepository, type VerifiedRasterSource } from "./documents.types.js";
import { requiresGeneratedPreview, STUDIO_EDITABLE_MEDIA_TYPES, STUDIO_SYNC_PREVIEW_POLICY } from "./studio-format-policy.js";

type Headers = Record<string, string | string[] | undefined>;
type Body = Record<string, unknown>;

@Injectable()
export class DocumentsService implements OnApplicationShutdown {
  constructor(
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(PRODUCT_REPOSITORY) private readonly product: ProductKernelRepository,
    @Inject(INTAKE_REPOSITORY) private readonly intake: IntakeRepository,
    @Inject(PRIVATE_OBJECT_STORE) private readonly objects: PrivateObjectStore,
    @Inject(RUNTIME_VALUES) private readonly runtime: RuntimeValues,
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

  async sources(headers: Headers, workspaceId: string) {
    const access = await this.access(headers, workspaceId, "document.create");
    const [files, uploads] = await Promise.all([
      this.product.listFiles(access.principal.actorId, access.workspaceId),
      this.intake.listWorkspaceUploads(access.workspaceId),
    ]);
    const candidates = files.flatMap((file) => {
      const stored = uploads.find((item) => item.record.file_id === file.file_id
        || (item.record.asset_original_id === file.asset_original_id
          && item.record.source_version_id === file.current_source_version_id));
      const facts = stored?.record.source_facts;
      if (!facts || stored?.record.state !== "ready") return [];
      const editable = STUDIO_EDITABLE_MEDIA_TYPES.has(facts.detected_media_type);
      return [{
        schema_version: PRODUCT_SCHEMA_VERSION,
        file_id: file.file_id,
        display_name: file.display_name,
        media_type: facts.detected_media_type,
        byte_size: facts.byte_size,
        width: facts.width,
        height: facts.height,
        editable,
        compatibility_message: editable
          ? "Editable in Image & Graphic Studio"
          : "Stored safely, but this format is not editable in Studio",
        requires_generated_preview: editable && requiresGeneratedPreview({
          byteSize: facts.byte_size, width: facts.width ?? null, height: facts.height ?? null,
        }),
      }];
    });
    return { schema_version: PRODUCT_SCHEMA_VERSION, sources: candidates };
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
    if (!result.replayed) await this.auditUnlessAtomic(context, access.workspaceId, "document.created", result.value.document.document_id);
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
      operationId: optionalId(body["operation_id"], "operation id"),
      leaseTokenHash: this.leaseTokenHash(headers),
    });
    if (!result.replayed) await this.auditUnlessAtomic(context, access.workspaceId, mutation.kind, id);
    return { schema_version: PRODUCT_SCHEMA_VERSION, mutation: result };
  }

  async addAsset(headers: Headers, workspaceId: string, documentId: string, body: Body) {
    const access = await this.access(headers, workspaceId, "document.edit");
    const id = requireId(documentId, "document id");
    const fileId = requireId(body["file_id"], "file id");
    const artboardId = requireId(body["artboard_id"], "artboard id");
    const baseRevision = requiredRevision(body["base_revision"]);
    const source = await this.verifiedSource(access.principal.actorId, access.workspaceId, fileId);
    if (source.requiresPreview) {
      throw new DomainError(409, "editor-asset-preview-required", "This source needs a generated preview before it can be added as another asset");
    }
    const current = await this.documents.get(access.principal.actorId, access.workspaceId, id);
    if (!current) throw new DomainError(404, "document-not-found", "Document was not found");
    const artboard = current.snapshot.artboards.find((item) => item.artboard_id === artboardId);
    if (!artboard) throw new DomainError(404, "artboard-not-found", "Artboard was not found");
    const sharedAssetId = this.runtime.id("shared-asset");
    const sharedAsset: SharedAssetRecord = {
      shared_asset_id: sharedAssetId,
      workspace_id: access.workspaceId,
      kind: "raster",
      name: source.displayName,
      asset_original_id: source.assetOriginalId,
      source_version_id: source.sourceVersionId,
      object_reference_id: source.objectReferenceId,
      preview_object_reference_id: null,
      linked_by_default: true,
    };
    const sourceWidth = source.width ?? artboard.width;
    const sourceHeight = source.height ?? artboard.height;
    const fit = Math.min(1, artboard.width / sourceWidth, artboard.height / sourceHeight);
    const width = Math.max(1, sourceWidth * fit);
    const height = Math.max(1, sourceHeight * fit);
    const siblings = (current.snapshot.layers ?? []).filter((item) => item.artboard_id === artboardId && !item.parent_layer_id);
    const layer: LayerRecord = {
      layer_id: this.runtime.id("layer"),
      artboard_id: artboardId,
      parent_layer_id: null,
      layer_type: "raster_image",
      name: source.displayName,
      order: siblings.length,
      visible: true,
      locked: false,
      opacity: 1,
      blend_mode: "normal",
      transform: {
        x: (artboard.width - width) / 2,
        y: (artboard.height - height) / 2,
        width,
        height,
        rotation_degrees: 0,
        scale_x: 1,
        scale_y: 1,
        skew_x_degrees: 0,
        skew_y_degrees: 0,
        flip_x: false,
        flip_y: false,
      },
      shared_style_ids: [],
      raster: {
        shared_asset_id: sharedAssetId,
        instance_mode: "linked",
        crop: { left: 0, top: 0, right: 1, bottom: 1 },
        adjustments: { exposure: 0, brightness: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, sharpness: 0 },
        mask_ids: [],
      },
      vector: null,
      rich_text: null,
      shape: null,
      group: null,
      extension_payload: {},
    };
    const mutation: EditorMutation = { kind: "asset.add", target_id: layer.layer_id, shared_asset: sharedAsset, layer, properties: {} };
    const context = this.command(headers, access.principal, "document.asset.add", {
      workspaceId: access.workspaceId, documentId: id, baseRevision, fileId, artboardId,
    });
    const result = await this.documents.mutate(context, {
      workspaceId: access.workspaceId,
      documentId: id,
      baseRevision,
      mutation,
      operationId: optionalId(body["operation_id"], "operation id"),
      leaseTokenHash: this.leaseTokenHash(headers),
    });
    if (!result.replayed) await this.auditUnlessAtomic(context, access.workspaceId, "document.asset.added", id);
    return { schema_version: PRODUCT_SCHEMA_VERSION, mutation: result };
  }

  async acquireLease(headers: Headers, workspaceId: string, documentId: string) {
    const access = await this.access(headers, workspaceId, "document.edit");
    const id = requireId(documentId, "document id");
    const context = this.command(headers, access.principal, "document.lease.acquire", { workspaceId: access.workspaceId, documentId: id });
    const grant = await this.documents.acquireLease(context, access.workspaceId, id);
    await this.auditUnlessAtomic(context, access.workspaceId, "document.lease.acquired", id);
    return { schema_version: PRODUCT_SCHEMA_VERSION, grant };
  }

  async heartbeat(headers: Headers, workspaceId: string, documentId: string) {
    const access = await this.access(headers, workspaceId, "document.edit");
    const id = requireId(documentId, "document id");
    const context = this.command(headers, access.principal, "document.lease.heartbeat", { workspaceId: access.workspaceId, documentId: id });
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      lease: await this.documents.heartbeatLease(context, access.workspaceId, id, this.leaseTokenHash(headers)),
    };
  }

  async leaseStatus(headers: Headers, workspaceId: string, documentId: string) {
    const access = await this.access(headers, workspaceId, "document.edit");
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      status: await this.documents.leaseStatus(
        access.principal.actorId,
        access.workspaceId,
        requireId(documentId, "document id"),
        this.leaseTokenHash(headers),
      ),
    };
  }

  async releaseLease(headers: Headers, workspaceId: string, documentId: string) {
    const access = await this.access(headers, workspaceId, "document.edit");
    const id = requireId(documentId, "document id");
    const context = this.command(headers, access.principal, "document.lease.release", { workspaceId: access.workspaceId, documentId: id });
    const lease = await this.documents.releaseLease(context, access.workspaceId, id, this.leaseTokenHash(headers));
    await this.auditUnlessAtomic(context, access.workspaceId, "document.lease.released", id);
    return { schema_version: PRODUCT_SCHEMA_VERSION, lease };
  }

  async takeover(headers: Headers, workspaceId: string, documentId: string, body: Body) {
    const access = await this.access(headers, workspaceId, "document.edit");
    const id = requireId(documentId, "document id");
    if (body["force"] === true) throw new DomainError(400, "force-takeover-route-required", "Use the authorised force takeover action");
    const reason = optionalReason(body["reason"], "Takeover requested");
    const context = this.command(headers, access.principal, "document.lease.takeover.request", { workspaceId: access.workspaceId, documentId: id, reason });
    const result = await this.documents.requestTakeover(context, access.workspaceId, id, reason);
    await this.auditUnlessAtomic(context, access.workspaceId, result.status === "acquired" ? "document.lease.acquired-after-expiry" : "document.lease.takeover-requested", id);
    return { schema_version: PRODUCT_SCHEMA_VERSION, takeover: result };
  }

  async denyTakeover(headers: Headers, workspaceId: string, documentId: string, body: Body) {
    const access = await this.access(headers, workspaceId, "document.edit");
    const id = requireId(documentId, "document id");
    const reason = optionalReason(body["reason"], "Takeover request denied");
    const context = this.command(headers, access.principal, "document.lease.takeover.deny", { workspaceId: access.workspaceId, documentId: id, reason });
    const lease = await this.documents.denyTakeover(context, access.workspaceId, id, this.leaseTokenHash(headers), reason);
    await this.auditUnlessAtomic(context, access.workspaceId, "document.lease.takeover-denied", id);
    return { schema_version: PRODUCT_SCHEMA_VERSION, lease };
  }

  async forceTakeover(headers: Headers, workspaceId: string, documentId: string, body: Body) {
    const access = await this.access(headers, workspaceId, "document.lease.takeover");
    const id = requireId(documentId, "document id");
    const reason = requireText(body["reason"], "force takeover reason", 500);
    const context = this.command(headers, access.principal, "document.lease.takeover.force", { workspaceId: access.workspaceId, documentId: id, reason });
    const result = await this.documents.forceTakeover(context, access.workspaceId, id, reason);
    await this.auditUnlessAtomic(context, access.workspaceId, "document.lease.force-takeover", id);
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
    if (!result.replayed) await this.auditUnlessAtomic(context, access.workspaceId, "document.version.created", id);
    return { schema_version: PRODUCT_SCHEMA_VERSION, version: result.value, replayed: result.replayed };
  }

  async restore(headers: Headers, workspaceId: string, documentId: string, versionId: string) {
    const access = await this.access(headers, workspaceId, "document.version");
    const id = requireId(documentId, "document id");
    const version = requireId(versionId, "version id");
    const context = this.command(headers, access.principal, "document.restore", { workspaceId: access.workspaceId, documentId: id, versionId: version });
    const result = await this.documents.restoreVersion(context, access.workspaceId, id, version, this.leaseTokenHash(headers));
    if (!result.replayed) await this.auditUnlessAtomic(context, access.workspaceId, "document.version.restored", id);
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
    const recoveredSnapshot = body["recovered_snapshot"] === undefined
      ? undefined
      : requireRecoveredSnapshot(body["recovered_snapshot"], id);
    const context = this.command(headers, access.principal, "document.save-as", {
      workspaceId: access.workspaceId, documentId: id, name, projectId, recoveredSnapshot,
    });
    const result = await this.documents.saveAs(
      context, access.workspaceId, id, name, projectId, access.defaultFilesId, recoveredSnapshot,
    );
    if (!result.replayed) await this.auditUnlessAtomic(context, access.workspaceId, "document.saved-as", result.value.document.document_id);
    return { schema_version: PRODUCT_SCHEMA_VERSION, editor: result.value, replayed: result.replayed };
  }

  async move(headers: Headers, workspaceId: string, documentId: string, body: Body) {
    const access = await this.access(headers, workspaceId, "document.edit");
    const id = requireId(documentId, "document id");
    const projectId = optionalId(body["project_id"], "project id");
    if (projectId) {
      const projects = await this.product.listProjects(access.principal.actorId, access.workspaceId);
      if (!projects.projects.some((item) => item.project_id === projectId)) {
        throw new DomainError(404, "project-not-found", "Project was not found");
      }
    }
    const context = this.command(headers, access.principal, "document.move", {
      workspaceId: access.workspaceId, documentId: id, projectId,
    });
    const result = await this.documents.move(context, access.workspaceId, id, projectId, access.defaultFilesId);
    if (!result.replayed) await this.auditUnlessAtomic(context, access.workspaceId, "document.moved", id);
    return { schema_version: PRODUCT_SCHEMA_VERSION, document: result.value, replayed: result.replayed };
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
    if (editor.document.preview_state === "preparing") throw new DomainError(409, "editor-preview-preparing", "The safe editor preview is still being prepared");
    if (editor.document.preview_state === "failed") throw new DomainError(409, "editor-preview-failed", "The safe editor preview could not be prepared");
    if (editor.document.preview_state === "cancelled") throw new DomainError(409, "editor-preview-cancelled", "Preview preparation was cancelled");
    if (requiresGeneratedPreview({ byteSize, width: stored.record.source_facts!.width ?? null, height: stored.record.source_facts!.height ?? null })) {
      const preview = await this.documents.previewDelivery(access.principal.actorId, access.workspaceId, documentId);
      if (!preview) throw new DomainError(409, "editor-preview-unavailable", "The safe editor preview is not available yet");
      return {
        bytes: await this.objects.read({ ownerScope: access.workspaceId, objectKey: preview.objectKey, zone: "derivative" }, preview.byteSize),
        mediaType: preview.mediaType,
      };
    }
    if (byteSize > STUDIO_SYNC_PREVIEW_POLICY.maxCompressedBytes) throw new DomainError(413, "editor-source-too-large", "The source exceeds the synchronous editor limit");
    return { bytes: await this.objects.read(stored.quarantineRef, byteSize), mediaType: stored.record.source_facts!.detected_media_type };
  }

  async assetSource(headers: Headers, workspaceId: string, documentId: string, sharedAssetId: string) {
    const access = await this.access(headers, workspaceId, "document.read");
    const editor = await this.documents.get(access.principal.actorId, access.workspaceId, requireId(documentId, "document id"));
    if (!editor) throw new DomainError(404, "document-not-found", "Document was not found");
    const asset = (editor.snapshot.shared_assets ?? []).find((item) => item.shared_asset_id === requireId(sharedAssetId, "shared asset id"));
    if (!asset || asset.workspace_id !== access.workspaceId || !asset.asset_original_id || !asset.source_version_id) {
      throw new DomainError(404, "document-asset-not-found", "Document asset was not found");
    }
    const files = await this.product.listFiles(access.principal.actorId, access.workspaceId);
    const file = files.find((item) => item.asset_original_id === asset.asset_original_id && item.current_source_version_id === asset.source_version_id);
    if (!file) throw new DomainError(404, "document-asset-not-found", "Document asset was not found");
    const { source, stored } = await this.verifiedSourceWithUpload(access.principal.actorId, access.workspaceId, file.file_id);
    if (source.requiresPreview || source.byteSize > STUDIO_SYNC_PREVIEW_POLICY.maxCompressedBytes) {
      const isInitialSource = editor.document.source_asset_original_id === asset.asset_original_id
        && editor.document.source_version_id === asset.source_version_id;
      const preview = isInitialSource
        ? await this.documents.previewDelivery(access.principal.actorId, access.workspaceId, documentId)
        : null;
      if (!preview) throw new DomainError(409, "editor-asset-preview-required", "This asset requires a bounded generated preview");
      return {
        bytes: await this.objects.read({ ownerScope: access.workspaceId, objectKey: preview.objectKey, zone: "derivative" }, preview.byteSize),
        mediaType: preview.mediaType,
      };
    }
    return {
      bytes: await this.objects.read(stored.quarantineRef, source.byteSize),
      mediaType: source.mediaType,
    };
  }

  async onApplicationShutdown(): Promise<void> { await this.documents.close(); }

  private async history(headers: Headers, workspaceId: string, documentId: string, direction: "undo" | "redo") {
    const access = await this.access(headers, workspaceId, "document.edit");
    const id = requireId(documentId, "document id");
    const context = this.command(headers, access.principal, `document.${direction}`, { workspaceId: access.workspaceId, documentId: id });
    const result = direction === "undo"
      ? await this.documents.undo(context, access.workspaceId, id, this.leaseTokenHash(headers))
      : await this.documents.redo(context, access.workspaceId, id, this.leaseTokenHash(headers));
    if (!result.replayed) await this.auditUnlessAtomic(context, access.workspaceId, `document.${direction}`, id);
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
    if (!STUDIO_EDITABLE_MEDIA_TYPES.has(facts.detected_media_type)) {
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
        byteSize: facts.byte_size,
        requiresPreview: requiresGeneratedPreview({ byteSize: facts.byte_size, width: facts.width ?? null, height: facts.height ?? null }),
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

  private auditUnlessAtomic(context: CommandContext, workspaceId: string, action: string, resourceId: string) {
    return this.documents.recordsMutationsAtomically
      ? Promise.resolve()
      : this.audit(context, workspaceId, action, resourceId);
  }
}

function optionalReason(value: unknown, fallback: string): string {
  return value === undefined || value === null || value === ""
    ? fallback
    : requireText(value, "takeover reason", 500);
}

function requireRecoveredSnapshot(value: unknown, documentId: string): EditorDocumentSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError(400, "recovered-snapshot-invalid", "A native recovered document snapshot is required");
  }
  const snapshot = structuredClone(value) as EditorDocumentSnapshot;
  if (snapshot.document_id !== documentId) {
    throw new DomainError(400, "recovered-snapshot-invalid", "Recovered state belongs to another document");
  }
  validateSnapshot(snapshot);
  return snapshot;
}

function requireMutation(value: unknown): EditorMutation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DomainError(400, "document-mutation-invalid", "A document mutation is required");
  const mutation = value as EditorMutation;
  const kinds: EditorMutation["kind"][] = ["layer.add", "layer.update", "layer.remove", "layer.reorder", "layer.group", "layer.ungroup", "artboard.add", "artboard.update", "artboard.remove", "mask.update", "style.upsert", "style.detach", "document.rename"];
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
