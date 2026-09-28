import type { ImageGeometryRecipe } from "./imageGeometry";
import type { PngGeometryMetadata } from "./pngMetadata";

interface LoadedGeometrySource {
  width: number;
  height: number;
}

export interface ImageGeometryResult {
  bytes: ArrayBuffer;
  width: number;
  height: number;
  outputSha256: string;
}

type WorkerSuccess =
  | { id: number; ok: true; type: "loaded"; width: number; height: number }
  | ({ id: number; ok: true; type: "rendered" } & ImageGeometryResult);
type WorkerResponse = WorkerSuccess | { id: number; ok: false; message: string };

export class WorkerImageGeometryEngine {
  private readonly worker = new Worker(new URL("./imageGeometry.worker.ts", import.meta.url), { type: "module" });
  private sequence = 0;
  private disposed = false;
  private readonly pending = new Map<number, {
    resolve: (value: WorkerSuccess) => void;
    reject: (reason: Error) => void;
  }>();

  constructor() {
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const request = this.pending.get(event.data.id);
      if (!request) return;
      this.pending.delete(event.data.id);
      if (!event.data.ok) request.reject(new Error(event.data.message));
      else request.resolve(event.data);
    };
    this.worker.onerror = () => this.rejectAll(new Error("The geometry renderer stopped unexpectedly. Your original is unchanged."));
  }

  async load(source: Blob): Promise<LoadedGeometrySource> {
    const result = await this.request({ type: "load", source });
    if (result.type !== "loaded") throw new Error("The geometry renderer returned an unexpected response.");
    return { width: result.width, height: result.height };
  }

  async render(recipe: ImageGeometryRecipe, metadata: PngGeometryMetadata): Promise<ImageGeometryResult> {
    const result = await this.request({ type: "render", recipe, metadata });
    if (result.type !== "rendered") throw new Error("The geometry renderer returned an unexpected response.");
    return {
      bytes: result.bytes,
      width: result.width,
      height: result.height,
      outputSha256: result.outputSha256,
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
    this.rejectAll(new Error("The geometry renderer was closed."));
  }

  private request(
    message: { type: "load"; source: Blob } | { type: "render"; recipe: ImageGeometryRecipe; metadata: PngGeometryMetadata },
  ): Promise<WorkerSuccess> {
    if (this.disposed) return Promise.reject(new Error("The geometry renderer is unavailable."));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, ...message });
    });
  }

  private rejectAll(error: Error) {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}
