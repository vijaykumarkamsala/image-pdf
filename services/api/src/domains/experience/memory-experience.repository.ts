import { createHash } from "node:crypto";
import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import type {
  AttentionItem,
  AuditEvent,
  NotificationKind,
  NotificationRecord,
  ProcessingJobRecord,
  RecentWorkItem,
  SearchResultKind,
  UploadSessionRecord,
  WorkspaceSearchResult,
} from "ipw-contracts-ts/product";

import { DomainError } from "../../kernel/errors.js";
import { MemoryProductKernelRepository } from "../../kernel/memory.repository.js";
import { MemoryIntakeRepository } from "../intake/memory-intake.repository.js";
import { MemoryDurableJobRepository } from "../jobs/memory-durable-job.repository.js";
import { decodeExperienceCursor, encodeExperienceCursor } from "./experience-cursor.js";
import type {
  ExperienceHomeData,
  ExperienceCommand,
  ExperienceRepository,
  NotificationPageData,
  SearchAccess,
  SearchPageData,
} from "./experience.types.js";

export class MemoryExperienceRepository implements ExperienceRepository {
  private readonly projectedNotifications = new Map<string, NotificationRecord>();
  private readonly reads = new Map<string, string>();
  private readonly commands = new Map<string, { name: string; requestHash: string }>();
  private readonly unsubscribers: Array<() => void>;

  constructor(
    private readonly product: MemoryProductKernelRepository,
    private readonly jobs: MemoryDurableJobRepository,
    private readonly intake: MemoryIntakeRepository,
  ) {
    this.unsubscribers = [
      this.product.onMutation((event) => this.projectAudit(event)),
      this.jobs.onTransition((job) => this.projectJob(job)),
      this.intake.onTransition((upload) => this.projectUpload(upload)),
    ];
  }

  async home(actorId: string, workspaceId: string, now: string): Promise<ExperienceHomeData> {
    const [{ projects }, files, audits, jobPage, uploads] = await Promise.all([
      this.product.listProjects(actorId, workspaceId),
      this.product.listFiles(actorId, workspaceId),
      this.product.listAuditEvents(actorId, workspaceId),
      this.jobs.listWorkspaceJobs(workspaceId, "all", undefined, 100),
      this.intake.listWorkspaceUploads(workspaceId),
    ]);
    const timestamp = new Map(audits.map((event) => [event.resource_id, event.occurred_at]));
    const recentWork: RecentWorkItem[] = [
      ...projects.map((project) => ({
        schema_version: PRODUCT_SCHEMA_VERSION,
        kind: "project" as const,
        resource_id: project.project_id,
        title: project.name,
        description: project.parent_project_id ? "Subproject" : "Project",
        path: `/w/${workspaceId}/projects`,
        updated_at: timestamp.get(project.project_id) ?? "1970-01-01T00:00:00.000Z",
      })),
      ...files.map((file) => ({
        schema_version: PRODUCT_SCHEMA_VERSION,
        kind: "file" as const,
        resource_id: file.file_id,
        title: file.display_name,
        description: file.canonical_location.kind === "project" ? "Project file" : "Default Files",
        path: `/w/${workspaceId}/files`,
        updated_at: timestamp.get(file.file_id) ?? "1970-01-01T00:00:00.000Z",
      })),
    ].sort((left, right) => right.updated_at.localeCompare(left.updated_at) || right.resource_id.localeCompare(left.resource_id)).slice(0, 8);

    const attention: AttentionItem[] = [];
    for (const item of jobPage.jobs) {
      if (item.state === "retry_wait" || (item.state === "failed" && item.failure?.retryable)) {
        attention.push(this.attention("job_retry", item.job_id, "Retry needs attention", item.failure?.message ?? "This job can be retried.", `/w/${workspaceId}/jobs?job=${item.job_id}`, item.updated_at));
      } else if (item.state === "failed") {
        attention.push(this.attention("job_failed", item.job_id, "Job could not finish", item.failure?.message ?? "Review the job timeline for details.", `/w/${workspaceId}/jobs?job=${item.job_id}`, item.updated_at));
      }
    }
    const interruptedBefore = new Date(Date.parse(now) - 5 * 60 * 1000).toISOString();
    for (const stored of uploads) {
      const upload = stored.record;
      if (["initiated", "uploading"].includes(upload.state) && upload.updated_at < interruptedBefore) {
        attention.push(this.attention("upload_interrupted", upload.upload_session_id, "Upload was interrupted", upload.display_name, `/w/${workspaceId}/files`, upload.updated_at));
      } else if (upload.state === "rejected") {
        attention.push(this.attention("upload_rejected", upload.upload_session_id, "File was not accepted", upload.failure?.message ?? upload.display_name, `/w/${workspaceId}/jobs`, upload.updated_at));
      } else if (upload.state === "expired") {
        attention.push(this.attention("source_expiring", upload.upload_session_id, "Temporary source expired", upload.display_name, `/w/${workspaceId}/files`, upload.updated_at));
      }
    }
    attention.sort((left, right) => right.occurred_at.localeCompare(left.occurred_at) || right.resource_id.localeCompare(left.resource_id));
    const activeJobs = jobPage.jobs.filter((item) => ["queued", "leased", "running", "retry_wait", "cancel_requested"].includes(item.state)).slice(0, 6);
    const recentJobs = jobPage.jobs.filter((item) => ["succeeded", "failed", "cancelled"].includes(item.state)).slice(0, 6);
    return { recentWork, attention: attention.slice(0, 8), activeJobs, recentJobs };
  }

