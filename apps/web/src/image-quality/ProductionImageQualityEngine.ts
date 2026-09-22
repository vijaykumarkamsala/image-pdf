import { api, createTraceId, type ImageQualityRequestRecord } from "../boundaries/apiClient";
import type {
  ImageQualityEngine,
  ImageQualityOperationOptions,
  ImageQualityProgress,
  ImageQualityResult,
  ImageQualitySource,
} from "./ImageQualityEngine";
import { sha256Bytes } from "./sha256";
import { WorkerImageQualityEngine } from "./WorkerImageQualityEngine";

const READY_UPLOAD_STATES = new Set(["ready", "rejected", "cancelled", "expired"]);
const TERMINAL_REQUEST_STATES = new Set(["succeeded", "failed", "cancelled"]);
const VERIFIED_BROWSER_BYTE_LIMIT = 256 * 1024 * 1024;

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Enhancement cancelled.", "AbortError"));
    const timer = globalThis.setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      globalThis.clearTimeout(timer);
      reject(new DOMException("Enhancement cancelled.", "AbortError"));
    }, { once: true });
  });
}

function progress(
  options: ImageQualityOperationOptions | undefined,
  phase: ImageQualityProgress["phase"],
  completed: number,
  total: number,
  message: string,
) {
  options?.onProgress?.({ phase, completed, total, message });
}

/**
 * Production Restore boundary. Local inspection/classification remains inside a
 * Web Worker; photographic reconstruction is uploaded directly to private
 * storage and executed by the durable native Linux worker.
 */
export class ProductionImageQualityEngine implements ImageQualityEngine {
  private readonly local = new WorkerImageQualityEngine({ allowAnalysisSample: true });
  private source: File | null = null;
  private sourceFacts: ImageQualitySource | null = null;
  private preparation: Promise<string> | null = null;
  private aborter = new AbortController();
  private disposed = false;

  async load(source: Blob, options?: ImageQualityOperationOptions): Promise<ImageQualitySource> {
    if (this.disposed) throw new Error("The image processor is unavailable.");
    this.aborter = new AbortController();
    this.source = source instanceof File
      ? source
      : new File([source], "image-quality-source", { type: source.type });
    const preparation = this.prepareUpload(this.source, this.aborter.signal, options);
    // Attach an observer immediately so a customer who leaves before pressing
    // Enhance never causes an unhandled background-upload rejection.
    void preparation.catch(() => undefined);
    this.preparation = preparation;
    try {
      this.sourceFacts = await this.local.load(source, options);
      return this.sourceFacts;
    } catch (error) {
      this.aborter.abort();
      throw error;
    }
  }

