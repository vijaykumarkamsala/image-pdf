export interface ImageColorRecipe {
  /** Blue/yellow white-balance axis. Positive values warm the image. */
  temperature: number;
  /** Green/magenta white-balance axis. Positive values add magenta. */
  tint: number;
  saturation: number;
  /** Saturation weighted toward less-saturated pixels. */
  vibrance: number;
}

export interface ImageColorStatistics {
  processedPixels: number;
  changedPixels: number;
  gamutClippedPixels: number;
}

export interface ImageWhiteBalanceSuggestion {
  sourceX: number;
  sourceY: number;
  radius: number;
  visiblePixels: number;
  red: number;
  green: number;
  blue: number;
  temperature: number;
  tint: number;
  atLimit: boolean;
}

export const MAX_BROWSER_COLOR_PIXELS = 67_108_864;

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const bounded = (value: number, minimum: number, maximum: number, fallback: number) => (
  clamp(Number.isFinite(value) ? value : fallback, minimum, maximum)
);

export function createNeutralColorRecipe(): ImageColorRecipe {
  return { temperature: 0, tint: 0, saturation: 0, vibrance: 0 };
}

export function sanitizeColorRecipe(recipe: ImageColorRecipe): ImageColorRecipe {
  return {
    temperature: Math.round(bounded(recipe.temperature, -100, 100, 0)),
    tint: Math.round(bounded(recipe.tint, -100, 100, 0)),
    saturation: Math.round(bounded(recipe.saturation, -100, 100, 0)),
    vibrance: Math.round(bounded(recipe.vibrance, -100, 100, 0)),
  };
}

export function isNeutralColor(recipe: ImageColorRecipe): boolean {
  return Object.values(sanitizeColorRecipe(recipe)).every((value) => value === 0);
}

export function sameColorRecipe(left: ImageColorRecipe | null, right: ImageColorRecipe | null): boolean {
  if (!left || !right) return left === right;
  const safeLeft = sanitizeColorRecipe(left);
  const safeRight = sanitizeColorRecipe(right);
  return (Object.keys(safeLeft) as Array<keyof ImageColorRecipe>).every((key) => safeLeft[key] === safeRight[key]);
}

