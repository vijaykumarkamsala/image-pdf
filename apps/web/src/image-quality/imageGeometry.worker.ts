/// <reference lib="webworker" />

import {
  geometryNaturalDimensions,
  geometryOutputDimensions,
  sanitizeGeometryRecipe,
  straightenCoverScale,
  type ImageGeometryRecipe,
} from "./imageGeometry";
import { pngOutputSha256, tagGeometryPng, type PngGeometryMetadata } from "./pngMetadata";

declare const self: DedicatedWorkerGlobalScope;

type Request =
  | { id: number; type: "load"; source: Blob }
  | { id: number; type: "render"; recipe: ImageGeometryRecipe; metadata: PngGeometryMetadata };

let bitmap: ImageBitmap | null = null;
const MAX_CANVAS_EDGE = 16_384;

function fail(id: number, error: unknown) {
  self.postMessage({
    id,
    ok: false,
    message: error instanceof Error ? error.message : "The geometry edit could not be rendered.",
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

async function render(id: number, recipe: ImageGeometryRecipe, metadata: PngGeometryMetadata) {
  if (!bitmap) throw new Error("The source must be prepared before applying geometry edits.");
  const safe = sanitizeGeometryRecipe(recipe, bitmap.width, bitmap.height);
  const natural = geometryNaturalDimensions(safe);
  const output = geometryOutputDimensions(safe);
  if (output.width > MAX_CANVAS_EDGE || output.height > MAX_CANVAS_EDGE) {
    throw new Error(
      `This geometry result requires ${output.width} × ${output.height} px, beyond this browser's ${MAX_CANVAS_EDGE}px canvas edge. No smaller result was substituted.`,
    );
  }
  if (metadata.outputWidth !== output.width || metadata.outputHeight !== output.height) {
    throw new Error("The requested geometry dimensions do not match the verified edit recipe.");
  }

  const canvas = new OffscreenCanvas(output.width, output.height);
  const context = canvas.getContext("2d", { colorSpace: "srgb", alpha: true });
  if (!context) throw new Error("Your browser could not allocate the geometry renderer.");
  const radians = safe.straighten * Math.PI / 180;
  const quarterRadians = safe.quarterTurns * Math.PI / 2;
  const cover = safe.straighten === 0
    ? 1
    : straightenCoverScale(natural.width, natural.height, safe.straighten) * 1.002;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.translate(output.width / 2, output.height / 2);
  context.scale(output.width / natural.width, output.height / natural.height);
  context.rotate(quarterRadians + radians);
  context.scale(
    cover * (safe.flipHorizontal ? -1 : 1),
    cover * (safe.flipVertical ? -1 : 1),
  );
  context.drawImage(
    bitmap,
    safe.crop.x,
    safe.crop.y,
    safe.crop.width,
    safe.crop.height,
    -safe.crop.width / 2,
    -safe.crop.height / 2,
    safe.crop.width,
    safe.crop.height,
  );

  const raw = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
  const tagged = tagGeometryPng(raw, metadata);
  const bytes = tagged.buffer.slice(tagged.byteOffset, tagged.byteOffset + tagged.byteLength);
  self.postMessage({
    id,
    ok: true,
    type: "rendered",
    bytes,
    width: output.width,
    height: output.height,
    outputSha256: pngOutputSha256(tagged),
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
