import { randomBytes } from "node:crypto";

import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import type {
  DocumentReadModel,
  DocumentVersionRecord,
  EditorDocumentRecord,
  EditorDocumentSnapshot,
  EditorLeaseGrant,
  EditorLeaseRecord,
  EditorMutation,
  ImportCompatibilityReport,
  LeaseTakeoverResult,
} from "ipw-contracts-ts/product";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

import { DomainError } from "../../kernel/errors.js";
import { runMigrations } from "../../kernel/migrations.js";
import type { CommandContext } from "../../kernel/product.types.js";
import type { RuntimeValues } from "../../kernel/runtime.js";
import {
  addSeconds,
  applyMutation,
  DOCUMENT_CHECKPOINT_INTERVAL,
  DOCUMENT_HISTORY_LIMIT,
  EDITOR_LEASE_GRACE_SECONDS,
  EDITOR_LEASE_SECONDS,
  initialSnapshot,
  sha256,
  snapshotDigest,
  stableJson,
} from "./document-model.js";
import type {
  CreateDocumentInput,
  DocumentCommandResult,
  DocumentHistoryResult,
  EditorLeaseStatus,
  DocumentMutationInput,
  DocumentMutationResult,
  DocumentRepository,
  DocumentPreviewDelivery,
} from "./documents.types.js";

export class PostgresDocumentRepository implements DocumentRepository {
  readonly recordsMutationsAtomically = true;

  constructor(private readonly pool: Pool, private readonly runtime: RuntimeValues) {}

  static async connect(connectionString: string, runtime: RuntimeValues, migrate = false) {
    const pool = new Pool({ connectionString, max: 5 });
    if (migrate) await runMigrations(pool);
    return new PostgresDocumentRepository(pool, runtime);
  }

  async create(context: CommandContext, input: CreateDocumentInput): Promise<DocumentCommandResult<DocumentReadModel>> {
    return this.command(context, "document.create", async (client) => {
      const documentId = this.runtime.id("document");
      const versionId = this.runtime.id("document-version");
      const now = this.runtime.now();
      const snapshot = initialSnapshot(this.runtime, documentId, input);
      const locationKind = input.projectId ? "project" : "default_files";
      const previewJobId = input.source?.requiresPreview ? this.runtime.id("job") : null;
      await client.query(
        `INSERT INTO editor_documents(document_id,workspace_id,project_id,location_kind,default_files_id,kind,name,
         source_file_id,source_asset_original_id,source_version_id,current_version_id,current_revision,current_snapshot,
         history_cursor,created_by_actor_id,created_at,updated_at,preview_state,preview_job_id)
         VALUES($1,$2,$3,$4,$5,'graphic',$6,$7,$8,$9,$10,0,$11,0,$12,$13,$13,$14,$15)`,
        [documentId, input.workspaceId, input.projectId ?? null, locationKind, input.projectId ? null : input.defaultFilesId,
          input.name, input.source?.fileId ?? null, input.source?.assetOriginalId ?? null, input.source?.sourceVersionId ?? null,
          versionId, snapshot, context.principal.actorId, now, previewJobId ? "preparing" : "not_required", previewJobId],
      );
      await this.insertVersion(client, {
        id: versionId, documentId, sequence: 1, snapshot, kind: "initial", name: "Initial",
        actorId: context.principal.actorId, now,
      });
      if (input.source) await this.insertCompatibility(client, documentId, input, now);
      if (previewJobId) {
        await this.enqueuePreview(client, context, input.workspaceId, documentId, previewJobId, now);
      }
      return (await this.read(client, input.workspaceId, documentId))!;
    }, (value) => ({ workspaceId: input.workspaceId, action: "document.created", resourceId: value.document.document_id }));
  }

  async list(actorId: string, workspaceId: string): Promise<EditorDocumentRecord[]> {
    void actorId;
    const result = await this.pool.query("SELECT * FROM editor_documents WHERE workspace_id=$1 ORDER BY updated_at DESC", [workspaceId]);
    return result.rows.map(documentRecord);
  }

  async get(actorId: string, workspaceId: string, documentId: string): Promise<DocumentReadModel | null> {
    void actorId;
    return this.read(this.pool, workspaceId, documentId, false);
  }

  async previewDelivery(actorId: string, workspaceId: string, documentId: string): Promise<DocumentPreviewDelivery | null> {
    void actorId;
    const result = await this.pool.query(
      `SELECT object.object_key,object.media_type,object.byte_size
       FROM editor_documents document
       JOIN preview_provenance preview ON preview.preview_id=document.current_preview_id
       JOIN object_references object ON object.object_reference_id=preview.object_reference_id
         AND object.workspace_id=document.workspace_id
       WHERE document.workspace_id=$1 AND document.document_id=$2 AND document.preview_state='ready'
         AND preview.zoom_level='workspace'`,
      [workspaceId, documentId],
    );
    const row = result.rows[0];
    return row ? { objectKey: String(row["object_key"]), mediaType: String(row["media_type"]), byteSize: Number(row["byte_size"]) } : null;
  }

