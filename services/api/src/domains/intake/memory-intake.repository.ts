import type {
  GuestSessionRecord,
  IntakeClassificationRecord,
  ProcessingJobRecord,
  UploadSessionRecord,
} from "ipw-contracts-ts/product";

import { DomainError } from "../../kernel/errors.js";
import type {
  IntakeCommand,
  CleanupCandidate,
  IntakeOwner,
  IntakeRepository,
  StoredUploadSession,
  UploadCreateResult,
} from "./intake.types.js";
import type { PrivateObjectRef } from "./private-object-store.js";
import type { ProviderObjectMetadata } from "./private-object-store.js";

interface GuestEntry {
  record: GuestSessionRecord;
  tokenHash: string;
  revokedAt?: string;
}

interface CommandEntry {
  commandName: string;
  requestHash: string;
  uploadSessionId?: string;
  classification?: IntakeClassificationRecord;
}

export class MemoryIntakeRepository implements IntakeRepository {
  private readonly guests = new Map<string, GuestEntry>();
  private readonly uploads = new Map<string, StoredUploadSession>();
  private readonly commands = new Map<string, CommandEntry>();
  private readonly classifications = new Map<string, IntakeClassificationRecord>();
  private readonly cleanup = new Map<string, { workerId: string; expiresAt: string; completedAt?: string }>();

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
      const existing = prior.uploadSessionId ? this.uploads.get(prior.uploadSessionId) : undefined;
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

  async setUploadProviderState(
    uploadSessionId: string,
    owner: IntakeOwner,
    transferProvider: StoredUploadSession["transferProvider"],
    protectedProviderSession: string | null,
  ): Promise<StoredUploadSession> {
    const stored = this.requireOwned(uploadSessionId, owner);
    const updated = { ...stored, transferProvider, protectedProviderSession };
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

  async recordProviderObject(
    uploadSessionId: string,
    owner: IntakeOwner,
    metadata: ProviderObjectMetadata,
    now: string,
  ): Promise<StoredUploadSession> {
    const stored = this.requireOwned(uploadSessionId, owner);
    if (!["initiated", "uploading"].includes(stored.record.state)) {
      throw new DomainError(409, "upload-not-writable", "This upload cannot be reconciled in its current state");
    }
    const updated: StoredUploadSession = {
      ...stored,
      quarantineRef: { ...stored.quarantineRef, generation: metadata.generation },
      providerMetadata: metadata,
      record: {
        ...stored.record,
        bytes_received: metadata.byteSize,
        verified_sha256: metadata.calculatedSha256,
        state: "uploading",
        updated_at: now,
      },
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

  async findClassification(
    uploadSessionId: string,
    owner: IntakeOwner,
  ): Promise<IntakeClassificationRecord | null> {
    this.requireOwned(uploadSessionId, owner);
    return this.classifications.get(uploadSessionId) ?? null;
  }

  async saveClassification(
    classification: IntakeClassificationRecord,
    owner: IntakeOwner,
    command: IntakeCommand,
  ) {
    const stored = this.requireOwned(classification.upload_session_id, owner);
    if (stored.record.state !== "ready") {
      throw new DomainError(409, "intake-not-ready", "Classification can be corrected only after inspection");
    }
    const key = `${command.ownerScope}:${command.idempotencyKey}`;
    const prior = this.commands.get(key);
    if (prior) {
      if (prior.commandName !== command.commandName || prior.requestHash !== command.requestHash) {
        throw new DomainError(409, "idempotency-conflict", "Idempotency key was already used for another request");
      }
      if (!prior.classification) throw new Error("idempotent intake classification is unavailable");
      return { classification: prior.classification, replayed: true };
    }
    this.classifications.set(classification.upload_session_id, classification);
    this.commands.set(key, { commandName: command.commandName, requestHash: command.requestHash, classification });
    return { classification, replayed: false };
  }

  async claimCleanup(
    workerId: string,
    now: string,
    leaseExpiresAt: string,
    limit: number,
  ): Promise<CleanupCandidate[]> {
    const candidates: CleanupCandidate[] = [];
    for (const [id, stored] of this.uploads) {
      const active = !["ready", "rejected", "expired", "cancelled"].includes(stored.record.state);
      const retainedGuest = stored.record.owner_kind === "guest" && ["ready", "rejected"].includes(stored.record.state);
      if ((active || retainedGuest) && stored.record.expires_at <= now) {
        this.uploads.set(id, { ...stored, record: { ...stored.record, state: "expired", updated_at: now } });
      }
      const current = this.uploads.get(id)!;
      const lease = this.cleanup.get(id);
      if (
        candidates.length < limit
        && ["expired", "rejected", "cancelled"].includes(current.record.state)
        && !lease?.completedAt
        && (!lease || lease.expiresAt <= now)
      ) {
        this.cleanup.set(id, { workerId, expiresAt: leaseExpiresAt });
        candidates.push({
          uploadSessionId: id,
          owner: this.owner(current.record),
          object: current.quarantineRef,
        });
      }
    }
    return candidates;
  }

  async completeCleanup(uploadSessionId: string, workerId: string, now: string): Promise<void> {
    const lease = this.cleanup.get(uploadSessionId);
    if (!lease || lease.workerId !== workerId || lease.completedAt) {
      throw new DomainError(409, "cleanup-lease-invalid", "Cleanup lease is invalid");
    }
    this.cleanup.set(uploadSessionId, { ...lease, completedAt: now });
  }

  async releaseCleanup(uploadSessionId: string, workerId: string): Promise<void> {
    const lease = this.cleanup.get(uploadSessionId);
    if (lease?.workerId === workerId && !lease.completedAt) this.cleanup.delete(uploadSessionId);
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

  private owner(record: UploadSessionRecord): IntakeOwner {
    return record.owner_kind === "actor"
      ? {
          ownerKind: "actor",
          ownerScope: record.workspace_id!,
          workspaceId: record.workspace_id!,
          actorId: record.actor_id!,
        }
      : {
          ownerKind: "guest",
          ownerScope: record.guest_session_id!,
          guestSessionId: record.guest_session_id!,
        };
  }
}
