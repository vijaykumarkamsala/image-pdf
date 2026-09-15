export type InspectedMediaType = "image/jpeg" | "image/png" | "image/webp";
export type InspectedColourModel = "grayscale" | "rgb" | "unknown";

export interface PhysicalPixelDensity {
  xPixelsPerMetre: number;
  yPixelsPerMetre: number;
}

export interface ImageFileInspection {
  mediaType: InspectedMediaType;
  width: number;
  height: number;
  bitDepth: number;
  colourModel: InspectedColourModel;
  hasAlpha: boolean;
  hasIccProfile: boolean;
  hasExif: boolean;
  mayContainGps: boolean;
  orientation: number | null;
  frameCount: number;
  animated: boolean;
  physicalPixelDensity: PhysicalPixelDensity | null;
  warnings: string[];
}

const HEADER_READ_BYTES = 4 * 1024 * 1024;
export const MAX_LOCAL_INPUT_BYTES = 1024 * 1024 * 1024 * 1024;
const ascii = (bytes: Uint8Array, start: number, length: number) => (
  String.fromCharCode(...bytes.subarray(start, start + length))
);

const pngSignature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function matches(bytes: Uint8Array, expected: Uint8Array, offset = 0) {
  if (bytes.byteLength < offset + expected.byteLength) return false;
  return expected.every((value, index) => bytes[offset + index] === value);
}

