/// <reference lib="webworker" />

import {
  applyNeighbourhoodToneToRgba,
  applyToneToRgba,
  assertBrowserToneBudget,
  clarityRadii,
  isNeutralTone,
  localContrastRadius,
  sanitizeToneRecipe,
  textureRadius,
  type ImageToneRecipe,
  type ImageToneStatistics,
} from "./imageTone";
import { pngOutputSha256, tagTonePng, type PngToneMetadata } from "./pngMetadata";

declare const self: DedicatedWorkerGlobalScope;

type Request =
  | { id: number; type: "load"; source: Blob }
  | { id: number; type: "render"; recipe: ImageToneRecipe; metadata: Omit<PngToneMetadata, "recipe" | "statistics"> };

let bitmap: ImageBitmap | null = null;
const MAX_CANVAS_EDGE = 16_384;
const TILE_PIXELS = 1_048_576;

function fail(id: number, error: unknown) {
  self.postMessage({
    id,
    ok: false,
    message: error instanceof Error ? error.message : "The light adjustment could not be rendered.",
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

function addStatistics(target: ImageToneStatistics, next: ImageToneStatistics) {
  target.processedPixels += next.processedPixels;
  target.changedPixels += next.changedPixels;
  target.newShadowClippedPixels += next.newShadowClippedPixels;
  target.newHighlightClippedPixels += next.newHighlightClippedPixels;
}

function compareCoreStatistics(
  sourceTile: Uint8ClampedArray,
  width: number,
  coreTop: number,
  output: Uint8ClampedArray,
): ImageToneStatistics {
  const statistics: ImageToneStatistics = {
    processedPixels: 0,
    changedPixels: 0,
    newShadowClippedPixels: 0,
    newHighlightClippedPixels: 0,
  };
  const coreHeight = output.byteLength / 4 / width;
  for (let y = 0; y < coreHeight; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceOffset = ((coreTop + y) * width + x) * 4;
      const outputOffset = (y * width + x) * 4;
      if (sourceTile[sourceOffset + 3] === 0) continue;
      statistics.processedPixels += 1;
      const beforeRed = sourceTile[sourceOffset];
      const beforeGreen = sourceTile[sourceOffset + 1];
      const beforeBlue = sourceTile[sourceOffset + 2];
      const outputRed = output[outputOffset];
      const outputGreen = output[outputOffset + 1];
      const outputBlue = output[outputOffset + 2];
      if (beforeRed !== outputRed || beforeGreen !== outputGreen || beforeBlue !== outputBlue) {
        statistics.changedPixels += 1;
      }
      const beforeShadowClipped = beforeRed <= 1 && beforeGreen <= 1 && beforeBlue <= 1;
      const beforeHighlightClipped = beforeRed >= 254 && beforeGreen >= 254 && beforeBlue >= 254;
      if (!beforeShadowClipped && outputRed <= 1 && outputGreen <= 1 && outputBlue <= 1) {
        statistics.newShadowClippedPixels += 1;
      }
      if (!beforeHighlightClipped && outputRed >= 254 && outputGreen >= 254 && outputBlue >= 254) {
        statistics.newHighlightClippedPixels += 1;
      }
    }
  }
  return statistics;
}

async function render(
  id: number,
  recipe: ImageToneRecipe,
  metadata: Omit<PngToneMetadata, "recipe" | "statistics">,
) {
  if (!bitmap) throw new Error("The image must be prepared before applying light adjustments.");
  const safe = sanitizeToneRecipe(recipe);
  if (isNeutralTone(safe)) throw new Error("Choose at least one non-neutral light adjustment before applying.");
  if (bitmap.width > MAX_CANVAS_EDGE || bitmap.height > MAX_CANVAS_EDGE) {
    throw new Error(
      `This light adjustment requires ${bitmap.width} × ${bitmap.height} px, beyond this browser's ${MAX_CANVAS_EDGE}px canvas edge. No smaller result was substituted.`,
    );
  }
  assertBrowserToneBudget(bitmap.width, bitmap.height);
  if (metadata.outputWidth !== bitmap.width || metadata.outputHeight !== bitmap.height) {
    throw new Error("The requested light-adjustment dimensions do not match the verified base image.");
  }

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d", { colorSpace: "srgb", alpha: true, willReadFrequently: true });
  if (!context) throw new Error("Your browser could not allocate the light-adjustment renderer.");
  const rowsPerTile = Math.max(1, Math.floor(TILE_PIXELS / bitmap.width));
  const statistics: ImageToneStatistics = {
    processedPixels: 0,
    changedPixels: 0,
    newShadowClippedPixels: 0,
    newHighlightClippedPixels: 0,
  };
  if (safe.localContrast === 0 && safe.clarity === 0 && safe.texture === 0) {
    context.drawImage(bitmap, 0, 0);
    for (let y = 0; y < bitmap.height; y += rowsPerTile) {
      const height = Math.min(rowsPerTile, bitmap.height - y);
      const imageData = context.getImageData(0, y, bitmap.width, height);
      addStatistics(statistics, applyToneToRgba(imageData.data, safe));
      context.putImageData(imageData, 0, y);
    }
  } else {
    const localRadius = localContrastRadius(bitmap.width, bitmap.height);
    const clarityRadius = clarityRadii(bitmap.width, bitmap.height);
    const fineRadius = textureRadius(bitmap.width, bitmap.height);
    const haloRadius = Math.max(
      safe.localContrast === 0 ? 0 : localRadius,
      safe.clarity === 0 ? 0 : clarityRadius.outer,
      safe.texture === 0 ? 0 : fineRadius,
    );
    const globalRecipe = { ...safe, localContrast: 0, clarity: 0, texture: 0 };
    const globalToneIsNeutral = isNeutralTone(globalRecipe);
    for (let y = 0; y < bitmap.height; y += rowsPerTile) {
      const height = Math.min(rowsPerTile, bitmap.height - y);
      const tileTop = Math.max(0, y - haloRadius);
      const tileBottom = Math.min(bitmap.height, y + height + haloRadius);
      const tileHeight = tileBottom - tileTop;
      const tileCanvas = new OffscreenCanvas(bitmap.width, tileHeight);
      const tileContext = tileCanvas.getContext("2d", { colorSpace: "srgb", alpha: true, willReadFrequently: true });
      if (!tileContext) throw new Error("Your browser could not allocate the neighbourhood-tone tile renderer.");
      tileContext.drawImage(
        bitmap,
        0,
        tileTop,
        bitmap.width,
        tileHeight,
        0,
        0,
        bitmap.width,
        tileHeight,
      );
      const sourceTile = tileContext.getImageData(0, 0, bitmap.width, tileHeight).data;
      const coreTop = y - tileTop;
      const core = applyNeighbourhoodToneToRgba(
        sourceTile,
        bitmap.width,
        tileHeight,
        coreTop,
        height,
        {
          localContrast: safe.localContrast,
          localRadius,
          clarity: safe.clarity,
          clarityRadius,
          texture: safe.texture,
          textureRadius: fineRadius,
        },
      );
      if (!globalToneIsNeutral) applyToneToRgba(core, globalRecipe);
      addStatistics(statistics, compareCoreStatistics(sourceTile, bitmap.width, coreTop, core));
      const outputImageData = new ImageData(bitmap.width, height);
      outputImageData.data.set(core);
      context.putImageData(outputImageData, 0, y);
    }
  }
  if (statistics.changedPixels === 0) {
    throw new Error("These light settings did not change any visible pixels. No duplicate derivative was created.");
  }

  const raw = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
  const tagged = tagTonePng(raw, { ...metadata, recipe: safe, statistics });
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
