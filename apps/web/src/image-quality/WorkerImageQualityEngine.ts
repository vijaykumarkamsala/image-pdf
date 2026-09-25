import type {
  ImageQualityEngine,
  ImageQualityOperationOptions,
  ImageQualityProgress,
  ImageQualityResult,
  ImageQualitySource,
} from "./ImageQualityEngine";

type WorkerSuccess =
  | ({ id: number; ok: true; type: "loaded" } & ImageQualitySource)
  | ({ id: number; ok: true; type: "enhanced" } & ImageQualityResult);
type WorkerResponse = WorkerSuccess | { id: number; ok: false; message: string };
type WorkerMessage = WorkerResponse | { id: number; type: "progress"; progress: ImageQualityProgress };

export class WorkerImageQualityEngine implements ImageQualityEngine {
  private readonly worker: Worker;
  private sequence = 0;
  private disposed = false;
  private activeRequest: number | null = null;
  private readonly preferDeterministic: boolean;
  private readonly allowAnalysisSample: boolean;
  private readonly pending = new Map<number, {
    resolve: (value: WorkerSuccess) => void;
    reject: (reason: Error) => void;
    onProgress?: (progress: ImageQualityProgress) => void;
  }>();

  constructor(options: { preferDeterministic?: boolean; allowAnalysisSample?: boolean } = {}) {
    this.preferDeterministic = options.preferDeterministic ?? false;
    this.allowAnalysisSample = options.allowAnalysisSample ?? false;
    const useLocalResearchWorker = import.meta.env.DEV
      && import.meta.env.VITE_IMAGE_QUALITY_RESEARCH === "1";
    this.worker = useLocalResearchWorker
      ? new Worker("/src/image-quality/imageQuality.worker.ts", { type: "module" })
      : new Worker(new URL("./imageQuality.production.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const request = this.pending.get(event.data.id);
      if (!request) return;
      if ("progress" in event.data) {
        request.onProgress?.(event.data.progress);
        return;
      }
      this.pending.delete(event.data.id);
      if (this.activeRequest === event.data.id) this.activeRequest = null;
      if (!event.data.ok) request.reject(new Error(event.data.message));
      else request.resolve(event.data);
    };
    this.worker.onerror = () => {
      this.rejectAll(new Error("The local image processor stopped unexpectedly. Your original is still available."));
    };
  }

  async load(source: Blob, options?: ImageQualityOperationOptions): Promise<ImageQualitySource> {
    const response = await this.request({ type: "load", source }, options);
    if (response.type !== "loaded") throw new Error("The image processor returned an unexpected response.");
    return {
      width: response.width,
      height: response.height,
      mediaType: response.mediaType,
      byteSize: response.byteSize,
      sourceSha256: response.sourceSha256,
      inspection: response.inspection,
    };
  }

  async enhance(strength: number, options?: ImageQualityOperationOptions): Promise<ImageQualityResult> {
    const response = await this.request({
      type: "enhance",
      strength,
      outputScale: options?.outputScale ?? 2,
      preferDeterministic: this.preferDeterministic,
    }, options);
    if (response.type !== "enhanced") throw new Error("The image processor returned an unexpected response.");
    return {
      bytes: response.bytes,
      mediaType: response.mediaType,
      width: response.width,
      height: response.height,
      analysis: response.analysis,
      engine: response.engine,
      route: response.route,
      sourceSha256: response.sourceSha256,
      outputSha256: response.outputSha256,
      strength: response.strength,
      scale: response.scale,
      processingTimeMs: response.processingTimeMs,
      contentClass: response.contentClass,
      classificationConfidence: response.classificationConfidence,
      model: response.model,
      warnings: response.warnings,
      fidelity: response.fidelity,
      analysisProxy: response.analysisProxy,
    };
  }

  cancel(): void {
    if (this.disposed || this.activeRequest === null) return;
    this.worker.terminate();
    this.disposed = true;
    this.activeRequest = null;
    this.rejectAll(new DOMException("Enhancement cancelled.", "AbortError"));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
    this.rejectAll(new Error("The image processor was closed."));
  }

  private request(
    message: { type: "load"; source: Blob; allowAnalysisSample?: boolean }
      | { type: "enhance"; strength: number; outputScale: 2 | 4; preferDeterministic: boolean },
    options?: ImageQualityOperationOptions,
  ): Promise<WorkerSuccess> {
    if (this.disposed) return Promise.reject(new Error("The image processor is unavailable."));
    const id = ++this.sequence;
    this.activeRequest = id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress: options?.onProgress });
      this.worker.postMessage(
        message.type === "load"
          ? { ...message, id, allowAnalysisSample: this.allowAnalysisSample }
          : { id, ...message },
      );
    });
  }

  private rejectAll(error: Error) {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}
