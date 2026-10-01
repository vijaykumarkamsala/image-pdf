import type { ImageHistogramSummary } from "./imageHistogram";

export interface ImageToneRecipe {
  /** Input luminance value mapped to black, expressed as an 8-bit sRGB level. */
  levelBlack: number;
  /** Input luminance value mapped to white, expressed as an 8-bit sRGB level. */
  levelWhite: number;
  /** Luminance-level midpoint. Values above 1 brighten midtones. */
  levelMidtone: number;
  /** Output percentages at fixed perceptual-luminance inputs 0, 25, 50, 75 and 100. */
  curveBlack: number;
  curveShadows: number;
  curveMidtones: number;
  curveHighlights: number;
  curveWhite: number;
  /** Positive-only, endpoint-protected lift for compressed dark tones. */
  shadowRecovery: number;
  /** Positive-only, endpoint-protected compression for bright tones. */
  highlightRecovery: number;
  /** Bounded neighbourhood contrast. Positive adds separation; negative softens it. */
  localContrast: number;
  /** Exposure compensation in stops. */
  exposure: number;
  brightness: number;
  contrast: number;
  /** Perceptual midtone correction. Positive values brighten midtones. */
  gamma: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
}

export interface ImageToneStatistics {
  processedPixels: number;
  changedPixels: number;
  newShadowClippedPixels: number;
  newHighlightClippedPixels: number;
}

export interface ImageToneRecommendation {
  levelBlack: number;
  levelWhite: number;
  levelMidtone: number;
  shadowRecovery: number;
  highlightRecovery: number;
  reasons: string[];
  isNeutral: boolean;
}

export const MAX_BROWSER_TONE_PIXELS = 67_108_864;

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const bounded = (value: number, minimum: number, maximum: number, fallback: number) => (
  clamp(Number.isFinite(value) ? value : fallback, minimum, maximum)
);

export function createNeutralToneRecipe(): ImageToneRecipe {
  return {
    levelBlack: 0,
    levelWhite: 255,
    levelMidtone: 1,
    curveBlack: 0,
    curveShadows: 25,
    curveMidtones: 50,
    curveHighlights: 75,
    curveWhite: 100,
    shadowRecovery: 0,
    highlightRecovery: 0,
    localContrast: 0,
    exposure: 0,
    brightness: 0,
    contrast: 0,
    gamma: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
  };
}

export function sanitizeToneRecipe(recipe: ImageToneRecipe): ImageToneRecipe {
  const levelBlack = Math.round(bounded(recipe.levelBlack, 0, 254, 0));
  const requestedWhite = Math.round(bounded(recipe.levelWhite, 1, 255, 255));
  const curveBlack = Math.round(bounded(recipe.curveBlack, 0, 100, 0));
  const curveShadows = Math.round(bounded(recipe.curveShadows, curveBlack, 100, 25));
  const curveMidtones = Math.round(bounded(recipe.curveMidtones, curveShadows, 100, 50));
  const curveHighlights = Math.round(bounded(recipe.curveHighlights, curveMidtones, 100, 75));
  const curveWhite = Math.round(bounded(recipe.curveWhite, curveHighlights, 100, 100));
  return {
    levelBlack,
    levelWhite: Math.max(levelBlack + 1, requestedWhite),
    levelMidtone: Math.round(bounded(recipe.levelMidtone, 0.1, 3, 1) * 100) / 100,
    curveBlack,
    curveShadows,
    curveMidtones,
    curveHighlights,
    curveWhite,
    shadowRecovery: Math.round(bounded(recipe.shadowRecovery, 0, 100, 0)),
    highlightRecovery: Math.round(bounded(recipe.highlightRecovery, 0, 100, 0)),
    localContrast: Math.round(bounded(recipe.localContrast, -100, 100, 0)),
    exposure: Math.round(bounded(recipe.exposure, -3, 3, 0) * 10) / 10,
    brightness: Math.round(bounded(recipe.brightness, -100, 100, 0)),
    contrast: Math.round(bounded(recipe.contrast, -100, 100, 0)),
    gamma: Math.round(bounded(recipe.gamma, -100, 100, 0)),
    highlights: Math.round(bounded(recipe.highlights, -100, 100, 0)),
    shadows: Math.round(bounded(recipe.shadows, -100, 100, 0)),
    whites: Math.round(bounded(recipe.whites, -100, 100, 0)),
    blacks: Math.round(bounded(recipe.blacks, -100, 100, 0)),
  };
}