  async notifications(actorId: string, workspaceId: string, cursorValue: string | undefined, limit: number): Promise<NotificationPageData> {
    const cursor = decodeExperienceCursor(cursorValue);
    const ordered = [...this.projectedNotifications.values()]
      .filter((item) => item.workspace_id === workspaceId)
      .sort((left, right) => right.occurred_at.localeCompare(left.occurred_at)
        || right.kind.localeCompare(left.kind)
        || right.notification_id.localeCompare(left.notification_id))
      .filter((item) => !cursor || item.occurred_at < cursor.occurredAt
        || (item.occurred_at === cursor.occurredAt && (item.kind < (cursor.kind ?? "~")
          || (item.kind === cursor.kind && item.notification_id < cursor.resourceId))));
    const page = ordered.slice(0, limit + 1);
    const notifications = page.slice(0, limit).map((item) => ({
      ...item,
      read_at: this.reads.get(`${actorId}:${item.notification_id}`) ?? null,
    }));
    const unreadCount = [...this.projectedNotifications.values()].filter((item) => item.workspace_id === workspaceId
      && !this.reads.has(`${actorId}:${item.notification_id}`)).length;
    return {
      notifications,
      nextCursor: page.length > limit && notifications.length
        ? encodeExperienceCursor({ occurredAt: notifications.at(-1)!.occurred_at, resourceId: notifications.at(-1)!.notification_id, kind: notifications.at(-1)!.kind })
        : null,
      unreadCount,
    };
  }

  async markNotificationRead(actorId: string, workspaceId: string, notificationId: string, now: string, command: ExperienceCommand): Promise<boolean> {
    const notification = this.projectedNotifications.get(notificationId);
    if (!notification || notification.workspace_id !== workspaceId) throw new DomainError(404, "notification-not-found", "Notification was not found");
    if (this.commandReplay(actorId, command)) return true;
    this.reads.set(`${actorId}:${notificationId}`, this.reads.get(`${actorId}:${notificationId}`) ?? now);
    return false;
  }

  async markAllNotificationsRead(actorId: string, workspaceId: string, now: string, command: ExperienceCommand): Promise<boolean> {
    if (this.commandReplay(actorId, command)) return true;
    for (const notification of this.projectedNotifications.values()) {
      if (notification.workspace_id === workspaceId) {
        const key = `${actorId}:${notification.notification_id}`;
        this.reads.set(key, this.reads.get(key) ?? now);
      }
    }
    return false;
  }

  async search(
    actorId: string,
    workspaceId: string,
    query: string,
    kinds: SearchResultKind[],
    access: SearchAccess,
    cursorValue: string | undefined,
    limit: number,
  ): Promise<SearchPageData> {
    const [{ projects }, files, audits, jobPage] = await Promise.all([
      this.product.listProjects(actorId, workspaceId),
      this.product.listFiles(actorId, workspaceId),
      this.product.listAuditEvents(actorId, workspaceId),
      this.jobs.listWorkspaceJobs(workspaceId, "all", undefined, 100),
    ]);
    const timestamp = new Map(audits.map((event) => [event.resource_id, event.occurred_at]));
    const requested = new Set(kinds.length ? kinds : ["project", "file", "job"] as SearchResultKind[]);
    const needle = query.toLocaleLowerCase();
    const results: WorkspaceSearchResult[] = [];
    if (access.projects && requested.has("project")) for (const project of projects) {
      if (project.name.toLocaleLowerCase().includes(needle)) results.push(this.searchResult("project", project.project_id, project.name, project.parent_project_id ? "Subproject" : "Project", `/w/${workspaceId}/projects`, timestamp.get(project.project_id)));
    }
    if (access.files && requested.has("file")) for (const file of files) {
      if (file.display_name.toLocaleLowerCase().includes(needle)) results.push(this.searchResult("file", file.file_id, file.display_name, "Workspace file", `/w/${workspaceId}/files`, timestamp.get(file.file_id)));
    }
    if (access.jobs && requested.has("job")) for (const item of jobPage.jobs) {
      const label = `${item.kind.replaceAll("_", " ")} ${item.job_id}`;
      if (label.toLocaleLowerCase().includes(needle)) results.push(this.searchResult("job", item.job_id, item.kind.replaceAll("_", " "), item.state.replaceAll("_", " "), `/w/${workspaceId}/jobs?job=${item.job_id}`, item.updated_at));
    }
    results.sort((left, right) => right.updated_at.localeCompare(left.updated_at)
      || right.resource_id.localeCompare(left.resource_id) || right.kind.localeCompare(left.kind));
    const cursor = decodeExperienceCursor(cursorValue);
    const after = results.filter((item) => !cursor || item.updated_at < cursor.occurredAt
      || (item.updated_at === cursor.occurredAt && (item.resource_id < cursor.resourceId
        || (item.resource_id === cursor.resourceId && item.kind < (cursor.kind ?? "")))));
    const page = after.slice(0, limit + 1);
    const visible = page.slice(0, limit);
    return {
      results: visible,
      nextCursor: page.length > limit && visible.length ? encodeExperienceCursor({
        occurredAt: visible.at(-1)!.updated_at,
        resourceId: visible.at(-1)!.resource_id,
        kind: visible.at(-1)!.kind,
      }) : null,
    };
  }

