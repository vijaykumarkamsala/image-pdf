import type {
  ImageQualityAnalysis,
  ImageQualityProgress,
  ImageQualityResult,
  ImageQualitySource,
} from "./ImageQualityEngine";
import { inspectImageFile, type ImageFileInspection } from "./imageFileInspection";
import { measureCoordinateMatchedFidelity } from "./imageQualityFidelity";
import {
  applyTextureConstrainedCorrection,
  buildSourceTextureMap,
  classifyFlatGraphic,
  enhanceFlatGraphicPixels,
  enhancePixels,
  reconstructPixels,
} from "./imageQualityPipeline";
import { classifyImageContent, planRequestedScale, processingBudget, qualityNeed } from "./imageQualityPolicy";
import { pngOutputSha256, tagSrgbPng } from "./pngMetadata";
import { sha256Blob } from "./sha256";

type WorkerRequest =
  | { id: number; type: "load"; source: Blob; allowAnalysisSample?: boolean }
  | { id: number; type: "enhance"; strength: number; outputScale: 2 | 4; preferDeterministic: boolean }
  | { type: "cancel"; targetId: number };

type WorkerResponse =
  | ({ id: number; ok: true; type: "loaded" } & ImageQualitySource)
  | ({ id: number; ok: true; type: "enhanced" } & ImageQualityResult)
  | { id: number; type: "progress"; progress: ImageQualityProgress }
  | { id: number; ok: false; message: string };

const workerScope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
};

const MAX_CANVAS_EDGE = 16_384;
let sourcePixels: Uint8ClampedArray | null = null;
let sourceWidth = 0;
let sourceHeight = 0;
let sourceSha256 = "";
let sourceInspection: ImageFileInspection | null = null;
let sourceIsAnalysisSample = false;
const cancelled = new Set<number>();

function report(id: number, progress: ImageQualityProgress) {
  workerScope.postMessage({ id, type: "progress", progress });
}

function assertActive(id: number) {
  if (cancelled.has(id)) throw new DOMException("Enhancement cancelled.", "AbortError");
}

async function loadSource(
  source: Blob,
  id: number,
  allowAnalysisSample = false,
): Promise<ImageQualitySource> {
  report(id, { phase: "inspect", completed: 0, total: 1, message: "Verifying the real image type and dimensions…" });
  const inspection = await inspectImageFile(source);
  const budget = processingBudget((navigator as typeof navigator & { deviceMemory?: number }).deviceMemory, MAX_CANVAS_EDGE);
  const requiresSample = inspection.animated
    || inspection.frameCount > 1
    || inspection.width * inspection.height > budget.sourcePixels;
  if (requiresSample && !allowAnalysisSample) {
    throw new Error("The decoded image exceeds this device's measured local processing budget. Use a higher-memory device or the future cloud route.");
  }
  report(id, { phase: "hash", completed: 0, total: source.size, message: "Fingerprinting the untouched original…" });
  const digest = await sha256Blob(source, (completed) => {
    assertActive(id);
    report(id, { phase: "hash", completed, total: source.size, message: "Fingerprinting the untouched original…" });
  });
  assertActive(id);
  report(id, { phase: "decode", completed: 0, total: 1, message: "Decoding source pixels into sRGB…" });
  let bitmap: ImageBitmap;
  try {
    const longest = Math.max(inspection.width, inspection.height);
    const analysisScale = requiresSample ? Math.min(1, 1024 / longest) : 1;
    bitmap = await createImageBitmap(source, {
      colorSpaceConversion: "default",
      imageOrientation: "from-image",
      premultiplyAlpha: "premultiply",
      ...(requiresSample ? {
        resizeWidth: Math.max(1, Math.round(inspection.width * analysisScale)),
        resizeHeight: Math.max(1, Math.round(inspection.height * analysisScale)),
        resizeQuality: "high" as const,
      } : {}),
    });
  } catch {
    throw new Error("This image could not be decoded. Try a valid JPEG, PNG or WebP file.");
  }
  try {
    if (bitmap.width * bitmap.height > budget.sourcePixels) {
      throw new Error("The decoded image exceeds this device's measured local processing budget.");
    }
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
    if (!context) throw new Error("Your browser could not prepare the image processor.");
    context.drawImage(bitmap, 0, 0);
    sourcePixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    sourceWidth = bitmap.width;
    sourceHeight = bitmap.height;
    sourceSha256 = digest;
    sourceInspection = inspection;
    sourceIsAnalysisSample = requiresSample;
    report(id, { phase: "decode", completed: 1, total: 1, message: "Source pixels ready." });
    return {
      width: inspection.width,
      height: inspection.height,
      mediaType: inspection.mediaType,
      byteSize: source.size,
      sourceSha256,
      inspection,
    };
  } finally {
    bitmap.close();
  }
}

