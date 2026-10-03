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

export const IMAGE_COLOR_GRADING_RANGES = ["shadows", "midtones", "highlights"] as const;

export type ImageColorGradingRange = typeof IMAGE_COLOR_GRADING_RANGES[number];

export interface ImageColorGrade {
  /** Tint hue in degrees. It has no effect while saturation is zero. */
  hue: number;
  saturation: number;
  luminance: number;
}

export type ImageColorGradingRecipe = Record<ImageColorGradingRange, ImageColorGrade>;

export interface ImageBlackAndWhiteRecipe {
  enabled: boolean;
  red: number;
  green: number;
  blue: number;
}

export interface ImageDuotoneRecipe {
  enabled: boolean;
  shadowHue: number;
  shadowSaturation: number;
  highlightHue: number;
  highlightSaturation: number;
  /** Negative values favor the highlight tint; positive values favor the shadow tint. */
  balance: number;
}

export interface ImagePointColorRecipe extends ImageSelectiveHslAdjustment {
  enabled: boolean;
  /** Sampled source hue in degrees. */
  targetHue: number;
  /** Full-strength circular hue distance in degrees. */
  tolerance: number;
  /** Additional smooth transition width in degrees. */
  feather: number;
}

interface PreparedColorGrade extends ImageColorGrade {
  tintRed: number;
  tintGreen: number;
  tintBlue: number;
}

type PreparedColorGradingRecipe = Record<ImageColorGradingRange, PreparedColorGrade>;

interface PreparedDuotoneRecipe extends ImageDuotoneRecipe {
  shadowTintRed: number;
  shadowTintGreen: number;
  shadowTintBlue: number;
  highlightTintRed: number;
  highlightTintGreen: number;
  highlightTintBlue: number;
}

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
  /** One source-sampled hue target with a bounded feathered selection. */
  pointColor: ImagePointColorRecipe;
  /** Smoothly blended colour and luminance corrections by tonal range. */
  colorGrading: ImageColorGradingRecipe;
  /** Opt-in normalized linear-light channel mixer. */
  blackAndWhite: ImageBlackAndWhiteRecipe;
  /** Opt-in luminance-preserving two-colour toning. */
  duotone: ImageDuotoneRecipe;
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

export interface ImagePointColorSample {
  sourceX: number;
  sourceY: number;
  radius: number;
  visiblePixels: number;
  red: number;
  green: number;
  blue: number;
  hue: number;
  saturation: number;
  lightness: number;
}

export const MAX_BROWSER_COLOR_PIXELS = 67_108_864;

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const bounded = (value: number, minimum: number, maximum: number, fallback: number) => (
  clamp(Number.isFinite(value) ? value : fallback, minimum, maximum)
);

const GLOBAL_COLOR_KEYS = ["temperature", "tint", "saturation", "vibrance"] as const;
const SELECTIVE_HSL_KEYS = ["hue", "saturation", "lightness"] as const;
const POINT_COLOR_KEYS = ["targetHue", "tolerance", "feather", "hue", "saturation", "lightness"] as const;
const COLOR_GRADING_KEYS = ["hue", "saturation", "luminance"] as const;
const BLACK_AND_WHITE_KEYS = ["red", "green", "blue"] as const;
const DUOTONE_KEYS = ["shadowHue", "shadowSaturation", "highlightHue", "highlightSaturation", "balance"] as const;
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

function createNeutralColorGrading(): ImageColorGradingRecipe {
  return Object.fromEntries(IMAGE_COLOR_GRADING_RANGES.map((range) => [
    range,
    { hue: 0, saturation: 0, luminance: 0 },
  ])) as ImageColorGradingRecipe;
}

export function createNeutralColorRecipe(): ImageColorRecipe {
  return {
    temperature: 0,
    tint: 0,
    saturation: 0,
    vibrance: 0,
    selectiveHsl: createNeutralSelectiveHsl(),
    pointColor: {
      enabled: false,
      targetHue: 0,
      tolerance: 18,
      feather: 18,
      hue: 0,
      saturation: 0,
      lightness: 0,
    },
    colorGrading: createNeutralColorGrading(),
    blackAndWhite: { enabled: false, red: 40, green: 40, blue: 20 },
    duotone: {
      enabled: false,
      shadowHue: 220,
      shadowSaturation: 35,
      highlightHue: 40,
      highlightSaturation: 25,
      balance: 0,
    },
  };
}