function readUint24LittleEndian(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function parseExif(payload: Uint8Array): { orientation: number | null; mayContainGps: boolean } {
  const tiffOffset = matches(payload, new Uint8Array([69, 120, 105, 102, 0, 0])) ? 6 : 0;
  if (payload.byteLength < tiffOffset + 8) return { orientation: null, mayContainGps: false };
  const byteOrder = ascii(payload, tiffOffset, 2);
  const littleEndian = byteOrder === "II";
  if (!littleEndian && byteOrder !== "MM") return { orientation: null, mayContainGps: false };
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const uint16 = (offset: number) => view.getUint16(tiffOffset + offset, littleEndian);
  const uint32 = (offset: number) => view.getUint32(tiffOffset + offset, littleEndian);
  if (uint16(2) !== 42) return { orientation: null, mayContainGps: false };
  const ifdOffset = uint32(4);
  if (ifdOffset > payload.byteLength - tiffOffset - 2) return { orientation: null, mayContainGps: false };
  const entries = uint16(ifdOffset);
  let orientation: number | null = null;
  let mayContainGps = false;
  for (let index = 0; index < entries; index += 1) {
    const entry = ifdOffset + 2 + index * 12;
    if (entry + 12 > payload.byteLength - tiffOffset) break;
    const tag = uint16(entry);
    if (tag === 0x0112 && uint16(entry + 2) === 3 && uint32(entry + 4) >= 1) {
      orientation = uint16(entry + 8);
      if (orientation < 1 || orientation > 8) orientation = null;
    }
    if (tag === 0x8825) mayContainGps = true;
  }
  return { orientation, mayContainGps };
}

function inspectPng(bytes: Uint8Array): ImageFileInspection {
  if (bytes.byteLength < 33) throw new Error("The PNG header is incomplete.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8, false) !== 13 || ascii(bytes, 12, 4) !== "IHDR") {
    throw new Error("The PNG header is malformed.");
  }
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  const bitDepth = bytes[24];
  const colourType = bytes[25];
  if (width < 1 || height < 1) throw new Error("The PNG dimensions are invalid.");
  let hasIccProfile = false;
  let hasExif = false;
  let mayContainGps = false;
  let orientation: number | null = null;
  let hasTransparencyChunk = false;
  let frameCount = 1;
  let animated = false;
  let physicalPixelDensity: PhysicalPixelDensity | null = null;
  let offset = 8;
  let reachedImageData = false;
  while (offset + 12 <= bytes.byteLength) {
    const length = view.getUint32(offset, false);
    const type = ascii(bytes, offset + 4, 4);
    const dataStart = offset + 8;
    const next = dataStart + length + 4;
    if (type === "IDAT") {
      reachedImageData = true;
      break;
    }
    if (!Number.isSafeInteger(next) || next > bytes.byteLength) {
      throw new Error("The PNG metadata header is incomplete or exceeds the safe inspection window.");
    }
    if (type === "iCCP" || type === "cICP") hasIccProfile = true;
    if (type === "tRNS") hasTransparencyChunk = true;
    if (type === "acTL" && length >= 8) {
      animated = true;
      frameCount = view.getUint32(dataStart, false);
    }
    if (type === "pHYs" && length === 9 && bytes[dataStart + 8] === 1) {
      physicalPixelDensity = {
        xPixelsPerMetre: view.getUint32(dataStart, false),
        yPixelsPerMetre: view.getUint32(dataStart + 4, false),
      };
    }
    if (type === "eXIf") {
      hasExif = true;
      const exif = parseExif(bytes.subarray(dataStart, dataStart + length));
      orientation = exif.orientation;
      mayContainGps = exif.mayContainGps;
    }
    if (type === "IEND") break;
    offset = next;
  }
  if (!reachedImageData) throw new Error("The PNG image data marker could not be verified before decoding.");
  const colourModel: InspectedColourModel = colourType === 0 || colourType === 4 ? "grayscale" : "rgb";
  return {
    mediaType: "image/png",
    width,
    height,
    bitDepth,
    colourModel,
    hasAlpha: colourType === 4 || colourType === 6 || hasTransparencyChunk,
    hasIccProfile,
    hasExif,
    mayContainGps,
    orientation,
    frameCount,
    animated,
    physicalPixelDensity,
    warnings: [],
  };
}

const jpegStartOfFrameMarkers = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function inspectJpeg(bytes: Uint8Array): ImageFileInspection {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colourModel: InspectedColourModel = "unknown";
  let hasIccProfile = false;
  let hasExif = false;
  let mayContainGps = false;
  let orientation: number | null = null;
  let physicalPixelDensity: PhysicalPixelDensity | null = null;
  let offset = 2;
  while (offset + 4 <= bytes.byteLength) {
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) break;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.byteLength) break;
    const segmentLength = view.getUint16(offset, false);
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) break;
    const dataStart = offset + 2;
    const dataLength = segmentLength - 2;
    if (marker === 0xe0 && dataLength >= 12 && ascii(bytes, dataStart, 5) === "JFIF\0") {
      const units = bytes[dataStart + 7];
      const densityX = view.getUint16(dataStart + 8, false);
      const densityY = view.getUint16(dataStart + 10, false);
      if (units === 1) {
        physicalPixelDensity = {
          xPixelsPerMetre: Math.round(densityX / 0.0254),
          yPixelsPerMetre: Math.round(densityY / 0.0254),
        };
      } else if (units === 2) {
        physicalPixelDensity = { xPixelsPerMetre: densityX * 100, yPixelsPerMetre: densityY * 100 };
      }
    }
    if (marker === 0xe1 && dataLength >= 6 && ascii(bytes, dataStart, 6) === "Exif\0\0") {
      hasExif = true;
      const exif = parseExif(bytes.subarray(dataStart, dataStart + dataLength));
      orientation = exif.orientation;
      mayContainGps = exif.mayContainGps;
    }
    if (marker === 0xe2 && dataLength >= 12 && ascii(bytes, dataStart, 12) === "ICC_PROFILE\0") {
      hasIccProfile = true;
    }
    if (jpegStartOfFrameMarkers.has(marker) && dataLength >= 6) {
      bitDepth = bytes[dataStart];
      height = view.getUint16(dataStart + 1, false);
      width = view.getUint16(dataStart + 3, false);
      const components = bytes[dataStart + 5];
      colourModel = components === 1 ? "grayscale" : components >= 3 ? "rgb" : "unknown";
    }
    offset += segmentLength;
  }
  if (width < 1 || height < 1) throw new Error("The JPEG dimensions could not be verified before decoding.");
  return {
    mediaType: "image/jpeg",
    width,
    height,
    bitDepth,
    colourModel,
    hasAlpha: false,
    hasIccProfile,
    hasExif,
    mayContainGps,
    orientation,
    frameCount: 1,
    animated: false,
    physicalPixelDensity,
    warnings: [],
  };
}

