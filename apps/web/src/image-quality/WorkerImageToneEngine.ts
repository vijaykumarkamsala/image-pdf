import type { ImageToneRecipe, ImageToneStatistics } from "./imageTone";
import type { PngToneMetadata } from "./pngMetadata";

interface LoadedToneSource {
  width: number;
  height: number;
}

export interface ImageToneResult {
  bytes: ArrayBuffer;
  width: number;
  height: number;
  outputSha256: string;
  statistics: ImageToneStatistics;
}

type WorkerSuccess =
  | { id: number; ok: true; type: "loaded"; width: number; height: number }
  | ({ id: number; ok: true; type: "rendered" } & ImageToneResult);
type WorkerResponse = WorkerSuccess | { id: number; ok: false; message: string };

export class WorkerImageToneEngine {
  private readonly worker = new Worker(new URL("./imageTone.worker.ts", import.meta.url), { type: "module" });
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
    this.worker.onerror = () => this.rejectAll(new Error("The light-adjustment renderer stopped unexpectedly. Your original is unchanged."));
  }

  async load(source: Blob): Promise<LoadedToneSource> {
    const result = await this.request({ type: "load", source });
    if (result.type !== "loaded") throw new Error("The light-adjustment renderer returned an unexpected response.");
    return { width: result.width, height: result.height };
  }

  async render(
    recipe: ImageToneRecipe,
    metadata: Omit<PngToneMetadata, "recipe" | "statistics">,
  ): Promise<ImageToneResult> {
    const result = await this.request({ type: "render", recipe, metadata });
    if (result.type !== "rendered") throw new Error("The light-adjustment renderer returned an unexpected response.");
    return {
      bytes: result.bytes,
      width: result.width,
      height: result.height,
      outputSha256: result.outputSha256,
      statistics: result.statistics,
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
    this.rejectAll(new Error("The light-adjustment renderer was closed."));
  }

  private request(
    message: { type: "load"; source: Blob }
      | { type: "render"; recipe: ImageToneRecipe; metadata: Omit<PngToneMetadata, "recipe" | "statistics"> },
  ): Promise<WorkerSuccess> {
    if (this.disposed) return Promise.reject(new Error("The light-adjustment renderer is unavailable."));
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
