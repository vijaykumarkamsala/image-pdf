export interface ImageToneRecipe {
  /** Input luminance value mapped to black, expressed as an 8-bit sRGB level. */
  levelBlack: number;
  /** Input luminance value mapped to white, expressed as an 8-bit sRGB level. */
  levelWhite: number;
  /** Luminance-level midpoint. Values above 1 brighten midtones. */
  levelMidtone: number;
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
  return {
    levelBlack,
    levelWhite: Math.max(levelBlack + 1, requestedWhite),
    levelMidtone: Math.round(bounded(recipe.levelMidtone, 0.1, 3, 1) * 100) / 100,
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
  const normalized = value / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number) {
  const safe = clamp(value, 0, 1);
  const encoded = safe <= 0.0031308 ? safe * 12.92 : 1.055 * safe ** (1 / 2.4) - 0.055;
  return Math.round(clamp(encoded * 255, 0, 255));
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
