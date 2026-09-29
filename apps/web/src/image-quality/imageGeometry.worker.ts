/// <reference lib="webworker" />

import {
  assertBrowserPerspectiveBudget,
  geometryNaturalDimensions,
  geometryOutputDimensions,
  perspectiveIsIdentity,
  perspectiveTransform,
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

function perspectiveCanvas(source: ImageBitmap, recipe: ImageGeometryRecipe): OffscreenCanvas | null {
  if (!recipe.perspective || perspectiveIsIdentity(recipe.perspective)) return null;
  const width = recipe.crop.width;
  const height = recipe.crop.height;
  assertBrowserPerspectiveBudget(width, height);
  const sourceCanvas = new OffscreenCanvas(width, height);
  const sourceContext = sourceCanvas.getContext("2d", { colorSpace: "srgb", alpha: true, willReadFrequently: true });
  if (!sourceContext) throw new Error("Your browser could not allocate the perspective source buffer.");
  sourceContext.drawImage(
    source,
    recipe.crop.x,
    recipe.crop.y,
    width,
    height,
    0,
    0,
    width,
    height,
  );
  const sourcePixels = sourceContext.getImageData(0, 0, width, height).data;
  const outputCanvas = new OffscreenCanvas(width, height);
  const outputContext = outputCanvas.getContext("2d", { colorSpace: "srgb", alpha: true });
  if (!outputContext) throw new Error("Your browser could not allocate the perspective output buffer.");
  const output = outputContext.createImageData(width, height);
  const targetPixels = output.data;
  const transform = perspectiveTransform(recipe.perspective);
  const maximumX = Math.max(0, width - 1);
  const maximumY = Math.max(0, height - 1);
  const denominatorX = Math.max(1, maximumX);
  const denominatorY = Math.max(1, maximumY);

  for (let targetY = 0; targetY < height; targetY += 1) {
    const normalizedY = targetY / denominatorY;
    for (let targetX = 0; targetX < width; targetX += 1) {
      const normalizedX = targetX / denominatorX;
      const perspectiveDenominator = transform.g * normalizedX + transform.h * normalizedY + 1;
      const mappedX = (transform.a * normalizedX + transform.b * normalizedY + transform.c) / perspectiveDenominator;
      const mappedY = (transform.d * normalizedX + transform.e * normalizedY + transform.f) / perspectiveDenominator;
      const sourceX = Math.min(maximumX, Math.max(0, mappedX * maximumX));
      const sourceY = Math.min(maximumY, Math.max(0, mappedY * maximumY));
      const x0 = Math.floor(sourceX);
      const y0 = Math.floor(sourceY);
      const x1 = Math.min(maximumX, x0 + 1);
      const y1 = Math.min(maximumY, y0 + 1);
      const fractionX = sourceX - x0;
      const fractionY = sourceY - y0;
      const inverseX = 1 - fractionX;
      const inverseY = 1 - fractionY;
      const weight00 = inverseX * inverseY;
      const weight10 = fractionX * inverseY;
      const weight01 = inverseX * fractionY;
      const weight11 = fractionX * fractionY;
      const offset00 = (y0 * width + x0) * 4;
      const offset10 = (y0 * width + x1) * 4;
      const offset01 = (y1 * width + x0) * 4;
      const offset11 = (y1 * width + x1) * 4;
      const contribution00 = weight00 * sourcePixels[offset00 + 3] / 255;
      const contribution10 = weight10 * sourcePixels[offset10 + 3] / 255;
      const contribution01 = weight01 * sourcePixels[offset01 + 3] / 255;
      const contribution11 = weight11 * sourcePixels[offset11 + 3] / 255;
      const alpha = contribution00 + contribution10 + contribution01 + contribution11;
      const red = sourcePixels[offset00] * contribution00 + sourcePixels[offset10] * contribution10
        + sourcePixels[offset01] * contribution01 + sourcePixels[offset11] * contribution11;
      const green = sourcePixels[offset00 + 1] * contribution00 + sourcePixels[offset10 + 1] * contribution10
        + sourcePixels[offset01 + 1] * contribution01 + sourcePixels[offset11 + 1] * contribution11;
      const blue = sourcePixels[offset00 + 2] * contribution00 + sourcePixels[offset10 + 2] * contribution10
        + sourcePixels[offset01 + 2] * contribution01 + sourcePixels[offset11 + 2] * contribution11;
      const targetOffset = (targetY * width + targetX) * 4;
      if (alpha > 0) {
        targetPixels[targetOffset] = Math.round(red / alpha);
        targetPixels[targetOffset + 1] = Math.round(green / alpha);
        targetPixels[targetOffset + 2] = Math.round(blue / alpha);
        targetPixels[targetOffset + 3] = Math.round(alpha * 255);
      }
    }
  }
  outputContext.putImageData(output, 0, 0);
  return outputCanvas;
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
  const corrected = perspectiveCanvas(bitmap, safe);
  const drawSource = corrected ?? bitmap;
  const sourceX = corrected ? 0 : safe.crop.x;
  const sourceY = corrected ? 0 : safe.crop.y;
  context.drawImage(
    drawSource,
    sourceX,
    sourceY,
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
