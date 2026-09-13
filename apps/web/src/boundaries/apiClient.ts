import type {
  Actor,
  DefaultFilesLocation,
  EffectivePermission,
  GuestSessionAuthorization,
  IntelligentIntakePresentation,
  IntakeClassificationRecord,
  IntakeSourceCategory,
  JobEventList,
  JobList,
  Membership,
  ProcessingJobRecord,
  ProjectRecord,
  UploadAuthorization,
  UploadSessionCreated,
  UploadSessionRecord,
  Workspace,
  WorkspaceFile,
  WorkspaceProjectPolicy,
  WorkspaceHome,
  WorkspaceSearchPage,
  NotificationList,
  FeatureStateList,
  DocumentReadModel,
  EditorDocumentRecord,
  EditorLeaseGrant,
  EditorMutation,
  EditorDocumentSnapshot,
  DocumentVersionRecord,
  ImportCompatibilityReport,
  StudioSourceCandidate,
  EnhancementPreview,
  ExportOutputProfile,
  ExportZipBundle,
  ImageExportRequestRecord,
  ImageOperation,
  IntendedOutcome,
  ProcessingRecipeRecord,
  RecommendationDecision,
  RecommendationSet,
  BatchCreateRequest,
  BatchPlan,
  BatchPlanRequest,
  BatchReport,
  BatchRunRecord,
  PdfCreateRequest,
  PdfCapabilityReport,
  PdfExportRequestRecord,
  PdfExportResult,
  PdfPreflightReport,
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

export interface WorkspaceListResponse {
  schema_version: string;
  workspaces: Workspace[];
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

export interface WorkspaceHomeResponse {
  schema_version: string;
  home: WorkspaceHome;
}

export interface JobListResponse extends JobList {}

export interface NotificationListResponse extends NotificationList {}

export interface SearchResponse extends WorkspaceSearchPage {}

export interface DocumentListResponse { schema_version: string; documents: EditorDocumentRecord[] }
export interface DocumentResponse { schema_version: string; editor: DocumentReadModel; replayed?: boolean }
export interface DocumentMutationResponse {
  schema_version: string;
  mutation: {
    document: EditorDocumentRecord;
    snapshot: EditorDocumentSnapshot;
    operationId: string;
    checkpoint: DocumentVersionRecord | null;
    replayed: boolean;
  };
}

export interface RecipeListResponse { schema_version: string; recipes: ProcessingRecipeRecord[] }
export interface RecipeResponse { schema_version: string; recipe: ProcessingRecipeRecord; replayed: boolean }
export interface RecommendationResponse { schema_version: string; recommendation_set: RecommendationSet; replayed: boolean }
export interface EnhancementPreviewResponse { schema_version: string; preview: EnhancementPreview }
export interface RecommendationDecisionResponse { schema_version: string; decisions: RecommendationDecision[]; replayed: boolean }
export interface ExportListResponse { schema_version: string; exports: ImageExportRequestRecord[] }
export interface ExportResponse { schema_version: string; export_request: ImageExportRequestRecord; replayed?: boolean }
export interface ExportBundleResponse { schema_version: string; bundle: ExportZipBundle; replayed?: boolean }
export interface BatchPlanResponse { schema_version: string; plan: BatchPlan }
export interface BatchResponse { schema_version: string; batch: BatchRunRecord; replayed?: boolean }
export interface BatchListResponse { schema_version: string; batches: BatchRunRecord[] }
export interface BatchReportResponse { schema_version: string; report: BatchReport }
export interface PdfExportReadModel { request: PdfExportRequestRecord; result: PdfExportResult | null }
export interface PdfPreflightResponse { schema_version: string; preflight: PdfPreflightReport }
export interface PdfExportResponse { schema_version: string; pdf_export: PdfExportReadModel; replayed?: boolean }
export interface PdfExportListResponse { schema_version: string; pdf_exports: PdfExportReadModel[] }
export interface PdfCapabilityReportResponse { schema_version: string; capability_report: PdfCapabilityReport }
export interface PdfCapabilityReportListResponse { schema_version: string; capability_reports: PdfCapabilityReport[] }

export type AuthSessionResponse = { authenticated: false } | {
  authenticated: true;
  actor: Actor;
  expires_at: string;
};

interface RequestOptions {
  traceId?: string;
}

function commandKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function createTraceId(): string {
  return `trace-${crypto.randomUUID()}`;
}

async function request<T>(path: string, init: RequestInit = {}, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const method = (init.method ?? "GET").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const csrf = csrfToken();
    if (csrf) headers.set("x-csrf-token", csrf);
  }
  headers.set("x-trace-id", options.traceId ?? createTraceId());
  const response = await fetch(`/v1${path}`, {
    ...init,
    headers,
    credentials: "same-origin",
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

function csrfToken(): string | null {
  for (const part of document.cookie.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === "ipw-csrf" || rawName === "__Host-ipw-csrf") {
      try { return decodeURIComponent(rawValue.join("=")); } catch { return null; }
    }
  }
  return null;
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
    const uploadOrigin = new URL(authorization.upload_url, window.location.href).origin;
    if (uploadOrigin === window.location.origin) {
      const csrf = csrfToken();
      if (csrf) xhr.setRequestHeader("x-csrf-token", csrf);
    }
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
  authSession(): Promise<AuthSessionResponse> {
    return request("/auth/session");
  },
  logout(): Promise<{ authenticated: false }> {
    return request("/auth/logout", { method: "POST" });
  },
  loginUrl(returnTo: string, handoffUploadSessionId?: string): string {
    const query = new URLSearchParams({ return_to: returnTo });
    if (handoffUploadSessionId) query.set("handoff", handoffUploadSessionId);
    return `/v1/auth/login?${query}`;
  },
  bootstrap(): Promise<WorkspaceContextResponse> {
    const key = sessionStorage.getItem("ipw-bootstrap-key") ?? commandKey("bootstrap");
    sessionStorage.setItem("ipw-bootstrap-key", key);
    return request("/session/bootstrap", { method: "POST", headers: { "idempotency-key": key } });
  },
  context(workspaceId: string): Promise<WorkspaceContextResponse> {
    return request(`/workspaces/${workspaceId}/context`);
  },
  workspaces(): Promise<WorkspaceListResponse> {
    return request("/me/workspaces");
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
    return request("/guest-sessions", { method: "POST" });
  },
  createGuestUploadSession(
    file: File,
    mediaType: string,
    traceId: string,
  ): Promise<UploadSessionCreated> {
    return request("/guest/upload-sessions", {
      method: "POST",
      headers: { "idempotency-key": commandKey("guest-upload") },
      body: JSON.stringify({ display_name: file.name, media_type: mediaType, byte_size: file.size }),
    }, { traceId });
  },
  transferFile,
  resumeUploadSession(
    uploadSessionId: string,
    traceId: string,
  ): Promise<UploadResumeResponse> {
    return request(
      `/upload-sessions/${uploadSessionId}/resume`,
      { method: "POST" },
      { traceId },
    );
  },
  finaliseUpload(
    uploadSessionId: string,
    traceId: string,
  ): Promise<UploadFinaliseResponse> {
    return request(`/upload-sessions/${uploadSessionId}/finalise`, {
      method: "POST",
      headers: { "idempotency-key": `finalise-${uploadSessionId}` },
    }, { traceId });
  },
  uploadStatus(uploadSessionId: string, traceId: string): Promise<UploadStatusResponse> {
    return request(`/upload-sessions/${uploadSessionId}`, {}, { traceId });
  },
  intakePresentation(
    uploadSessionId: string,
    traceId: string,
  ): Promise<IntakePresentationResponse> {
    return request(`/upload-sessions/${uploadSessionId}/intake-presentation`, {}, { traceId });
  },
  correctIntakeClassification(
    uploadSessionId: string,
    category: IntakeSourceCategory,
    traceId: string,
  ): Promise<ClassificationCorrectionResponse> {
    return request(`/upload-sessions/${uploadSessionId}/classification`, {
      method: "PUT",
      headers: { "idempotency-key": commandKey("classification") },
      body: JSON.stringify({ category }),
    }, { traceId });
  },
  jobStatus(jobId: string, traceId: string): Promise<JobStatusResponse> {
    return request(`/jobs/${jobId}`, {}, { traceId });
  },
  jobs(workspaceId: string, view = "all", cursor?: string, limit = 25): Promise<JobListResponse> {
    const query = new URLSearchParams({ view, limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return request(`/workspaces/${workspaceId}/jobs?${query}`);
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
  retryJob(jobId: string, traceId: string): Promise<JobStatusResponse & { command: { replayed: boolean } }> {
    return request(`/jobs/${jobId}/retry`, {
      method: "POST",
      headers: { "idempotency-key": commandKey("job-retry") },
    }, { traceId });
  },
  home(workspaceId: string): Promise<WorkspaceHomeResponse> {
    return request(`/workspaces/${workspaceId}/home`);
  },
  notifications(workspaceId: string, cursor?: string, limit = 25): Promise<NotificationListResponse> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return request(`/workspaces/${workspaceId}/notifications?${query}`);
  },
  markNotificationRead(workspaceId: string, notificationId: string): Promise<{ command: { replayed: boolean } }> {
    return request(`/workspaces/${workspaceId}/notifications/${notificationId}/read`, {
      method: "POST",
      headers: { "idempotency-key": commandKey("notification-read") },
    });
  },
  markAllNotificationsRead(workspaceId: string): Promise<{ command: { replayed: boolean } }> {
    return request(`/workspaces/${workspaceId}/notifications/read-all`, {
      method: "POST",
      headers: { "idempotency-key": commandKey("notification-read-all") },
    });
  },
  search(workspaceId: string, queryValue: string, cursor?: string, limit = 20): Promise<SearchResponse> {
    const query = new URLSearchParams({ q: queryValue, limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return request(`/workspaces/${workspaceId}/search?${query}`);
  },
  features(workspaceId: string): Promise<FeatureStateList> {
    return request(`/workspaces/${workspaceId}/features`);
  },
  documents(workspaceId: string): Promise<DocumentListResponse> {
    return request(`/workspaces/${workspaceId}/documents`);
  },
  studioSources(workspaceId: string): Promise<{ sources: StudioSourceCandidate[] }> {
    return request(`/workspaces/${workspaceId}/documents/studio-sources`);
  },
  createDocument(workspaceId: string, input: {
    name: string;
    source_file_id?: string;
    project_id?: string;
    intended_use: "source" | "digital" | "print" | "custom";
    intended_use_label?: string;
    width?: number;
    height?: number;
  }): Promise<DocumentResponse> {
    return request(`/workspaces/${workspaceId}/documents`, {
      method: "POST",
      headers: { "idempotency-key": commandKey("document") },
      body: JSON.stringify(input),
    });
  },
  createPdfDocument(workspaceId: string, input: PdfCreateRequest): Promise<DocumentResponse> {
    return request(`/workspaces/${workspaceId}/documents/pdf`, {
      method: "POST",
      headers: { "idempotency-key": commandKey("pdf-document") },
      body: JSON.stringify(input),
    });
  },
  document(workspaceId: string, documentId: string): Promise<DocumentResponse> {
    return request(`/workspaces/${workspaceId}/documents/${documentId}`);
  },
  acquireDocumentLease(workspaceId: string, documentId: string, idempotencyKey = commandKey("editor-lease")): Promise<{ grant: EditorLeaseGrant }> {
    return request(`/workspaces/${workspaceId}/documents/${documentId}/lease`, {
      method: "POST", headers: { "idempotency-key": idempotencyKey },
    });
  },
  heartbeatDocumentLease(workspaceId: string, documentId: string, leaseToken: string) {
    return request<{ grant: EditorLeaseGrant }>(`/workspaces/${workspaceId}/documents/${documentId}/lease/heartbeat`, {
      method: "POST", headers: { "idempotency-key": commandKey("editor-heartbeat"), "x-editor-lease": leaseToken },
    });
  },
  documentLeaseStatus(workspaceId: string, documentId: string, leaseToken: string) {
    return request<{
      status: {
        lease: EditorLeaseGrant["lease"];
        takeoverRequest: { actorId: string; actorDisplayName: string; reason: string; requestedAt: string } | null;
      };
    }>(`/workspaces/${workspaceId}/documents/${documentId}/lease`, {
      headers: { "x-editor-lease": leaseToken },
    });
  },
  releaseDocumentLease(workspaceId: string, documentId: string, leaseToken: string) {
    return request(`/workspaces/${workspaceId}/documents/${documentId}/lease/release`, {
      method: "POST", headers: { "idempotency-key": commandKey("editor-release"), "x-editor-lease": leaseToken },
    });
  },
  takeoverDocumentLease(workspaceId: string, documentId: string, reason = "Editing access requested"): Promise<{ takeover: { status: "requested" | "acquired"; grant?: EditorLeaseGrant | null } }> {
    return request(`/workspaces/${workspaceId}/documents/${documentId}/lease/takeover`, {
      method: "POST", headers: { "idempotency-key": commandKey("editor-takeover") }, body: JSON.stringify({ reason }),
    });
  },
  forceTakeoverDocumentLease(workspaceId: string, documentId: string, reason: string) {
    return request<{ takeover: { status: "acquired"; grant: EditorLeaseGrant } }>(`/workspaces/${workspaceId}/documents/${documentId}/lease/takeover/force`, {
      method: "POST", headers: { "idempotency-key": commandKey("editor-force-takeover") }, body: JSON.stringify({ reason }),
    });
  },
  denyTakeoverDocumentLease(workspaceId: string, documentId: string, leaseToken: string, reason: string) {
    return request(`/workspaces/${workspaceId}/documents/${documentId}/lease/takeover/deny`, {
      method: "POST", headers: { "idempotency-key": commandKey("editor-deny-takeover"), "x-editor-lease": leaseToken }, body: JSON.stringify({ reason }),
    });
  },
  mutateDocument(
    workspaceId: string,
    documentId: string,
    leaseToken: string,
    baseRevision: number,
    mutation: EditorMutation,
    replay?: { operationId: string; idempotencyKey: string; traceId: string },
  ): Promise<DocumentMutationResponse> {
    return request(`/workspaces/${workspaceId}/documents/${documentId}`, {
      method: "PATCH", headers: { "idempotency-key": replay?.idempotencyKey ?? commandKey("editor-mutation"), "x-editor-lease": leaseToken },
      body: JSON.stringify({ base_revision: baseRevision, operation_id: replay?.operationId, mutation }),
    }, { traceId: replay?.traceId });
  },
  addDocumentAsset(
    workspaceId: string,
    documentId: string,
    leaseToken: string,
    baseRevision: number,
    fileId: string,
    artboardId: string,
  ): Promise<DocumentMutationResponse> {
    return request(`/workspaces/${workspaceId}/documents/${documentId}/assets`, {
      method: "POST",
      headers: { "idempotency-key": commandKey("editor-asset"), "x-editor-lease": leaseToken },
      body: JSON.stringify({ base_revision: baseRevision, file_id: fileId, artboard_id: artboardId }),
    });
  },
  documentHistory(workspaceId: string, documentId: string, leaseToken: string, direction: "undo" | "redo") {
    return request<{ history: { document: EditorDocumentRecord; snapshot: EditorDocumentSnapshot; canUndo: boolean; canRedo: boolean } }>(`/workspaces/${workspaceId}/documents/${documentId}/${direction}`, {
      method: "POST", headers: { "idempotency-key": commandKey(`editor-${direction}`), "x-editor-lease": leaseToken },
    });
  },
  createDocumentVersion(workspaceId: string, documentId: string, name: string): Promise<{ version: DocumentVersionRecord }> {
    return request(`/workspaces/${workspaceId}/documents/${documentId}/versions`, {
      method: "POST", headers: { "idempotency-key": commandKey("editor-version") }, body: JSON.stringify({ name }),
    });
  },
  restoreDocumentVersion(workspaceId: string, documentId: string, versionId: string, leaseToken: string): Promise<DocumentResponse> {
    return request(`/workspaces/${workspaceId}/documents/${documentId}/versions/${versionId}/restore`, {
      method: "POST", headers: { "idempotency-key": commandKey("editor-restore"), "x-editor-lease": leaseToken },
    });
  },
  saveAsDocument(workspaceId: string, documentId: string, name: string, projectId?: string, recoveredSnapshot?: EditorDocumentSnapshot): Promise<DocumentResponse> {
    return request(`/workspaces/${workspaceId}/documents/${documentId}/save-as`, {
      method: "POST",
      headers: { "idempotency-key": commandKey("editor-save-as") },
      body: JSON.stringify({ name, project_id: projectId || undefined, recovered_snapshot: recoveredSnapshot }),
    });
  },
  moveDocument(workspaceId: string, documentId: string, projectId?: string): Promise<{ document: EditorDocumentRecord; replayed: boolean }> {
    return request(`/workspaces/${workspaceId}/documents/${documentId}/location`, {
      method: "PATCH",
      headers: { "idempotency-key": commandKey("editor-move") },
      body: JSON.stringify({ project_id: projectId || undefined }),
    });
  },
  documentCompatibility(workspaceId: string, documentId: string): Promise<{ reports: ImportCompatibilityReport[] }> {
    return request(`/workspaces/${workspaceId}/documents/${documentId}/compatibility-reports`);
  },
  processingRecipes(workspaceId: string, documentId: string): Promise<RecipeListResponse> {
    return request(`/workspaces/${workspaceId}/documents/${documentId}/recipes`);
  },
  createProcessingRecipe(workspaceId: string, documentId: string, name: string, operations: ImageOperation[]): Promise<RecipeResponse> {
    return request(`/workspaces/${workspaceId}/documents/${documentId}/recipes`, {
      method: "POST",
      headers: { "idempotency-key": commandKey("recipe-create") },
      body: JSON.stringify({ name, operations }),
    });
  },
  updateProcessingRecipe(workspaceId: string, documentId: string, recipeId: string, name: string, operations: ImageOperation[]): Promise<RecipeResponse> {
    return request(`/workspaces/${workspaceId}/documents/${documentId}/recipes/${recipeId}`, {
      method: "PATCH",
      headers: { "idempotency-key": commandKey("recipe-update") },
      body: JSON.stringify({ name, operations }),
    });
  },
  requestRecommendations(workspaceId: string, documentId: string, documentVersionId: string, intendedOutcome: IntendedOutcome | null): Promise<RecommendationResponse> {
    return request(`/workspaces/${workspaceId}/documents/${documentId}/recommendations`, {
      method: "POST",
      headers: { "idempotency-key": commandKey("recommendations") },
      body: JSON.stringify({ document_version_id: documentVersionId, intended_outcome: intendedOutcome }),
    });
  },
  decideRecommendations(workspaceId: string, recommendationSetId: string, decisions: Array<{ recommendation_id: string; state: "accepted" | "declined" }>): Promise<RecommendationDecisionResponse> {
    return request(`/workspaces/${workspaceId}/recommendation-sets/${recommendationSetId}/decisions`, {
      method: "PATCH",
      headers: { "idempotency-key": commandKey("recommendation-decisions") },
      body: JSON.stringify({ decisions }),
    });
  },
  requestEnhancementPreview(workspaceId: string, documentId: string, recipeId: string, recipeVersion: number, mode: "original" | "current" | "recommended", artboardId: string): Promise<EnhancementPreviewResponse> {
    return request(`/workspaces/${workspaceId}/documents/${documentId}/enhancement-previews`, {
      method: "POST",
      headers: { "idempotency-key": commandKey("enhancement-preview") },
      body: JSON.stringify({ recipe_id: recipeId, recipe_version: recipeVersion, mode, artboard_id: artboardId }),
    });
  },
  enhancementPreview(workspaceId: string, previewId: string): Promise<EnhancementPreviewResponse> {
    return request(`/workspaces/${workspaceId}/enhancement-previews/${previewId}`);
  },
  submitImageExport(workspaceId: string, documentId: string, input: {
    document_version_id: string;
    recipe_id: string;
    recipe_version: number;
    outputs: Array<{ artboard_id: string; profile: ExportOutputProfile; filename: string }>;
  }): Promise<ExportResponse> {
    return request(`/workspaces/${workspaceId}/documents/${documentId}/exports`, {
      method: "POST",
      headers: { "idempotency-key": commandKey("image-export") },
      body: JSON.stringify(input),
    });
  },
  imageExports(workspaceId: string, documentId?: string): Promise<ExportListResponse> {
    const query = documentId ? `?document_id=${encodeURIComponent(documentId)}` : "";
    return request(`/workspaces/${workspaceId}/exports${query}`);
  },
  imageExport(workspaceId: string, exportRequestId: string): Promise<ExportResponse> {
    return request(`/workspaces/${workspaceId}/exports/${exportRequestId}`);
  },
  cancelImageExport(workspaceId: string, exportRequestId: string): Promise<ExportResponse> {
    return request(`/workspaces/${workspaceId}/exports/${exportRequestId}/cancel`, {
      method: "POST", headers: { "idempotency-key": commandKey("export-cancel") },
    });
  },
  retryImageExport(workspaceId: string, exportRequestId: string): Promise<ExportResponse> {
    return request(`/workspaces/${workspaceId}/exports/${exportRequestId}/retry`, {
      method: "POST", headers: { "idempotency-key": commandKey("export-retry") },
    });
  },
  createExportBundle(workspaceId: string, exportRequestId: string): Promise<ExportBundleResponse> {
    return request(`/workspaces/${workspaceId}/exports/${exportRequestId}/bundles`, {
      method: "POST", headers: { "idempotency-key": commandKey("export-bundle") },
    });
  },
  exportBundle(workspaceId: string, bundleId: string): Promise<ExportBundleResponse> {
    return request(`/workspaces/${workspaceId}/export-bundles/${bundleId}`);
  },
  planImageBatch(workspaceId: string, input: BatchPlanRequest): Promise<BatchPlanResponse> {
    return request(`/workspaces/${workspaceId}/batches/plan`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  submitImageBatch(
    workspaceId: string,
    input: BatchCreateRequest,
    idempotencyKey = commandKey("batch-submit"),
  ): Promise<BatchResponse> {
    return request(`/workspaces/${workspaceId}/batches`, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(input),
    });
  },
  imageBatches(workspaceId: string): Promise<BatchListResponse> {
    return request(`/workspaces/${workspaceId}/batches`);
  },
  imageBatch(workspaceId: string, batchId: string): Promise<BatchResponse> {
    return request(`/workspaces/${workspaceId}/batches/${batchId}`);
  },
  cancelImageBatch(workspaceId: string, batchId: string): Promise<BatchResponse> {
    return request(`/workspaces/${workspaceId}/batches/${batchId}/cancel`, {
      method: "POST",
      headers: { "idempotency-key": commandKey("batch-cancel") },
    });
  },
  retryImageBatch(workspaceId: string, batchId: string): Promise<BatchResponse> {
    return request(`/workspaces/${workspaceId}/batches/${batchId}/retry`, {
      method: "POST",
      headers: { "idempotency-key": commandKey("batch-retry") },
    });
  },
  imageBatchReport(workspaceId: string, batchId: string): Promise<BatchReportResponse> {
    return request(`/workspaces/${workspaceId}/batches/${batchId}/report`);
  },
  pdfPreflight(workspaceId: string, documentId: string): Promise<PdfPreflightResponse> {
    return request(`/workspaces/${workspaceId}/documents/${documentId}/pdf-preflight`);
  },
  pdfCapabilityReports(workspaceId: string): Promise<PdfCapabilityReportListResponse> {
    return request(`/workspaces/${workspaceId}/pdf-files`);
  },
  pdfCapabilityReport(workspaceId: string, fileId: string): Promise<PdfCapabilityReportResponse> {
    return request(`/workspaces/${workspaceId}/pdf-files/${fileId}/capability-report`);
  },
  submitPdfExport(workspaceId: string, documentId: string): Promise<PdfExportResponse> {
    return request(`/workspaces/${workspaceId}/documents/${documentId}/pdf-exports`, {
      method: "POST",
      headers: { "idempotency-key": commandKey("pdf-export") },
    });
  },
  pdfExports(workspaceId: string, documentId?: string): Promise<PdfExportListResponse> {
    const query = documentId ? `?document_id=${encodeURIComponent(documentId)}` : "";
    return request(`/workspaces/${workspaceId}/pdf-exports${query}`);
  },
  pdfExport(workspaceId: string, requestId: string): Promise<PdfExportResponse> {
    return request(`/workspaces/${workspaceId}/pdf-exports/${requestId}`);
  },
  cancelPdfExport(workspaceId: string, requestId: string): Promise<PdfExportResponse> {
    return request(`/workspaces/${workspaceId}/pdf-exports/${requestId}/cancel`, {
      method: "PATCH",
      headers: { "idempotency-key": commandKey("pdf-export-cancel") },
    });
  },
  retryPdfExport(workspaceId: string, requestId: string): Promise<PdfExportResponse> {
    return request(`/workspaces/${workspaceId}/pdf-exports/${requestId}/retry`, {
      method: "POST",
      headers: { "idempotency-key": commandKey("pdf-export-retry") },
    });
  },
  pdfExportDownloadUrl(workspaceId: string, requestId: string): string {
    return `/v1/workspaces/${encodeURIComponent(workspaceId)}/pdf-exports/${encodeURIComponent(requestId)}/download`;
  },
  exportOutputDownloadUrl(workspaceId: string, outputId: string): string {
    return `/v1/workspaces/${encodeURIComponent(workspaceId)}/export-outputs/${encodeURIComponent(outputId)}/download`;
  },
  exportBundleDownloadUrl(workspaceId: string, bundleId: string): string {
    return `/v1/workspaces/${encodeURIComponent(workspaceId)}/export-bundles/${encodeURIComponent(bundleId)}/download`;
  },
  documentSourceUrl(workspaceId: string, documentId: string): string {
    return `/v1/workspaces/${encodeURIComponent(workspaceId)}/documents/${encodeURIComponent(documentId)}/source`;
  },
  documentAssetSourceUrl(workspaceId: string, documentId: string, sharedAssetId: string): string {
    return `/v1/workspaces/${encodeURIComponent(workspaceId)}/documents/${encodeURIComponent(documentId)}/assets/${encodeURIComponent(sharedAssetId)}/source`;
  },
  handoffGuest(
    uploadSessionId: string,
    workspaceId: string,
    traceId: string,
    idempotencyKey = commandKey("guest-handoff"),
  ): Promise<{ file: WorkspaceFile; asset_original_id: string; source_version_id: string }> {
    return request(`/upload-sessions/${uploadSessionId}/handoff`, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify({ workspace_id: workspaceId }),
    }, { traceId });
  },
};