  async close(): Promise<void> {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
  }

  private projectJob(item: ProcessingJobRecord): void {
    if (!item.workspace_id) return;
    if (item.state === "succeeded") {
      this.addNotification(item.workspace_id, `job:${item.job_id}:completed:${item.attempt}`, "job_completed", "Job completed", "The file check finished successfully.", "processing_job", item.job_id, item.updated_at);
      if (item.attempt > 1) this.addNotification(item.workspace_id, `job:${item.job_id}:retry-completed:${item.attempt}`, "retry_completed", "Retry completed", "The retried job finished successfully.", "processing_job", item.job_id, item.updated_at);
    } else if (item.state === "failed") {
      this.addNotification(item.workspace_id, `job:${item.job_id}:failed:${item.attempt}`, "job_failed", "Job could not finish", item.failure?.message ?? "Review the job timeline.", "processing_job", item.job_id, item.updated_at);
    } else if (item.state === "cancelled") {
      this.addNotification(item.workspace_id, `job:${item.job_id}:cancelled:${item.attempt}`, "job_cancelled", "Job cancelled", "The job stopped before completion.", "processing_job", item.job_id, item.updated_at);
    } else if (item.state === "retry_wait") {
      this.addNotification(item.workspace_id, `job:${item.job_id}:retry-required:${item.attempt}`, "retry_required", "Retry scheduled", item.failure?.message ?? "The job will retry safely.", "processing_job", item.job_id, item.updated_at);
    }
  }

  private projectUpload(upload: UploadSessionRecord): void {
    if (!upload.workspace_id) return;
    if (upload.state === "ready") this.addNotification(upload.workspace_id, `upload:${upload.upload_session_id}:ready`, "upload_accepted", "File accepted", upload.display_name, "upload_session", upload.upload_session_id, upload.updated_at);
    if (upload.state === "rejected") this.addNotification(upload.workspace_id, `upload:${upload.upload_session_id}:rejected`, "upload_rejected", "File not accepted", upload.failure?.message ?? upload.display_name, "upload_session", upload.upload_session_id, upload.updated_at);
    if (upload.state === "expired") this.addNotification(upload.workspace_id, `upload:${upload.upload_session_id}:expired`, "source_cleanup_required", "Temporary source expired", upload.display_name, "upload_session", upload.upload_session_id, upload.updated_at);
  }

  private projectAudit(event: AuditEvent): void {
    if (event.action === "guest-source.handed-off") this.addNotification(event.workspace_id, `audit:${event.audit_event_id}`, "guest_handoff_completed", "Guest source saved", "The original source is now in Default Files.", event.resource_kind, event.resource_id, event.occurred_at);
  }

  private addNotification(workspaceId: string, sourceKey: string, kind: NotificationKind, title: string, message: string, resourceKind: string, resourceId: string, occurredAt: string) {
    const id = `notification-${createHash("sha256").update(`${workspaceId}:${sourceKey}`).digest("hex").slice(0, 24)}`;
    if (!this.projectedNotifications.has(id)) this.projectedNotifications.set(id, {
      schema_version: PRODUCT_SCHEMA_VERSION,
      notification_id: id,
      workspace_id: workspaceId,
      kind,
      title,
      message,
      resource_kind: resourceKind,
      resource_id: resourceId,
      occurred_at: occurredAt,
      read_at: null,
    });
  }

  private commandReplay(actorId: string, command: ExperienceCommand): boolean {
    const key = `${actorId}:${command.idempotencyKey}`;
    const prior = this.commands.get(key);
    if (prior) {
      if (prior.name !== command.name || prior.requestHash !== command.requestHash) {
        throw new DomainError(409, "idempotency-conflict", "Idempotency key was already used for another request");
      }
      return true;
    }
    this.commands.set(key, { name: command.name, requestHash: command.requestHash });
    return false;
  }

  private attention(kind: AttentionItem["kind"], resourceId: string, title: string, message: string, path: string, occurredAt: string): AttentionItem {
    return { schema_version: PRODUCT_SCHEMA_VERSION, kind, resource_id: resourceId, title, message, path, occurred_at: occurredAt };
  }

  private searchResult(kind: WorkspaceSearchResult["kind"], resourceId: string, title: string, description: string, path: string, updatedAt?: string): WorkspaceSearchResult {
    return { schema_version: PRODUCT_SCHEMA_VERSION, kind, resource_id: resourceId, title, description, path, updated_at: updatedAt ?? "1970-01-01T00:00:00.000Z" };
  }
}
