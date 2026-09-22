import type { NativeFaceCandidateArtifact } from "./NativeFaceQualityClient";

export interface NativeFacePreview {
  patch: Blob;
  regionMap: Blob;
  candidateSha256: string;
}

export interface NativeFacePreviewer {
  render(pixels: NativeFaceCandidateArtifact, mask: NativeFaceCandidateArtifact, signal: AbortSignal): Promise<NativeFacePreview>;
  dispose(): void;
}

export class WorkerNativeFacePreview implements NativeFacePreviewer {
  private readonly worker = new Worker(new URL("./nativeFacePreview.worker.ts", import.meta.url), { type: "module" });
  private sequence = 0;
  private disposed = false;
  private pending = new Map<number, { resolve: (value: NativeFacePreview) => void; reject: (error: Error) => void }>();

  constructor() {
    this.worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; patch?: Blob; regionMap?: Blob; message?: string }>) => {
      const pending = this.pending.get(event.data.id);
      if (!pending) return;
      this.pending.delete(event.data.id);
      if (event.data.ok && event.data.patch && event.data.regionMap) {
        pending.resolve({ patch: event.data.patch, regionMap: event.data.regionMap, candidateSha256: "" });
      } else pending.reject(new Error(event.data.message ?? "Face comparison preparation failed."));
    };
    this.worker.onerror = () => this.dispose();
  }

  async render(pixels: NativeFaceCandidateArtifact, mask: NativeFaceCandidateArtifact, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.disposed) throw new Error("The native face preview worker has closed.");
    if (pixels.kind !== "pixels" || mask.kind !== "mask" || pixels.candidateSha256 !== mask.candidateSha256
      || pixels.width !== mask.width || pixels.height !== mask.height || pixels.bitDepth !== mask.bitDepth) {
      throw new Error("The native face patch and mask do not belong to the same candidate.");
    }
    const id = ++this.sequence; const candidateSha256 = pixels.candidateSha256;
    const cancel = () => this.dispose(); signal.addEventListener("abort", cancel, { once: true });
    try {
      const result = await new Promise<NativeFacePreview>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        try {
          this.worker.postMessage({ id, width: pixels.width, height: pixels.height, bitDepth: pixels.bitDepth,
            pixels: pixels.bytes, mask: mask.bytes }, [pixels.bytes, mask.bytes]);
        } catch (error) { this.pending.delete(id); reject(error); }
      });
      return { ...result, candidateSha256 };
    } finally { signal.removeEventListener("abort", cancel); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(
      new DOMException("Face comparison stopped. The original and enhanced image are unchanged.", "AbortError"),
    );
    this.pending.clear();
  }
}
