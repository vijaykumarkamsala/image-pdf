import ImageTracer from "imagetracerjs";

import type {
  ImageQualityAnalysis,
  ImageQualityProgress,
  ImageQualityResult,
  ImageQualitySource,
} from "./ImageQualityEngine";
import { selectImageQualityEngine } from "./enginePortfolio";
import { measureCoordinateMatchedFidelity } from "./imageQualityFidelity";
import { inspectImageFile, type ImageFileInspection } from "./imageFileInspection";
import {
  applyTextureConstrainedCorrection,
  buildSkinToneProtectionMap,
  buildSourceTextureMap,
  classifyFlatGraphic,
  enhanceFlatGraphicPixels,
  enhancePixels,
  fuseRestoredPixel,
  prepareFlatGraphicTracePixels,
  reconstructPixels,
} from "./imageQualityPipeline";
import {
  chooseScalePlan,
  classifyImageContent,
  processingBudget,
  qualityNeed,
  type ImageContentClass,
} from "./imageQualityPolicy";
import { planImageQualityTiles } from "./imageQualityTiling";
import { pngOutputSha256, tagSrgbPng } from "./pngMetadata";
import { sha256Blob } from "./sha256";
import { traceSmoothMaskSvg } from "./smoothMaskTrace";

type OrtModule = typeof import("onnxruntime-web/webgpu");
type ResvgModule = typeof import("@resvg/resvg-wasm");

type WorkerRequest =
  | { id: number; type: "load"; source: Blob }
  | { id: number; type: "enhance"; strength: number; preferDeterministic: boolean }
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
const MODEL_TILE = 128;
const TILE_CONTEXT = 10;
const CORE_TILE = MODEL_TILE - TILE_CONTEXT * 2;
const MODEL_SCALE = 4;
const MODEL_OUTPUT_TILE = MODEL_TILE * MODEL_SCALE;
const MODEL_SPECS = {
  strong: {
    url: "/quality-models/realesr-general-x4v3-tile128.onnx",
    bytes: 4_959_082,
    sha256: "5c5af5908e7438a965cffb1ba62a764e319aac069c35c50ba6851bb4a300760c",
  },
  natural: {
    url: "/quality-models/realesr-general-x4v3-dni50-tile128.onnx",
    bytes: 4_959_211,
    sha256: "baa6d2ecb9c5ba34ed8bed03a079946179260aa11ba2516681ec355492e94060",
  },
} as const;
type ModelVariant = keyof typeof MODEL_SPECS;
const MAX_TRACE_EDGE = 1_024;
const MAX_VECTOR_MARKUP_BYTES = 16_000_000;
let sourcePixels: Uint8ClampedArray | null = null;
let sourceWidth = 0;
let sourceHeight = 0;
let sourceMediaType = "";
let sourceSha256 = "";
let sourceInspection: ImageFileInspection | null = null;
let ortModule: Promise<OrtModule> | null = null;
const modelSessions: Partial<Record<ModelVariant, Promise<import("onnxruntime-web").InferenceSession>>> = {};
let resvgModule: Promise<ResvgModule> | null = null;
const cancelledRequests = new Set<number>();
const LOCAL_RESEARCH_COMPONENTS_ENABLED = import.meta.env.DEV
  && ["localhost", "127.0.0.1", "::1"].includes(globalThis.location.hostname);

function report(id: number, progress: ImageQualityProgress) {
  workerScope.postMessage({ id, type: "progress", progress });
}

function assertNotCancelled(id: number) {
  if (cancelledRequests.has(id)) throw new DOMException("Enhancement cancelled.", "AbortError");
}

async function loadSource(source: Blob, requestId: number): Promise<ImageQualitySource> {
  report(requestId, { phase: "inspect", completed: 0, total: 1, message: "Verifying the real image type and dimensions…" });
  const inspection = await inspectImageFile(source);
  if (inspection.animated || inspection.frameCount > 1) {
    throw new Error("Animated images are not flattened silently. Choose a still JPEG, PNG or WebP image.");
  }
  const budget = processingBudget(
    (navigator as typeof navigator & { deviceMemory?: number }).deviceMemory,
    MAX_CANVAS_EDGE,
  );
  const encodedPixels = inspection.width * inspection.height;
  if (!Number.isSafeInteger(encodedPixels) || encodedPixels > budget.sourcePixels) {
    throw new Error(`This image needs more decoded memory than this browser can safely allocate (${Math.round(encodedPixels / 1_000_000)} MP detected). Use a higher-memory device or the future cloud route.`);
  }
  report(requestId, { phase: "inspect", completed: 1, total: 1, message: "Image header verified." });
  assertNotCancelled(requestId);
  report(requestId, { phase: "hash", completed: 0, total: source.size, message: "Fingerprinting the untouched original…" });
  const digest = await sha256Blob(source, (completed) => {
    assertNotCancelled(requestId);
    report(requestId, { phase: "hash", completed, total: source.size, message: "Fingerprinting the untouched original…" });
  });
  assertNotCancelled(requestId);
  report(requestId, { phase: "decode", completed: 0, total: 1, message: "Decoding source pixels into sRGB…" });
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source, {
      colorSpaceConversion: "default",
      imageOrientation: "from-image",
      premultiplyAlpha: "premultiply",
    });
  } catch {
    throw new Error("This image could not be decoded. Try a valid JPEG, PNG or WebP file.");
  }
  try {
    if (bitmap.width < 1 || bitmap.height < 1 || bitmap.width * bitmap.height > budget.sourcePixels) {
      throw new Error("The decoded image exceeds this device's measured local processing budget.");
    }
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
    if (!context) throw new Error("Your browser could not prepare the image processor.");
    context.drawImage(bitmap, 0, 0);
    const decoded = context.getImageData(0, 0, bitmap.width, bitmap.height);
    sourcePixels = decoded.data;
    sourceWidth = bitmap.width;
    sourceHeight = bitmap.height;
    sourceMediaType = inspection.mediaType;
    sourceSha256 = digest;
    sourceInspection = inspection;
    report(requestId, { phase: "decode", completed: 1, total: 1, message: "Source pixels ready." });
    return {
      width: sourceWidth,
      height: sourceHeight,
      mediaType: sourceMediaType,
      byteSize: source.size,
      sourceSha256,
      inspection,
    };
  } finally {
    bitmap.close();
  }
}