  async mutate(context: CommandContext, input: DocumentMutationInput): Promise<DocumentMutationResult> {
    const result = await this.command(context, "document.mutate", async (client) => {
      const row = await this.lockDocument(client, input.workspaceId, input.documentId);
      await this.requireLease(client, context.principal.actorId, input.workspaceId, input.documentId, input.leaseTokenHash);
      const revision = Number(row["current_revision"]);
      if (revision !== input.baseRevision) {
        throw new DomainError(409, "document-revision-conflict", "This document changed in another editor. Reload before continuing");
      }
      const before = row["current_snapshot"] as EditorDocumentSnapshot;
      const after = applyMutation(before, input.mutation);
      const operationId = input.operationId ?? this.runtime.id("document-operation");
      const now = this.runtime.now();
      const cursor = Number(row["history_cursor"]);
      await client.query("DELETE FROM document_history_entries WHERE document_id=$1 AND history_position>$2", [input.documentId, cursor]);
      await this.insertOperation(client, operationId, input.documentId, revision, input.mutation, context, now);
      const position = cursor + 1;
      await client.query(
        `INSERT INTO document_history_entries(history_entry_id,document_id,history_position,operation_id,before_snapshot,after_snapshot,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [this.runtime.id("history"), input.documentId, position, operationId, before, after, now],
      );
      let nextCursor = position;
      if (position > DOCUMENT_HISTORY_LIMIT) {
        const trimmed = position - DOCUMENT_HISTORY_LIMIT;
        await client.query(
          "DELETE FROM document_history_entries WHERE document_id=$1 AND history_position<=$2",
          [input.documentId, trimmed],
        );
        await client.query(
          "UPDATE document_history_entries SET history_position=history_position-$2 WHERE document_id=$1",
          [input.documentId, trimmed],
        );
        nextCursor = DOCUMENT_HISTORY_LIMIT;
      }
      await client.query(
        "UPDATE editor_documents SET current_revision=$1,current_snapshot=$2,history_cursor=$3,updated_at=$4 WHERE document_id=$5",
        [after.revision, after, nextCursor, now, input.documentId],
      );
      const checkpoint = after.revision % DOCUMENT_CHECKPOINT_INTERVAL === 0
        ? await this.appendVersion(client, input.documentId, after, "autosave_checkpoint", `Autosave ${after.revision}`, context.principal.actorId, now)
        : null;
      const record = documentRecord((await client.query("SELECT * FROM editor_documents WHERE document_id=$1", [input.documentId])).rows[0]!);
      return { document: record, snapshot: after, operationId, checkpoint };
    }, () => ({ workspaceId: input.workspaceId, action: input.mutation.kind, resourceId: input.documentId }));
    return { ...result.value, replayed: result.replayed };
  }

  async undo(context: CommandContext, workspaceId: string, documentId: string, leaseTokenHash: string) {
    return this.historyCommand(context, "document.undo", workspaceId, documentId, leaseTokenHash, "undo");
  }

  async redo(context: CommandContext, workspaceId: string, documentId: string, leaseTokenHash: string) {
    return this.historyCommand(context, "document.redo", workspaceId, documentId, leaseTokenHash, "redo");
  }

  async createVersion(context: CommandContext, workspaceId: string, documentId: string, name: string) {
    return this.command(context, "document.version", async (client) => {
      const row = await this.lockDocument(client, workspaceId, documentId);
      return this.appendVersion(
        client, documentId, row["current_snapshot"] as EditorDocumentSnapshot,
        "named", name, context.principal.actorId, this.runtime.now(),
      );
    }, () => ({ workspaceId, action: "document.version.created", resourceId: documentId }));
  }

  async restoreVersion(context: CommandContext, workspaceId: string, documentId: string, versionId: string, leaseTokenHash: string) {
    return this.command(context, "document.restore", async (client) => {
      const row = await this.lockDocument(client, workspaceId, documentId);
      await this.requireLease(client, context.principal.actorId, workspaceId, documentId, leaseTokenHash);
      const version = await client.query("SELECT snapshot FROM document_versions WHERE document_id=$1 AND document_version_id=$2", [documentId, versionId]);
      if (!version.rows[0]) throw new DomainError(404, "document-version-not-found", "Document version was not found");
      const before = row["current_snapshot"] as EditorDocumentSnapshot;
      const after = structuredClone(version.rows[0]["snapshot"] as EditorDocumentSnapshot);
      const revision = Number(row["current_revision"]);
      after.revision = revision + 1;
      const operationId = this.runtime.id("document-operation");
      const now = this.runtime.now();
      const mutation: EditorMutation = { schema_version: PRODUCT_SCHEMA_VERSION, kind: "document.rename", target_id: null, properties: { restore_version_id: versionId } };
      await this.insertOperation(client, operationId, documentId, revision, mutation, context, now);
      const cursor = Number(row["history_cursor"]);
      await client.query("DELETE FROM document_history_entries WHERE document_id=$1 AND history_position>$2", [documentId, cursor]);
      await client.query(
        `INSERT INTO document_history_entries(history_entry_id,document_id,history_position,operation_id,before_snapshot,after_snapshot,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [this.runtime.id("history"), documentId, cursor + 1, operationId, before, after, now],
      );
      let nextCursor = cursor + 1;
      if (nextCursor > DOCUMENT_HISTORY_LIMIT) {
        const trimmed = nextCursor - DOCUMENT_HISTORY_LIMIT;
        await client.query("DELETE FROM document_history_entries WHERE document_id=$1 AND history_position<=$2", [documentId, trimmed]);
        await client.query("UPDATE document_history_entries SET history_position=history_position-$2 WHERE document_id=$1", [documentId, trimmed]);
        nextCursor = DOCUMENT_HISTORY_LIMIT;
      }
      await client.query("UPDATE editor_documents SET current_revision=$1,current_snapshot=$2,history_cursor=$3,updated_at=$4 WHERE document_id=$5", [after.revision, after, nextCursor, now, documentId]);
      await this.appendVersion(client, documentId, after, "restore", `Restored ${versionId}`, context.principal.actorId, now, versionId);
      return (await this.read(client, workspaceId, documentId))!;
    }, () => ({ workspaceId, action: "document.version.restored", resourceId: documentId }));
  }

  async saveAs(
    context: CommandContext,
    workspaceId: string,
    documentId: string,
    name: string,
    projectId: string | undefined,
    defaultFilesId: string,
    recoveredSnapshot?: EditorDocumentSnapshot,
  ) {
    return this.command(context, "document.save-as", async (client) => {
      const source = await this.lockDocument(client, workspaceId, documentId);
      const nextId = this.runtime.id("document");
      const versionId = this.runtime.id("document-version");
      const now = this.runtime.now();
      const authoritativeSnapshot = source["current_snapshot"] as EditorDocumentSnapshot;
      const snapshot = structuredClone(recoveredSnapshot ?? authoritativeSnapshot);
      if (snapshot.document_id !== documentId) {
        throw new DomainError(400, "recovered-snapshot-invalid", "Recovered state belongs to another document");
      }
      if (stableJson(snapshot.shared_assets ?? []) !== stableJson(authoritativeSnapshot.shared_assets ?? [])) {
        throw new DomainError(409, "recovered-assets-conflict", "Recovered edits cannot replace authorised document assets");
      }
      snapshot.document_id = nextId;
      snapshot.revision = 0;
      const sourcePreviewState = String(source["preview_state"] ?? "not_required");
      const cloneReadyPreview = sourcePreviewState === "ready" && Boolean(source["current_preview_id"]);
      const nextPreviewJobId = sourcePreviewState === "not_required"
        ? null
        : cloneReadyPreview
          ? String(source["preview_job_id"])
          : this.runtime.id("job");
      await client.query(
        `INSERT INTO editor_documents(document_id,workspace_id,project_id,location_kind,default_files_id,kind,name,
         source_file_id,source_asset_original_id,source_version_id,current_version_id,current_revision,current_snapshot,
         history_cursor,created_by_actor_id,created_at,updated_at,preview_state,preview_job_id)
         VALUES($1,$2,$3,$4,$5,'graphic',$6,$7,$8,$9,$10,0,$11,0,$12,$13,$13,$14,$15)`,
        [nextId, workspaceId, projectId ?? null, projectId ? "project" : "default_files", projectId ? null : defaultFilesId,
          name, source["source_file_id"], source["source_asset_original_id"], source["source_version_id"], versionId,
          snapshot, context.principal.actorId, now, cloneReadyPreview ? "ready" : nextPreviewJobId ? "preparing" : "not_required", nextPreviewJobId],
      );
      await this.insertVersion(client, {
        id: versionId, documentId: nextId, sequence: 1, snapshot, kind: "save_as", name,
        actorId: context.principal.actorId, now, basedOn: String(source["current_version_id"]),
      });
      await client.query(
        `INSERT INTO import_compatibility_reports(compatibility_report_id,workspace_id,document_id,source_file_id,
         source_version_id,source_kind,state,source_preserved,sanitisation_required,preserved_structures,
         unsupported_structures,warnings,created_at)
         SELECT $1,workspace_id,$2,source_file_id,source_version_id,source_kind,state,source_preserved,
           sanitisation_required,preserved_structures,unsupported_structures,warnings,$3
         FROM import_compatibility_reports WHERE document_id=$4 ORDER BY created_at DESC LIMIT 1`,
        [this.runtime.id("compatibility"), nextId, now, documentId],
      );
      if (cloneReadyPreview) {
        const previews = await client.query(
          "SELECT * FROM preview_provenance WHERE document_id=$1 ORDER BY zoom_level",
          [documentId],
        );
        let workspacePreviewId: string | null = null;
        for (const preview of previews.rows) {
          const previewId = this.runtime.id("preview");
          await client.query(
            `INSERT INTO preview_provenance(preview_id,document_id,document_version_id,source_version_id,
             object_reference_id,job_id,trace_id,processor_name,processor_version,zoom_level,source_sha256,
             sha256,width,height,colour_decision,metadata_decision,authoritative,created_at)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,false,$17)`,
            [previewId, nextId, versionId, preview["source_version_id"], preview["object_reference_id"],
              preview["job_id"], context.traceId, preview["processor_name"], preview["processor_version"],
              preview["zoom_level"], preview["source_sha256"], preview["sha256"], preview["width"],
              preview["height"], preview["colour_decision"], preview["metadata_decision"], now],
          );
          if (preview["zoom_level"] === "workspace") workspacePreviewId = previewId;
        }
        if (!workspacePreviewId) throw new Error("ready source document has no workspace preview");
        await client.query("UPDATE editor_documents SET current_preview_id=$1 WHERE document_id=$2", [workspacePreviewId, nextId]);
      } else if (nextPreviewJobId) {
        await this.enqueuePreview(client, context, workspaceId, nextId, nextPreviewJobId, now);
      }
      return (await this.read(client, workspaceId, nextId))!;
    }, (value) => ({ workspaceId, action: "document.saved-as", resourceId: value.document.document_id }));
  }

  async move(context: CommandContext, workspaceId: string, documentId: string, projectId: string | undefined, defaultFilesId: string) {
    return this.command(context, "document.move", async (client) => {
      await this.lockDocument(client, workspaceId, documentId);
      const result = await client.query(
        `UPDATE editor_documents SET project_id=$1,location_kind=$2,default_files_id=$3,updated_at=$4
         WHERE workspace_id=$5 AND document_id=$6 RETURNING *`,
        [projectId ?? null, projectId ? "project" : "default_files", projectId ? null : defaultFilesId,
          this.runtime.now(), workspaceId, documentId],
      );
      return documentRecord(result.rows[0]!);
    }, () => ({ workspaceId, action: "document.moved", resourceId: documentId }));
  }

  async acquireLease(context: CommandContext, workspaceId: string, documentId: string): Promise<EditorLeaseGrant> {
    const result = await this.command(context, "document.lease.acquire", async (client) => {
      await this.lockDocument(client, workspaceId, documentId);
      const existing = await this.lockLease(client, workspaceId, documentId);
      const now = this.runtime.now();
      if (existing && existing["state"] !== "released" && new Date(now) <= new Date(existing["grace_expires_at"] as Date)) {
        throw new DomainError(409, "document-lease-held", `${String(existing["actor_display_name"])} is currently editing this document`);
      }
      if (existing && existing["state"] !== "released") {
        await this.recordLeaseEvent(client, context, workspaceId, documentId, existing, "expired");
        await this.recordMutation(client, context, workspaceId, "document.lease.expired", documentId);
      }
      return this.issueLease(client, context, workspaceId, documentId, now);
    }, () => ({ workspaceId, action: "document.lease.acquired", resourceId: documentId }));
    return result.value;
  }

  async heartbeatLease(context: CommandContext, workspaceId: string, documentId: string, leaseTokenHash: string): Promise<EditorLeaseRecord> {
    const result = await this.command(context, "document.lease.heartbeat", async (client) => {
      await this.lockDocument(client, workspaceId, documentId);
      const current = await this.requireLease(client, context.principal.actorId, workspaceId, documentId, leaseTokenHash, true);
      const now = this.runtime.now();
      const expires = addSeconds(now, EDITOR_LEASE_SECONDS);
      const grace = addSeconds(expires, EDITOR_LEASE_GRACE_SECONDS);
      const updated = await client.query(
        `UPDATE document_leases lease SET state='active',heartbeat_at=$1,expires_at=$2,grace_expires_at=$3
         FROM editor_documents document WHERE lease.document_id=$4 AND document.document_id=lease.document_id
         AND document.workspace_id=$5 RETURNING lease.*`,
        [now, expires, grace, documentId, workspaceId],
      );
      await this.recordLeaseEvent(client, context, workspaceId, documentId, current, "heartbeat");
      return leaseRecord(updated.rows[0]!);
    });
    return result.value;
  }

  async releaseLease(context: CommandContext, workspaceId: string, documentId: string, leaseTokenHash: string): Promise<EditorLeaseRecord> {
    const result = await this.command(context, "document.lease.release", async (client) => {
      await this.lockDocument(client, workspaceId, documentId);
      const current = await this.requireLease(client, context.principal.actorId, workspaceId, documentId, leaseTokenHash, true);
      const now = this.runtime.now();
      const updated = await client.query(
        `UPDATE document_leases lease SET state='released',expires_at=$1,grace_expires_at=$1,
         takeover_request_id=NULL,takeover_requested_by_actor_id=NULL,takeover_requested_at=NULL,takeover_request_reason=NULL
         FROM editor_documents document WHERE lease.document_id=$2 AND document.document_id=lease.document_id
         AND document.workspace_id=$3 RETURNING lease.*`,
        [now, documentId, workspaceId],
      );
      await this.recordLeaseEvent(client, context, workspaceId, documentId, current, "released");
      return leaseRecord(updated.rows[0]!);
    }, () => ({ workspaceId, action: "document.lease.released", resourceId: documentId }));
    return result.value;
  }

  async requestTakeover(context: CommandContext, workspaceId: string, documentId: string, reason: string): Promise<LeaseTakeoverResult> {
    const result = await this.command(context, "document.lease.takeover.request", async (client) => {
      await this.lockDocument(client, workspaceId, documentId);
      const existing = await this.lockLease(client, workspaceId, documentId);
      const now = this.runtime.now();
      if (!existing || existing["state"] === "released" || new Date(now) > new Date(existing["grace_expires_at"] as Date)) {
        if (existing && existing["state"] !== "released") {
          await this.recordLeaseEvent(client, context, workspaceId, documentId, existing, "expired");
          await this.recordMutation(client, context, workspaceId, "document.lease.expired", documentId);
        }
        const grant = await this.issueLease(client, context, workspaceId, documentId, now);
        return { schema_version: PRODUCT_SCHEMA_VERSION, status: "acquired" as const, current_editor: null, grant };
      }
      const requestId = this.runtime.id("takeover-request");
      await client.query(
        `UPDATE document_leases lease SET takeover_request_id=$1,takeover_requested_by_actor_id=$2,
         takeover_requested_at=$3,takeover_request_reason=$4 FROM editor_documents document
         WHERE lease.document_id=$5 AND document.document_id=lease.document_id AND document.workspace_id=$6`,
        [requestId, context.principal.actorId, now, reason, documentId, workspaceId],
      );
      await this.recordLeaseEvent(client, context, workspaceId, documentId, existing, "takeover_requested", String(existing["actor_id"]), reason);
      await client.query(
        `INSERT INTO notifications(notification_id,workspace_id,source_key,kind,title,message,resource_kind,
         resource_id,occurred_at,recipient_actor_id) VALUES($1,$2,$3,'lease_takeover_requested',
         'Takeover requested',$4,'editor_document',$5,$6,$7) ON CONFLICT(workspace_id,source_key) DO NOTHING`,
        [this.runtime.id("notification"), workspaceId, `lease-takeover:${requestId}`,
          `${context.principal.displayName} asked to edit this document.`, documentId, now, String(existing["actor_id"])],
      );
      return { schema_version: PRODUCT_SCHEMA_VERSION, status: "requested" as const, current_editor: leaseRecord(existing), grant: null };
    }, () => ({ workspaceId, action: "document.lease.takeover-requested", resourceId: documentId }));
    return result.value;
  }

  async denyTakeover(context: CommandContext, workspaceId: string, documentId: string, leaseTokenHash: string, reason: string): Promise<EditorLeaseRecord> {
    const result = await this.command(context, "document.lease.takeover.deny", async (client) => {
      await this.lockDocument(client, workspaceId, documentId);
      const current = await this.requireLease(client, context.principal.actorId, workspaceId, documentId, leaseTokenHash, true);
      const requester = current["takeover_requested_by_actor_id"] ? String(current["takeover_requested_by_actor_id"]) : null;
      if (!requester) throw new DomainError(409, "takeover-request-missing", "There is no active takeover request");
      await client.query(
        `UPDATE document_leases lease SET takeover_request_id=NULL,takeover_requested_by_actor_id=NULL,
         takeover_requested_at=NULL,takeover_request_reason=NULL FROM editor_documents document
         WHERE lease.document_id=$1 AND document.document_id=lease.document_id AND document.workspace_id=$2`,
        [documentId, workspaceId],
      );
      await this.recordLeaseEvent(client, context, workspaceId, documentId, current, "takeover_denied", requester, reason);
      return leaseRecord(current);
    }, () => ({ workspaceId, action: "document.lease.takeover-denied", resourceId: documentId }));
    return result.value;
  }

  async forceTakeover(context: CommandContext, workspaceId: string, documentId: string, reason: string): Promise<LeaseTakeoverResult> {
    const result = await this.command(context, "document.lease.takeover.force", async (client) => {
      await this.lockDocument(client, workspaceId, documentId);
      const existing = await this.lockLease(client, workspaceId, documentId);
      const grant = await this.issueLease(client, context, workspaceId, documentId, this.runtime.now());
      await this.recordLeaseEvent(
        client, context, workspaceId, documentId, existing ?? grant.lease, "force_takeover",
        existing ? String(existing["actor_id"]) : undefined, reason,
      );
      return { schema_version: PRODUCT_SCHEMA_VERSION, status: "acquired" as const, current_editor: null, grant };
    }, () => ({ workspaceId, action: "document.lease.force-takeover", resourceId: documentId }));
    return result.value;
  }

  async compatibilityReports(actorId: string, workspaceId: string, documentId: string): Promise<ImportCompatibilityReport[]> {
    void actorId;
    const exists = await this.pool.query("SELECT 1 FROM editor_documents WHERE workspace_id=$1 AND document_id=$2", [workspaceId, documentId]);
    if (!exists.rowCount) throw new DomainError(404, "document-not-found", "Document was not found");
    const rows = await this.pool.query("SELECT * FROM import_compatibility_reports WHERE document_id=$1 ORDER BY created_at DESC", [documentId]);
    return rows.rows.map(compatibilityReport);
  }

  async leaseStatus(actorId: string, workspaceId: string, documentId: string, leaseTokenHash: string): Promise<EditorLeaseStatus> {
    const result = await this.pool.query(
      `SELECT lease.*,requester.display_name AS requester_display_name
       FROM editor_documents document
       JOIN document_leases lease ON lease.document_id=document.document_id
       LEFT JOIN actors requester ON requester.actor_id=lease.takeover_requested_by_actor_id
       WHERE document.workspace_id=$1 AND document.document_id=$2 AND lease.actor_id=$3 AND lease.token_hash=$4`,
      [workspaceId, documentId, actorId, leaseTokenHash],
    );
    const row = result.rows[0];
    if (!row || row["state"] === "released" || new Date(this.runtime.now()) > new Date(row["grace_expires_at"] as Date)) {
      throw new DomainError(409, "document-lease-required", "An active editor lease is required");
    }
    return {
      lease: leaseRecord(row),
      takeoverRequest: row["takeover_requested_by_actor_id"] ? {
        actorId: String(row["takeover_requested_by_actor_id"]),
        actorDisplayName: String(row["requester_display_name"] ?? "Workspace member"),
        reason: String(row["takeover_request_reason"] ?? "Editing access requested"),
        requestedAt: timestamp(row["takeover_requested_at"]),
      } : null,
    };
  }

  async close(): Promise<void> { await this.pool.end(); }

  private async historyCommand(
    context: CommandContext,
    command: string,
    workspaceId: string,
    documentId: string,
    leaseTokenHash: string,
    direction: "undo" | "redo",
  ): Promise<DocumentCommandResult<DocumentHistoryResult>> {
    return this.command(context, command, async (client) => {
      const row = await this.lockDocument(client, workspaceId, documentId);
      await this.requireLease(client, context.principal.actorId, workspaceId, documentId, leaseTokenHash);
      const cursor = Number(row["history_cursor"]);
      const history = await client.query(
        direction === "undo"
          ? "SELECT * FROM document_history_entries WHERE document_id=$1 AND history_position=$2"
          : "SELECT * FROM document_history_entries WHERE document_id=$1 AND history_position=$2",
        [documentId, direction === "undo" ? cursor : cursor + 1],
      );
      if (!history.rows[0]) {
        throw new DomainError(409, direction === "undo" ? "document-history-start" : "document-history-end", `There is nothing to ${direction}`);
      }
      const revision = Number(row["current_revision"]);
      const snapshot = structuredClone(history.rows[0][direction === "undo" ? "before_snapshot" : "after_snapshot"] as EditorDocumentSnapshot);
      snapshot.revision = revision + 1;
      const now = this.runtime.now();
      const mutation: EditorMutation = { schema_version: PRODUCT_SCHEMA_VERSION, kind: "document.rename", target_id: null, properties: { history_action: direction } };
      await this.insertOperation(client, this.runtime.id("document-operation"), documentId, revision, mutation, context, now);
      const nextCursor = direction === "undo" ? cursor - 1 : cursor + 1;
      await client.query("UPDATE editor_documents SET current_revision=$1,current_snapshot=$2,history_cursor=$3,updated_at=$4 WHERE document_id=$5", [snapshot.revision, snapshot, nextCursor, now, documentId]);
      const [updated, count] = await Promise.all([
        client.query("SELECT * FROM editor_documents WHERE document_id=$1", [documentId]),
        client.query("SELECT COALESCE(MAX(history_position),0)::int AS maximum FROM document_history_entries WHERE document_id=$1", [documentId]),
      ]);
      return {
        document: documentRecord(updated.rows[0]!), snapshot,
        canUndo: nextCursor > 0, canRedo: nextCursor < Number(count.rows[0]?.["maximum"] ?? 0),
      };
    }, () => ({ workspaceId, action: `document.${direction}`, resourceId: documentId }));
  }

  private async command<T>(
    context: CommandContext,
    command: string,
    execute: (client: PoolClient) => Promise<T>,
    audit?: (value: T) => { workspaceId: string; action: string; resourceId: string },
  ): Promise<DocumentCommandResult<T>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${context.principal.actorId}:${context.idempotencyKey}`]);
      const prior = await client.query("SELECT command_name,request_hash,response_body FROM idempotency_records WHERE actor_id=$1 AND idempotency_key=$2", [context.principal.actorId, context.idempotencyKey]);
      if (prior.rows[0]) {
        if (prior.rows[0]["command_name"] !== command || prior.rows[0]["request_hash"] !== context.requestHash) {
          throw new DomainError(409, "idempotency-conflict", "Idempotency key was already used for another request");
        }
        await client.query("COMMIT");
        return { value: prior.rows[0]["response_body"] as T, replayed: true };
      }
      const value = await execute(client);
      if (audit) {
        const event = audit(value);
        await this.recordMutation(client, context, event.workspaceId, event.action, event.resourceId);
      }
      await client.query(
        `INSERT INTO idempotency_records(actor_id,idempotency_key,command_name,request_hash,response_status,response_body,created_at)
         VALUES($1,$2,$3,$4,200,$5,$6)`,
        [context.principal.actorId, context.idempotencyKey, command, context.requestHash, value, this.runtime.now()],
      );
      await client.query("COMMIT");
      return { value, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK"); throw error;
    } finally { client.release(); }
  }

  private async lockDocument(client: PoolClient, workspaceId: string, documentId: string): Promise<QueryResultRow> {
    const result = await client.query("SELECT * FROM editor_documents WHERE workspace_id=$1 AND document_id=$2 FOR UPDATE", [workspaceId, documentId]);
    if (!result.rows[0]) throw new DomainError(404, "document-not-found", "Document was not found");
    return result.rows[0];
  }

  private async lockLease(client: PoolClient, workspaceId: string, documentId: string): Promise<QueryResultRow | undefined> {
    const result = await client.query(
      `SELECT lease.* FROM document_leases lease
       JOIN editor_documents document ON document.document_id=lease.document_id
       WHERE document.workspace_id=$1 AND lease.document_id=$2 FOR UPDATE OF lease`,
      [workspaceId, documentId],
    );
    return result.rows[0];
  }

  private async read(queryable: Pick<Pool, "query"> | Pick<PoolClient, "query">, workspaceId: string, documentId: string, required = true): Promise<DocumentReadModel | null> {
    const document = await queryable.query("SELECT * FROM editor_documents WHERE workspace_id=$1 AND document_id=$2", [workspaceId, documentId]);
    if (!document.rows[0]) {
      if (required) throw new DomainError(404, "document-not-found", "Document was not found");
      return null;
    }
    const versions = await queryable.query("SELECT * FROM document_versions WHERE document_id=$1 ORDER BY sequence DESC", [documentId]);
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      document: documentRecord(document.rows[0]),
      snapshot: document.rows[0]["current_snapshot"] as EditorDocumentSnapshot,
      versions: versions.rows.map(documentVersion),
    };
  }

  private async requireLease(
    client: PoolClient,
    actorId: string,
    workspaceId: string,
    documentId: string,
    tokenHash: string,
    allowGrace = false,
  ): Promise<QueryResultRow> {
    const result = await client.query(
      `SELECT lease.* FROM document_leases lease
       JOIN editor_documents document ON document.document_id=lease.document_id
       WHERE document.workspace_id=$1 AND lease.document_id=$2 FOR UPDATE OF lease`,
      [workspaceId, documentId],
    );
    const row = result.rows[0];
    if (!row || row["actor_id"] !== actorId || row["token_hash"] !== tokenHash || row["state"] === "released") {
      throw new DomainError(409, "document-lease-required", "An active editor lease is required");
    }
    const now = this.runtime.now();
    if (new Date(now) > new Date(row["grace_expires_at"] as Date)) {
      await client.query(
        `UPDATE document_leases lease SET state='expired' FROM editor_documents document
         WHERE lease.document_id=$1 AND document.document_id=lease.document_id AND document.workspace_id=$2`,
        [documentId, workspaceId],
      );
      throw new DomainError(409, "document-lease-expired", "The editor lease expired. Reopen the document to continue");
    }
    if (!allowGrace && new Date(now) > new Date(row["expires_at"] as Date)) {
      await client.query(
        `UPDATE document_leases lease SET state='grace' FROM editor_documents document
         WHERE lease.document_id=$1 AND document.document_id=lease.document_id AND document.workspace_id=$2`,
        [documentId, workspaceId],
      );
      throw new DomainError(409, "document-lease-grace", "Reconnect the editor before making changes");
    }
    return row;
  }

  private async issueLease(
    client: PoolClient,
    context: CommandContext,
    workspaceId: string,
    documentId: string,
    now: string,
  ): Promise<EditorLeaseGrant> {
    const token = randomBytes(32).toString("hex");
    const record = this.newLease(documentId, context, now);
    await client.query(
      `INSERT INTO document_leases(document_id,lease_id,actor_id,actor_display_name,state,token_hash,acquired_at,
       heartbeat_at,expires_at,grace_expires_at,takeover_requested_by_actor_id,takeover_requested_at,
       takeover_request_id,takeover_request_reason)
       VALUES($1,$2,$3,$4,'active',$5,$6,$6,$7,$8,NULL,NULL,NULL,NULL)
       ON CONFLICT(document_id) DO UPDATE SET lease_id=EXCLUDED.lease_id,actor_id=EXCLUDED.actor_id,
         actor_display_name=EXCLUDED.actor_display_name,state='active',token_hash=EXCLUDED.token_hash,
         acquired_at=EXCLUDED.acquired_at,heartbeat_at=EXCLUDED.heartbeat_at,expires_at=EXCLUDED.expires_at,
         grace_expires_at=EXCLUDED.grace_expires_at,takeover_requested_by_actor_id=NULL,takeover_requested_at=NULL,
         takeover_request_id=NULL,takeover_request_reason=NULL`,
      [documentId, record.lease_id, record.actor_id, record.actor_display_name, sha256(token), now, record.expires_at, record.grace_expires_at],
    );
    await this.recordLeaseEvent(client, context, workspaceId, documentId, record, "acquired");
    return { schema_version: PRODUCT_SCHEMA_VERSION, lease: record, lease_token: token, takeover_warning: null };
  }

  private async recordLeaseEvent(
    client: PoolClient,
    context: CommandContext,
    workspaceId: string,
    documentId: string,
    lease: QueryResultRow | EditorLeaseRecord,
    kind: "acquired" | "heartbeat" | "takeover_requested" | "takeover_denied" | "expired" | "released" | "force_takeover",
    subjectActorId?: string,
    reason?: string,
  ): Promise<void> {
    const leaseId = "lease_id" in lease ? String(lease["lease_id"]) : null;
    await client.query(
      `INSERT INTO document_lease_events(document_lease_event_id,workspace_id,document_id,lease_id,event_kind,
       actor_id,subject_actor_id,reason,trace_id,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [this.runtime.id("lease-event"), workspaceId, documentId, leaseId, kind, context.principal.actorId,
        subjectActorId ?? null, reason ?? null, context.traceId, this.runtime.now()],
    );
  }