async function enhance(strength: number, outputScale: 2 | 4, id: number): Promise<ImageQualityResult> {
  if (!sourcePixels || !sourceInspection || !sourceSha256) throw new Error("Choose an image before enhancing it.");
  const started = performance.now();
  report(id, { phase: "analyse", completed: 0, total: 1, message: "Measuring noise, edges, tone and content structure…" });
  const corrected = enhancePixels(sourcePixels, sourceWidth, sourceHeight, strength);
  const graphic = classifyFlatGraphic(sourcePixels, sourceWidth, sourceHeight);
  const content = classifyImageContent(graphic, corrected.analysis);
  const budget = processingBudget((navigator as typeof navigator & { deviceMemory?: number }).deviceMemory, MAX_CANVAS_EDGE);
  const scalePlan = planRequestedScale(sourceWidth, sourceHeight, outputScale, budget);
  report(id, { phase: "reconstruct", completed: 0, total: 1, message: "Applying production-safe source-pixel reconstruction…" });
  const routePixels = graphic.isFlatGraphic
    ? enhanceFlatGraphicPixels(sourcePixels, sourceWidth, sourceHeight, strength).pixels
    : applyTextureConstrainedCorrection(
      sourcePixels,
      corrected.pixels,
      buildSourceTextureMap(sourcePixels, sourceWidth, sourceHeight),
      strength,
    );
  const reconstructed = graphic.isFlatGraphic
    ? { pixels: routePixels, width: sourceWidth, height: sourceHeight, scale: 1 as const }
    : reconstructPixels(routePixels, sourceWidth, sourceHeight, budget.outputPixels);
  const scale = scalePlan.scale;
  const scaleRationale = strength === 0
    ? `${scale}× neutral high-quality resampling without enhancement corrections.`
    : scalePlan.rationale;
  const raw = await encodePixels(reconstructed.pixels, reconstructed.width, reconstructed.height, scale, id);
  const fidelity = await validateFidelity(raw, id);
  if (!fidelity.passed) {
    throw new Error("The result did not pass source-colour and protected-region checks. Your original is unchanged.");
  }
  const route = `${content.contentClass}-production-deterministic-x${scale}`;
  const tagged = tagSrgbPng(new Uint8Array(raw), {
    sourceSha256,
    engineId: "ipw-deterministic-image-quality",
    engineVersion: "1.0.0",
    route,
    strength,
    scale,
    modelSha256: null,
    usage: "deterministic",
    contentClass: content.contentClass,
    classificationConfidence: content.confidence,
    outputWidth: sourceWidth * scale,
    outputHeight: sourceHeight * scale,
    xPixelsPerMetre: sourceInspection.physicalPixelDensity?.xPixelsPerMetre,
    yPixelsPerMetre: sourceInspection.physicalPixelDensity?.yPixelsPerMetre,
  });
  return {
    bytes: Uint8Array.from(tagged).buffer,
    mediaType: "image/png",
    width: sourceWidth * scale,
    height: sourceHeight * scale,
    analysis: corrected.analysis,
    engine: "Production-safe deterministic restoration · Worker",
    route,
    sourceSha256,
    outputSha256: pngOutputSha256(tagged),
    strength,
    scale,
    processingTimeMs: Math.round(performance.now() - started),
    contentClass: content.contentClass,
    classificationConfidence: content.confidence,
    model: { id: "ipw-deterministic-image-quality", version: "1.0.0", sha256: null, usage: "deterministic" },
    warnings: [
      scaleRationale,
      `Measured correction need: ${qualityNeed(corrected.analysis)}.`,
      "Output pixels and metadata are normalized to sRGB.",
      "Production-safe deterministic restoration was used; no research-only weights were loaded or distributed.",
      ...(sourceInspection.bitDepth > 8 ? [`The ${sourceInspection.bitDepth}-bit source was normalized to an 8-bit-per-channel PNG by the browser-local canvas pipeline.`] : []),
      ...(sourceInspection.hasExif ? ["Source EXIF, including any location metadata, is not copied to the derivative."] : []),
      ...sourceInspection.warnings,
    ],
    fidelity,
    analysisProxy: sourceIsAnalysisSample,
  };
}

