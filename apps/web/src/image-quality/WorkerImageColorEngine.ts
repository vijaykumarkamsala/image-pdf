import type {
  ImageColorRecipe,
  ImageColorStatistics,
  ImagePointColorSample,
  ImageWhiteBalanceSuggestion,
} from "./imageColor";
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
  | ({ id: number; ok: true; type: "white-balance-sampled" } & ImageWhiteBalanceSuggestion)
  | ({ id: number; ok: true; type: "point-color-sampled" } & ImagePointColorSample)
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

  async sampleWhiteBalance(x: number, y: number): Promise<ImageWhiteBalanceSuggestion> {
    const result = await this.request({ type: "sample-white-balance", x, y });
    if (result.type !== "white-balance-sampled") {
      throw new Error("The colour-adjustment renderer returned an unexpected white-balance response.");
    }
    return {
      sourceX: result.sourceX,
      sourceY: result.sourceY,
      radius: result.radius,
      visiblePixels: result.visiblePixels,
      red: result.red,
      green: result.green,
      blue: result.blue,
      temperature: result.temperature,
      tint: result.tint,
      atLimit: result.atLimit,
    };
  }

  async samplePointColor(x: number, y: number): Promise<ImagePointColorSample> {
    const result = await this.request({ type: "sample-point-color", x, y });
    if (result.type !== "point-color-sampled") {
      throw new Error("The colour-adjustment renderer returned an unexpected point-colour response.");
    }
    return {
      sourceX: result.sourceX,
      sourceY: result.sourceY,
      radius: result.radius,
      visiblePixels: result.visiblePixels,
      red: result.red,
      green: result.green,
      blue: result.blue,
      hue: result.hue,
      saturation: result.saturation,
      lightness: result.lightness,
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
      | { type: "sample-white-balance"; x: number; y: number }
      | { type: "sample-point-color"; x: number; y: number }
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
