import { randomBytes } from "node:crypto";

import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import type {
  DocumentReadModel,
  DocumentVersionRecord,
  EditorDocumentRecord,
  EditorDocumentSnapshot,
  EditorLeaseGrant,
  EditorLeaseRecord,
  ImportCompatibilityReport,
  LeaseTakeoverResult,
} from "ipw-contracts-ts/product";

import { DomainError } from "../../kernel/errors.js";
import type { CommandContext } from "../../kernel/product.types.js";
import type { RuntimeValues } from "../../kernel/runtime.js";
import {
  addSeconds,
  applyMutation,
  clone,
  DOCUMENT_CHECKPOINT_INTERVAL,
  DOCUMENT_HISTORY_LIMIT,
  EDITOR_LEASE_GRACE_SECONDS,
  EDITOR_LEASE_SECONDS,
  initialSnapshot,
  sha256,
  snapshotDigest,
} from "./document-model.js";
import type {
  CreateDocumentInput,
  DocumentCommandResult,
  DocumentHistoryResult,
  DocumentMutationInput,
  DocumentMutationResult,
  DocumentRepository,
} from "./documents.types.js";

interface StoredDocument {
  record: EditorDocumentRecord;
  snapshot: EditorDocumentSnapshot;
  versions: DocumentVersionRecord[];
  versionSnapshots: Map<string, EditorDocumentSnapshot>;
  history: Array<{ before: EditorDocumentSnapshot; after: EditorDocumentSnapshot }>;
  historyCursor: number;
  compatibility: ImportCompatibilityReport[];
}

interface StoredLease {
  record: EditorLeaseRecord;
  tokenHash: string;
  takeoverRequestedBy: string | null;
}

interface IdempotencyRecord {
  requestHash: string;
  response: unknown;
}

export class MemoryDocumentRepository implements DocumentRepository {
  readonly recordsMutationsAtomically = false;
  private readonly documents = new Map<string, StoredDocument>();
  private readonly leases = new Map<string, StoredLease>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();

  constructor(private readonly runtime: RuntimeValues) {}

  async create(context: CommandContext, input: CreateDocumentInput): Promise<DocumentCommandResult<DocumentReadModel>> {
    return this.idempotent(context, "document.create", () => {
      const documentId = this.runtime.id("document");
      const versionId = this.runtime.id("document-version");
      const now = this.runtime.now();
      const snapshot = initialSnapshot(this.runtime, documentId, input);
      const record: EditorDocumentRecord = {
        schema_version: PRODUCT_SCHEMA_VERSION,
        document_id: documentId,
        workspace_id: input.workspaceId,
        project_id: input.projectId ?? null,
        location: input.projectId
          ? { schema_version: PRODUCT_SCHEMA_VERSION, kind: "project", default_files_id: null, project_id: input.projectId }
          : { schema_version: PRODUCT_SCHEMA_VERSION, kind: "default_files", default_files_id: input.defaultFilesId, project_id: null },
        kind: "graphic",
        name: input.name,
        source_file_id: input.source?.fileId ?? null,
        source_asset_original_id: input.source?.assetOriginalId ?? null,
        source_version_id: input.source?.sourceVersionId ?? null,
        current_version_id: versionId,
        current_revision: 0,
        created_by_actor_id: context.principal.actorId,
        created_at: now,
        updated_at: now,
      };
      const version = this.version(record, snapshot, versionId, 1, "initial", "Initial", context.principal.actorId, now);
      const compatibility = input.source ? [this.rasterCompatibility(documentId, input, now)] : [];
      this.documents.set(documentId, {
        record, snapshot, versions: [version], versionSnapshots: new Map([[versionId, clone(snapshot)]]),
        history: [], historyCursor: 0, compatibility,
      });
      return this.read(this.documents.get(documentId)!);
    });
  }