  private async recordMutation(
    client: PoolClient,
    context: CommandContext,
    workspaceId: string,
    action: string,
    resourceId: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_events(audit_event_id,workspace_id,actor_id,action,resource_kind,resource_id,occurred_at,trace_id)
       VALUES($1,$2,$3,$4,'editor_document',$5,$6,$7)`,
      [this.runtime.id("audit"), workspaceId, context.principal.actorId, action, resourceId, this.runtime.now(), context.traceId],
    );
    const usageId = this.runtime.id("usage");
    await client.query(
      `INSERT INTO usage_events(usage_event_id,workspace_id,actor_id,event_kind,customer_amount,credit_debit,currency,occurred_at)
       VALUES($1,$2,$3,$4,0,0,'USD',$5)`,
      [usageId, workspaceId, context.principal.actorId, action, this.runtime.now()],
    );
    await client.query(
      "INSERT INTO usage_admin_dimensions(usage_event_id,dimensions) VALUES($1,$2)",
      [usageId, { resource_kind: "editor_document", operation: action }],
    );
  }

  private async insertOperation(client: PoolClient, id: string, documentId: string, base: number, mutation: EditorMutation, context: CommandContext, now: string) {
    await client.query(
      `INSERT INTO document_operations(operation_id,document_id,base_revision,resulting_revision,mutation,actor_id,idempotency_key,trace_id,occurred_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, documentId, base, base + 1, mutation, context.principal.actorId, context.idempotencyKey, context.traceId, now],
    );
  }

  private async appendVersion(
    client: PoolClient,
    documentId: string,
    snapshot: EditorDocumentSnapshot,
    kind: DocumentVersionRecord["kind"],
    name: string,
    actorId: string,
    now: string,
    restoredFrom?: string,
  ): Promise<DocumentVersionRecord> {
    const current = await client.query("SELECT current_version_id FROM editor_documents WHERE document_id=$1", [documentId]);
    const sequence = await client.query("SELECT COALESCE(MAX(sequence),0)::int+1 AS next FROM document_versions WHERE document_id=$1", [documentId]);
    const id = this.runtime.id("document-version");
    await this.insertVersion(client, {
      id, documentId, sequence: Number(sequence.rows[0]?.["next"] ?? 1), snapshot, kind, name, actorId, now,
      basedOn: String(current.rows[0]?.["current_version_id"] ?? "") || undefined, restoredFrom,
    });
    await client.query("UPDATE editor_documents SET current_version_id=$1 WHERE document_id=$2", [id, documentId]);
    return documentVersion((await client.query("SELECT * FROM document_versions WHERE document_version_id=$1", [id])).rows[0]!);
  }

  private async insertVersion(client: PoolClient, value: {
    id: string; documentId: string; sequence: number; snapshot: EditorDocumentSnapshot;
    kind: DocumentVersionRecord["kind"]; name: string; actorId: string; now: string;
    basedOn?: string; restoredFrom?: string;
  }) {
    await client.query(
      `INSERT INTO document_versions(document_version_id,document_id,sequence,revision,kind,name,based_on_version_id,
       restored_from_version_id,snapshot_sha256,snapshot,created_by_actor_id,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [value.id, value.documentId, value.sequence, value.snapshot.revision, value.kind, value.name,
        value.basedOn ?? null, value.restoredFrom ?? null, snapshotDigest(value.snapshot), value.snapshot, value.actorId, value.now],
    );
  }

  private async insertCompatibility(client: PoolClient, documentId: string, input: CreateDocumentInput, now: string) {
    await client.query(
      `INSERT INTO import_compatibility_reports(compatibility_report_id,workspace_id,document_id,source_file_id,
       source_version_id,source_kind,state,source_preserved,sanitisation_required,preserved_structures,
       unsupported_structures,warnings,created_at) VALUES($1,$2,$3,$4,$5,'raster','compatible',true,false,$6,'[]'::jsonb,$7,$8)`,
      [this.runtime.id("compatibility"), input.workspaceId, documentId, input.source!.fileId, input.source!.sourceVersionId,
        JSON.stringify(["Immutable raster source", "Pixel dimensions", "Colour profile evidence"]),
        JSON.stringify(input.source!.width && input.source!.height ? [] : ["Source dimensions were unavailable"]), now],
    );
  }

  private async enqueuePreview(
    client: PoolClient,
    context: CommandContext,
    workspaceId: string,
    documentId: string,
    jobId: string,
    now: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO processing_jobs(job_id,kind,owner_kind,workspace_id,actor_id,document_id,state,attempt,
       max_attempts,progress_percent,created_at,updated_at)
       VALUES($1,'preview_generation','actor',$2,$3,$4,'queued',0,3,0,$5,$5)`,
      [jobId, workspaceId, context.principal.actorId, documentId, now],
    );
    await client.query(
      `INSERT INTO job_events(job_event_id,job_id,event_kind,state,progress_percent,occurred_at,trace_id)
       VALUES($1,$2,'preview.queued','queued',0,$3,$4)`,
      [this.runtime.id("job-event"), jobId, now, context.traceId],
    );
    await client.query(
      `INSERT INTO job_outbox(outbox_id,job_id,dispatch_kind,payload,trace_id,available_at,created_at)
       VALUES($1,$2,'process_job',$3,$4,$5,$5)`,
      [this.runtime.id("outbox"), jobId, { job_id: jobId }, context.traceId, now],
    );
  }

  private newLease(documentId: string, context: CommandContext, now: string): EditorLeaseRecord {
    const expires = addSeconds(now, EDITOR_LEASE_SECONDS);
    return {
      schema_version: PRODUCT_SCHEMA_VERSION, lease_id: this.runtime.id("editor-lease"), document_id: documentId,
      actor_id: context.principal.actorId, actor_display_name: context.principal.displayName, state: "active",
      acquired_at: now, heartbeat_at: now, expires_at: expires,
      grace_expires_at: addSeconds(expires, EDITOR_LEASE_GRACE_SECONDS),
    };
  }
}

