import { StudioEditableMediaTypeValues } from "ipw-contracts-ts/product";
import type { SourceFacts } from "ipw-contracts-ts/product";

export const STUDIO_EDITABLE_MEDIA_TYPES = new Set<string>(StudioEditableMediaTypeValues);

export const STUDIO_PROCESSING_POLICY = Object.freeze({
  maxCompressedBytes: 64 * 1024 * 1024,
  maxDecodedPixels: 16_000_000,
  maxDimension: 12_000,
  maxBitDepth: 8,
  maxFrames: 1,
});

export const STUDIO_SYNC_PREVIEW_POLICY = Object.freeze({
  maxCompressedBytes: 8 * 1024 * 1024,
  maxDecodedPixels: 8_000_000,
  maxDimension: 4_096,
  browserTextureLimit: 4_096,
});

export function requiresGeneratedPreview(input: {
  byteSize: number;
  width: number | null;
  height: number | null;
  mediaType?: string;
  colourModel?: SourceFacts["colour_model"];
}): boolean {
  const { byteSize, width, height } = input;
  if (!width || !height) return true;
  return input.mediaType === "image/tiff"
    || input.colourModel === "cmyk"
    || byteSize > STUDIO_SYNC_PREVIEW_POLICY.maxCompressedBytes
    || width * height > STUDIO_SYNC_PREVIEW_POLICY.maxDecodedPixels
    || Math.max(width, height) > STUDIO_SYNC_PREVIEW_POLICY.maxDimension
    || Math.max(width, height) > STUDIO_SYNC_PREVIEW_POLICY.browserTextureLimit;
}

export function studioCompatibility(facts: SourceFacts): { editable: boolean; message: string } {
  if (!STUDIO_EDITABLE_MEDIA_TYPES.has(facts.detected_media_type)) {
    return { editable: false, message: "Stored safely, but this format is not editable in Studio" };
  }
  if (!facts.width || !facts.height || !facts.colour_model || facts.bit_depth === null
    || facts.bit_depth === undefined || !facts.frame_count) {
    return { editable: false, message: "Stored safely, but complete image facts are required for Studio" };
  }
  if (facts.byte_size > STUDIO_PROCESSING_POLICY.maxCompressedBytes
    || facts.width > STUDIO_PROCESSING_POLICY.maxDimension
    || facts.height > STUDIO_PROCESSING_POLICY.maxDimension
    || facts.width * facts.height > STUDIO_PROCESSING_POLICY.maxDecodedPixels) {
    return { editable: false, message: "Stored safely, but this image exceeds the current Studio processing limit" };
  }
  if (facts.bit_depth > STUDIO_PROCESSING_POLICY.maxBitDepth) {
    return { editable: false, message: "Stored safely, but high-precision editing is not active in this build" };
  }
  if (facts.frame_count !== STUDIO_PROCESSING_POLICY.maxFrames) {
    return { editable: false, message: "Stored safely, but animated or multi-page image editing is not active in this build" };
  }
  if (facts.colour_model === "cmyk" && facts.has_icc_profile !== true) {
    return { editable: false, message: "Stored safely, but CMYK editing requires a validated embedded ICC profile" };
  }
  return { editable: true, message: "Editable in Image & Graphic Studio" };
}