  async list(actorId: string, workspaceId: string): Promise<EditorDocumentRecord[]> {
    void actorId;
    return [...this.documents.values()]
      .filter((item) => item.record.workspace_id === workspaceId)
      .map((item) => clone(item.record))
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }

  async get(actorId: string, workspaceId: string, documentId: string): Promise<DocumentReadModel | null> {
    void actorId;
    const stored = this.documents.get(documentId);
    return stored?.record.workspace_id === workspaceId ? this.read(stored) : null;
  }

  async mutate(context: CommandContext, input: DocumentMutationInput): Promise<DocumentMutationResult> {
    const result = await this.idempotent(context, "document.mutate", () => {
      const stored = this.requireDocument(input.workspaceId, input.documentId);
      this.requireLease(context.principal.actorId, input.documentId, input.leaseTokenHash);
      if (stored.record.current_revision !== input.baseRevision) {
        throw new DomainError(409, "document-revision-conflict", "This document changed in another editor. Reload before continuing");
      }
      const before = clone(stored.snapshot);
      const after = applyMutation(before, input.mutation);
      stored.history.splice(stored.historyCursor);
      stored.history.push({ before, after: clone(after) });
      if (stored.history.length > DOCUMENT_HISTORY_LIMIT) stored.history.splice(0, stored.history.length - DOCUMENT_HISTORY_LIMIT);
      stored.historyCursor = stored.history.length;
      stored.snapshot = after;
      stored.record.current_revision = after.revision;
      stored.record.updated_at = this.runtime.now();
      const checkpoint = after.revision % DOCUMENT_CHECKPOINT_INTERVAL === 0
        ? this.appendVersion(stored, "autosave_checkpoint", `Autosave ${after.revision}`, context.principal.actorId)
        : null;
      return {
        document: clone(stored.record), snapshot: clone(after), operationId: this.runtime.id("document-operation"),
        checkpoint: checkpoint ? clone(checkpoint) : null,
      };
    });
    return { ...result.value, replayed: result.replayed };
  }

  async undo(context: CommandContext, workspaceId: string, documentId: string, leaseTokenHash: string) {
    return this.idempotent(context, "document.undo", () => {
      const stored = this.requireDocument(workspaceId, documentId);
      this.requireLease(context.principal.actorId, documentId, leaseTokenHash);
      if (stored.historyCursor === 0) throw new DomainError(409, "document-history-start", "There is nothing to undo");
      stored.historyCursor -= 1;
      this.advanceHistory(stored, stored.history[stored.historyCursor]!.before);
      return this.history(stored);
    });
  }

  async redo(context: CommandContext, workspaceId: string, documentId: string, leaseTokenHash: string) {
    return this.idempotent(context, "document.redo", () => {
      const stored = this.requireDocument(workspaceId, documentId);
      this.requireLease(context.principal.actorId, documentId, leaseTokenHash);
      if (stored.historyCursor >= stored.history.length) throw new DomainError(409, "document-history-end", "There is nothing to redo");
      const target = stored.history[stored.historyCursor]!.after;
      stored.historyCursor += 1;
      this.advanceHistory(stored, target);
      return this.history(stored);
    });
  }

  async createVersion(context: CommandContext, workspaceId: string, documentId: string, name: string) {
    return this.idempotent(context, "document.version", () => {
      const stored = this.requireDocument(workspaceId, documentId);
      return clone(this.appendVersion(stored, "named", name, context.principal.actorId));
    });
  }

