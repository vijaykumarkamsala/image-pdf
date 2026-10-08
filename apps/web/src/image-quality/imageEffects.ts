export interface ImageBloomRecipe {
  /** Bounded strength of source-derived highlight spread. */
  amount: number;
  /** Source-coordinate neighbourhood radius in pixels. */
  radius: number;
  /** Minimum source luminance eligible to contribute, as a percentage. */
  threshold: number;
}

export interface ImageFilmGrainRecipe {
  /** Bounded monochrome luminance grain strength. */
  amount: number;
  /** Source-coordinate grain radius in pixels. */
  size: number;
}

export interface ImagePosterizeRecipe {
  /** Number of evenly spaced values retained in each visible RGB channel. */
  levels: number;
}

export interface ImageHalftoneRecipe {
  /** Blend from the source colour into a monochrome dot screen. */
  amount: number;
  /** Source-coordinate square cell size in pixels. */
  size: number;
  /** Clockwise screen rotation in degrees. */
  angle: number;
}

export interface ImagePixelArtRecipe {
  /** Blend from source pixels into alpha-aware block averages. */
  amount: number;
  /** Source-coordinate square block size in pixels. */
  size: number;
}

export interface ImageTiltShiftRecipe {
  /** Blend from the current stage into a source-derived blur outside the focus band. */
  amount: number;
  /** Source-coordinate box-blur radius in pixels. */
  radius: number;
  /** Vertical centre of the horizontal focus band, as a percentage. */
  position: number;
  /** Height of the unchanged focus band, as a percentage. */
  width: number;
  /** Width of the transition into full blur, as a percentage. */
  feather: number;
}

export interface ImageMotionBlurRecipe {
  /** Blend from the current stage into a source-derived directional blur. */
  amount: number;
  /** Maximum source-coordinate travel in pixels. */
  distance: number;
  /** Clockwise direction of travel in degrees. */
  angle: number;
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
  bloom: ImageBloomRecipe;
  tiltShift: ImageTiltShiftRecipe;
  motionBlur: ImageMotionBlurRecipe;
  posterize: ImagePosterizeRecipe;
  halftone: ImageHalftoneRecipe;
  pixelArt: ImagePixelArtRecipe;
  grain: ImageFilmGrainRecipe;
  vignette: ImageVignetteRecipe;
}

export interface ImageEffectsStatistics {
  processedPixels: number;
  changedPixels: number;
  bloomChangedPixels: number;
  tiltShiftChangedPixels: number;
  motionBlurChangedPixels: number;
  posterizedPixels: number;
  halftonedPixels: number;
  pixelatedPixels: number;
  grainChangedPixels: number;
  vignetteChangedPixels: number;
  darkenedPixels: number;
  lightenedPixels: number;
}

export const MAX_BROWSER_EFFECT_PIXELS = 67_108_864;
export const MAX_BROWSER_MOTION_BLUR_PIXELS = 16_777_216;

const SQRT_TWO = Math.SQRT2;

