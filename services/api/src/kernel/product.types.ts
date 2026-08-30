import type {
  Actor,
  AssetOriginalRecord,
  AuditEvent,
  Collection,
  DefaultFilesLocation,
  EffectivePermission,
  Membership,
  ObjectReference,
  ProjectRecord,
  ReusableFileReference,
  SourceVersionRecord,
  UsageEvent,
  Workspace,
  WorkspaceFile,
  WorkspaceProjectPolicy,
} from "ipw-contracts-ts/product";

export interface Principal {
  actorId: string;
  displayName: string;
}

export interface CommandContext {
  principal: Principal;
  idempotencyKey: string;
  traceId: string;
  requestHash: string;
}

export interface BootstrapResult {
  actor: Actor;
  workspace: Workspace;
  membership: Membership;
  policy: WorkspaceProjectPolicy;
  defaultFiles: DefaultFilesLocation;
  replayed: boolean;
}

export interface WorkspaceContextRecord extends Omit<BootstrapResult, "replayed"> {
  effectivePermissions: EffectivePermission[];
}

export interface ProjectListing {
  projects: ProjectRecord[];
  collections: Collection[];
}

export interface RegisteredFile {
  file: WorkspaceFile;
  original: AssetOriginalRecord;
  sourceVersion: SourceVersionRecord;
  objectReference: ObjectReference;
  replayed: boolean;
}

export interface SourceRegistration {
  file: WorkspaceFile;
  sourceVersion: SourceVersionRecord;
  objectReference: ObjectReference;
  replayed: boolean;
}

export interface MutationResult<T> {
  value: T;
  replayed: boolean;
}

export interface RegisterFileInput {
  displayName: string;
  objectKey: string;
  sha256: string;
  mediaType: string;
  byteSize: number;
  projectId?: string;
}

export interface RegisterSourceInput {
  objectKey: string;
  sha256: string;
  mediaType: string;
  byteSize: number;
}

export interface MoveFileInput {
  kind: "default_files" | "project";
  projectId?: string;
}

export interface AddReferenceInput {
  ownerKind: "project" | "document";
  ownerId: string;
  purpose: string;
}

export interface ProductKernelRepository {
  bootstrap(context: CommandContext): Promise<BootstrapResult>;
  listWorkspaces(actorId: string): Promise<Workspace[]>;
  workspaceContext(actorId: string, workspaceId: string): Promise<WorkspaceContextRecord | null>;
  listProjects(actorId: string, workspaceId: string): Promise<ProjectListing>;
  createProject(
    context: CommandContext,
    workspaceId: string,
    input: { name: string; parentProjectId?: string },
  ): Promise<MutationResult<ProjectRecord>>;
  listFiles(actorId: string, workspaceId: string): Promise<WorkspaceFile[]>;
  registerFile(
    context: CommandContext,
    workspaceId: string,
    input: RegisterFileInput,
  ): Promise<RegisteredFile>;
  registerSourceVersion(
    context: CommandContext,
    workspaceId: string,
    fileId: string,
    input: RegisterSourceInput,
  ): Promise<SourceRegistration>;
  moveFile(
    context: CommandContext,
    workspaceId: string,
    fileId: string,
    input: MoveFileInput,
  ): Promise<MutationResult<WorkspaceFile>>;
  addFileReference(
    context: CommandContext,
    workspaceId: string,
    fileId: string,
    input: AddReferenceInput,
  ): Promise<MutationResult<ReusableFileReference>>;
  listFileReferences(actorId: string, workspaceId: string, fileId: string): Promise<ReusableFileReference[]>;
  listAuditEvents(actorId: string, workspaceId: string): Promise<AuditEvent[]>;
  listUsageEvents(actorId: string, workspaceId: string): Promise<UsageEvent[]>;
  recordExternalMutation(
    context: CommandContext,
    workspaceId: string,
    action: string,
    resourceKind: string,
    resourceId: string,
  ): Promise<void>;
  close(): Promise<void>;
}

export const PRODUCT_REPOSITORY = Symbol("PRODUCT_REPOSITORY");
export const RUNTIME_VALUES = Symbol("RUNTIME_VALUES");