function documentRecord(row: QueryResultRow): EditorDocumentRecord {
  const projectId = row["project_id"] ? String(row["project_id"]) : null;
  return {
    schema_version: PRODUCT_SCHEMA_VERSION,
    document_id: String(row["document_id"]), workspace_id: String(row["workspace_id"]), project_id: projectId,
    location: projectId
      ? { schema_version: PRODUCT_SCHEMA_VERSION, kind: "project", project_id: projectId, default_files_id: null }
      : { schema_version: PRODUCT_SCHEMA_VERSION, kind: "default_files", project_id: null, default_files_id: String(row["default_files_id"]) },
    kind: String(row["kind"]) as EditorDocumentRecord["kind"], name: String(row["name"]),
    source_file_id: row["source_file_id"] ? String(row["source_file_id"]) : null,
    source_asset_original_id: row["source_asset_original_id"] ? String(row["source_asset_original_id"]) : null,
    source_version_id: row["source_version_id"] ? String(row["source_version_id"]) : null,
    preview_state: String(row["preview_state"] ?? "not_required") as EditorDocumentRecord["preview_state"],
    preview_job_id: row["preview_job_id"] ? String(row["preview_job_id"]) : null,
    current_preview_id: row["current_preview_id"] ? String(row["current_preview_id"]) : null,
    current_version_id: String(row["current_version_id"]), current_revision: Number(row["current_revision"]),
    created_by_actor_id: String(row["created_by_actor_id"]), created_at: timestamp(row["created_at"]), updated_at: timestamp(row["updated_at"]),
  };
}

