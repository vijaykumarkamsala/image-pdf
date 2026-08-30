import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import type { IntakeFailure, JobEventRecord, ProcessingJobRecord } from "ipw-contracts-ts/product";

import { DomainError } from "../../kernel/errors.js";
import type { IntakeCommand, IntakeOwner } from "../intake/intake.types.js";
import { MemoryIntakeRepository } from "../intake/memory-intake.repository.js";
import { MemoryProductKernelRepository } from "../../kernel/memory.repository.js";
import type { CommandContext } from "../../kernel/product.types.js";
import type {
  AcceptedInspection,
  ClaimedJob,
  DurableJobRepository,
  JobCreateResult,
  JobOutboxRecord,
  InspectionCompletion,
  JobPageResult,
  JobRetryResult,
  StoredCheckpoint,
} from "./durable-job.types.js";
import { decodeJobCursor, encodeJobCursor, jobMatchesView, type JobView } from "./job-pagination.js";

interface CommandEntry {
  commandName: string;
  requestHash: string;
  jobId: string;
}

export class MemoryDurableJobRepository implements DurableJobRepository {
  private readonly jobs = new Map<string, ProcessingJobRecord>();
  private readonly events: JobEventRecord[] = [];
  private readonly outbox = new Map<string, JobOutboxRecord & {
    state: "pending" | "dispatching" | "dispatched";
    leaseExpiresAt?: string;
  }>();
  private readonly checkpoints = new Map<string, StoredCheckpoint>();
  private readonly commands = new Map<string, CommandEntry>();
  private readonly leaseHashes = new Map<string, string>();
  private cursor = 0;