export function isNeutralTone(recipe: ImageToneRecipe): boolean {
  const safe = sanitizeToneRecipe(recipe);
  return safe.levelBlack === 0 && safe.levelWhite === 255 && safe.levelMidtone === 1
    && safe.curveBlack === 0 && safe.curveShadows === 25 && safe.curveMidtones === 50
    && safe.curveHighlights === 75 && safe.curveWhite === 100
    && safe.shadowRecovery === 0 && safe.highlightRecovery === 0
    && safe.localContrast === 0
    && safe.exposure === 0 && safe.brightness === 0 && safe.contrast === 0 && safe.gamma === 0
    && safe.highlights === 0 && safe.shadows === 0 && safe.whites === 0 && safe.blacks === 0;
}

export function sameToneRecipe(left: ImageToneRecipe | null, right: ImageToneRecipe | null): boolean {
  if (!left || !right) return left === right;
  const safeLeft = sanitizeToneRecipe(left);
  const safeRight = sanitizeToneRecipe(right);
  return (Object.keys(safeLeft) as Array<keyof ImageToneRecipe>).every((key) => safeLeft[key] === safeRight[key]);
}

export function assertBrowserToneBudget(width: number, height: number): number {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error("Light adjustment requires positive integer working dimensions.");
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > MAX_BROWSER_TONE_PIXELS) {
    throw new Error(
      `Light adjustment requires ${pixels.toLocaleString("en-US")} working pixels, beyond this browser's ${MAX_BROWSER_TONE_PIXELS.toLocaleString("en-US")}-pixel safety budget. No unadjusted substitute was created.`,
    );
  }
  return pixels;
}

function histogramPercentile(summary: ImageHistogramSummary, percentile: number): number {
  if (summary.luminance.length !== 64 || summary.visiblePixels < 1
    || summary.luminance.some((count) => !Number.isSafeInteger(count) || count < 0)
    || summary.luminance.reduce((total, count) => total + count, 0) !== summary.visiblePixels) {
    throw new Error("Automatic tone correction requires a complete exact luminance histogram.");
  }
  const target = Math.max(1, Math.ceil(summary.visiblePixels * clamp(percentile, 0, 1)));
  let cumulative = 0;
  for (let index = 0; index < summary.luminance.length; index += 1) {
    cumulative += summary.luminance[index];
    if (cumulative >= target) return index * 4 + 1.5;
  }
  return 253.5;
}

