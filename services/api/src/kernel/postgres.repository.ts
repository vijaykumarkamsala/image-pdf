import type {
  Actor,
  AssetOriginalRecord,
  AuditEvent,
  Collection,
  DefaultFilesLocation,
  Membership,
  ProjectRecord,
  ReusableFileReference,
  SourceVersionRecord,
  UsageEvent,
  Workspace,
  WorkspaceFile,
  WorkspaceProjectPolicy,
} from "ipw-contracts-ts/product";
import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

import { DomainError } from "./errors.js";
import { runMigrations } from "./migrations.js";
import { MetadataObjectReferenceCatalog } from "./object-references.js";
import { permissionsForRole } from "./permissions.js";
import type {
  AddReferenceInput,
  BootstrapResult,
  CommandContext,
  MoveFileInput,
  MutationResult,
  ProductKernelRepository,
  ProjectListing,
  RegisteredFile,
  RegisterFileInput,
  RegisterSourceInput,
  SourceRegistration,
  WorkspaceContextRecord,
} from "./product.types.js";
import type { RuntimeValues } from "./runtime.js";

const VERSION = PRODUCT_SCHEMA_VERSION;

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function workspace(row: QueryResultRow): Workspace {
  return {
    schema_version: VERSION,
    workspace_id: String(row["workspace_id"]),
    name: String(row["name"]),
    personal_for_actor_id: row["personal_for_actor_id"] ? String(row["personal_for_actor_id"]) : null,
    home_region: row["home_region"] ? String(row["home_region"]) : null,
  };
}

function project(row: QueryResultRow): ProjectRecord {
  return {
    schema_version: VERSION,
    project_id: String(row["project_id"]),
    workspace_id: String(row["workspace_id"]),
    name: String(row["name"]),
    parent_project_id: row["parent_project_id"] ? String(row["parent_project_id"]) : null,
    archived: Boolean(row["archived"]),
  };
}

function workspaceFile(row: QueryResultRow): WorkspaceFile {
  const kind = String(row["canonical_location_kind"]) as "default_files" | "project";
  return {
    schema_version: VERSION,
    file_id: String(row["file_id"]),
    workspace_id: String(row["workspace_id"]),
    asset_original_id: String(row["asset_original_id"]),
    current_source_version_id: String(row["current_source_version_id"]),
    display_name: String(row["display_name"]),
    canonical_location: {
      schema_version: VERSION,
      kind,
      default_files_id: row["default_files_id"] ? String(row["default_files_id"]) : null,
      project_id: row["project_id"] ? String(row["project_id"]) : null,
    },
  };
}

export class PostgresProductKernelRepository implements ProductKernelRepository {
  private readonly objectCatalog: MetadataObjectReferenceCatalog;

  constructor(
    private readonly pool: Pool,
    private readonly runtime: RuntimeValues,
  ) {
    this.objectCatalog = new MetadataObjectReferenceCatalog(runtime);
  }

  static async connect(connectionString: string, runtime: RuntimeValues, migrate = false) {
    const pool = new Pool({ connectionString, max: 5 });
    if (migrate) await runMigrations(pool);
    return new PostgresProductKernelRepository(pool, runtime);
  }