interface RawEnhancement {
  bytes: ArrayBuffer;
  width: number;
  height: number;
  engine: string;
  route: string;
  analysis: ImageQualityAnalysis;
  scale: 1 | 2 | 4;
  scaleRationale: string;
  model: ImageQualityResult["model"];
  warnings: string[];
}

async function enhance(strength: number, requestId: number, preferDeterministic: boolean): Promise<ImageQualityResult> {
  if (!sourcePixels || !sourceInspection || !sourceSha256) throw new Error("Choose an image before enhancing it.");
  const started = performance.now();
  report(requestId, { phase: "analyse", completed: 0, total: 1, message: "Measuring noise, edges, tone and content structure…" });
  const corrected = enhancePixels(sourcePixels, sourceWidth, sourceHeight, strength);
  const graphic = classifyFlatGraphic(sourcePixels, sourceWidth, sourceHeight);
  const content = classifyImageContent(graphic, corrected.analysis);
  report(requestId, { phase: "analyse", completed: 1, total: 1, message: `${content.contentClass} route selected with ${Math.round(content.confidence * 100)}% confidence.` });
  assertNotCancelled(requestId);
  const flatPixels = graphic.isFlatGraphic
    ? enhanceFlatGraphicPixels(sourcePixels, sourceWidth, sourceHeight, strength).pixels
    : null;
  let raw: RawEnhancement;
  if (flatPixels) {
    if (!LOCAL_RESEARCH_COMPONENTS_ENABLED) {
      raw = await renderFlatPixelFallback(flatPixels, corrected.analysis, requestId);
    } else {
      try {
        raw = await renderFlatGraphic(flatPixels, corrected.analysis, strength, requestId);
      } catch {
        raw = await renderFlatPixelFallback(flatPixels, corrected.analysis, requestId);
      }
    }
  } else {
    raw = await renderPhoto(sourcePixels, corrected, content.contentClass, strength, requestId, preferDeterministic);
  }
  assertNotCancelled(requestId);
  let fidelity = await validateOutputFidelity(raw.bytes, requestId);
  if (!fidelity.passed) {
    raw = flatPixels
      ? await renderFlatPixelFallback(flatPixels, corrected.analysis, requestId)
      : await renderDeterministicPhoto(corrected, content.contentClass, requestId, [
        "The optional reconstruction was rejected by source-fidelity checks; deterministic restoration was used.",
      ]);
    fidelity = await validateOutputFidelity(raw.bytes, requestId);
    if (!fidelity.passed) {
      throw new Error("The result did not pass source-colour and protected-region checks. Your original is unchanged.");
    }
  }
  report(requestId, { phase: "encode", completed: 0, total: 1, message: "Writing the processed PNG and provenance…" });
  const tagged = tagSrgbPng(new Uint8Array(raw.bytes), {
    sourceSha256,
    engineId: raw.model.id,
    engineVersion: raw.model.version,
    route: raw.route,
    strength,
    scale: raw.scale,
    modelSha256: raw.model.sha256,
    usage: raw.model.usage,
    contentClass: content.contentClass,
    classificationConfidence: content.confidence,
    outputWidth: raw.width,
    outputHeight: raw.height,
    xPixelsPerMetre: sourceInspection.physicalPixelDensity?.xPixelsPerMetre,
    yPixelsPerMetre: sourceInspection.physicalPixelDensity?.yPixelsPerMetre,
  });
  const outputSha256 = pngOutputSha256(tagged);
  report(requestId, { phase: "encode", completed: 1, total: 1, message: "Processed PNG verified." });
  return {
    ...raw,
    bytes: Uint8Array.from(tagged).buffer,
    mediaType: "image/png",
    sourceSha256,
    outputSha256,
    strength,
    processingTimeMs: Math.round(performance.now() - started),
    contentClass: content.contentClass,
    classificationConfidence: content.confidence,
    fidelity,
    warnings: [
      raw.scaleRationale,
      `Measured correction need: ${qualityNeed(raw.analysis)}.`,
      "Output pixels and metadata are normalized to sRGB.",
      ...(sourceInspection.bitDepth > 8 ? [`The ${sourceInspection.bitDepth}-bit source was normalized to an 8-bit-per-channel PNG by the browser-local canvas pipeline.`] : []),
      ...(sourceInspection.hasExif ? ["Source EXIF, including any location metadata, is not copied to the derivative."] : []),
      ...sourceInspection.warnings,
      ...raw.warnings,
    ],
  };
}

