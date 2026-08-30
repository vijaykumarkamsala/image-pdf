import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import type { IntakeFailure, JobEventRecord, ProcessingJobRecord } from "ipw-contracts-ts/product";

import { DomainError } from "../../kernel/errors.js";
import type { IntakeCommand, IntakeOwner } from "../intake/intake.types.js";
import { MemoryIntakeRepository } from "../intake/memory-intake.repository.js";
import type {
  ClaimedJob,
  DurableJobRepository,
  JobCreateResult,
  JobOutboxRecord,
} from "./durable-job.types.js";

interface CommandEntry {
  commandName: string;
  requestHash: string;
  jobId: string;
}

export class MemoryDurableJobRepository implements DurableJobRepository {
  private readonly jobs = new Map<string, ProcessingJobRecord>();
  private readonly events: JobEventRecord[] = [];
  private readonly outbox = new Map<string, JobOutboxRecord & { dispatched: boolean }>();
  private readonly commands = new Map<string, CommandEntry>();
  private readonly leaseHashes = new Map<string, string>();
  private cursor = 0;

  constructor(private readonly intake: MemoryIntakeRepository) {}

  async createForUpload(
    uploadSessionId: string,
    owner: IntakeOwner,
    job: ProcessingJobRecord,
    command: IntakeCommand,
    traceId: string,
  ): Promise<JobCreateResult> {
    const commandKey = `${command.ownerScope}:${command.idempotencyKey}`;
    const prior = this.commands.get(commandKey);
    if (prior) {
      if (prior.commandName !== command.commandName || prior.requestHash !== command.requestHash) {
        throw new DomainError(409, "idempotency-conflict", "Idempotency key was already used for another request");
      }
      const existing = this.requireJob(prior.jobId);
      const upload = this.intake.finaliseForJob(uploadSessionId, owner, existing, job.updated_at);
      return { job: existing, upload: upload.record, replayed: true };
    }
    const upload = this.intake.finaliseForJob(uploadSessionId, owner, job, job.updated_at);
    this.jobs.set(job.job_id, job);
    this.commands.set(commandKey, { commandName: command.commandName, requestHash: command.requestHash, jobId: job.job_id });
    this.event(job, "job.queued", traceId);
    this.outbox.set(`outbox-${job.job_id}`, {
      outboxId: `outbox-${job.job_id}`,
      jobId: job.job_id,
      availableAt: job.created_at,
      deliveryAttempts: 0,
      dispatched: false,
    });
    return { job, upload: upload.record, replayed: false };
  }

  async findJob(jobId: string, owner: IntakeOwner): Promise<ProcessingJobRecord | null> {
    const job = this.jobs.get(jobId);
    return job && this.ownedBy(job, owner) ? job : null;
  }

  async findJobByActor(jobId: string, actorId: string): Promise<ProcessingJobRecord | null> {
    const job = this.jobs.get(jobId);
    return job?.actor_id === actorId ? job : null;
  }

  async listEvents(jobId: string, owner: IntakeOwner, after: number, limit: number): Promise<JobEventRecord[]> {
    if (!(await this.findJob(jobId, owner))) throw new DomainError(404, "job-not-found", "Job was not found");
    return this.events.filter((event) => event.job_id === jobId && event.cursor > after).slice(0, limit);
  }

  async requestCancel(jobId: string, owner: IntakeOwner, now: string, traceId: string): Promise<ProcessingJobRecord> {
    const current = await this.findJob(jobId, owner);
    if (!current) throw new DomainError(404, "job-not-found", "Job was not found");
    if (["succeeded", "failed", "cancelled"].includes(current.state)) return current;
    const state = ["queued", "retry_wait"].includes(current.state) ? "cancelled" : "cancel_requested";
    const updated = { ...current, state: state as ProcessingJobRecord["state"], updated_at: now };
    this.jobs.set(jobId, updated);
    this.event(updated, state === "cancelled" ? "job.cancelled" : "job.cancel-requested", traceId);
    return updated;
  }

  async pendingOutbox(now: string, limit: number): Promise<JobOutboxRecord[]> {
    return [...this.outbox.values()]
      .filter((entry) => !entry.dispatched && entry.availableAt <= now)
      .slice(0, limit);
  }

  async markOutboxDispatched(outboxId: string): Promise<void> {
    const entry = this.outbox.get(outboxId);
    if (entry) this.outbox.set(outboxId, { ...entry, dispatched: true, deliveryAttempts: entry.deliveryAttempts + 1 });
  }

