import type { InspectedMediaType } from "./imageFileInspection.ts";

export const MAX_COLOR_MATCH_REFERENCE_BYTES = 256 * 1024 * 1024;
export const MAX_COLOR_MATCH_REFERENCE_PIXELS = 67_108_864;
export const MAX_COLOR_MATCH_ANALYSIS_PIXELS = 1_048_576;

export interface ImageColorDistribution {
  mean: [number, number, number];
  deviation: [number, number, number];
  visiblePixels: number;
  sampleWidth: number;
  sampleHeight: number;
}

export interface ImageColorMatchAnalysis {
  referenceSha256: string;
  referenceWidth: number;
  referenceHeight: number;
  referenceMediaType: InspectedMediaType;
  source: ImageColorDistribution;
  reference: ImageColorDistribution;
}

export interface ImageColorMatchRecipe extends ImageColorMatchAnalysis {
  enabled: boolean;
  intensity: number;
  luminance: number;
  colorIntensity: number;
  protectNeutrals: boolean;
  sourceBaseSha256: string;
  method: "bounded-oklab-distribution-v1";
}

export interface PreparedImageColorMatch {
  recipe: ImageColorMatchRecipe;
  scale: [number, number, number];
}

const SHA256 = /^[a-f0-9]{64}$/;
const MEDIA_TYPES = new Set<InspectedMediaType>(["image/jpeg", "image/png", "image/webp"]);
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const round = (value: number, precision = 6) => Number(value.toFixed(precision));
const smoothstep = (edge0: number, edge1: number, value: number) => {
  const position = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return position * position * (3 - 2 * position);
};

