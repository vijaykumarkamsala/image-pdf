import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import type {
  AttentionItem,
  IntakeFailure,
  NotificationRecord,
  ProcessingJobRecord,
  RecentWorkItem,
  SearchResultKind,
  WorkspaceSearchResult,
} from "ipw-contracts-ts/product";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

import { DomainError } from "../../kernel/errors.js";
import { runMigrations } from "../../kernel/migrations.js";
import { decodeExperienceCursor, encodeExperienceCursor } from "./experience-cursor.js";
import type {
  ExperienceHomeData,
  ExperienceCommand,
  ExperienceRepository,
  NotificationPageData,
  SearchAccess,
  SearchPageData,
} from "./experience.types.js";

function instant(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function job(row: QueryResultRow): ProcessingJobRecord {
  return {
    schema_version: PRODUCT_SCHEMA_VERSION,
    job_id: String(row["job_id"]),
    kind: "file_intake_inspection",
    owner_kind: String(row["owner_kind"]) as ProcessingJobRecord["owner_kind"],
    workspace_id: row["workspace_id"] ? String(row["workspace_id"]) : null,
    actor_id: row["actor_id"] ? String(row["actor_id"]) : null,
    guest_session_id: row["guest_session_id"] ? String(row["guest_session_id"]) : null,
    upload_session_id: String(row["upload_session_id"]),
    state: String(row["state"]) as ProcessingJobRecord["state"],
    attempt: Number(row["attempt"]),
    max_attempts: Number(row["max_attempts"]),
    progress_percent: Number(row["progress_percent"]),
    lease_owner: row["lease_owner"] ? String(row["lease_owner"]) : null,
    lease_expires_at: row["lease_expires_at"] ? instant(row["lease_expires_at"] as Date | string) : null,
    heartbeat_at: row["heartbeat_at"] ? instant(row["heartbeat_at"] as Date | string) : null,
    next_attempt_at: row["next_attempt_at"] ? instant(row["next_attempt_at"] as Date | string) : null,
    failure: (row["failure"] as IntakeFailure | null) ?? null,
    created_at: instant(row["created_at"] as Date | string),
    updated_at: instant(row["updated_at"] as Date | string),
  };
}

function notification(row: QueryResultRow): NotificationRecord {
  return {
    schema_version: PRODUCT_SCHEMA_VERSION,
    notification_id: String(row["notification_id"]),
    workspace_id: String(row["workspace_id"]),
    kind: String(row["kind"]) as NotificationRecord["kind"],
    title: String(row["title"]),
    message: String(row["message"]),
    resource_kind: String(row["resource_kind"]),
    resource_id: String(row["resource_id"]),
    occurred_at: instant(row["occurred_at"] as Date | string),
    read_at: row["read_at"] ? instant(row["read_at"] as Date | string) : null,
  };
}

export class PostgresExperienceRepository implements ExperienceRepository {
  constructor(private readonly pool: Pool) {}

  static async connect(connectionString: string, migrate = false): Promise<PostgresExperienceRepository> {
    const pool = new Pool({ connectionString, max: 5 });
    if (migrate) await runMigrations(pool);
    return new PostgresExperienceRepository(pool);
  }

  async home(_actorId: string, workspaceId: string, now: string): Promise<ExperienceHomeData> {
    const [recent, attentionRows, active, completed] = await Promise.all([
      this.pool.query(
        `SELECT * FROM (
           SELECT 'project' AS kind,project_id AS resource_id,name AS title,
             CASE WHEN parent_project_id IS NULL THEN 'Project' ELSE 'Subproject' END AS description,
             '/w/' || workspace_id || '/projects' AS path,created_at AS updated_at
           FROM projects WHERE workspace_id=$1 AND archived=false
           UNION ALL
           SELECT 'file',file_id,display_name,
             CASE WHEN canonical_location_kind='project' THEN 'Project file' ELSE 'Default Files' END,
             '/w/' || workspace_id || '/files',updated_at
           FROM workspace_files WHERE workspace_id=$1
         ) recent ORDER BY updated_at DESC,resource_id DESC LIMIT 8`,
        [workspaceId],
      ),
      this.pool.query(
        `SELECT * FROM (
           SELECT CASE WHEN state='retry_wait' OR (state='failed' AND coalesce((failure->>'retryable')::boolean,false))
               THEN 'job_retry' ELSE 'job_failed' END AS kind,
             job_id AS resource_id,
             CASE WHEN state='retry_wait' OR coalesce((failure->>'retryable')::boolean,false)
               THEN 'Retry needs attention' ELSE 'Job could not finish' END AS title,
             coalesce(failure->>'message','Review the job timeline for details.') AS message,
             '/w/' || workspace_id || '/jobs?job=' || job_id AS path,updated_at AS occurred_at
           FROM processing_jobs WHERE workspace_id=$1 AND state IN ('retry_wait','failed')
           UNION ALL
           SELECT CASE WHEN state='rejected' THEN 'upload_rejected'
                 WHEN state='expired' THEN 'source_expiring' ELSE 'upload_interrupted' END,
             upload_session_id,
             CASE WHEN state='rejected' THEN 'File was not accepted'
                 WHEN state='expired' THEN 'Temporary source expired' ELSE 'Upload was interrupted' END,
             coalesce(failure->>'message',display_name),
             '/w/' || workspace_id || CASE WHEN state='rejected' THEN '/jobs' ELSE '/files' END,
             updated_at
           FROM upload_sessions WHERE workspace_id=$1 AND (
             state IN ('rejected','expired') OR
             (state IN ('initiated','uploading') AND updated_at < $2::timestamptz - interval '5 minutes')
           )
         ) attention ORDER BY occurred_at DESC,resource_id DESC LIMIT 8`,
        [workspaceId, now],
      ),
      this.pool.query(
        `SELECT * FROM processing_jobs WHERE workspace_id=$1
         AND state IN ('queued','leased','running','retry_wait','cancel_requested')
         ORDER BY updated_at DESC,job_id DESC LIMIT 6`,
        [workspaceId],
      ),
      this.pool.query(
        `SELECT * FROM processing_jobs WHERE workspace_id=$1 AND state IN ('succeeded','failed','cancelled')
         ORDER BY updated_at DESC,job_id DESC LIMIT 6`,
        [workspaceId],
      ),
    ]);
    return {
      recentWork: recent.rows.map((row): RecentWorkItem => ({
        schema_version: PRODUCT_SCHEMA_VERSION,
        kind: String(row["kind"]) as RecentWorkItem["kind"],
        resource_id: String(row["resource_id"]),
        title: String(row["title"]),
        description: String(row["description"]),
        path: String(row["path"]),
        updated_at: instant(row["updated_at"] as Date | string),
      })),
      attention: attentionRows.rows.map((row): AttentionItem => ({
        schema_version: PRODUCT_SCHEMA_VERSION,
        kind: String(row["kind"]) as AttentionItem["kind"],
        resource_id: String(row["resource_id"]),
        title: String(row["title"]),
        message: String(row["message"]),
        path: String(row["path"]),
        occurred_at: instant(row["occurred_at"] as Date | string),
      })),
      activeJobs: active.rows.map(job),
      recentJobs: completed.rows.map(job),
    };
  }

  async notifications(actorId: string, workspaceId: string, cursorValue: string | undefined, limit: number): Promise<NotificationPageData> {
    const cursor = decodeExperienceCursor(cursorValue);
    const result = await this.pool.query(
      `SELECT notification.*,reads.read_at FROM notifications notification
       LEFT JOIN notification_reads reads ON reads.notification_id=notification.notification_id AND reads.actor_id=$2
       WHERE notification.workspace_id=$1 AND (notification.recipient_actor_id IS NULL OR notification.recipient_actor_id=$2)
         AND ($3::timestamptz IS NULL OR (notification.occurred_at,notification.kind,notification.notification_id)<($3::timestamptz,$4,$5))
       ORDER BY notification.occurred_at DESC,notification.kind DESC,notification.notification_id DESC LIMIT $6`,
      [workspaceId, actorId, cursor?.occurredAt ?? null, cursor?.kind ?? "~", cursor?.resourceId ?? "", limit + 1],
    );
    const count = await this.pool.query(
      `SELECT count(*)::integer AS unread FROM notifications notification
       LEFT JOIN notification_reads reads ON reads.notification_id=notification.notification_id AND reads.actor_id=$2
       WHERE notification.workspace_id=$1 AND (notification.recipient_actor_id IS NULL OR notification.recipient_actor_id=$2)
         AND reads.notification_id IS NULL`,
      [workspaceId, actorId],
    );
    const notifications = result.rows.slice(0, limit).map(notification);
    return {
      notifications,
      nextCursor: result.rows.length > limit && notifications.length ? encodeExperienceCursor({
        occurredAt: notifications.at(-1)!.occurred_at,
        resourceId: notifications.at(-1)!.notification_id,
        kind: notifications.at(-1)!.kind,
      }) : null,
      unreadCount: Number(count.rows[0]?.["unread"] ?? 0),
    };
  }

  async markNotificationRead(actorId: string, workspaceId: string, notificationId: string, now: string, command: ExperienceCommand): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (await this.commandReplay(client, actorId, command)) {
        await client.query("COMMIT");
        return true;
      }
      const existing = await client.query(
        `SELECT 1 FROM notifications WHERE workspace_id=$1 AND notification_id=$2
         AND (recipient_actor_id IS NULL OR recipient_actor_id=$3) FOR UPDATE`,
        [workspaceId, notificationId, actorId],
      );
      if (!existing.rowCount) throw new DomainError(404, "notification-not-found", "Notification was not found");
      await client.query(
        `INSERT INTO notification_reads(notification_id,actor_id,read_at) VALUES ($1,$2,$3)
         ON CONFLICT (notification_id,actor_id) DO NOTHING`,
        [notificationId, actorId, now],
      );
      await this.saveCommand(client, actorId, workspaceId, command, { notification_id: notificationId }, now);
      await client.query("COMMIT");
      return false;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markAllNotificationsRead(actorId: string, workspaceId: string, now: string, command: ExperienceCommand): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (await this.commandReplay(client, actorId, command)) {
        await client.query("COMMIT");
        return true;
      }
      await client.query(
        `INSERT INTO notification_reads(notification_id,actor_id,read_at)
         SELECT notification_id,$2,$3 FROM notifications WHERE workspace_id=$1
         AND (recipient_actor_id IS NULL OR recipient_actor_id=$2)
         ON CONFLICT (notification_id,actor_id) DO NOTHING`,
        [workspaceId, actorId, now],
      );
      await this.saveCommand(client, actorId, workspaceId, command, { all: true }, now);
      await client.query("COMMIT");
      return false;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async search(
    _actorId: string,
    workspaceId: string,
    query: string,
    kinds: SearchResultKind[],
    access: SearchAccess,
    cursorValue: string | undefined,
    limit: number,
  ): Promise<SearchPageData> {
    const cursor = decodeExperienceCursor(cursorValue);
    const requested = kinds.length ? kinds : ["project", "file", "job"];
    const result = await this.pool.query(
      `SELECT * FROM (
         SELECT 'project' AS kind,project_id AS resource_id,name AS title,
           CASE WHEN parent_project_id IS NULL THEN 'Project' ELSE 'Subproject' END AS description,
           '/w/' || workspace_id || '/projects' AS path,created_at AS updated_at
         FROM projects WHERE workspace_id=$1 AND archived=false AND $3 AND 'project'=ANY($6::text[])
           AND position(lower($2) in lower(name))>0
         UNION ALL
         SELECT 'file',file_id,display_name,'Workspace file','/w/' || workspace_id || '/files',updated_at
         FROM workspace_files WHERE workspace_id=$1 AND $4 AND 'file'=ANY($6::text[])
           AND position(lower($2) in lower(display_name))>0
         UNION ALL
         SELECT 'job',job_id,replace(kind,'_',' '),replace(state,'_',' '),
           '/w/' || workspace_id || '/jobs?job=' || job_id,updated_at
         FROM processing_jobs WHERE workspace_id=$1 AND $5 AND 'job'=ANY($6::text[])
           AND position(lower($2) in lower(kind || ' ' || job_id))>0
       ) result
       WHERE ($7::timestamptz IS NULL OR (updated_at,resource_id,kind)<($7::timestamptz,$8,$9))
       ORDER BY updated_at DESC,resource_id DESC,kind DESC LIMIT $10`,
      [workspaceId, query, access.projects, access.files, access.jobs, requested,
        cursor?.occurredAt ?? null, cursor?.resourceId ?? "", cursor?.kind ?? "", limit + 1],
    );
    const results = result.rows.slice(0, limit).map((row): WorkspaceSearchResult => ({
      schema_version: PRODUCT_SCHEMA_VERSION,
      kind: String(row["kind"]) as WorkspaceSearchResult["kind"],
      resource_id: String(row["resource_id"]),
      title: String(row["title"]),
      description: String(row["description"]),
      path: String(row["path"]),
      updated_at: instant(row["updated_at"] as Date | string),
    }));
    return {
      results,
      nextCursor: result.rows.length > limit && results.length ? encodeExperienceCursor({
        occurredAt: results.at(-1)!.updated_at,
        resourceId: results.at(-1)!.resource_id,
        kind: results.at(-1)!.kind,
      }) : null,
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async commandReplay(client: PoolClient, actorId: string, command: ExperienceCommand): Promise<boolean> {
    const prior = await client.query(
      `SELECT command_name,request_hash FROM experience_idempotency_records
       WHERE actor_id=$1 AND idempotency_key=$2 FOR UPDATE`,
      [actorId, command.idempotencyKey],
    );
    if (!prior.rows[0]) return false;
    if (prior.rows[0]["command_name"] !== command.name || prior.rows[0]["request_hash"] !== command.requestHash) {
      throw new DomainError(409, "idempotency-conflict", "Idempotency key was already used for another request");
    }
    return true;
  }

  private saveCommand(
    client: PoolClient,
    actorId: string,
    workspaceId: string,
    command: ExperienceCommand,
    responseBody: Record<string, unknown>,
    now: string,
  ): Promise<unknown> {
    return client.query(
      `INSERT INTO experience_idempotency_records(workspace_id,actor_id,idempotency_key,
       command_name,request_hash,response_body,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [workspaceId, actorId, command.idempotencyKey, command.name, command.requestHash, responseBody, now],
    );
  }
}
