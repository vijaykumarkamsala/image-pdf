export const IMAGE_HISTOGRAM_BINS = 64;
export const SHADOW_CLIP_LEVEL = 2;
export const HIGHLIGHT_CLIP_LEVEL = 253;
export const MATERIAL_CLIPPING_PERCENT = 1;
export const MAX_BROWSER_HISTOGRAM_PIXELS = 67_108_864;

export interface ImageHistogramAccumulator {
  red: Uint32Array;
  green: Uint32Array;
  blue: Uint32Array;
  luminance: Uint32Array;
  visiblePixels: number;
  transparentPixels: number;
  shadowClippedPixels: number;
  highlightClippedPixels: number;
}

export interface ImageHistogramSummary {
  red: number[];
  green: number[];
  blue: number[];
  luminance: number[];
  analyzedPixels: number;
  visiblePixels: number;
  transparentPixels: number;
  shadowClippedPixels: number;
  highlightClippedPixels: number;
  shadowClippedPercent: number;
  highlightClippedPercent: number;
}

export function createImageHistogramAccumulator(): ImageHistogramAccumulator {
  return {
    red: new Uint32Array(IMAGE_HISTOGRAM_BINS),
    green: new Uint32Array(IMAGE_HISTOGRAM_BINS),
    blue: new Uint32Array(IMAGE_HISTOGRAM_BINS),
    luminance: new Uint32Array(IMAGE_HISTOGRAM_BINS),
    visiblePixels: 0,
    transparentPixels: 0,
    shadowClippedPixels: 0,
    highlightClippedPixels: 0,
  };
}

export function assertBrowserHistogramBudget(width: number, height: number): number {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error("Histogram analysis requires positive integer image dimensions.");
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > MAX_BROWSER_HISTOGRAM_PIXELS) {
    throw new Error(
      `Histogram analysis requires ${pixels.toLocaleString("en-US")} pixels, beyond this browser's `
      + `${MAX_BROWSER_HISTOGRAM_PIXELS.toLocaleString("en-US")}-pixel safety budget. No sampled substitute was shown.`,
    );
  }
  return pixels;
}

/** Accumulates exact stored RGB values for every non-fully-transparent pixel. */
export function accumulateImageHistogram(
  accumulator: ImageHistogramAccumulator,
  pixels: Uint8ClampedArray,
): void {
  if (pixels.byteLength % 4 !== 0) throw new Error("Histogram analysis requires complete RGBA pixels.");
  for (let offset = 0; offset < pixels.byteLength; offset += 4) {
    if (pixels[offset + 3] === 0) {
      accumulator.transparentPixels += 1;
      continue;
    }
    const red = pixels[offset];
    const green = pixels[offset + 1];
    const blue = pixels[offset + 2];
    const luminance = Math.round(0.2126 * red + 0.7152 * green + 0.0722 * blue);
    accumulator.red[Math.min(IMAGE_HISTOGRAM_BINS - 1, red >> 2)] += 1;
    accumulator.green[Math.min(IMAGE_HISTOGRAM_BINS - 1, green >> 2)] += 1;
    accumulator.blue[Math.min(IMAGE_HISTOGRAM_BINS - 1, blue >> 2)] += 1;
    accumulator.luminance[Math.min(IMAGE_HISTOGRAM_BINS - 1, luminance >> 2)] += 1;
    accumulator.visiblePixels += 1;
    if (luminance <= SHADOW_CLIP_LEVEL) accumulator.shadowClippedPixels += 1;
    if (luminance >= HIGHLIGHT_CLIP_LEVEL) accumulator.highlightClippedPixels += 1;
  }
}

export function finalizeImageHistogram(
  accumulator: ImageHistogramAccumulator,
  width: number,
  height: number,
): ImageHistogramSummary {
  const analyzedPixels = assertBrowserHistogramBudget(width, height);
  if (accumulator.visiblePixels + accumulator.transparentPixels !== analyzedPixels) {
    throw new Error("Histogram analysis did not account for every decoded pixel.");
  }
  const percent = (count: number) => accumulator.visiblePixels === 0
    ? 0
    : count / accumulator.visiblePixels * 100;
  return {
    red: Array.from(accumulator.red),
    green: Array.from(accumulator.green),
    blue: Array.from(accumulator.blue),
    luminance: Array.from(accumulator.luminance),
    analyzedPixels,
    visiblePixels: accumulator.visiblePixels,
    transparentPixels: accumulator.transparentPixels,
    shadowClippedPixels: accumulator.shadowClippedPixels,
    highlightClippedPixels: accumulator.highlightClippedPixels,
    shadowClippedPercent: percent(accumulator.shadowClippedPixels),
    highlightClippedPercent: percent(accumulator.highlightClippedPixels),
  };
}

