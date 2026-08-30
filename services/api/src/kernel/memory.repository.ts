import type {
  Actor,
  AssetOriginalRecord,
  AuditEvent,
  Collection,
  DefaultFilesLocation,
  Membership,
  ObjectReference,
  ProjectRecord,
  ReusableFileReference,
  SourceVersionRecord,
  UsageEvent,
  UsageSummary,
  Workspace,
  WorkspaceFile,
  WorkspaceProjectPolicy,
} from "ipw-contracts-ts/product";
import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";

import { DomainError } from "./errors.js";
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

interface IdempotencyEntry<T> {
  command: string;
  requestHash: string;
  value: T;
}

const VERSION = PRODUCT_SCHEMA_VERSION;

export class MemoryProductKernelRepository implements ProductKernelRepository {
  private readonly actors = new Map<string, Actor>();
  private readonly workspaces = new Map<string, Workspace>();
  private readonly memberships = new Map<string, Membership>();
  private readonly policies = new Map<string, WorkspaceProjectPolicy>();
  private readonly defaultFiles = new Map<string, DefaultFilesLocation>();
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly collections = new Map<string, Collection>();
  private readonly objectReferences = new Map<string, ObjectReference>();
  private readonly originals = new Map<string, AssetOriginalRecord>();
  private readonly sources = new Map<string, SourceVersionRecord>();
  private readonly files = new Map<string, WorkspaceFile>();
  private readonly fileReferences = new Map<string, ReusableFileReference>();
  private readonly audits: AuditEvent[] = [];
  private readonly usage: UsageEvent[] = [];
  private readonly idempotency = new Map<string, IdempotencyEntry<unknown>>();

  private readonly objectCatalog: MetadataObjectReferenceCatalog;

  constructor(private readonly runtime: RuntimeValues) {
    this.objectCatalog = new MetadataObjectReferenceCatalog(runtime);
  }

  async bootstrap(context: CommandContext): Promise<BootstrapResult> {
    return this.command(context, "session.bootstrap", () => {
      const actor: Actor = this.actors.get(context.principal.actorId) ?? {
        schema_version: VERSION,
        actor_id: context.principal.actorId,
        display_name: context.principal.displayName,
      };
      this.actors.set(actor.actor_id, actor);

      let workspace = [...this.workspaces.values()].find(
        (item) => item.personal_for_actor_id === actor.actor_id,
      );
      if (!workspace) {
        workspace = {
          schema_version: VERSION,
          workspace_id: this.runtime.id("workspace"),
          name: `${actor.display_name}'s workspace`,
          personal_for_actor_id: actor.actor_id,
          home_region: null,
        };
        this.workspaces.set(workspace.workspace_id, workspace);
      }

      const memberKey = this.memberKey(actor.actor_id, workspace.workspace_id);
      const membership: Membership = this.memberships.get(memberKey) ?? {
        schema_version: VERSION,
        membership_id: this.runtime.id("membership"),
        workspace_id: workspace.workspace_id,
        actor_id: actor.actor_id,
        role: "owner",
      };
      this.memberships.set(memberKey, membership);

      const policy: WorkspaceProjectPolicy = this.policies.get(workspace.workspace_id) ?? {
        schema_version: VERSION,
        workspace_id: workspace.workspace_id,
        allow_collections: true,
        allow_subprojects: true,
      };
      this.policies.set(workspace.workspace_id, policy);

      const defaultFiles: DefaultFilesLocation = this.defaultFiles.get(workspace.workspace_id) ?? {
        schema_version: VERSION,
        default_files_id: this.runtime.id("default-files"),
        workspace_id: workspace.workspace_id,
        name: "Default Files",
      };
      this.defaultFiles.set(workspace.workspace_id, defaultFiles);
      this.recordMutation(context, workspace.workspace_id, "workspace.bootstrapped", "workspace", workspace.workspace_id);
      return { actor, workspace, membership, policy, defaultFiles, replayed: false };
    });
  }

  async listWorkspaces(actorId: string): Promise<Workspace[]> {
    const ids = new Set(
      [...this.memberships.values()].filter((item) => item.actor_id === actorId).map((item) => item.workspace_id),
    );
    return [...this.workspaces.values()].filter((item) => ids.has(item.workspace_id));
  }

  async workspaceContext(actorId: string, workspaceId: string): Promise<WorkspaceContextRecord | null> {
    const membership = this.memberships.get(this.memberKey(actorId, workspaceId));
    const actor = this.actors.get(actorId);
    const workspace = this.workspaces.get(workspaceId);
    const policy = this.policies.get(workspaceId);
    const defaultFiles = this.defaultFiles.get(workspaceId);
    if (!membership || !actor || !workspace || !policy || !defaultFiles) return null;
    return {
      actor,
      workspace,
      membership,
      policy,
      defaultFiles,
      effectivePermissions: permissionsForRole(membership.role),
    };
  }