  async claim(
    workerId: string,
    leaseToken: string,
    leaseTokenHash: string,
    now: string,
    leaseExpiresAt: string,
    traceId: string,
  ): Promise<ClaimedJob | null> {
    const current = [...this.jobs.values()].find(
      (job) => job.state === "queued" || (job.state === "retry_wait" && (!job.next_attempt_at || job.next_attempt_at <= now)),
    );
    if (!current) return null;
    const updated: ProcessingJobRecord = {
      ...current,
      state: "leased",
      attempt: current.attempt + 1,
      lease_owner: workerId,
      lease_expires_at: leaseExpiresAt,
      heartbeat_at: now,
      updated_at: now,
    };
    this.jobs.set(current.job_id, updated);
    this.leaseHashes.set(current.job_id, leaseTokenHash);
    this.event(updated, "job.leased", traceId);
    return { job: updated, leaseToken };
  }

  async start(jobId: string, leaseTokenHash: string, now: string, traceId: string): Promise<ProcessingJobRecord> {
    const current = this.requireLease(jobId, leaseTokenHash);
    if (current.state === "cancel_requested") return current;
    if (current.state !== "leased") throw new DomainError(409, "job-state-conflict", "Job cannot start from its current state");
    const updated = { ...current, state: "running" as const, progress_percent: 10, updated_at: now };
    this.jobs.set(jobId, updated);
    this.event(updated, "job.started", traceId);
    return updated;
  }

  async heartbeat(jobId: string, leaseTokenHash: string, now: string, leaseExpiresAt: string): Promise<void> {
    const current = this.requireLease(jobId, leaseTokenHash);
    this.jobs.set(jobId, { ...current, heartbeat_at: now, lease_expires_at: leaseExpiresAt, updated_at: now });
  }

  async checkpoint(
    jobId: string,
    leaseTokenHash: string,
    _key: string,
    _payload: Record<string, unknown>,
    now: string,
  ): Promise<void> {
    const current = this.requireLease(jobId, leaseTokenHash);
    this.jobs.set(jobId, { ...current, progress_percent: Math.max(current.progress_percent, 50), updated_at: now });
  }

  async succeed(jobId: string, leaseTokenHash: string, now: string, traceId: string): Promise<ProcessingJobRecord> {
    const current = this.requireLease(jobId, leaseTokenHash);
    if (current.state !== "running") throw new DomainError(409, "job-state-conflict", "Job is not running");
    const updated = { ...current, state: "succeeded" as const, progress_percent: 100, updated_at: now };
    this.jobs.set(jobId, updated);
    this.event(updated, "job.succeeded", traceId);
    return updated;
  }

  async fail(
    jobId: string,
    leaseTokenHash: string,
    failure: IntakeFailure,
    now: string,
    retryAt: string,
    traceId: string,
  ): Promise<ProcessingJobRecord> {
    const current = this.requireLease(jobId, leaseTokenHash);
    const retry = failure.retryable && current.attempt < current.max_attempts;
    const updated: ProcessingJobRecord = {
      ...current,
      state: retry ? "retry_wait" : "failed",
      failure,
      next_attempt_at: retry ? retryAt : null,
      lease_owner: null,
      lease_expires_at: null,
      updated_at: now,
    };
    this.jobs.set(jobId, updated);
    this.event(updated, retry ? "job.retry-scheduled" : "job.failed", traceId);
    if (retry) {
      const id = `outbox-${jobId}-${current.attempt + 1}`;
      this.outbox.set(id, { outboxId: id, jobId, availableAt: retryAt, deliveryAttempts: 0, dispatched: false });
    }
    return updated;
  }

  async close(): Promise<void> {}

  private requireJob(jobId: string): ProcessingJobRecord {
    const job = this.jobs.get(jobId);
    if (!job) throw new DomainError(404, "job-not-found", "Job was not found");
    return job;
  }

  private requireLease(jobId: string, leaseTokenHash: string): ProcessingJobRecord {
    const job = this.requireJob(jobId);
    if (this.leaseHashes.get(jobId) !== leaseTokenHash) throw new DomainError(409, "job-lease-invalid", "Job lease is invalid");
    return job;
  }

  private event(job: ProcessingJobRecord, eventKind: string, traceId: string): void {
    this.cursor += 1;
    this.events.push({
      schema_version: PRODUCT_SCHEMA_VERSION,
      job_event_id: `job-event-${String(this.cursor).padStart(6, "0")}`,
      job_id: job.job_id,
      cursor: this.cursor,
      event_kind: eventKind,
      state: job.state,
      progress_percent: job.progress_percent,
      occurred_at: job.updated_at,
      trace_id: traceId,
    });
  }

  private ownedBy(job: ProcessingJobRecord, owner: IntakeOwner): boolean {
    return owner.ownerKind === "actor"
      ? job.owner_kind === "actor" && job.workspace_id === owner.workspaceId && job.actor_id === owner.actorId
      : job.owner_kind === "guest" && job.guest_session_id === owner.guestSessionId;
  }
}