export function assertBrowserColorBudget(width: number, height: number): number {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error("Colour adjustment requires positive integer working dimensions.");
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > MAX_BROWSER_COLOR_PIXELS) {
    throw new Error(
      `Colour adjustment requires ${pixels.toLocaleString("en-US")} working pixels, beyond this browser's ${MAX_BROWSER_COLOR_PIXELS.toLocaleString("en-US")}-pixel safety budget. No unadjusted substitute was created.`,
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

export function whiteBalanceSampleRadius(width: number, height: number): number {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error("White-balance sampling requires positive integer image dimensions.");
  }
  return Math.min(8, Math.max(1, Math.round(Math.min(width, height) / 512)));
}

/**
 * Measures a small user-selected, known-neutral patch and proposes the inverse
 * of its blue/yellow and green/magenta cast. The proposal uses the same linear
 * RGB gain model as applyColorToRgba so it remains deterministic and reviewable.
 */
export function recommendWhiteBalanceFromRgba(
  pixels: Uint8ClampedArray,
  sourceX: number,
  sourceY: number,
  radius: number,
): ImageWhiteBalanceSuggestion {
  if (pixels.byteLength % 4 !== 0 || pixels.byteLength === 0) {
    throw new Error("White-balance sampling requires complete RGBA pixels.");
  }
  if (!Number.isSafeInteger(sourceX) || sourceX < 0 || !Number.isSafeInteger(sourceY) || sourceY < 0
    || !Number.isSafeInteger(radius) || radius < 1 || radius > 8) {
    throw new Error("White-balance sampling requires a valid source point and bounded radius.");
  }
  let visiblePixels = 0;
  let totalWeight = 0;
  let encodedRed = 0;
  let encodedGreen = 0;
  let encodedBlue = 0;
  let linearRed = 0;
  let linearGreen = 0;
  let linearBlue = 0;
  for (let offset = 0; offset < pixels.byteLength; offset += 4) {
    const alpha = pixels[offset + 3];
    if (alpha === 0) continue;
    const weight = alpha / 255;
    visiblePixels += 1;
    totalWeight += weight;
    encodedRed += pixels[offset] * weight;
    encodedGreen += pixels[offset + 1] * weight;
    encodedBlue += pixels[offset + 2] * weight;
    linearRed += srgbToLinear(pixels[offset]) * weight;
    linearGreen += srgbToLinear(pixels[offset + 1]) * weight;
    linearBlue += srgbToLinear(pixels[offset + 2]) * weight;
  }
  if (totalWeight < 1) {
    throw new Error("The selected white-balance patch does not contain enough visible pixels. Choose an opaque neutral area.");
  }
  const red = Math.round(encodedRed / totalWeight);
  const green = Math.round(encodedGreen / totalWeight);
  const blue = Math.round(encodedBlue / totalWeight);
  if (Math.max(red, green, blue) <= 12) {
    throw new Error("The selected white-balance patch is too dark to measure reliably. Choose a visible neutral grey or white area.");
  }
  if (Math.min(red, green, blue) >= 250) {
    throw new Error("The selected white-balance patch is clipped near white and has too little colour information. Choose a darker neutral area.");
  }

  const safeRed = Math.max(linearRed / totalWeight, 1 / 65_535);
  const safeGreen = Math.max(linearGreen / totalWeight, 1 / 65_535);
  const safeBlue = Math.max(linearBlue / totalWeight, 1 / 65_535);
  const rawTemperature = (Math.log2(safeBlue) - Math.log2(safeRed)) / 0.7 * 100;
  const rawTint = -(
    Math.log2(safeRed) - Math.log2(safeGreen) + 0.35 * rawTemperature / 100
  ) / 0.36 * 100;
  const roundedTemperature = Math.round(clamp(rawTemperature, -100, 100));
  const roundedTint = Math.round(clamp(rawTint, -100, 100));
  return {
    sourceX,
    sourceY,
    radius,
    visiblePixels,
    red,
    green,
    blue,
    temperature: Math.abs(roundedTemperature) <= 1 ? 0 : roundedTemperature,
    tint: Math.abs(roundedTint) <= 1 ? 0 : roundedTint,
    atLimit: Math.abs(rawTemperature) > 100 || Math.abs(rawTint) > 100,
  };
}

/** Applies a deterministic global colour transform while preserving alpha exactly. */
export function applyColorToRgba(pixels: Uint8ClampedArray, recipe: ImageColorRecipe): ImageColorStatistics {
  if (pixels.byteLength % 4 !== 0) throw new Error("Colour adjustment requires complete RGBA pixels.");
  const safe = sanitizeColorRecipe(recipe);
  const statistics: ImageColorStatistics = { processedPixels: 0, changedPixels: 0, gamutClippedPixels: 0 };
  if (isNeutralColor(safe)) return statistics;

  const temperature = safe.temperature / 100;
  const tint = safe.tint / 100;
  const saturation = safe.saturation / 100;
  const vibrance = safe.vibrance / 100;
  const redGain = 2 ** (temperature * 0.35 + tint * 0.12);
  const greenGain = 2 ** (-tint * 0.24);
  const blueGain = 2 ** (-temperature * 0.35 + tint * 0.12);
  const saturationFactor = saturation < 0 ? 1 + saturation : 1 + saturation * 1.5;

  for (let offset = 0; offset < pixels.byteLength; offset += 4) {
    if (pixels[offset + 3] === 0) continue;
    statistics.processedPixels += 1;
    const beforeRed = pixels[offset];
    const beforeGreen = pixels[offset + 1];
    const beforeBlue = pixels[offset + 2];
    let red = srgbToLinear(beforeRed) * redGain;
    let green = srgbToLinear(beforeGreen) * greenGain;
    let blue = srgbToLinear(beforeBlue) * blueGain;
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    const chroma = maximum <= 0 ? 0 : clamp((maximum - minimum) / maximum, 0, 1);
    const vibranceFactor = vibrance >= 0
      ? 1 + vibrance * 1.4 * (1 - chroma) ** 2
      : 1 + vibrance * 0.8 * (1 - chroma * 0.5);
    const chromaFactor = Math.max(0, saturationFactor * vibranceFactor);
    red = luminance + (red - luminance) * chromaFactor;
    green = luminance + (green - luminance) * chromaFactor;
    blue = luminance + (blue - luminance) * chromaFactor;
    if (red < 0 || red > 1 || green < 0 || green > 1 || blue < 0 || blue > 1) {
      statistics.gamutClippedPixels += 1;
    }
    const outputRed = linearToSrgb(red);
    const outputGreen = linearToSrgb(green);
    const outputBlue = linearToSrgb(blue);
    pixels[offset] = outputRed;
    pixels[offset + 1] = outputGreen;
    pixels[offset + 2] = outputBlue;
    if (outputRed !== beforeRed || outputGreen !== beforeGreen || outputBlue !== beforeBlue) {
      statistics.changedPixels += 1;
    }
  }
  return statistics;
}
