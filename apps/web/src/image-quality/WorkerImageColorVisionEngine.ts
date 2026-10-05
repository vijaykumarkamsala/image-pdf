import type { ImageColorVisionMode, ImageColorVisionStatistics } from "./imageColorVision";

export interface ImageColorVisionResult {
  bytes: ArrayBuffer;
  width: number;
  height: number;
  outputSha256: string;
  statistics: ImageColorVisionStatistics;
}

type WorkerResponse = ({
  id: number;
  ok: true;
  type: "rendered";
} & ImageColorVisionResult) | { id: number; ok: false; message: string };

export class WorkerImageColorVisionEngine {
  private readonly worker = new Worker(new URL("./imageColorVision.worker.ts", import.meta.url), { type: "module" });
  private sequence = 0;
  private disposed = false;
  private readonly pending = new Map<number, {
    resolve: (value: ImageColorVisionResult) => void;
    reject: (reason: Error) => void;
  }>();

  constructor() {
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const request = this.pending.get(event.data.id);
      if (!request) return;
      this.pending.delete(event.data.id);
      if (!event.data.ok) request.reject(new Error(event.data.message));
      else request.resolve({
        bytes: event.data.bytes,
        width: event.data.width,
        height: event.data.height,
        outputSha256: event.data.outputSha256,
        statistics: event.data.statistics,
      });
    };
    this.worker.onerror = () => this.rejectAll(
      new Error("The colour-vision preview renderer stopped unexpectedly. The verified image is unchanged."),
    );
  }

  render(source: Blob, mode: ImageColorVisionMode, width: number, height: number): Promise<ImageColorVisionResult> {
    if (this.disposed) return Promise.reject(new Error("The colour-vision preview renderer is unavailable."));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type: "render", source, mode, expectedWidth: width, expectedHeight: height });
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
    this.rejectAll(new Error("The colour-vision preview renderer was closed."));
  }

  private rejectAll(error: Error) {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}
