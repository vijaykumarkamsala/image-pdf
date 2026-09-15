import { sha256Bytes } from "./sha256.ts";

export interface PngOutputMetadata {
  sourceSha256: string;
  engineId: string;
  engineVersion: string;
  route: string;
  strength: number;
  scale: number;
  modelSha256: string | null;
  usage: "deterministic" | "local-research";
  contentClass: "flat-graphic" | "illustration" | "photograph";
  classificationConfidence: number;
  outputWidth: number;
  outputHeight: number;
  xPixelsPerMetre?: number;
  yPixelsPerMetre?: number;
}

const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const encoder = new TextEncoder();
let crcTable: Uint32Array | null = null;

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
  });
  const keyword = encoder.encode("ImageQualityProvenance");
  const text = encoder.encode(value);
  const data = new Uint8Array(keyword.byteLength + 5 + text.byteLength);
  data.set(keyword, 0);
  // null keyword terminator, uncompressed flag/method and empty language/translated-keyword fields
  data.set(text, keyword.byteLength + 5);
  return data;
}

export function tagSrgbPng(bytes: Uint8Array, metadata: PngOutputMetadata): Uint8Array {
  if (bytes.byteLength < 33 || !signature.every((value, index) => bytes[index] === value)) {
    throw new Error("The processed PNG bytes are invalid.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8, false) !== 13 || String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") {
    throw new Error("The processed PNG header is invalid.");
  }
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

export function pngOutputSha256(bytes: Uint8Array) {
  return sha256Bytes(bytes);
}