  async listProjects(actorId: string, workspaceId: string): Promise<ProjectListing> {
    this.requireMember(actorId, workspaceId);
    return {
      projects: [...this.projects.values()].filter((item) => item.workspace_id === workspaceId),
      collections: [...this.collections.values()].filter((item) => item.workspace_id === workspaceId),
    };
  }

  async createProject(
    context: CommandContext,
    workspaceId: string,
    input: { name: string; parentProjectId?: string },
  ): Promise<MutationResult<ProjectRecord>> {
    this.requireMember(context.principal.actorId, workspaceId);
    return this.command(context, "project.create", () => {
      if (input.parentProjectId) this.requireProject(workspaceId, input.parentProjectId);
      const project: ProjectRecord = {
        schema_version: VERSION,
        project_id: this.runtime.id("project"),
        workspace_id: workspaceId,
        name: input.name,
        parent_project_id: input.parentProjectId ?? null,
        archived: false,
      };
      this.projects.set(project.project_id, project);
      this.recordMutation(context, workspaceId, "project.created", "project", project.project_id);
      return { value: project, replayed: false };
    });
  }

  async listFiles(actorId: string, workspaceId: string): Promise<WorkspaceFile[]> {
    this.requireMember(actorId, workspaceId);
    return [...this.files.values()].filter((item) => item.workspace_id === workspaceId);
  }

  async registerFile(
    context: CommandContext,
    workspaceId: string,
    input: RegisterFileInput,
  ): Promise<RegisteredFile> {
    this.requireMember(context.principal.actorId, workspaceId);
    return this.command(context, "file.register", () => {
      const defaultFiles = this.requireDefaultFiles(workspaceId);
      if (input.projectId) this.requireProject(workspaceId, input.projectId);
      const now = this.runtime.now();
      const objectReference = this.objectCatalog.create(workspaceId, input);
      const original: AssetOriginalRecord = {
        schema_version: VERSION,
        asset_original_id: this.runtime.id("asset"),
        workspace_id: workspaceId,
        object_reference_id: objectReference.object_reference_id,
        original_filename: input.displayName,
        created_at: now,
      };
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
      const file: WorkspaceFile = {
        schema_version: VERSION,
        file_id: this.runtime.id("file"),
        workspace_id: workspaceId,
        asset_original_id: original.asset_original_id,
        current_source_version_id: sourceVersion.source_version_id,
        display_name: input.displayName,
        canonical_location: input.projectId
          ? { schema_version: VERSION, kind: "project", project_id: input.projectId, default_files_id: null }
          : {
              schema_version: VERSION,
              kind: "default_files",
              default_files_id: defaultFiles.default_files_id,
              project_id: null,
            },
      };
      this.objectReferences.set(objectReference.object_reference_id, objectReference);
      this.originals.set(original.asset_original_id, original);
      this.sources.set(sourceVersion.source_version_id, sourceVersion);
      this.files.set(file.file_id, file);
      this.recordMutation(context, workspaceId, "file.registered", "file", file.file_id);
      return { file, original, sourceVersion, objectReference, replayed: false };
    });
  }

  async registerSourceVersion(
    context: CommandContext,
    workspaceId: string,
    fileId: string,
    input: RegisterSourceInput,
  ): Promise<SourceRegistration> {
    this.requireMember(context.principal.actorId, workspaceId);
    return this.command(context, "file.source.register", () => {
      const file = this.requireFile(workspaceId, fileId);
      const previous = this.sources.get(file.current_source_version_id);
      if (!previous) throw new DomainError(500, "source-missing", "Current source version is unavailable");
      const objectReference = this.objectCatalog.create(workspaceId, input);
      const sourceVersion: SourceVersionRecord = {
        schema_version: VERSION,
        source_version_id: this.runtime.id("source"),
        workspace_id: workspaceId,
        asset_original_id: file.asset_original_id,
        object_reference_id: objectReference.object_reference_id,
        sequence: previous.sequence + 1,
        previous_source_version_id: previous.source_version_id,
        created_at: this.runtime.now(),
      };
      const updated: WorkspaceFile = { ...file, current_source_version_id: sourceVersion.source_version_id };
      this.objectReferences.set(objectReference.object_reference_id, objectReference);
      this.sources.set(sourceVersion.source_version_id, sourceVersion);
      this.files.set(fileId, updated);
      this.recordMutation(context, workspaceId, "source-version.registered", "file", fileId);
      return { file: updated, sourceVersion, objectReference, replayed: false };
    });
  }