  async enhance(strength: number, options?: ImageQualityOperationOptions): Promise<ImageQualityResult> {
    if (this.disposed || !this.source || !this.sourceFacts || !this.preparation) {
      throw new Error("Choose and prepare an image before enhancing it.");
    }
    const started = performance.now();
    // This protected local pass is also the content classifier. Flat graphics
    // must never be sent through a perceptual model that can repaint geometry.
    const protectedResult = await this.local.enhance(strength, options);
    if (protectedResult.contentClass === "flat-graphic" && !protectedResult.analysisProxy) {
      return protectedResult;
    }

    progress(options, "model", 0, 100, "Securing the immutable source for production Restore…");
    const uploadSessionId = await this.preparation;
    const traceId = createTraceId();
    const created = await api.createImageQualityRequest(
      uploadSessionId,
      protectedResult.contentClass === "photograph"
        ? "photo"
        : protectedResult.contentClass,
      strength,
      traceId,
      `quality-${this.sourceFacts.sourceSha256}-${strength}`,
    );
    const completed = await this.waitForResult(created.image_quality_request, traceId, options);
    if (!completed.output) throw new Error("The production worker finished without a verified output.");
    const browserVerifiable = completed.output.byte_size <= VERIFIED_BROWSER_BYTE_LIMIT;
    const bytes = browserVerifiable
      ? await api.imageQualityDownload(completed.image_quality_request_id)
      : null;
    if (bytes && bytes.byteLength !== completed.output.byte_size) {
      throw new Error("The downloaded result did not match its recorded byte count.");
    }
    const outputSha256 = bytes
      ? await sha256Bytes(new Uint8Array(bytes))
      : completed.output.sha256;
    if (outputSha256 !== completed.output.sha256) {
      throw new Error("The downloaded result failed its integrity check.");
    }
    const scaleValue = completed.output.width / this.sourceFacts.width;
    const scale: 1 | 2 | 4 = scaleValue >= 3 ? 4 : scaleValue >= 1.5 ? 2 : 1;
    return {
      bytes,
      ...(browserVerifiable ? {} : {
        remoteViewUrl: api.imageQualityViewUrl(completed.image_quality_request_id),
        remoteDownloadUrl: api.imageQualityDownloadUrl(completed.image_quality_request_id),
      }),
      mediaType: "image/png",
      width: completed.output.width,
      height: completed.output.height,
      analysis: protectedResult.analysis,
      engine: `${completed.output.model.id} · native worker`,
      route: "durable-native-production-restore",
      sourceSha256: this.sourceFacts.sourceSha256,
      outputSha256,
      strength,
      scale,
      processingTimeMs: Math.round(performance.now() - started),
      contentClass: protectedResult.contentClass,
      classificationConfidence: protectedResult.classificationConfidence,
      model: {
        id: completed.output.model.id,
        version: completed.output.model.version,
        sha256: completed.output.model.sha256,
        usage: completed.output.model.deterministic
          ? "deterministic"
          : "production-restore",
      },
      warnings: [
        "Restore processing can reconstruct plausible texture; compare important details against the immutable original.",
        ...(completed.output.frame_count > 1
          ? [`All ${completed.output.frame_count} animation frames were processed and retained.`]
          : []),
        ...(completed.output.bit_depth > 8
          ? [`The result preserves ${completed.output.bit_depth}-bit channel precision.`]
          : []),
        `Colour handling: ${completed.output.colour_policy}.`,
        ...(completed.output.dynamic_range?.startsWith("hdr-")
          ? [`HDR signalling (${completed.output.dynamic_range}) remains attached to the processed pixels.`]
          : []),
        ...(!browserVerifiable
          ? ["This large result is streamed from private storage; its recorded digest was verified by the production worker."]
          : []),
      ],
      fidelity: {
        lowTextureMeanRgbShift: completed.output.fidelity.low_texture_mean_rgb_shift,
        highDriftFraction: completed.output.fidelity.high_drift_fraction,
        alphaMismatchFraction: completed.output.fidelity.alpha_mismatch_fraction,
        overallMeanRgbDifference: completed.output.fidelity.overall_mean_rgb_difference,
        passed: completed.output.fidelity.passed,
      },
      remoteContext: {
        uploadSessionId,
        imageQualityRequestId: completed.image_quality_request_id,
      },
    };
  }

  cancel(): void {
    this.aborter.abort();
    this.local.cancel();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.aborter.abort();
    this.local.dispose();
  }

  private async prepareUpload(
    file: File,
    signal: AbortSignal,
    options?: ImageQualityOperationOptions,
  ): Promise<string> {
    await api.createGuestSession();
    if (signal.aborted) throw new DOMException("Enhancement cancelled.", "AbortError");
    const traceId = createTraceId();
    const created = await api.createGuestUploadSession(file, file.type, traceId);
    await api.transferFile(
      created.authorization,
      file,
      0,
      (completed) => progress(
        options,
        "upload",
        completed,
        file.size,
        "Uploading the immutable source directly to private cloud storage…",
      ),
      signal,
    );
    const finalised = await api.finaliseUpload(created.upload_session.upload_session_id, traceId);
    let state = finalised.upload_session.state;
    while (!READY_UPLOAD_STATES.has(state)) {
      progress(options, "inspect", 0, 1, "Safety-checking the uploaded source…");
      await delay(500, signal);
      state = (await api.uploadStatus(created.upload_session.upload_session_id, traceId)).upload_session.state;
    }
    if (state !== "ready") {
      throw new Error("The source did not pass private upload inspection. Your local original is unchanged.");
    }
    return created.upload_session.upload_session_id;
  }

  private async waitForResult(
    initial: ImageQualityRequestRecord,
    traceId: string,
    options?: ImageQualityOperationOptions,
  ): Promise<ImageQualityRequestRecord> {
    let current = initial;
    while (!TERMINAL_REQUEST_STATES.has(current.state)) {
      progress(
        options,
        "model",
        current.progress_percent,
        100,
        `Production Restore is ${current.state.replaceAll("_", " ")} · ${current.progress_percent}%`,
      );
      await delay(800, this.aborter.signal);
      current = (await api.imageQualityStatus(current.image_quality_request_id, traceId)).image_quality_request;
    }
    if (current.state !== "succeeded") {
      throw new Error(current.failure?.message ?? "Production Restore did not complete. Your original is unchanged.");
    }
    progress(options, "encode", 100, 100, "Verifying the processed image bytes…");
    return current;
  }
}

export function createImageQualityEngine(options: { preferDeterministic?: boolean } = {}): ImageQualityEngine {
  const useCloud = import.meta.env.VITE_IMAGE_QUALITY_CLOUD === "1";
  return useCloud && !options.preferDeterministic
    ? new ProductionImageQualityEngine()
    : new WorkerImageQualityEngine(options);
}
