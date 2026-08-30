import { randomUUID } from "node:crypto";
import { Pool } from "pg";

import { DomainError } from "../../kernel/errors.js";
import { MemoryProductKernelRepository } from "../../kernel/memory.repository.js";
import { runMigrations } from "../../kernel/migrations.js";
import type { CommandContext } from "../../kernel/product.types.js";
import { MemoryIntakeRepository } from "./memory-intake.repository.js";

export interface GuestHandoffInput {
  uploadSessionId: string;
  guestSessionId: string;
  workspaceId: string;
  actorId: string;
  objectReferenceId: string;
  assetOriginalId: string;
  sourceVersionId: string;
  fileId: string;
  displayName: string;
  immutableObjectKey: string;
  sha256: string;
  mediaType: string;
  byteSize: number;
  command: CommandContext;
  now: string;
}

export interface GuestHandoffResult {
  fileId: string;
  replayed: boolean;
}

export interface GuestHandoffRepository {
  handoff(input: GuestHandoffInput): Promise<GuestHandoffResult>;
  close(): Promise<void>;
}

export class MemoryGuestHandoffRepository implements GuestHandoffRepository {
  private readonly results = new Map<string, { requestHash: string; fileId: string }>();

  constructor(
    private readonly intake: MemoryIntakeRepository,
    private readonly product: MemoryProductKernelRepository,
  ) {}

  async handoff(input: GuestHandoffInput): Promise<GuestHandoffResult> {
    const key = `${input.guestSessionId}:${input.command.idempotencyKey}`;
    const prior = this.results.get(key);
    if (prior) {
      if (prior.requestHash !== input.command.requestHash) {
        throw new DomainError(409, "idempotency-conflict", "Idempotency key was already used for another request");
      }
      return { fileId: prior.fileId, replayed: true };
    }
    const stored = await this.intake.findUpload(input.uploadSessionId, {
      ownerKind: "guest",
      ownerScope: input.guestSessionId,
      guestSessionId: input.guestSessionId,
    });
    if (!stored || stored.record.state !== "ready") throw new DomainError(409, "upload-not-ready", "Guest upload is not ready to save");
    if (stored.record.asset_original_id !== input.assetOriginalId || stored.record.source_version_id !== input.sourceVersionId) {
      throw new DomainError(409, "source-identity-conflict", "Guest source identity changed unexpectedly");
    }
    this.product.registerVerifiedOriginal({
      context: input.command,
      workspaceId: input.workspaceId,
      objectReferenceId: input.objectReferenceId,
      assetOriginalId: input.assetOriginalId,
      sourceVersionId: input.sourceVersionId,
      fileId: input.fileId,
      displayName: input.displayName,
      objectKey: input.immutableObjectKey,
      sha256: input.sha256,
      mediaType: input.mediaType,
      byteSize: input.byteSize,
    });
    await this.product.recordExternalMutation(
      input.command,
      input.workspaceId,
      "guest-source.handed-off",
      "file",
      input.fileId,
    );
    this.results.set(key, { requestHash: input.command.requestHash, fileId: input.fileId });
    return { fileId: input.fileId, replayed: false };
  }

  async close(): Promise<void> {}
}

export class PostgresGuestHandoffRepository implements GuestHandoffRepository {
  constructor(private readonly pool: Pool) {}

  static async connect(connectionString: string, migrate = false): Promise<PostgresGuestHandoffRepository> {
    const pool = new Pool({ connectionString, max: 5 });
    if (migrate) await runMigrations(pool);
    return new PostgresGuestHandoffRepository(pool);
  }

