import type { ImageQualityAnalysis } from "./ImageQualityEngine";
import { enhancePixels, reconstructPixels } from "./imageQualityPipeline";

type WorkerRequest =
  | { id: number; type: "load"; source: Blob }
  | { id: number; type: "enhance"; strength: number };

type WorkerResponse =
  | { id: number; ok: true; type: "loaded"; width: number; height: number; mediaType: string }
  | { id: number; ok: true; type: "enhanced"; width: number; height: number; mediaType: "image/png"; bytes: ArrayBuffer; analysis: ImageQualityAnalysis }
  | { id: number; ok: false; message: string };

const workerScope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
};

const MAX_PIXELS = 80_000_000;
let sourcePixels: Uint8ClampedArray | null = null;
let sourceWidth = 0;
let sourceHeight = 0;
let sourceMediaType = "";

async function loadSource(source: Blob) {
  const filename = source instanceof File ? source.name.toLowerCase() : "";
  const inferredType = /\.jpe?g$/.test(filename)
    ? "image/jpeg"
    : filename.endsWith(".png")
      ? "image/png"
      : filename.endsWith(".webp")
        ? "image/webp"
        : "";
  const mediaType = source.type || inferredType;
  if (!["image/jpeg", "image/png", "image/webp"].includes(mediaType)) {
    throw new Error("Choose a JPEG, PNG or WebP image.");
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source);
  } catch {
    throw new Error("This image could not be decoded. Try a valid JPEG, PNG or WebP file.");
  }
  try {
    if (bitmap.width < 1 || bitmap.height < 1 || bitmap.width * bitmap.height > MAX_PIXELS) {
      throw new Error("This image is too large for safe local processing. Use an image up to 80 megapixels.");
    }
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Your browser could not prepare the image processor.");
    context.drawImage(bitmap, 0, 0);
    const decoded = context.getImageData(0, 0, bitmap.width, bitmap.height);
    sourcePixels = decoded.data;
    sourceWidth = bitmap.width;
    sourceHeight = bitmap.height;
    sourceMediaType = mediaType;
    return { width: sourceWidth, height: sourceHeight, mediaType: sourceMediaType };
  } finally {
    bitmap.close();
  }
}

async function enhance(strength: number) {
  if (!sourcePixels) throw new Error("Choose an image before enhancing it.");
  const result = enhancePixels(sourcePixels, sourceWidth, sourceHeight, strength);
  const reconstructed = reconstructPixels(result.pixels, sourceWidth, sourceHeight);
  const canvas = new OffscreenCanvas(reconstructed.width, reconstructed.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Your browser could not create the enhanced image.");
  const outputPixels = new Uint8ClampedArray(reconstructed.pixels.length);
  outputPixels.set(reconstructed.pixels);
  context.putImageData(new ImageData(outputPixels, reconstructed.width, reconstructed.height), 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const bytes = await blob.arrayBuffer();
  return { bytes, width: reconstructed.width, height: reconstructed.height, analysis: result.analysis };
}

workerScope.onmessage = (event) => {
  const request = event.data;
  void (async () => {
    try {
      if (request.type === "load") {
        const loaded = await loadSource(request.source);
        workerScope.postMessage({ id: request.id, ok: true, type: "loaded", ...loaded });
        return;
      }
      const result = await enhance(request.strength);
      workerScope.postMessage(
        { id: request.id, ok: true, type: "enhanced", mediaType: "image/png", ...result },
        [result.bytes],
      );
    } catch (error) {
      workerScope.postMessage({
        id: request.id,
        ok: false,
        message: error instanceof Error ? error.message : "Image processing did not complete.",
      });
    }
  })();
};
