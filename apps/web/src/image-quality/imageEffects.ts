export interface ImageFilmGrainRecipe {
  /** Bounded monochrome luminance grain strength. */
  amount: number;
  /** Source-coordinate grain radius in pixels. */
  size: number;
}

export interface ImageVignetteRecipe {
  /** Negative values darken the perimeter; positive values lighten it. */
  amount: number;
  /** Distance from the centre where the transition begins, as a percentage. */
  midpoint: number;
  /** Width of the transition from unchanged centre to full perimeter effect. */
  feather: number;
}

export interface ImageEffectsRecipe {
  grain: ImageFilmGrainRecipe;
  vignette: ImageVignetteRecipe;
}

export interface ImageEffectsStatistics {
  processedPixels: number;
  changedPixels: number;
  grainChangedPixels: number;
  vignetteChangedPixels: number;
  darkenedPixels: number;
  lightenedPixels: number;
}

export const MAX_BROWSER_EFFECT_PIXELS = 67_108_864;

const SQRT_TWO = Math.SQRT2;

function bounded(value: number, minimum: number, maximum: number, fallback: number) {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

export function createNeutralEffectsRecipe(): ImageEffectsRecipe {
  return {
    grain: { amount: 0, size: 2 },
    vignette: { amount: 0, midpoint: 50, feather: 50 },
  };
}

export function sanitizeEffectsRecipe(recipe: ImageEffectsRecipe): ImageEffectsRecipe {
  return {
    grain: {
      amount: Math.round(bounded(recipe.grain?.amount, 0, 100, 0)),
      size: Math.round(bounded(recipe.grain?.size, 1, 8, 2)),
    },
    vignette: {
      amount: Math.round(bounded(recipe.vignette?.amount, -100, 100, 0)),
      midpoint: Math.round(bounded(recipe.vignette?.midpoint, 0, 100, 50)),
      feather: Math.round(bounded(recipe.vignette?.feather, 1, 100, 50)),
    },
  };
}

export function isSanitizedEffectsRecipe(recipe: ImageEffectsRecipe): boolean {
  const safe = sanitizeEffectsRecipe(recipe);
  return recipe.grain?.amount === safe.grain.amount
    && recipe.grain?.size === safe.grain.size
    && recipe.vignette?.amount === safe.vignette.amount
    && recipe.vignette?.midpoint === safe.vignette.midpoint
    && recipe.vignette?.feather === safe.vignette.feather;
}

export function isNeutralEffects(recipe: ImageEffectsRecipe): boolean {
  const safe = sanitizeEffectsRecipe(recipe);
  return safe.grain.amount === 0 && safe.vignette.amount === 0;
}

export function sameEffectsRecipe(left: ImageEffectsRecipe | null, right: ImageEffectsRecipe | null): boolean {
  if (!left || !right) return left === right;
  const safeLeft = sanitizeEffectsRecipe(left);
  const safeRight = sanitizeEffectsRecipe(right);
  return safeLeft.grain.amount === safeRight.grain.amount
    && safeLeft.grain.size === safeRight.grain.size
    && safeLeft.vignette.amount === safeRight.vignette.amount
    && safeLeft.vignette.midpoint === safeRight.vignette.midpoint
    && safeLeft.vignette.feather === safeRight.vignette.feather;
}

export function assertBrowserEffectsBudget(width: number, height: number): number {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error("Effects require positive integer image dimensions.");
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > MAX_BROWSER_EFFECT_PIXELS) {
    throw new Error(
      `Effects require ${pixels.toLocaleString("en-US")} working pixels, beyond this browser's `
      + `${MAX_BROWSER_EFFECT_PIXELS.toLocaleString("en-US")}-pixel safety budget. No unchanged substitute was created.`,
    );
  }
  return pixels;
}

function smoothstep(start: number, end: number, value: number) {
  if (value <= start) return 0;
  if (value >= end) return 1;
  const position = (value - start) / (end - start);
  return position * position * (3 - 2 * position);
}

function srgbToLinear(value: number) {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number) {
  const channel = Math.min(1, Math.max(0, value));
  const encoded = channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
  return Math.round(encoded * 255);
}

