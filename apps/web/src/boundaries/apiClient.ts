import type {
  Actor,
  DefaultFilesLocation,
  EffectivePermission,
  Membership,
  ProjectRecord,
  Workspace,
  WorkspaceFile,
  WorkspaceProjectPolicy,
} from "ipw-contracts-ts/product";

export interface WorkspaceContextResponse {
  schema_version: string;
  actor: Actor;
  workspace: Workspace;
  membership: Membership;
  policy: WorkspaceProjectPolicy;
  default_files: DefaultFilesLocation;
  effective_permissions: EffectivePermission[];
  command?: { replayed: boolean };
}

export interface ProjectListResponse {
  schema_version: string;
  projects: ProjectRecord[];
  collections: unknown[];
}

export interface FileListResponse {
  schema_version: string;
  files: WorkspaceFile[];
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string };
}

const actorId = localStorage.getItem("ipw-actor-id") ?? "actor-local";
const actorName = localStorage.getItem("ipw-actor-name") ?? "Alex Morgan";

function commandKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/v1${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-ipw-actor-id": actorId,
      "x-ipw-actor-name": actorName,
      "x-trace-id": `trace-${crypto.randomUUID()}`,
      ...init.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ErrorBody;
    throw new ApiError(
      response.status,
      body.error?.code ?? "request-failed",
      body.error?.message ?? "The request could not be completed",
    );
  }
  return (await response.json()) as T;
}

export const api = {
  bootstrap(): Promise<WorkspaceContextResponse> {
    const key = sessionStorage.getItem("ipw-bootstrap-key") ?? commandKey("bootstrap");
    sessionStorage.setItem("ipw-bootstrap-key", key);
    return request("/session/bootstrap", { method: "POST", headers: { "idempotency-key": key } });
  },
  context(workspaceId: string): Promise<WorkspaceContextResponse> {
    return request(`/workspaces/${workspaceId}/context`);
  },
  projects(workspaceId: string): Promise<ProjectListResponse> {
    return request(`/workspaces/${workspaceId}/projects`);
  },
  async createProject(workspaceId: string, name: string): Promise<ProjectRecord> {
    const result = await request<{ project: ProjectRecord }>(`/workspaces/${workspaceId}/projects`, {
      method: "POST",
      headers: { "idempotency-key": commandKey("project") },
      body: JSON.stringify({ name }),
    });
    return result.project;
  },
  files(workspaceId: string): Promise<FileListResponse> {
    return request(`/workspaces/${workspaceId}/files`);
  },
};