export function sanitizeColorRecipe(recipe: ImageColorRecipe): ImageColorRecipe {
  const selectiveHsl = createNeutralSelectiveHsl();
  const colorGrading = createNeutralColorGrading();
  for (const range of IMAGE_SELECTIVE_COLOR_RANGES) {
    const adjustment = recipe.selectiveHsl?.[range];
    selectiveHsl[range] = {
      hue: Math.round(bounded(adjustment?.hue, -100, 100, 0)),
      saturation: Math.round(bounded(adjustment?.saturation, -100, 100, 0)),
      lightness: Math.round(bounded(adjustment?.lightness, -100, 100, 0)),
    };
  }
  for (const range of IMAGE_COLOR_GRADING_RANGES) {
    const grade = recipe.colorGrading?.[range];
    colorGrading[range] = {
      hue: Math.round(bounded(grade?.hue, 0, 359, 0)),
      saturation: Math.round(bounded(grade?.saturation, 0, 100, 0)),
      luminance: Math.round(bounded(grade?.luminance, -100, 100, 0)),
    };
  }
  return {
    temperature: Math.round(bounded(recipe.temperature, -100, 100, 0)),
    tint: Math.round(bounded(recipe.tint, -100, 100, 0)),
    saturation: Math.round(bounded(recipe.saturation, -100, 100, 0)),
    vibrance: Math.round(bounded(recipe.vibrance, -100, 100, 0)),
    selectiveHsl,
    pointColor: {
      enabled: recipe.pointColor?.enabled === true,
      targetHue: Math.round(bounded(recipe.pointColor?.targetHue, 0, 359, 0)),
      tolerance: Math.round(bounded(recipe.pointColor?.tolerance, 5, 60, 18)),
      feather: Math.round(bounded(recipe.pointColor?.feather, 1, 60, 18)),
      hue: Math.round(bounded(recipe.pointColor?.hue, -100, 100, 0)),
      saturation: Math.round(bounded(recipe.pointColor?.saturation, -100, 100, 0)),
      lightness: Math.round(bounded(recipe.pointColor?.lightness, -100, 100, 0)),
    },
    colorGrading,
    blackAndWhite: {
      enabled: recipe.blackAndWhite?.enabled === true,
      red: Math.round(bounded(recipe.blackAndWhite?.red, 0, 100, 40)),
      green: Math.round(bounded(recipe.blackAndWhite?.green, 0, 100, 40)),
      blue: Math.round(bounded(recipe.blackAndWhite?.blue, 0, 100, 20)),
    },
    duotone: {
      enabled: recipe.duotone?.enabled === true,
      shadowHue: Math.round(bounded(recipe.duotone?.shadowHue, 0, 359, 220)),
      shadowSaturation: Math.round(bounded(recipe.duotone?.shadowSaturation, 0, 100, 35)),
      highlightHue: Math.round(bounded(recipe.duotone?.highlightHue, 0, 359, 40)),
      highlightSaturation: Math.round(bounded(recipe.duotone?.highlightSaturation, 0, 100, 25)),
      balance: Math.round(bounded(recipe.duotone?.balance, -100, 100, 0)),
    },
  };
}

export function isNeutralColor(recipe: ImageColorRecipe): boolean {
  const safe = sanitizeColorRecipe(recipe);
  return GLOBAL_COLOR_KEYS.every((key) => safe[key] === 0)
    && IMAGE_SELECTIVE_COLOR_RANGES.every((range) => (
      SELECTIVE_HSL_KEYS.every((key) => safe.selectiveHsl[range][key] === 0)
    ))
    && (!safe.pointColor.enabled || SELECTIVE_HSL_KEYS.every((key) => safe.pointColor[key] === 0))
    && IMAGE_COLOR_GRADING_RANGES.every((range) => (
      safe.colorGrading[range].saturation === 0 && safe.colorGrading[range].luminance === 0
    ))
    && !safe.blackAndWhite.enabled
    && !safe.duotone.enabled;
}

