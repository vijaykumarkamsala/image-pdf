import type {
  FaceQualityCandidateRequest,
  FaceQualityCapabilities,
  FaceQualityCompositionIntent,
  FaceQualityJobView,
} from "ipw-contracts-ts/product";

const CONTRACT_VERSION = "image-quality-face-v1" as const;
const ACTIVE_JOB_PREFIX = "ipw-face-quality-active-v1-";
const SHA256 = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const TERMINAL = new Set<FaceQualityJobView["state"]>(["succeeded", "failed", "cancelled"]);

export interface NativeFaceRemoteContext {
  uploadSessionId: string;
  baseImageQualityRequestId: string;
  sourceSha256: string;
  baseOutputSha256: string;
}

interface StoredNativeFaceJob {
  version: 1;
  operation: FaceQualityJobView["operation"];
  uploadSessionId: string;
  baseImageQualityRequestId: string;
  sourceSha256: string;
  baseOutputSha256: string;
  faceQualityJobId: string;
  expiresAt: string;
}

export interface NativeFaceQualityTransport {
  capabilities(uploadSessionId: string, traceId: string, signal?: AbortSignal): Promise<FaceQualityCapabilities>;
  createCandidates(
    uploadSessionId: string,
    intent: FaceQualityCandidateRequest,
    traceId: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<NativeFaceCommandResponse>;
  createComposition(
    uploadSessionId: string,
    intent: FaceQualityCompositionIntent,
    traceId: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<NativeFaceCommandResponse>;
  get(uploadSessionId: string, jobId: string, traceId: string, signal?: AbortSignal): Promise<FaceQualityJobView>;
  cancel(uploadSessionId: string, jobId: string, traceId: string, signal?: AbortSignal): Promise<FaceQualityJobView>;
  retry(
    uploadSessionId: string,
    jobId: string,
    traceId: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<NativeFaceCommandResponse>;
  downloadUrl(uploadSessionId: string, jobId: string): string;
  candidateArtifact(
    uploadSessionId: string,
    jobId: string,
    candidateId: string,
    kind: "pixels" | "mask",
    signal?: AbortSignal,
  ): Promise<NativeFaceCandidateArtifact>;
}

export interface NativeFaceCommandResponse {
  value: FaceQualityJobView;
  replayed: boolean;
}

export interface NativeFaceCandidateArtifact {
  bytes: ArrayBuffer;
  candidateSha256: string;
  artifactSha256: string;
  width: number;
  height: number;
  bitDepth: 8 | 16;
  kind: "pixels" | "mask";
}

function createTraceId(): string {
  return `trace-${crypto.randomUUID()}`;
}

function validateContext(context: NativeFaceRemoteContext): void {
  if (!IDENTIFIER.test(context.uploadSessionId) || !IDENTIFIER.test(context.baseImageQualityRequestId)) {
    throw new Error("Native face work requires server-issued upload and enhancement identifiers.");
  }
  if (!SHA256.test(context.sourceSha256) || !SHA256.test(context.baseOutputSha256)) {
    throw new Error("Native face work must be bound to exact original and enhanced image hashes.");
  }
}

function validateJob(job: FaceQualityJobView, context: NativeFaceRemoteContext, operation?: FaceQualityJobView["operation"]): void {
  if (!IDENTIFIER.test(job.face_quality_job_id) || !IDENTIFIER.test(job.job_id)
    || job.source_sha256 !== context.sourceSha256 || job.base_output_sha256 !== context.baseOutputSha256
    || (operation && job.operation !== operation)
    || !Number.isInteger(job.progress_percent) || job.progress_percent < 0 || job.progress_percent > 100
    || !Number.isFinite(Date.parse(job.expires_at))) {
    throw new Error("The native face job does not belong to this exact original and enhanced image.");
  }
}

function storageKey(context: NativeFaceRemoteContext, operation: FaceQualityJobView["operation"]): string {
  return `${ACTIVE_JOB_PREFIX}${context.baseImageQualityRequestId}-${operation}`;
}

function storedJob(job: FaceQualityJobView, context: NativeFaceRemoteContext): StoredNativeFaceJob {
  return {
    version: 1,
    operation: job.operation,
    uploadSessionId: context.uploadSessionId,
    baseImageQualityRequestId: context.baseImageQualityRequestId,
    sourceSha256: context.sourceSha256,
    baseOutputSha256: context.baseOutputSha256,
    faceQualityJobId: job.face_quality_job_id,
    expiresAt: job.expires_at,
  };
}

function parseStoredJob(value: string | null, context: NativeFaceRemoteContext, now: number): StoredNativeFaceJob | null {
  if (!value) return null;
  try {
    const candidate = JSON.parse(value) as Partial<StoredNativeFaceJob>;
    if (candidate.version === 1
      && (candidate.operation === "candidates" || candidate.operation === "compose")
      && candidate.uploadSessionId === context.uploadSessionId
      && candidate.baseImageQualityRequestId === context.baseImageQualityRequestId
      && candidate.sourceSha256 === context.sourceSha256
      && candidate.baseOutputSha256 === context.baseOutputSha256
      && typeof candidate.faceQualityJobId === "string" && IDENTIFIER.test(candidate.faceQualityJobId)
      && typeof candidate.expiresAt === "string" && Date.parse(candidate.expiresAt) > now) {
      return candidate as StoredNativeFaceJob;
    }
  } catch {
    // Corrupt or stale browser state is never used to address private work.
  }
  return null;
}

async function idempotencyKey(prefix: string, payload: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(payload)));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${hex.slice(0, 48)}`;
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Native face work cancelled.", "AbortError"));
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      reject(new DOMException("Native face work cancelled.", "AbortError"));
    };
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isExpiredOrMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error
    && typeof error.status === "number" && [404, 409, 410].includes(error.status);
}

/**
 * Owner-scoped orchestration only. It never receives pixels, model paths or model
 * approval flags; the browser can address only the API's current private job.
 */
export class NativeFaceQualityCoordinator {
  private readonly transport: NativeFaceQualityTransport;
  private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  private readonly pollMilliseconds: number;
  private readonly now: () => number;

  constructor(
    transport: NativeFaceQualityTransport,
    storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = sessionStorage,
    pollMilliseconds = 800,
    now = () => Date.now(),
  ) {
    this.transport = transport;
    this.storage = storage;
    this.pollMilliseconds = pollMilliseconds;
    this.now = now;
  }

  capabilities(context: NativeFaceRemoteContext, signal?: AbortSignal): Promise<FaceQualityCapabilities> {
    validateContext(context);
    return this.transport.capabilities(context.uploadSessionId, createTraceId(), signal);
  }

  async recover(
    context: NativeFaceRemoteContext,
    operation: FaceQualityJobView["operation"],
    signal: AbortSignal,
    onProgress?: (job: FaceQualityJobView) => void,
  ): Promise<FaceQualityJobView | null> {
    validateContext(context);
    const key = storageKey(context, operation);
    const saved = parseStoredJob(this.storage.getItem(key), context, this.now());
    if (!saved) {
      this.storage.removeItem(key);
      return null;
    }
    if (saved.operation !== operation) {
      this.storage.removeItem(key);
      return null;
    }
    try {
      const job = await this.transport.get(context.uploadSessionId, saved.faceQualityJobId, createTraceId(), signal);
      validateJob(job, context, operation);
      return this.wait(context, job, signal, onProgress);
    } catch (error) {
      if (isExpiredOrMissing(error)) {
        this.storage.removeItem(key);
        return null;
      }
      throw error;
    }
  }

  async createCandidates(
    context: NativeFaceRemoteContext,
    options: { fidelityPermyriad: number; candidateCount: 2 | 3 },
    signal: AbortSignal,
    onProgress?: (job: FaceQualityJobView) => void,
  ): Promise<FaceQualityJobView> {
    validateContext(context);
    if (!Number.isInteger(options.fidelityPermyriad) || options.fidelityPermyriad < 0
      || options.fidelityPermyriad > 10_000 || (options.candidateCount !== 2 && options.candidateCount !== 3)) {
      throw new Error("Choose two or three candidates with a valid native fidelity setting.");
    }
    const intent: FaceQualityCandidateRequest = {
      contract_version: CONTRACT_VERSION,
      base_image_quality_request_id: context.baseImageQualityRequestId,
      source_sha256: context.sourceSha256,
      base_output_sha256: context.baseOutputSha256,
      allow_reconstructed_face_detail: true,
      fidelity_permyriad: options.fidelityPermyriad,
      candidate_count: options.candidateCount,
    };
    const created = await this.transport.createCandidates(
      context.uploadSessionId,
      intent,
      createTraceId(),
      await idempotencyKey("face-candidates", intent),
      signal,
    );
    validateJob(created.value, context, "candidates");
    return this.wait(context, created.value, signal, onProgress);
  }

  async createComposition(
    context: NativeFaceRemoteContext,
    candidateRequestId: string,
    candidateSha256: string,
    signal: AbortSignal,
    onProgress?: (job: FaceQualityJobView) => void,
  ): Promise<FaceQualityJobView> {
    validateContext(context);
    if (!IDENTIFIER.test(candidateRequestId) || !SHA256.test(candidateSha256)) {
      throw new Error("Review one exact native face candidate before composition.");
    }
    const intent: FaceQualityCompositionIntent = {
      contract_version: CONTRACT_VERSION,
      candidate_request_id: candidateRequestId,
      candidate_sha256: candidateSha256,
      source_sha256: context.sourceSha256,
      base_output_sha256: context.baseOutputSha256,
      allow_reconstructed_face_detail: true,
      acknowledged_possible_identity_change: true,
    };
    const created = await this.transport.createComposition(
      context.uploadSessionId,
      intent,
      createTraceId(),
      await idempotencyKey("face-compose", intent),
      signal,
    );
    validateJob(created.value, context, "compose");
    return this.wait(context, created.value, signal, onProgress);
  }

  async retry(
    context: NativeFaceRemoteContext,
    jobId: string,
    signal: AbortSignal,
    onProgress?: (job: FaceQualityJobView) => void,
  ): Promise<FaceQualityJobView> {
    validateContext(context);
    if (!IDENTIFIER.test(jobId)) throw new Error("The native face job identifier is invalid.");
    const replay = { jobId, sourceSha256: context.sourceSha256, baseOutputSha256: context.baseOutputSha256 };
    const response = await this.transport.retry(
      context.uploadSessionId,
      jobId,
      createTraceId(),
      await idempotencyKey("face-retry", replay),
      signal,
    );
    validateJob(response.value, context);
    return this.wait(context, response.value, signal, onProgress);
  }

  async cancel(context: NativeFaceRemoteContext, jobId: string, signal?: AbortSignal): Promise<FaceQualityJobView> {
    validateContext(context);
    if (!IDENTIFIER.test(jobId)) throw new Error("The native face job identifier is invalid.");
    const job = await this.transport.cancel(context.uploadSessionId, jobId, createTraceId(), signal);
    validateJob(job, context);
    if (job.state === "cancelled") this.clear(context, job.operation);
    else this.persist(context, job);
    return job;
  }

  downloadUrl(context: NativeFaceRemoteContext, job: FaceQualityJobView): string {
    validateContext(context);
    validateJob(job, context, "compose");
    if (job.state !== "succeeded" || !SHA256.test(job.output_sha256 ?? "")) {
      throw new Error("The reviewed native face result is not ready to download.");
    }
    return this.transport.downloadUrl(context.uploadSessionId, job.face_quality_job_id);
  }

  async candidateArtifact(
    context: NativeFaceRemoteContext,
    job: FaceQualityJobView,
    candidateId: string,
    kind: "pixels" | "mask",
    signal?: AbortSignal,
  ): Promise<NativeFaceCandidateArtifact> {
    validateContext(context);
    validateJob(job, context, "candidates");
    if (job.state !== "succeeded") throw new Error("Face candidates are not ready for review.");
    const candidate = job.candidates.find((value) => value.candidate_id === candidateId);
    if (!candidate) throw new Error("The selected face candidate is not part of this completed job.");
    const artifact = await this.transport.candidateArtifact(
      context.uploadSessionId, job.face_quality_job_id, candidateId, kind, signal,
    );
    const expectedSha256 = kind === "pixels" ? candidate.pixels_sha256 : candidate.mask_sha256;
    const expectedBytes = candidate.region.width * candidate.region.height
      * (kind === "pixels" ? 4 * (candidate.context.bit_depth === 16 ? 2 : 1) : 1);
    if (artifact.kind !== kind || artifact.width !== candidate.region.width || artifact.height !== candidate.region.height
      || artifact.bitDepth !== candidate.context.bit_depth || artifact.artifactSha256 !== expectedSha256
      || artifact.bytes.byteLength !== expectedBytes || await sha256(artifact.bytes) !== expectedSha256) {
      throw new Error("The downloaded face candidate does not match its reviewed metadata.");
    }
    return artifact;
  }

  clear(context: NativeFaceRemoteContext, operation?: FaceQualityJobView["operation"]): void {
    validateContext(context);
    if (operation) {
      this.storage.removeItem(storageKey(context, operation));
      return;
    }
    this.storage.removeItem(storageKey(context, "candidates"));
    this.storage.removeItem(storageKey(context, "compose"));
  }

  private persist(context: NativeFaceRemoteContext, job: FaceQualityJobView): void {
    this.storage.setItem(storageKey(context, job.operation), JSON.stringify(storedJob(job, context)));
  }

  private async wait(
    context: NativeFaceRemoteContext,
    initial: FaceQualityJobView,
    signal: AbortSignal,
    onProgress?: (job: FaceQualityJobView) => void,
  ): Promise<FaceQualityJobView> {
    let job = initial;
    while (true) {
      validateJob(job, context, initial.operation);
      if (Date.parse(job.expires_at) <= this.now()) {
        this.clear(context, job.operation);
        throw new Error("The private native face job expired. Generate new candidates from the unchanged enhanced image.");
      }
      this.persist(context, job);
      onProgress?.(job);
      if (TERMINAL.has(job.state)) {
        if (job.state !== "succeeded") this.clear(context, job.operation);
        return job;
      }
      await delay(this.pollMilliseconds, signal);
      try {
        job = await this.transport.get(context.uploadSessionId, job.face_quality_job_id, createTraceId(), signal);
      } catch (error) {
        if (isExpiredOrMissing(error)) this.clear(context, job.operation);
        throw error;
      }
    }
  }
}