function bounded(value: number, minimum: number, maximum: number, fallback: number) {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

export function createNeutralEffectsRecipe(): ImageEffectsRecipe {
  return {
    bloom: { amount: 0, radius: 8, threshold: 70 },
    tiltShift: { amount: 0, radius: 12, position: 50, width: 30, feather: 50 },
    motionBlur: { amount: 0, distance: 12, angle: 0 },
    posterize: { levels: 256 },
    halftone: { amount: 0, size: 8, angle: 45 },
    pixelArt: { amount: 0, size: 8 },
    grain: { amount: 0, size: 2 },
    vignette: { amount: 0, midpoint: 50, feather: 50 },
  };
}

export function sanitizeEffectsRecipe(recipe: ImageEffectsRecipe): ImageEffectsRecipe {
  return {
    bloom: {
      amount: Math.round(bounded(recipe.bloom?.amount, 0, 100, 0)),
      radius: Math.round(bounded(recipe.bloom?.radius, 1, 32, 8)),
      threshold: Math.round(bounded(recipe.bloom?.threshold, 0, 100, 70)),
    },
    tiltShift: {
      amount: Math.round(bounded(recipe.tiltShift?.amount, 0, 100, 0)),
      radius: Math.round(bounded(recipe.tiltShift?.radius, 1, 32, 12)),
      position: Math.round(bounded(recipe.tiltShift?.position, 0, 100, 50)),
      width: Math.round(bounded(recipe.tiltShift?.width, 5, 80, 30)),
      feather: Math.round(bounded(recipe.tiltShift?.feather, 1, 100, 50)),
    },
    motionBlur: {
      amount: Math.round(bounded(recipe.motionBlur?.amount, 0, 100, 0)),
      distance: Math.round(bounded(recipe.motionBlur?.distance, 1, 32, 12)),
      angle: Math.round(bounded(recipe.motionBlur?.angle, -180, 180, 0)),
    },
    posterize: {
      levels: Math.round(bounded(recipe.posterize?.levels, 2, 256, 256)),
    },
    halftone: {
      amount: Math.round(bounded(recipe.halftone?.amount, 0, 100, 0)),
      size: Math.round(bounded(recipe.halftone?.size, 3, 32, 8)),
      angle: Math.round(bounded(recipe.halftone?.angle, -90, 90, 45)),
    },
    pixelArt: {
      amount: Math.round(bounded(recipe.pixelArt?.amount, 0, 100, 0)),
      size: Math.round(bounded(recipe.pixelArt?.size, 2, 32, 8)),
    },
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
  return recipe.bloom?.amount === safe.bloom.amount
    && recipe.bloom?.radius === safe.bloom.radius
    && recipe.bloom?.threshold === safe.bloom.threshold
    && recipe.tiltShift?.amount === safe.tiltShift.amount
    && recipe.tiltShift?.radius === safe.tiltShift.radius
    && recipe.tiltShift?.position === safe.tiltShift.position
    && recipe.tiltShift?.width === safe.tiltShift.width
    && recipe.tiltShift?.feather === safe.tiltShift.feather
    && recipe.motionBlur?.amount === safe.motionBlur.amount
    && recipe.motionBlur?.distance === safe.motionBlur.distance
    && recipe.motionBlur?.angle === safe.motionBlur.angle
    && recipe.posterize?.levels === safe.posterize.levels
    && recipe.halftone?.amount === safe.halftone.amount
    && recipe.halftone?.size === safe.halftone.size
    && recipe.halftone?.angle === safe.halftone.angle
    && recipe.pixelArt?.amount === safe.pixelArt.amount
    && recipe.pixelArt?.size === safe.pixelArt.size
    && recipe.grain?.amount === safe.grain.amount
    && recipe.grain?.size === safe.grain.size
    && recipe.vignette?.amount === safe.vignette.amount
    && recipe.vignette?.midpoint === safe.vignette.midpoint
    && recipe.vignette?.feather === safe.vignette.feather;
}

export function isNeutralEffects(recipe: ImageEffectsRecipe): boolean {
  const safe = sanitizeEffectsRecipe(recipe);
  return safe.bloom.amount === 0 && safe.tiltShift.amount === 0 && safe.motionBlur.amount === 0
    && safe.posterize.levels === 256
    && safe.halftone.amount === 0 && safe.pixelArt.amount === 0
    && safe.grain.amount === 0 && safe.vignette.amount === 0;
}

export function sameEffectsRecipe(left: ImageEffectsRecipe | null, right: ImageEffectsRecipe | null): boolean {
  if (!left || !right) return left === right;
  const safeLeft = sanitizeEffectsRecipe(left);
  const safeRight = sanitizeEffectsRecipe(right);
  return safeLeft.bloom.amount === safeRight.bloom.amount
    && safeLeft.bloom.radius === safeRight.bloom.radius
    && safeLeft.bloom.threshold === safeRight.bloom.threshold
    && safeLeft.tiltShift.amount === safeRight.tiltShift.amount
    && safeLeft.tiltShift.radius === safeRight.tiltShift.radius
    && safeLeft.tiltShift.position === safeRight.tiltShift.position
    && safeLeft.tiltShift.width === safeRight.tiltShift.width
    && safeLeft.tiltShift.feather === safeRight.tiltShift.feather
    && safeLeft.motionBlur.amount === safeRight.motionBlur.amount
    && safeLeft.motionBlur.distance === safeRight.motionBlur.distance
    && safeLeft.motionBlur.angle === safeRight.motionBlur.angle
    && safeLeft.posterize.levels === safeRight.posterize.levels
    && safeLeft.halftone.amount === safeRight.halftone.amount
    && safeLeft.halftone.size === safeRight.halftone.size
    && safeLeft.halftone.angle === safeRight.halftone.angle
    && safeLeft.pixelArt.amount === safeRight.pixelArt.amount
    && safeLeft.pixelArt.size === safeRight.pixelArt.size
    && safeLeft.grain.amount === safeRight.grain.amount
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

export function assertBrowserMotionBlurBudget(width: number, height: number): number {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error("Directional motion blur requires positive integer image dimensions.");
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > MAX_BROWSER_MOTION_BLUR_PIXELS) {
    throw new Error(
      `Directional motion blur requires ${pixels.toLocaleString("en-US")} working pixels, beyond this browser's `
      + `${MAX_BROWSER_MOTION_BLUR_PIXELS.toLocaleString("en-US")}-pixel safety budget. `
      + "No smaller or unchanged substitute was created.",
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

export interface ImageBloomResult {
  pixels: Uint8ClampedArray;
  processedPixels: number;
  changedPixels: number;
}

export interface ImagePixelArtResult {
  processedPixels: number;
  changedPixels: number;
}

export interface ImageTiltShiftResult {
  processedPixels: number;
  changedPixels: number;
}

export interface ImageMotionBlurResult {
  processedPixels: number;
  changedPixels: number;
}

/**
 * Blends an alpha-weighted source-neighbourhood blur over the current effect
 * stage outside a horizontal focus band. The source tile must include a full
 * radius halo at every non-image boundary so independent worker tiles remain
 * byte-exact.
 */
export function applyTiltShiftToRgba(
  source: Uint8ClampedArray,
  target: Uint8ClampedArray,
  width: number,
  coreTop: number,
  coreHeight: number,
  imageHeight: number,
  rowOffset: number,
  recipe: ImageTiltShiftRecipe,
): ImageTiltShiftResult {
  const amount = Math.round(bounded(recipe.amount, 0, 100, 0));
  const radius = Math.round(bounded(recipe.radius, 1, 32, 12));
  const position = Math.round(bounded(recipe.position, 0, 100, 50));
  const focusWidth = Math.round(bounded(recipe.width, 5, 80, 30));
  const feather = Math.round(bounded(recipe.feather, 1, 100, 50));
  const sourcePixels = source.byteLength / 4;
  const sourceHeight = sourcePixels / width;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(imageHeight)
    || !Number.isSafeInteger(coreTop) || !Number.isSafeInteger(coreHeight)
    || !Number.isSafeInteger(rowOffset) || width < 1 || imageHeight < 1
    || coreTop < 0 || coreHeight < 1 || rowOffset < 0
    || !Number.isSafeInteger(sourcePixels) || !Number.isSafeInteger(sourceHeight)
    || sourcePixels % width !== 0 || coreTop + coreHeight > sourceHeight
    || rowOffset + coreHeight > imageHeight
    || target.byteLength !== width * coreHeight * 4) {
    throw new Error("Tilt-shift requires valid source halo and target RGBA dimensions.");
  }
  const sourceTop = rowOffset - coreTop;
  const sourceBottom = sourceTop + sourceHeight;
  if (sourceTop < 0 || sourceBottom > imageHeight) {
    throw new Error("Tilt-shift received a source tile outside the image.");
  }
  if (amount === 0) return { processedPixels: 0, changedPixels: 0 };
  if ((sourceTop > 0 && coreTop < radius)
    || (sourceBottom < imageHeight && sourceHeight - coreTop - coreHeight < radius)) {
    throw new Error("Tilt-shift requires a complete immutable-source radius halo.");
  }

  const stride = width + 1;
  const entries = stride * (sourceHeight + 1);
  const alphaIntegral = new Float64Array(entries);
  const redIntegral = new Float64Array(entries);
  const greenIntegral = new Float64Array(entries);
  const blueIntegral = new Float64Array(entries);
  for (let y = 0; y < sourceHeight; y += 1) {
    let rowAlpha = 0;
    let rowRed = 0;
    let rowGreen = 0;
    let rowBlue = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const alpha = source[offset + 3];
      rowAlpha += alpha;
      rowRed += source[offset] * alpha;
      rowGreen += source[offset + 1] * alpha;
      rowBlue += source[offset + 2] * alpha;
      const integralOffset = (y + 1) * stride + x + 1;
      alphaIntegral[integralOffset] = alphaIntegral[integralOffset - stride] + rowAlpha;
      redIntegral[integralOffset] = redIntegral[integralOffset - stride] + rowRed;
      greenIntegral[integralOffset] = greenIntegral[integralOffset - stride] + rowGreen;
      blueIntegral[integralOffset] = blueIntegral[integralOffset - stride] + rowBlue;
    }
  }
  const area = (integral: Float64Array, left: number, top: number, right: number, bottom: number) => (
    integral[(bottom + 1) * stride + right + 1]
      - integral[top * stride + right + 1]
      - integral[(bottom + 1) * stride + left]
      + integral[top * stride + left]
  );
  const maximumMix = amount / 100;
  const centre = position / 100;
  const focusHalfWidth = focusWidth / 200;
  const transitionEnd = focusHalfWidth + feather / 200;
  let processedPixels = 0;
  let changedPixels = 0;
  for (let outputY = 0; outputY < coreHeight; outputY += 1) {
    const sourceY = coreTop + outputY;
    const globalY = rowOffset + outputY;
    const distance = Math.abs((globalY + 0.5) / imageHeight - centre);
    const mix = maximumMix * smoothstep(focusHalfWidth, transitionEnd, distance);
    for (let x = 0; x < width; x += 1) {
      const targetOffset = (outputY * width + x) * 4;
      if (target[targetOffset + 3] === 0) continue;
      processedPixels += 1;
      if (mix === 0) continue;
      const left = Math.max(0, x - radius);
      const right = Math.min(width - 1, x + radius);
      const top = Math.max(0, sourceY - radius);
      const bottom = Math.min(sourceHeight - 1, sourceY + radius);
      const alphaWeight = area(alphaIntegral, left, top, right, bottom);
      if (alphaWeight === 0) continue;
      const beforeRed = target[targetOffset];
      const beforeGreen = target[targetOffset + 1];
      const beforeBlue = target[targetOffset + 2];
      target[targetOffset] = Math.round(beforeRed * (1 - mix)
        + area(redIntegral, left, top, right, bottom) / alphaWeight * mix);
      target[targetOffset + 1] = Math.round(beforeGreen * (1 - mix)
        + area(greenIntegral, left, top, right, bottom) / alphaWeight * mix);
      target[targetOffset + 2] = Math.round(beforeBlue * (1 - mix)
        + area(blueIntegral, left, top, right, bottom) / alphaWeight * mix);
      if (beforeRed !== target[targetOffset] || beforeGreen !== target[targetOffset + 1]
        || beforeBlue !== target[targetOffset + 2]) changedPixels += 1;
    }
  }
  return { processedPixels, changedPixels };
}

/**
 * Blends five alpha-weighted bilinear samples from the immutable source along
 * a centred direction line over the current effect stage. The source tile must
 * include a distance-plus-one halo at every non-image boundary so worker tiles
 * remain byte-exact regardless of the selected angle.
 */
export function applyMotionBlurToRgba(
  source: Uint8ClampedArray,
  target: Uint8ClampedArray,
  width: number,
  coreTop: number,
  coreHeight: number,
  imageHeight: number,
  rowOffset: number,
  recipe: ImageMotionBlurRecipe,
): ImageMotionBlurResult {
  const amount = Math.round(bounded(recipe.amount, 0, 100, 0));
  const distance = Math.round(bounded(recipe.distance, 1, 32, 12));
  const angle = Math.round(bounded(recipe.angle, -180, 180, 0));
  const sourcePixels = source.byteLength / 4;
  const sourceHeight = sourcePixels / width;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(imageHeight)
    || !Number.isSafeInteger(coreTop) || !Number.isSafeInteger(coreHeight)
    || !Number.isSafeInteger(rowOffset) || width < 1 || imageHeight < 1
    || coreTop < 0 || coreHeight < 1 || rowOffset < 0
    || !Number.isSafeInteger(sourcePixels) || !Number.isSafeInteger(sourceHeight)
    || sourcePixels % width !== 0 || coreTop + coreHeight > sourceHeight
    || rowOffset + coreHeight > imageHeight
    || target.byteLength !== width * coreHeight * 4) {
    throw new Error("Directional motion blur requires valid source halo and target RGBA dimensions.");
  }
  const sourceTop = rowOffset - coreTop;
  const sourceBottom = sourceTop + sourceHeight;
  if (sourceTop < 0 || sourceBottom > imageHeight) {
    throw new Error("Directional motion blur received a source tile outside the image.");
  }
  if (amount === 0) return { processedPixels: 0, changedPixels: 0 };
  const halo = distance + 1;
  if ((sourceTop > 0 && coreTop < halo)
    || (sourceBottom < imageHeight && sourceHeight - coreTop - coreHeight < halo)) {
    throw new Error("Directional motion blur requires a complete immutable-source distance halo.");
  }

  const radians = angle * Math.PI / 180;
  const travelX = Math.cos(radians) * distance;
  const travelY = Math.sin(radians) * distance;
  const sampleFactors = [-1, -0.5, 0, 0.5, 1] as const;
  const mix = amount / 100;
  let processedPixels = 0;
  let changedPixels = 0;
  for (let outputY = 0; outputY < coreHeight; outputY += 1) {
    const globalY = rowOffset + outputY;
    for (let x = 0; x < width; x += 1) {
      const targetOffset = (outputY * width + x) * 4;
      if (target[targetOffset + 3] === 0) continue;
      processedPixels += 1;
      let alphaWeight = 0;
      let red = 0;
      let green = 0;
      let blue = 0;
      for (const factor of sampleFactors) {
        const sampleX = Math.min(width - 1, Math.max(0, x + factor * travelX));
        const sampleY = Math.min(imageHeight - 1, Math.max(0, globalY + factor * travelY));
        const localY = sampleY - sourceTop;
        const left = Math.floor(sampleX);
        const right = Math.min(width - 1, left + 1);
        const top = Math.floor(localY);
        const bottom = Math.min(sourceHeight - 1, top + 1);
        const fractionX = sampleX - left;
        const fractionY = localY - top;
        const topLeftWeight = (1 - fractionX) * (1 - fractionY);
        const topRightWeight = fractionX * (1 - fractionY);
        const bottomLeftWeight = (1 - fractionX) * fractionY;
        const bottomRightWeight = fractionX * fractionY;
        const topLeftOffset = (top * width + left) * 4;
        const topRightOffset = (top * width + right) * 4;
        const bottomLeftOffset = (bottom * width + left) * 4;
        const bottomRightOffset = (bottom * width + right) * 4;
        const topLeftAlpha = topLeftWeight * source[topLeftOffset + 3] / 255;
        const topRightAlpha = topRightWeight * source[topRightOffset + 3] / 255;
        const bottomLeftAlpha = bottomLeftWeight * source[bottomLeftOffset + 3] / 255;
        const bottomRightAlpha = bottomRightWeight * source[bottomRightOffset + 3] / 255;
        alphaWeight += topLeftAlpha + topRightAlpha + bottomLeftAlpha + bottomRightAlpha;
        red += source[topLeftOffset] * topLeftAlpha + source[topRightOffset] * topRightAlpha
          + source[bottomLeftOffset] * bottomLeftAlpha + source[bottomRightOffset] * bottomRightAlpha;
        green += source[topLeftOffset + 1] * topLeftAlpha + source[topRightOffset + 1] * topRightAlpha
          + source[bottomLeftOffset + 1] * bottomLeftAlpha
          + source[bottomRightOffset + 1] * bottomRightAlpha;
        blue += source[topLeftOffset + 2] * topLeftAlpha + source[topRightOffset + 2] * topRightAlpha
          + source[bottomLeftOffset + 2] * bottomLeftAlpha
          + source[bottomRightOffset + 2] * bottomRightAlpha;
      }
      if (alphaWeight === 0) continue;
      const beforeRed = target[targetOffset];
      const beforeGreen = target[targetOffset + 1];
      const beforeBlue = target[targetOffset + 2];
      target[targetOffset] = Math.round(beforeRed * (1 - mix) + red / alphaWeight * mix);
      target[targetOffset + 1] = Math.round(beforeGreen * (1 - mix) + green / alphaWeight * mix);
      target[targetOffset + 2] = Math.round(beforeBlue * (1 - mix) + blue / alphaWeight * mix);
      if (beforeRed !== target[targetOffset] || beforeGreen !== target[targetOffset + 1]
        || beforeBlue !== target[targetOffset + 2]) changedPixels += 1;
    }
  }
  return { processedPixels, changedPixels };
}

/**
 * Blends each visible pixel toward the alpha-weighted average of its immutable
 * source-coordinate block. Tiles must begin and end on block boundaries (apart
 * from the final image edge), which keeps independently rendered tiles exact.
 */
export function applyPixelArtToRgba(
  pixels: Uint8ClampedArray,
  width: number,
  imageHeight: number,
  rowOffset: number,
  recipe: ImagePixelArtRecipe,
): ImagePixelArtResult {
  const amount = Math.round(bounded(recipe.amount, 0, 100, 0));
  const size = Math.round(bounded(recipe.size, 2, 32, 8));
  const tilePixels = pixels.byteLength / 4;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(imageHeight)
    || !Number.isSafeInteger(rowOffset) || width < 1 || imageHeight < 1 || rowOffset < 0
    || !Number.isSafeInteger(tilePixels) || tilePixels % width !== 0) {
    throw new Error("Pixel art requires valid source-coordinate RGBA tile dimensions.");
  }
  const tileHeight = tilePixels / width;
  if (tileHeight < 1 || rowOffset + tileHeight > imageHeight) {
    throw new Error("Pixel art received a tile outside the source image.");
  }
  if (amount === 0) return { processedPixels: 0, changedPixels: 0 };
  if (rowOffset % size !== 0
    || (tileHeight % size !== 0 && rowOffset + tileHeight !== imageHeight)) {
    throw new Error("Pixel-art tiles must align to complete source-coordinate blocks.");
  }

  const mix = amount / 100;
  let processedPixels = 0;
  let changedPixels = 0;
  for (let blockY = 0; blockY < tileHeight; blockY += size) {
    const blockHeight = Math.min(size, tileHeight - blockY);
    for (let blockX = 0; blockX < width; blockX += size) {
      const blockWidth = Math.min(size, width - blockX);
      let alphaWeight = 0;
      let red = 0;
      let green = 0;
      let blue = 0;
      for (let y = 0; y < blockHeight; y += 1) {
        for (let x = 0; x < blockWidth; x += 1) {
          const offset = ((blockY + y) * width + blockX + x) * 4;
          const alpha = pixels[offset + 3] / 255;
          if (alpha === 0) continue;
          alphaWeight += alpha;
          red += pixels[offset] * alpha;
          green += pixels[offset + 1] * alpha;
          blue += pixels[offset + 2] * alpha;
        }
      }
      if (alphaWeight === 0) continue;
      const averageRed = red / alphaWeight;
      const averageGreen = green / alphaWeight;
      const averageBlue = blue / alphaWeight;
      for (let y = 0; y < blockHeight; y += 1) {
        for (let x = 0; x < blockWidth; x += 1) {
          const offset = ((blockY + y) * width + blockX + x) * 4;
          if (pixels[offset + 3] === 0) continue;
          processedPixels += 1;
          const beforeRed = pixels[offset];
          const beforeGreen = pixels[offset + 1];
          const beforeBlue = pixels[offset + 2];
          pixels[offset] = Math.round(beforeRed * (1 - mix) + averageRed * mix);
          pixels[offset + 1] = Math.round(beforeGreen * (1 - mix) + averageGreen * mix);
          pixels[offset + 2] = Math.round(beforeBlue * (1 - mix) + averageBlue * mix);
          if (beforeRed !== pixels[offset] || beforeGreen !== pixels[offset + 1]
            || beforeBlue !== pixels[offset + 2]) changedPixels += 1;
        }
      }
    }
  }
  return { processedPixels, changedPixels };
}

/**
 * Spreads only measured bright source pixels into visible core pixels. Callers
 * provide radius-sized halo rows so independently rendered tiles match exactly.
 */
export function applyBloomToRgba(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  coreTop: number,
  coreHeight: number,
  recipe: ImageBloomRecipe,
): ImageBloomResult {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || pixels.byteLength !== width * height * 4
    || !Number.isSafeInteger(coreTop) || !Number.isSafeInteger(coreHeight)
    || coreTop < 0 || coreHeight < 1 || coreTop + coreHeight > height) {
    throw new Error("Highlight bloom requires complete RGBA core and halo dimensions.");
  }
  const amount = Math.round(bounded(recipe.amount, 0, 100, 0));
  const radius = Math.round(bounded(recipe.radius, 1, 32, 8));
  const threshold = Math.round(bounded(recipe.threshold, 0, 100, 70));
  const output = new Uint8ClampedArray(width * coreHeight * 4);
  const stride = width + 1;
  const entries = stride * (height + 1);
  const redIntegral = new Float64Array(entries);
  const greenIntegral = new Float64Array(entries);
  const blueIntegral = new Float64Array(entries);
  const thresholdByte = threshold / 100 * 255;
  for (let y = 0; y < height; y += 1) {
    let rowRed = 0;
    let rowGreen = 0;
    let rowBlue = 0;
    for (let x = 0; x < width; x += 1) {
      const sourceOffset = (y * width + x) * 4;
      const alpha = pixels[sourceOffset + 3] / 255;
      if (alpha > 0 && thresholdByte < 255) {
        const luminance = pixels[sourceOffset] * 0.2126
          + pixels[sourceOffset + 1] * 0.7152
          + pixels[sourceOffset + 2] * 0.0722;
        const eligibility = smoothstep(thresholdByte, 255, luminance) * alpha;
        rowRed += Math.round(pixels[sourceOffset] * eligibility);
        rowGreen += Math.round(pixels[sourceOffset + 1] * eligibility);
        rowBlue += Math.round(pixels[sourceOffset + 2] * eligibility);
      }
      const integralOffset = (y + 1) * stride + x + 1;
      redIntegral[integralOffset] = redIntegral[integralOffset - stride] + rowRed;
      greenIntegral[integralOffset] = greenIntegral[integralOffset - stride] + rowGreen;
      blueIntegral[integralOffset] = blueIntegral[integralOffset - stride] + rowBlue;
    }
  }
  const area = (integral: Float64Array, left: number, top: number, right: number, bottom: number) => (
    integral[(bottom + 1) * stride + right + 1]
      - integral[top * stride + right + 1]
      - integral[(bottom + 1) * stride + left]
      + integral[top * stride + left]
  );
  let processedPixels = 0;
  let changedPixels = 0;
  const maximumMix = amount / 100 * 0.9;
  for (let outputY = 0; outputY < coreHeight; outputY += 1) {
    const sourceY = coreTop + outputY;
    const top = Math.max(0, sourceY - radius);
    const bottom = Math.min(height - 1, sourceY + radius);
    for (let x = 0; x < width; x += 1) {
      const sourceOffset = (sourceY * width + x) * 4;
      const outputOffset = (outputY * width + x) * 4;
      output[outputOffset] = pixels[sourceOffset];
      output[outputOffset + 1] = pixels[sourceOffset + 1];
      output[outputOffset + 2] = pixels[sourceOffset + 2];
      output[outputOffset + 3] = pixels[sourceOffset + 3];
      if (pixels[sourceOffset + 3] === 0) continue;
      processedPixels += 1;
      if (maximumMix === 0) continue;
      const left = Math.max(0, x - radius);
      const right = Math.min(width - 1, x + radius);
      const samples = (right - left + 1) * (bottom - top + 1);
      const glow = [
        area(redIntegral, left, top, right, bottom),
        area(greenIntegral, left, top, right, bottom),
        area(blueIntegral, left, top, right, bottom),
      ];
      for (let channel = 0; channel < 3; channel += 1) {
        const source = pixels[sourceOffset + channel];
        const spread = glow[channel] / samples / 255;
        const adjusted = Math.round(source + (255 - source) * spread * maximumMix);
        output[outputOffset + channel] = Math.min(source < 255 ? 254 : 255, adjusted);
      }
      if (output[outputOffset] !== pixels[sourceOffset]
        || output[outputOffset + 1] !== pixels[sourceOffset + 1]
        || output[outputOffset + 2] !== pixels[sourceOffset + 2]) changedPixels += 1;
    }
  }
  return { pixels: output, processedPixels, changedPixels };
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
    bloomChangedPixels: 0,
    tiltShiftChangedPixels: 0,
    motionBlurChangedPixels: 0,
    posterizedPixels: 0,
    halftonedPixels: 0,
    pixelatedPixels: 0,
    grainChangedPixels: 0,
    vignetteChangedPixels: 0,
    darkenedPixels: 0,
    lightenedPixels: 0,
  };
  if (safe.posterize.levels === 256 && safe.halftone.amount === 0
    && safe.grain.amount === 0 && safe.vignette.amount === 0) return statistics;

  const posterizeSteps = safe.posterize.levels - 1;
  const halftoneMix = safe.halftone.amount / 100;
  const halftoneRadians = safe.halftone.angle * Math.PI / 180;
  const halftoneCosine = Math.cos(halftoneRadians);
  const halftoneSine = Math.sin(halftoneRadians);
  const halftoneAntialias = 0.75 / safe.halftone.size;
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

      if (safe.posterize.levels < 256) {
        const prePosterizeRed = rgba[offset];
        const prePosterizeGreen = rgba[offset + 1];
        const prePosterizeBlue = rgba[offset + 2];
        for (let channel = 0; channel < 3; channel += 1) {
          const level = Math.round(rgba[offset + channel] / 255 * posterizeSteps);
          rgba[offset + channel] = Math.round(level / posterizeSteps * 255);
        }
        if (prePosterizeRed !== rgba[offset] || prePosterizeGreen !== rgba[offset + 1]
          || prePosterizeBlue !== rgba[offset + 2]) statistics.posterizedPixels += 1;
      }

      if (halftoneMix > 0) {
        const preHalftoneRed = rgba[offset];
        const preHalftoneGreen = rgba[offset + 1];
        const preHalftoneBlue = rgba[offset + 2];
        const luminance = (preHalftoneRed * 0.2126 + preHalftoneGreen * 0.7152
          + preHalftoneBlue * 0.0722) / 255;
        const centredX = x + 0.5 - halfWidth;
        const centredY = sourceY + 0.5 - halfHeight;
        const rotatedX = centredX * halftoneCosine - centredY * halftoneSine;
        const rotatedY = centredX * halftoneSine + centredY * halftoneCosine;
        const wrappedX = ((rotatedX % safe.halftone.size) + safe.halftone.size) % safe.halftone.size;
        const wrappedY = ((rotatedY % safe.halftone.size) + safe.halftone.size) % safe.halftone.size;
        const cellX = wrappedX / safe.halftone.size - 0.5;
        const cellY = wrappedY / safe.halftone.size - 0.5;
        const distance = Math.sqrt(cellX * cellX + cellY * cellY);
        const radius = Math.SQRT1_2 * Math.sqrt(Math.max(0, 1 - luminance));
        const screenValue = Math.round(smoothstep(
          radius - halftoneAntialias,
          radius + halftoneAntialias,
          distance,
        ) * 255);
        for (let channel = 0; channel < 3; channel += 1) {
          rgba[offset + channel] = Math.round(rgba[offset + channel] * (1 - halftoneMix)
            + screenValue * halftoneMix);
        }
        if (preHalftoneRed !== rgba[offset] || preHalftoneGreen !== rgba[offset + 1]
          || preHalftoneBlue !== rgba[offset + 2]) statistics.halftonedPixels += 1;
      }

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