  async restoreVersion(context: CommandContext, workspaceId: string, documentId: string, versionId: string, leaseTokenHash: string) {
    return this.idempotent(context, "document.restore", () => {
      const stored = this.requireDocument(workspaceId, documentId);
      this.requireLease(context.principal.actorId, documentId, leaseTokenHash);
      const target = stored.versionSnapshots.get(versionId);
      if (!target) throw new DomainError(404, "document-version-not-found", "Document version was not found");
      const before = clone(stored.snapshot);
      const after = clone(target);
      after.revision = stored.record.current_revision + 1;
      stored.history.splice(stored.historyCursor);
      stored.history.push({ before, after: clone(after) });
      if (stored.history.length > DOCUMENT_HISTORY_LIMIT) stored.history.splice(0, stored.history.length - DOCUMENT_HISTORY_LIMIT);
      stored.historyCursor = stored.history.length;
      stored.snapshot = after;
      stored.record.current_revision = after.revision;
      stored.record.updated_at = this.runtime.now();
      this.appendVersion(stored, "restore", `Restored ${versionId}`, context.principal.actorId, versionId);
      return this.read(stored);
    });
  }

  async saveAs(
    context: CommandContext,
    workspaceId: string,
    documentId: string,
    name: string,
    projectId: string | undefined,
    defaultFilesId: string,
  ) {
    return this.idempotent(context, "document.save-as", () => {
      const source = this.requireDocument(workspaceId, documentId);
      const nextId = this.runtime.id("document");
      const versionId = this.runtime.id("document-version");
      const now = this.runtime.now();
      const snapshot = clone(source.snapshot);
      snapshot.document_id = nextId;
      snapshot.revision = 0;
      const record: EditorDocumentRecord = {
        ...clone(source.record), document_id: nextId, name, project_id: projectId ?? null,
        location: projectId
          ? { schema_version: PRODUCT_SCHEMA_VERSION, kind: "project", project_id: projectId, default_files_id: null }
          : { schema_version: PRODUCT_SCHEMA_VERSION, kind: "default_files", project_id: null, default_files_id: defaultFilesId },
        current_version_id: versionId, current_revision: 0, created_by_actor_id: context.principal.actorId,
        created_at: now, updated_at: now,
      };
      const version = this.version(record, snapshot, versionId, 1, "save_as", name, context.principal.actorId, now, source.record.current_version_id);
      const saved: StoredDocument = {
        record, snapshot, versions: [version], versionSnapshots: new Map([[versionId, clone(snapshot)]]),
        history: [], historyCursor: 0, compatibility: clone(source.compatibility),
      };
      this.documents.set(nextId, saved);
      return this.read(saved);
    });
  }

  async acquireLease(context: CommandContext, workspaceId: string, documentId: string): Promise<EditorLeaseGrant> {
    return (await this.idempotent(context, "document.lease.acquire", () => {
      this.requireDocument(workspaceId, documentId);
      const existing = this.leases.get(documentId);
      const now = this.runtime.now();
      if (existing && existing.record.state !== "released" && new Date(now) <= new Date(existing.record.grace_expires_at)) {
        throw new DomainError(409, "document-lease-held", `${existing.record.actor_display_name} is currently editing this document`);
      }
      return this.issueLease(context, documentId, now);
    })).value;
  }

  async heartbeatLease(context: CommandContext, workspaceId: string, documentId: string, leaseTokenHash: string): Promise<EditorLeaseRecord> {
    return (await this.idempotent(context, "document.lease.heartbeat", () => {
      this.requireDocument(workspaceId, documentId);
      const lease = this.requireLease(context.principal.actorId, documentId, leaseTokenHash, true);
      const now = this.runtime.now();
      lease.record.state = "active";
      lease.record.heartbeat_at = now;
      lease.record.expires_at = addSeconds(now, EDITOR_LEASE_SECONDS);
      lease.record.grace_expires_at = addSeconds(lease.record.expires_at, EDITOR_LEASE_GRACE_SECONDS);
      return clone(lease.record);
    })).value;
  }

  async releaseLease(context: CommandContext, workspaceId: string, documentId: string, leaseTokenHash: string): Promise<EditorLeaseRecord> {
    return (await this.idempotent(context, "document.lease.release", () => {
      this.requireDocument(workspaceId, documentId);
      const lease = this.requireLease(context.principal.actorId, documentId, leaseTokenHash, true);
      lease.record.state = "released";
      lease.record.expires_at = this.runtime.now();
      lease.record.grace_expires_at = this.runtime.now();
      return clone(lease.record);
    })).value;
  }