  async moveFile(
    context: CommandContext,
    workspaceId: string,
    fileId: string,
    input: MoveFileInput,
  ): Promise<MutationResult<WorkspaceFile>> {
    this.requireMember(context.principal.actorId, workspaceId);
    return this.command(context, "file.move", () => {
      const file = this.requireFile(workspaceId, fileId);
      const defaultFiles = this.requireDefaultFiles(workspaceId);
      if (input.kind === "project" && input.projectId) this.requireProject(workspaceId, input.projectId);
      const updated: WorkspaceFile = {
        ...file,
        canonical_location:
          input.kind === "project"
            ? { schema_version: VERSION, kind: "project", project_id: input.projectId, default_files_id: null }
            : {
                schema_version: VERSION,
                kind: "default_files",
                default_files_id: defaultFiles.default_files_id,
                project_id: null,
              },
      };
      this.files.set(fileId, updated);
      this.recordMutation(context, workspaceId, "file.moved", "file", fileId);
      return { value: updated, replayed: false };
    });
  }

  async addFileReference(
    context: CommandContext,
    workspaceId: string,
    fileId: string,
    input: AddReferenceInput,
  ): Promise<MutationResult<ReusableFileReference>> {
    this.requireMember(context.principal.actorId, workspaceId);
    return this.command(context, "file.reference.add", () => {
      this.requireFile(workspaceId, fileId);
      if (input.ownerKind === "project") this.requireProject(workspaceId, input.ownerId);
      const reference: ReusableFileReference = {
        schema_version: VERSION,
        reference_id: this.runtime.id("reference"),
        workspace_id: workspaceId,
        file_id: fileId,
        owner_kind: input.ownerKind,
        owner_id: input.ownerId,
        purpose: input.purpose,
      };
      this.fileReferences.set(reference.reference_id, reference);
      this.recordMutation(context, workspaceId, "file.reference.added", "file", fileId);
      return { value: reference, replayed: false };
    });
  }

  async listFileReferences(actorId: string, workspaceId: string, fileId: string): Promise<ReusableFileReference[]> {
    this.requireMember(actorId, workspaceId);
    this.requireFile(workspaceId, fileId);
    return [...this.fileReferences.values()].filter(
      (item) => item.workspace_id === workspaceId && item.file_id === fileId,
    );
  }

  async listAuditEvents(actorId: string, workspaceId: string): Promise<AuditEvent[]> {
    this.requireMember(actorId, workspaceId);
    return this.audits.filter((item) => item.workspace_id === workspaceId);
  }

  async listUsageEvents(actorId: string, workspaceId: string): Promise<UsageEvent[]> {
    this.requireMember(actorId, workspaceId);
    return this.usage.filter((item) => item.workspace_id === workspaceId);
  }

  async customerUsageSummary(actorId: string, workspaceId: string): Promise<UsageSummary> {
    this.requireMember(actorId, workspaceId);
    const events = this.usage.filter((item) => item.workspace_id === workspaceId);
    return {
      schema_version: VERSION,
      files: [...this.files.values()].filter((item) => item.workspace_id === workspaceId).length,
      storage_bytes: [...this.objectReferences.values()]
        .filter((item) => item.workspace_id === workspaceId)
        .reduce((total, item) => total + item.byte_size, 0),
      jobs: events.filter((item) => item.event_kind === "upload.finalised").length,
      high_cost_processing: events.filter((item) => item.event_kind.includes("high-cost")).length,
      activities: events.map((item) => ({
        schema_version: VERSION,
        event_kind: item.event_kind,
        occurred_at: item.occurred_at,
      })),
    };
  }

  async recordExternalMutation(
    context: CommandContext,
    workspaceId: string,
    action: string,
    resourceKind: string,
    resourceId: string,
  ): Promise<void> {
    this.requireMember(context.principal.actorId, workspaceId);
    if (this.audits.some((event) =>
      event.workspace_id === workspaceId
      && event.action === action
      && event.resource_kind === resourceKind
      && event.resource_id === resourceId
      && event.trace_id === context.traceId
    )) return;
    this.recordMutation(context, workspaceId, action, resourceKind, resourceId);
  }

