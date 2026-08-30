import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import type { GuestSessionRecord, UploadSessionRecord } from "ipw-contracts-ts/product";
import { Pool, type QueryResultRow } from "pg";

import { DomainError } from "../../kernel/errors.js";
import { runMigrations } from "../../kernel/migrations.js";
import type {
  IntakeCommand,
  IntakeOwner,
  IntakeRepository,
  StoredUploadSession,
  UploadCreateResult,
} from "./intake.types.js";
import type { PrivateObjectRef } from "./private-object-store.js";

function instant(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function stored(row: QueryResultRow): StoredUploadSession {
  const ownerKind = String(row["owner_kind"]) as "actor" | "guest";
  return {
    record: {
      schema_version: PRODUCT_SCHEMA_VERSION,
      upload_session_id: String(row["upload_session_id"]),
      owner_kind: ownerKind,
      workspace_id: row["workspace_id"] ? String(row["workspace_id"]) : null,
      actor_id: row["actor_id"] ? String(row["actor_id"]) : null,
      guest_session_id: row["guest_session_id"] ? String(row["guest_session_id"]) : null,
      display_name: String(row["display_name"]),
      expected_media_type: String(row["expected_media_type"]),
      expected_byte_size: Number(row["expected_byte_size"]),
      bytes_received: Number(row["bytes_received"]),
      state: String(row["state"]) as UploadSessionRecord["state"],
      constraints: row["constraints"] as UploadSessionRecord["constraints"],
      job_id: row["job_id"] ? String(row["job_id"]) : null,
      asset_original_id: row["asset_original_id"] ? String(row["asset_original_id"]) : null,
      source_version_id: row["source_version_id"] ? String(row["source_version_id"]) : null,
      file_id: row["file_id"] ? String(row["file_id"]) : null,
      source_facts: (row["source_facts"] as UploadSessionRecord["source_facts"]) ?? null,
      failure: (row["failure"] as UploadSessionRecord["failure"]) ?? null,
      created_at: instant(row["created_at"] as Date | string),
      expires_at: instant(row["expires_at"] as Date | string),
      updated_at: instant(row["updated_at"] as Date | string),
    },
    quarantineRef: {
      ownerScope: ownerKind === "actor" ? String(row["workspace_id"]) : String(row["guest_session_id"]),
      objectKey: String(row["quarantine_object_key"]),
      zone: "quarantine",
    },
    uploadTokenHash: String(row["upload_token_hash"]),
    uploadTokenExpiresAt: instant(row["upload_token_expires_at"] as Date | string),
  };
}

export class PostgresIntakeRepository implements IntakeRepository {
  constructor(private readonly pool: Pool) {}

  static async connect(connectionString: string, migrate = false): Promise<PostgresIntakeRepository> {
    const pool = new Pool({ connectionString, max: 5 });
    if (migrate) await runMigrations(pool);
    return new PostgresIntakeRepository(pool);
  }

  async createGuest(record: GuestSessionRecord, tokenHash: string, createdAt: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO guest_sessions(guest_session_id, token_hash, expires_at, created_at)
       VALUES ($1,$2,$3,$4)`,
      [record.guest_session_id, tokenHash, record.expires_at, createdAt],
    );
  }

  async findGuest(tokenHash: string, now: string): Promise<GuestSessionRecord | null> {
    const result = await this.pool.query(
      `SELECT guest_session_id, expires_at FROM guest_sessions
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2`,
      [tokenHash, now],
    );
    const row = result.rows[0];
    return row ? {
      schema_version: PRODUCT_SCHEMA_VERSION,
      guest_session_id: String(row["guest_session_id"]),
      expires_at: instant(row["expires_at"] as Date | string),
    } : null;
  }

  async createUpload(
    value: StoredUploadSession,
    command: IntakeCommand,
    createdAt: string,
  ): Promise<UploadCreateResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const prior = await client.query(
        `SELECT command_name, request_hash, response_body FROM intake_idempotency_records
         WHERE owner_scope = $1 AND idempotency_key = $2 FOR UPDATE`,
        [command.ownerScope, command.idempotencyKey],
      );
      if (prior.rows[0]) {
        if (prior.rows[0]["command_name"] !== command.commandName || prior.rows[0]["request_hash"] !== command.requestHash) {
          throw new DomainError(409, "idempotency-conflict", "Idempotency key was already used for another request");
        }
        const uploadId = String((prior.rows[0]["response_body"] as { upload_session_id: string }).upload_session_id);
        const replay = await client.query("SELECT * FROM upload_sessions WHERE upload_session_id = $1", [uploadId]);
        await client.query("COMMIT");
        return { stored: stored(replay.rows[0]), replayed: true };
      }
      const record = value.record;
      await client.query(
        `INSERT INTO upload_sessions(
          upload_session_id, owner_kind, workspace_id, actor_id, guest_session_id,
          display_name, expected_media_type, expected_byte_size, bytes_received, state,
          constraints, upload_token_hash, upload_token_expires_at, quarantine_object_key,
          created_at, expires_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [record.upload_session_id, record.owner_kind, record.workspace_id, record.actor_id,
          record.guest_session_id, record.display_name, record.expected_media_type,
          record.expected_byte_size, record.bytes_received, record.state, record.constraints,
          value.uploadTokenHash, value.uploadTokenExpiresAt, value.quarantineRef.objectKey,
          record.created_at, record.expires_at, record.updated_at],
      );
      await client.query(
        `INSERT INTO intake_idempotency_records(owner_scope, idempotency_key, command_name,
         request_hash, response_body, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
        [command.ownerScope, command.idempotencyKey, command.commandName, command.requestHash,
          { upload_session_id: record.upload_session_id }, createdAt],
      );
      await client.query("COMMIT");
      return { stored: value, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async rotateUploadToken(
    uploadSessionId: string,
    owner: IntakeOwner,
    tokenHash: string,
    expiresAt: string,
    updatedAt: string,
  ): Promise<StoredUploadSession> {
    const result = await this.pool.query(
      `UPDATE upload_sessions SET upload_token_hash=$1, upload_token_expires_at=$2, updated_at=$3
       WHERE upload_session_id=$4 AND ${this.ownerSql(owner, 5)} RETURNING *`,
      [tokenHash, expiresAt, updatedAt, uploadSessionId, ...this.ownerValues(owner)],
    );
    if (!result.rows[0]) throw new DomainError(404, "upload-not-found", "Upload session was not found");
    return stored(result.rows[0]);
  }

  async findUpload(uploadSessionId: string, owner: IntakeOwner): Promise<StoredUploadSession | null> {
    const result = await this.pool.query(
      `SELECT * FROM upload_sessions WHERE upload_session_id=$1 AND ${this.ownerSql(owner, 2)}`,
      [uploadSessionId, ...this.ownerValues(owner)],
    );
    return result.rows[0] ? stored(result.rows[0]) : null;
  }

  async findUploadByActor(uploadSessionId: string, actorId: string): Promise<StoredUploadSession | null> {
    const result = await this.pool.query(
      "SELECT * FROM upload_sessions WHERE upload_session_id=$1 AND owner_kind='actor' AND actor_id=$2",
      [uploadSessionId, actorId],
    );
    return result.rows[0] ? stored(result.rows[0]) : null;
  }

  async findUploadByToken(uploadSessionId: string, tokenHash: string, now: string): Promise<StoredUploadSession | null> {
    const result = await this.pool.query(
      `SELECT * FROM upload_sessions WHERE upload_session_id=$1 AND upload_token_hash=$2
       AND upload_token_expires_at > $3`,
      [uploadSessionId, tokenHash, now],
    );
    return result.rows[0] ? stored(result.rows[0]) : null;
  }

  async recordUploadedBytes(
    uploadSessionId: string,
    tokenHash: string,
    bytesReceived: number,
    now: string,
  ): Promise<StoredUploadSession> {
    const result = await this.pool.query(
      `UPDATE upload_sessions SET bytes_received=$1, state='uploading', updated_at=$2
       WHERE upload_session_id=$3 AND upload_token_hash=$4 AND upload_token_expires_at > $2
       AND state IN ('initiated','uploading') RETURNING *`,
      [bytesReceived, now, uploadSessionId, tokenHash],
    );
    if (!result.rows[0]) throw new DomainError(401, "upload-authorization-invalid", "Upload authorization is invalid or expired");
    return stored(result.rows[0]);
  }

  async cancelUpload(uploadSessionId: string, owner: IntakeOwner, now: string): Promise<StoredUploadSession> {
    const current = await this.findUpload(uploadSessionId, owner);
    if (!current) throw new DomainError(404, "upload-not-found", "Upload session was not found");
    if (["ready", "rejected", "expired", "cancelled"].includes(current.record.state)) return current;
    const result = await this.pool.query(
      `UPDATE upload_sessions SET state='cancelled', updated_at=$1
       WHERE upload_session_id=$2 AND ${this.ownerSql(owner, 3)} RETURNING *`,
      [now, uploadSessionId, ...this.ownerValues(owner)],
    );
    return stored(result.rows[0]);
  }

  async expireUploads(now: string): Promise<PrivateObjectRef[]> {
    const result = await this.pool.query(
      `UPDATE upload_sessions SET state='expired', updated_at=$1
       WHERE expires_at <= $1 AND state IN ('initiated','uploading')
       RETURNING owner_kind, workspace_id, guest_session_id, quarantine_object_key`,
      [now],
    );
    return result.rows.map((row) => ({
      ownerScope: String(row["owner_kind"] === "actor" ? row["workspace_id"] : row["guest_session_id"]),
      objectKey: String(row["quarantine_object_key"]),
      zone: "quarantine",
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private ownerSql(owner: IntakeOwner, start: number): string {
    return owner.ownerKind === "actor"
      ? `owner_kind='actor' AND workspace_id=$${start} AND actor_id=$${start + 1}`
      : `owner_kind='guest' AND guest_session_id=$${start}`;
  }

  private ownerValues(owner: IntakeOwner): string[] {
    return owner.ownerKind === "actor"
      ? [String(owner.workspaceId), String(owner.actorId)]
      : [String(owner.guestSessionId)];
  }
}
