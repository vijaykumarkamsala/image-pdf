import type {
  IntakeFailure,
  JobEventRecord,
  ProcessingJobRecord,
  UploadSessionRecord,
} from "ipw-contracts-ts/product";

import type { IntakeCommand, IntakeOwner } from "../intake/intake.types.js";
import type { JobView } from "./job-pagination.js";

export interface JobCreateResult {
  job: ProcessingJobRecord;
  upload: UploadSessionRecord;
  replayed: boolean;
}

export interface JobPageResult {
  jobs: ProcessingJobRecord[];
  nextCursor: string | null;
}

export interface JobRetryResult {
  job: ProcessingJobRecord;
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
  traceId: string;
  leaseOwner: string;
}

export interface StoredCheckpoint {
  attempt: number;
  key: string;
  payload: Record<string, unknown>;
}

export interface AcceptedInspection {
  objectReferenceId: string;
  assetOriginalId: string;
  sourceVersionId: string;
  fileId: string | null;
  immutableObjectKey: string;
  facts: NonNullable<UploadSessionRecord["source_facts"]>;
}

export interface InspectionCompletion {
  job: ProcessingJobRecord;
  upload: UploadSessionRecord;
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
  findWorkspaceJob(jobId: string): Promise<ProcessingJobRecord | null>;
  listWorkspaceJobs(workspaceId: string, view: JobView, cursor: string | undefined, limit: number): Promise<JobPageResult>;
  listEvents(jobId: string, owner: IntakeOwner, after: number, limit: number): Promise<JobEventRecord[]>;
  requestCancel(jobId: string, owner: IntakeOwner, now: string, traceId: string): Promise<ProcessingJobRecord>;
  retry(
    jobId: string,
    owner: IntakeOwner,
    command: IntakeCommand,
    now: string,
    traceId: string,
  ): Promise<JobRetryResult>;
  claimOutbox(workerId: string, now: string, leaseExpiresAt: string, limit: number): Promise<JobOutboxRecord[]>;
  markOutboxDispatched(outboxId: string, workerId: string, now: string): Promise<void>;
  releaseOutbox(
    outboxId: string,
    workerId: string,
    availableAt: string,
    errorCategory: string,
  ): Promise<void>;
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
  latestCheckpoint(jobId: string): Promise<StoredCheckpoint | null>;
  succeed(jobId: string, leaseTokenHash: string, now: string, traceId: string): Promise<ProcessingJobRecord>;
  completeAccepted(
    jobId: string,
    leaseTokenHash: string,
    result: AcceptedInspection,
    now: string,
    traceId: string,
  ): Promise<InspectionCompletion>;
  completeRejected(
    jobId: string,
    leaseTokenHash: string,
    failure: IntakeFailure,
    now: string,
    traceId: string,
  ): Promise<InspectionCompletion>;
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