/** Creates a conservative, explainable suggestion; it never changes pixels by itself. */
export function recommendToneCorrection(summary: ImageHistogramSummary): ImageToneRecommendation {
  const low = histogramPercentile(summary, 0.005);
  const lowerQuartile = histogramPercentile(summary, 0.25);
  const median = histogramPercentile(summary, 0.5);
  const upperQuartile = histogramPercentile(summary, 0.75);
  const high = histogramPercentile(summary, 0.995);
  const levelBlack = low >= 8 ? Math.min(24, Math.floor(low / 4) * 4) : 0;
  const levelWhite = high <= 247 ? Math.max(231, Math.floor(high / 4) * 4 + 3) : 255;
  const normalizedMedian = clamp((median - levelBlack) / (levelWhite - levelBlack), 0.01, 0.99);
  const suggestedMidtone = Math.log(normalizedMedian) / Math.log(0.5);
  const levelMidtone = normalizedMedian < 0.44 || normalizedMedian > 0.56
    ? Math.round(clamp(suggestedMidtone, 0.8, 1.25) * 100) / 100
    : 1;
  const shadowRecovery = lowerQuartile < 52
    ? Math.round(clamp((52 - lowerQuartile) / 52 * 45, 0, 45))
    : 0;
  const highlightRecovery = upperQuartile > 203
    ? Math.round(clamp((upperQuartile - 203) / 52 * 45, 0, 45))
    : 0;
  const reasons: string[] = [];
  if (levelBlack > 0 || levelWhite < 255) reasons.push(
    `Conservative endpoint mapping uses the exact histogram's 0.5%–99.5% luminance bins (${Math.round(low)}–${Math.round(high)}).`,
  );
  if (levelMidtone !== 1) reasons.push(
    `The median luminance is ${Math.round(median)}, so a bounded ${levelMidtone.toFixed(2)} midtone value is suggested.`,
  );
  if (shadowRecovery > 0) reasons.push(
    `The lower luminance quartile is ${Math.round(lowerQuartile)}, indicating compressed dark tones.`,
  );
  if (highlightRecovery > 0) reasons.push(
    `The upper luminance quartile is ${Math.round(upperQuartile)}, indicating compressed bright tones.`,
  );
  if (summary.shadowClippedPixels > 0 || summary.highlightClippedPixels > 0) reasons.push(
    "Endpoint occupancy is present; tonal redistribution cannot recreate detail already clipped in the source.",
  );
  const isNeutral = levelBlack === 0 && levelWhite === 255 && levelMidtone === 1
    && shadowRecovery === 0 && highlightRecovery === 0;
  if (isNeutral) reasons.push("The measured tonal span is already inside the conservative correction thresholds.");
  return {
    levelBlack,
    levelWhite,
    levelMidtone,
    shadowRecovery,
    highlightRecovery,
    reasons,
    isNeutral,
  };
}

export function localContrastRadius(width: number, height: number): number {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error("Local contrast requires positive integer image dimensions.");
  }
  return Math.min(32, Math.max(4, Math.round(Math.min(width, height) / 80)));
}

/**
 * Applies source-neighbourhood contrast to core rows of an RGBA tile.
 * Callers provide halo rows around the core so independently rendered tiles match exactly.
 */
export function applyLocalContrastToRgba(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  coreTop: number,
  coreHeight: number,
  amount: number,
  radius: number,
): Uint8ClampedArray {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || pixels.byteLength !== width * height * 4) {
    throw new Error("Local contrast requires complete RGBA tile dimensions.");
  }
  if (!Number.isSafeInteger(coreTop) || !Number.isSafeInteger(coreHeight) || coreTop < 0 || coreHeight < 1
    || coreTop + coreHeight > height || !Number.isSafeInteger(radius) || radius < 1 || radius > 64) {
    throw new Error("Local contrast requires a bounded core and halo radius.");
  }
  const safeAmount = Math.round(bounded(amount, -100, 100, 0));
  const output = new Uint8ClampedArray(width * coreHeight * 4);
  const stride = width + 1;
  const entries = stride * (height + 1);
  const luminanceIntegral = new Float64Array(entries);
  const visibleIntegral = new Uint32Array(entries);
  for (let y = 0; y < height; y += 1) {
    let rowLuminance = 0;
    let rowVisible = 0;
    for (let x = 0; x < width; x += 1) {
      const sourceOffset = (y * width + x) * 4;
      if (pixels[sourceOffset + 3] !== 0) {
        rowLuminance += 2126 * pixels[sourceOffset]
          + 7152 * pixels[sourceOffset + 1]
          + 722 * pixels[sourceOffset + 2];
        rowVisible += 1;
      }
      const integralOffset = (y + 1) * stride + x + 1;
      luminanceIntegral[integralOffset] = luminanceIntegral[integralOffset - stride] + rowLuminance;
      visibleIntegral[integralOffset] = visibleIntegral[integralOffset - stride] + rowVisible;
    }
  }
  const area = (integral: Float64Array | Uint32Array, left: number, top: number, right: number, bottom: number) => (
    integral[(bottom + 1) * stride + right + 1]
      - integral[top * stride + right + 1]
      - integral[(bottom + 1) * stride + left]
      + integral[top * stride + left]
  );
  const gain = safeAmount >= 0 ? safeAmount / 100 * 0.65 : safeAmount / 100 * 0.5;
  const noiseFloor = 1.5 / 255;
  for (let outputY = 0; outputY < coreHeight; outputY += 1) {
    const sourceY = coreTop + outputY;
    for (let x = 0; x < width; x += 1) {
      const sourceOffset = (sourceY * width + x) * 4;
      const outputOffset = (outputY * width + x) * 4;
      output[outputOffset] = pixels[sourceOffset];
      output[outputOffset + 1] = pixels[sourceOffset + 1];
      output[outputOffset + 2] = pixels[sourceOffset + 2];
      output[outputOffset + 3] = pixels[sourceOffset + 3];
      if (safeAmount === 0 || pixels[sourceOffset + 3] === 0) continue;
      const left = Math.max(0, x - radius);
      const right = Math.min(width - 1, x + radius);
      const top = Math.max(0, sourceY - radius);
      const bottom = Math.min(height - 1, sourceY + radius);
      const visible = area(visibleIntegral, left, top, right, bottom);
      if (visible < 2) continue;
      const localMean = area(luminanceIntegral, left, top, right, bottom) / visible / 2_550_000;
      const red = pixels[sourceOffset] / 255;
      const green = pixels[sourceOffset + 1] / 255;
      const blue = pixels[sourceOffset + 2] / 255;
      const luminance = (2126 * pixels[sourceOffset]
        + 7152 * pixels[sourceOffset + 1]
        + 722 * pixels[sourceOffset + 2]) / 2_550_000;
      const detail = luminance - localMean;
      const protectedDetail = Math.sign(detail) * Math.min(0.12, Math.max(0, Math.abs(detail) - noiseFloor));
      let delta = protectedDetail * gain * 4 * luminance * (1 - luminance);
      if (delta > 0) delta = Math.min(delta, Math.max(0, 1 - Math.max(red, green, blue)));
      if (delta < 0) delta = Math.max(delta, -Math.max(0, Math.min(red, green, blue)));
      output[outputOffset] = Math.round(clamp(red + delta, 0, 1) * 255);
      output[outputOffset + 1] = Math.round(clamp(green + delta, 0, 1) * 255);
      output[outputOffset + 2] = Math.round(clamp(blue + delta, 0, 1) * 255);
    }
  }
  return output;
}

