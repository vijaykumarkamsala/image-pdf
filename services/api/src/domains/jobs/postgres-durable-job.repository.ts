import { randomUUID } from "node:crypto";
import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import type { IntakeFailure, JobEventRecord, ProcessingJobRecord, UploadSessionRecord } from "ipw-contracts-ts/product";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

import { DomainError } from "../../kernel/errors.js";
import { runMigrations } from "../../kernel/migrations.js";
import type { IntakeCommand, IntakeOwner } from "../intake/intake.types.js";
import type {
  ClaimedJob,
  DurableJobRepository,
  JobCreateResult,
  JobOutboxRecord,
} from "./durable-job.types.js";

function instant(value: Date | string | null): string | null {
  return value === null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function job(row: QueryResultRow): ProcessingJobRecord {
  return {
    schema_version: PRODUCT_SCHEMA_VERSION,
    job_id: String(row["job_id"]),
    kind: "file_intake_inspection",
    owner_kind: String(row["owner_kind"]) as ProcessingJobRecord["owner_kind"],
    workspace_id: row["workspace_id"] ? String(row["workspace_id"]) : null,
    actor_id: row["actor_id"] ? String(row["actor_id"]) : null,
    guest_session_id: row["guest_session_id"] ? String(row["guest_session_id"]) : null,
    upload_session_id: String(row["upload_session_id"]),
    state: String(row["state"]) as ProcessingJobRecord["state"],
    attempt: Number(row["attempt"]),
    max_attempts: Number(row["max_attempts"]),
    progress_percent: Number(row["progress_percent"]),
    lease_owner: row["lease_owner"] ? String(row["lease_owner"]) : null,
    lease_expires_at: instant(row["lease_expires_at"] as Date | string | null),
    heartbeat_at: instant(row["heartbeat_at"] as Date | string | null),
    next_attempt_at: instant(row["next_attempt_at"] as Date | string | null),
    failure: (row["failure"] as IntakeFailure | null) ?? null,
    created_at: instant(row["created_at"] as Date | string)!,
    updated_at: instant(row["updated_at"] as Date | string)!,
  };
}

function upload(row: QueryResultRow): UploadSessionRecord {
  return {
    schema_version: PRODUCT_SCHEMA_VERSION,
    upload_session_id: String(row["upload_session_id"]),
    owner_kind: String(row["owner_kind"]) as UploadSessionRecord["owner_kind"],
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
    created_at: instant(row["created_at"] as Date | string)!,
    expires_at: instant(row["expires_at"] as Date | string)!,
    updated_at: instant(row["updated_at"] as Date | string)!,
  };
}

export class PostgresDurableJobRepository implements DurableJobRepository {
  constructor(private readonly pool: Pool) {}

  static async connect(connectionString: string, migrate = false): Promise<PostgresDurableJobRepository> {
    const pool = new Pool({ connectionString, max: 5 });
    if (migrate) await runMigrations(pool);
    return new PostgresDurableJobRepository(pool);
  }

  async createForUpload(
    uploadSessionId: string,
    owner: IntakeOwner,
    value: ProcessingJobRecord,
    command: IntakeCommand,
    traceId: string,
  ): Promise<JobCreateResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const prior = await client.query(
        `SELECT command_name, request_hash, response_body FROM intake_idempotency_records
         WHERE owner_scope=$1 AND idempotency_key=$2 FOR UPDATE`,
        [command.ownerScope, command.idempotencyKey],
      );
      if (prior.rows[0]) {
        if (prior.rows[0]["command_name"] !== command.commandName || prior.rows[0]["request_hash"] !== command.requestHash) {
          throw new DomainError(409, "idempotency-conflict", "Idempotency key was already used for another request");
        }
        const jobId = String((prior.rows[0]["response_body"] as { job_id: string }).job_id);
        const [jobResult, uploadResult] = await Promise.all([
          client.query("SELECT * FROM processing_jobs WHERE job_id=$1", [jobId]),
          client.query("SELECT * FROM upload_sessions WHERE upload_session_id=$1", [uploadSessionId]),
        ]);
        await client.query("COMMIT");
        return { job: job(jobResult.rows[0]), upload: upload(uploadResult.rows[0]), replayed: true };
      }
      const uploadResult = await client.query(
        `SELECT * FROM upload_sessions WHERE upload_session_id=$1 AND ${this.ownerSql(owner, 2)} FOR UPDATE`,
        [uploadSessionId, ...this.ownerValues(owner)],
      );
      const currentUpload = uploadResult.rows[0];
      if (!currentUpload) throw new DomainError(404, "upload-not-found", "Upload session was not found");
      if (currentUpload["job_id"]) throw new DomainError(409, "upload-already-finalised", "Upload is already finalising");
      if (currentUpload["state"] !== "uploading" || Number(currentUpload["bytes_received"]) !== Number(currentUpload["expected_byte_size"])) {
        throw new DomainError(409, "upload-incomplete", "Finish uploading every byte before continuing");
      }
      await client.query(
        `INSERT INTO processing_jobs(job_id,kind,owner_kind,workspace_id,actor_id,guest_session_id,
         upload_session_id,state,attempt,max_attempts,progress_percent,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [value.job_id, value.kind, value.owner_kind, value.workspace_id, value.actor_id,
          value.guest_session_id, value.upload_session_id, value.state, value.attempt,
          value.max_attempts, value.progress_percent, value.created_at, value.updated_at],
      );
      const updatedUpload = await client.query(
        `UPDATE upload_sessions SET state='finalising', job_id=$1, updated_at=$2
         WHERE upload_session_id=$3 RETURNING *`,
        [value.job_id, value.updated_at, uploadSessionId],
      );
      await this.insertEvent(client, value, "job.queued", traceId);
      await client.query(
        `INSERT INTO job_outbox(outbox_id,job_id,dispatch_kind,payload,available_at,created_at)
         VALUES ($1,$2,'process_job',$3,$4,$4)`,
        [`outbox-${randomUUID()}`, value.job_id, { job_id: value.job_id }, value.created_at],
      );
      await client.query(
        `INSERT INTO intake_idempotency_records(owner_scope,idempotency_key,command_name,request_hash,response_body,created_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [command.ownerScope, command.idempotencyKey, command.commandName, command.requestHash,
          { job_id: value.job_id }, value.created_at],
      );
      await client.query("COMMIT");
      return { job: value, upload: upload(updatedUpload.rows[0]), replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async findJob(jobId: string, owner: IntakeOwner): Promise<ProcessingJobRecord | null> {
    const result = await this.pool.query(
      `SELECT * FROM processing_jobs WHERE job_id=$1 AND ${this.ownerSql(owner, 2)}`,
      [jobId, ...this.ownerValues(owner)],
    );
    return result.rows[0] ? job(result.rows[0]) : null;
  }

  async findJobByActor(jobId: string, actorId: string): Promise<ProcessingJobRecord | null> {
    const result = await this.pool.query(
      "SELECT * FROM processing_jobs WHERE job_id=$1 AND owner_kind='actor' AND actor_id=$2",
      [jobId, actorId],
    );
    return result.rows[0] ? job(result.rows[0]) : null;
  }

  async listEvents(jobId: string, owner: IntakeOwner, after: number, limit: number): Promise<JobEventRecord[]> {
    const allowed = await this.findJob(jobId, owner);
    if (!allowed) throw new DomainError(404, "job-not-found", "Job was not found");
    const result = await this.pool.query(
      `SELECT * FROM job_events WHERE job_id=$1 AND cursor>$2 ORDER BY cursor LIMIT $3`,
      [jobId, after, limit],
    );
    return result.rows.map((row) => ({
      schema_version: PRODUCT_SCHEMA_VERSION,
      job_event_id: String(row["job_event_id"]),
      job_id: String(row["job_id"]),
      cursor: Number(row["cursor"]),
      event_kind: String(row["event_kind"]),
      state: String(row["state"]) as JobEventRecord["state"],
      progress_percent: Number(row["progress_percent"]),
      occurred_at: instant(row["occurred_at"] as Date | string)!,
      trace_id: String(row["trace_id"]),
    }));
  }

  async requestCancel(jobId: string, owner: IntakeOwner, now: string, traceId: string): Promise<ProcessingJobRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query(
        `SELECT * FROM processing_jobs WHERE job_id=$1 AND ${this.ownerSql(owner, 2)} FOR UPDATE`,
        [jobId, ...this.ownerValues(owner)],
      );
      if (!found.rows[0]) throw new DomainError(404, "job-not-found", "Job was not found");
      const current = job(found.rows[0]);
      if (["succeeded", "failed", "cancelled"].includes(current.state)) {
        await client.query("COMMIT");
        return current;
      }
      const state = ["queued", "retry_wait"].includes(current.state) ? "cancelled" : "cancel_requested";
      const updatedResult = await client.query(
        "UPDATE processing_jobs SET state=$1,updated_at=$2 WHERE job_id=$3 RETURNING *",
        [state, now, jobId],
      );
      const updated = job(updatedResult.rows[0]);
      await this.insertEvent(client, updated, state === "cancelled" ? "job.cancelled" : "job.cancel-requested", traceId);
      await client.query("COMMIT");
      return updated;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async pendingOutbox(now: string, limit: number): Promise<JobOutboxRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM job_outbox WHERE state='pending' AND available_at <= $1
       ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $2`,
      [now, limit],
    );
    return result.rows.map((row) => ({
      outboxId: String(row["outbox_id"]),
      jobId: String(row["job_id"]),
      availableAt: instant(row["available_at"] as Date | string)!,
      deliveryAttempts: Number(row["delivery_attempts"]),
    }));
  }

  async markOutboxDispatched(outboxId: string, now: string): Promise<void> {
    await this.pool.query(
      `UPDATE job_outbox SET state='dispatched',delivery_attempts=delivery_attempts+1,dispatched_at=$1
       WHERE outbox_id=$2`,
      [now, outboxId],
    );
  }

  async claim(
    workerId: string,
    leaseToken: string,
    leaseTokenHash: string,
    now: string,
    leaseExpiresAt: string,
    traceId: string,
  ): Promise<ClaimedJob | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `SELECT * FROM processing_jobs WHERE
          (state='queued' OR (state='retry_wait' AND (next_attempt_at IS NULL OR next_attempt_at <= $1))
           OR (state IN ('leased','running') AND lease_expires_at <= $1))
          AND attempt < max_attempts ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
        [now],
      );
      if (!result.rows[0]) {
        await client.query("COMMIT");
        return null;
      }
      const updatedResult = await client.query(
        `UPDATE processing_jobs SET state='leased',attempt=attempt+1,lease_owner=$1,
         lease_token_hash=$2,lease_expires_at=$3,heartbeat_at=$4,next_attempt_at=NULL,updated_at=$4
         WHERE job_id=$5 RETURNING *`,
        [workerId, leaseTokenHash, leaseExpiresAt, now, result.rows[0]["job_id"]],
      );
      const updated = job(updatedResult.rows[0]);
      await this.insertEvent(client, updated, "job.leased", traceId);
      await client.query("COMMIT");
      return { job: updated, leaseToken };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async start(jobId: string, leaseTokenHash: string, now: string, traceId: string): Promise<ProcessingJobRecord> {
    return this.transitionLeased(jobId, leaseTokenHash, now, "running", 10, "job.started", traceId);
  }

  async heartbeat(jobId: string, leaseTokenHash: string, now: string, leaseExpiresAt: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE processing_jobs SET heartbeat_at=$1,lease_expires_at=$2,updated_at=$1
       WHERE job_id=$3 AND lease_token_hash=$4 AND state IN ('leased','running','cancel_requested')`,
      [now, leaseExpiresAt, jobId, leaseTokenHash],
    );
    if (!result.rowCount) throw new DomainError(409, "job-lease-invalid", "Job lease is invalid");
  }

  async checkpoint(
    jobId: string,
    leaseTokenHash: string,
    key: string,
    payload: Record<string, unknown>,
    now: string,
  ): Promise<void> {
    const result = await this.pool.query(
      `INSERT INTO job_checkpoints(job_id,attempt,checkpoint_key,payload,created_at)
       SELECT job_id,attempt,$3,$4,$5 FROM processing_jobs
       WHERE job_id=$1 AND lease_token_hash=$2 AND state IN ('running','cancel_requested')
       ON CONFLICT (job_id,attempt,checkpoint_key) DO UPDATE SET payload=EXCLUDED.payload`,
      [jobId, leaseTokenHash, key, payload, now],
    );
    if (!result.rowCount) throw new DomainError(409, "job-lease-invalid", "Job lease is invalid");
    await this.pool.query(
      "UPDATE processing_jobs SET progress_percent=GREATEST(progress_percent,50),updated_at=$1 WHERE job_id=$2",
      [now, jobId],
    );
  }

  async succeed(jobId: string, leaseTokenHash: string, now: string, traceId: string): Promise<ProcessingJobRecord> {
    return this.transitionLeased(jobId, leaseTokenHash, now, "succeeded", 100, "job.succeeded", traceId);
  }

  async fail(
    jobId: string,
    leaseTokenHash: string,
    failure: IntakeFailure,
    now: string,
    retryAt: string,
    traceId: string,
  ): Promise<ProcessingJobRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query(
        "SELECT * FROM processing_jobs WHERE job_id=$1 AND lease_token_hash=$2 FOR UPDATE",
        [jobId, leaseTokenHash],
      );
      if (!found.rows[0]) throw new DomainError(409, "job-lease-invalid", "Job lease is invalid");
      const current = job(found.rows[0]);
      const retry = failure.retryable && current.attempt < current.max_attempts;
      const result = await client.query(
        `UPDATE processing_jobs SET state=$1,failure=$2,next_attempt_at=$3,lease_owner=NULL,
         lease_token_hash=NULL,lease_expires_at=NULL,updated_at=$4 WHERE job_id=$5 RETURNING *`,
        [retry ? "retry_wait" : "failed", failure, retry ? retryAt : null, now, jobId],
      );
      const updated = job(result.rows[0]);
      await this.insertEvent(client, updated, retry ? "job.retry-scheduled" : "job.failed", traceId);
      if (retry) {
        await client.query(
          `INSERT INTO job_outbox(outbox_id,job_id,dispatch_kind,payload,available_at,created_at)
           VALUES ($1,$2,'process_job',$3,$4,$5)`,
          [`outbox-${randomUUID()}`, jobId, { job_id: jobId }, retryAt, now],
        );
      }
      await client.query("COMMIT");
      return updated;
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

  private async transitionLeased(
    jobId: string,
    leaseTokenHash: string,
    now: string,
    state: "running" | "succeeded",
    progress: number,
    eventKind: string,
    traceId: string,
  ): Promise<ProcessingJobRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE processing_jobs SET state=$1,progress_percent=$2,updated_at=$3
         WHERE job_id=$4 AND lease_token_hash=$5 AND state=$6 RETURNING *`,
        [state, progress, now, jobId, leaseTokenHash, state === "running" ? "leased" : "running"],
      );
      if (!result.rows[0]) throw new DomainError(409, "job-lease-invalid", "Job lease is invalid or state changed");
      const updated = job(result.rows[0]);
      await this.insertEvent(client, updated, eventKind, traceId);
      await client.query("COMMIT");
      return updated;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private insertEvent(
    client: PoolClient,
    value: ProcessingJobRecord,
    eventKind: string,
    traceId: string,
  ): Promise<unknown> {
    return client.query(
      `INSERT INTO job_events(job_event_id,job_id,event_kind,state,progress_percent,occurred_at,trace_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [`event-${randomUUID()}`, value.job_id, eventKind, value.state, value.progress_percent, value.updated_at, traceId],
    );
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