  constructor(
    private readonly intake: MemoryIntakeRepository,
    private readonly product: MemoryProductKernelRepository,
  ) {}

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
      traceId,
      leaseOwner: "",
      state: "pending",
    });
    return { job, upload: upload.record, replayed: false };
  }

  async findJob(jobId: string, owner: IntakeOwner): Promise<ProcessingJobRecord | null> {
    const job = this.jobs.get(jobId);
    return job && this.ownedBy(job, owner) ? job : null;
  }

  async findWorkspaceJob(jobId: string): Promise<ProcessingJobRecord | null> {
    const job = this.jobs.get(jobId);
    return job?.owner_kind === "actor" ? job : null;
  }

  async listWorkspaceJobs(
    workspaceId: string,
    view: JobView,
    cursorValue: string | undefined,
    limit: number,
  ): Promise<JobPageResult> {
    const cursor = decodeJobCursor(cursorValue);
    const ordered = [...this.jobs.values()]
      .filter((item) => item.owner_kind === "actor" && item.workspace_id === workspaceId && jobMatchesView(item, view))
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || right.job_id.localeCompare(left.job_id))
      .filter((item) => !cursor || item.updated_at < cursor.updatedAt
        || (item.updated_at === cursor.updatedAt && item.job_id < cursor.jobId));
    const page = ordered.slice(0, limit + 1);
    const jobs = page.slice(0, limit);
    return { jobs, nextCursor: page.length > limit && jobs.length ? encodeJobCursor(jobs.at(-1)!) : null };
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

  async retry(
    jobId: string,
    owner: IntakeOwner,
    command: IntakeCommand,
    now: string,
    traceId: string,
  ): Promise<JobRetryResult> {
    const commandKey = `${command.ownerScope}:${command.idempotencyKey}`;
    const prior = this.commands.get(commandKey);
    if (prior) {
      if (prior.commandName !== command.commandName || prior.requestHash !== command.requestHash) {
        throw new DomainError(409, "idempotency-conflict", "Idempotency key was already used for another request");
      }
      return { job: this.requireJob(prior.jobId), replayed: true };
    }
    const current = await this.findJob(jobId, owner);
    if (!current || current.state !== "failed" || !current.failure?.retryable || current.max_attempts >= 20) {
      throw new DomainError(409, "job-not-retryable", "This job can no longer be retried");
    }
    this.intake.reopenForRetry(current.upload_session_id, owner, now);
    const updated: ProcessingJobRecord = {
      ...current,
      state: "queued",
      max_attempts: current.max_attempts + 1,
      progress_percent: 0,
      next_attempt_at: null,
      failure: null,
      lease_owner: null,
      lease_expires_at: null,
      heartbeat_at: null,
      updated_at: now,
    };
    this.jobs.set(jobId, updated);
    this.commands.set(commandKey, { commandName: command.commandName, requestHash: command.requestHash, jobId });
    this.event(updated, "job.retry-requested", traceId);
    const outboxId = `outbox-${jobId}-manual-${updated.max_attempts}`;
    this.outbox.set(outboxId, {
      outboxId,
      jobId,
      availableAt: now,
      deliveryAttempts: 0,
      traceId,
      leaseOwner: "",
      state: "pending",
    });
    return { job: updated, replayed: false };
  }

  async claimOutbox(workerId: string, now: string, leaseExpiresAt: string, limit: number): Promise<JobOutboxRecord[]> {
    const claimed = [...this.outbox.values()]
      .filter((entry) => (entry.state === "pending" || (entry.state === "dispatching" && entry.leaseExpiresAt! <= now))
        && entry.availableAt <= now)
      .slice(0, limit);
    return claimed.map((entry) => {
      const updated = {
        ...entry,
        state: "dispatching" as const,
        leaseOwner: workerId,
        leaseExpiresAt,
        deliveryAttempts: entry.deliveryAttempts + 1,
      };
      this.outbox.set(entry.outboxId, updated);
      return updated;
    });
  }

  async markOutboxDispatched(outboxId: string, workerId: string): Promise<void> {
    const entry = this.outbox.get(outboxId);
    if (entry?.state === "dispatching" && entry.leaseOwner === workerId) {
      this.outbox.set(outboxId, { ...entry, state: "dispatched", leaseOwner: "", leaseExpiresAt: undefined });
    }
  }

  async releaseOutbox(outboxId: string, workerId: string, availableAt: string): Promise<void> {
    const entry = this.outbox.get(outboxId);
    if (entry?.state === "dispatching" && entry.leaseOwner === workerId) {
      this.outbox.set(outboxId, { ...entry, state: "pending", availableAt, leaseOwner: "", leaseExpiresAt: undefined });
    }
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
    this.intake.markInspecting(current.upload_session_id, now);
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
    key: string,
    payload: Record<string, unknown>,
    now: string,
  ): Promise<void> {
    const current = this.requireLease(jobId, leaseTokenHash);
    this.checkpoints.set(jobId, { attempt: current.attempt, key, payload });
    this.jobs.set(jobId, { ...current, progress_percent: Math.max(current.progress_percent, 50), updated_at: now });
  }

  async latestCheckpoint(jobId: string): Promise<StoredCheckpoint | null> {
    return this.checkpoints.get(jobId) ?? null;
  }

  async succeed(jobId: string, leaseTokenHash: string, now: string, traceId: string): Promise<ProcessingJobRecord> {
    const current = this.requireLease(jobId, leaseTokenHash);
    if (current.state === "cancel_requested") {
      const cancelled = { ...current, state: "cancelled" as const, updated_at: now };
      this.jobs.set(jobId, cancelled);
      this.event(cancelled, "job.cancelled", traceId);
      return cancelled;
    }
    if (current.state !== "running") throw new DomainError(409, "job-state-conflict", "Job is not running");
    const updated = { ...current, state: "succeeded" as const, progress_percent: 100, updated_at: now };
    this.jobs.set(jobId, updated);
    this.event(updated, "job.succeeded", traceId);
    return updated;
  }

  async completeAccepted(
    jobId: string,
    leaseTokenHash: string,
    result: AcceptedInspection,
    now: string,
    traceId: string,
  ): Promise<InspectionCompletion> {
    const current = this.requireLease(jobId, leaseTokenHash);
    if (current.state !== "running") throw new DomainError(409, "job-state-conflict", "Job is not running");
    const upload = this.intake.completeAccepted(current.upload_session_id, {
      immutableObjectKey: result.immutableObjectKey,
      assetOriginalId: result.assetOriginalId,
      sourceVersionId: result.sourceVersionId,
      fileId: result.fileId,
      sourceFacts: result.facts,
      now,
    });
    if (current.owner_kind === "actor" && current.workspace_id && current.actor_id && result.fileId) {
      const context: CommandContext = {
        principal: { actorId: current.actor_id, displayName: "inspection-worker" },
        idempotencyKey: `worker-${jobId}`,
        traceId,
        requestHash: result.facts.sha256,
      };
      this.product.registerVerifiedOriginal({
        context,
        workspaceId: current.workspace_id,
        objectReferenceId: result.objectReferenceId,
        assetOriginalId: result.assetOriginalId,
        sourceVersionId: result.sourceVersionId,
        fileId: result.fileId,
        displayName: upload.record.display_name,
        objectKey: result.immutableObjectKey,
        sha256: result.facts.sha256,
        mediaType: result.facts.detected_media_type,
        byteSize: result.facts.byte_size,
      });
    }
    const completed = { ...current, state: "succeeded" as const, progress_percent: 100, updated_at: now };
    this.jobs.set(jobId, completed);
    this.event(completed, "job.succeeded", traceId);
    return { job: completed, upload: upload.record };
  }

  async completeRejected(
    jobId: string,
    leaseTokenHash: string,
    failure: IntakeFailure,
    now: string,
    traceId: string,
  ): Promise<InspectionCompletion> {
    const current = this.requireLease(jobId, leaseTokenHash);
    if (current.state !== "running") throw new DomainError(409, "job-state-conflict", "Job is not running");
    const upload = this.intake.completeRejected(current.upload_session_id, failure, now);
    const completed = { ...current, state: "succeeded" as const, progress_percent: 100, updated_at: now };
    this.jobs.set(jobId, completed);
    this.event(completed, "job.completed-with-rejection", traceId);
    return { job: completed, upload: upload.record };
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
    if (current.state === "cancel_requested") {
      const cancelled = { ...current, state: "cancelled" as const, failure: null, updated_at: now };
      this.jobs.set(jobId, cancelled);
      await this.intake.cancelUpload(current.upload_session_id, this.owner(current), now);
      this.event(cancelled, "job.cancelled", traceId);
      return cancelled;
    }
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
      this.outbox.set(id, {
        outboxId: id,
        jobId,
        availableAt: retryAt,
        deliveryAttempts: 0,
        traceId,
        leaseOwner: "",
        state: "pending",
      });
    } else {
      this.intake.completeRejected(current.upload_session_id, failure, now);
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

  private owner(job: ProcessingJobRecord): IntakeOwner {
    return job.owner_kind === "actor"
      ? { ownerKind: "actor", ownerScope: job.workspace_id!, workspaceId: job.workspace_id!, actorId: job.actor_id! }
      : { ownerKind: "guest", ownerScope: job.guest_session_id!, guestSessionId: job.guest_session_id! };
  }
}
