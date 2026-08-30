import { Controller, Get, Headers, Param, Post, Query } from "@nestjs/common";

import { DomainError } from "../../kernel/errors.js";
import { JobsService } from "./jobs.service.js";
import type { JobView } from "./job-pagination.js";

type RequestHeaders = Record<string, string | string[] | undefined>;

@Controller()
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Post("upload-sessions/:uploadSessionId/finalise")
  finalise(@Headers() headers: RequestHeaders, @Param("uploadSessionId") uploadSessionId: string) {
    return this.jobs.finalise(headers, uploadSessionId);
  }

  @Get("jobs/:jobId")
  get(@Headers() headers: RequestHeaders, @Param("jobId") jobId: string) {
    return this.jobs.get(headers, jobId);
  }

  @Get("workspaces/:workspaceId/jobs")
  list(
    @Headers() headers: RequestHeaders,
    @Param("workspaceId") workspaceId: string,
    @Query("view") rawView?: string,
    @Query("cursor") cursor?: string,
    @Query("limit") rawLimit?: string,
  ) {
    const view = rawView ?? "all";
    const limit = Number(rawLimit ?? "25");
    if (!["all", "active", "completed", "failed", "cancelled", "retryable"].includes(view)
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new DomainError(400, "job-list-query-invalid", "Use a valid Jobs view and a limit from 1 to 100");
    }
    return this.jobs.list(headers, workspaceId, view as JobView, cursor, limit);
  }

  @Get("jobs/:jobId/events")
  events(
    @Headers() headers: RequestHeaders,
    @Param("jobId") jobId: string,
    @Query("after") rawAfter?: string,
    @Query("limit") rawLimit?: string,
  ) {
    const after = Number(rawAfter ?? "0");
    const limit = Number(rawLimit ?? "100");
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new DomainError(400, "event-cursor-invalid", "Use a valid event cursor and a limit from 1 to 200");
    }
    return this.jobs.events(headers, jobId, after, limit);
  }

  @Post("jobs/:jobId/cancel")
  cancel(@Headers() headers: RequestHeaders, @Param("jobId") jobId: string) {
    return this.jobs.cancel(headers, jobId);
  }

  @Post("jobs/:jobId/retry")
  retry(@Headers() headers: RequestHeaders, @Param("jobId") jobId: string) {
    return this.jobs.retry(headers, jobId);
  }
}
