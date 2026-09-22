function checkedPixelCount(width: number, height: number): number {
  const count = width * height;
  if (!Number.isSafeInteger(width) || width < 1
    || !Number.isSafeInteger(height) || height < 1
    || !Number.isSafeInteger(count) || count < 1) {
    throw new Error("The face comparison dimensions are invalid.");
  }
  return count;
}

export function nativeFacePreviewRgba(
  pixels: ArrayBuffer,
  width: number,
  height: number,
  bitDepth: 8 | 16,
): Uint8ClampedArray<ArrayBuffer> {
  const channelCount = checkedPixelCount(width, height) * 4;
  if (bitDepth === 8) {
    if (pixels.byteLength !== channelCount) throw new Error("The face comparison pixel count is invalid.");
    return new Uint8ClampedArray(pixels.slice(0));
  }
  if (pixels.byteLength !== channelCount * 2) {
    throw new Error("The 16-bit face comparison pixel count is invalid.");
  }
  const source = new DataView(pixels);
  const output = new Uint8ClampedArray(channelCount);
  for (let index = 0; index < channelCount; index += 1) {
    output[index] = Math.round(source.getUint16(index * 2, true) / 257);
  }
  return output;
}

export function nativeFaceMaskRgba(
  maskBytes: ArrayBuffer,
  width: number,
  height: number,
): Uint8ClampedArray<ArrayBuffer> {
  const pixelCount = checkedPixelCount(width, height);
  if (maskBytes.byteLength !== pixelCount) {
    throw new Error("The face comparison mask does not match its region.");
  }
  const mask = new Uint8Array(maskBytes);
  const output = new Uint8ClampedArray(pixelCount * 4);
  for (let index = 0; index < mask.length; index += 1) {
    const offset = index * 4;
    output[offset] = 255;
    output[offset + 1] = 32;
    output[offset + 2] = 128;
    output[offset + 3] = Math.round(mask[index] * 0.58);
  }
  return output;
}