export function sameColorRecipe(left: ImageColorRecipe | null, right: ImageColorRecipe | null): boolean {
  if (!left || !right) return left === right;
  const safeLeft = sanitizeColorRecipe(left);
  const safeRight = sanitizeColorRecipe(right);
  return GLOBAL_COLOR_KEYS.every((key) => safeLeft[key] === safeRight[key])
    && IMAGE_SELECTIVE_COLOR_RANGES.every((range) => (
      SELECTIVE_HSL_KEYS.every((key) => safeLeft.selectiveHsl[range][key] === safeRight.selectiveHsl[range][key])
    ))
    && safeLeft.pointColor.enabled === safeRight.pointColor.enabled
    && POINT_COLOR_KEYS.every((key) => safeLeft.pointColor[key] === safeRight.pointColor[key])
    && IMAGE_COLOR_GRADING_RANGES.every((range) => (
      COLOR_GRADING_KEYS.every((key) => safeLeft.colorGrading[range][key] === safeRight.colorGrading[range][key])
    ))
    && safeLeft.blackAndWhite.enabled === safeRight.blackAndWhite.enabled
    && BLACK_AND_WHITE_KEYS.every((key) => safeLeft.blackAndWhite[key] === safeRight.blackAndWhite[key])
    && safeLeft.duotone.enabled === safeRight.duotone.enabled
    && DUOTONE_KEYS.every((key) => safeLeft.duotone[key] === safeRight.duotone[key]);
}