async function validateOutputFidelity(bytes: ArrayBuffer, requestId: number) {
  assertNotCancelled(requestId);
  const sampleScale = Math.min(1, 512 / Math.max(sourceWidth, sourceHeight));
  const sampleWidth = Math.max(1, Math.round(sourceWidth * sampleScale));
  const sampleHeight = Math.max(1, Math.round(sourceHeight * sampleScale));
  const sourceCanvas = new OffscreenCanvas(sourceWidth, sourceHeight);
  const sourceContext = sourceCanvas.getContext("2d", { colorSpace: "srgb" });
  if (!sourceContext || !sourcePixels) throw new Error("Source-fidelity validation could not read the original pixels.");
  sourceContext.putImageData(new ImageData(new Uint8ClampedArray(sourcePixels), sourceWidth, sourceHeight, { colorSpace: "srgb" }), 0, 0);
  const sampledSourceCanvas = new OffscreenCanvas(sampleWidth, sampleHeight);
  const sampledSourceContext = sampledSourceCanvas.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
  if (!sampledSourceContext) throw new Error("Source-fidelity validation could not allocate its sample.");
  sampledSourceContext.drawImage(sourceCanvas, 0, 0, sampleWidth, sampleHeight);
  const sourceSample = sampledSourceContext.getImageData(0, 0, sampleWidth, sampleHeight).data;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }), {
      resizeWidth: sampleWidth,
      resizeHeight: sampleHeight,
      resizeQuality: "high",
      colorSpaceConversion: "default",
      premultiplyAlpha: "premultiply",
    });
  } catch {
    throw new Error("The processed result could not be decoded for fidelity validation.");
  }
  try {
    const outputCanvas = new OffscreenCanvas(sampleWidth, sampleHeight);
    const outputContext = outputCanvas.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
    if (!outputContext) throw new Error("Source-fidelity validation could not allocate the result sample.");
    outputContext.drawImage(bitmap, 0, 0, sampleWidth, sampleHeight);
    const outputSample = outputContext.getImageData(0, 0, sampleWidth, sampleHeight).data;
    return measureCoordinateMatchedFidelity(sourceSample, outputSample, sampleWidth, sampleHeight);
  } finally {
    bitmap.close();
  }
}

