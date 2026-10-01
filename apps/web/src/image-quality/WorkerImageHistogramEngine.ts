import type { ImageHistogramSummary } from "./imageHistogram";

export interface ImageHistogramResult {
  width: number;
  height: number;
  summary: ImageHistogramSummary;
}

type WorkerResponse =
  | { id: number; ok: true; result: ImageHistogramResult }
  | { id: number; ok: false; message: string };

export class WorkerImageHistogramEngine {
  private readonly worker = new Worker(new URL("./imageHistogram.worker.ts", import.meta.url), { type: "module" });
  private sequence = 0;
  private disposed = false;
  private readonly pending = new Map<number, {
    resolve: (value: ImageHistogramResult) => void;
    reject: (reason: Error) => void;
  }>();

  constructor() {
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const request = this.pending.get(event.data.id);
      if (!request) return;
      this.pending.delete(event.data.id);
      if (!event.data.ok) request.reject(new Error(event.data.message));
      else request.resolve(event.data.result);
    };
    this.worker.onerror = () => this.rejectAll(new Error(
      "Histogram analysis stopped unexpectedly. Image pixels and downloads are unchanged.",
    ));
  }

  analyze(source: Blob, expectedWidth: number, expectedHeight: number): Promise<ImageHistogramResult> {
    if (this.disposed) return Promise.reject(new Error("Histogram analysis is unavailable."));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, source, expectedWidth, expectedHeight });
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
    this.rejectAll(new Error("Histogram analysis was closed."));
  }

  private rejectAll(error: Error) {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}

