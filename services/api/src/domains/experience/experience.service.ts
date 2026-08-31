import { Inject, Injectable, OnApplicationShutdown } from "@nestjs/common";
import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import type {
  FeatureStateList,
  IdempotentCommandResult,
  Permission,
  SearchResultKind,
  WorkspaceHome,
} from "ipw-contracts-ts/product";

import { DomainError, requireId, requireText } from "../../kernel/errors.js";
import {
  PRODUCT_REPOSITORY,
  RUNTIME_VALUES,
  type CommandContext,
  type ProductKernelRepository,
} from "../../kernel/product.types.js";
import { requestDigest, type RuntimeValues } from "../../kernel/runtime.js";
import { IdentityBoundary } from "../identity/identity.service.js";
import { EXPERIENCE_REPOSITORY, type ExperienceRepository } from "./experience.types.js";

type Headers = Record<string, string | string[] | undefined>;

@Injectable()
export class ExperienceService implements OnApplicationShutdown {
  constructor(
    @Inject(EXPERIENCE_REPOSITORY) private readonly repository: ExperienceRepository,
    @Inject(PRODUCT_REPOSITORY) private readonly product: ProductKernelRepository,
    @Inject(RUNTIME_VALUES) private readonly runtime: RuntimeValues,
    private readonly identity: IdentityBoundary,
  ) {}

  async home(headers: Headers, workspaceId: string) {
    const access = await this.access(headers, workspaceId, "workspace.read");
    const [data, usage, notifications] = await Promise.all([
      this.repository.home(access.actorId, access.workspaceId, this.runtime.now()),
      this.product.customerUsageSummary(access.actorId, access.workspaceId),
      access.permissions.has("notification.read")
        ? this.repository.notifications(access.actorId, access.workspaceId, undefined, 5)
        : Promise.resolve({ notifications: [], nextCursor: null, unreadCount: 0 }),
    ]);
    const home: WorkspaceHome = {
      schema_version: PRODUCT_SCHEMA_VERSION,
      recent_work: data.recentWork,
      attention: data.attention,
      active_jobs: data.activeJobs,
      recent_jobs: data.recentJobs,
      notifications: notifications.notifications,
      unread_notification_count: notifications.unreadCount,
      usage,
    };
    return { schema_version: PRODUCT_SCHEMA_VERSION, home };
  }

  async notifications(headers: Headers, workspaceId: string, cursor: string | undefined, limit: number) {
    const access = await this.access(headers, workspaceId, "notification.read");
    const page = await this.repository.notifications(access.actorId, access.workspaceId, cursor, limit);
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      notifications: page.notifications,
      next_cursor: page.nextCursor,
      unread_count: page.unreadCount,
    };
  }

  async markNotificationRead(headers: Headers, workspaceId: string, notificationId: string) {
    const access = await this.access(headers, workspaceId, "notification.update");
    const id = requireId(notificationId, "notification id");
    const context = this.command(headers, access.actorId, "notification.read", {
      workspaceId: access.workspaceId,
      notificationId: id,
    });
    const replayed = await this.repository.markNotificationRead(access.actorId, access.workspaceId, id, this.runtime.now(), {
      name: "notification.read",
      idempotencyKey: context.idempotencyKey,
      requestHash: context.requestHash,
    });
    if (!replayed) await this.product.recordExternalMutation(context, access.workspaceId, "notification.read", "notification", id);
    return { schema_version: PRODUCT_SCHEMA_VERSION, command: this.commandResult(context, replayed, "notification", id) };
  }

  async markAllNotificationsRead(headers: Headers, workspaceId: string) {
    const access = await this.access(headers, workspaceId, "notification.update");
    const context = this.command(headers, access.actorId, "notification.read-all", { workspaceId: access.workspaceId });
    const replayed = await this.repository.markAllNotificationsRead(access.actorId, access.workspaceId, this.runtime.now(), {
      name: "notification.read-all",
      idempotencyKey: context.idempotencyKey,
      requestHash: context.requestHash,
    });
    if (!replayed) await this.product.recordExternalMutation(context, access.workspaceId, "notification.read-all", "workspace", access.workspaceId);
    return { schema_version: PRODUCT_SCHEMA_VERSION, command: this.commandResult(context, replayed, "workspace", access.workspaceId) };
  }

  async search(
    headers: Headers,
    workspaceId: string,
    rawQuery: string,
    kinds: SearchResultKind[],
    cursor: string | undefined,
    limit: number,
  ) {
    const access = await this.access(headers, workspaceId, "search.read");
    const query = requireText(rawQuery, "search query", 200);
    if (query.length < 2) throw new DomainError(400, "search-query-short", "Enter at least two characters to search");
    const page = await this.repository.search(access.actorId, access.workspaceId, query, kinds, {
      projects: access.permissions.has("project.read"),
      files: access.permissions.has("file.read"),
      jobs: access.permissions.has("job.read"),
    }, cursor, limit);
    return { schema_version: PRODUCT_SCHEMA_VERSION, results: page.results, next_cursor: page.nextCursor };
  }

  async features(headers: Headers, workspaceId: string): Promise<FeatureStateList> {
    await this.access(headers, workspaceId, "workspace.read");
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      features: ["image-graphic-studio", "create-pdf", "edit-manage-pdf", "print-production"].map((feature) => ({
        schema_version: PRODUCT_SCHEMA_VERSION,
        feature,
        active: false,
        customer_visible: true,
      })),
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.repository.close();
  }

  private async access(headers: Headers, workspaceId: string, required: Permission) {
    const principal = await this.identity.resolve(headers);
    const id = requireId(workspaceId, "workspace id");
    const context = await this.product.workspaceContext(principal.actorId, id);
    if (!context) throw new DomainError(404, "workspace-not-found", "Workspace was not found");
    const permissions = new Set(context.effectivePermissions.filter((item) => item.allowed).map((item) => item.permission));
    if (!permissions.has(required)) throw new DomainError(403, "access-denied", "You do not have permission to use this workspace view");
    return { actorId: principal.actorId, workspaceId: id, permissions };
  }

  private command(headers: Headers, actorId: string, name: string, payload: unknown): CommandContext {
    const idempotencyKey = requireId(this.header(headers, "idempotency-key"), "Idempotency-Key");
    const traceId = requireId(this.header(headers, "x-trace-id"), "trace id");
    return {
      principal: { actorId, displayName: actorId },
      idempotencyKey,
      traceId,
      requestHash: requestDigest({ command: name, payload }),
    };
  }

  private commandResult(context: CommandContext, replayed: boolean, resourceKind: string, resourceId: string): IdempotentCommandResult {
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      idempotency_key: context.idempotencyKey,
      replayed,
      resource_kind: resourceKind,
      resource_id: resourceId,
    };
  }

  private header(headers: Headers, name: string): string | undefined {
    const value = headers[name];
    return (Array.isArray(value) ? value[0] : value)?.trim();
  }
}