function srgbToLinear(value: number) {
  const safe = clamp(value, 0, 1);
  return safe <= 0.04045 ? safe / 12.92 : ((safe + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number) {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * Math.max(0, value) ** (1 / 2.4) - 0.055;
}

function rgbToOklab(red: number, green: number, blue: number): [number, number, number] {
  const r = srgbToLinear(red);
  const g = srgbToLinear(green);
  const b = srgbToLinear(blue);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToRgb(lightness: number, a: number, b: number): [number, number, number] {
  const lRoot = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lRoot ** 3;
  const m = mRoot ** 3;
  const s = sRoot ** 3;
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function sanitizeDistribution(value: ImageColorDistribution | null | undefined): ImageColorDistribution | null {
  if (!value || !Array.isArray(value.mean) || value.mean.length !== 3
    || !Array.isArray(value.deviation) || value.deviation.length !== 3) return null;
  if (!Number.isSafeInteger(value.visiblePixels) || value.visiblePixels < 32
    || value.visiblePixels > MAX_COLOR_MATCH_ANALYSIS_PIXELS
    || !Number.isSafeInteger(value.sampleWidth) || value.sampleWidth < 1 || value.sampleWidth > 16_384
    || !Number.isSafeInteger(value.sampleHeight) || value.sampleHeight < 1 || value.sampleHeight > 16_384
    || value.sampleWidth * value.sampleHeight > MAX_COLOR_MATCH_ANALYSIS_PIXELS) return null;
  const mean = value.mean.map((item, index) => (
    Number.isFinite(item) && item >= (index === 0 ? 0 : -0.6) && item <= (index === 0 ? 1 : 0.6)
      ? round(item)
      : Number.NaN
  )) as [number, number, number];
  const deviation = value.deviation.map((item) => (
    Number.isFinite(item) && item >= 0 && item <= 1 ? round(item) : Number.NaN
  )) as [number, number, number];
  if (mean.some((item) => !Number.isFinite(item)) || deviation.some((item) => !Number.isFinite(item))) return null;
  return {
    mean,
    deviation,
    visiblePixels: value.visiblePixels,
    sampleWidth: value.sampleWidth,
    sampleHeight: value.sampleHeight,
  };
}

export function analyzeColorDistribution(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): ImageColorDistribution {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width * height > MAX_COLOR_MATCH_ANALYSIS_PIXELS || pixels.byteLength !== width * height * 4) {
    throw new Error("Colour-match analysis requires one complete bounded RGBA sample.");
  }
  let count = 0;
  const mean = [0, 0, 0];
  const sumSquares = [0, 0, 0];
  for (let offset = 0; offset < pixels.byteLength; offset += 4) {
    if (pixels[offset + 3] === 0) continue;
    const channels = rgbToOklab(pixels[offset] / 255, pixels[offset + 1] / 255, pixels[offset + 2] / 255);
    count += 1;
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = channels[channel] - mean[channel];
      mean[channel] += delta / count;
      sumSquares[channel] += delta * (channels[channel] - mean[channel]);
    }
  }
  if (count < 32) throw new Error("The image does not contain enough visible pixels for a reliable colour match.");
  return {
    mean: mean.map((item) => round(item)) as [number, number, number],
    deviation: sumSquares.map((item) => round(Math.sqrt(Math.max(0, item / count)))) as [number, number, number],
    visiblePixels: count,
    sampleWidth: width,
    sampleHeight: height,
  };
}

export function createColorMatchRecipe(
  analysis: ImageColorMatchAnalysis,
  sourceBaseSha256: string,
): ImageColorMatchRecipe {
  const recipe: ImageColorMatchRecipe = {
    ...analysis,
    enabled: true,
    intensity: 65,
    luminance: 35,
    colorIntensity: 70,
    protectNeutrals: true,
    sourceBaseSha256,
    method: "bounded-oklab-distribution-v1",
  };
  const safe = sanitizeColorMatchRecipe(recipe);
  if (!safe) throw new Error("The colour-match analysis could not be bound to a safe recipe.");
  return safe;
}

export function sanitizeColorMatchRecipe(
  recipe: ImageColorMatchRecipe | null | undefined,
): ImageColorMatchRecipe | null {
  if (!recipe || !SHA256.test(recipe.sourceBaseSha256 ?? "") || !SHA256.test(recipe.referenceSha256 ?? "")
    || !Number.isSafeInteger(recipe.referenceWidth) || recipe.referenceWidth < 1 || recipe.referenceWidth > 65_535
    || !Number.isSafeInteger(recipe.referenceHeight) || recipe.referenceHeight < 1 || recipe.referenceHeight > 65_535
    || recipe.referenceWidth * recipe.referenceHeight > MAX_COLOR_MATCH_REFERENCE_PIXELS
    || !MEDIA_TYPES.has(recipe.referenceMediaType)
    || recipe.method !== "bounded-oklab-distribution-v1") return null;
  const source = sanitizeDistribution(recipe.source);
  const reference = sanitizeDistribution(recipe.reference);
  if (!source || !reference) return null;
  return {
    enabled: recipe.enabled === true,
    intensity: Math.round(clamp(Number.isFinite(recipe.intensity) ? recipe.intensity : 65, 0, 100)),
    luminance: Math.round(clamp(Number.isFinite(recipe.luminance) ? recipe.luminance : 35, 0, 100)),
    colorIntensity: Math.round(clamp(Number.isFinite(recipe.colorIntensity) ? recipe.colorIntensity : 70, 0, 100)),
    protectNeutrals: recipe.protectNeutrals !== false,
    sourceBaseSha256: recipe.sourceBaseSha256,
    referenceSha256: recipe.referenceSha256,
    referenceWidth: recipe.referenceWidth,
    referenceHeight: recipe.referenceHeight,
    referenceMediaType: recipe.referenceMediaType,
    source,
    reference,
    method: "bounded-oklab-distribution-v1",
  };
}

function sameDistribution(left: ImageColorDistribution, right: ImageColorDistribution) {
  return left.visiblePixels === right.visiblePixels
    && left.sampleWidth === right.sampleWidth
    && left.sampleHeight === right.sampleHeight
    && left.mean.every((value, index) => value === right.mean[index])
    && left.deviation.every((value, index) => value === right.deviation[index]);
}

export function sameColorMatchRecipe(
  left: ImageColorMatchRecipe | null,
  right: ImageColorMatchRecipe | null,
): boolean {
  if (!left || !right) return left === right;
  return left.enabled === right.enabled
    && left.intensity === right.intensity
    && left.luminance === right.luminance
    && left.colorIntensity === right.colorIntensity
    && left.protectNeutrals === right.protectNeutrals
    && left.sourceBaseSha256 === right.sourceBaseSha256
    && left.referenceSha256 === right.referenceSha256
    && left.referenceWidth === right.referenceWidth
    && left.referenceHeight === right.referenceHeight
    && left.referenceMediaType === right.referenceMediaType
    && left.method === right.method
    && sameDistribution(left.source, right.source)
    && sameDistribution(left.reference, right.reference);
}

export function isSanitizedColorMatchRecipe(recipe: ImageColorMatchRecipe | null): boolean {
  if (recipe === null) return true;
  const safe = sanitizeColorMatchRecipe(recipe);
  return Boolean(safe && sameColorMatchRecipe(recipe, safe));
}

export function analysisMatchesColorMatchRecipe(
  analysis: ImageColorMatchAnalysis | null | undefined,
  recipe: ImageColorMatchRecipe | null | undefined,
  sourceBaseSha256: string,
): boolean {
  if (!analysis || !recipe) return false;
  const expected = createColorMatchRecipe(analysis, sourceBaseSha256);
  return recipe.sourceBaseSha256 === expected.sourceBaseSha256
    && recipe.referenceSha256 === expected.referenceSha256
    && recipe.referenceWidth === expected.referenceWidth
    && recipe.referenceHeight === expected.referenceHeight
    && recipe.referenceMediaType === expected.referenceMediaType
    && recipe.method === expected.method
    && sameDistribution(recipe.source, expected.source)
    && sameDistribution(recipe.reference, expected.reference);
}

export function prepareColorMatch(recipe: ImageColorMatchRecipe): PreparedImageColorMatch {
  const safe = sanitizeColorMatchRecipe(recipe);
  if (!safe) throw new Error("The reviewed colour-match recipe is invalid.");
  return {
    recipe: safe,
    scale: safe.source.deviation.map((sourceDeviation, index) => (
      clamp(safe.reference.deviation[index] / Math.max(0.008, sourceDeviation), 0.6, 1.6)
    )) as [number, number, number],
  };
}

export function applyPreparedColorMatch(
  red: number,
  green: number,
  blue: number,
  prepared: PreparedImageColorMatch,
): { red: number; green: number; blue: number; outOfGamut: boolean } {
  const { recipe, scale } = prepared;
  const [lightness, a, b] = rgbToOklab(red, green, blue);
  const source = recipe.source.mean;
  const reference = recipe.reference.mean;
  const matchedLightness = reference[0] + (lightness - source[0]) * scale[0];
  const matchedA = reference[1] + (a - source[1]) * scale[1];
  const matchedB = reference[2] + (b - source[2]) * scale[2];
  const endpointWeight = smoothstep(0.015, 0.12, lightness) * (1 - smoothstep(0.88, 0.985, lightness));
  const chroma = Math.hypot(a, b);
  const neutralWeight = recipe.protectNeutrals ? smoothstep(0.012, 0.075, chroma) : 1;
  const master = recipe.intensity / 100;
  const luminanceWeight = master * recipe.luminance / 100 * endpointWeight;
  const colorWeight = master * recipe.colorIntensity / 100 * endpointWeight * neutralWeight;
  if (luminanceWeight === 0 && colorWeight === 0) {
    return { red, green, blue, outOfGamut: false };
  }
  const outputLightness = lightness + clamp(matchedLightness - lightness, -0.14, 0.14) * luminanceWeight;
  const outputA = a + clamp(matchedA - a, -0.1, 0.1) * colorWeight;
  const outputB = b + clamp(matchedB - b, -0.1, 0.1) * colorWeight;
  const output = oklabToRgb(outputLightness, outputA, outputB);
  return {
    red: output[0],
    green: output[1],
    blue: output[2],
    outOfGamut: output.some((value) => value < 0 || value > 1),
  };
}
