import type { GuestSessionRecord, ProcessingJobRecord, UploadSessionRecord } from "ipw-contracts-ts/product";

import { DomainError } from "../../kernel/errors.js";
import type {
  IntakeCommand,
  IntakeOwner,
  IntakeRepository,
  StoredUploadSession,
  UploadCreateResult,
} from "./intake.types.js";
import type { PrivateObjectRef } from "./private-object-store.js";

interface GuestEntry {
  record: GuestSessionRecord;
  tokenHash: string;
  revokedAt?: string;
}

interface CommandEntry {
  commandName: string;
  requestHash: string;
  uploadSessionId: string;
}

export class MemoryIntakeRepository implements IntakeRepository {
  private readonly guests = new Map<string, GuestEntry>();
  private readonly uploads = new Map<string, StoredUploadSession>();
  private readonly commands = new Map<string, CommandEntry>();

  async createGuest(record: GuestSessionRecord, tokenHash: string): Promise<void> {
    this.guests.set(record.guest_session_id, { record, tokenHash });
  }

  async findGuest(tokenHash: string, now: string): Promise<GuestSessionRecord | null> {
    const entry = [...this.guests.values()].find((candidate) => candidate.tokenHash === tokenHash);
    return entry && !entry.revokedAt && entry.record.expires_at > now ? entry.record : null;
  }

  async createUpload(
    stored: StoredUploadSession,
    command: IntakeCommand,
  ): Promise<UploadCreateResult> {
    const key = `${command.ownerScope}:${command.idempotencyKey}`;
    const prior = this.commands.get(key);
    if (prior) {
      if (prior.commandName !== command.commandName || prior.requestHash !== command.requestHash) {
        throw new DomainError(409, "idempotency-conflict", "Idempotency key was already used for another request");
      }
      const existing = this.uploads.get(prior.uploadSessionId);
      if (!existing) throw new Error("idempotent upload session is unavailable");
      return { stored: existing, replayed: true };
    }
    this.uploads.set(stored.record.upload_session_id, stored);
    this.commands.set(key, {
      commandName: command.commandName,
      requestHash: command.requestHash,
      uploadSessionId: stored.record.upload_session_id,
    });
    return { stored, replayed: false };
  }

  async rotateUploadToken(
    uploadSessionId: string,
    owner: IntakeOwner,
    tokenHash: string,
    expiresAt: string,
  ): Promise<StoredUploadSession> {
    const stored = this.requireOwned(uploadSessionId, owner);
    const updated = { ...stored, uploadTokenHash: tokenHash, uploadTokenExpiresAt: expiresAt };
    this.uploads.set(uploadSessionId, updated);
    return updated;
  }

  async findUpload(uploadSessionId: string, owner: IntakeOwner): Promise<StoredUploadSession | null> {
    const stored = this.uploads.get(uploadSessionId);
    return stored && this.ownedBy(stored.record, owner) ? stored : null;
  }

  async findUploadByActor(uploadSessionId: string, actorId: string): Promise<StoredUploadSession | null> {
    const stored = this.uploads.get(uploadSessionId);
    return stored?.record.actor_id === actorId ? stored : null;
  }

  async findUploadByToken(uploadSessionId: string, tokenHash: string, now: string): Promise<StoredUploadSession | null> {
    const stored = this.uploads.get(uploadSessionId);
    if (!stored || stored.uploadTokenHash !== tokenHash || stored.uploadTokenExpiresAt <= now) return null;
    return stored;
  }

  async recordUploadedBytes(
    uploadSessionId: string,
    tokenHash: string,
    bytesReceived: number,
    now: string,
  ): Promise<StoredUploadSession> {
    const stored = await this.findUploadByToken(uploadSessionId, tokenHash, now);
    if (!stored) throw new DomainError(401, "upload-authorization-invalid", "Upload authorization is invalid or expired");
    if (stored.record.state !== "initiated" && stored.record.state !== "uploading") {
      throw new DomainError(409, "upload-not-writable", "This upload no longer accepts bytes");
    }
    const updated: StoredUploadSession = {
      ...stored,
      record: { ...stored.record, bytes_received: bytesReceived, state: "uploading", updated_at: now },
    };
    this.uploads.set(uploadSessionId, updated);
    return updated;
  }