async function renderPhoto(
  originalPixels: Uint8ClampedArray,
  corrected: { pixels: Uint8ClampedArray; analysis: ImageQualityAnalysis },
  contentClass: ImageContentClass,
  strength: number,
  requestId: number,
  preferDeterministic: boolean,
): Promise<RawEnhancement> {
  const gpu = (navigator as typeof navigator & {
    gpu?: { requestAdapter(options: { powerPreference: string }): Promise<unknown | null> };
  }).gpu;
  const adapter = LOCAL_RESEARCH_COMPONENTS_ENABLED && !preferDeterministic && gpu
    ? await gpu.requestAdapter({ powerPreference: "high-performance" })
    : null;
  const selectedEngine = selectImageQualityEngine({
    contentClass,
    purpose: LOCAL_RESEARCH_COMPONENTS_ENABLED ? "local-research" : "production",
    webGpuAvailable: Boolean(adapter),
  });
  if (selectedEngine.implementation !== "neural") return renderDeterministicPhoto(corrected, contentClass, requestId, [
    LOCAL_RESEARCH_COMPONENTS_ENABLED
      ? "WebGPU was unavailable; a deterministic restoration was used."
      : "Production-safe deterministic restoration was used because research-only model weights are not distributable.",
  ]);
  const modelVariant: ModelVariant = contentClass === "photograph" ? "natural" : "strong";
  const modelSpec = MODEL_SPECS[modelVariant];
  let ort: OrtModule;
  let session: import("onnxruntime-web").InferenceSession;
  try {
    ort = await getOrtModule();
    session = await getModelSession(ort, modelVariant);
  } catch {
    return renderDeterministicPhoto(corrected, contentClass, requestId, [
      "The optional local-research model was unavailable; deterministic restoration completed instead.",
    ]);
  }
  const sourceTexture = buildSourceTextureMap(originalPixels, sourceWidth, sourceHeight);
  const skinToneProtection = contentClass === "photograph"
    ? buildSkinToneProtectionMap(originalPixels, sourceWidth, sourceHeight)
    : null;
  const correctedReference = applyTextureConstrainedCorrection(originalPixels, corrected.pixels, sourceTexture);
  const sourceCanvas = new OffscreenCanvas(sourceWidth, sourceHeight);
  const sourceContext = sourceCanvas.getContext("2d", { colorSpace: "srgb" });
  if (!sourceContext) throw new Error("Your browser could not prepare source-reference pixels.");
  sourceContext.putImageData(
    new ImageData(new Uint8ClampedArray(correctedReference), sourceWidth, sourceHeight, { colorSpace: "srgb" }),
    0,
    0,
  );
  const plan = chooseScalePlan(
    sourceWidth,
    sourceHeight,
    contentClass,
    "neural",
    processingBudget((navigator as typeof navigator & { deviceMemory?: number }).deviceMemory, MAX_CANVAS_EDGE),
  );
  const outputScale = plan.scale;
  const width = sourceWidth * outputScale;
  const height = sourceHeight * outputScale;
  const outputCanvas = new OffscreenCanvas(width, height);
  const outputContext = outputCanvas.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
  if (!outputContext) throw new Error("Your browser could not allocate the enhanced image.");
  outputContext.imageSmoothingEnabled = true;
  outputContext.imageSmoothingQuality = "high";
  outputContext.drawImage(sourceCanvas, 0, 0, width, height);
  const outputImage = outputContext.getImageData(0, 0, width, height);
  let completedTiles = 0;
  const tiles = planImageQualityTiles(sourceWidth, sourceHeight, CORE_TILE);
  const totalTiles = tiles.length;
  const inferenceStarted = performance.now();
  report(requestId, { phase: "model", completed: 0, total: totalTiles, message: "Restoring source-aligned detail…" });

  for (const tile of tiles) {
      const input = modelInput(originalPixels, sourceWidth, sourceHeight, tile.left, tile.top);
      const tensor = new ort.Tensor("float32", input, [1, 3, MODEL_TILE, MODEL_TILE]);
      let restored: import("onnxruntime-web").Tensor | undefined;
      try {
        const results = await session.run({ input: tensor });
        completedTiles += 1;
        if (completedTiles === 1) {
          console.info(`[image-quality] first WebGPU tile completed in ${Math.round(performance.now() - inferenceStarted)} ms`);
        }
        restored = results["output"];
        if (!restored || !(restored.data instanceof Float32Array)) {
          throw new Error("The restoration model returned invalid pixels. Your original is unchanged.");
        }
        blendModelTile(
          outputImage.data,
          width,
          sourceTexture,
          sourceWidth,
          restored.data,
          tile.left,
          tile.top,
          tile.width,
          tile.height,
          outputScale,
          strength,
          contentClass === "photograph" ? 0.55 : 1,
          skinToneProtection,
        );
        report(requestId, { phase: "model", completed: completedTiles, total: totalTiles, message: `Restoring source-aligned detail (${completedTiles}/${totalTiles})…` });
      } finally {
        restored?.dispose();
        tensor.dispose();
      }
      assertNotCancelled(requestId);
  }
  console.info(`[image-quality] ${completedTiles} WebGPU tiles completed in ${Math.round(performance.now() - inferenceStarted)} ms`);
  outputContext.putImageData(outputImage, 0, 0);
  const blob = await outputCanvas.convertToBlob({ type: "image/png" });
  return {
    bytes: await blob.arrayBuffer(),
    width,
    height,
    engine: modelVariant === "natural"
      ? "Identity-constrained Real-ESRGAN x4v3 DNI 0.5 · WebGPU"
      : "Fidelity-constrained Real-ESRGAN x4v3 · WebGPU",
    route: `${contentClass}-${modelVariant === "natural" ? "natural-" : ""}${outputScale === 4 ? "reconstruct-x4" : outputScale === 2 ? "reconstruct-x2" : "restore-native"}`,
    analysis: corrected.analysis,
    scale: outputScale,
    scaleRationale: plan.rationale,
    model: {
      id: modelVariant === "natural" ? `${selectedEngine.id}-dni50` : selectedEngine.id,
      version: modelVariant === "natural" ? `${selectedEngine.version}/dni0.5` : selectedEngine.version,
      sha256: modelSpec.sha256,
      usage: "local-research",
    },
    warnings: [
      ...(contentClass === "photograph"
        ? ["Potential skin-tone regions use conservative source-fidelity fusion; no face-restoration model was used."]
        : []),
      "Local-research model weights are not licensed for production distribution.",
    ],
  };
}

async function renderDeterministicPhoto(
  corrected: { pixels: Uint8ClampedArray; analysis: ImageQualityAnalysis },
  contentClass: ImageContentClass,
  requestId: number,
  warnings: string[],
): Promise<RawEnhancement> {
  report(requestId, { phase: "reconstruct", completed: 0, total: 1, message: "Applying deterministic edge-directed reconstruction…" });
  if (!sourcePixels) throw new Error("The immutable source pixels are unavailable.");
  const texture = buildSourceTextureMap(sourcePixels, sourceWidth, sourceHeight);
  const protectedCorrection = applyTextureConstrainedCorrection(sourcePixels, corrected.pixels, texture);
  const reconstructed = reconstructPixels(
    protectedCorrection,
    sourceWidth,
    sourceHeight,
    processingBudget((navigator as typeof navigator & { deviceMemory?: number }).deviceMemory, MAX_CANVAS_EDGE).outputPixels,
  );
  assertNotCancelled(requestId);
  const canvas = new OffscreenCanvas(reconstructed.width, reconstructed.height);
  const context = canvas.getContext("2d", { colorSpace: "srgb" });
  if (!context) throw new Error("Your browser could not allocate the deterministic result.");
  context.putImageData(
    new ImageData(new Uint8ClampedArray(reconstructed.pixels), reconstructed.width, reconstructed.height, { colorSpace: "srgb" }),
    0,
    0,
  );
  const blob = await canvas.convertToBlob({ type: "image/png" });
  report(requestId, { phase: "reconstruct", completed: 1, total: 1, message: "Deterministic reconstruction complete." });
  return {
    bytes: await blob.arrayBuffer(),
    width: reconstructed.width,
    height: reconstructed.height,
    engine: "Deterministic adaptive restoration · Worker",
    route: `${contentClass}-deterministic-x${reconstructed.scale}`,
    analysis: corrected.analysis,
    scale: reconstructed.scale,
    scaleRationale: reconstructed.scale === 1
      ? "Source pixels were corrected at native dimensions; enlargement was not justified."
      : "2× edge-directed resampling followed source-pixel correction.",
    model: {
      id: "ipw-deterministic-image-quality",
      version: "1.0.0",
      sha256: null,
      usage: "deterministic",
    },
    warnings,
  };
}