function srgbToLinear(value: number) {
  return srgbNormalizedToLinear(value / 255);
}

function srgbNormalizedToLinear(normalized: number) {
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function linearToSrgbNormalized(value: number) {
  const safe = clamp(value, 0, 1);
  return safe <= 0.0031308 ? safe * 12.92 : 1.055 * safe ** (1 / 2.4) - 0.055;
}

function linearToSrgb(value: number) {
  return Math.round(clamp(linearToSrgbNormalized(value) * 255, 0, 255));
}

const CURVE_STEP = 0.25;

export function toneCurveOutputs(recipe: ImageToneRecipe): readonly number[] {
  const safe = sanitizeToneRecipe(recipe);
  return [safe.curveBlack, safe.curveShadows, safe.curveMidtones, safe.curveHighlights, safe.curveWhite]
    .map((value) => value / 100);
}

export function isNeutralToneCurve(recipe: ImageToneRecipe): boolean {
  const safe = sanitizeToneRecipe(recipe);
  return safe.curveBlack === 0 && safe.curveShadows === 25 && safe.curveMidtones === 50
    && safe.curveHighlights === 75 && safe.curveWhite === 100;
}

function toneCurveSlopes(outputs: readonly number[]): number[] {
  const deltas = outputs.slice(0, -1).map((value, index) => (outputs[index + 1] - value) / CURVE_STEP);
  const slopes = new Array<number>(outputs.length).fill(0);
  for (let index = 1; index < outputs.length - 1; index += 1) {
    const before = deltas[index - 1];
    const after = deltas[index];
    slopes[index] = before <= 0 || after <= 0 ? 0 : 2 / (1 / before + 1 / after);
  }
  const endpoint = (first: number, second: number) => {
    let slope = (3 * first - second) / 2;
    if (slope * first <= 0) return 0;
    if (first * second < 0 && Math.abs(slope) > Math.abs(3 * first)) slope = 3 * first;
    return slope;
  };
  slopes[0] = endpoint(deltas[0], deltas[1]);
  slopes[slopes.length - 1] = endpoint(deltas[deltas.length - 1], deltas[deltas.length - 2]);
  return slopes;
}

/** Evaluates the bounded monotone curve in perceptual sRGB luminance space. */
function evaluatePreparedToneCurve(value: number, outputs: readonly number[], slopes: readonly number[]): number {
  const input = clamp(Number.isFinite(value) ? value : 0, 0, 1);
  if (input <= 0) return outputs[0];
  if (input >= 1) return outputs[outputs.length - 1];
  const segment = Math.min(outputs.length - 2, Math.floor(input / CURVE_STEP));
  const position = (input - segment * CURVE_STEP) / CURVE_STEP;
  const position2 = position * position;
  const position3 = position2 * position;
  const result = (2 * position3 - 3 * position2 + 1) * outputs[segment]
    + (position3 - 2 * position2 + position) * CURVE_STEP * slopes[segment]
    + (-2 * position3 + 3 * position2) * outputs[segment + 1]
    + (position3 - position2) * CURVE_STEP * slopes[segment + 1];
  return clamp(result, outputs[segment], outputs[segment + 1]);
}

export function evaluateToneCurve(value: number, recipe: ImageToneRecipe): number {
  const outputs = toneCurveOutputs(recipe);
  return evaluatePreparedToneCurve(value, outputs, toneCurveSlopes(outputs));
}

function smoothstep(minimum: number, maximum: number, value: number) {
  const position = clamp((value - minimum) / (maximum - minimum), 0, 1);
  return position * position * (3 - 2 * position);
}

/**
 * Redistributes recoverable endpoint tones without moving exact black/white.
 * This is deterministic tonal compression, not reconstruction of clipped detail.
 */
export function evaluateProtectedRecovery(
  value: number,
  shadowRecovery: number,
  highlightRecovery: number,
): number {
  const input = clamp(Number.isFinite(value) ? value : 0, 0, 1);
  const shadows = bounded(shadowRecovery, 0, 100, 0) / 100;
  const highlights = bounded(highlightRecovery, 0, 100, 0) / 100;
  const endpointProtection = 4 * input * (1 - input);
  const shadowWindow = 1 - smoothstep(0.08, 0.58, input);
  const highlightWindow = smoothstep(0.42, 0.92, input);
  return clamp(
    input
      + shadows * 0.14 * shadowWindow * endpointProtection
      - highlights * 0.14 * highlightWindow * endpointProtection,
    0,
    1,
  );
}

/**
 * Applies one deterministic, global tone curve to straight-alpha sRGB bytes.
 * Alpha and fully transparent hidden RGB are preserved exactly.
 */
export function applyToneToRgba(pixels: Uint8ClampedArray, recipe: ImageToneRecipe): ImageToneStatistics {
  if (pixels.byteLength % 4 !== 0) throw new Error("Tone adjustment requires complete RGBA pixels.");
  const safe = sanitizeToneRecipe(recipe);
  const statistics: ImageToneStatistics = {
    processedPixels: 0,
    changedPixels: 0,
    newShadowClippedPixels: 0,
    newHighlightClippedPixels: 0,
  };
  if (isNeutralTone(safe)) return statistics;

  const exposure = 2 ** safe.exposure;
  const brightness = safe.brightness / 100;
  const contrast = 2 ** (safe.contrast / 100 * 1.5);
  const gammaExponent = 2 ** (-safe.gamma / 100);
  const highlights = safe.highlights / 100;
  const shadows = safe.shadows / 100;
  const whites = safe.whites / 100;
  const blacks = safe.blacks / 100;
  const levelsAreNeutral = safe.levelBlack === 0 && safe.levelWhite === 255 && safe.levelMidtone === 1;
  const curveIsNeutral = isNeutralToneCurve(safe);
  const curveOutputs = toneCurveOutputs(safe);
  const curveSlopes = toneCurveSlopes(curveOutputs);
  const recoveryIsNeutral = safe.shadowRecovery === 0 && safe.highlightRecovery === 0;
  const levelBlack = srgbToLinear(safe.levelBlack);
  const levelWhite = srgbToLinear(safe.levelWhite);
  const levelRange = levelWhite - levelBlack;
  const levelExponent = 1 / safe.levelMidtone;

  for (let offset = 0; offset < pixels.byteLength; offset += 4) {
    if (pixels[offset + 3] === 0) continue;
    statistics.processedPixels += 1;
    const beforeRed = pixels[offset];
    const beforeGreen = pixels[offset + 1];
    const beforeBlue = pixels[offset + 2];
    let red = srgbToLinear(beforeRed);
    let green = srgbToLinear(beforeGreen);
    let blue = srgbToLinear(beforeBlue);
    if (!levelsAreNeutral) {
      const sourceLuminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      const normalizedLuminance = clamp((sourceLuminance - levelBlack) / levelRange, 0, 1);
      const levelledLuminance = normalizedLuminance ** levelExponent;
      const levelsDelta = levelledLuminance - sourceLuminance;
      red += levelsDelta;
      green += levelsDelta;
      blue += levelsDelta;
    }
    if (!curveIsNeutral) {
      const sourceLuminance = clamp(0.2126 * red + 0.7152 * green + 0.0722 * blue, 0, 1);
      const encodedLuminance = linearToSrgbNormalized(sourceLuminance);
      const curveLuminance = srgbNormalizedToLinear(evaluatePreparedToneCurve(encodedLuminance, curveOutputs, curveSlopes));
      const curveDelta = curveLuminance - sourceLuminance;
      red += curveDelta;
      green += curveDelta;
      blue += curveDelta;
    }
    if (!recoveryIsNeutral) {
      const sourceLuminance = clamp(0.2126 * red + 0.7152 * green + 0.0722 * blue, 0, 1);
      const encodedLuminance = linearToSrgbNormalized(sourceLuminance);
      const recoveredLuminance = srgbNormalizedToLinear(evaluateProtectedRecovery(
        encodedLuminance,
        safe.shadowRecovery,
        safe.highlightRecovery,
      ));
      let recoveryDelta = recoveredLuminance - sourceLuminance;
      if (recoveryDelta > 0) {
        recoveryDelta = Math.min(recoveryDelta, Math.max(0, 1 - Math.max(red, green, blue)));
      }
      if (recoveryDelta < 0) {
        recoveryDelta = Math.max(recoveryDelta, -Math.max(0, Math.min(red, green, blue)));
      }
      red += recoveryDelta;
      green += recoveryDelta;
      blue += recoveryDelta;
    }
    red *= exposure;
    green *= exposure;
    blue *= exposure;
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    const boundedLuminance = clamp(luminance, 0, 1);
    const inverse = 1 - boundedLuminance;
    let target = boundedLuminance
      + brightness * 0.25
      + shadows * 1.8 * boundedLuminance * inverse * inverse
      + highlights * 1.8 * boundedLuminance * boundedLuminance * inverse
      + blacks * 0.2 * inverse ** 4
      + whites * 0.2 * boundedLuminance ** 4;
    target = 0.5 + (target - 0.5) * contrast;
    target = clamp(target, 0, 1) ** gammaExponent;
    const delta = target - luminance;
    const outputRed = linearToSrgb(red + delta);
    const outputGreen = linearToSrgb(green + delta);
    const outputBlue = linearToSrgb(blue + delta);
    pixels[offset] = outputRed;
    pixels[offset + 1] = outputGreen;
    pixels[offset + 2] = outputBlue;
    if (outputRed !== beforeRed || outputGreen !== beforeGreen || outputBlue !== beforeBlue) {
      statistics.changedPixels += 1;
    }
    const beforeShadowClipped = beforeRed <= 1 && beforeGreen <= 1 && beforeBlue <= 1;
    const beforeHighlightClipped = beforeRed >= 254 && beforeGreen >= 254 && beforeBlue >= 254;
    if (!beforeShadowClipped && outputRed <= 1 && outputGreen <= 1 && outputBlue <= 1) {
      statistics.newShadowClippedPixels += 1;
    }
    if (!beforeHighlightClipped && outputRed >= 254 && outputGreen >= 254 && outputBlue >= 254) {
      statistics.newHighlightClippedPixels += 1;
    }
  }
  return statistics;
}