  async cancelUpload(uploadSessionId: string, owner: IntakeOwner, now: string): Promise<StoredUploadSession> {
    const stored = this.requireOwned(uploadSessionId, owner);
    if (["ready", "rejected", "expired", "cancelled"].includes(stored.record.state)) return stored;
    const updated = { ...stored, record: { ...stored.record, state: "cancelled" as const, updated_at: now } };
    this.uploads.set(uploadSessionId, updated);
    return updated;
  }

  async expireUploads(now: string): Promise<PrivateObjectRef[]> {
    const refs: PrivateObjectRef[] = [];
    for (const [id, stored] of this.uploads) {
      const active = !["ready", "rejected", "expired", "cancelled"].includes(stored.record.state);
      const retainedGuest = stored.record.owner_kind === "guest" && ["ready", "rejected"].includes(stored.record.state);
      if ((active || retainedGuest) && stored.record.expires_at <= now) {
        refs.push(stored.quarantineRef);
        this.uploads.set(id, { ...stored, record: { ...stored.record, state: "expired", updated_at: now } });
      }
    }
    return refs;
  }

  async close(): Promise<void> {}

  finaliseForJob(uploadSessionId: string, owner: IntakeOwner, job: ProcessingJobRecord, now: string): StoredUploadSession {
    const stored = this.requireOwned(uploadSessionId, owner);
    if (stored.record.job_id) {
      if (stored.record.job_id !== job.job_id) throw new DomainError(409, "upload-already-finalised", "Upload is already finalising");
      return stored;
    }
    if (stored.record.state !== "uploading" || stored.record.bytes_received !== stored.record.expected_byte_size) {
      throw new DomainError(409, "upload-incomplete", "Finish uploading every byte before continuing");
    }
    const updated = {
      ...stored,
      record: { ...stored.record, state: "finalising" as const, job_id: job.job_id, updated_at: now },
    };
    this.uploads.set(uploadSessionId, updated);
    return updated;
  }

  markInspecting(uploadSessionId: string, now: string): StoredUploadSession {
    const stored = this.uploads.get(uploadSessionId);
    if (!stored || stored.record.state !== "finalising") throw new DomainError(409, "upload-state-conflict", "Upload is not ready for inspection");
    const updated = { ...stored, record: { ...stored.record, state: "inspecting" as const, updated_at: now } };
    this.uploads.set(uploadSessionId, updated);
    return updated;
  }

  completeAccepted(
    uploadSessionId: string,
    input: {
      immutableObjectKey: string;
      assetOriginalId: string;
      sourceVersionId: string;
      fileId: string | null;
      sourceFacts: UploadSessionRecord["source_facts"];
      now: string;
    },
  ): StoredUploadSession {
    const stored = this.uploads.get(uploadSessionId);
    if (!stored || stored.record.state !== "inspecting") throw new DomainError(409, "upload-state-conflict", "Upload is not being inspected");
    const updated = {
      ...stored,
      record: {
        ...stored.record,
        state: "ready" as const,
        asset_original_id: input.assetOriginalId,
        source_version_id: input.sourceVersionId,
        file_id: input.fileId,
        source_facts: input.sourceFacts,
        updated_at: input.now,
      },
    };
    updated.quarantineRef = { ...stored.quarantineRef, objectKey: input.immutableObjectKey, zone: "immutable" };
    this.uploads.set(uploadSessionId, updated);
    return updated;
  }

  completeRejected(
    uploadSessionId: string,
    failure: UploadSessionRecord["failure"],
    now: string,
  ): StoredUploadSession {
    const stored = this.uploads.get(uploadSessionId);
    if (!stored || stored.record.state !== "inspecting") throw new DomainError(409, "upload-state-conflict", "Upload is not being inspected");
    const updated = { ...stored, record: { ...stored.record, state: "rejected" as const, failure, updated_at: now } };
    this.uploads.set(uploadSessionId, updated);
    return updated;
  }

  private requireOwned(uploadSessionId: string, owner: IntakeOwner): StoredUploadSession {
    const stored = this.uploads.get(uploadSessionId);
    if (!stored || !this.ownedBy(stored.record, owner)) {
      throw new DomainError(404, "upload-not-found", "Upload session was not found");
    }
    return stored;
  }

  private ownedBy(record: UploadSessionRecord, owner: IntakeOwner): boolean {
    return owner.ownerKind === "actor"
      ? record.owner_kind === "actor" && record.workspace_id === owner.workspaceId && record.actor_id === owner.actorId
      : record.owner_kind === "guest" && record.guest_session_id === owner.guestSessionId;
  }
}
