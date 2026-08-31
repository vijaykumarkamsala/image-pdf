import { Inject, Injectable, OnApplicationShutdown } from "@nestjs/common";
import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import type { IdempotentCommandResult, ProcessingJobRecord } from "ipw-contracts-ts/product";

import { IdentityBoundary } from "../identity/identity.service.js";
import { IntakeService } from "../intake/intake.service.js";
import type { IntakeOwner } from "../intake/intake.types.js";
import { DomainError, requireId } from "../../kernel/errors.js";
import {
  PRODUCT_REPOSITORY,
  RUNTIME_VALUES,
  type CommandContext,
  type ProductKernelRepository,
} from "../../kernel/product.types.js";
import { requestDigest, type RuntimeValues } from "../../kernel/runtime.js";
import { DURABLE_JOB_REPOSITORY, type DurableJobRepository } from "./durable-job.types.js";
import type { JobView } from "./job-pagination.js";

type Headers = Record<string, string | string[] | undefined>;

@Injectable()
export class JobsService implements OnApplicationShutdown {
  constructor(
    @Inject(DURABLE_JOB_REPOSITORY) private readonly repository: DurableJobRepository,
    @Inject(PRODUCT_REPOSITORY) private readonly product: ProductKernelRepository,
    @Inject(RUNTIME_VALUES) private readonly runtime: RuntimeValues,
    private readonly intake: IntakeService,
    private readonly identity: IdentityBoundary,
  ) {}

  async finalise(headers: Headers, uploadSessionId: string) {
    const stored = await this.intake.reconcileForFinalise(headers, uploadSessionId);
    const owner = this.intake.ownerFor(stored.record);
    const now = this.runtime.now();
    const context = await this.command(headers, owner, "upload.finalise", { uploadSessionId: stored.record.upload_session_id });
    const job: ProcessingJobRecord = {
      schema_version: PRODUCT_SCHEMA_VERSION,
      job_id: this.runtime.id("job"),
      kind: "file_intake_inspection",
      owner_kind: owner.ownerKind,
      workspace_id: owner.workspaceId ?? null,
      actor_id: owner.actorId ?? null,
      guest_session_id: owner.guestSessionId ?? null,
      upload_session_id: stored.record.upload_session_id,
      state: "queued",
      attempt: 0,
      max_attempts: 3,
      progress_percent: 0,
      lease_owner: null,
      lease_expires_at: null,
      heartbeat_at: null,
      next_attempt_at: null,
      failure: null,
      created_at: now,
      updated_at: now,
    };
    const created = await this.repository.createForUpload(
      stored.record.upload_session_id,
      owner,
      job,
      {
        ownerScope: owner.ownerScope,
        idempotencyKey: context.idempotencyKey,
        commandName: "upload.finalise",
        requestHash: context.requestHash,
      },
      context.traceId,
    );
    if (!created.replayed && owner.ownerKind === "actor") {
      await this.product.recordExternalMutation(context, owner.workspaceId!, "upload.finalised", "processing_job", created.job.job_id);
    }
    const command: IdempotentCommandResult = {
      schema_version: PRODUCT_SCHEMA_VERSION,
      idempotency_key: context.idempotencyKey,
      replayed: created.replayed,
      resource_kind: "processing_job",
      resource_id: created.job.job_id,
    };
    return { schema_version: PRODUCT_SCHEMA_VERSION, upload_session: created.upload, job: created.job, command };
  }

  async get(headers: Headers, jobId: string) {
    const { job } = await this.requireAccessible(headers, requireId(jobId, "job id"));
    return { schema_version: PRODUCT_SCHEMA_VERSION, job };
  }

  async list(headers: Headers, workspaceId: string, view: JobView, cursor: string | undefined, limit: number) {
    const principal = await this.identity.resolve(headers);
    const id = requireId(workspaceId, "workspace id");
    const context = await this.product.workspaceContext(principal.actorId, id);
    if (!context?.effectivePermissions.some((item) => item.permission === "job.read" && item.allowed)) {
      throw new DomainError(403, "access-denied", "You do not have permission to view Jobs in this workspace");
    }
    const page = await this.repository.listWorkspaceJobs(id, view, cursor, limit);
    return { schema_version: PRODUCT_SCHEMA_VERSION, jobs: page.jobs, next_cursor: page.nextCursor };
  }

