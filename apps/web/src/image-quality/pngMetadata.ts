import { sha256Bytes } from "./sha256.ts";
import type { FaceRecreateEvidence } from "./faceDetailRestoration.ts";
import { sanitizePerspectiveQuad, type ImagePerspectiveQuad } from "./imageGeometry.ts";
import { sanitizeToneRecipe, type ImageToneRecipe, type ImageToneStatistics } from "./imageTone.ts";

export interface PngOutputMetadata {
  sourceSha256: string;
  engineId: string;
  engineVersion: string;
  route: string;
  strength: number;
  scale: number;
  modelSha256: string | null;
  usage: "deterministic" | "production-restore" | "local-research" | "explicit-face-recreate";
  contentClass: "flat-graphic" | "illustration" | "photograph";
  classificationConfidence: number;
  outputWidth: number;
  outputHeight: number;
  xPixelsPerMetre?: number;
  yPixelsPerMetre?: number;
  /** Present only for an explicitly reviewed face derivative, never ordinary enhancement. */
  faceRecreateEvidence?: FaceRecreateEvidence;
}

export interface PngGeometryMetadata {
  sourceSha256: string;
  baseOutputSha256: string;
  baseKind: "original" | "enhanced";
  baseRoute: string;
  baseStrength: number | null;
  baseScale: number;
  crop: { x: number; y: number; width: number; height: number };
  quarterTurns: 0 | 1 | 2 | 3;
  straighten: number;
  flipHorizontal: boolean;
  flipVertical: boolean;
  perspective: ImagePerspectiveQuad | null;
  resize: { width: number; height: number } | null;
  outputWidth: number;
  outputHeight: number;
}

export interface PngToneMetadata {
  sourceSha256: string;
  baseOutputSha256: string;
  baseKind: "original" | "enhanced" | "geometry-original" | "geometry-enhanced";
  baseRoute: string;
  baseStrength: number | null;
  baseScale: number;
  recipe: ImageToneRecipe;
  statistics: ImageToneStatistics;
  outputWidth: number;
  outputHeight: number;
}

const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const encoder = new TextEncoder();
let crcTable: Uint32Array | null = null;

export function inspectPngDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.byteLength < 33 || !signature.every((value, index) => bytes[index] === value)) {
    throw new Error("The processed PNG bytes are invalid.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8, false) !== 13 || String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") {
    throw new Error("The processed PNG header is invalid.");
  }
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (width < 1 || height < 1) throw new Error("The processed PNG dimensions are invalid.");
  return { width, height };
}

export function assertPngDimensions(
  bytes: Uint8Array,
  expectedWidth: number,
  expectedHeight: number,
): void {
  const actual = inspectPngDimensions(bytes);
  if (actual.width !== expectedWidth || actual.height !== expectedHeight) {
    throw new Error(
      `The encoded PNG is ${actual.width} × ${actual.height} px instead of the required ${expectedWidth} × ${expectedHeight} px. `
      + "The result was rejected and no mismatched download was created.",
    );
  }
}

function table() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let current = value;
    for (let bit = 0; bit < 8; bit += 1) current = (current & 1) ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
    crcTable[value] = current >>> 0;
  }
  return crcTable;
}

function chunk(type: string, data: Uint8Array) {
  const typeBytes = encoder.encode(type);
  const output = new Uint8Array(12 + data.byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, data.byteLength, false);
  output.set(typeBytes, 4);
  output.set(data, 8);
  let crc = 0xffffffff;
  const values = output.subarray(4, 8 + data.byteLength);
  const valuesTable = table();
  for (const value of values) crc = valuesTable[(crc ^ value) & 0xff] ^ (crc >>> 8);
  view.setUint32(8 + data.byteLength, (crc ^ 0xffffffff) >>> 0, false);
  return output;
}

function uint32(value: number) {
  const data = new Uint8Array(4);
  new DataView(data.buffer).setUint32(0, value, false);
  return data;
}

function physicalDensity(metadata: PngOutputMetadata): Uint8Array | null {
  if (!metadata.xPixelsPerMetre || !metadata.yPixelsPerMetre) return null;
  const data = new Uint8Array(9);
  const view = new DataView(data.buffer);
  view.setUint32(0, Math.min(0xffffffff, Math.round(metadata.xPixelsPerMetre * metadata.scale)), false);
  view.setUint32(4, Math.min(0xffffffff, Math.round(metadata.yPixelsPerMetre * metadata.scale)), false);
  data[8] = 1;
  return data;
}

