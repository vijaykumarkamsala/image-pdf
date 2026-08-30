import type { ProcessingJobRecord } from "ipw-contracts-ts/product";

import { DomainError } from "../../kernel/errors.js";

export type JobView = "all" | "active" | "completed" | "failed" | "cancelled" | "retryable";

export interface JobCursor {
  updatedAt: string;
  jobId: string;
}

export function encodeJobCursor(job: ProcessingJobRecord): string {
  return Buffer.from(JSON.stringify([job.updated_at, job.job_id]), "utf8").toString("base64url");
}

export function decodeJobCursor(value?: string): JobCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string" || typeof parsed[1] !== "string") {
      throw new Error("shape");
    }
    if (Number.isNaN(Date.parse(parsed[0])) || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(parsed[1])) throw new Error("value");
    return { updatedAt: parsed[0], jobId: parsed[1] };
  } catch {
    throw new DomainError(400, "job-cursor-invalid", "Use a valid Jobs cursor");
  }
}

export function jobMatchesView(job: ProcessingJobRecord, view: JobView): boolean {
  if (view === "all") return true;
  if (view === "active") return ["queued", "leased", "running", "retry_wait", "cancel_requested"].includes(job.state);
  if (view === "completed") return job.state === "succeeded";
  if (view === "failed") return job.state === "failed";
  if (view === "cancelled") return job.state === "cancelled";
  return job.state === "failed" && job.failure?.retryable === true;
}