async function renderFlatPixelFallback(
  pixels: Uint8ClampedArray,
  analysis: ImageQualityAnalysis,
  requestId: number,
): Promise<RawEnhancement> {
  const plan = chooseScalePlan(
    sourceWidth,
    sourceHeight,
    "flat-graphic",
    "deterministic",
    processingBudget((navigator as typeof navigator & { deviceMemory?: number }).deviceMemory, MAX_CANVAS_EDGE),
  );
  const sourceCanvas = new OffscreenCanvas(sourceWidth, sourceHeight);
  const sourceContext = sourceCanvas.getContext("2d", { colorSpace: "srgb" });
  if (!sourceContext) throw new Error("Your browser could not prepare the protected graphic fallback.");
  sourceContext.putImageData(new ImageData(new Uint8ClampedArray(pixels), sourceWidth, sourceHeight, { colorSpace: "srgb" }), 0, 0);
  const width = sourceWidth * plan.scale;
  const height = sourceHeight * plan.scale;
  const outputCanvas = new OffscreenCanvas(width, height);
  const outputContext = outputCanvas.getContext("2d", { colorSpace: "srgb" });
  if (!outputContext) throw new Error("Your browser could not allocate the protected graphic fallback.");
  outputContext.imageSmoothingEnabled = true;
  outputContext.imageSmoothingQuality = "high";
  outputContext.drawImage(sourceCanvas, 0, 0, width, height);
  const blob = await outputCanvas.convertToBlob({ type: "image/png" });
  report(requestId, { phase: "reconstruct", completed: 1, total: 1, message: "Protected source-colour reconstruction complete." });
  return {
    bytes: await blob.arrayBuffer(),
    width,
    height,
    engine: "Protected source-colour reconstruction · Worker",
    route: `flat-graphic-protected-x${plan.scale}`,
    analysis,
    scale: plan.scale,
    scaleRationale: plan.rationale,
    model: {
      id: "ipw-protected-graphic-reconstruction",
      version: "1.0.0",
      sha256: null,
      usage: "deterministic",
    },
    warnings: ["A contour candidate was rejected by source-fidelity checks; protected pixel reconstruction was used."],
  };
}

async function renderFlatGraphic(
  pixels: Uint8ClampedArray,
  analysis: ImageQualityAnalysis,
  strength: number,
  requestId: number,
): Promise<RawEnhancement> {
  report(requestId, { phase: "reconstruct", completed: 0, total: 1, message: "Reconstructing smooth source-colour contours…" });
  const plan = chooseScalePlan(
    sourceWidth,
    sourceHeight,
    "flat-graphic",
    "deterministic",
    processingBudget((navigator as typeof navigator & { deviceMemory?: number }).deviceMemory, MAX_CANVAS_EDGE),
  );
  const outputScale = plan.scale;
  const traceScale = Math.min(1, MAX_TRACE_EDGE / Math.max(sourceWidth, sourceHeight));
  const traceWidth = Math.max(1, Math.round(sourceWidth * traceScale));
  const traceHeight = Math.max(1, Math.round(sourceHeight * traceScale));
  const sourceCanvas = new OffscreenCanvas(sourceWidth, sourceHeight);
  const sourceContext = sourceCanvas.getContext("2d", { colorSpace: "srgb" });
  if (!sourceContext) throw new Error("Your browser could not prepare clean graphic pixels.");
  sourceContext.putImageData(new ImageData(new Uint8ClampedArray(pixels), sourceWidth, sourceHeight, { colorSpace: "srgb" }), 0, 0);
  const traceCanvas = new OffscreenCanvas(traceWidth, traceHeight);
  const traceContext = traceCanvas.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
  if (!traceContext) throw new Error("Your browser could not prepare vector tracing pixels.");
  traceContext.imageSmoothingEnabled = true;
  traceContext.imageSmoothingQuality = "high";
  traceContext.drawImage(sourceCanvas, 0, 0, traceWidth, traceHeight);
  const tracePixels = traceContext.getImageData(0, 0, traceWidth, traceHeight);
  const preparedTrace = prepareFlatGraphicTracePixels(
    tracePixels.data,
    traceWidth,
    traceHeight,
  );
  const amount = strength / 100;
  const outputWidth = sourceWidth * outputScale;
  const outputHeight = sourceHeight * outputScale;
  if (preparedTrace.background && preparedTrace.foregroundMask) {
    return renderSourceColourMask(
      preparedTrace.mattePixels,
      preparedTrace.foregroundMask,
      preparedTrace.background,
      traceWidth,
      traceHeight,
      outputWidth,
      outputHeight,
      analysis,
      outputScale,
      plan.rationale,
      requestId,
    );
  }
  const rawSvg = ImageTracer.imagedataToSVG({
    data: preparedTrace.pixels,
    height: traceHeight,
    width: traceWidth,
  }, {
    blurradius: 1,
    blurdelta: 64,
    colorquantcycles: 3,
    colorsampling: 2,
    desc: false,
    layering: 0,
    linefilter: true,
    ltres: 0.01,
    mincolorratio: 0.0005,
    numberofcolors: Math.round(32 - amount * 16),
    pathomit: Math.max(1, Math.round(Math.max(traceWidth, traceHeight) / 512)),
    qtres: 0.7 + amount * 0.5,
    rightangleenhance: false,
    roundcoords: 3,
    scale: 1,
    strokewidth: 0,
    viewbox: true,
  });
  const png = await renderVectorPng(rawSvg, outputWidth, outputHeight);
  report(requestId, { phase: "reconstruct", completed: 1, total: 1, message: "Smooth contour reconstruction complete." });
  return {
    bytes: png.buffer,
    width: outputWidth,
    height: outputHeight,
    engine: "Bézier vector contour reconstruction · Worker",
    route: `flat-graphic-vector-x${outputScale}`,
    analysis,
    scale: outputScale,
    scaleRationale: plan.rationale,
    model: {
      id: "ipw-bezier-vector-reconstruction",
      version: "1.0.0",
      sha256: null,
      usage: "deterministic",
    },
    warnings: [],
  };
}