function provenance(metadata: PngOutputMetadata) {
  const value = JSON.stringify({
    schema: "ipw.image-quality.provenance.v1",
    source_sha256: metadata.sourceSha256,
    engine: metadata.engineId,
    engine_version: metadata.engineVersion,
    route: metadata.route,
    strength: metadata.strength,
    scale: metadata.scale,
    model_sha256: metadata.modelSha256,
    usage: metadata.usage,
    content_class: metadata.contentClass,
    classification_confidence: metadata.classificationConfidence,
    output_width: metadata.outputWidth,
    output_height: metadata.outputHeight,
    ...(metadata.faceRecreateEvidence ? { reconstructed_regions: [metadata.faceRecreateEvidence] } : {}),
  });
  const keyword = encoder.encode("ImageQualityProvenance");
  const text = encoder.encode(value);
  const data = new Uint8Array(keyword.byteLength + 5 + text.byteLength);
  data.set(keyword, 0);
  // null keyword terminator, uncompressed flag/method and empty language/translated-keyword fields
  data.set(text, keyword.byteLength + 5);
  return data;
}

function geometryProvenance(metadata: PngGeometryMetadata) {
  const value = JSON.stringify({
    schema: "ipw.image-edit.geometry.provenance.v1",
    source_sha256: metadata.sourceSha256,
    base_output_sha256: metadata.baseOutputSha256,
    base_kind: metadata.baseKind,
    base_route: metadata.baseRoute,
    base_strength: metadata.baseStrength,
    base_scale: metadata.baseScale,
    operation_order: ["crop", "perspective", "flip", "quarter_turn", "straighten", "resize"],
    crop: metadata.crop,
    perspective: metadata.perspective,
    flip_horizontal: metadata.flipHorizontal,
    flip_vertical: metadata.flipVertical,
    quarter_turns_clockwise: metadata.quarterTurns,
    straighten_degrees: metadata.straighten,
    resize: metadata.resize,
    output_width: metadata.outputWidth,
    output_height: metadata.outputHeight,
  });
  const keyword = encoder.encode("ImageEditProvenance");
  const text = encoder.encode(value);
  const data = new Uint8Array(keyword.byteLength + 5 + text.byteLength);
  data.set(keyword, 0);
  data.set(text, keyword.byteLength + 5);
  return data;
}

function toneProvenance(metadata: PngToneMetadata) {
  const value = JSON.stringify({
    schema: "ipw.image-edit.tone.provenance.v1",
    source_sha256: metadata.sourceSha256,
    base_output_sha256: metadata.baseOutputSha256,
    base_kind: metadata.baseKind,
    base_route: metadata.baseRoute,
    base_strength: metadata.baseStrength,
    base_scale: metadata.baseScale,
    operation_order: ["exposure", "brightness", "shadows", "highlights", "blacks", "whites", "contrast", "gamma"],
    recipe: metadata.recipe,
    statistics: {
      processed_pixels: metadata.statistics.processedPixels,
      changed_pixels: metadata.statistics.changedPixels,
      new_shadow_clipped_pixels: metadata.statistics.newShadowClippedPixels,
      new_highlight_clipped_pixels: metadata.statistics.newHighlightClippedPixels,
    },
    output_width: metadata.outputWidth,
    output_height: metadata.outputHeight,
  });
  const keyword = encoder.encode("ImageToneProvenance");
  const text = encoder.encode(value);
  const data = new Uint8Array(keyword.byteLength + 5 + text.byteLength);
  data.set(keyword, 0);
  data.set(text, keyword.byteLength + 5);
  return data;
}

