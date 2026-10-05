/// <reference lib="webworker" />

import { assertBrowserColorBudget } from "./imageColor";
import {
  assertImageExportInspection,
  IMAGE_EXPORT_MEDIA_TYPES,
  sanitizeImageExportSettings,
  type ImageExportSettings,
} from "./imageExport";
import { inspectImageFile } from "./imageFileInspection";
import { sha256Blob, sha256Bytes } from "./sha256";

declare const self: DedicatedWorkerGlobalScope;

interface ExportRequest {
  id: number;
  type: "export";
  source: Blob;
  expectedSourceSha256: string;
  settings: ImageExportSettings;
  expectedWidth: number;
  expectedHeight: number;
}

const MAX_CANVAS_EDGE = 16_384;
const TILE_PIXELS = 1_048_576;

async function exportImage(message: ExportRequest) {
  const settings = sanitizeImageExportSettings(message.settings);
  const sourceSha256 = await sha256Blob(message.source);
  if (sourceSha256 !== message.expectedSourceSha256) {
    throw new Error("The export source bytes do not match the verified derivative. Prepare the latest edit again.");
  }
  const sourceInspection = await inspectImageFile(message.source);
  if (sourceInspection.width !== message.expectedWidth || sourceInspection.height !== message.expectedHeight) {
    throw new Error(
      `The verified export source is ${sourceInspection.width} × ${sourceInspection.height} px instead of the expected `
      + `${message.expectedWidth} × ${message.expectedHeight} px. Prepare the latest edit before exporting.`,
    );
  }

  if (settings.format === "png" && sourceInspection.mediaType === "image/png") {
    const raw = new Uint8Array(await message.source.arrayBuffer());
    const bytes = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    assertImageExportInspection(sourceInspection, settings.format, message.expectedWidth, message.expectedHeight);
    self.postMessage({
      id: message.id,
      ok: true,
      type: "exported",
      bytes,
      width: sourceInspection.width,
      height: sourceInspection.height,
      mediaType: sourceInspection.mediaType,
      byteSize: raw.byteLength,
      outputSha256: sha256Bytes(raw),
      transparentPixels: sourceInspection.hasAlpha,
      transparencyFlattened: false,
    }, { transfer: [bytes] });
    return;
  }

  const bitmap = await createImageBitmap(message.source, {
    colorSpaceConversion: "default",
    imageOrientation: "from-image",
    premultiplyAlpha: "premultiply",
  });
  try {
    if (bitmap.width !== message.expectedWidth || bitmap.height !== message.expectedHeight) {
      throw new Error(
        `The export decoder returned ${bitmap.width} × ${bitmap.height} px instead of the verified `
        + `${message.expectedWidth} × ${message.expectedHeight} px.`,
      );
    }
    if (bitmap.width > MAX_CANVAS_EDGE || bitmap.height > MAX_CANVAS_EDGE) {
      throw new Error(
        `This export requires ${bitmap.width} × ${bitmap.height} px, beyond this browser's `
        + `${MAX_CANVAS_EDGE}px canvas edge. No smaller or silently clamped export was created.`,
      );
    }
    assertBrowserColorBudget(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { colorSpace: "srgb", alpha: true, willReadFrequently: true });
    if (!context) throw new Error("Your browser could not allocate the export renderer.");
    context.clearRect(0, 0, bitmap.width, bitmap.height);
    context.drawImage(bitmap, 0, 0);

    let transparentPixels = false;
    const rowsPerTile = Math.max(1, Math.floor(TILE_PIXELS / bitmap.width));
    for (let y = 0; y < bitmap.height && !transparentPixels; y += rowsPerTile) {
      const height = Math.min(rowsPerTile, bitmap.height - y);
      const pixels = context.getImageData(0, y, bitmap.width, height).data;
      for (let index = 3; index < pixels.length; index += 4) {
        if (pixels[index] < 255) {
          transparentPixels = true;
          break;
        }
      }
    }

    let transparencyFlattened = false;
    if (settings.format === "jpeg" && transparentPixels) {
      if (settings.jpegMatte === "reject") {
        throw new Error(
          "This image contains transparent pixels. Choose a white or black JPEG background, or export PNG/WebP to preserve transparency.",
        );
      }
      context.globalCompositeOperation = "destination-over";
      context.fillStyle = settings.jpegMatte === "black" ? "#000000" : "#ffffff";
      context.fillRect(0, 0, bitmap.width, bitmap.height);
      context.globalCompositeOperation = "source-over";
      transparencyFlattened = true;
    }

    const mediaType = IMAGE_EXPORT_MEDIA_TYPES[settings.format];
    const encoded = await canvas.convertToBlob({
      type: mediaType,
      quality: settings.format === "png" ? undefined : settings.quality / 100,
    });
    const inspection = await inspectImageFile(encoded);
    assertImageExportInspection(inspection, settings.format, message.expectedWidth, message.expectedHeight);
    if (settings.format === "webp" && transparentPixels && !inspection.hasAlpha) {
      throw new Error("The browser WebP encoder removed transparency. No lossy export was created; use PNG instead.");
    }
    const raw = new Uint8Array(await encoded.arrayBuffer());
    const bytes = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    self.postMessage({
      id: message.id,
      ok: true,
      type: "exported",
      bytes,
      width: inspection.width,
      height: inspection.height,
      mediaType: inspection.mediaType,
      byteSize: raw.byteLength,
      outputSha256: sha256Bytes(raw),
      transparentPixels,
      transparencyFlattened,
    }, { transfer: [bytes] });
  } finally {
    bitmap.close();
  }
}

self.onmessage = (event: MessageEvent<ExportRequest>) => {
  void exportImage(event.data).catch((error) => self.postMessage({
    id: event.data.id,
    ok: false,
    message: error instanceof Error ? error.message : "The image export could not be prepared.",
  }));
};

export {};