async function renderSourceColourMask(
  preparedPixels: Uint8ClampedArray,
  foregroundMask: Uint8Array,
  background: readonly [number, number, number, number],
  traceWidth: number,
  traceHeight: number,
  outputWidth: number,
  outputHeight: number,
  analysis: ImageQualityAnalysis,
  outputScale: 1 | 2 | 4,
  scaleRationale: string,
  requestId: number,
): Promise<RawEnhancement> {
  let rawMaskSvg: string;
  try {
    rawMaskSvg = traceSmoothMaskSvg(foregroundMask, traceWidth, traceHeight);
  } catch {
    throw new Error("The smooth contour reconstruction could not complete. Your original is unchanged.");
  }
  const maskPng = await renderVectorPng(rawMaskSvg, outputWidth, outputHeight);
  let maskBitmap: ImageBitmap;
  try {
    maskBitmap = await createImageBitmap(new Blob([maskPng.buffer], { type: "image/png" }));
  } catch {
    throw new Error("The reconstructed contour mask could not be decoded. Your original is unchanged.");
  }
  try {
    const preparedCanvas = new OffscreenCanvas(traceWidth, traceHeight);
    const preparedContext = preparedCanvas.getContext("2d", { colorSpace: "srgb" });
    if (!preparedContext) throw new Error("Your browser could not prepare source-colour pixels.");
    preparedContext.putImageData(
      new ImageData(new Uint8ClampedArray(preparedPixels), traceWidth, traceHeight, { colorSpace: "srgb" }),
      0,
      0,
    );
    const outputCanvas = new OffscreenCanvas(outputWidth, outputHeight);
    const outputContext = outputCanvas.getContext("2d", { colorSpace: "srgb" });
    if (!outputContext) throw new Error("Your browser could not allocate the reconstructed graphic.");
    outputContext.imageSmoothingEnabled = true;
    // The vector mask owns edge smoothness. Linear colour interpolation avoids
    // cubic overshoot inventing dark or bright contour colours at hard edges.
    outputContext.imageSmoothingQuality = "low";
    outputContext.drawImage(preparedCanvas, 0, 0, outputWidth, outputHeight);
    outputContext.globalCompositeOperation = "destination-in";
    outputContext.drawImage(maskBitmap, 0, 0, outputWidth, outputHeight);
    outputContext.globalCompositeOperation = "destination-over";
    outputContext.fillStyle = `rgba(${background[0]}, ${background[1]}, ${background[2]}, ${background[3] / 255})`;
    outputContext.fillRect(0, 0, outputWidth, outputHeight);
    const blob = await outputCanvas.convertToBlob({ type: "image/png" });
    report(requestId, { phase: "reconstruct", completed: 1, total: 1, message: "Source-colour contour reconstruction complete." });
    return {
      bytes: await blob.arrayBuffer(),
      width: outputWidth,
      height: outputHeight,
      engine: "Source-colour smooth-spline reconstruction · Worker",
      route: `flat-graphic-mask-x${outputScale}`,
      analysis,
      scale: outputScale,
      scaleRationale,
      model: {
        id: "ipw-source-colour-spline-reconstruction",
        version: "1.0.0",
        sha256: null,
        usage: "deterministic",
      },
      warnings: [],
    };
  } finally {
    maskBitmap.close();
  }
}