function grainHash(x: number, y: number, seed: number) {
  let value = seed ^ Math.imul(x + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(y + 0x7f4a7c15, 0xc2b2ae35);
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 0xffffffff * 2 - 1;
}

function interpolatedGrainNoise(x: number, y: number, size: number, seed: number) {
  const gridX = (x + 0.5) / size;
  const gridY = (y + 0.5) / size;
  const left = Math.floor(gridX);
  const top = Math.floor(gridY);
  const blendX = smoothstep(0, 1, gridX - left);
  const blendY = smoothstep(0, 1, gridY - top);
  const topValue = grainHash(left, top, seed) * (1 - blendX) + grainHash(left + 1, top, seed) * blendX;
  const bottomValue = grainHash(left, top + 1, seed) * (1 - blendX) + grainHash(left + 1, top + 1, seed) * blendX;
  return Math.max(-1, Math.min(1, (topValue * (1 - blendY) + bottomValue * blendY) * 1.35));
}

export function applyEffectsToRgba(
  rgba: Uint8ClampedArray,
  recipe: ImageEffectsRecipe,
  imageWidth: number,
  imageHeight: number,
  rowOffset = 0,
  grainSeed = 0,
): ImageEffectsStatistics {
  const safe = sanitizeEffectsRecipe(recipe);
  if (!Number.isSafeInteger(imageWidth) || !Number.isSafeInteger(imageHeight)
    || !Number.isSafeInteger(rowOffset) || imageWidth < 1 || imageHeight < 1 || rowOffset < 0) {
    throw new Error("Effects require valid source-coordinate dimensions.");
  }
  const tilePixels = rgba.byteLength / 4;
  if (!Number.isSafeInteger(tilePixels) || tilePixels % imageWidth !== 0) {
    throw new Error("Effects received an invalid RGBA tile.");
  }
  const tileHeight = tilePixels / imageWidth;
  if (rowOffset + tileHeight > imageHeight) throw new Error("Effects received a tile outside the source image.");

  const statistics: ImageEffectsStatistics = {
    processedPixels: 0,
    changedPixels: 0,
    grainChangedPixels: 0,
    vignetteChangedPixels: 0,
    darkenedPixels: 0,
    lightenedPixels: 0,
  };
  if (isNeutralEffects(safe)) return statistics;

  const vignetteAmount = safe.vignette.amount;
  const start = safe.vignette.midpoint / 100;
  const end = start + Math.max(0.01, safe.vignette.feather / 100) * (SQRT_TWO - start);
  const darkening = vignetteAmount < 0;
  const maximumMix = Math.abs(vignetteAmount) / 100 * (darkening ? 0.72 : 0.55);
  const maximumGrainDelta = safe.grain.amount / 100 * 20;
  const halfWidth = imageWidth / 2;
  const halfHeight = imageHeight / 2;

  for (let localY = 0; localY < tileHeight; localY += 1) {
    const sourceY = rowOffset + localY;
    const normalizedY = Math.abs((sourceY + 0.5 - halfHeight) / halfHeight);
    for (let x = 0; x < imageWidth; x += 1) {
      const offset = (localY * imageWidth + x) * 4;
      if (rgba[offset + 3] === 0) continue;
      statistics.processedPixels += 1;
      const beforeRed = rgba[offset];
      const beforeGreen = rgba[offset + 1];
      const beforeBlue = rgba[offset + 2];

      if (maximumGrainDelta > 0) {
        const luminance = rgba[offset] * 0.2126 + rgba[offset + 1] * 0.7152 + rgba[offset + 2] * 0.0722;
        const envelope = 0.35 + 0.65 * Math.sin(Math.PI * luminance / 255);
        const noise = interpolatedGrainNoise(x, sourceY, safe.grain.size, grainSeed >>> 0);
        let delta = Math.round(noise * maximumGrainDelta * envelope);
        if (delta < 0) {
          delta = Math.max(delta, -Math.min(rgba[offset], rgba[offset + 1], rgba[offset + 2]));
        } else if (delta > 0) {
          delta = Math.min(delta, 255 - Math.max(rgba[offset], rgba[offset + 1], rgba[offset + 2]));
        }
        if (delta !== 0) {
          rgba[offset] += delta;
          rgba[offset + 1] += delta;
          rgba[offset + 2] += delta;
          statistics.grainChangedPixels += 1;
        }
      }

      if (vignetteAmount !== 0) {
        const normalizedX = Math.abs((x + 0.5 - halfWidth) / halfWidth);
        const radius = Math.sqrt(normalizedX * normalizedX + normalizedY * normalizedY);
        const mix = smoothstep(start, end, radius) * maximumMix;
        if (mix > 0) {
          const preVignetteRed = rgba[offset];
          const preVignetteGreen = rgba[offset + 1];
          const preVignetteBlue = rgba[offset + 2];
          for (let channel = 0; channel < 3; channel += 1) {
            const linear = srgbToLinear(rgba[offset + channel]);
            const adjusted = darkening ? linear * (1 - mix) : linear + (1 - linear) * mix;
            rgba[offset + channel] = linearToSrgb(adjusted);
          }
          if (preVignetteRed !== rgba[offset] || preVignetteGreen !== rgba[offset + 1]
            || preVignetteBlue !== rgba[offset + 2]) {
            statistics.vignetteChangedPixels += 1;
            if (darkening) statistics.darkenedPixels += 1;
            else statistics.lightenedPixels += 1;
          }
        }
      }

      if (beforeRed !== rgba[offset] || beforeGreen !== rgba[offset + 1] || beforeBlue !== rgba[offset + 2]) {
        statistics.changedPixels += 1;
      }
    }
  }
  return statistics;
}