  registerVerifiedOriginal(input: {
    context: CommandContext;
    workspaceId: string;
    objectReferenceId: string;
    assetOriginalId: string;
    sourceVersionId: string;
    fileId: string;
    displayName: string;
    objectKey: string;
    sha256: string;
    mediaType: string;
    byteSize: number;
  }): RegisteredFile {
    this.requireMember(input.context.principal.actorId, input.workspaceId);
    const existing = this.files.get(input.fileId);
    if (existing) {
      return {
        file: existing,
        original: this.originals.get(input.assetOriginalId)!,
        sourceVersion: this.sources.get(input.sourceVersionId)!,
        objectReference: this.objectReferences.get(input.objectReferenceId)!,
        replayed: true,
      };
    }
    const now = this.runtime.now();
    const defaultFiles = this.requireDefaultFiles(input.workspaceId);
    const objectReference: ObjectReference = {
      schema_version: VERSION,
      object_reference_id: input.objectReferenceId,
      workspace_id: input.workspaceId,
      object_key: input.objectKey,
      sha256: input.sha256,
      media_type: input.mediaType,
      byte_size: input.byteSize,
    };
    const original: AssetOriginalRecord = {
      schema_version: VERSION,
      asset_original_id: input.assetOriginalId,
      workspace_id: input.workspaceId,
      object_reference_id: input.objectReferenceId,
      original_filename: input.displayName,
      created_at: now,
    };
    const sourceVersion: SourceVersionRecord = {
      schema_version: VERSION,
      source_version_id: input.sourceVersionId,
      workspace_id: input.workspaceId,
      asset_original_id: input.assetOriginalId,
      object_reference_id: input.objectReferenceId,
      sequence: 1,
      previous_source_version_id: null,
      created_at: now,
    };
    const file: WorkspaceFile = {
      schema_version: VERSION,
      file_id: input.fileId,
      workspace_id: input.workspaceId,
      asset_original_id: input.assetOriginalId,
      current_source_version_id: input.sourceVersionId,
      display_name: input.displayName,
      canonical_location: {
        schema_version: VERSION,
        kind: "default_files",
        default_files_id: defaultFiles.default_files_id,
        project_id: null,
      },
    };
    this.objectReferences.set(input.objectReferenceId, objectReference);
    this.originals.set(input.assetOriginalId, original);
    this.sources.set(input.sourceVersionId, sourceVersion);
    this.files.set(input.fileId, file);
    this.recordMutation(input.context, input.workspaceId, "file.intake-ready", "file", input.fileId);
    return { file, original, sourceVersion, objectReference, replayed: false };
  }

  async close(): Promise<void> {}

  private command<T>(context: CommandContext, command: string, execute: () => T): T {
    const key = `${context.principal.actorId}:${context.idempotencyKey}`;
    const prior = this.idempotency.get(key) as IdempotencyEntry<T> | undefined;
    if (prior) {
      if (prior.command !== command || prior.requestHash !== context.requestHash) {
        throw new DomainError(409, "idempotency-conflict", "Idempotency key was already used for another request");
      }
      return this.asReplay(prior.value);
    }
    const value = execute();
    this.idempotency.set(key, { command, requestHash: context.requestHash, value });
    return value;
  }

  private asReplay<T>(value: T): T {
    if (typeof value === "object" && value !== null && "replayed" in value) {
      return { ...value, replayed: true };
    }
    return value;
  }

  private recordMutation(
    context: CommandContext,
    workspaceId: string,
    action: string,
    resourceKind: string,
    resourceId: string,
  ): void {
    this.audits.push({
      schema_version: VERSION,
      audit_event_id: this.runtime.id("audit"),
      workspace_id: workspaceId,
      actor_id: context.principal.actorId,
      action,
      resource_kind: resourceKind,
      resource_id: resourceId,
      occurred_at: this.runtime.now(),
      trace_id: context.traceId,
    });
    this.usage.push({
      schema_version: VERSION,
      usage_event_id: this.runtime.id("usage"),
      workspace_id: workspaceId,
      actor_id: context.principal.actorId,
      event_kind: action,
      customer_amount: "0.00",
      credit_debit: 0,
      currency: "USD",
      occurred_at: this.runtime.now(),
    });
  }

  private memberKey(actorId: string, workspaceId: string): string {
    return `${actorId}:${workspaceId}`;
  }

  private requireMember(actorId: string, workspaceId: string): Membership {
    const member = this.memberships.get(this.memberKey(actorId, workspaceId));
    if (!member) throw new DomainError(403, "access-denied", "You do not have access to this workspace");
    return member;
  }

  private requireDefaultFiles(workspaceId: string): DefaultFilesLocation {
    const value = this.defaultFiles.get(workspaceId);
    if (!value) throw new DomainError(404, "default-files-not-found", "Default Files is unavailable");
    return value;
  }

  private requireProject(workspaceId: string, projectId: string): ProjectRecord {
    const project = this.projects.get(projectId);
    if (!project || project.workspace_id !== workspaceId) {
      throw new DomainError(404, "project-not-found", "Project was not found");
    }
    return project;
  }

  private requireFile(workspaceId: string, fileId: string): WorkspaceFile {
    const file = this.files.get(fileId);
    if (!file || file.workspace_id !== workspaceId) throw new DomainError(404, "file-not-found", "File was not found");
    return file;
  }
}