  async events(headers: Headers, jobId: string, after: number, limit: number) {
    const { job, owner } = await this.requireAccessible(headers, requireId(jobId, "job id"));
    const events = await this.repository.listEvents(job.job_id, owner, after, limit);
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      events,
      next_cursor: events.at(-1)?.cursor ?? after,
    };
  }

  async cancel(headers: Headers, jobId: string) {
    const id = requireId(jobId, "job id");
    const { job: current, owner } = await this.requireAccessible(headers, id, "job.cancel");
    if (["succeeded", "failed", "cancelled", "cancel_requested"].includes(current.state)) {
      return { schema_version: PRODUCT_SCHEMA_VERSION, job: current };
    }
    const context = await this.command(headers, owner, "job.cancel", { jobId: id });
    const job = await this.repository.requestCancel(id, owner, this.runtime.now(), context.traceId);
    if (owner.ownerKind === "actor") {
      await this.product.recordExternalMutation(context, owner.workspaceId!, "job.cancellation-requested", "processing_job", id);
      if (job.state === "cancelled") {
        await this.product.recordExternalMutation(context, owner.workspaceId!, "job.cancelled", "processing_job", id);
      }
    }
    return { schema_version: PRODUCT_SCHEMA_VERSION, job };
  }

  async retry(headers: Headers, jobId: string) {
    const id = requireId(jobId, "job id");
    const { owner } = await this.requireAccessible(headers, id, "job.retry");
    const context = await this.command(headers, owner, "job.retry", { jobId: id });
    const result = await this.repository.retry(id, owner, {
      ownerScope: owner.ownerScope,
      idempotencyKey: context.idempotencyKey,
      commandName: "job.retry",
      requestHash: context.requestHash,
    }, this.runtime.now(), context.traceId);
    if (!result.replayed && owner.ownerKind === "actor") {
      await this.product.recordExternalMutation(context, owner.workspaceId!, "job.retry-requested", "processing_job", id);
    }
    const command: IdempotentCommandResult = {
      schema_version: PRODUCT_SCHEMA_VERSION,
      idempotency_key: context.idempotencyKey,
      replayed: result.replayed,
      resource_kind: "processing_job",
      resource_id: id,
    };
    return { schema_version: PRODUCT_SCHEMA_VERSION, job: result.job, command };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.repository.close();
  }

  private async requireAccessible(
    headers: Headers,
    jobId: string,
    permission = "job.read",
  ): Promise<{ job: ProcessingJobRecord; owner: IntakeOwner }> {
    if (this.intake.hasGuestToken(headers)) {
      const owner = await this.intake.guestOwner(headers);
      const job = await this.repository.findJob(jobId, owner);
      if (!job) throw new DomainError(404, "job-not-found", "Job was not found");
      return { job, owner };
    }
    const principal = await this.identity.resolve(headers);
    const job = await this.repository.findWorkspaceJob(jobId);
    if (!job?.workspace_id || !job.actor_id) throw new DomainError(404, "job-not-found", "Job was not found");
    const context = await this.product.workspaceContext(principal.actorId, job.workspace_id);
    if (!context?.effectivePermissions.some((item) => item.permission === permission && item.allowed)) {
      throw new DomainError(404, "job-not-found", "Job was not found");
    }
    return {
      job,
      owner: { ownerKind: "actor", ownerScope: job.workspace_id, workspaceId: job.workspace_id, actorId: job.actor_id },
    };
  }

  private async command(headers: Headers, owner: IntakeOwner, name: string, payload: unknown): Promise<CommandContext> {
    const idempotencyKey = requireId(this.header(headers, "idempotency-key"), "Idempotency-Key");
    const traceId = requireId(this.header(headers, "x-trace-id"), "trace id");
    return {
      principal: {
        actorId: owner.ownerKind === "actor" ? (await this.identity.resolve(headers)).actorId : owner.guestSessionId!,
        displayName: owner.ownerKind,
      },
      idempotencyKey,
      traceId,
      requestHash: requestDigest({ command: name, payload }),
    };
  }

  private header(headers: Headers, name: string): string | undefined {
    const value = headers[name];
    return (Array.isArray(value) ? value[0] : value)?.trim();
  }
}
