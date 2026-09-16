import {
  faceModelBlockers, validateFaceRestorationRequest, type FaceDetailCandidate,
  type FaceModelRelease, type FaceRestorationEngine, type FaceRestorationRequest,
} from "./faceDetailRestoration.ts";
import type { FaceInferenceAssets } from "./faceRestorationAssets.ts";

export type FaceInferenceCommand = { id: number; request: FaceRestorationRequest; assets?: FaceInferenceAssets; release: FaceModelRelease };

/** No runtime route registers this engine. Heavy work and model integrity checks stay in its worker. */
export class WorkerFaceRestorationEngine implements FaceRestorationEngine {
  readonly release: Readonly<FaceModelRelease>;
  private assets: FaceInferenceAssets;
  private worker: Worker | null = null;
  private disposed = false;
  private sequence = 0;
  private pending: { id: number; resolve(value: FaceDetailCandidate[]): void; reject(error: Error): void } | null = null;

  constructor(release: Readonly<FaceModelRelease>, assets: FaceInferenceAssets) {
    const blockers = faceModelBlockers(release);
    if (blockers.length) throw new Error(`Face detail is unavailable. ${blockers.join(" ")}`);
    this.release = Object.freeze({ ...release });
    this.assets = { ...assets, manifest: structuredClone(assets.manifest) };
  }

  async generateCandidates(request: FaceRestorationRequest, signal: AbortSignal) {
    validateFaceRestorationRequest(request, this.release); signal.throwIfAborted();
    if (this.disposed) throw new Error("The face restoration engine has closed.");
    if (this.pending) throw new Error("Finish or cancel the current face candidates first.");
    const isNew = !this.worker;
    if (!this.worker) {
      this.worker = new Worker(new URL("./faceRestoration.worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (event: MessageEvent<{ id: number; candidates?: FaceDetailCandidate[]; message?: string }>) => {
        if (event.data.id !== this.pending?.id) return;
        const pending = this.pending; this.pending = null;
        if (event.data.candidates) pending.resolve(event.data.candidates);
        else { this.dispose(); pending.reject(new Error(event.data.message ?? "Face inference failed. Your original is unchanged.")); }
      };
      this.worker.onerror = () => this.dispose();
    }
    const id = ++this.sequence, cancel = () => this.dispose();
    signal.addEventListener("abort", cancel, { once: true });
    try {
      return await new Promise<FaceDetailCandidate[]>((resolve, reject) => {
        this.pending = { id, resolve, reject };
        const snapshot = { ...request, context: { ...request.context }, consent: { ...request.consent }, sourcePixels: request.sourcePixels.slice() };
        try { this.worker!.postMessage({ id, request: snapshot, release: this.release,
          ...(isNew ? { assets: this.assets } : {}) } satisfies FaceInferenceCommand, [snapshot.sourcePixels.buffer]); }
        catch (error) { this.dispose(); reject(error); }
      });
    } finally { signal.removeEventListener("abort", cancel); }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.worker?.terminate(); this.worker = null;
    this.pending?.reject(new DOMException("Face inference cancelled; your original and base result are unchanged.", "AbortError"));
    this.pending = null;
  }
}
