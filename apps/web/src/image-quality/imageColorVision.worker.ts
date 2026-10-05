/// <reference lib="webworker" />

import { assertBrowserColorBudget } from "./imageColor";
import {
  applyColorVisionToRgba,
  type ImageColorVisionMode,
  type ImageColorVisionStatistics,
} from "./imageColorVision";
import { sha256Bytes } from "./sha256";

declare const self: DedicatedWorkerGlobalScope;

interface RenderRequest {
  id: number;
  type: "render";
  source: Blob;
  mode: ImageColorVisionMode;
  expectedWidth: number;
  expectedHeight: number;
}

const MAX_CANVAS_EDGE = 16_384;
const TILE_PIXELS = 1_048_576;

function addStatistics(target: ImageColorVisionStatistics, next: ImageColorVisionStatistics) {
  target.processedPixels += next.processedPixels;
  target.changedPixels += next.changedPixels;
  target.clippedChannels += next.clippedChannels;
}

async function render(message: RenderRequest) {
  const bitmap = await createImageBitmap(message.source, {
    colorSpaceConversion: "default",
    imageOrientation: "from-image",
    premultiplyAlpha: "premultiply",
  });
  try {
    if (bitmap.width !== message.expectedWidth || bitmap.height !== message.expectedHeight) {
      throw new Error(
        `The colour-vision decoder returned ${bitmap.width} × ${bitmap.height} px instead of the verified `
        + `${message.expectedWidth} × ${message.expectedHeight} px.`,
      );
    }
    if (bitmap.width > MAX_CANVAS_EDGE || bitmap.height > MAX_CANVAS_EDGE) {
      throw new Error(
        `This colour-vision preview requires ${bitmap.width} × ${bitmap.height} px, beyond this browser's `
        + `${MAX_CANVAS_EDGE}px canvas edge. The verified image remains unchanged.`,
      );
    }
    assertBrowserColorBudget(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { colorSpace: "srgb", alpha: true, willReadFrequently: true });
    if (!context) throw new Error("Your browser could not allocate the colour-vision preview renderer.");
    context.drawImage(bitmap, 0, 0);
    const rowsPerTile = Math.max(1, Math.floor(TILE_PIXELS / bitmap.width));
    const statistics: ImageColorVisionStatistics = { processedPixels: 0, changedPixels: 0, clippedChannels: 0 };
    for (let y = 0; y < bitmap.height; y += rowsPerTile) {
      const height = Math.min(rowsPerTile, bitmap.height - y);
      const imageData = context.getImageData(0, y, bitmap.width, height);
      addStatistics(statistics, applyColorVisionToRgba(imageData.data, message.mode));
      context.putImageData(imageData, 0, y);
    }
    const raw = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
    const bytes = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    self.postMessage({
      id: message.id,
      ok: true,
      type: "rendered",
      bytes,
      width: bitmap.width,
      height: bitmap.height,
      outputSha256: sha256Bytes(raw),
      statistics,
    }, { transfer: [bytes] });
  } finally {
    bitmap.close();
  }
}

self.onmessage = (event: MessageEvent<RenderRequest>) => {
  void render(event.data).catch((error) => self.postMessage({
    id: event.data.id,
    ok: false,
    message: error instanceof Error ? error.message : "The colour-vision preview could not be rendered.",
  }));
};

export {};