function inspectWebp(bytes: Uint8Array, byteSize: number): ImageFileInspection {
  if (bytes.byteLength < 20 || ascii(bytes, 8, 4) !== "WEBP") throw new Error("The WebP header is incomplete.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declaredSize = view.getUint32(4, true) + 8;
  if (declaredSize > byteSize) throw new Error("The WebP container is truncated.");
  let width = 0;
  let height = 0;
  let hasAlpha = false;
  let hasIccProfile = false;
  let hasExif = false;
  let mayContainGps = false;
  let orientation: number | null = null;
  let animated = false;
  let frameCount = 0;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const type = ascii(bytes, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const dataStart = offset + 8;
    const next = dataStart + length + (length % 2);
    if (!Number.isSafeInteger(next) || next > bytes.byteLength) break;
    if (type === "VP8X" && length >= 10) {
      const flags = bytes[dataStart];
      hasIccProfile = (flags & 0x20) !== 0;
      hasAlpha = (flags & 0x10) !== 0;
      hasExif = (flags & 0x08) !== 0;
      animated = (flags & 0x02) !== 0;
      width = readUint24LittleEndian(bytes, dataStart + 4) + 1;
      height = readUint24LittleEndian(bytes, dataStart + 7) + 1;
    } else if (type === "VP8 " && length >= 10 && matches(bytes, new Uint8Array([0x9d, 0x01, 0x2a]), dataStart + 3)) {
      width ||= view.getUint16(dataStart + 6, true) & 0x3fff;
      height ||= view.getUint16(dataStart + 8, true) & 0x3fff;
    } else if (type === "VP8L" && length >= 5 && bytes[dataStart] === 0x2f) {
      const bits = view.getUint32(dataStart + 1, true);
      width ||= (bits & 0x3fff) + 1;
      height ||= ((bits >>> 14) & 0x3fff) + 1;
      hasAlpha = true;
    } else if (type === "ANMF") {
      frameCount += 1;
      animated = true;
    } else if (type === "EXIF") {
      hasExif = true;
      const exif = parseExif(bytes.subarray(dataStart, dataStart + length));
      orientation = exif.orientation;
      mayContainGps = exif.mayContainGps;
    }
    offset = next;
  }
  if (width < 1 || height < 1) throw new Error("The WebP dimensions could not be verified before decoding.");
  return {
    mediaType: "image/webp",
    width,
    height,
    bitDepth: 8,
    colourModel: "rgb",
    hasAlpha,
    hasIccProfile,
    hasExif,
    mayContainGps,
    orientation,
    frameCount: Math.max(1, frameCount),
    animated,
    physicalPixelDensity: null,
    warnings: [],
  };
}

export function inspectImageHeaderBytes(bytes: Uint8Array, byteSize = bytes.byteLength): ImageFileInspection {
  if (matches(bytes, pngSignature)) return inspectPng(bytes);
  if (bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return inspectJpeg(bytes);
  if (bytes.byteLength >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return inspectWebp(bytes, byteSize);
  }
  throw new Error("The file signature is not a valid JPEG, PNG or WebP image.");
}

export async function inspectImageFile(source: Blob): Promise<ImageFileInspection> {
  if (source.size < 12) throw new Error("The image file is empty or incomplete.");
  if (source.size > MAX_LOCAL_INPUT_BYTES) {
    throw new Error("This file exceeds the safe 512 MB browser-local limit. A cloud processing route is required.");
  }
  const header = new Uint8Array(await source.slice(0, HEADER_READ_BYTES).arrayBuffer());
  const inspection = inspectImageHeaderBytes(header, source.size);
  const claimedType = source.type.toLowerCase();
  if (claimedType && claimedType !== inspection.mediaType) {
    inspection.warnings.push(`The supplied ${claimedType} label did not match the verified ${inspection.mediaType} bytes.`);
  }
  return inspection;
}