async function encodePixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  scale: 1 | 2 | 4,
  id: number,
) {
  assertActive(id);
  const source = new OffscreenCanvas(width, height);
  const sourceContext = source.getContext("2d", { colorSpace: "srgb" });
  if (!sourceContext) throw new Error("Your browser could not prepare the corrected pixels.");
  sourceContext.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height, { colorSpace: "srgb" }), 0, 0);
  const output = new OffscreenCanvas(sourceWidth * scale, sourceHeight * scale);
  const outputContext = output.getContext("2d", { colorSpace: "srgb" });
  if (!outputContext) throw new Error("Your browser could not allocate the enhanced image.");
  outputContext.imageSmoothingEnabled = true;
  outputContext.imageSmoothingQuality = "high";
  outputContext.drawImage(source, 0, 0, output.width, output.height);
  const blob = await output.convertToBlob({ type: "image/png" });
  report(id, { phase: "encode", completed: 1, total: 1, message: "Processed PNG ready." });
  return blob.arrayBuffer();
}

async function validateFidelity(bytes: ArrayBuffer, id: number) {
  assertActive(id);
  if (!sourcePixels) throw new Error("The immutable source pixels are unavailable.");
  const sampleScale = Math.min(1, 512 / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * sampleScale));
  const height = Math.max(1, Math.round(sourceHeight * sampleScale));
  const sourceCanvas = new OffscreenCanvas(sourceWidth, sourceHeight);
  const sourceContext = sourceCanvas.getContext("2d", { colorSpace: "srgb" });
  const sourceSampleCanvas = new OffscreenCanvas(width, height);
  const sourceSampleContext = sourceSampleCanvas.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
  if (!sourceContext || !sourceSampleContext) throw new Error("Fidelity validation could not allocate its source sample.");
  sourceContext.putImageData(new ImageData(new Uint8ClampedArray(sourcePixels), sourceWidth, sourceHeight, { colorSpace: "srgb" }), 0, 0);
  sourceSampleContext.drawImage(sourceCanvas, 0, 0, width, height);
  const sourceSample = sourceSampleContext.getImageData(0, 0, width, height).data;
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }), { resizeWidth: width, resizeHeight: height, resizeQuality: "high" });
  try {
    const outputCanvas = new OffscreenCanvas(width, height);
    const outputContext = outputCanvas.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
    if (!outputContext) throw new Error("Fidelity validation could not allocate its result sample.");
    outputContext.drawImage(bitmap, 0, 0);
    return measureCoordinateMatchedFidelity(sourceSample, outputContext.getImageData(0, 0, width, height).data, width, height);
  } finally {
    bitmap.close();
  }
}

workerScope.onmessage = (event) => {
  const request = event.data;
  if (request.type === "cancel") {
    cancelled.add(request.targetId);
    return;
  }
  void (async () => {
    try {
      if (request.type === "load") {
        const loaded = await loadSource(
          request.source,
          request.id,
          request.allowAnalysisSample,
        );
        workerScope.postMessage({ id: request.id, ok: true, type: "loaded", ...loaded });
        return;
      }
      const result = await enhance(request.strength, request.outputScale, request.id);
      if (!result.bytes) throw new Error("The local worker did not encode its result.");
      workerScope.postMessage(
        { id: request.id, ok: true, type: "enhanced", ...result },
        [result.bytes],
      );
    } catch (error) {
      workerScope.postMessage({ id: request.id, ok: false, message: error instanceof Error ? error.message : "Image processing did not complete." });
    } finally {
      cancelled.delete(request.id);
    }
  })();
};
