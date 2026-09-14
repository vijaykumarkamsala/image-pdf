import { initWasm, Resvg } from "@resvg/resvg-wasm";
import resvgWasmUrl from "@resvg/resvg-wasm/index_bg.wasm?url";
import ImageTracer from "imagetracerjs";

import type { ImageQualityAnalysis } from "./ImageQualityEngine";
import {
  classifyFlatGraphic,
  enhanceFlatGraphicPixels,
  enhancePixels,
} from "./imageQualityPipeline";

type OrtModule = typeof import("onnxruntime-web/webgpu");

type WorkerRequest =
  | { id: number; type: "load"; source: Blob }
  | { id: number; type: "enhance"; strength: number };

type WorkerResponse =
  | { id: number; ok: true; type: "loaded"; width: number; height: number; mediaType: string }
  | { id: number; ok: true; type: "enhanced"; width: number; height: number; mediaType: "image/png"; bytes: ArrayBuffer; analysis: ImageQualityAnalysis; engine: string; route: string }
  | { id: number; ok: false; message: string };

const workerScope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
};

const MAX_PIXELS = 80_000_000;
const MAX_OUTPUT_PIXELS = 100_000_000;
const MAX_CANVAS_EDGE = 16_384;
const MODEL_TILE = 128;
const TILE_CONTEXT = 10;
const CORE_TILE = MODEL_TILE - TILE_CONTEXT * 2;
const MODEL_SCALE = 4;
const MODEL_OUTPUT_TILE = MODEL_TILE * MODEL_SCALE;
const MODEL_URL = "/quality-models/realesr-general-x4v3-tile128.onnx";
const MODEL_BYTES = 4_959_082;
const MODEL_SHA256 = "5c5af5908e7438a965cffb1ba62a764e319aac069c35c50ba6851bb4a300760c";
const MAX_TRACE_EDGE = 1_024;
const MAX_VECTOR_MARKUP_BYTES = 16_000_000;
let sourcePixels: Uint8ClampedArray | null = null;
let sourceWidth = 0;
let sourceHeight = 0;
let sourceMediaType = "";
let ortModule: Promise<OrtModule> | null = null;
let modelSession: Promise<import("onnxruntime-web").InferenceSession> | null = null;
let resvgReady: Promise<void> | null = null;

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
  const classification = classifyFlatGraphic(sourcePixels, sourceWidth, sourceHeight);
  if (classification.isFlatGraphic) {
    const cleaned = enhanceFlatGraphicPixels(sourcePixels, sourceWidth, sourceHeight, strength);
    return renderFlatGraphic(cleaned.pixels, cleaned.analysis, strength);
  }
  const gpu = (navigator as typeof navigator & {
    gpu?: { requestAdapter(options: { powerPreference: string }): Promise<unknown | null> };
  }).gpu;
  if (!gpu) {
    throw new Error("WebGPU is unavailable. Open this page in a current Chrome or Edge browser.");
  }
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) {
    throw new Error("No usable WebGPU device was found. Enable hardware acceleration in Chrome or Edge.");
  }
  const ort = await getOrtModule();
  const session = await getModelSession(ort);
  const corrected = enhancePixels(sourcePixels, sourceWidth, sourceHeight, strength);
  const correctedCanvas = new OffscreenCanvas(sourceWidth, sourceHeight);
  const correctedContext = correctedCanvas.getContext("2d");
  if (!correctedContext) throw new Error("Your browser could not prepare corrected source pixels.");
  correctedContext.putImageData(
    new ImageData(new Uint8ClampedArray(corrected.pixels), sourceWidth, sourceHeight),
    0,
    0,
  );
  const outputScale = chooseOutputScale(sourceWidth, sourceHeight);
  const width = sourceWidth * outputScale;
  const height = sourceHeight * outputScale;
  const outputCanvas = new OffscreenCanvas(width, height);
  const outputContext = outputCanvas.getContext("2d", { willReadFrequently: true });
  if (!outputContext) throw new Error("Your browser could not allocate the enhanced image.");
  outputContext.imageSmoothingEnabled = true;
  outputContext.imageSmoothingQuality = "high";
  outputContext.drawImage(correctedCanvas, 0, 0, width, height);
  const outputImage = outputContext.getImageData(0, 0, width, height);
  const learnedFraction = 0.2 + Math.max(1, Math.min(100, strength)) / 100 * 0.8;
  let completedTiles = 0;
  const inferenceStarted = performance.now();

  for (let top = 0; top < sourceHeight; top += CORE_TILE) {
    for (let left = 0; left < sourceWidth; left += CORE_TILE) {
      const input = modelInput(corrected.pixels, sourceWidth, sourceHeight, left, top);
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
        const coreWidth = Math.min(CORE_TILE, sourceWidth - left);
        const coreHeight = Math.min(CORE_TILE, sourceHeight - top);
        blendModelTile(
          outputImage.data,
          width,
          restored.data,
          left,
          top,
          coreWidth,
          coreHeight,
          outputScale,
          learnedFraction,
        );
      } finally {
        restored?.dispose();
        tensor.dispose();
      }
    }
  }
  console.info(`[image-quality] ${completedTiles} WebGPU tiles completed in ${Math.round(performance.now() - inferenceStarted)} ms`);
  outputContext.putImageData(outputImage, 0, 0);
  const blob = await outputCanvas.convertToBlob({ type: "image/png" });
  const bytes = await blob.arrayBuffer();
  return {
    bytes,
    width,
    height,
    engine: "Real-ESRGAN General x4v3 · WebGPU",
    route: `photo-${outputScale === 4 ? "reconstruct-x4" : outputScale === 2 ? "reconstruct-x2" : "restore-native"}`,
    analysis: corrected.analysis,
  };
}