async function renderVectorPng(
  rawSvg: string,
  outputWidth: number,
  outputHeight: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (rawSvg.length > MAX_VECTOR_MARKUP_BYTES || /<(?:script|foreignObject)|\b(?:href|src)=|url\s*\(/i.test(rawSvg)) {
    throw new Error("The reconstructed graphic exceeded the safe vector complexity budget. Your original is unchanged.");
  }
  const svg = rawSvg.replace(/<svg\b([^>]*)>/i, (_element, attributes: string) => {
    const sourceWidth = attributes.match(/\bwidth="([0-9.]+)"/i)?.[1];
    const sourceHeight = attributes.match(/\bheight="([0-9.]+)"/i)?.[1];
    const sourceViewBox = attributes.match(/\bviewBox="([^"]+)"/i)?.[1];
    const cleanAttributes = attributes
      .replace(/\swidth="[^"]*"/i, "")
      .replace(/\sheight="[^"]*"/i, "")
      .replace(/\sviewBox="[^"]*"/i, "");
    const viewBox = sourceWidth && sourceHeight
      ? ` viewBox="0 0 ${sourceWidth} ${sourceHeight}"`
      : sourceViewBox
        ? ` viewBox="${sourceViewBox}"`
        : "";
    return `<svg width="${outputWidth}" height="${outputHeight}"${viewBox}${cleanAttributes}>`;
  });
  if (!LOCAL_RESEARCH_COMPONENTS_ENABLED) return renderVectorPngWithBrowser(svg, outputWidth, outputHeight);
  const module = await getResvgModule();
  let renderer: InstanceType<ResvgModule["Resvg"]> | null = null;
  let rendered: ReturnType<InstanceType<ResvgModule["Resvg"]>["render"]> | null = null;
  try {
    renderer = new module.Resvg(svg, {
      fitTo: { mode: "width", value: outputWidth },
      font: { loadSystemFonts: false },
      imageRendering: 0,
      shapeRendering: 2,
    });
    rendered = renderer.render();
    if (rendered.width !== outputWidth || rendered.height !== outputHeight) {
      throw new Error("The vector renderer returned unexpected dimensions.");
    }
    return Uint8Array.from(rendered.asPng());
  } finally {
    rendered?.free();
    renderer?.free();
  }
}

async function getResvgModule(): Promise<ResvgModule> {
  if (!resvgModule) {
    resvgModule = (async () => {
      const [module, wasm] = await Promise.all([
        import("@resvg/resvg-wasm"),
        import("@resvg/resvg-wasm/index_bg.wasm?url"),
      ]);
      await module.initWasm(fetch(wasm.default));
      return module;
    })();
  }
  try {
    return await resvgModule;
  } catch (error) {
    resvgModule = null;
    throw error;
  }
}

