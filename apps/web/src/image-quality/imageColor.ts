export const IMAGE_SELECTIVE_COLOR_RANGES = [
  "red",
  "orange",
  "yellow",
  "green",
  "aqua",
  "blue",
  "purple",
  "magenta",
] as const;

export type ImageSelectiveColorRange = typeof IMAGE_SELECTIVE_COLOR_RANGES[number];

export interface ImageSelectiveHslAdjustment {
  /** Bounded hue rotation. A value of 100 maps to 30 degrees. */
  hue: number;
  saturation: number;
  lightness: number;
}

export type ImageSelectiveHslRecipe = Record<ImageSelectiveColorRange, ImageSelectiveHslAdjustment>;

export interface ImageColorRecipe {
  /** Blue/yellow white-balance axis. Positive values warm the image. */
  temperature: number;
  /** Green/magenta white-balance axis. Positive values add magenta. */
  tint: number;
  saturation: number;
  /** Saturation weighted toward less-saturated pixels. */
  vibrance: number;
  /** Smoothly blended, source-hue selective corrections. */
  selectiveHsl: ImageSelectiveHslRecipe;
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

const GLOBAL_COLOR_KEYS = ["temperature", "tint", "saturation", "vibrance"] as const;
const SELECTIVE_HSL_KEYS = ["hue", "saturation", "lightness"] as const;
const SELECTIVE_HUE_CENTRES: Record<ImageSelectiveColorRange, number> = {
  red: 0,
  orange: 30,
  yellow: 60,
  green: 120,
  aqua: 180,
  blue: 240,
  purple: 280,
  magenta: 320,
};

function createNeutralSelectiveHsl(): ImageSelectiveHslRecipe {
  return Object.fromEntries(IMAGE_SELECTIVE_COLOR_RANGES.map((range) => [
    range,
    { hue: 0, saturation: 0, lightness: 0 },
  ])) as ImageSelectiveHslRecipe;
}

export function createNeutralColorRecipe(): ImageColorRecipe {
  return {
    temperature: 0,
    tint: 0,
    saturation: 0,
    vibrance: 0,
    selectiveHsl: createNeutralSelectiveHsl(),
  };
}

export function sanitizeColorRecipe(recipe: ImageColorRecipe): ImageColorRecipe {
  const selectiveHsl = createNeutralSelectiveHsl();
  for (const range of IMAGE_SELECTIVE_COLOR_RANGES) {
    const adjustment = recipe.selectiveHsl?.[range];
    selectiveHsl[range] = {
      hue: Math.round(bounded(adjustment?.hue, -100, 100, 0)),
      saturation: Math.round(bounded(adjustment?.saturation, -100, 100, 0)),
      lightness: Math.round(bounded(adjustment?.lightness, -100, 100, 0)),
    };
  }
  return {
    temperature: Math.round(bounded(recipe.temperature, -100, 100, 0)),
    tint: Math.round(bounded(recipe.tint, -100, 100, 0)),
    saturation: Math.round(bounded(recipe.saturation, -100, 100, 0)),
    vibrance: Math.round(bounded(recipe.vibrance, -100, 100, 0)),
    selectiveHsl,
  };
}

export function isNeutralColor(recipe: ImageColorRecipe): boolean {
  const safe = sanitizeColorRecipe(recipe);
  return GLOBAL_COLOR_KEYS.every((key) => safe[key] === 0)
    && IMAGE_SELECTIVE_COLOR_RANGES.every((range) => (
      SELECTIVE_HSL_KEYS.every((key) => safe.selectiveHsl[range][key] === 0)
    ));
}

export function sameColorRecipe(left: ImageColorRecipe | null, right: ImageColorRecipe | null): boolean {
  if (!left || !right) return left === right;
  const safeLeft = sanitizeColorRecipe(left);
  const safeRight = sanitizeColorRecipe(right);
  return GLOBAL_COLOR_KEYS.every((key) => safeLeft[key] === safeRight[key])
    && IMAGE_SELECTIVE_COLOR_RANGES.every((range) => (
      SELECTIVE_HSL_KEYS.every((key) => safeLeft.selectiveHsl[range][key] === safeRight.selectiveHsl[range][key])
    ));
}

export function isSanitizedColorRecipe(recipe: ImageColorRecipe): boolean {
  const safe = sanitizeColorRecipe(recipe);
  return GLOBAL_COLOR_KEYS.every((key) => recipe[key] === safe[key])
    && IMAGE_SELECTIVE_COLOR_RANGES.every((range) => {
      const adjustment = recipe.selectiveHsl?.[range];
      return Boolean(adjustment) && SELECTIVE_HSL_KEYS.every((key) => adjustment[key] === safe.selectiveHsl[range][key]);
    });
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

function rgbToHsl(red: number, green: number, blue: number) {
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const chroma = maximum - minimum;
  const lightness = (maximum + minimum) / 2;
  if (chroma === 0) return { hue: 0, saturation: 0, lightness };
  const saturation = chroma / (1 - Math.abs(2 * lightness - 1));
  const segment = maximum === red
    ? ((green - blue) / chroma) % 6
    : maximum === green
      ? (blue - red) / chroma + 2
      : (red - green) / chroma + 4;
  return { hue: (segment * 60 + 360) % 360, saturation, lightness };
}

function hslToRgb(hue: number, saturation: number, lightness: number) {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const segment = ((hue % 360) + 360) % 360 / 60;
  const intermediate = chroma * (1 - Math.abs(segment % 2 - 1));
  const [red, green, blue] = segment < 1 ? [chroma, intermediate, 0]
    : segment < 2 ? [intermediate, chroma, 0]
      : segment < 3 ? [0, chroma, intermediate]
        : segment < 4 ? [0, intermediate, chroma]
          : segment < 5 ? [intermediate, 0, chroma]
            : [chroma, 0, intermediate];
  const match = lightness - chroma / 2;
  return { red: red + match, green: green + match, blue: blue + match };
}

function selectiveHueWeights(hue: number): Array<[ImageSelectiveColorRange, number]> {
  for (let index = 0; index < IMAGE_SELECTIVE_COLOR_RANGES.length; index += 1) {
    const current = IMAGE_SELECTIVE_COLOR_RANGES[index];
    const next = IMAGE_SELECTIVE_COLOR_RANGES[(index + 1) % IMAGE_SELECTIVE_COLOR_RANGES.length];
    const start = SELECTIVE_HUE_CENTRES[current];
    const end = index === IMAGE_SELECTIVE_COLOR_RANGES.length - 1 ? 360 : SELECTIVE_HUE_CENTRES[next];
    const adjustedHue = hue < start && index === IMAGE_SELECTIVE_COLOR_RANGES.length - 1 ? hue + 360 : hue;
    if (adjustedHue >= start && adjustedHue <= end) {
      const nextWeight = end === start ? 0 : (adjustedHue - start) / (end - start);
      return [[current, 1 - nextWeight], [next, nextWeight]];
    }
  }
  return [["red", 1]];
}

function applySelectiveHsl(
  red: number,
  green: number,
  blue: number,
  recipe: ImageSelectiveHslRecipe,
) {
  const hsl = rgbToHsl(red, green, blue);
  // Exact and near-neutral pixels have no trustworthy hue and therefore stay protected.
  const hueConfidence = clamp((hsl.saturation - 0.02) / 0.08, 0, 1);
  if (hueConfidence === 0) return { red, green, blue };
  let hueControl = 0;
  let saturationControl = 0;
  let lightnessControl = 0;
  for (const [range, weight] of selectiveHueWeights(hsl.hue)) {
    hueControl += recipe[range].hue * weight;
    saturationControl += recipe[range].saturation * weight;
    lightnessControl += recipe[range].lightness * weight;
  }
  if (hueControl === 0 && saturationControl === 0 && lightnessControl === 0) return { red, green, blue };

  const hue = (hsl.hue + hueControl * 0.3 * hueConfidence + 360) % 360;
  const saturationAmount = saturationControl / 100 * hueConfidence;
  const saturation = clamp(saturationAmount >= 0
    ? hsl.saturation + (1 - hsl.saturation) * saturationAmount
    : hsl.saturation * (1 + saturationAmount), 0, 1);
  const lightnessAmount = lightnessControl / 100 * hueConfidence * 0.45;
  const lightness = clamp(lightnessAmount >= 0
    ? hsl.lightness + (1 - hsl.lightness) * lightnessAmount
    : hsl.lightness * (1 + lightnessAmount), 0, 1);
  return hslToRgb(hue, saturation, lightness);
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
  const selectiveActive = IMAGE_SELECTIVE_COLOR_RANGES.some((range) => (
    SELECTIVE_HSL_KEYS.some((key) => safe.selectiveHsl[range][key] !== 0)
  ));

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
    let outputRed = linearToSrgb(red);
    let outputGreen = linearToSrgb(green);
    let outputBlue = linearToSrgb(blue);
    if (selectiveActive) {
      const selective = applySelectiveHsl(
        outputRed / 255,
        outputGreen / 255,
        outputBlue / 255,
        safe.selectiveHsl,
      );
      outputRed = Math.round(clamp(selective.red * 255, 0, 255));
      outputGreen = Math.round(clamp(selective.green * 255, 0, 255));
      outputBlue = Math.round(clamp(selective.blue * 255, 0, 255));
    }
    pixels[offset] = outputRed;
    pixels[offset + 1] = outputGreen;
    pixels[offset + 2] = outputBlue;
    if (outputRed !== beforeRed || outputGreen !== beforeGreen || outputBlue !== beforeBlue) {
      statistics.changedPixels += 1;
    }
  }
  return statistics;
}