export function tagSrgbPng(bytes: Uint8Array, metadata: PngOutputMetadata): Uint8Array {
  assertPngDimensions(bytes, metadata.outputWidth, metadata.outputHeight);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const evidence = metadata.faceRecreateEvidence;
  if (metadata.usage === "explicit-face-recreate") {
    const hash = /^[a-f0-9]{64}$/;
    if (!evidence || evidence.kind !== "explicit-face-recreate"
      || !hash.test(evidence.candidateSha256) || !hash.test(evidence.baseOutputSha256)
      || !hash.test(evidence.dependencyLockSha256)
      || evidence.sourceSha256 !== metadata.sourceSha256 || evidence.modelSha256 !== metadata.modelSha256
      || !evidence.rightsEvidenceId.trim() || !evidence.qualityEvidenceId.trim()
      || evidence.acknowledgedPossibleIdentityChange !== true || !Number.isSafeInteger(evidence.changedPixels)
      || evidence.changedPixels <= 0 || evidence.changedPixels > evidence.outputRegion.width * evidence.outputRegion.height
      || ![evidence.outputRegion.x, evidence.outputRegion.y, evidence.outputRegion.width, evidence.outputRegion.height].every(Number.isSafeInteger)
      || evidence.outputRegion.x < 0 || evidence.outputRegion.y < 0 || evidence.outputRegion.width <= 0 || evidence.outputRegion.height <= 0
      || evidence.outputRegion.x + evidence.outputRegion.width > metadata.outputWidth
      || evidence.outputRegion.y + evidence.outputRegion.height > metadata.outputHeight) {
      throw new Error("Face-recreated PNG requires matching reviewed region and release evidence.");
    }
  } else if (evidence) throw new Error("Ordinary enhancement cannot carry an undisclosed face reconstruction.");
  const additions = [
    chunk("sRGB", new Uint8Array([0])),
    chunk("gAMA", uint32(45_455)),
    chunk("iTXt", provenance(metadata)),
  ];
  const density = physicalDensity(metadata);
  if (density) additions.push(chunk("pHYs", density));
  const parts = [bytes.subarray(0, 33), ...additions];
  let inputOffset = 33;
  let foundEnd = false;
  while (inputOffset + 12 <= bytes.byteLength) {
    const length = view.getUint32(inputOffset, false);
    const end = inputOffset + 12 + length;
    if (!Number.isSafeInteger(end) || end > bytes.byteLength) throw new Error("The processed PNG chunk structure is invalid.");
    const type = String.fromCharCode(...bytes.subarray(inputOffset + 4, inputOffset + 8));
    const keyword = type === "iTXt"
      ? new TextDecoder().decode(bytes.subarray(inputOffset + 8, Math.min(end - 4, inputOffset + 96))).split("\0", 1)[0]
      : "";
    if (!["sRGB", "gAMA", "iCCP", "cICP", "pHYs"].includes(type)
      && !(type === "iTXt" && keyword === "ImageQualityProvenance")) {
      parts.push(bytes.subarray(inputOffset, end));
    }
    inputOffset = end;
    if (type === "IEND") {
      foundEnd = true;
      break;
    }
  }
  if (!foundEnd || inputOffset !== bytes.byteLength) throw new Error("The processed PNG is incomplete.");
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let outputOffset = 0;
  for (const part of parts) {
    output.set(part, outputOffset);
    outputOffset += part.byteLength;
  }
  return output;
}

