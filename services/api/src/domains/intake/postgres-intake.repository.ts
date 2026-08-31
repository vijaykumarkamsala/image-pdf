import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import type { GuestSessionRecord, IntakeClassificationRecord, UploadSessionRecord } from "ipw-contracts-ts/product";
import { Pool, type QueryResultRow } from "pg";

import { DomainError } from "../../kernel/errors.js";
import { runMigrations } from "../../kernel/migrations.js";
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

function instant(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function classification(row: QueryResultRow): IntakeClassificationRecord {
  return {
    schema_version: PRODUCT_SCHEMA_VERSION,
    upload_session_id: String(row["upload_session_id"]),
    inferred_category: (row["inferred_category"] as IntakeClassificationRecord["inferred_category"]) ?? null,
    evidence_label: String(row["evidence_label"]) as IntakeClassificationRecord["evidence_label"],
    confidence_percent: null,
    evidence: Array.isArray(row["evidence"]) ? row["evidence"].map(String) : [],
    customer_category: (row["customer_category"] as IntakeClassificationRecord["customer_category"]) ?? null,
    updated_at: instant(row["updated_at"] as Date | string),
  };
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
      expected_sha256: row["expected_sha256"] ? String(row["expected_sha256"]) : null,
      verified_sha256: row["verified_sha256"] ? String(row["verified_sha256"]) : null,
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
      objectKey: String(row["immutable_object_key"] ?? row["quarantine_object_key"]),
      zone: row["immutable_object_key"] ? "immutable" : "quarantine",
      generation: row["provider_generation"] ? String(row["provider_generation"]) : undefined,
    },
    uploadTokenHash: String(row["upload_token_hash"]),
    uploadTokenExpiresAt: instant(row["upload_token_expires_at"] as Date | string),
    transferProvider: String(row["transfer_provider"]) as StoredUploadSession["transferProvider"],
    protectedProviderSession: row["protected_resumable_uri"] ? String(row["protected_resumable_uri"]) : null,
    providerMetadata: (row["provider_metadata"] as ProviderObjectMetadata | null) ?? null,
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

  async revokeGuest(guestSessionId: string, now: string): Promise<void> {
    await this.pool.query(
      "UPDATE guest_sessions SET revoked_at=$2 WHERE guest_session_id=$1 AND revoked_at IS NULL",
      [guestSessionId, now],
    );
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
          display_name, expected_media_type, expected_byte_size, expected_sha256, bytes_received, state,
          constraints, upload_token_hash, upload_token_expires_at, quarantine_object_key,
          transfer_provider, created_at, expires_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [record.upload_session_id, record.owner_kind, record.workspace_id, record.actor_id,
          record.guest_session_id, record.display_name, record.expected_media_type,
          record.expected_byte_size, record.expected_sha256, record.bytes_received, record.state, record.constraints,
          value.uploadTokenHash, value.uploadTokenExpiresAt, value.quarantineRef.objectKey,
          value.transferProvider, record.created_at, record.expires_at, record.updated_at],
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

  async setUploadProviderState(
    uploadSessionId: string,
    owner: IntakeOwner,
    transferProvider: StoredUploadSession["transferProvider"],
    protectedProviderSession: string | null,
    updatedAt: string,
  ): Promise<StoredUploadSession> {
    const result = await this.pool.query(
      `UPDATE upload_sessions SET transfer_provider=$1,protected_resumable_uri=$2,updated_at=$3
       WHERE upload_session_id=$4 AND ${this.ownerSql(owner, 5)} RETURNING *`,
      [transferProvider, protectedProviderSession, updatedAt, uploadSessionId, ...this.ownerValues(owner)],
    );
    if (!result.rows[0]) throw new DomainError(404, "upload-not-found", "Upload session was not found");
    return stored(result.rows[0]);
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

  async listWorkspaceUploads(workspaceId: string): Promise<StoredUploadSession[]> {
    const result = await this.pool.query(
      `SELECT * FROM upload_sessions WHERE owner_kind='actor' AND workspace_id=$1
       ORDER BY updated_at DESC,upload_session_id DESC`,
      [workspaceId],
    );
    return result.rows.map(stored);
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

  async recordProviderObject(
    uploadSessionId: string,
    owner: IntakeOwner,
    metadata: ProviderObjectMetadata,
    now: string,
  ): Promise<StoredUploadSession> {
    const result = await this.pool.query(
      `UPDATE upload_sessions SET bytes_received=$1,state='uploading',provider_generation=$2,
       provider_metadata=$3,verified_sha256=$4,updated_at=$5
       WHERE upload_session_id=$6 AND ${this.ownerSql(owner, 7)}
       AND state IN ('initiated','uploading') RETURNING *`,
      [metadata.byteSize, metadata.generation, metadata, metadata.calculatedSha256, now, uploadSessionId, ...this.ownerValues(owner)],
    );
    if (!result.rows[0]) throw new DomainError(409, "upload-state-conflict", "Upload cannot be reconciled in its current state");
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

  async findClassification(
    uploadSessionId: string,
    owner: IntakeOwner,
  ): Promise<IntakeClassificationRecord | null> {
    const result = await this.pool.query(
      `SELECT classification.* FROM intake_classifications classification
       WHERE classification.upload_session_id=$1 AND EXISTS (
         SELECT 1 FROM upload_sessions WHERE upload_session_id=classification.upload_session_id
           AND ${this.ownerSql(owner, 2)}
       )`,
      [uploadSessionId, ...this.ownerValues(owner)],
    );
    return result.rows[0] ? classification(result.rows[0]) : null;
  }

  async saveClassification(
    value: IntakeClassificationRecord,
    owner: IntakeOwner,
    command: IntakeCommand,
    createdAt: string,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const upload = await client.query(
        `SELECT state FROM upload_sessions WHERE upload_session_id=$1
         AND ${this.ownerSql(owner, 2)} FOR UPDATE`,
        [value.upload_session_id, ...this.ownerValues(owner)],
      );
      if (!upload.rows[0]) throw new DomainError(404, "upload-not-found", "Upload session was not found");
      if (upload.rows[0]["state"] !== "ready") {
        throw new DomainError(409, "intake-not-ready", "Classification can be corrected only after inspection");
      }
      const prior = await client.query(
        `SELECT command_name,request_hash,response_body FROM intake_idempotency_records
         WHERE owner_scope=$1 AND idempotency_key=$2 FOR UPDATE`,
        [command.ownerScope, command.idempotencyKey],
      );
      if (prior.rows[0]) {
        if (prior.rows[0]["command_name"] !== command.commandName || prior.rows[0]["request_hash"] !== command.requestHash) {
          throw new DomainError(409, "idempotency-conflict", "Idempotency key was already used for another request");
        }
        const replay = (prior.rows[0]["response_body"] as { classification: IntakeClassificationRecord }).classification;
        await client.query("COMMIT");
        return { classification: replay, replayed: true };
      }
      const result = await client.query(
        `INSERT INTO intake_classifications(upload_session_id,inferred_category,evidence_label,confidence_percent,
           evidence,customer_category,updated_at) VALUES ($1,$2,$3,NULL,$4,$5,$6)
         ON CONFLICT (upload_session_id) DO UPDATE SET
           inferred_category=EXCLUDED.inferred_category,
           evidence_label=EXCLUDED.evidence_label,
           confidence_percent=NULL,
           evidence=EXCLUDED.evidence,
           customer_category=EXCLUDED.customer_category,
           updated_at=EXCLUDED.updated_at
         RETURNING *`,
        [value.upload_session_id, value.inferred_category, value.evidence_label,
          JSON.stringify(value.evidence), value.customer_category, value.updated_at],
      );
      const saved = classification(result.rows[0]);
      await client.query(
        `INSERT INTO intake_idempotency_records(owner_scope,idempotency_key,command_name,
         request_hash,response_body,created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
        [command.ownerScope, command.idempotencyKey, command.commandName, command.requestHash,
          { classification: saved }, createdAt],
      );
      await client.query("COMMIT");
      return { classification: saved, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async claimCleanup(
    workerId: string,
    now: string,
    leaseExpiresAt: string,
    limit: number,
  ): Promise<CleanupCandidate[]> {
    await this.pool.query(
      `UPDATE upload_sessions SET state='expired', updated_at=$1
       WHERE expires_at <= $1 AND (
         state IN ('initiated','uploading') OR (owner_kind='guest' AND state IN ('ready','rejected'))
       )`,
      [now],
    );
    const result = await this.pool.query(
      `WITH candidates AS (
         SELECT upload_session_id FROM upload_sessions
         WHERE cleanup_completed_at IS NULL
           AND state IN ('expired','rejected','cancelled')
           AND (cleanup_lease_expires_at IS NULL OR cleanup_lease_expires_at <= $2)
         ORDER BY expires_at,created_at FOR UPDATE SKIP LOCKED LIMIT $4
       )
       UPDATE upload_sessions upload SET cleanup_lease_owner=$1,cleanup_lease_expires_at=$3
       FROM candidates WHERE upload.upload_session_id=candidates.upload_session_id
       RETURNING upload.upload_session_id,upload.owner_kind,upload.workspace_id,upload.actor_id,
         upload.guest_session_id,upload.quarantine_object_key,upload.immutable_object_key,
         upload.provider_generation`,
      [workerId, now, leaseExpiresAt, limit],
    );
    return result.rows.map((row) => ({
      uploadSessionId: String(row["upload_session_id"]),
      owner: row["owner_kind"] === "actor"
        ? {
            ownerKind: "actor" as const,
            ownerScope: String(row["workspace_id"]),
            workspaceId: String(row["workspace_id"]),
            actorId: String(row["actor_id"]),
          }
        : {
            ownerKind: "guest" as const,
            ownerScope: String(row["guest_session_id"]),
            guestSessionId: String(row["guest_session_id"]),
          },
      object: {
        ownerScope: String(row["owner_kind"] === "actor" ? row["workspace_id"] : row["guest_session_id"]),
        objectKey: String(row["immutable_object_key"] ?? row["quarantine_object_key"]),
        zone: row["immutable_object_key"] ? "immutable" as const : "quarantine" as const,
        generation: row["provider_generation"] ? String(row["provider_generation"]) : undefined,
      },
    }));
  }

  async completeCleanup(uploadSessionId: string, workerId: string, now: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE upload_sessions SET cleanup_completed_at=$1,cleanup_lease_owner=NULL,
       cleanup_lease_expires_at=NULL WHERE upload_session_id=$2 AND cleanup_lease_owner=$3
       AND cleanup_completed_at IS NULL`,
      [now, uploadSessionId, workerId],
    );
    if (!result.rowCount) throw new DomainError(409, "cleanup-lease-invalid", "Cleanup lease is invalid");
  }

  async releaseCleanup(uploadSessionId: string, workerId: string): Promise<void> {
    await this.pool.query(
      `UPDATE upload_sessions SET cleanup_lease_owner=NULL,cleanup_lease_expires_at=NULL
       WHERE upload_session_id=$1 AND cleanup_lease_owner=$2 AND cleanup_completed_at IS NULL`,
      [uploadSessionId, workerId],
    );
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