  async bootstrap(context: CommandContext): Promise<BootstrapResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO actors(actor_id, display_name, created_at) VALUES ($1, $2, $3)
         ON CONFLICT (actor_id) DO UPDATE SET display_name = EXCLUDED.display_name`,
        [context.principal.actorId, context.principal.displayName, this.runtime.now()],
      );
      return await this.command(client, context, "session.bootstrap", async () => {
        const actor: Actor = {
          schema_version: VERSION,
          actor_id: context.principal.actorId,
          display_name: context.principal.displayName,
        };
        const newWorkspaceId = this.runtime.id("workspace");
        const workspaceRow = await client.query(
          `INSERT INTO workspaces(workspace_id, name, personal_for_actor_id, created_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (personal_for_actor_id) DO UPDATE SET name = workspaces.name
           RETURNING *`,
          [newWorkspaceId, `${context.principal.displayName}'s workspace`, actor.actor_id, this.runtime.now()],
        );
        const value = workspace(workspaceRow.rows[0]);
        const membershipRow = await client.query(
          `INSERT INTO memberships(membership_id, workspace_id, actor_id, role, created_at)
           VALUES ($1, $2, $3, 'owner', $4)
           ON CONFLICT (workspace_id, actor_id) DO UPDATE SET role = memberships.role
           RETURNING *`,
          [this.runtime.id("membership"), value.workspace_id, actor.actor_id, this.runtime.now()],
        );
        const membership: Membership = {
          schema_version: VERSION,
          membership_id: String(membershipRow.rows[0]["membership_id"]),
          workspace_id: value.workspace_id,
          actor_id: actor.actor_id,
          role: "owner",
        };
        const policyRow = await client.query(
          `INSERT INTO workspace_project_policies(workspace_id) VALUES ($1)
           ON CONFLICT (workspace_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id RETURNING *`,
          [value.workspace_id],
        );
        const policy: WorkspaceProjectPolicy = {
          schema_version: VERSION,
          workspace_id: value.workspace_id,
          allow_collections: Boolean(policyRow.rows[0]["allow_collections"]),
          allow_subprojects: Boolean(policyRow.rows[0]["allow_subprojects"]),
        };
        const filesRow = await client.query(
          `INSERT INTO default_files_locations(default_files_id, workspace_id)
           VALUES ($1, $2)
           ON CONFLICT (workspace_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id RETURNING *`,
          [this.runtime.id("default-files"), value.workspace_id],
        );
        const defaultFiles: DefaultFilesLocation = {
          schema_version: VERSION,
          default_files_id: String(filesRow.rows[0]["default_files_id"]),
          workspace_id: value.workspace_id,
          name: "Default Files",
        };
        await this.recordMutation(client, context, value.workspace_id, "workspace.bootstrapped", "workspace", value.workspace_id);
        return { actor, workspace: value, membership, policy, defaultFiles, replayed: false };
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listWorkspaces(actorId: string): Promise<Workspace[]> {
    const result = await this.pool.query(
      `SELECT w.* FROM workspaces w JOIN memberships m USING (workspace_id)
       WHERE m.actor_id = $1 ORDER BY w.created_at`,
      [actorId],
    );
    return result.rows.map(workspace);
  }

