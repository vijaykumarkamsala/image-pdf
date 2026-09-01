import { StudioEditableMediaTypeValues } from "ipw-contracts-ts/product";

export const STUDIO_EDITABLE_MEDIA_TYPES = new Set<string>(StudioEditableMediaTypeValues);

export const STUDIO_SYNC_PREVIEW_POLICY = Object.freeze({
  maxCompressedBytes: 12 * 1024 * 1024,
  maxDecodedPixels: 24_000_000,
  maxDimension: 8_192,
  browserTextureLimit: 8_192,
});

export function requiresGeneratedPreview(input: {
  byteSize: number;
  width: number | null;
  height: number | null;
}): boolean {
  const { byteSize, width, height } = input;
  if (!width || !height) return true;
  return byteSize > STUDIO_SYNC_PREVIEW_POLICY.maxCompressedBytes
    || width * height > STUDIO_SYNC_PREVIEW_POLICY.maxDecodedPixels
    || Math.max(width, height) > STUDIO_SYNC_PREVIEW_POLICY.maxDimension
    || Math.max(width, height) > STUDIO_SYNC_PREVIEW_POLICY.browserTextureLimit;
}
