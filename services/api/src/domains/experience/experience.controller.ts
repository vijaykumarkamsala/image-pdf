import { Controller, Get, Headers, Param, Post, Query } from "@nestjs/common";
import type { SearchResultKind } from "ipw-contracts-ts/product";

import { DomainError } from "../../kernel/errors.js";
import { ExperienceService } from "./experience.service.js";

type RequestHeaders = Record<string, string | string[] | undefined>;

@Controller("workspaces/:workspaceId")
export class ExperienceController {
  constructor(private readonly experience: ExperienceService) {}

  @Get("home")
  home(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string) {
    return this.experience.home(headers, workspaceId);
  }

  @Get("notifications")
  notifications(
    @Headers() headers: RequestHeaders,
    @Param("workspaceId") workspaceId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") rawLimit?: string,
  ) {
    return this.experience.notifications(headers, workspaceId, cursor, this.limit(rawLimit, 25));
  }

  @Post("notifications/read-all")
  markAllRead(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string) {
    return this.experience.markAllNotificationsRead(headers, workspaceId);
  }

  @Post("notifications/:notificationId/read")
  markRead(
    @Headers() headers: RequestHeaders,
    @Param("workspaceId") workspaceId: string,
    @Param("notificationId") notificationId: string,
  ) {
    return this.experience.markNotificationRead(headers, workspaceId, notificationId);
  }

  @Get("search")
  search(
    @Headers() headers: RequestHeaders,
    @Param("workspaceId") workspaceId: string,
    @Query("q") query = "",
    @Query("kinds") rawKinds?: string,
    @Query("cursor") cursor?: string,
    @Query("limit") rawLimit?: string,
  ) {
    const kinds = rawKinds ? rawKinds.split(",").filter(Boolean) : [];
    if (kinds.some((kind) => !["project", "file", "job"].includes(kind))) {
      throw new DomainError(400, "search-kind-invalid", "Search only available projects, files and jobs");
    }
    return this.experience.search(headers, workspaceId, query, kinds as SearchResultKind[], cursor, this.limit(rawLimit, 20));
  }

  @Get("features")
  features(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string) {
    return this.experience.features(headers, workspaceId);
  }

  private limit(raw: string | undefined, fallback: number): number {
    const limit = Number(raw ?? String(fallback));
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new DomainError(400, "page-limit-invalid", "Use a page limit from 1 to 100");
    }
    return limit;
  }
}
