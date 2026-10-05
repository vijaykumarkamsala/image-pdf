import type {
  ImageExportEvidence,
  ImageExportSettings,
} from "./imageExport";

export interface ImageExportResult extends ImageExportEvidence {
  bytes: ArrayBuffer;
}

type WorkerResponse = ({
  id: number;
  ok: true;
  type: "exported";
} & ImageExportResult) | { id: number; ok: false; message: string };

export class WorkerImageExportEngine {
  private readonly worker = new Worker(new URL("./imageExport.worker.ts", import.meta.url), { type: "module" });
  private sequence = 0;
  private disposed = false;
  private readonly pending = new Map<number, {
    resolve: (value: ImageExportResult) => void;
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
        mediaType: event.data.mediaType,
        byteSize: event.data.byteSize,
        outputSha256: event.data.outputSha256,
        transparentPixels: event.data.transparentPixels,
        transparencyFlattened: event.data.transparencyFlattened,
      });
    };
    this.worker.onerror = () => this.rejectAll(
      new Error("The export renderer stopped unexpectedly. The verified image is unchanged."),
    );
  }

  render(
    source: Blob,
    expectedSourceSha256: string,
    settings: ImageExportSettings,
    expectedWidth: number,
    expectedHeight: number,
  ): Promise<ImageExportResult> {
    if (this.disposed) return Promise.reject(new Error("The export renderer is unavailable."));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({
        id,
        type: "export",
        source,
        expectedSourceSha256,
        settings,
        expectedWidth,
        expectedHeight,
      });
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
    this.rejectAll(new Error("The export renderer was closed."));
  }

  private rejectAll(error: Error) {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}