  async requestTakeover(context: CommandContext, workspaceId: string, documentId: string, reason: string): Promise<LeaseTakeoverResult> {
    return (await this.idempotent(context, "document.lease.takeover.request", () => {
      this.requireDocument(workspaceId, documentId);
      const existing = this.leases.get(documentId);
      const now = this.runtime.now();
      if (!existing || existing.record.state === "released" || new Date(now) > new Date(existing.record.grace_expires_at)) {
        const grant = this.issueLease(context, documentId, now);
        return { schema_version: PRODUCT_SCHEMA_VERSION, status: "acquired" as const, current_editor: null, grant };
      }
      void reason;
      existing.takeoverRequestedBy = context.principal.actorId;
      return { schema_version: PRODUCT_SCHEMA_VERSION, status: "requested" as const, current_editor: clone(existing.record), grant: null };
    })).value;
  }

  async denyTakeover(context: CommandContext, workspaceId: string, documentId: string, leaseTokenHash: string, reason: string): Promise<EditorLeaseRecord> {
    return (await this.idempotent(context, "document.lease.takeover.deny", () => {
      this.requireDocument(workspaceId, documentId);
      const lease = this.requireLease(context.principal.actorId, documentId, leaseTokenHash, true);
      if (!lease.takeoverRequestedBy) throw new DomainError(409, "takeover-request-missing", "There is no active takeover request");
      void reason;
      lease.takeoverRequestedBy = null;
      return clone(lease.record);
    })).value;
  }

  async forceTakeover(context: CommandContext, workspaceId: string, documentId: string, reason: string): Promise<LeaseTakeoverResult> {
    return (await this.idempotent(context, "document.lease.takeover.force", () => {
      this.requireDocument(workspaceId, documentId);
      void reason;
      const grant = this.issueLease(context, documentId, this.runtime.now());
      return { schema_version: PRODUCT_SCHEMA_VERSION, status: "acquired" as const, current_editor: null, grant };
    })).value;
  }

  async compatibilityReports(actorId: string, workspaceId: string, documentId: string): Promise<ImportCompatibilityReport[]> {
    void actorId;
    return clone(this.requireDocument(workspaceId, documentId).compatibility);
  }

  async close(): Promise<void> {}

  private requireDocument(workspaceId: string, documentId: string): StoredDocument {
    const stored = this.documents.get(documentId);
    if (!stored || stored.record.workspace_id !== workspaceId) throw new DomainError(404, "document-not-found", "Document was not found");
    return stored;
  }

  private requireLease(actorId: string, documentId: string, tokenHash: string, allowGrace = false): StoredLease {
    const lease = this.leases.get(documentId);
    if (!lease || lease.record.actor_id !== actorId || lease.tokenHash !== tokenHash || lease.record.state === "released") {
      throw new DomainError(409, "document-lease-required", "An active editor lease is required");
    }
    const now = this.runtime.now();
    if (new Date(now) > new Date(lease.record.grace_expires_at)) {
      lease.record.state = "expired";
      throw new DomainError(409, "document-lease-expired", "The editor lease expired. Reopen the document to continue");
    }
    if (new Date(now) > new Date(lease.record.expires_at)) lease.record.state = "grace";
    if (!allowGrace && lease.record.state !== "active") throw new DomainError(409, "document-lease-grace", "Reconnect the editor before making changes");
    return lease;
  }