async function renderVectorPngWithBrowser(
  svg: string,
  outputWidth: number,
  outputHeight: number,
): Promise<Uint8Array<ArrayBuffer>> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([svg], { type: "image/svg+xml" }));
  } catch {
    throw new Error("The browser-native contour renderer could not start. Your original is unchanged.");
  }
  try {
    const canvas = new OffscreenCanvas(outputWidth, outputHeight);
    const context = canvas.getContext("2d", { colorSpace: "srgb" });
    if (!context) throw new Error("Your browser could not allocate the contour result.");
    context.drawImage(bitmap, 0, 0, outputWidth, outputHeight);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

function getOrtModule(): Promise<OrtModule> {
  ortModule ??= import("onnxruntime-web/webgpu");
  return ortModule;
}

async function getModelSession(
  ort: OrtModule,
  variant: ModelVariant,
): Promise<import("onnxruntime-web").InferenceSession> {
  if (modelSessions[variant]) return modelSessions[variant];
  const spec = MODEL_SPECS[variant];
  const pendingSession = modelSessions[variant] = (async () => {
    const started = performance.now();
    ort.env.logLevel = "warning";
    let response: Response;
    try {
      response = await fetch(spec.url, { cache: "force-cache" });
    } catch {
      throw new Error("The local restoration model could not be loaded. Your original is unchanged.");
    }
    if (!response.ok) {
      throw new Error("The governed local restoration model is missing. Your original is unchanged.");
    }
    const announcedLength = response.headers.get("Content-Length");
    const announcedBytes = announcedLength === null ? null : Number(announcedLength);
    if (announcedBytes !== null && Number.isFinite(announcedBytes) && announcedBytes !== spec.bytes) {
      throw new Error("The restoration model failed its size check. Your original is unchanged.");
    }
    const model = await response.arrayBuffer();
    if (model.byteLength !== spec.bytes) {
      throw new Error("The restoration model failed its size check. Your original is unchanged.");
    }
    console.info(`[image-quality] model fetched in ${Math.round(performance.now() - started)} ms`);
    const digest = await crypto.subtle.digest("SHA-256", model);
    const actual = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
    if (actual !== spec.sha256) {
      throw new Error("The restoration model failed its integrity check. Your original is unchanged.");
    }
    console.info(`[image-quality] model integrity verified in ${Math.round(performance.now() - started)} ms`);
    try {
      const session = await ort.InferenceSession.create(model, {
        executionProviders: ["webgpu"],
        graphOptimizationLevel: "all",
      });
      console.info(`[image-quality] WebGPU session ready in ${Math.round(performance.now() - started)} ms`);
      return session;
    } catch {
      throw new Error("The WebGPU restoration model could not start on this device. Your original is unchanged.");
    }
  })();
  try {
    return await pendingSession;
  } catch (error) {
    delete modelSessions[variant];
    throw error;
  }
}

function modelInput(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  left: number,
  top: number,
): Float32Array {
  const plane = MODEL_TILE * MODEL_TILE;
  const input = new Float32Array(plane * 3);
  for (let y = 0; y < MODEL_TILE; y += 1) {
    const sourceY = Math.max(0, Math.min(height - 1, top - TILE_CONTEXT + y));
    for (let x = 0; x < MODEL_TILE; x += 1) {
      const sourceX = Math.max(0, Math.min(width - 1, left - TILE_CONTEXT + x));
      const sourceOffset = (sourceY * width + sourceX) * 4;
      const targetOffset = y * MODEL_TILE + x;
      input[targetOffset] = pixels[sourceOffset] / 255;
      input[plane + targetOffset] = pixels[sourceOffset + 1] / 255;
      input[plane * 2 + targetOffset] = pixels[sourceOffset + 2] / 255;
    }
  }
  return input;
}

function blendModelTile(
  output: Uint8ClampedArray,
  outputWidth: number,
  sourceTexture: Uint8Array,
  sourceWidth: number,
  restored: Float32Array,
  left: number,
  top: number,
  coreWidth: number,
  coreHeight: number,
  outputScale: 1 | 2 | 4,
  strength: number,
  modelTrust: number,
  skinToneProtection: Uint8Array | null,
): void {
  const restoredPlane = MODEL_OUTPUT_TILE * MODEL_OUTPUT_TILE;
  const samplingStep = MODEL_SCALE / outputScale;
  const targetWidth = coreWidth * outputScale;
  const targetHeight = coreHeight * outputScale;
  for (let y = 0; y < targetHeight; y += 1) {
    const modelY = TILE_CONTEXT * MODEL_SCALE + y * samplingStep;
    const outputY = top * outputScale + y;
    for (let x = 0; x < targetWidth; x += 1) {
      const modelX = TILE_CONTEXT * MODEL_SCALE + x * samplingStep;
      const outputOffset = (outputY * outputWidth + left * outputScale + x) * 4;
      const sourceX = Math.min(sourceWidth - 1, left + Math.floor(x / outputScale));
      const sourceY = top + Math.floor(y / outputScale);
      let learnedRed = 0;
      let learnedGreen = 0;
      let learnedBlue = 0;
      for (let channel = 0; channel < 3; channel += 1) {
        let sum = 0;
        for (let sampleY = 0; sampleY < samplingStep; sampleY += 1) {
          for (let sampleX = 0; sampleX < samplingStep; sampleX += 1) {
            const modelOffset = (modelY + sampleY) * MODEL_OUTPUT_TILE + modelX + sampleX;
            sum += restored[channel * restoredPlane + modelOffset];
          }
        }
        const learned = Math.max(0, Math.min(255, Math.round(sum * 255 / (samplingStep * samplingStep))));
        if (channel === 0) learnedRed = learned;
        else if (channel === 1) learnedGreen = learned;
        else learnedBlue = learned;
      }
      const learnedY = (learnedRed + learnedGreen * 2 + learnedBlue) / 4;
      // Measure learned detail at one source-pixel radius. A one-output-pixel
      // residual disappears when a 4x result is viewed at matching source
      // coordinates and was making illustrated photographs look softer.
      const detailRadius = MODEL_SCALE;
      const localLearnedY = (
        learnedY * 4
        + restoredLuma(restored, restoredPlane, modelX - detailRadius, modelY)
        + restoredLuma(restored, restoredPlane, modelX + detailRadius, modelY)
        + restoredLuma(restored, restoredPlane, modelX, modelY - detailRadius)
        + restoredLuma(restored, restoredPlane, modelX, modelY + detailRadius)
      ) / 8;
      fuseRestoredPixel(
        output,
        outputOffset,
        learnedRed,
        learnedGreen,
        learnedBlue,
        sourceTexture[sourceY * sourceWidth + sourceX],
        strength,
        learnedY - localLearnedY,
        modelTrust * (1 - (skinToneProtection?.[sourceY * sourceWidth + sourceX] ?? 0) / 255 * 0.78),
      );
    }
  }
}

function restoredLuma(
  restored: Float32Array,
  plane: number,
  x: number,
  y: number,
): number {
  const sampleX = Math.max(0, Math.min(MODEL_OUTPUT_TILE - 1, Math.round(x)));
  const sampleY = Math.max(0, Math.min(MODEL_OUTPUT_TILE - 1, Math.round(y)));
  const offset = sampleY * MODEL_OUTPUT_TILE + sampleX;
  return Math.max(0, Math.min(255, (
    restored[offset]
    + restored[plane + offset] * 2
    + restored[plane * 2 + offset]
  ) * 255 / 4));
}

workerScope.onmessage = (event) => {
  const request = event.data;
  if (request.type === "cancel") {
    cancelledRequests.add(request.targetId);
    return;
  }
  void (async () => {
    try {
      if (request.type === "load") {
        const loaded = await loadSource(request.source, request.id);
        workerScope.postMessage({ id: request.id, ok: true, type: "loaded", ...loaded });
        return;
      }
      const result = await enhance(request.strength, request.id, request.preferDeterministic);
      if (!result.bytes) throw new Error("The local worker did not encode its result.");
      workerScope.postMessage(
        { id: request.id, ok: true, type: "enhanced", ...result },
        [result.bytes],
      );
    } catch (error) {
      workerScope.postMessage({
        id: request.id,
        ok: false,
        message: error instanceof Error ? error.message : "Image processing did not complete.",
      });
    } finally {
      cancelledRequests.delete(request.id);
    }
  })();
};