function documentVersion(row: QueryResultRow): DocumentVersionRecord {
  return {
    schema_version: PRODUCT_SCHEMA_VERSION,
    document_version_id: String(row["document_version_id"]), document_id: String(row["document_id"]),
    sequence: Number(row["sequence"]), revision: Number(row["revision"]), kind: String(row["kind"]) as DocumentVersionRecord["kind"],
    name: row["name"] ? String(row["name"]) : null,
    based_on_version_id: row["based_on_version_id"] ? String(row["based_on_version_id"]) : null,
    restored_from_version_id: row["restored_from_version_id"] ? String(row["restored_from_version_id"]) : null,
    snapshot_sha256: String(row["snapshot_sha256"]), created_by_actor_id: String(row["created_by_actor_id"]), created_at: timestamp(row["created_at"]),
  };
}

function leaseRecord(row: QueryResultRow): EditorLeaseRecord {
  return {
    schema_version: PRODUCT_SCHEMA_VERSION,
    lease_id: String(row["lease_id"]), document_id: String(row["document_id"]), actor_id: String(row["actor_id"]),
    actor_display_name: String(row["actor_display_name"]), state: String(row["state"]) as EditorLeaseRecord["state"],
    acquired_at: timestamp(row["acquired_at"]), heartbeat_at: timestamp(row["heartbeat_at"]),
    expires_at: timestamp(row["expires_at"]), grace_expires_at: timestamp(row["grace_expires_at"]),
  };
}

function compatibilityReport(row: QueryResultRow): ImportCompatibilityReport {
  return {
    schema_version: PRODUCT_SCHEMA_VERSION,
    compatibility_report_id: String(row["compatibility_report_id"]), source_file_id: String(row["source_file_id"]),
    source_version_id: String(row["source_version_id"]), source_kind: String(row["source_kind"]) as ImportCompatibilityReport["source_kind"],
    state: String(row["state"]) as ImportCompatibilityReport["state"], source_preserved: true,
    sanitisation_required: Boolean(row["sanitisation_required"]), preserved_structures: row["preserved_structures"] as string[],
    unsupported_structures: row["unsupported_structures"] as string[], warnings: row["warnings"] as string[], created_at: timestamp(row["created_at"]),
  };
}

function timestamp(value: unknown): string { return value instanceof Date ? value.toISOString() : String(value); }