export function tagGeometryPng(bytes: Uint8Array, metadata: PngGeometryMetadata): Uint8Array {
  assertPngDimensions(bytes, metadata.outputWidth, metadata.outputHeight);
  const hash = /^[a-f0-9]{64}$/;
  if (!hash.test(metadata.sourceSha256) || !hash.test(metadata.baseOutputSha256)) {
    throw new Error("Geometry provenance requires verified source and base SHA-256 values.");
  }
  const cropValues = [metadata.crop.x, metadata.crop.y, metadata.crop.width, metadata.crop.height];
  const resizeValues = metadata.resize ? [metadata.resize.width, metadata.resize.height] : [];
  const perspectivePoints = metadata.perspective
    ? [
      metadata.perspective.topLeft,
      metadata.perspective.topRight,
      metadata.perspective.bottomRight,
      metadata.perspective.bottomLeft,
    ]
    : [];
  const perspectiveValues = perspectivePoints.flatMap((point) => point ? [point.x, point.y] : [Number.NaN, Number.NaN]);
  const safePerspective = metadata.perspective ? sanitizePerspectiveQuad(metadata.perspective) : null;
  const perspectiveIsSafe = !metadata.perspective || perspectivePoints.every((point, index) => {
    if (!point || !safePerspective) return false;
    const corner = (["topLeft", "topRight", "bottomRight", "bottomLeft"] as const)[index];
    return point.x === safePerspective[corner].x && point.y === safePerspective[corner].y;
  });
  if (!cropValues.every(Number.isSafeInteger) || metadata.crop.x < 0 || metadata.crop.y < 0
    || metadata.crop.width < 1 || metadata.crop.height < 1
    || !Number.isSafeInteger(metadata.quarterTurns) || metadata.quarterTurns < 0 || metadata.quarterTurns > 3
    || !Number.isFinite(metadata.straighten) || Math.abs(metadata.straighten) > 15
    || typeof metadata.flipHorizontal !== "boolean" || typeof metadata.flipVertical !== "boolean"
    || !perspectiveValues.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
    || !perspectiveIsSafe
    || !resizeValues.every(Number.isSafeInteger) || resizeValues.some((value) => value < 1)
    || !Number.isSafeInteger(metadata.baseScale) || metadata.baseScale < 1) {
    throw new Error("Geometry provenance requires a valid bounded source-coordinate recipe.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const additions = [
    chunk("sRGB", new Uint8Array([0])),
    chunk("gAMA", uint32(45_455)),
    chunk("iTXt", geometryProvenance(metadata)),
  ];
  const parts = [bytes.subarray(0, 33), ...additions];
  let inputOffset = 33;
  let foundEnd = false;
  while (inputOffset + 12 <= bytes.byteLength) {
    const length = view.getUint32(inputOffset, false);
    const end = inputOffset + 12 + length;
    if (!Number.isSafeInteger(end) || end > bytes.byteLength) throw new Error("The processed PNG chunk structure is invalid.");
    const type = String.fromCharCode(...bytes.subarray(inputOffset + 4, inputOffset + 8));
    const keyword = type === "iTXt"
      ? new TextDecoder().decode(bytes.subarray(inputOffset + 8, Math.min(end - 4, inputOffset + 96))).split("\0", 1)[0]
      : "";
    if (!["sRGB", "gAMA", "iCCP", "cICP", "pHYs"].includes(type)
      && !(type === "iTXt" && ["ImageQualityProvenance", "ImageEditProvenance"].includes(keyword))) {
      parts.push(bytes.subarray(inputOffset, end));
    }
    inputOffset = end;
    if (type === "IEND") {
      foundEnd = true;
      break;
    }
  }
  if (!foundEnd || inputOffset !== bytes.byteLength) throw new Error("The processed PNG is incomplete.");
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let outputOffset = 0;
  for (const part of parts) {
    output.set(part, outputOffset);
    outputOffset += part.byteLength;
  }
  return output;
}

export function tagTonePng(bytes: Uint8Array, metadata: PngToneMetadata): Uint8Array {
  assertPngDimensions(bytes, metadata.outputWidth, metadata.outputHeight);
  const hash = /^[a-f0-9]{64}$/;
  const safeRecipe = sanitizeToneRecipe(metadata.recipe);
  const recipeIsSafe = (Object.keys(safeRecipe) as Array<keyof ImageToneRecipe>)
    .every((key) => metadata.recipe[key] === safeRecipe[key]);
  const pixelCount = metadata.outputWidth * metadata.outputHeight;
  const statistics = [
    metadata.statistics.processedPixels,
    metadata.statistics.changedPixels,
    metadata.statistics.newShadowClippedPixels,
    metadata.statistics.newHighlightClippedPixels,
  ];
  const baseKinds: PngToneMetadata["baseKind"][] = ["original", "enhanced", "geometry-original", "geometry-enhanced"];
  if (!hash.test(metadata.sourceSha256) || !hash.test(metadata.baseOutputSha256)
    || !baseKinds.includes(metadata.baseKind) || !metadata.baseRoute.trim()
    || (metadata.baseStrength !== null && (!Number.isFinite(metadata.baseStrength) || metadata.baseStrength < 0 || metadata.baseStrength > 100))
    || !recipeIsSafe || !Number.isSafeInteger(metadata.baseScale) || metadata.baseScale < 1
    || !statistics.every(Number.isSafeInteger) || statistics.some((value) => value < 0 || value > pixelCount)
    || metadata.statistics.changedPixels > metadata.statistics.processedPixels
    || metadata.statistics.newShadowClippedPixels > metadata.statistics.changedPixels
    || metadata.statistics.newHighlightClippedPixels > metadata.statistics.changedPixels) {
    throw new Error("Light-adjustment provenance requires a valid bounded source-derived recipe.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const additions = [
    chunk("sRGB", new Uint8Array([0])),
    chunk("gAMA", uint32(45_455)),
    chunk("iTXt", toneProvenance(metadata)),
  ];
  const parts = [bytes.subarray(0, 33), ...additions];
  let inputOffset = 33;
  let foundEnd = false;
  while (inputOffset + 12 <= bytes.byteLength) {
    const length = view.getUint32(inputOffset, false);
    const end = inputOffset + 12 + length;
    if (!Number.isSafeInteger(end) || end > bytes.byteLength) throw new Error("The processed PNG chunk structure is invalid.");
    const type = String.fromCharCode(...bytes.subarray(inputOffset + 4, inputOffset + 8));
    const keyword = type === "iTXt"
      ? new TextDecoder().decode(bytes.subarray(inputOffset + 8, Math.min(end - 4, inputOffset + 96))).split("\0", 1)[0]
      : "";
    if (!["sRGB", "gAMA", "iCCP", "cICP", "pHYs"].includes(type)
      && !(type === "iTXt" && ["ImageQualityProvenance", "ImageEditProvenance", "ImageToneProvenance"].includes(keyword))) {
      parts.push(bytes.subarray(inputOffset, end));
    }
    inputOffset = end;
    if (type === "IEND") {
      foundEnd = true;
      break;
    }
  }
  if (!foundEnd || inputOffset !== bytes.byteLength) throw new Error("The processed PNG is incomplete.");
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let outputOffset = 0;
  for (const part of parts) {
    output.set(part, outputOffset);
    outputOffset += part.byteLength;
  }
  return output;
}

export function pngOutputSha256(bytes: Uint8Array) {
  return sha256Bytes(bytes);
}
