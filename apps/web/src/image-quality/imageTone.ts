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
