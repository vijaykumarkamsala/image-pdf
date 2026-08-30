import type {
  Actor,
  DefaultFilesLocation,
  EffectivePermission,
  GuestSessionAuthorization,
  IntelligentIntakePresentation,
  IntakeClassificationRecord,
  IntakeSourceCategory,
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
import { nextGcsOffset } from "./uploadState.ts";

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

export interface UploadResumeResponse extends UploadStatusResponse {
  authorization: UploadAuthorization;
}

export interface JobStatusResponse {
  schema_version: string;
  job: ProcessingJobRecord;
}

export interface IntakePresentationResponse {
  schema_version: string;
  presentation: IntelligentIntakePresentation;
}

export interface ClassificationCorrectionResponse extends IntakePresentationResponse {
  classification: IntakeClassificationRecord;
  command: { replayed: boolean };
}

interface RequestOptions {
  traceId?: string;
  guestToken?: string;
  includeActor?: boolean;
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
  if (options.includeActor !== false) {
    headers.set("x-ipw-actor-id", actorId);
    headers.set("x-ipw-actor-name", actorName);
  }
  if (options.guestToken) headers.set("x-ipw-guest-token", options.guestToken);
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

interface ChunkResult {
  uploadOffset: number;
  uploadSession?: UploadSessionRecord;
}

function uploadChunk(
  authorization: UploadAuthorization,
  chunk: Blob,
  offset: number,
  totalBytes: number,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<ChunkResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(authorization.method ?? "PUT", authorization.upload_url);
    const protocol = authorization.protocol ?? "ipw_offset_json";
    for (const [name, value] of Object.entries(authorization.required_headers ?? {})) {
      const normalized = name.toLowerCase();
      if (value !== undefined && normalized !== "upload-offset" && normalized !== "content-type") {
        xhr.setRequestHeader(name, value);
      }
    }
    xhr.setRequestHeader("content-type", protocol === "gcs_resumable"
      ? authorization.required_headers?.["content-type"] ?? "application/octet-stream"
      : "application/octet-stream");
    if (protocol === "gcs_resumable") {
      xhr.setRequestHeader("content-range", `bytes ${offset}-${offset + chunk.size - 1}/${totalBytes}`);
    } else {
      xhr.setRequestHeader("upload-offset", String(offset));
    }
    xhr.upload.addEventListener("progress", (event) => {
      const sent = offset + (event.lengthComputable ? event.loaded : 0);
      onProgress(Math.min(100, Math.round((sent / totalBytes) * 100)));
    });
    xhr.addEventListener("error", () => reject(new ApiError(503, "upload-transfer-failed", "The file transfer was interrupted")));
    xhr.addEventListener("abort", () => reject(new ApiError(499, "upload-cancelled", "The file transfer was cancelled")));
    xhr.addEventListener("load", () => {
      if (protocol === "gcs_resumable") {
        try {
          resolve({ uploadOffset: nextGcsOffset(xhr.status, xhr.getResponseHeader("range"), totalBytes) });
        } catch (error) {
          reject(error);
        }
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) return reject(xhrError(xhr));
      try {
        const result = JSON.parse(xhr.responseText) as UploadContentResponse;
        resolve({ uploadOffset: result.upload_offset, uploadSession: result.upload_session });
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

function queryGcsOffset(
  authorization: UploadAuthorization,
  totalBytes: number,
  signal?: AbortSignal,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", authorization.upload_url);
    xhr.setRequestHeader("content-range", `bytes */${totalBytes}`);
    xhr.addEventListener("error", () => reject(new ApiError(503, "upload-transfer-failed", "The upload position could not be recovered")));
    xhr.addEventListener("abort", () => reject(new ApiError(499, "upload-cancelled", "The file transfer was cancelled")));
    xhr.addEventListener("load", () => {
      try {
        resolve(nextGcsOffset(xhr.status, xhr.getResponseHeader("range"), totalBytes));
      } catch (error) {
        reject(error);
      }
    });
    if (signal) {
      if (signal.aborted) return xhr.abort();
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.send();
  });
}

async function transferFile(
  authorization: UploadAuthorization,
  file: File,
  startingOffset: number,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<{ bytesReceived: number; uploadSession?: UploadSessionRecord }> {
  const chunkSize = authorization.protocol === "gcs_resumable" ? 8 * 1024 * 1024 : 4 * 1024 * 1024;
  let offset = authorization.protocol === "gcs_resumable"
    ? await queryGcsOffset(authorization, file.size, signal)
    : startingOffset;
  let latest: UploadSessionRecord | null = null;
  while (offset < file.size) {
    const end = Math.min(file.size, offset + chunkSize);
    const result = await uploadChunk(authorization, file.slice(offset, end), offset, file.size, onProgress, signal);
    if (result.uploadOffset <= offset || result.uploadOffset > file.size) {
      throw new ApiError(502, "upload-offset-invalid", "The upload service returned an invalid resume position");
    }
    offset = result.uploadOffset;
    latest = result.uploadSession ?? latest;
  }
  if (offset === 0) throw new ApiError(400, "upload-empty", "Choose a non-empty image or PDF file");
  onProgress(100);
  return { bytesReceived: offset, uploadSession: latest ?? undefined };
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
  createGuestSession(): Promise<GuestSessionAuthorization> {
    return request("/guest-sessions", { method: "POST" }, { includeActor: false });
  },
  createGuestUploadSession(
    guestToken: string,
    file: File,
    mediaType: string,
    traceId: string,
  ): Promise<UploadSessionCreated> {
    return request("/guest/upload-sessions", {
      method: "POST",
      headers: { "idempotency-key": commandKey("guest-upload") },
      body: JSON.stringify({ display_name: file.name, media_type: mediaType, byte_size: file.size }),
    }, { traceId, guestToken, includeActor: false });
  },
  transferFile,
  resumeUploadSession(
    uploadSessionId: string,
    traceId: string,
    guestToken?: string,
  ): Promise<UploadResumeResponse> {
    return request(
      `/upload-sessions/${uploadSessionId}/resume`,
      { method: "POST" },
      { traceId, guestToken },
    );
  },
  finaliseUpload(
    uploadSessionId: string,
    traceId: string,
    guestToken?: string,
  ): Promise<UploadFinaliseResponse> {
    return request(`/upload-sessions/${uploadSessionId}/finalise`, {
      method: "POST",
      headers: { "idempotency-key": commandKey("finalise") },
    }, { traceId, guestToken });
  },
  uploadStatus(uploadSessionId: string, traceId: string, guestToken?: string): Promise<UploadStatusResponse> {
    return request(`/upload-sessions/${uploadSessionId}`, {}, { traceId, guestToken });
  },
  intakePresentation(
    uploadSessionId: string,
    traceId: string,
    guestToken?: string,
  ): Promise<IntakePresentationResponse> {
    return request(`/upload-sessions/${uploadSessionId}/intake-presentation`, {}, { traceId, guestToken });
  },
  correctIntakeClassification(
    uploadSessionId: string,
    category: IntakeSourceCategory,
    traceId: string,
    guestToken?: string,
  ): Promise<ClassificationCorrectionResponse> {
    return request(`/upload-sessions/${uploadSessionId}/classification`, {
      method: "PUT",
      headers: { "idempotency-key": commandKey("classification") },
      body: JSON.stringify({ category }),
    }, { traceId, guestToken });
  },
  jobStatus(jobId: string, traceId: string, guestToken?: string): Promise<JobStatusResponse> {
    return request(`/jobs/${jobId}`, {}, { traceId, guestToken });
  },
  jobEvents(jobId: string, after: number, traceId: string, guestToken?: string): Promise<JobEventList> {
    return request(`/jobs/${jobId}/events?after=${after}&limit=100`, {}, { traceId, guestToken });
  },
  cancelUpload(uploadSessionId: string, traceId: string, guestToken?: string): Promise<UploadStatusResponse> {
    return request(`/upload-sessions/${uploadSessionId}`, {
      method: "DELETE",
      headers: { "idempotency-key": commandKey("upload-cancel") },
    }, { traceId, guestToken });
  },
  cancelJob(jobId: string, traceId: string, guestToken?: string): Promise<JobStatusResponse> {
    return request(`/jobs/${jobId}/cancel`, {
      method: "POST",
      headers: { "idempotency-key": commandKey("job-cancel") },
    }, { traceId, guestToken });
  },
  handoffGuest(
    uploadSessionId: string,
    guestToken: string,
    workspaceId: string,
    traceId: string,
  ): Promise<{ file: WorkspaceFile; asset_original_id: string; source_version_id: string }> {
    return request(`/upload-sessions/${uploadSessionId}/handoff`, {
      method: "POST",
      headers: { "idempotency-key": commandKey("guest-handoff") },
      body: JSON.stringify({ workspace_id: workspaceId }),
    }, { traceId, guestToken });
  },
};