  async handoff(input: GuestHandoffInput): Promise<GuestHandoffResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const priorCommand = await client.query(
        `SELECT request_hash,response_body FROM intake_idempotency_records
         WHERE owner_scope=$1 AND idempotency_key=$2 FOR UPDATE`,
        [input.guestSessionId, input.command.idempotencyKey],
      );
      if (priorCommand.rows[0]) {
        if (priorCommand.rows[0]["request_hash"] !== input.command.requestHash) {
          throw new DomainError(409, "idempotency-conflict", "Idempotency key was already used for another request");
        }
        await client.query("COMMIT");
        return {
          fileId: String((priorCommand.rows[0]["response_body"] as { file_id: string }).file_id),
          replayed: true,
        };
      }
      const source = await client.query(
        `SELECT * FROM upload_sessions WHERE upload_session_id=$1 AND owner_kind='guest'
         AND guest_session_id=$2 AND state='ready' FOR UPDATE`,
        [input.uploadSessionId, input.guestSessionId],
      );
      if (!source.rows[0]) throw new DomainError(409, "upload-not-ready", "Guest upload is not ready to save");
      if (source.rows[0]["asset_original_id"] !== input.assetOriginalId || source.rows[0]["source_version_id"] !== input.sourceVersionId) {
        throw new DomainError(409, "source-identity-conflict", "Guest source identity changed unexpectedly");
      }
      const member = await client.query(
        "SELECT 1 FROM memberships WHERE workspace_id=$1 AND actor_id=$2",
        [input.workspaceId, input.actorId],
      );
      if (!member.rows[0]) throw new DomainError(403, "access-denied", "You do not have access to this workspace");
      const existingObject = await client.query(
        "SELECT * FROM object_references WHERE workspace_id=$1 AND object_key=$2",
        [input.workspaceId, input.immutableObjectKey],
      );
      let objectReferenceId = input.objectReferenceId;
      if (existingObject.rows[0]) {
        if (existingObject.rows[0]["sha256"] !== input.sha256 || Number(existingObject.rows[0]["byte_size"]) !== input.byteSize) {
          throw new DomainError(409, "immutable-object-conflict", "Immutable object identity conflicts with stored facts");
        }
        objectReferenceId = String(existingObject.rows[0]["object_reference_id"]);
      } else {
        await client.query(
          `INSERT INTO object_references(object_reference_id,workspace_id,object_key,sha256,media_type,byte_size,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [objectReferenceId, input.workspaceId, input.immutableObjectKey, input.sha256, input.mediaType, input.byteSize, input.now],
        );
      }
      await client.query(
        `INSERT INTO asset_originals(asset_original_id,workspace_id,object_reference_id,original_filename,created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [input.assetOriginalId, input.workspaceId, objectReferenceId, input.displayName, input.now],
      );
      await client.query(
        `INSERT INTO source_versions(source_version_id,workspace_id,asset_original_id,object_reference_id,sequence,created_at)
         VALUES ($1,$2,$3,$4,1,$5)`,
        [input.sourceVersionId, input.workspaceId, input.assetOriginalId, objectReferenceId, input.now],
      );
      const defaults = await client.query(
        "SELECT default_files_id FROM default_files_locations WHERE workspace_id=$1",
        [input.workspaceId],
      );
      await client.query(
        `INSERT INTO workspace_files(file_id,workspace_id,asset_original_id,current_source_version_id,
         display_name,canonical_location_kind,default_files_id,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,'default_files',$6,$7,$7)`,
        [input.fileId, input.workspaceId, input.assetOriginalId, input.sourceVersionId,
          input.displayName, defaults.rows[0]["default_files_id"], input.now],
      );
      await client.query(
        `INSERT INTO guest_upload_handoffs(upload_session_id,guest_session_id,workspace_id,actor_id,
         object_reference_id,asset_original_id,source_version_id,file_id,handed_off_at,trace_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [input.uploadSessionId, input.guestSessionId, input.workspaceId, input.actorId,
          objectReferenceId, input.assetOriginalId, input.sourceVersionId, input.fileId,
          input.now, input.command.traceId],
      );
      const auditId = `audit-${randomUUID()}`;
      const usageId = `usage-${randomUUID()}`;
      await client.query(
        `INSERT INTO audit_events(audit_event_id,workspace_id,actor_id,action,resource_kind,resource_id,occurred_at,trace_id)
         VALUES ($1,$2,$3,'guest-source.handed-off','file',$4,$5,$6)`,
        [auditId, input.workspaceId, input.actorId, input.fileId, input.now, input.command.traceId],
      );
      await client.query(
        `INSERT INTO usage_events(usage_event_id,workspace_id,actor_id,event_kind,customer_amount,credit_debit,currency,occurred_at)
         VALUES ($1,$2,$3,'guest-source.handed-off',0,0,'USD',$4)`,
        [usageId, input.workspaceId, input.actorId, input.now],
      );
      await client.query(
        "INSERT INTO usage_admin_dimensions(usage_event_id,dimensions) VALUES ($1,$2)",
        [usageId, { resource_kind: "file", operation: "guest_handoff" }],
      );
      await client.query(
        `INSERT INTO intake_idempotency_records(owner_scope,idempotency_key,command_name,request_hash,response_body,created_at)
         VALUES ($1,$2,'guest-source.handoff',$3,$4,$5)`,
        [input.guestSessionId, input.command.idempotencyKey, input.command.requestHash,
          { file_id: input.fileId }, input.now],
      );
      await client.query("COMMIT");
      return { fileId: input.fileId, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export const GUEST_HANDOFF_REPOSITORY = Symbol("GUEST_HANDOFF_REPOSITORY");
