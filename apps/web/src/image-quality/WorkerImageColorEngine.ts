import type { ImageColorRecipe, ImageColorStatistics } from "./imageColor";
import type { PngColorMetadata } from "./pngMetadata";

interface LoadedColorSource { width: number; height: number }

export interface ImageColorResult {
  bytes: ArrayBuffer;
  width: number;
  height: number;
  outputSha256: string;
  statistics: ImageColorStatistics;
}

type WorkerSuccess =
  | { id: number; ok: true; type: "loaded"; width: number; height: number }
  | ({ id: number; ok: true; type: "rendered" } & ImageColorResult);
type WorkerResponse = WorkerSuccess | { id: number; ok: false; message: string };

export class WorkerImageColorEngine {
  private readonly worker = new Worker(new URL("./imageColor.worker.ts", import.meta.url), { type: "module" });
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
    this.worker.onerror = () => this.rejectAll(new Error("The colour-adjustment renderer stopped unexpectedly. Your verified base is unchanged."));
  }

  async load(source: Blob): Promise<LoadedColorSource> {
    const result = await this.request({ type: "load", source });
    if (result.type !== "loaded") throw new Error("The colour-adjustment renderer returned an unexpected response.");
    return { width: result.width, height: result.height };
  }

  async render(
    recipe: ImageColorRecipe,
    metadata: Omit<PngColorMetadata, "recipe" | "statistics">,
  ): Promise<ImageColorResult> {
    const result = await this.request({ type: "render", recipe, metadata });
    if (result.type !== "rendered") throw new Error("The colour-adjustment renderer returned an unexpected response.");
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
    this.rejectAll(new Error("The colour-adjustment renderer was closed."));
  }

  private request(
    message: { type: "load"; source: Blob }
      | { type: "render"; recipe: ImageColorRecipe; metadata: Omit<PngColorMetadata, "recipe" | "statistics"> },
  ): Promise<WorkerSuccess> {
    if (this.disposed) return Promise.reject(new Error("The colour-adjustment renderer is unavailable."));
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