export function isSanitizedColorRecipe(recipe: ImageColorRecipe): boolean {
  const safe = sanitizeColorRecipe(recipe);
  return GLOBAL_COLOR_KEYS.every((key) => recipe[key] === safe[key])
    && IMAGE_SELECTIVE_COLOR_RANGES.every((range) => {
      const adjustment = recipe.selectiveHsl?.[range];
      return Boolean(adjustment) && SELECTIVE_HSL_KEYS.every((key) => adjustment[key] === safe.selectiveHsl[range][key]);
    })
    && recipe.pointColor?.enabled === safe.pointColor.enabled
    && POINT_COLOR_KEYS.every((key) => recipe.pointColor?.[key] === safe.pointColor[key])
    && IMAGE_COLOR_GRADING_RANGES.every((range) => {
      const grade = recipe.colorGrading?.[range];
      return Boolean(grade) && COLOR_GRADING_KEYS.every((key) => grade[key] === safe.colorGrading[range][key]);
    })
    && recipe.blackAndWhite?.enabled === safe.blackAndWhite.enabled
    && BLACK_AND_WHITE_KEYS.every((key) => recipe.blackAndWhite?.[key] === safe.blackAndWhite[key])
    && (!safe.blackAndWhite.enabled
      || safe.blackAndWhite.red + safe.blackAndWhite.green + safe.blackAndWhite.blue > 0)
    && recipe.duotone?.enabled === safe.duotone.enabled
    && DUOTONE_KEYS.every((key) => recipe.duotone?.[key] === safe.duotone[key]);
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

function smoothstep(edge0: number, edge1: number, value: number) {
  const position = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return position * position * (3 - 2 * position);
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

function circularHueDistance(left: number, right: number) {
  const distance = Math.abs(left - right) % 360;
  return Math.min(distance, 360 - distance);
}

function pointColorSelectionWeight(red: number, green: number, blue: number, recipe: ImagePointColorRecipe) {
  const hsl = rgbToHsl(red, green, blue);
  const hueConfidence = clamp((hsl.saturation - 0.02) / 0.08, 0, 1);
  if (hueConfidence === 0) return 0;
  const distance = circularHueDistance(hsl.hue, recipe.targetHue);
  return hueConfidence * (1 - smoothstep(recipe.tolerance, recipe.tolerance + recipe.feather, distance));
}

function applyPointColorHsl(
  red: number,
  green: number,
  blue: number,
  recipe: ImagePointColorRecipe,
  weight: number,
) {
  if (weight === 0) return { red, green, blue };
  const hsl = rgbToHsl(red, green, blue);
  const hue = (hsl.hue + recipe.hue * 0.3 * weight + 360) % 360;
  const saturationAmount = recipe.saturation / 100 * weight;
  const saturation = clamp(saturationAmount >= 0
    ? hsl.saturation + (1 - hsl.saturation) * saturationAmount
    : hsl.saturation * (1 + saturationAmount), 0, 1);
  const lightnessAmount = recipe.lightness / 100 * weight * 0.45;
  const lightness = clamp(lightnessAmount >= 0
    ? hsl.lightness + (1 - hsl.lightness) * lightnessAmount
    : hsl.lightness * (1 + lightnessAmount), 0, 1);
  return hslToRgb(hue, saturation, lightness);
}

function colorGradingWeights(luminance: number): Record<ImageColorGradingRange, number> {
  const weights = {
    shadows: 1 - smoothstep(0.12, 0.5, luminance),
    midtones: smoothstep(0.08, 0.42, luminance) * (1 - smoothstep(0.58, 0.92, luminance)),
    highlights: smoothstep(0.5, 0.88, luminance),
  };
  const total = weights.shadows + weights.midtones + weights.highlights;
  if (total <= 1) return weights;
  return {
    shadows: weights.shadows / total,
    midtones: weights.midtones / total,
    highlights: weights.highlights / total,
  };
}

function prepareColorGrading(recipe: ImageColorGradingRecipe): PreparedColorGradingRecipe {
  return Object.fromEntries(IMAGE_COLOR_GRADING_RANGES.map((range) => {
    const grade = recipe[range];
    const target = hslToRgb(grade.hue, 1, 0.5);
    const targetRed = srgbToLinear(target.red * 255);
    const targetGreen = srgbToLinear(target.green * 255);
    const targetBlue = srgbToLinear(target.blue * 255);
    const targetLuminance = 0.2126 * targetRed + 0.7152 * targetGreen + 0.0722 * targetBlue;
    return [range, {
      ...grade,
      tintRed: targetRed - targetLuminance,
      tintGreen: targetGreen - targetLuminance,
      tintBlue: targetBlue - targetLuminance,
    }];
  })) as PreparedColorGradingRecipe;
}

function applyColorGrading(
  encodedRed: number,
  encodedGreen: number,
  encodedBlue: number,
  recipe: PreparedColorGradingRecipe,
) {
  let red = srgbToLinear(encodedRed * 255);
  let green = srgbToLinear(encodedGreen * 255);
  let blue = srgbToLinear(encodedBlue * 255);
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  const endpointGate = Math.min(smoothstep(0, 0.025, luminance), 1 - smoothstep(0.975, 1, luminance));
  if (endpointGate <= 0) return { red: encodedRed, green: encodedGreen, blue: encodedBlue };

  const weights = colorGradingWeights(luminance);
  let tintRed = 0;
  let tintGreen = 0;
  let tintBlue = 0;
  let luminanceControl = 0;
  for (const range of IMAGE_COLOR_GRADING_RANGES) {
    const grade = recipe[range];
    const weight = weights[range];
    luminanceControl += weight * grade.luminance / 100;
    if (grade.saturation === 0 || weight === 0) continue;
    const amount = weight * grade.saturation / 100;
    tintRed += grade.tintRed * amount;
    tintGreen += grade.tintGreen * amount;
    tintBlue += grade.tintBlue * amount;
  }

  const tintStrength = 0.2 * endpointGate;
  const delta = [tintRed * tintStrength, tintGreen * tintStrength, tintBlue * tintStrength];
  const channels = [red, green, blue];
  let headroomScale = 1;
  for (let index = 0; index < channels.length; index += 1) {
    if (delta[index] > 0) headroomScale = Math.min(headroomScale, (1 - channels[index]) / delta[index]);
    if (delta[index] < 0) headroomScale = Math.min(headroomScale, channels[index] / -delta[index]);
  }
  red += delta[0] * Math.max(0, headroomScale);
  green += delta[1] * Math.max(0, headroomScale);
  blue += delta[2] * Math.max(0, headroomScale);

  const luminanceAmount = clamp(luminanceControl * 0.18 * endpointGate, -0.18, 0.18);
  if (luminanceAmount >= 0) {
    red += (1 - red) * luminanceAmount;
    green += (1 - green) * luminanceAmount;
    blue += (1 - blue) * luminanceAmount;
  } else {
    red *= 1 + luminanceAmount;
    green *= 1 + luminanceAmount;
    blue *= 1 + luminanceAmount;
  }
  return {
    red: linearToSrgb(red) / 255,
    green: linearToSrgb(green) / 255,
    blue: linearToSrgb(blue) / 255,
  };
}

function prepareDuotone(recipe: ImageDuotoneRecipe): PreparedDuotoneRecipe {
  const tintVector = (hue: number) => {
    const target = hslToRgb(hue, 1, 0.5);
    const red = srgbToLinear(target.red * 255);
    const green = srgbToLinear(target.green * 255);
    const blue = srgbToLinear(target.blue * 255);
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    return { red: red - luminance, green: green - luminance, blue: blue - luminance };
  };
  const shadow = tintVector(recipe.shadowHue);
  const highlight = tintVector(recipe.highlightHue);
  return {
    ...recipe,
    shadowTintRed: shadow.red,
    shadowTintGreen: shadow.green,
    shadowTintBlue: shadow.blue,
    highlightTintRed: highlight.red,
    highlightTintGreen: highlight.green,
    highlightTintBlue: highlight.blue,
  };
}

function applyDuotone(
  encodedRed: number,
  encodedGreen: number,
  encodedBlue: number,
  recipe: PreparedDuotoneRecipe,
) {
  const red = srgbToLinear(encodedRed);
  const green = srgbToLinear(encodedGreen);
  const blue = srgbToLinear(encodedBlue);
  const luminance = clamp(0.2126 * red + 0.7152 * green + 0.0722 * blue, 0, 1);
  const endpointGate = Math.min(smoothstep(0, 0.025, luminance), 1 - smoothstep(0.975, 1, luminance));
  if (endpointGate <= 0) return { red: encodedRed, green: encodedGreen, blue: encodedBlue };

  const midpoint = 0.5 + recipe.balance * 0.004;
  const balanced = luminance <= midpoint
    ? 0.5 * luminance / midpoint
    : 0.5 + 0.5 * (luminance - midpoint) / (1 - midpoint);
  const highlightWeight = smoothstep(0, 1, balanced);
  const shadowWeight = 1 - highlightWeight;
  const shadowAmount = shadowWeight * recipe.shadowSaturation / 100;
  const highlightAmount = highlightWeight * recipe.highlightSaturation / 100;
  const tintStrength = 0.34 * endpointGate;
  const delta = [
    (recipe.shadowTintRed * shadowAmount + recipe.highlightTintRed * highlightAmount) * tintStrength,
    (recipe.shadowTintGreen * shadowAmount + recipe.highlightTintGreen * highlightAmount) * tintStrength,
    (recipe.shadowTintBlue * shadowAmount + recipe.highlightTintBlue * highlightAmount) * tintStrength,
  ];
  let headroomScale = 1;
  for (const change of delta) {
    if (change > 0) headroomScale = Math.min(headroomScale, (1 - luminance) / change);
    if (change < 0) headroomScale = Math.min(headroomScale, luminance / -change);
  }
  const scale = Math.max(0, headroomScale);
  return {
    red: linearToSrgb(luminance + delta[0] * scale),
    green: linearToSrgb(luminance + delta[1] * scale),
    blue: linearToSrgb(luminance + delta[2] * scale),
  };
}

export function whiteBalanceSampleRadius(width: number, height: number): number {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error("White-balance sampling requires positive integer image dimensions.");
  }
  return Math.min(8, Math.max(1, Math.round(Math.min(width, height) / 512)));
}

export const pointColorSampleRadius = whiteBalanceSampleRadius;

/** Measures a small visible source patch and returns its chroma-weighted circular mean hue. */
export function samplePointColorFromRgba(
  pixels: Uint8ClampedArray,
  sourceX: number,
  sourceY: number,
  radius: number,
): ImagePointColorSample {
  if (pixels.byteLength % 4 !== 0 || pixels.byteLength === 0) {
    throw new Error("Point-colour sampling requires complete RGBA pixels.");
  }
  if (!Number.isSafeInteger(sourceX) || sourceX < 0 || !Number.isSafeInteger(sourceY) || sourceY < 0
    || !Number.isSafeInteger(radius) || radius < 1 || radius > 8) {
    throw new Error("Point-colour sampling requires a valid source point and bounded radius.");
  }
  let visiblePixels = 0;
  let visibleWeight = 0;
  let chromaticWeight = 0;
  let encodedRed = 0;
  let encodedGreen = 0;
  let encodedBlue = 0;
  let hueX = 0;
  let hueY = 0;
  let saturationTotal = 0;
  let lightnessTotal = 0;
  for (let offset = 0; offset < pixels.byteLength; offset += 4) {
    const alpha = pixels[offset + 3];
    if (alpha === 0) continue;
    const weight = alpha / 255;
    visiblePixels += 1;
    visibleWeight += weight;
    encodedRed += pixels[offset] * weight;
    encodedGreen += pixels[offset + 1] * weight;
    encodedBlue += pixels[offset + 2] * weight;
    const hsl = rgbToHsl(pixels[offset] / 255, pixels[offset + 1] / 255, pixels[offset + 2] / 255);
    const colourConfidence = smoothstep(0.04, 0.16, hsl.saturation)
      * smoothstep(0.02, 0.12, hsl.lightness)
      * (1 - smoothstep(0.9, 0.99, hsl.lightness));
    const colourWeight = weight * colourConfidence;
    if (colourWeight === 0) continue;
    const radians = hsl.hue * Math.PI / 180;
    chromaticWeight += colourWeight;
    hueX += Math.cos(radians) * colourWeight;
    hueY += Math.sin(radians) * colourWeight;
    saturationTotal += hsl.saturation * colourWeight;
    lightnessTotal += hsl.lightness * colourWeight;
  }
  if (visibleWeight < 1) {
    throw new Error("The selected point-colour patch does not contain enough visible pixels. Choose an opaque coloured area.");
  }
  if (chromaticWeight / visibleWeight < 0.08 || Math.hypot(hueX, hueY) / chromaticWeight < 0.25) {
    throw new Error("The selected point-colour patch is too neutral or contains conflicting hues. Choose a more consistently coloured area.");
  }
  const hue = Math.round(((Math.atan2(hueY, hueX) * 180 / Math.PI) + 360) % 360) % 360;
  return {
    sourceX,
    sourceY,
    radius,
    visiblePixels,
    red: Math.round(encodedRed / visibleWeight),
    green: Math.round(encodedGreen / visibleWeight),
    blue: Math.round(encodedBlue / visibleWeight),
    hue,
    saturation: Math.round(clamp(saturationTotal / chromaticWeight * 100, 0, 100)),
    lightness: Math.round(clamp(lightnessTotal / chromaticWeight * 100, 0, 100)),
  };
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
  const pointColorActive = safe.pointColor.enabled
    && SELECTIVE_HSL_KEYS.some((key) => safe.pointColor[key] !== 0);
  const gradingActive = IMAGE_COLOR_GRADING_RANGES.some((range) => (
    safe.colorGrading[range].saturation !== 0 || safe.colorGrading[range].luminance !== 0
  ));
  const preparedColorGrading = gradingActive ? prepareColorGrading(safe.colorGrading) : null;
  const blackAndWhiteTotal = safe.blackAndWhite.red + safe.blackAndWhite.green + safe.blackAndWhite.blue;
  if (safe.blackAndWhite.enabled && blackAndWhiteTotal === 0) {
    throw new Error("Black-and-white mixing requires at least one non-zero colour channel.");
  }
  const blackAndWhiteWeights = safe.blackAndWhite.enabled ? {
    red: safe.blackAndWhite.red / blackAndWhiteTotal,
    green: safe.blackAndWhite.green / blackAndWhiteTotal,
    blue: safe.blackAndWhite.blue / blackAndWhiteTotal,
  } : null;
  const preparedDuotone = safe.duotone.enabled ? prepareDuotone(safe.duotone) : null;

  for (let offset = 0; offset < pixels.byteLength; offset += 4) {
    if (pixels[offset + 3] === 0) continue;
    statistics.processedPixels += 1;
    const beforeRed = pixels[offset];
    const beforeGreen = pixels[offset + 1];
    const beforeBlue = pixels[offset + 2];
    const pointColorWeight = pointColorActive
      ? pointColorSelectionWeight(beforeRed / 255, beforeGreen / 255, beforeBlue / 255, safe.pointColor)
      : 0;
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
    if (pointColorActive) {
      const pointColor = applyPointColorHsl(
        outputRed / 255,
        outputGreen / 255,
        outputBlue / 255,
        safe.pointColor,
        pointColorWeight,
      );
      outputRed = Math.round(clamp(pointColor.red * 255, 0, 255));
      outputGreen = Math.round(clamp(pointColor.green * 255, 0, 255));
      outputBlue = Math.round(clamp(pointColor.blue * 255, 0, 255));
    }
    if (preparedColorGrading) {
      const graded = applyColorGrading(
        outputRed / 255,
        outputGreen / 255,
        outputBlue / 255,
        preparedColorGrading,
      );
      outputRed = Math.round(clamp(graded.red * 255, 0, 255));
      outputGreen = Math.round(clamp(graded.green * 255, 0, 255));
      outputBlue = Math.round(clamp(graded.blue * 255, 0, 255));
    }
    if (blackAndWhiteWeights) {
      const monochrome = srgbToLinear(outputRed) * blackAndWhiteWeights.red
        + srgbToLinear(outputGreen) * blackAndWhiteWeights.green
        + srgbToLinear(outputBlue) * blackAndWhiteWeights.blue;
      outputRed = linearToSrgb(monochrome);
      outputGreen = outputRed;
      outputBlue = outputRed;
    }
    if (preparedDuotone) {
      const duotone = applyDuotone(outputRed, outputGreen, outputBlue, preparedDuotone);
      outputRed = duotone.red;
      outputGreen = duotone.green;
      outputBlue = duotone.blue;
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
