/// <reference lib="webworker" />

import {
  applyEffectsToRgba,
  assertBrowserEffectsBudget,
  isNeutralEffects,
  sanitizeEffectsRecipe,
  type ImageEffectsRecipe,
  type ImageEffectsStatistics,
} from "./imageEffects";
import { pngOutputSha256, tagEffectPng, type PngEffectMetadata } from "./pngMetadata";

declare const self: DedicatedWorkerGlobalScope;

type Request =
  | { id: number; type: "load"; source: Blob }
  | { id: number; type: "render"; recipe: ImageEffectsRecipe; metadata: Omit<PngEffectMetadata, "recipe" | "statistics"> };

let bitmap: ImageBitmap | null = null;
const MAX_CANVAS_EDGE = 16_384;
const TILE_PIXELS = 1_048_576;

function fail(id: number, error: unknown) {
  self.postMessage({
    id,
    ok: false,
    message: error instanceof Error ? error.message : "The effects adjustment could not be rendered.",
  });
}

async function load(id: number, source: Blob) {
  const decoded = await createImageBitmap(source, {
    colorSpaceConversion: "default",
    imageOrientation: "from-image",
    premultiplyAlpha: "premultiply",
  });
  bitmap?.close();
  bitmap = decoded;
  self.postMessage({ id, ok: true, type: "loaded", width: decoded.width, height: decoded.height });
}

function addStatistics(target: ImageEffectsStatistics, next: ImageEffectsStatistics) {
  target.processedPixels += next.processedPixels;
  target.changedPixels += next.changedPixels;
  target.darkenedPixels += next.darkenedPixels;
  target.lightenedPixels += next.lightenedPixels;
}

async function render(
  id: number,
  recipe: ImageEffectsRecipe,
  metadata: Omit<PngEffectMetadata, "recipe" | "statistics">,
) {
  if (!bitmap) throw new Error("The image must be prepared before applying effects.");
  const safe = sanitizeEffectsRecipe(recipe);
  if (isNeutralEffects(safe)) throw new Error("Choose a non-neutral vignette amount before applying effects.");
  if (bitmap.width > MAX_CANVAS_EDGE || bitmap.height > MAX_CANVAS_EDGE) {
    throw new Error(
      `This effect requires ${bitmap.width} × ${bitmap.height} px, beyond this browser's ${MAX_CANVAS_EDGE}px canvas edge. No smaller result was substituted.`,
    );
  }
  assertBrowserEffectsBudget(bitmap.width, bitmap.height);
  if (metadata.outputWidth !== bitmap.width || metadata.outputHeight !== bitmap.height) {
    throw new Error("The requested effect dimensions do not match the verified base image.");
  }

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d", { colorSpace: "srgb", alpha: true, willReadFrequently: true });
  if (!context) throw new Error("Your browser could not allocate the effects renderer.");
  context.drawImage(bitmap, 0, 0);
  const rowsPerTile = Math.max(1, Math.floor(TILE_PIXELS / bitmap.width));
  const statistics: ImageEffectsStatistics = {
    processedPixels: 0,
    changedPixels: 0,
    darkenedPixels: 0,
    lightenedPixels: 0,
  };
  for (let y = 0; y < bitmap.height; y += rowsPerTile) {
    const height = Math.min(rowsPerTile, bitmap.height - y);
    const imageData = context.getImageData(0, y, bitmap.width, height);
    addStatistics(statistics, applyEffectsToRgba(imageData.data, safe, bitmap.width, bitmap.height, y));
    context.putImageData(imageData, 0, y);
  }
  if (statistics.changedPixels === 0) {
    throw new Error("These effect settings did not change any visible pixels. No duplicate derivative was created.");
  }

  const raw = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
  const tagged = tagEffectPng(raw, { ...metadata, recipe: safe, statistics });
  const bytes = tagged.buffer.slice(tagged.byteOffset, tagged.byteOffset + tagged.byteLength);
  self.postMessage({
    id,
    ok: true,
    type: "rendered",
    bytes,
    width: bitmap.width,
    height: bitmap.height,
    outputSha256: pngOutputSha256(tagged),
    statistics,
  }, { transfer: [bytes] });
}

self.onmessage = (event: MessageEvent<Request>) => {
  const message = event.data;
  void (message.type === "load"
    ? load(message.id, message.source)
    : render(message.id, message.recipe, message.metadata))
    .catch((error) => fail(message.id, error));
};

self.addEventListener("close", () => bitmap?.close());

export {};
