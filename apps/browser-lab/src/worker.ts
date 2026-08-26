/**
 * Image operations, off the main thread.
 *
 * POC-005 requires work to run off the main UI thread "where appropriate", and
 * the acceptance criterion is that the UI stays responsive. That is not a matter
 * of degree in a browser: any decode or resize of a real photograph on the main
 * thread blocks paint and input for its whole duration.
 *
 * So everything here runs in a Worker, using `createImageBitmap` and
 * `OffscreenCanvas` so no DOM element is ever touched. The main thread's only job
 * is to hand over a Blob and receive a result.
 *
 * Operations mirror the server-side standard baseline (POC-004) so results are
 * comparable. They are non-generative: resize, crop, rotate, flip. The browser
 * never performs AI work (D-019).
 */

export type WorkerOperation =
  | { kind: "decode" }
  | { kind: "resize"; width: number; height: number }
  | { kind: "crop"; x: number; y: number; width: number; height: number }
  | { kind: "rotate"; degrees: 90 | 180 | 270 }
  | { kind: "flip"; axis: "horizontal" | "vertical" };

export interface WorkerRequest {
  id: string;
  blob: Blob;
  operation: WorkerOperation;
  /** Output encoding. PNG is lossless so timings are comparable across runs. */
  outputType: "image/png" | "image/jpeg";
  quality: number;
}

export interface WorkerPhases {
  decodeNs: number;
  operationNs: number;
  encodeNs: number;
  totalNs: number;
}

export interface WorkerSuccess {
  id: string;
  ok: true;
  width: number;
  height: number;
  outputBytes: number;
  outputSha256: string;
  phases: WorkerPhases;
}

export interface WorkerFailure {
  id: string;
  ok: false;
  /** Mirrors the server's normalised failure codes so reports stay comparable. */
  code: string;
  message: string;
}

export type WorkerResponse = WorkerSuccess | WorkerFailure;

/** performance.now() is milliseconds with fractional precision; the contract wants integer ns. */
const nowNs = (): number => Math.round(performance.now() * 1e6);

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function targetSize(
  bitmap: ImageBitmap,
  operation: WorkerOperation,
): { width: number; height: number } {
  switch (operation.kind) {
    case "resize":
      return { width: operation.width, height: operation.height };
    case "crop":
      return { width: operation.width, height: operation.height };
    case "rotate":
      return operation.degrees === 180
        ? { width: bitmap.width, height: bitmap.height }
        : { width: bitmap.height, height: bitmap.width };
    default:
      return { width: bitmap.width, height: bitmap.height };
  }
}

function draw(
  context: OffscreenCanvasRenderingContext2D,
  bitmap: ImageBitmap,
  operation: WorkerOperation,
  size: { width: number; height: number },
): void {
  context.save();
  switch (operation.kind) {
    case "crop":
      context.drawImage(
        bitmap,
        operation.x,
        operation.y,
        operation.width,
        operation.height,
        0,
        0,
        operation.width,
        operation.height,
      );
      break;
    case "rotate": {
      context.translate(size.width / 2, size.height / 2);
      context.rotate((operation.degrees * Math.PI) / 180);
      context.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
      break;
    }
    case "flip": {
      const horizontal = operation.axis === "horizontal";
      context.translate(horizontal ? size.width : 0, horizontal ? 0 : size.height);
      context.scale(horizontal ? -1 : 1, horizontal ? 1 : -1);
      context.drawImage(bitmap, 0, 0);
      break;
    }
    default:
      context.drawImage(bitmap, 0, 0, size.width, size.height);
  }
  context.restore();
}

export async function runOperation(request: WorkerRequest): Promise<WorkerResponse> {
  const started = nowNs();
  let bitmap: ImageBitmap | null = null;

  try {
    bitmap = await createImageBitmap(request.blob);
    const decoded = nowNs();

    const size = targetSize(bitmap, request.operation);
    const canvas = new OffscreenCanvas(size.width, size.height);
    const context = canvas.getContext("2d");
    if (!context) {
      return {
        id: request.id,
        ok: false,
        code: "PROCESSOR.UNAVAILABLE",
        message: "a 2D context could not be obtained from OffscreenCanvas",
      };
    }

    // Match the server's resampling intent as closely as the platform allows.
    // Canvas gives no choice of kernel, which is itself a finding: browser and
    // server output will differ, so browser output stays a preview.
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";

    draw(context, bitmap, request.operation, size);
    const operated = nowNs();

    const outputBlob = await canvas.convertToBlob({
      type: request.outputType,
      quality: request.quality / 100,
    });
    const buffer = await outputBlob.arrayBuffer();
    const finished = nowNs();

    return {
      id: request.id,
      ok: true,
      width: size.width,
      height: size.height,
      outputBytes: buffer.byteLength,
      outputSha256: await sha256Hex(buffer),
      phases: {
        decodeNs: decoded - started,
        operationNs: operated - decoded,
        encodeNs: finished - operated,
        totalNs: finished - started,
      },
    };
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      code: "PROCESSOR.INTERNAL_ERROR",
      message: error instanceof Error ? `${error.name}: ${error.message}` : "unknown error",
    };
  } finally {
    // ImageBitmap holds decoded pixels outside the JS heap; without this the
    // memory is only reclaimed at GC, which skews the next measurement.
    bitmap?.close();
  }
}

// Worker entry point. Guarded so the module can also be imported in Node for
// type-checking and for testing the pure helpers.
if (typeof self !== "undefined" && typeof (self as unknown as { postMessage?: unknown }).postMessage === "function") {
  self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
    void runOperation(event.data).then((response) => {
      (self as unknown as { postMessage: (m: WorkerResponse) => void }).postMessage(response);
    });
  });
}