  private leaseRecord(documentId: string, context: CommandContext, now: string): EditorLeaseRecord {
    const expiresAt = addSeconds(now, EDITOR_LEASE_SECONDS);
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      lease_id: this.runtime.id("editor-lease"), document_id: documentId,
      actor_id: context.principal.actorId, actor_display_name: context.principal.displayName,
      state: "active", acquired_at: now, heartbeat_at: now, expires_at: expiresAt,
      grace_expires_at: addSeconds(expiresAt, EDITOR_LEASE_GRACE_SECONDS),
    };
  }

  private issueLease(context: CommandContext, documentId: string, now: string): EditorLeaseGrant {
    const rawToken = randomBytes(32).toString("hex");
    const record = this.leaseRecord(documentId, context, now);
    this.leases.set(documentId, { record, tokenHash: sha256(rawToken), takeoverRequestedBy: null });
    return { schema_version: PRODUCT_SCHEMA_VERSION, lease: clone(record), lease_token: rawToken, takeover_warning: null };
  }

  private advanceHistory(stored: StoredDocument, target: EditorDocumentSnapshot) {
    stored.snapshot = clone(target);
    stored.snapshot.revision = stored.record.current_revision + 1;
    stored.record.current_revision = stored.snapshot.revision;
    stored.record.updated_at = this.runtime.now();
  }

  private history(stored: StoredDocument): DocumentHistoryResult {
    return {
      document: clone(stored.record), snapshot: clone(stored.snapshot),
      canUndo: stored.historyCursor > 0, canRedo: stored.historyCursor < stored.history.length,
    };
  }

  private appendVersion(
    stored: StoredDocument,
    kind: DocumentVersionRecord["kind"],
    name: string,
    actorId: string,
    restoredFrom?: string,
  ): DocumentVersionRecord {
    const id = this.runtime.id("document-version");
    const version = this.version(
      stored.record, stored.snapshot, id, stored.versions.length + 1, kind, name, actorId, this.runtime.now(),
      stored.record.current_version_id, restoredFrom,
    );
    stored.versions.push(version);
    stored.versionSnapshots.set(id, clone(stored.snapshot));
    stored.record.current_version_id = id;
    return version;
  }

  private version(
    record: EditorDocumentRecord,
    snapshot: EditorDocumentSnapshot,
    id: string,
    sequence: number,
    kind: DocumentVersionRecord["kind"],
    name: string,
    actorId: string,
    now: string,
    basedOn?: string,
    restoredFrom?: string,
  ): DocumentVersionRecord {
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      document_version_id: id, document_id: record.document_id, sequence, revision: snapshot.revision,
      kind, name, based_on_version_id: basedOn ?? null, restored_from_version_id: restoredFrom ?? null,
      snapshot_sha256: snapshotDigest(snapshot), created_by_actor_id: actorId, created_at: now,
    };
  }

  private rasterCompatibility(documentId: string, input: CreateDocumentInput, now: string): ImportCompatibilityReport {
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      compatibility_report_id: this.runtime.id("compatibility"),
      source_file_id: input.source!.fileId, source_version_id: input.source!.sourceVersionId,
      source_kind: "raster", state: "compatible", source_preserved: true, sanitisation_required: false,
      preserved_structures: ["Immutable raster source", "Pixel dimensions", "Colour profile evidence"],
      unsupported_structures: [], warnings: input.source!.width && input.source!.height ? [] : ["Source dimensions were unavailable"],
      created_at: now,
    };
  }

  private read(stored: StoredDocument): DocumentReadModel {
    return { schema_version: PRODUCT_SCHEMA_VERSION, document: clone(stored.record), snapshot: clone(stored.snapshot), versions: clone(stored.versions) };
  }

  private async idempotent<T>(context: CommandContext, command: string, factory: () => T): Promise<DocumentCommandResult<T>> {
    const key = `${context.principal.actorId}:${command}:${context.idempotencyKey}`;
    const prior = this.idempotency.get(key);
    if (prior) {
      if (prior.requestHash !== context.requestHash) throw new DomainError(409, "idempotency-conflict", "Idempotency key was already used for another request");
      return { value: clone(prior.response as T), replayed: true };
    }
    const response = factory();
    this.idempotency.set(key, { requestHash: context.requestHash, response: clone(response) });
    return { value: clone(response), replayed: false };
  }
}
