/// <reference lib="webworker" />

import {
  applyColorToRgba,
  assertBrowserColorBudget,
  isNeutralColor,
  sanitizeColorRecipe,
  type ImageColorRecipe,
  type ImageColorStatistics,
} from "./imageColor";
import { pngOutputSha256, tagColorPng, type PngColorMetadata } from "./pngMetadata";

declare const self: DedicatedWorkerGlobalScope;

type Request =
  | { id: number; type: "load"; source: Blob }
  | { id: number; type: "render"; recipe: ImageColorRecipe; metadata: Omit<PngColorMetadata, "recipe" | "statistics"> };

let bitmap: ImageBitmap | null = null;
const MAX_CANVAS_EDGE = 16_384;
const TILE_PIXELS = 1_048_576;

function fail(id: number, error: unknown) {
  self.postMessage({
    id,
    ok: false,
    message: error instanceof Error ? error.message : "The colour adjustment could not be rendered.",
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

function addStatistics(target: ImageColorStatistics, next: ImageColorStatistics) {
  target.processedPixels += next.processedPixels;
  target.changedPixels += next.changedPixels;
  target.gamutClippedPixels += next.gamutClippedPixels;
}

async function render(
  id: number,
  recipe: ImageColorRecipe,
  metadata: Omit<PngColorMetadata, "recipe" | "statistics">,
) {
  if (!bitmap) throw new Error("The image must be prepared before applying colour adjustments.");
  const safe = sanitizeColorRecipe(recipe);
  if (isNeutralColor(safe)) throw new Error("Choose at least one non-neutral colour adjustment before applying.");
  if (bitmap.width > MAX_CANVAS_EDGE || bitmap.height > MAX_CANVAS_EDGE) {
    throw new Error(
      `This colour adjustment requires ${bitmap.width} × ${bitmap.height} px, beyond this browser's ${MAX_CANVAS_EDGE}px canvas edge. No smaller result was substituted.`,
    );
  }
  assertBrowserColorBudget(bitmap.width, bitmap.height);
  if (metadata.outputWidth !== bitmap.width || metadata.outputHeight !== bitmap.height) {
    throw new Error("The requested colour-adjustment dimensions do not match the verified base image.");
  }

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d", { colorSpace: "srgb", alpha: true, willReadFrequently: true });
  if (!context) throw new Error("Your browser could not allocate the colour-adjustment renderer.");
  context.drawImage(bitmap, 0, 0);
  const rowsPerTile = Math.max(1, Math.floor(TILE_PIXELS / bitmap.width));
  const statistics: ImageColorStatistics = { processedPixels: 0, changedPixels: 0, gamutClippedPixels: 0 };
  for (let y = 0; y < bitmap.height; y += rowsPerTile) {
    const height = Math.min(rowsPerTile, bitmap.height - y);
    const imageData = context.getImageData(0, y, bitmap.width, height);
    addStatistics(statistics, applyColorToRgba(imageData.data, safe));
    context.putImageData(imageData, 0, y);
  }
  if (statistics.changedPixels === 0) {
    throw new Error("These colour settings did not change any visible pixels. No duplicate derivative was created.");
  }

  const raw = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
  const tagged = tagColorPng(raw, { ...metadata, recipe: safe, statistics });
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