async function renderFlatGraphic(
  pixels: Uint8ClampedArray,
  analysis: ImageQualityAnalysis,
  strength: number,
) {
  const outputScale = chooseOutputScale(sourceWidth, sourceHeight);
  const traceScale = Math.min(1, MAX_TRACE_EDGE / Math.max(sourceWidth, sourceHeight));
  const traceWidth = Math.max(1, Math.round(sourceWidth * traceScale));
  const traceHeight = Math.max(1, Math.round(sourceHeight * traceScale));
  const sourceCanvas = new OffscreenCanvas(sourceWidth, sourceHeight);
  const sourceContext = sourceCanvas.getContext("2d");
  if (!sourceContext) throw new Error("Your browser could not prepare clean graphic pixels.");
  sourceContext.putImageData(new ImageData(new Uint8ClampedArray(pixels), sourceWidth, sourceHeight), 0, 0);
  const traceCanvas = new OffscreenCanvas(traceWidth, traceHeight);
  const traceContext = traceCanvas.getContext("2d", { willReadFrequently: true });
  if (!traceContext) throw new Error("Your browser could not prepare vector tracing pixels.");
  traceContext.imageSmoothingEnabled = true;
  traceContext.imageSmoothingQuality = "high";
  traceContext.drawImage(sourceCanvas, 0, 0, traceWidth, traceHeight);
  const tracePixels = traceContext.getImageData(0, 0, traceWidth, traceHeight);
  const amount = strength / 100;
  const rawSvg = ImageTracer.imagedataToSVG(tracePixels, {
    blurradius: 1,
    blurdelta: 24,
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
  if (rawSvg.length > MAX_VECTOR_MARKUP_BYTES || /<(?:script|foreignObject)|\b(?:href|src)=|url\s*\(/i.test(rawSvg)) {
    throw new Error("The reconstructed graphic exceeded the safe vector complexity budget. Your original is unchanged.");
  }
  const outputWidth = sourceWidth * outputScale;
  const outputHeight = sourceHeight * outputScale;
  const svg = rawSvg.replace(
    "<svg ",
    `<svg width="${outputWidth}" height="${outputHeight}" `,
  );
  resvgReady ??= initWasm(fetch(resvgWasmUrl));
  try {
    await resvgReady;
  } catch {
    resvgReady = null;
    throw new Error("The vector renderer could not start. Your original is unchanged.");
  }
  let renderer: InstanceType<typeof Resvg> | null = null;
  let rendered: ReturnType<InstanceType<typeof Resvg>["render"]> | null = null;
  try {
    renderer = new Resvg(svg, {
      fitTo: { mode: "width", value: outputWidth },
      font: { loadSystemFonts: false },
      imageRendering: 0,
      shapeRendering: 2,
    });
    rendered = renderer.render();
    if (rendered.width !== outputWidth || rendered.height !== outputHeight) {
      throw new Error("The vector renderer returned unexpected dimensions.");
    }
    const png = new Uint8Array(rendered.asPng());
    return {
      bytes: png.buffer,
      width: outputWidth,
      height: outputHeight,
      engine: "Bézier vector contour reconstruction · Worker",
      route: `flat-graphic-vector-x${outputScale}`,
      analysis,
    };
  } catch {
    throw new Error("The reconstructed curves could not be rendered within the local memory budget. Your original is unchanged.");
  } finally {
    rendered?.free();
    renderer?.free();
  }
}

function chooseOutputScale(width: number, height: number): 1 | 2 | 4 {
  const pixels = width * height;
  if (pixels * 16 <= MAX_OUTPUT_PIXELS && width * 4 <= MAX_CANVAS_EDGE && height * 4 <= MAX_CANVAS_EDGE) return 4;
  if (pixels * 4 <= MAX_OUTPUT_PIXELS && width * 2 <= MAX_CANVAS_EDGE && height * 2 <= MAX_CANVAS_EDGE) return 2;
  return 1;
}

function getOrtModule(): Promise<OrtModule> {
  ortModule ??= import("onnxruntime-web/webgpu");
  return ortModule;
}

async function getModelSession(ort: OrtModule): Promise<import("onnxruntime-web").InferenceSession> {
  if (modelSession) return modelSession;
  modelSession = (async () => {
    const started = performance.now();
    ort.env.logLevel = "warning";
    let response: Response;
    try {
      response = await fetch(MODEL_URL, { cache: "no-store" });
    } catch {
      throw new Error("The local restoration model could not be loaded. Your original is unchanged.");
    }
    if (!response.ok) {
      throw new Error("The governed local restoration model is missing. Your original is unchanged.");
    }
    const announcedLength = response.headers.get("Content-Length");
    const announcedBytes = announcedLength === null ? null : Number(announcedLength);
    if (announcedBytes !== null && Number.isFinite(announcedBytes) && announcedBytes !== MODEL_BYTES) {
      throw new Error("The restoration model failed its size check. Your original is unchanged.");
    }
    const model = await response.arrayBuffer();
    if (model.byteLength !== MODEL_BYTES) {
      throw new Error("The restoration model failed its size check. Your original is unchanged.");
    }
    console.info(`[image-quality] model fetched in ${Math.round(performance.now() - started)} ms`);
    const digest = await crypto.subtle.digest("SHA-256", model);
    const actual = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
    if (actual !== MODEL_SHA256) {
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
    return await modelSession;
  } catch (error) {
    modelSession = null;
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
  restored: Float32Array,
  left: number,
  top: number,
  coreWidth: number,
  coreHeight: number,
  outputScale: 1 | 2 | 4,
  learnedFraction: number,
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
      for (let channel = 0; channel < 3; channel += 1) {
        let sum = 0;
        for (let sampleY = 0; sampleY < samplingStep; sampleY += 1) {
          for (let sampleX = 0; sampleX < samplingStep; sampleX += 1) {
            const modelOffset = (modelY + sampleY) * MODEL_OUTPUT_TILE + modelX + sampleX;
            sum += restored[channel * restoredPlane + modelOffset];
          }
        }
        const learned = Math.max(0, Math.min(255, Math.round(sum * 255 / (samplingStep * samplingStep))));
        output[outputOffset + channel] = Math.round(output[outputOffset + channel] * (1 - learnedFraction) + learned * learnedFraction);
      }
    }
  }
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
