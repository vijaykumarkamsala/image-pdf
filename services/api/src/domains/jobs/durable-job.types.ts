import type {
  IntakeFailure,
  JobEventRecord,
  ProcessingJobRecord,
  UploadSessionRecord,
} from "ipw-contracts-ts/product";

import type { IntakeCommand, IntakeOwner } from "../intake/intake.types.js";

export interface JobCreateResult {
  job: ProcessingJobRecord;
  upload: UploadSessionRecord;
  replayed: boolean;
}

export interface ClaimedJob {
  job: ProcessingJobRecord;
  leaseToken: string;
}

export interface JobOutboxRecord {
  outboxId: string;
  jobId: string;
  availableAt: string;
  deliveryAttempts: number;
}

export interface DurableJobRepository {
  createForUpload(
    uploadSessionId: string,
    owner: IntakeOwner,
    job: ProcessingJobRecord,
    command: IntakeCommand,
    traceId: string,
  ): Promise<JobCreateResult>;
  findJob(jobId: string, owner: IntakeOwner): Promise<ProcessingJobRecord | null>;
  findJobByActor(jobId: string, actorId: string): Promise<ProcessingJobRecord | null>;
  listEvents(jobId: string, owner: IntakeOwner, after: number, limit: number): Promise<JobEventRecord[]>;
  requestCancel(jobId: string, owner: IntakeOwner, now: string, traceId: string): Promise<ProcessingJobRecord>;
  pendingOutbox(now: string, limit: number): Promise<JobOutboxRecord[]>;
  markOutboxDispatched(outboxId: string, now: string): Promise<void>;
  claim(
    workerId: string,
    leaseToken: string,
    leaseTokenHash: string,
    now: string,
    leaseExpiresAt: string,
    traceId: string,
  ): Promise<ClaimedJob | null>;
  start(jobId: string, leaseTokenHash: string, now: string, traceId: string): Promise<ProcessingJobRecord>;
  heartbeat(jobId: string, leaseTokenHash: string, now: string, leaseExpiresAt: string): Promise<void>;
  checkpoint(
    jobId: string,
    leaseTokenHash: string,
    key: string,
    payload: Record<string, unknown>,
    now: string,
  ): Promise<void>;
  succeed(jobId: string, leaseTokenHash: string, now: string, traceId: string): Promise<ProcessingJobRecord>;
  fail(
    jobId: string,
    leaseTokenHash: string,
    failure: IntakeFailure,
    now: string,
    retryAt: string,
    traceId: string,
  ): Promise<ProcessingJobRecord>;
  close(): Promise<void>;
}

export const DURABLE_JOB_REPOSITORY = Symbol("DURABLE_JOB_REPOSITORY");
