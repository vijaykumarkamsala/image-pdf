import type {
  ImageQualityEngine,
  ImageQualityResult,
  ImageQualitySource,
} from "./ImageQualityEngine";

type WorkerSuccess =
  | ({ id: number; ok: true; type: "loaded" } & ImageQualitySource)
  | ({ id: number; ok: true; type: "enhanced" } & ImageQualityResult);
type WorkerResponse = WorkerSuccess | { id: number; ok: false; message: string };

export class WorkerImageQualityEngine implements ImageQualityEngine {
  private readonly worker: Worker;
  private sequence = 0;
  private disposed = false;
  private readonly pending = new Map<number, {
    resolve: (value: WorkerSuccess) => void;
    reject: (reason: Error) => void;
  }>();

  constructor() {
    this.worker = new Worker(new URL("./imageQuality.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const request = this.pending.get(event.data.id);
      if (!request) return;
      this.pending.delete(event.data.id);
      if (!event.data.ok) request.reject(new Error(event.data.message));
      else request.resolve(event.data);
    };
    this.worker.onerror = () => {
      this.rejectAll(new Error("The local image processor stopped unexpectedly. Your original is still available."));
    };
  }

  async load(source: Blob): Promise<ImageQualitySource> {
    const response = await this.request({ type: "load", source });
    if (response.type !== "loaded") throw new Error("The image processor returned an unexpected response.");
    return { width: response.width, height: response.height, mediaType: response.mediaType };
  }

  async enhance(strength: number): Promise<ImageQualityResult> {
    const response = await this.request({ type: "enhance", strength });
    if (response.type !== "enhanced") throw new Error("The image processor returned an unexpected response.");
    return {
      bytes: response.bytes,
      mediaType: response.mediaType,
      width: response.width,
      height: response.height,
      analysis: response.analysis,
      engine: response.engine,
      route: response.route,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
    this.rejectAll(new Error("The image processor was closed."));
  }

  private request(message: { type: "load"; source: Blob } | { type: "enhance"; strength: number }): Promise<WorkerSuccess> {
    if (this.disposed) return Promise.reject(new Error("The image processor is unavailable."));
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
