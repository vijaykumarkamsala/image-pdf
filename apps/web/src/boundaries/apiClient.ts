import type {
  Actor,
  DefaultFilesLocation,
  EffectivePermission,
  JobEventList,
  Membership,
  ProcessingJobRecord,
  ProjectRecord,
  UploadAuthorization,
  UploadSessionCreated,
  UploadSessionRecord,
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

export interface UploadFinaliseResponse {
  schema_version: string;
  upload_session: UploadSessionRecord;
  job: ProcessingJobRecord;
}

export interface UploadContentResponse {
  schema_version: string;
  upload_session: UploadSessionRecord;
  upload_offset: number;
}

export interface UploadStatusResponse {
  schema_version: string;
  upload_session: UploadSessionRecord;
}

export interface JobStatusResponse {
  schema_version: string;
  job: ProcessingJobRecord;
}

interface RequestOptions {
  traceId?: string;
}

const actorId = localStorage.getItem("ipw-actor-id") ?? "actor-local";
const actorName = localStorage.getItem("ipw-actor-name") ?? "Alex Morgan";

function commandKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function createTraceId(): string {
  return `trace-${crypto.randomUUID()}`;
}

async function request<T>(path: string, init: RequestInit = {}, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  headers.set("x-ipw-actor-id", actorId);
  headers.set("x-ipw-actor-name", actorName);
  headers.set("x-trace-id", options.traceId ?? createTraceId());
  const response = await fetch(`/v1${path}`, {
    ...init,
    headers,
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

function xhrError(xhr: XMLHttpRequest): ApiError {
  let body: ErrorBody = {};
  try {
    body = JSON.parse(xhr.responseText) as ErrorBody;
  } catch {
    // A private storage provider may return an empty or non-JSON error body.
  }
  return new ApiError(
    xhr.status || 503,
    body.error?.code ?? "upload-transfer-failed",
    body.error?.message ?? "The file transfer was interrupted",
  );
}

function uploadChunk(
  authorization: UploadAuthorization,
  chunk: Blob,
  offset: number,
  totalBytes: number,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<UploadContentResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(authorization.method ?? "PUT", authorization.upload_url);
    for (const [name, value] of Object.entries(authorization.required_headers ?? {})) {
      const normalized = name.toLowerCase();
      if (value !== undefined && normalized !== "upload-offset" && normalized !== "content-type") {
        xhr.setRequestHeader(name, value);
      }
    }
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.setRequestHeader("upload-offset", String(offset));
    xhr.upload.addEventListener("progress", (event) => {
      const sent = offset + (event.lengthComputable ? event.loaded : 0);
      onProgress(Math.min(100, Math.round((sent / totalBytes) * 100)));
    });
    xhr.addEventListener("error", () => reject(new ApiError(503, "upload-transfer-failed", "The file transfer was interrupted")));
    xhr.addEventListener("abort", () => reject(new ApiError(499, "upload-cancelled", "The file transfer was cancelled")));
    xhr.addEventListener("load", () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(xhrError(xhr));
        return;
      }
      try {
        resolve(JSON.parse(xhr.responseText) as UploadContentResponse);
      } catch {
        reject(new ApiError(502, "upload-response-invalid", "The upload service returned an invalid response"));
      }
    });
    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        return;
      }
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.send(chunk);
  });
}

async function transferFile(
  authorization: UploadAuthorization,
  file: File,
  startingOffset: number,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<UploadSessionRecord> {
  const chunkSize = 4 * 1024 * 1024;
  let offset = startingOffset;
  let latest: UploadSessionRecord | null = null;
  while (offset < file.size) {
    const end = Math.min(file.size, offset + chunkSize);
    const result = await uploadChunk(authorization, file.slice(offset, end), offset, file.size, onProgress, signal);
    if (result.upload_offset <= offset || result.upload_offset > file.size) {
      throw new ApiError(502, "upload-offset-invalid", "The upload service returned an invalid resume position");
    }
    offset = result.upload_offset;
    latest = result.upload_session;
  }
  if (!latest) throw new ApiError(400, "upload-empty", "Choose a non-empty image or PDF file");
  onProgress(100);
  return latest;
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
  createUploadSession(workspaceId: string, file: File, mediaType: string, traceId: string): Promise<UploadSessionCreated> {
    return request(`/workspaces/${workspaceId}/upload-sessions`, {
      method: "POST",
      headers: { "idempotency-key": commandKey("upload") },
      body: JSON.stringify({ display_name: file.name, media_type: mediaType, byte_size: file.size }),
    }, { traceId });
  },
  transferFile,
  finaliseUpload(uploadSessionId: string, traceId: string): Promise<UploadFinaliseResponse> {
    return request(`/upload-sessions/${uploadSessionId}/finalise`, {
      method: "POST",
      headers: { "idempotency-key": commandKey("finalise") },
    }, { traceId });
  },
  uploadStatus(uploadSessionId: string, traceId: string): Promise<UploadStatusResponse> {
    return request(`/upload-sessions/${uploadSessionId}`, {}, { traceId });
  },
  jobStatus(jobId: string, traceId: string): Promise<JobStatusResponse> {
    return request(`/jobs/${jobId}`, {}, { traceId });
  },
  jobEvents(jobId: string, after: number, traceId: string): Promise<JobEventList> {
    return request(`/jobs/${jobId}/events?after=${after}&limit=100`, {}, { traceId });
  },
  cancelUpload(uploadSessionId: string, traceId: string): Promise<UploadStatusResponse> {
    return request(`/upload-sessions/${uploadSessionId}`, {
      method: "DELETE",
      headers: { "idempotency-key": commandKey("upload-cancel") },
    }, { traceId });
  },
  cancelJob(jobId: string, traceId: string): Promise<JobStatusResponse> {
    return request(`/jobs/${jobId}/cancel`, {
      method: "POST",
      headers: { "idempotency-key": commandKey("job-cancel") },
    }, { traceId });
  },
};
