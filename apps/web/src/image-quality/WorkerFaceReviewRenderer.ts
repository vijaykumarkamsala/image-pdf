import type {
  FaceDetailCandidate, FaceDetailContext, FaceDetailRegion, FaceDetailReview,
  FaceModelRelease, FaceRecreateEvidence,
} from "./faceDetailRestoration.ts";
import type { PngOutputMetadata } from "./pngMetadata.ts";

export interface FaceReviewInput {
  original: Blob;
  base: Blob;
  context: FaceDetailContext;
  metadata: PngOutputMetadata;
}

export interface FaceReviewPreviews {
  original: Blob;
  base: Blob;
  candidates: Array<{ candidateSha256: string; bytes: Blob; regionMap: Blob }>;
  region: FaceDetailRegion;
  sourceRegion: FaceDetailRegion;
}

export interface FaceReviewOutput {
  bytes: ArrayBuffer;
  outputSha256: string;
  evidence: FaceRecreateEvidence;
}

export interface FaceReviewRenderer {
  prepare(input: FaceReviewInput, release: Readonly<FaceModelRelease>, signal: AbortSignal): Promise<Uint8ClampedArray>;
  preview(candidates: Array<FaceDetailCandidate & { candidateSha256: string }>, signal: AbortSignal): Promise<FaceReviewPreviews>;
  apply(candidate: FaceDetailCandidate, review: FaceDetailReview, signal: AbortSignal): Promise<FaceReviewOutput>;
  dispose(): void;
}

export type FaceReviewCommand =
  | { type: "prepare"; input: FaceReviewInput; release: FaceModelRelease }
  | { type: "preview"; candidates: Array<FaceDetailCandidate & { candidateSha256: string }> }
  | { type: "apply"; candidate: FaceDetailCandidate; review: FaceDetailReview };

export type FaceReviewReply =
  | { type: "prepared"; sourcePixels: Uint8ClampedArray }
  | { type: "previews"; previews: FaceReviewPreviews }
  | { type: "applied"; output: FaceReviewOutput };

/** Decode/region rendering/full PNG composition all stay off the main UI thread. */
export class WorkerFaceReviewRenderer implements FaceReviewRenderer {
  private readonly worker = new Worker(new URL("./faceReview.worker.ts", import.meta.url), { type: "module" });
  private sequence = 0;
  private disposed = false;
  private pending = new Map<number, { resolve: (reply: FaceReviewReply) => void; reject: (error: Error) => void }>();

  constructor() {
    this.worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; reply?: FaceReviewReply; message?: string }>) => {
      const pending = this.pending.get(event.data.id);
      if (!pending) return;
      this.pending.delete(event.data.id);
      if (event.data.ok && event.data.reply) pending.resolve(event.data.reply);
      else pending.reject(new Error(event.data.message ?? "Face rendering failed. Your previous result is unchanged."));
    };
    this.worker.onerror = () => this.dispose();
  }

  private async request(command: FaceReviewCommand, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.disposed) throw new Error("The face renderer has closed.");
    const id = ++this.sequence;
    const cancel = () => this.dispose();
    signal.addEventListener("abort", cancel, { once: true });
    try {
      return await new Promise<FaceReviewReply>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        try { this.worker.postMessage({ id, ...command }); }
        catch (error) { this.pending.delete(id); reject(error); }
      });
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  async prepare(input: FaceReviewInput, release: Readonly<FaceModelRelease>, signal: AbortSignal) {
    const reply = await this.request({ type: "prepare", input, release: { ...release } }, signal);
    if (reply.type !== "prepared") throw new Error("Unexpected face preparation response.");
    return reply.sourcePixels;
  }

  async preview(candidates: Array<FaceDetailCandidate & { candidateSha256: string }>, signal: AbortSignal) {
    const reply = await this.request({ type: "preview", candidates }, signal);
    if (reply.type !== "previews") throw new Error("Unexpected face comparison response.");
    return reply.previews;
  }

  async apply(candidate: FaceDetailCandidate, review: FaceDetailReview, signal: AbortSignal) {
    const reply = await this.request({ type: "apply", candidate, review }, signal);
    if (reply.type !== "applied") throw new Error("Unexpected face composition response.");
    return reply.output;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(new DOMException("Face rendering stopped. Original and previous result are unchanged.", "AbortError"));
    this.pending.clear();
  }
}