  async workspaceContext(actorId: string, workspaceId: string): Promise<WorkspaceContextRecord | null> {
    const result = await this.pool.query(
      `SELECT a.actor_id, a.display_name, w.*, m.membership_id, m.role,
              p.allow_collections, p.allow_subprojects, d.default_files_id
       FROM memberships m
       JOIN actors a ON a.actor_id = m.actor_id
       JOIN workspaces w ON w.workspace_id = m.workspace_id
       JOIN workspace_project_policies p ON p.workspace_id = w.workspace_id
       JOIN default_files_locations d ON d.workspace_id = w.workspace_id
       WHERE m.actor_id = $1 AND m.workspace_id = $2`,
      [actorId, workspaceId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const membership: Membership = {
      schema_version: VERSION,
      membership_id: String(row["membership_id"]),
      workspace_id: workspaceId,
      actor_id: actorId,
      role: String(row["role"]) as Membership["role"],
    };
    return {
      actor: { schema_version: VERSION, actor_id: actorId, display_name: String(row["display_name"]) },
      workspace: workspace(row),
      membership,
      policy: {
        schema_version: VERSION,
        workspace_id: workspaceId,
        allow_collections: Boolean(row["allow_collections"]),
        allow_subprojects: Boolean(row["allow_subprojects"]),
      },
      defaultFiles: {
        schema_version: VERSION,
        default_files_id: String(row["default_files_id"]),
        workspace_id: workspaceId,
        name: "Default Files",
      },
      effectivePermissions: permissionsForRole(membership.role),
    };
  }

  async listProjects(actorId: string, workspaceId: string): Promise<ProjectListing> {
    await this.requireMember(this.pool, actorId, workspaceId);
    const [projects, collections] = await Promise.all([
      this.pool.query("SELECT * FROM projects WHERE workspace_id = $1 ORDER BY created_at", [workspaceId]),
      this.pool.query("SELECT * FROM collections WHERE workspace_id = $1 ORDER BY created_at", [workspaceId]),
    ]);
    return {
      projects: projects.rows.map(project),
      collections: collections.rows.map((row): Collection => ({
        schema_version: VERSION,
        collection_id: String(row["collection_id"]),
        workspace_id: workspaceId,
        name: String(row["name"]),
      })),
    };
  }

  async createProject(
    context: CommandContext,
    workspaceId: string,
    input: { name: string; parentProjectId?: string },
  ): Promise<MutationResult<ProjectRecord>> {
    return this.transactionCommand(context, "project.create", async (client) => {
      await this.requireMember(client, context.principal.actorId, workspaceId);
      if (input.parentProjectId) await this.requireProject(client, workspaceId, input.parentProjectId);
      const result = await client.query(
        `INSERT INTO projects(project_id, workspace_id, name, parent_project_id, created_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [this.runtime.id("project"), workspaceId, input.name, input.parentProjectId ?? null, this.runtime.now()],
      );
      const value = project(result.rows[0]);
      await this.recordMutation(client, context, workspaceId, "project.created", "project", value.project_id);
      return { value, replayed: false };
    });
  }

  async listFiles(actorId: string, workspaceId: string): Promise<WorkspaceFile[]> {
    await this.requireMember(this.pool, actorId, workspaceId);
    const result = await this.pool.query("SELECT * FROM workspace_files WHERE workspace_id = $1 ORDER BY created_at", [workspaceId]);
    return result.rows.map(workspaceFile);
  }

  async registerFile(
    context: CommandContext,
    workspaceId: string,
    input: RegisterFileInput,
  ): Promise<RegisteredFile> {
    return this.transactionCommand(context, "file.register", async (client) => {
      await this.requireMember(client, context.principal.actorId, workspaceId);
      if (input.projectId) await this.requireProject(client, workspaceId, input.projectId);
      const defaultResult = await client.query("SELECT * FROM default_files_locations WHERE workspace_id = $1", [workspaceId]);
      const defaultFilesId = String(defaultResult.rows[0]?.["default_files_id"] ?? "");
      if (!defaultFilesId) throw new DomainError(404, "default-files-not-found", "Default Files is unavailable");
      const now = this.runtime.now();
      const objectReference = this.objectCatalog.create(workspaceId, input);
      await client.query(
        `INSERT INTO object_references(object_reference_id, workspace_id, object_key, sha256, media_type, byte_size, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [objectReference.object_reference_id, workspaceId, input.objectKey, input.sha256, input.mediaType, input.byteSize, now],
      );
      const original: AssetOriginalRecord = {
        schema_version: VERSION,
        asset_original_id: this.runtime.id("asset"),
        workspace_id: workspaceId,
        object_reference_id: objectReference.object_reference_id,
        original_filename: input.displayName,
        created_at: now,
      };
      await client.query(
        `INSERT INTO asset_originals(asset_original_id, workspace_id, object_reference_id, original_filename, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [original.asset_original_id, workspaceId, original.object_reference_id, original.original_filename, now],
      );
      const sourceVersion: SourceVersionRecord = {
        schema_version: VERSION,
        source_version_id: this.runtime.id("source"),
        workspace_id: workspaceId,
        asset_original_id: original.asset_original_id,
        object_reference_id: objectReference.object_reference_id,
        sequence: 1,
        previous_source_version_id: null,
        created_at: now,
      };
      await client.query(
        `INSERT INTO source_versions(source_version_id, workspace_id, asset_original_id, object_reference_id, sequence, created_at)
         VALUES ($1, $2, $3, $4, 1, $5)`,
        [sourceVersion.source_version_id, workspaceId, original.asset_original_id, objectReference.object_reference_id, now],
      );
      const fileId = this.runtime.id("file");
      const kind = input.projectId ? "project" : "default_files";
      const row = await client.query(
        `INSERT INTO workspace_files(
           file_id, workspace_id, asset_original_id, current_source_version_id, display_name,
           canonical_location_kind, default_files_id, project_id, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,
        [
          fileId,
          workspaceId,
          original.asset_original_id,
          sourceVersion.source_version_id,
          input.displayName,
          kind,
          input.projectId ? null : defaultFilesId,
          input.projectId ?? null,
          now,
        ],
      );
      const file = workspaceFile(row.rows[0]);
      await this.recordMutation(client, context, workspaceId, "file.registered", "file", fileId);
      return { file, original, sourceVersion, objectReference, replayed: false };
    });
  }

  async registerSourceVersion(
    context: CommandContext,
    workspaceId: string,
    fileId: string,
    input: RegisterSourceInput,
  ): Promise<SourceRegistration> {
    return this.transactionCommand(context, "file.source.register", async (client) => {
      await this.requireMember(client, context.principal.actorId, workspaceId);
      const fileRow = await this.requireFile(client, workspaceId, fileId, true);
      const previous = await client.query("SELECT * FROM source_versions WHERE source_version_id = $1", [
        fileRow["current_source_version_id"],
      ]);
      const previousRow = previous.rows[0];
      if (!previousRow) throw new DomainError(500, "source-missing", "Current source version is unavailable");
      const now = this.runtime.now();
      const objectReference = this.objectCatalog.create(workspaceId, input);
      await client.query(
        `INSERT INTO object_references(object_reference_id, workspace_id, object_key, sha256, media_type, byte_size, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [objectReference.object_reference_id, workspaceId, input.objectKey, input.sha256, input.mediaType, input.byteSize, now],
      );
      const sourceVersion: SourceVersionRecord = {
        schema_version: VERSION,
        source_version_id: this.runtime.id("source"),
        workspace_id: workspaceId,
        asset_original_id: String(fileRow["asset_original_id"]),
        object_reference_id: objectReference.object_reference_id,
        sequence: Number(previousRow["sequence"]) + 1,
        previous_source_version_id: String(previousRow["source_version_id"]),
        created_at: now,
      };
      await client.query(
        `INSERT INTO source_versions(source_version_id, workspace_id, asset_original_id, object_reference_id,
          sequence, previous_source_version_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          sourceVersion.source_version_id,
          workspaceId,
          sourceVersion.asset_original_id,
          sourceVersion.object_reference_id,
          sourceVersion.sequence,
          sourceVersion.previous_source_version_id,
          now,
        ],
      );
      const updated = await client.query(
        `UPDATE workspace_files SET current_source_version_id = $1, updated_at = $2
         WHERE workspace_id = $3 AND file_id = $4 RETURNING *`,
        [sourceVersion.source_version_id, now, workspaceId, fileId],
      );
      const file = workspaceFile(updated.rows[0]);
      await this.recordMutation(client, context, workspaceId, "source-version.registered", "file", fileId);
      return { file, sourceVersion, objectReference, replayed: false };
    });
  }

  async moveFile(
    context: CommandContext,
    workspaceId: string,
    fileId: string,
    input: MoveFileInput,
  ): Promise<MutationResult<WorkspaceFile>> {
    return this.transactionCommand(context, "file.move", async (client) => {
      await this.requireMember(client, context.principal.actorId, workspaceId);
      await this.requireFile(client, workspaceId, fileId, true);
      if (input.kind === "project" && input.projectId) await this.requireProject(client, workspaceId, input.projectId);
      const defaults = await client.query("SELECT default_files_id FROM default_files_locations WHERE workspace_id = $1", [workspaceId]);
      const result = await client.query(
        `UPDATE workspace_files SET canonical_location_kind = $1, default_files_id = $2,
           project_id = $3, updated_at = $4 WHERE workspace_id = $5 AND file_id = $6 RETURNING *`,
        [
          input.kind,
          input.kind === "default_files" ? defaults.rows[0]?.["default_files_id"] : null,
          input.kind === "project" ? input.projectId : null,
          this.runtime.now(),
          workspaceId,
          fileId,
        ],
      );
      const value = workspaceFile(result.rows[0]);
      await this.recordMutation(client, context, workspaceId, "file.moved", "file", fileId);
      return { value, replayed: false };
    });
  }

  async addFileReference(
    context: CommandContext,
    workspaceId: string,
    fileId: string,
    input: AddReferenceInput,
  ): Promise<MutationResult<ReusableFileReference>> {
    return this.transactionCommand(context, "file.reference.add", async (client) => {
      await this.requireMember(client, context.principal.actorId, workspaceId);
      await this.requireFile(client, workspaceId, fileId);
      if (input.ownerKind === "project") await this.requireProject(client, workspaceId, input.ownerId);
      const value: ReusableFileReference = {
        schema_version: VERSION,
        reference_id: this.runtime.id("reference"),
        workspace_id: workspaceId,
        file_id: fileId,
        owner_kind: input.ownerKind,
        owner_id: input.ownerId,
        purpose: input.purpose,
      };
      await client.query(
        `INSERT INTO reusable_file_references(reference_id, workspace_id, file_id, owner_kind, owner_id, purpose, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [value.reference_id, workspaceId, fileId, input.ownerKind, input.ownerId, input.purpose, this.runtime.now()],
      );
      await this.recordMutation(client, context, workspaceId, "file.reference.added", "file", fileId);
      return { value, replayed: false };
    });
  }

  async listFileReferences(actorId: string, workspaceId: string, fileId: string): Promise<ReusableFileReference[]> {
    await this.requireMember(this.pool, actorId, workspaceId);
    await this.requireFile(this.pool, workspaceId, fileId);
    const result = await this.pool.query(
      "SELECT * FROM reusable_file_references WHERE workspace_id = $1 AND file_id = $2 ORDER BY created_at",
      [workspaceId, fileId],
    );
    return result.rows.map((row) => ({
      schema_version: VERSION,
      reference_id: String(row["reference_id"]),
      workspace_id: workspaceId,
      file_id: fileId,
      owner_kind: String(row["owner_kind"]) as ReusableFileReference["owner_kind"],
      owner_id: String(row["owner_id"]),
      purpose: String(row["purpose"]),
    }));
  }

  async listAuditEvents(actorId: string, workspaceId: string): Promise<AuditEvent[]> {
    await this.requireMember(this.pool, actorId, workspaceId);
    const result = await this.pool.query("SELECT * FROM audit_events WHERE workspace_id = $1 ORDER BY occurred_at", [workspaceId]);
    return result.rows.map((row) => ({
      schema_version: VERSION,
      audit_event_id: String(row["audit_event_id"]),
      workspace_id: workspaceId,
      actor_id: String(row["actor_id"]),
      action: String(row["action"]),
      resource_kind: String(row["resource_kind"]),
      resource_id: String(row["resource_id"]),
      occurred_at: timestamp(row["occurred_at"] as Date),
      trace_id: String(row["trace_id"]),
    }));
  }

  async listUsageEvents(actorId: string, workspaceId: string): Promise<UsageEvent[]> {
    await this.requireMember(this.pool, actorId, workspaceId);
    const result = await this.pool.query("SELECT * FROM usage_events WHERE workspace_id = $1 ORDER BY occurred_at", [workspaceId]);
    return result.rows.map((row) => ({
      schema_version: VERSION,
      usage_event_id: String(row["usage_event_id"]),
      workspace_id: workspaceId,
      actor_id: String(row["actor_id"]),
      event_kind: String(row["event_kind"]),
      customer_amount: "0.00",
      credit_debit: 0,
      currency: "USD",
      occurred_at: timestamp(row["occurred_at"] as Date),
    }));
  }

  async recordExternalMutation(
    context: CommandContext,
    workspaceId: string,
    action: string,
    resourceKind: string,
    resourceId: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.requireMember(client, context.principal.actorId, workspaceId);
      await this.recordMutation(client, context, workspaceId, action, resourceKind, resourceId);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async transactionCommand<T>(
    context: CommandContext,
    command: string,
    execute: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      return await this.command(client, context, command, () => execute(client));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async command<T>(
    client: PoolClient,
    context: CommandContext,
    command: string,
    execute: () => Promise<T>,
  ): Promise<T> {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `${context.principal.actorId}:${context.idempotencyKey}`,
    ]);
    const prior = await client.query(
      `SELECT command_name, request_hash, response_body FROM idempotency_records
       WHERE actor_id = $1 AND idempotency_key = $2`,
      [context.principal.actorId, context.idempotencyKey],
    );
    if (prior.rows[0]) {
      if (prior.rows[0]["command_name"] !== command || prior.rows[0]["request_hash"] !== context.requestHash) {
        throw new DomainError(409, "idempotency-conflict", "Idempotency key was already used for another request");
      }
      await client.query("COMMIT");
      const body = prior.rows[0]["response_body"] as T;
      return typeof body === "object" && body !== null && "replayed" in body ? { ...body, replayed: true } : body;
    }
    const value = await execute();
    await client.query(
      `INSERT INTO idempotency_records(actor_id, idempotency_key, command_name, request_hash,
       response_status, response_body, created_at) VALUES ($1,$2,$3,$4,200,$5,$6)`,
      [context.principal.actorId, context.idempotencyKey, command, context.requestHash, value, this.runtime.now()],
    );
    await client.query("COMMIT");
    return value;
  }

  private async recordMutation(
    client: PoolClient,
    context: CommandContext,
    workspaceId: string,
    action: string,
    resourceKind: string,
    resourceId: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_events(audit_event_id, workspace_id, actor_id, action, resource_kind,
       resource_id, occurred_at, trace_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [this.runtime.id("audit"), workspaceId, context.principal.actorId, action, resourceKind, resourceId, this.runtime.now(), context.traceId],
    );
    const usageId = this.runtime.id("usage");
    await client.query(
      `INSERT INTO usage_events(usage_event_id, workspace_id, actor_id, event_kind, customer_amount,
       credit_debit, currency, occurred_at) VALUES ($1,$2,$3,$4,0,0,'USD',$5)`,
      [usageId, workspaceId, context.principal.actorId, action, this.runtime.now()],
    );
    await client.query("INSERT INTO usage_admin_dimensions(usage_event_id, dimensions) VALUES ($1, $2)", [
      usageId,
      { resource_kind: resourceKind },
    ]);
  }

  private async requireMember(
    client: Pick<PoolClient, "query">,
    actorId: string,
    workspaceId: string,
  ): Promise<Membership> {
    const result = await client.query("SELECT * FROM memberships WHERE actor_id = $1 AND workspace_id = $2", [
      actorId,
      workspaceId,
    ]);
    const row = result.rows[0];
    if (!row) throw new DomainError(403, "access-denied", "You do not have access to this workspace");
    return {
      schema_version: VERSION,
      membership_id: String(row["membership_id"]),
      workspace_id: workspaceId,
      actor_id: actorId,
      role: String(row["role"]) as Membership["role"],
    };
  }

  private async requireProject(client: Pick<PoolClient, "query">, workspaceId: string, projectId: string) {
    const result = await client.query("SELECT * FROM projects WHERE workspace_id = $1 AND project_id = $2", [
      workspaceId,
      projectId,
    ]);
    if (!result.rows[0]) throw new DomainError(404, "project-not-found", "Project was not found");
    return result.rows[0];
  }

  private async requireFile(
    client: Pick<PoolClient, "query">,
    workspaceId: string,
    fileId: string,
    lock = false,
  ) {
    const result = await client.query(
      `SELECT * FROM workspace_files WHERE workspace_id = $1 AND file_id = $2${lock ? " FOR UPDATE" : ""}`,
      [workspaceId, fileId],
    );
    if (!result.rows[0]) throw new DomainError(404, "file-not-found", "File was not found");
    return result.rows[0];
  }
}
