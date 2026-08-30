import { randomUUID } from "node:crypto";
import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import type { IntakeFailure, JobEventRecord, ProcessingJobRecord, UploadSessionRecord } from "ipw-contracts-ts/product";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

import { DomainError } from "../../kernel/errors.js";
import { runMigrations } from "../../kernel/migrations.js";
import type { IntakeCommand, IntakeOwner } from "../intake/intake.types.js";
import type {
  AcceptedInspection,
  ClaimedJob,
  DurableJobRepository,
  JobCreateResult,
  JobOutboxRecord,
  InspectionCompletion,
  StoredCheckpoint,
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
        `INSERT INTO job_outbox(outbox_id,job_id,dispatch_kind,payload,trace_id,available_at,created_at)
         VALUES ($1,$2,'process_job',$3,$4,$5,$5)`,
        [`outbox-${randomUUID()}`, value.job_id, { job_id: value.job_id }, traceId, value.created_at],
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
      if (current.state === "cancel_requested") {
        await client.query("COMMIT");
        return current;
      }
      const state = ["queued", "retry_wait"].includes(current.state) ? "cancelled" : "cancel_requested";
      const updatedResult = await client.query(
        "UPDATE processing_jobs SET state=$1,updated_at=$2 WHERE job_id=$3 RETURNING *",
        [state, now, jobId],
      );
      const updated = job(updatedResult.rows[0]);
      if (state === "cancelled") {
        await client.query(
          "UPDATE upload_sessions SET state='cancelled',updated_at=$1 WHERE upload_session_id=$2",
          [now, updated.upload_session_id],
        );
      }
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

  async claimOutbox(workerId: string, now: string, leaseExpiresAt: string, limit: number): Promise<JobOutboxRecord[]> {
    const result = await this.pool.query(
      `WITH candidates AS (
         SELECT outbox_id FROM job_outbox
         WHERE (state='pending' OR (state='dispatching' AND lease_expires_at <= $2))
           AND available_at <= $2
         ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $4
       )
       UPDATE job_outbox outbox SET state='dispatching',lease_owner=$1,lease_expires_at=$3,
         delivery_attempts=delivery_attempts+1,last_error_category=NULL
       FROM candidates WHERE outbox.outbox_id=candidates.outbox_id RETURNING outbox.*`,
      [workerId, now, leaseExpiresAt, limit],
    );
    return result.rows.map((row) => ({
      outboxId: String(row["outbox_id"]),
      jobId: String(row["job_id"]),
      availableAt: instant(row["available_at"] as Date | string)!,
      deliveryAttempts: Number(row["delivery_attempts"]),
      traceId: String(row["trace_id"]),
      leaseOwner: String(row["lease_owner"]),
    }));
  }

  async markOutboxDispatched(outboxId: string, workerId: string, now: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE job_outbox SET state='dispatched',dispatched_at=$1,lease_owner=NULL,lease_expires_at=NULL
       WHERE outbox_id=$2 AND state='dispatching' AND lease_owner=$3`,
      [now, outboxId, workerId],
    );
    if (!result.rowCount) throw new DomainError(409, "outbox-lease-invalid", "Outbox delivery lease is invalid");
  }

  async releaseOutbox(
    outboxId: string,
    workerId: string,
    availableAt: string,
    errorCategory: string,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE job_outbox SET state='pending',available_at=$1,last_error_category=$2,
       lease_owner=NULL,lease_expires_at=NULL
       WHERE outbox_id=$3 AND state='dispatching' AND lease_owner=$4`,
      [availableAt, errorCategory, outboxId, workerId],
    );
    if (!result.rowCount) throw new DomainError(409, "outbox-lease-invalid", "Outbox delivery lease is invalid");
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

  async latestCheckpoint(jobId: string): Promise<StoredCheckpoint | null> {
    const result = await this.pool.query(
      `SELECT attempt,checkpoint_key,payload FROM job_checkpoints
       WHERE job_id=$1 ORDER BY attempt DESC,created_at DESC LIMIT 1`,
      [jobId],
    );
    const row = result.rows[0];
    return row ? {
      attempt: Number(row["attempt"]),
      key: String(row["checkpoint_key"]),
      payload: row["payload"] as Record<string, unknown>,
    } : null;
  }

  async succeed(jobId: string, leaseTokenHash: string, now: string, traceId: string): Promise<ProcessingJobRecord> {
    return this.transitionLeased(jobId, leaseTokenHash, now, "succeeded", 100, "job.succeeded", traceId);
  }

  async completeAccepted(
    jobId: string,
    leaseTokenHash: string,
    result: AcceptedInspection,
    now: string,
    traceId: string,
  ): Promise<InspectionCompletion> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query(
        "SELECT * FROM processing_jobs WHERE job_id=$1 AND lease_token_hash=$2 AND state='running' FOR UPDATE",
        [jobId, leaseTokenHash],
      );
      if (!found.rows[0]) throw new DomainError(409, "job-lease-invalid", "Job lease is invalid or state changed");
      const current = job(found.rows[0]);
      const uploadResult = await client.query(
        "SELECT * FROM upload_sessions WHERE upload_session_id=$1 FOR UPDATE",
        [current.upload_session_id],
      );
      const currentUpload = upload(uploadResult.rows[0]);
      let fileId: string | null = null;
      if (current.owner_kind === "actor" && current.workspace_id && current.actor_id && result.fileId) {
        const existingObject = await client.query(
          "SELECT * FROM object_references WHERE workspace_id=$1 AND object_key=$2",
          [current.workspace_id, result.immutableObjectKey],
        );
        let objectReferenceId = result.objectReferenceId;
        if (existingObject.rows[0]) {
          if (existingObject.rows[0]["sha256"] !== result.facts.sha256 || Number(existingObject.rows[0]["byte_size"]) !== result.facts.byte_size) {
            throw new DomainError(409, "immutable-object-conflict", "Immutable object identity conflicts with stored facts");
          }
          objectReferenceId = String(existingObject.rows[0]["object_reference_id"]);
        } else {
          await client.query(
            `INSERT INTO object_references(object_reference_id,workspace_id,object_key,sha256,media_type,byte_size,created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [objectReferenceId, current.workspace_id, result.immutableObjectKey, result.facts.sha256,
              result.facts.detected_media_type, result.facts.byte_size, now],
          );
        }
        await client.query(
          `INSERT INTO asset_originals(asset_original_id,workspace_id,object_reference_id,original_filename,created_at)
           VALUES ($1,$2,$3,$4,$5)`,
          [result.assetOriginalId, current.workspace_id, objectReferenceId, currentUpload.display_name, now],
        );
        await client.query(
          `INSERT INTO source_versions(source_version_id,workspace_id,asset_original_id,object_reference_id,sequence,created_at)
           VALUES ($1,$2,$3,$4,1,$5)`,
          [result.sourceVersionId, current.workspace_id, result.assetOriginalId, objectReferenceId, now],
        );
        const defaults = await client.query(
          "SELECT default_files_id FROM default_files_locations WHERE workspace_id=$1",
          [current.workspace_id],
        );
        fileId = result.fileId;
        await client.query(
          `INSERT INTO workspace_files(file_id,workspace_id,asset_original_id,current_source_version_id,
           display_name,canonical_location_kind,default_files_id,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,'default_files',$6,$7,$7)`,
          [fileId, current.workspace_id, result.assetOriginalId, result.sourceVersionId,
            currentUpload.display_name, defaults.rows[0]["default_files_id"], now],
        );
        const auditId = `audit-${randomUUID()}`;
        const usageId = `usage-${randomUUID()}`;
        await client.query(
          `INSERT INTO audit_events(audit_event_id,workspace_id,actor_id,action,resource_kind,resource_id,occurred_at,trace_id)
           VALUES ($1,$2,$3,'file.intake-ready','file',$4,$5,$6)`,
          [auditId, current.workspace_id, current.actor_id, fileId, now, traceId],
        );
        await client.query(
          `INSERT INTO usage_events(usage_event_id,workspace_id,actor_id,event_kind,customer_amount,credit_debit,currency,occurred_at)
           VALUES ($1,$2,$3,'file.intake-ready',0,0,'USD',$4)`,
          [usageId, current.workspace_id, current.actor_id, now],
        );
        await client.query(
          "INSERT INTO usage_admin_dimensions(usage_event_id,dimensions) VALUES ($1,$2)",
          [usageId, { resource_kind: "file", operation: "secure_intake" }],
        );
      }
      const readyResult = await client.query(
        `UPDATE upload_sessions SET state='ready',immutable_object_key=$1,asset_original_id=$2,
         source_version_id=$3,file_id=$4,source_facts=$5,updated_at=$6
         WHERE upload_session_id=$7 RETURNING *`,
        [result.immutableObjectKey, result.assetOriginalId, result.sourceVersionId, fileId,
          result.facts, now, current.upload_session_id],
      );
      const completedResult = await client.query(
        `UPDATE processing_jobs SET state='succeeded',progress_percent=100,updated_at=$1
         WHERE job_id=$2 RETURNING *`,
        [now, jobId],
      );
      const completed = job(completedResult.rows[0]);
      await this.insertEvent(client, completed, "job.succeeded", traceId);
      await client.query("COMMIT");
      return { job: completed, upload: upload(readyResult.rows[0]) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async completeRejected(
    jobId: string,
    leaseTokenHash: string,
    failure: IntakeFailure,
    now: string,
    traceId: string,
  ): Promise<InspectionCompletion> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query(
        "SELECT * FROM processing_jobs WHERE job_id=$1 AND lease_token_hash=$2 AND state='running' FOR UPDATE",
        [jobId, leaseTokenHash],
      );
      if (!found.rows[0]) throw new DomainError(409, "job-lease-invalid", "Job lease is invalid or state changed");
      const current = job(found.rows[0]);
      const rejectedResult = await client.query(
        `UPDATE upload_sessions SET state='rejected',failure=$1,updated_at=$2
         WHERE upload_session_id=$3 RETURNING *`,
        [failure, now, current.upload_session_id],
      );
      const completedResult = await client.query(
        `UPDATE processing_jobs SET state='succeeded',progress_percent=100,updated_at=$1
         WHERE job_id=$2 RETURNING *`,
        [now, jobId],
      );
      const completed = job(completedResult.rows[0]);
      await this.insertEvent(client, completed, "job.completed-with-rejection", traceId);
      await client.query("COMMIT");
      return { job: completed, upload: upload(rejectedResult.rows[0]) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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
      if (current.state === "cancel_requested") {
        const cancelledResult = await client.query(
          `UPDATE processing_jobs SET state='cancelled',failure=NULL,lease_owner=NULL,lease_token_hash=NULL,
           lease_expires_at=NULL,updated_at=$1 WHERE job_id=$2 RETURNING *`,
          [now, jobId],
        );
        await client.query(
          `UPDATE upload_sessions SET state='cancelled',updated_at=$1
           WHERE upload_session_id=$2 AND state IN ('finalising','inspecting')`,
          [now, current.upload_session_id],
        );
        const cancelled = job(cancelledResult.rows[0]);
        await this.insertEvent(client, cancelled, "job.cancelled", traceId);
        await client.query("COMMIT");
        return cancelled;
      }
      const retry = failure.retryable && current.attempt < current.max_attempts;
      const result = await client.query(
        `UPDATE processing_jobs SET state=$1,failure=$2,next_attempt_at=$3,lease_owner=NULL,
         lease_token_hash=NULL,lease_expires_at=NULL,updated_at=$4 WHERE job_id=$5 RETURNING *`,
        [retry ? "retry_wait" : "failed", failure, retry ? retryAt : null, now, jobId],
      );
      const updated = job(result.rows[0]);
      if (!retry) {
        await client.query(
          `UPDATE upload_sessions SET state='rejected',failure=$1,updated_at=$2
           WHERE upload_session_id=$3 AND state='inspecting'`,
          [failure, now, updated.upload_session_id],
        );
      }
      await this.insertEvent(client, updated, retry ? "job.retry-scheduled" : "job.failed", traceId);
      if (retry) {
        await client.query(
          `INSERT INTO job_outbox(outbox_id,job_id,dispatch_kind,payload,trace_id,available_at,created_at)
           VALUES ($1,$2,'process_job',$3,$4,$5,$6)`,
          [`outbox-${randomUUID()}`, jobId, { job_id: jobId }, traceId, retryAt, now],
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
      if (state === "running") {
        await client.query(
          `UPDATE upload_sessions SET state='inspecting',updated_at=$1
           WHERE upload_session_id=$2 AND state IN ('finalising','inspecting')`,
          [now, updated.upload_session_id],
        );
      }
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
