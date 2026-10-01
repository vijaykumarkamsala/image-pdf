/// <reference lib="webworker" />

import {
  accumulateImageHistogram,
  assertBrowserHistogramBudget,
  createImageHistogramAccumulator,
  finalizeImageHistogram,
} from "./imageHistogram";

declare const self: DedicatedWorkerGlobalScope;

interface Request {
  id: number;
  source: Blob;
  expectedWidth: number;
  expectedHeight: number;
}

const MAX_CANVAS_EDGE = 16_384;
const TILE_PIXELS = 1_048_576;

async function analyze(message: Request) {
  const bitmap = await createImageBitmap(message.source, {
    colorSpaceConversion: "default",
    imageOrientation: "from-image",
    premultiplyAlpha: "premultiply",
  });
  try {
    if (bitmap.width !== message.expectedWidth || bitmap.height !== message.expectedHeight) {
      throw new Error(
        `Histogram decoded ${bitmap.width} × ${bitmap.height} px instead of the verified `
        + `${message.expectedWidth} × ${message.expectedHeight} px preview. No analysis was shown.`,
      );
    }
    if (bitmap.width > MAX_CANVAS_EDGE || bitmap.height > MAX_CANVAS_EDGE) {
      throw new Error(
        `Histogram analysis requires ${bitmap.width} × ${bitmap.height} px, beyond this browser's `
        + `${MAX_CANVAS_EDGE}px canvas edge. No sampled substitute was shown.`,
      );
    }
    assertBrowserHistogramBudget(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { colorSpace: "srgb", alpha: true, willReadFrequently: true });
    if (!context) throw new Error("Your browser could not allocate the histogram analyser.");
    context.drawImage(bitmap, 0, 0);
    const accumulator = createImageHistogramAccumulator();
    const rowsPerTile = Math.max(1, Math.floor(TILE_PIXELS / bitmap.width));
    for (let y = 0; y < bitmap.height; y += rowsPerTile) {
      const height = Math.min(rowsPerTile, bitmap.height - y);
      accumulateImageHistogram(accumulator, context.getImageData(0, y, bitmap.width, height).data);
    }
    const summary = finalizeImageHistogram(accumulator, bitmap.width, bitmap.height);
    self.postMessage({
      id: message.id,
      ok: true,
      result: { width: bitmap.width, height: bitmap.height, summary },
    });
  } finally {
    bitmap.close();
  }
}

self.onmessage = (event: MessageEvent<Request>) => {
  void analyze(event.data).catch((error) => self.postMessage({
    id: event.data.id,
    ok: false,
    message: error instanceof Error ? error.message : "Histogram analysis did not complete.",
  }));
};

export {};

