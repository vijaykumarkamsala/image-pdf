import { Inject, Injectable } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";

import {
  INSPECTION_ADAPTER,
  MALWARE_SCANNER,
  type HeaderFirstInspectionAdapter,
  type MalwareScanner,
} from "../intake/inspection-adapter.js";
import { INTAKE_REPOSITORY, type IntakeOwner, type IntakeRepository } from "../intake/intake.types.js";
import { PRIVATE_OBJECT_STORE, type PrivateObjectStore } from "../intake/private-object-store.js";
import { RUNTIME_VALUES } from "../../kernel/product.types.js";
import type { RuntimeValues } from "../../kernel/runtime.js";
import { DURABLE_JOB_REPOSITORY, type DurableJobRepository } from "./durable-job.types.js";

@Injectable()
export class LocalInspectionExecutor {
  constructor(
    @Inject(DURABLE_JOB_REPOSITORY) private readonly jobs: DurableJobRepository,
    @Inject(INTAKE_REPOSITORY) private readonly intake: IntakeRepository,
    @Inject(PRIVATE_OBJECT_STORE) private readonly objects: PrivateObjectStore,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
    @Inject(INSPECTION_ADAPTER) private readonly inspector: HeaderFirstInspectionAdapter,
    @Inject(RUNTIME_VALUES) private readonly runtime: RuntimeValues,
  ) {}

  async runAvailable(): Promise<boolean> {
    const leaseToken = randomBytes(32).toString("base64url");
    const leaseHash = createHash("sha256").update(leaseToken).digest("hex");
    const now = this.runtime.now();
    const claimed = await this.jobs.claim(
      "local-inspection-worker",
      leaseToken,
      leaseHash,
      now,
      this.after(now, 60),
      "trace-local-inspection",
    );
    if (!claimed) return false;
    const job = await this.jobs.start(
      claimed.job.job_id,
      leaseHash,
      this.runtime.now(),
      "trace-local-inspection",
    );
    const owner = this.owner(job);
    if (!job.upload_session_id || job.kind !== "file_intake_inspection") throw new Error("local intake executor received a non-intake job");
    const stored = await this.intake.findUpload(job.upload_session_id, owner);
    if (!stored) throw new Error("claimed job upload is unavailable");
    try {
      const bytes = await this.objects.read(stored.quarantineRef, stored.record.constraints.max_bytes);
      const malwareState = await this.scanner.scan(bytes);
      const outcome = await this.inspector.inspect({
        bytes,
        displayName: stored.record.display_name,
        expectedMediaType: stored.record.expected_media_type,
        constraints: stored.record.constraints,
        malwareState,
      });
      await this.jobs.checkpoint(
        job.job_id,
        leaseHash,
        "header-and-malware-inspection",
        { ...(outcome.facts ?? outcome.failure ?? {}) },
        this.runtime.now(),
      );
      if (!outcome.accepted || !outcome.facts) {
        const failure = outcome.failure ?? {
          schema_version: PRODUCT_SCHEMA_VERSION,
          code: "inspection-failed",
          message: "The file could not be inspected",
          retryable: false,
        };
        if (failure.retryable) {
          await this.jobs.fail(
            job.job_id,
            leaseHash,
            failure,
            this.runtime.now(),
            this.after(this.runtime.now(), 30),
            "trace-local-inspection",
          );
        } else {
          await this.objects.remove(stored.quarantineRef);
          await this.jobs.completeRejected(
            job.job_id,
            leaseHash,
            failure,
            this.runtime.now(),
            "trace-local-inspection",
          );
        }
        return true;
      }
      const immutable = await this.objects.promote(stored.quarantineRef, outcome.facts.sha256);
      if (!immutable.generation) throw new Error("immutable object storage generation is unavailable");
      await this.jobs.completeAccepted(
        job.job_id,
        leaseHash,
        {
          objectReferenceId: this.runtime.id("object"),
          assetOriginalId: this.runtime.id("asset"),
          sourceVersionId: this.runtime.id("source"),
          fileId: owner.ownerKind === "actor" ? this.runtime.id("file") : null,
          immutableObjectKey: immutable.objectKey,
          immutableStorageGeneration: immutable.generation,
          facts: outcome.facts,
        },
        this.runtime.now(),
        "trace-local-inspection",
      );
      await this.objects.remove(stored.quarantineRef);
      return true;
    } catch (error) {
      await this.jobs.fail(
        job.job_id,
        leaseHash,
        {
          schema_version: PRODUCT_SCHEMA_VERSION,
          code: "inspection-runtime-failed",
          message: "The inspection worker could not complete this attempt",
          retryable: true,
        },
        this.runtime.now(),
        this.after(this.runtime.now(), 30),
        "trace-local-inspection",
      );
      if (process.env["NODE_ENV"] === "test") throw error;
      return true;
    }
  }

  private owner(job: { owner_kind: "actor" | "guest"; workspace_id?: string | null; actor_id?: string | null; guest_session_id?: string | null }): IntakeOwner {
    return job.owner_kind === "actor"
      ? { ownerKind: "actor", ownerScope: job.workspace_id!, workspaceId: job.workspace_id!, actorId: job.actor_id! }
      : { ownerKind: "guest", ownerScope: job.guest_session_id!, guestSessionId: job.guest_session_id! };
  }

  private after(now: string, seconds: number): string {
    return new Date(new Date(now).getTime() + seconds * 1000).toISOString();
  }
}
