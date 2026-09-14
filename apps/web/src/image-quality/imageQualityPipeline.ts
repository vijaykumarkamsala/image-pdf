import type { ImageQualityAnalysis } from "./ImageQualityEngine";

export const MIN_STRENGTH = 1;
export const MAX_STRENGTH = 100;

export interface PixelEnhancementResult {
  pixels: Uint8ClampedArray;
  analysis: ImageQualityAnalysis;
}

export interface PixelReconstructionResult {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
  scale: 1 | 2;
}

export interface GraphicClassification {
  dominantPaletteFraction: number;
  flatNeighbourFraction: number;
  isFlatGraphic: boolean;
  quantizedColours: number;
}

export interface FlatGraphicTracePreparation {
  background: readonly [number, number, number, number] | null;
  backgroundSimplified: boolean;
  decontaminatedEdgePixels: number;
  foregroundMask: Uint8Array | null;
  mattePixels: Uint8ClampedArray;
  pixels: Uint8ClampedArray;
  removedComponents: number;
}

interface MeasuredImage extends ImageQualityAnalysis {
  blockiness: number;
  illuminantBlue: number;
  illuminantGreen: number;
  illuminantRed: number;
  noiseSigma: number;
}

interface LocalToneMap {
  globalHistogram: Uint32Array;
  mappings: Uint8Array;
  tileHeight: number;
  tileStrengths: Float32Array;
  tileWidth: number;
  tilesX: number;
  tilesY: number;
  visiblePixels: number;
}

const LUMA_RED = 0.2126;
const LUMA_GREEN = 0.7152;
const LUMA_BLUE = 0.0722;
const MAX_RECONSTRUCTED_PIXELS = 17_000_000;
const MAX_SOURCE_PIXELS_FOR_RECONSTRUCTION = 4_300_000;
const MIN_SOURCE_EDGE_FOR_RECONSTRUCTION = 256;

const clamp = (value: number, minimum = 0, maximum = 255) => Math.min(maximum, Math.max(minimum, value));
const luma = (red: number, green: number, blue: number) => (
  LUMA_RED * red + LUMA_GREEN * green + LUMA_BLUE * blue
);

export function classifyFlatGraphic(
  source: Uint8ClampedArray,
  width: number,
  height: number,
): GraphicClassification {
  if (source.length !== width * height * 4) throw new Error("Decoded pixel data is incomplete.");
  const stride = Math.max(1, Math.floor(Math.sqrt(width * height / 100_000)));
  const palette = new Map<number, number>();
  let flatNeighbours = 0;
  let neighbourSamples = 0;
  let visibleSamples = 0;
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const offset = (y * width + x) * 4;
      if (source[offset + 3] < 16) continue;
      const key = (source[offset] >> 4) << 8
        | (source[offset + 1] >> 4) << 4
        | (source[offset + 2] >> 4);
      palette.set(key, (palette.get(key) ?? 0) + 1);
      visibleSamples += 1;
      let maximumDifference = 0;
      if (x + 1 < width) {
        const right = offset + 4;
        maximumDifference = Math.max(
          maximumDifference,
          Math.abs(source[offset] - source[right]),
          Math.abs(source[offset + 1] - source[right + 1]),
          Math.abs(source[offset + 2] - source[right + 2]),
        );
      }
      if (y + 1 < height) {
        const below = offset + width * 4;
        maximumDifference = Math.max(
          maximumDifference,
          Math.abs(source[offset] - source[below]),
          Math.abs(source[offset + 1] - source[below + 1]),
          Math.abs(source[offset + 2] - source[below + 2]),
        );
      }
      if (x + 1 < width || y + 1 < height) {
        neighbourSamples += 1;
        if (maximumDifference <= 6) flatNeighbours += 1;
      }
    }
  }
  if (visibleSamples === 0) throw new Error("The image does not contain visible pixels to enhance.");
  const dominantPaletteSamples = [...palette.values()]
    .sort((first, second) => second - first)
    .slice(0, 8)
    .reduce((total, count) => total + count, 0);
  const dominantPaletteFraction = dominantPaletteSamples / visibleSamples;
  const flatNeighbourFraction = flatNeighbours / Math.max(1, neighbourSamples);
  return {
    dominantPaletteFraction,
    flatNeighbourFraction,
    isFlatGraphic: palette.size <= 512
      && dominantPaletteFraction >= 0.72
      && flatNeighbourFraction >= 0.72,
    quantizedColours: palette.size,
  };
}

export function enhanceFlatGraphicPixels(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  strength: number,
): PixelEnhancementResult {
  if (!Number.isFinite(strength) || strength < MIN_STRENGTH || strength > MAX_STRENGTH) {
    throw new Error("Enhancement strength is outside the supported range.");
  }
  if (source.length !== width * height * 4) throw new Error("Decoded pixel data is incomplete.");
  const measured = analyse(source, width, height);
  const output = new Uint8ClampedArray(source);
  const mixLimit = 0.16 + strength / MAX_STRENGTH * 0.38;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const offset = (y * width + x) * 4;
      if (source[offset + 3] === 0) continue;
      let minimumRed = 255;
      let minimumGreen = 255;
      let minimumBlue = 255;
      let maximumRed = 0;
      let maximumGreen = 0;
      let maximumBlue = 0;
      let redTotal = 0;
      let greenTotal = 0;
      let blueTotal = 0;
      let samples = 0;
      let alphaCompatible = true;
      for (let neighbourY = -1; neighbourY <= 1; neighbourY += 1) {
        for (let neighbourX = -1; neighbourX <= 1; neighbourX += 1) {
          if (neighbourX === 0 && neighbourY === 0) continue;
          const neighbour = ((y + neighbourY) * width + x + neighbourX) * 4;
          if (Math.abs(source[neighbour + 3] - source[offset + 3]) > 8) {
            alphaCompatible = false;
            continue;
          }
          minimumRed = Math.min(minimumRed, source[neighbour]);
          minimumGreen = Math.min(minimumGreen, source[neighbour + 1]);
          minimumBlue = Math.min(minimumBlue, source[neighbour + 2]);
          maximumRed = Math.max(maximumRed, source[neighbour]);
          maximumGreen = Math.max(maximumGreen, source[neighbour + 1]);
          maximumBlue = Math.max(maximumBlue, source[neighbour + 2]);
          redTotal += source[neighbour];
          greenTotal += source[neighbour + 1];
          blueTotal += source[neighbour + 2];
          samples += 1;
        }
      }
      const spread = Math.max(maximumRed - minimumRed, maximumGreen - minimumGreen, maximumBlue - minimumBlue);
      if (!alphaCompatible || samples < 5 || spread > 18) continue;
      const redMean = redTotal / samples;
      const greenMean = greenTotal / samples;
      const blueMean = blueTotal / samples;
      const centreDifference = Math.max(
        Math.abs(source[offset] - redMean),
        Math.abs(source[offset + 1] - greenMean),
        Math.abs(source[offset + 2] - blueMean),
      );
      if (centreDifference > 40) continue;
      const mix = mixLimit * (1 - spread / 19);
      output[offset] = Math.round(source[offset] + (redMean - source[offset]) * mix);
      output[offset + 1] = Math.round(source[offset + 1] + (greenMean - source[offset + 1]) * mix);
      output[offset + 2] = Math.round(source[offset + 2] + (blueMean - source[offset + 2]) * mix);
    }
  }
  return {
    pixels: output,
    analysis: {
      noiseLevel: measured.noiseLevel,
      edgeDefinition: measured.edgeDefinition,
      tonalRange: measured.tonalRange,
      colourCast: measured.colourCast,
    },
  };
}

/**
 * Separates meaningful artwork from a dominant, nearly uniform border colour
 * before vector tracing. JPEG field noise must not become thousands of tiny
 * paths, but large foreground regions retain their decoded source colours.
 */
export function prepareFlatGraphicTracePixels(
  source: Uint8ClampedArray,
  width: number,
  height: number,
): FlatGraphicTracePreparation {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error("Image dimensions are invalid.");
  }
  if (source.length !== width * height * 4) throw new Error("Decoded pixel data is incomplete.");

  const output = new Uint8ClampedArray(source);
  const borderBand = Math.max(2, Math.round(Math.min(width, height) * 0.04));
  const quantizedCounts = new Uint32Array(32 * 32 * 32);
  let opaqueBorderSamples = 0;
  const isBorder = (x: number, y: number) => (
    x < borderBand || x >= width - borderBand || y < borderBand || y >= height - borderBand
  );

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!isBorder(x, y)) continue;
      const offset = (y * width + x) * 4;
      if (source[offset + 3] < 240) continue;
      const key = (source[offset] >> 3) << 10
        | (source[offset + 1] >> 3) << 5
        | (source[offset + 2] >> 3);
      quantizedCounts[key] += 1;
      opaqueBorderSamples += 1;
    }
  }

  let dominantKey = 0;
  let dominantSamples = 0;
  for (let key = 0; key < quantizedCounts.length; key += 1) {
    if (quantizedCounts[key] > dominantSamples) {
      dominantKey = key;
      dominantSamples = quantizedCounts[key];
    }
  }
  const borderPixels = Math.max(1, width * height - Math.max(0, width - borderBand * 2) * Math.max(0, height - borderBand * 2));
  const opaqueBorderFraction = opaqueBorderSamples / borderPixels;
  const dominantFraction = dominantSamples / Math.max(1, opaqueBorderSamples);
  if (opaqueBorderFraction < 0.9 || dominantFraction < 0.55) {
    return {
      background: null,
      backgroundSimplified: false,
      decontaminatedEdgePixels: 0,
      foregroundMask: null,
      mattePixels: output,
      pixels: output,
      removedComponents: 0,
    };
  }

  let redTotal = 0;
  let greenTotal = 0;
  let blueTotal = 0;
  let alphaTotal = 0;
  const borderDistanceHistogram = new Uint32Array(256);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!isBorder(x, y)) continue;
      const offset = (y * width + x) * 4;
      if (source[offset + 3] < 240) continue;
      const key = (source[offset] >> 3) << 10
        | (source[offset + 1] >> 3) << 5
        | (source[offset + 2] >> 3);
      if (key !== dominantKey) continue;
      redTotal += source[offset];
      greenTotal += source[offset + 1];
      blueTotal += source[offset + 2];
      alphaTotal += source[offset + 3];
    }
  }
  const background: [number, number, number, number] = [
    Math.round(redTotal / dominantSamples),
    Math.round(greenTotal / dominantSamples),
    Math.round(blueTotal / dominantSamples),
    Math.round(alphaTotal / dominantSamples),
  ];

  let measuredBorderSamples = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!isBorder(x, y)) continue;
      const offset = (y * width + x) * 4;
      if (source[offset + 3] < 240) continue;
      const distance = Math.max(
        Math.abs(source[offset] - background[0]),
        Math.abs(source[offset + 1] - background[1]),
        Math.abs(source[offset + 2] - background[2]),
      );
      borderDistanceHistogram[distance] += 1;
      measuredBorderSamples += 1;
    }
  }
  const noiseLimit = percentile(borderDistanceHistogram, measuredBorderSamples, 0.995);
  const baseForegroundThreshold = Math.round(clamp(noiseLimit + 8, 12, 28));
  const pixelCount = width * height;
  const componentState = new Uint8Array(pixelCount);
  const distanceFromBackground = (pixel: number) => {
    const offset = pixel * 4;
    return Math.max(
      Math.abs(source[offset] - background[0]),
      Math.abs(source[offset + 1] - background[1]),
      Math.abs(source[offset + 2] - background[2]),
    );
  };
  const distanceHistogram = new Uint32Array(256);
  let candidatePixels = 0;
  let opaquePixels = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    if (source[pixel * 4 + 3] < 16) continue;
    opaquePixels += 1;
    const distance = distanceFromBackground(pixel);
    distanceHistogram[distance] += 1;
    if (distance > baseForegroundThreshold) candidatePixels += 1;
  }
  const separationThreshold = otsuThreshold(distanceHistogram, opaquePixels);
  let separatedPixels = 0;
  for (let distance = separationThreshold + 1; distance < distanceHistogram.length; distance += 1) {
    separatedPixels += distanceHistogram[distance];
  }
  // Prefer the natural background/foreground valley when it only removes a
  // narrow fringe. If it would discard a meaningful gradient, retain the
  // conservative noise-derived threshold instead.
  const foregroundThreshold = separationThreshold > baseForegroundThreshold
    && separatedPixels >= candidatePixels * 0.94
    ? separationThreshold
    : baseForegroundThreshold;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * 4;
    if (source[offset + 3] >= 16 && distanceFromBackground(pixel) > foregroundThreshold) {
      componentState[pixel] = 1;
    }
  }

  const queue = new Int32Array(pixelCount);
  const minimumComponentArea = Math.max(6, Math.round(pixelCount * 0.00004));
  let removedComponents = 0;
  for (let start = 0; start < pixelCount; start += 1) {
    if (componentState[start] !== 1) continue;
    let read = 0;
    let written = 1;
    let strongPixels = 0;
    queue[0] = start;
    componentState[start] = 2;
    while (read < written) {
      const pixel = queue[read];
      read += 1;
      if (distanceFromBackground(pixel) > foregroundThreshold + 8) strongPixels += 1;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      for (let neighbourY = Math.max(0, y - 1); neighbourY <= Math.min(height - 1, y + 1); neighbourY += 1) {
        for (let neighbourX = Math.max(0, x - 1); neighbourX <= Math.min(width - 1, x + 1); neighbourX += 1) {
          const neighbour = neighbourY * width + neighbourX;
          if (componentState[neighbour] !== 1) continue;
          componentState[neighbour] = 2;
          queue[written] = neighbour;
          written += 1;
        }
      }
    }
    const keep = written >= minimumComponentArea && strongPixels >= Math.max(2, Math.ceil(written * 0.05));
    if (!keep) removedComponents += 1;
    for (let index = 0; index < written; index += 1) componentState[queue[index]] = keep ? 3 : 0;
  }

  const integralStride = width + 1;
  const foregroundIntegral = new Uint32Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let rowTotal = 0;
    for (let x = 0; x < width; x += 1) {
      if (componentState[y * width + x] === 3) rowTotal += 1;
      foregroundIntegral[(y + 1) * integralStride + x + 1] = (
        foregroundIntegral[y * integralStride + x + 1] + rowTotal
      );
    }
  }
  const matteDepth = Math.max(2, Math.min(5, Math.round(Math.min(width, height) / 256)));
  const deepInterior = new Uint8Array(pixelCount);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    if (componentState[pixel] !== 3) continue;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    const left = Math.max(0, x - matteDepth);
    const right = Math.min(width - 1, x + matteDepth);
    const top = Math.max(0, y - matteDepth);
    const bottom = Math.min(height - 1, y + matteDepth);
    const foregroundArea = foregroundIntegral[(bottom + 1) * integralStride + right + 1]
      - foregroundIntegral[top * integralStride + right + 1]
      - foregroundIntegral[(bottom + 1) * integralStride + left]
      + foregroundIntegral[top * integralStride + left];
    if (foregroundArea === (right - left + 1) * (bottom - top + 1)) deepInterior[pixel] = 1;
  }
  let decontaminatedEdgePixels = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    if (componentState[pixel] !== 3) continue;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    if (deepInterior[pixel] === 1) continue;
    let nearestInterior = -1;
    let nearestDistance = Number.POSITIVE_INFINITY;
    const searchRadius = matteDepth * 2;
    for (let searchY = Math.max(0, y - searchRadius); searchY <= Math.min(height - 1, y + searchRadius); searchY += 1) {
      for (let searchX = Math.max(0, x - searchRadius); searchX <= Math.min(width - 1, x + searchRadius); searchX += 1) {
        if (deepInterior[searchY * width + searchX] !== 1) continue;
        const distance = (searchX - x) ** 2 + (searchY - y) ** 2;
        if (distance >= nearestDistance) continue;
        nearestDistance = distance;
        nearestInterior = searchY * width + searchX;
      }
    }
    if (nearestInterior < 0) continue;
    const offset = pixel * 4;
    const interiorOffset = nearestInterior * 4;
    output[offset] = source[interiorOffset];
    output[offset + 1] = source[interiorOffset + 1];
    output[offset + 2] = source[interiorOffset + 2];
    decontaminatedEdgePixels += 1;
  }

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    if (componentState[pixel] === 3) continue;
    const offset = pixel * 4;
    output[offset] = background[0];
    output[offset + 1] = background[1];
    output[offset + 2] = background[2];
    output[offset + 3] = background[3];
  }
  const foregroundMask = new Uint8Array(pixelCount);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    if (componentState[pixel] === 3) foregroundMask[pixel] = 255;
  }
  // Colour is extended just beyond the binary contour so resampling the
  // source under an antialiased mask cannot pull the old background into the
  // new edge. This is the same matte decontamination principle used for clean
  // compositing, while `pixels` still retains the exact measured background.
  const mattePixels = new Uint8ClampedArray(output);
  const matteDistance = new Uint8Array(pixelCount);
  let matteRead = 0;
  let matteWritten = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    if (componentState[pixel] !== 3) continue;
    matteDistance[pixel] = 1;
    queue[matteWritten] = pixel;
    matteWritten += 1;
  }
  while (matteRead < matteWritten) {
    const pixel = queue[matteRead];
    matteRead += 1;
    const distance = matteDistance[pixel];
    if (distance > 4) continue;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    const neighbours = [
      x > 0 ? pixel - 1 : -1,
      x + 1 < width ? pixel + 1 : -1,
      y > 0 ? pixel - width : -1,
      y + 1 < height ? pixel + width : -1,
    ];
    for (const neighbour of neighbours) {
      if (neighbour < 0 || matteDistance[neighbour] !== 0) continue;
      matteDistance[neighbour] = distance + 1;
      queue[matteWritten] = neighbour;
      matteWritten += 1;
      const offset = neighbour * 4;
      const sourceOffset = pixel * 4;
      mattePixels[offset] = mattePixels[sourceOffset];
      mattePixels[offset + 1] = mattePixels[sourceOffset + 1];
      mattePixels[offset + 2] = mattePixels[sourceOffset + 2];
    }
  }
  return {
    background,
    backgroundSimplified: true,
    decontaminatedEdgePixels,
    foregroundMask,
    mattePixels,
    pixels: output,
    removedComponents,
  };
}

function otsuThreshold(histogram: Uint32Array, count: number): number {
  if (count <= 0) return 0;
  let weightedTotal = 0;
  for (let value = 0; value < histogram.length; value += 1) {
    weightedTotal += value * histogram[value];
  }
  let lowerCount = 0;
  let lowerWeighted = 0;
  let bestThreshold = 0;
  let maximumVariance = -1;
  for (let value = 0; value < histogram.length; value += 1) {
    lowerCount += histogram[value];
    lowerWeighted += value * histogram[value];
    const upperCount = count - lowerCount;
    if (lowerCount === 0 || upperCount === 0) continue;
    const meanDifference = lowerWeighted / lowerCount
      - (weightedTotal - lowerWeighted) / upperCount;
    const variance = lowerCount * upperCount * meanDifference * meanDifference;
    if (variance <= maximumVariance) continue;
    maximumVariance = variance;
    bestThreshold = value;
  }
  return bestThreshold;
}

export function buildSourceTextureMap(
  source: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8Array {
  if (source.length !== width * height * 4) throw new Error("Decoded pixel data is incomplete.");
  const texture = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let minimum = 255;
      let maximum = 0;
      for (let neighbourY = Math.max(0, y - 1); neighbourY <= Math.min(height - 1, y + 1); neighbourY += 1) {
        for (let neighbourX = Math.max(0, x - 1); neighbourX <= Math.min(width - 1, x + 1); neighbourX += 1) {
          const offset = (neighbourY * width + neighbourX) * 4;
          const value = luma(source[offset], source[offset + 1], source[offset + 2]);
          minimum = Math.min(minimum, value);
          maximum = Math.max(maximum, value);
        }
      }
      texture[y * width + x] = Math.round(maximum - minimum);
    }
  }
  return texture;
}

/**
 * Adds learned luminance detail without allowing a perceptual model to replace
 * source colour or repaint low-texture regions. The reference pixel already in
 * `output` remains the authority for low-frequency tone and chroma.
 */
export function fuseRestoredPixel(
  output: Uint8ClampedArray,
  offset: number,
  learnedRed: number,
  learnedGreen: number,
  learnedBlue: number,
  sourceTexture: number,
  strength: number,
  learnedDetailLuma = 0,
): void {
  const amount = clamp(strength / MAX_STRENGTH, 0, 1);
  const texture = clamp((sourceTexture - 4) / 32, 0, 1);
  const referenceRed = output[offset];
  const referenceGreen = output[offset + 1];
  const referenceBlue = output[offset + 2];
  const referenceY = (referenceRed + referenceGreen * 2 + referenceBlue) / 4;
  const referenceCo = referenceRed - referenceBlue;
  const referenceCg = referenceGreen - (referenceRed + referenceBlue) / 2;
  const learnedY = (learnedRed + learnedGreen * 2 + learnedBlue) / 4;
  const structureLimit = amount * (2 + texture * 7);
  const structureChange = clamp(
    (learnedY - referenceY) * texture * (0.04 + amount * 0.28),
    -structureLimit,
    structureLimit,
  );
  const detailLimit = amount * (2 + texture * 16);
  const detailChange = clamp(
    learnedDetailLuma * texture * (0.35 + amount * 1.05),
    -detailLimit,
    detailLimit,
  );
  const targetY = referenceY + structureChange + detailChange;
  // Chroma remains source-authoritative. Neural colour transfer is the cause
  // of the background/skin/brand-colour shifts users reported.
  output[offset] = Math.round(clamp(targetY - referenceCg / 2 + referenceCo / 2));
  output[offset + 1] = Math.round(clamp(targetY + referenceCg / 2));
  output[offset + 2] = Math.round(clamp(targetY - referenceCg / 2 - referenceCo / 2));
}

function percentile(histogram: Uint32Array, count: number, fraction: number): number {
  const target = Math.max(1, Math.round(count * fraction));
  let seen = 0;
  for (let value = 0; value < histogram.length; value += 1) {
    seen += histogram[value];
    if (seen >= target) return value;
  }
  return 255;
}

function sampledLuma(source: Uint8ClampedArray, pixel: number): number {
  const offset = pixel * 4;
  return luma(source[offset], source[offset + 1], source[offset + 2]);
}

function estimateBlockiness(source: Uint8ClampedArray, width: number, height: number): number {
  if (width < 24 || height < 24) return 0;
  const rowStep = Math.max(1, Math.floor(height / 320));
  const columnStep = Math.max(1, Math.floor(width / 320));
  let boundary = 0;
  let nearby = 0;
  let samples = 0;

  for (let y = 0; y < height; y += rowStep) {
    for (let x = 8; x < width - 1; x += 8) {
      const row = y * width;
      boundary += Math.abs(sampledLuma(source, row + x) - sampledLuma(source, row + x - 1));
      nearby += (
        Math.abs(sampledLuma(source, row + x - 1) - sampledLuma(source, row + x - 2))
        + Math.abs(sampledLuma(source, row + x + 1) - sampledLuma(source, row + x))
      ) / 2;
      samples += 1;
    }
  }
  for (let x = 0; x < width; x += columnStep) {
    for (let y = 8; y < height - 1; y += 8) {
      boundary += Math.abs(sampledLuma(source, y * width + x) - sampledLuma(source, (y - 1) * width + x));
      nearby += (
        Math.abs(sampledLuma(source, (y - 1) * width + x) - sampledLuma(source, (y - 2) * width + x))
        + Math.abs(sampledLuma(source, (y + 1) * width + x) - sampledLuma(source, y * width + x))
      ) / 2;
      samples += 1;
    }
  }
  if (samples === 0) return 0;
  const excess = boundary / samples - nearby / samples * 1.15;
  return clamp(excess / 14, 0, 1);
}

function analyse(source: Uint8ClampedArray, width: number, height: number): MeasuredImage {
  const histogram = new Uint32Array(256);
  const residualHistogram = new Uint32Array(256);
  const pixelCount = width * height;
  const stride = Math.max(1, Math.floor(Math.sqrt(pixelCount / 750_000)));
  const shadePower = 6;
  let samples = 0;
  let residualSamples = 0;
  let edgeTotal = 0;
  let redPower = 0;
  let greenPower = 0;
  let bluePower = 0;

  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const pixel = y * width + x;
      const offset = pixel * 4;
      if (source[offset + 3] < 16) continue;
      const red = source[offset];
      const green = source[offset + 1];
      const blue = source[offset + 2];
      const value = Math.round(luma(red, green, blue));
      histogram[value] += 1;
      // L6 Shades-of-Gray is less easily dominated than a simple scene average.
      redPower += (red / 255) ** shadePower;
      greenPower += (green / 255) ** shadePower;
      bluePower += (blue / 255) ** shadePower;
      samples += 1;

      if (x < stride || y < stride || x + stride >= width || y + stride >= height) continue;
      const left = sampledLuma(source, pixel - stride);
      const right = sampledLuma(source, pixel + stride);
      const above = sampledLuma(source, pixel - stride * width);
      const below = sampledLuma(source, pixel + stride * width);
      const gradient = (Math.abs(right - left) + Math.abs(below - above)) / 2;
      edgeTotal += gradient;
      if (gradient < 34) {
        const laplacian = Math.min(255, Math.round(Math.abs(4 * value - left - right - above - below)));
        residualHistogram[laplacian] += 1;
        residualSamples += 1;
      }
    }
  }

  if (samples === 0) throw new Error("The image does not contain visible pixels to enhance.");
  const noiseSigma = residualSamples > 0 ? percentile(residualHistogram, residualSamples, 0.5) / 3.05 : 0;
  const illuminantRed = 255 * (redPower / samples) ** (1 / shadePower);
  const illuminantGreen = 255 * (greenPower / samples) ** (1 / shadePower);
  const illuminantBlue = 255 * (bluePower / samples) ** (1 / shadePower);
  const neutralIlluminant = (illuminantRed + illuminantGreen + illuminantBlue) / 3;
  const shadowPoint = percentile(histogram, samples, 0.005);
  const highlightPoint = percentile(histogram, samples, 0.995);

  return {
    noiseLevel: clamp(noiseSigma / 11, 0, 1),
    edgeDefinition: clamp(edgeTotal / Math.max(1, samples) / 28, 0, 1),
    tonalRange: (highlightPoint - shadowPoint) / 255,
    colourCast: clamp(Math.max(
      Math.abs(illuminantRed - neutralIlluminant),
      Math.abs(illuminantGreen - neutralIlluminant),
      Math.abs(illuminantBlue - neutralIlluminant),
    ) / Math.max(1, neutralIlluminant), 0, 1),
    blockiness: estimateBlockiness(source, width, height),
    illuminantBlue,
    illuminantGreen,
    illuminantRed,
    noiseSigma,
  };
}

function boxBlur(
  source: Uint8Array,
  width: number,
  height: number,
  radius: number,
  temporary: Uint8Array,
  output: Uint8Array,
) {
  const diameter = radius * 2 + 1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = source[row] * (radius + 1);
    for (let x = 1; x <= radius; x += 1) sum += source[row + Math.min(width - 1, x)];
    for (let x = 0; x < width; x += 1) {
      temporary[row + x] = Math.round(sum / diameter);
      const removedX = Math.max(0, x - radius);
      const addedX = Math.min(width - 1, x + radius + 1);
      sum += source[row + addedX] - source[row + removedX];
    }
  }
  for (let x = 0; x < width; x += 1) {
    let sum = temporary[x] * (radius + 1);
    for (let y = 1; y <= radius; y += 1) sum += temporary[Math.min(height - 1, y) * width + x];
    for (let y = 0; y < height; y += 1) {
      output[y * width + x] = Math.round(sum / diameter);
      const removedY = Math.max(0, y - radius);
      const addedY = Math.min(height - 1, y + radius + 1);
      sum += temporary[addedY * width + x] - temporary[removedY * width + x];
    }
  }
}

function reduceNoise(luminance: Uint8Array, blurred: Uint8Array, noiseSigma: number, amount: number) {
  const denoiseAmount = clamp((noiseSigma - 0.55) / 7, 0, 1) * (0.38 + amount * 0.55);
  if (denoiseAmount <= 0) return;
  const detailProtectionStart = Math.max(3, noiseSigma * 1.6);
  const detailProtectionEnd = detailProtectionStart + 12;
  for (let pixel = 0; pixel < luminance.length; pixel += 1) {
    const residual = Math.abs(luminance[pixel] - blurred[pixel]);
    const edgeProtection = clamp((detailProtectionEnd - residual) / (detailProtectionEnd - detailProtectionStart), 0, 1);
    luminance[pixel] = Math.round(luminance[pixel] + (blurred[pixel] - luminance[pixel]) * denoiseAmount * edgeProtection);
  }
}

function reduceBlockBoundaries(
  luminance: Uint8Array,
  width: number,
  height: number,
  blockiness: number,
  amount: number,
) {
  const blend = blockiness * amount * 0.28;
  if (blend < 0.015) return;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 8; x < width - 1; x += 8) {
      const leftIndex = row + x - 1;
      const rightIndex = row + x;
      const boundary = Math.abs(luminance[leftIndex] - luminance[rightIndex]);
      const neighborhood = (
        Math.abs(luminance[leftIndex] - luminance[leftIndex - 1])
        + Math.abs(luminance[rightIndex + 1] - luminance[rightIndex])
      ) / 2;
      if (boundary <= neighborhood * 1.4 + 2 || boundary >= 38) continue;
      const midpoint = (luminance[leftIndex] + luminance[rightIndex]) / 2;
      luminance[leftIndex] = Math.round(luminance[leftIndex] + (midpoint - luminance[leftIndex]) * blend);
      luminance[rightIndex] = Math.round(luminance[rightIndex] + (midpoint - luminance[rightIndex]) * blend);
    }
  }
  for (let y = 8; y < height - 1; y += 8) {
    for (let x = 0; x < width; x += 1) {
      const aboveIndex = (y - 1) * width + x;
      const belowIndex = y * width + x;
      const boundary = Math.abs(luminance[aboveIndex] - luminance[belowIndex]);
      const neighborhood = (
        Math.abs(luminance[aboveIndex] - luminance[aboveIndex - width])
        + Math.abs(luminance[belowIndex + width] - luminance[belowIndex])
      ) / 2;
      if (boundary <= neighborhood * 1.4 + 2 || boundary >= 38) continue;
      const midpoint = (luminance[aboveIndex] + luminance[belowIndex]) / 2;
      luminance[aboveIndex] = Math.round(luminance[aboveIndex] + (midpoint - luminance[aboveIndex]) * blend);
      luminance[belowIndex] = Math.round(luminance[belowIndex] + (midpoint - luminance[belowIndex]) * blend);
    }
  }
}

function buildLocalToneMap(
  luminance: Uint8Array,
  source: Uint8ClampedArray,
  width: number,
  height: number,
  amount: number,
  noiseLevel: number,
): LocalToneMap {
  const tileWidth = Math.max(48, Math.ceil(width / Math.max(2, Math.ceil(width / 192))));
  const tileHeight = Math.max(48, Math.ceil(height / Math.max(2, Math.ceil(height / 192))));
  const tilesX = Math.ceil(width / tileWidth);
  const tilesY = Math.ceil(height / tileHeight);
  const histograms = new Uint32Array(tilesX * tilesY * 256);
  const globalHistogram = new Uint32Array(256);
  const tilePixelCounts = new Uint32Array(tilesX * tilesY);
  let visiblePixels = 0;

  for (let y = 0; y < height; y += 1) {
    const tileY = Math.min(tilesY - 1, Math.floor(y / tileHeight));
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      if (source[pixel * 4 + 3] < 16) continue;
      const value = luminance[pixel];
      const tileX = Math.min(tilesX - 1, Math.floor(x / tileWidth));
      const tile = tileY * tilesX + tileX;
      histograms[tile * 256 + value] += 1;
      tilePixelCounts[tile] += 1;
      globalHistogram[value] += 1;
      visiblePixels += 1;
    }
  }

  const mappings = new Uint8Array(histograms.length);
  const tileStrengths = new Float32Array(tilesX * tilesY);
  for (let tileY = 0; tileY < tilesY; tileY += 1) {
    for (let tileX = 0; tileX < tilesX; tileX += 1) {
      const tile = tileY * tilesX + tileX;
      const offset = tile * 256;
      const pixelCount = tilePixelCounts[tile];
      const tileHistogram = histograms.subarray(offset, offset + 256);
      if (pixelCount === 0) {
        for (let value = 0; value < 256; value += 1) mappings[offset + value] = value;
        continue;
      }
      const low = percentile(tileHistogram, pixelCount, 0.08);
      const high = percentile(tileHistogram, pixelCount, 0.92);
      const localRange = high - low;
      if (localRange < 3) {
        for (let value = 0; value < 256; value += 1) mappings[offset + value] = value;
        tileStrengths[tile] = 0;
        continue;
      }
      const noiseProtection = 1 - noiseLevel * 0.68;
      tileStrengths[tile] = amount * (0.16 + 0.42 * clamp((112 - localRange) / 96, 0, 1)) * noiseProtection;

      const clipLimit = Math.max(2, Math.round(pixelCount / 256 * (2.1 + amount * 1.8)));
      let excess = 0;
      for (let value = 0; value < 256; value += 1) {
        if (tileHistogram[value] <= clipLimit) continue;
        excess += tileHistogram[value] - clipLimit;
        tileHistogram[value] = clipLimit;
      }
      const evenShare = Math.floor(excess / 256);
      const remainder = excess - evenShare * 256;
      for (let value = 0; value < 256; value += 1) {
        tileHistogram[value] += evenShare + (value < remainder ? 1 : 0);
      }

      let cumulative = 0;
      let firstCumulative = 0;
      for (let value = 0; value < 256; value += 1) {
        cumulative += tileHistogram[value];
        if (firstCumulative === 0 && cumulative > 0) firstCumulative = cumulative;
        const denominator = Math.max(1, pixelCount - firstCumulative);
        mappings[offset + value] = Math.round(clamp((cumulative - firstCumulative) * 255 / denominator));
      }
    }
  }
  return { globalHistogram, mappings, tileHeight, tileStrengths, tileWidth, tilesX, tilesY, visiblePixels };
}

function localToneValue(map: LocalToneMap, x: number, y: number, value: number): { mapped: number; strength: number } {
  const tilePositionX = x / map.tileWidth - 0.5;
  const tilePositionY = y / map.tileHeight - 0.5;
  const lowerX = Math.floor(tilePositionX);
  const lowerY = Math.floor(tilePositionY);
  const mixX = clamp(tilePositionX - lowerX, 0, 1);
  const mixY = clamp(tilePositionY - lowerY, 0, 1);
  const x0 = Math.round(clamp(lowerX, 0, map.tilesX - 1));
  const x1 = Math.round(clamp(lowerX + 1, 0, map.tilesX - 1));
  const y0 = Math.round(clamp(lowerY, 0, map.tilesY - 1));
  const y1 = Math.round(clamp(lowerY + 1, 0, map.tilesY - 1));
  const tile00 = y0 * map.tilesX + x0;
  const tile10 = y0 * map.tilesX + x1;
  const tile01 = y1 * map.tilesX + x0;
  const tile11 = y1 * map.tilesX + x1;
  const topMapped = map.mappings[tile00 * 256 + value] * (1 - mixX) + map.mappings[tile10 * 256 + value] * mixX;
  const bottomMapped = map.mappings[tile01 * 256 + value] * (1 - mixX) + map.mappings[tile11 * 256 + value] * mixX;
  const topStrength = map.tileStrengths[tile00] * (1 - mixX) + map.tileStrengths[tile10] * mixX;
  const bottomStrength = map.tileStrengths[tile01] * (1 - mixX) + map.tileStrengths[tile11] * mixX;
  return {
    mapped: topMapped * (1 - mixY) + bottomMapped * mixY,
    strength: topStrength * (1 - mixY) + bottomStrength * mixY,
  };
}

function softThreshold(value: number, threshold: number): number {
  return Math.sign(value) * Math.max(0, Math.abs(value) - threshold);
}

function fitRgbToGamut(red: number, green: number, blue: number, targetLuma: number): [number, number, number] {
  const minimum = Math.min(red, green, blue);
  const maximum = Math.max(red, green, blue);
  let scale = 1;
  if (minimum < 0) scale = Math.min(scale, targetLuma / Math.max(0.001, targetLuma - minimum));
  if (maximum > 255) scale = Math.min(scale, (255 - targetLuma) / Math.max(0.001, maximum - targetLuma));
  return [
    targetLuma + (red - targetLuma) * scale,
    targetLuma + (green - targetLuma) * scale,
    targetLuma + (blue - targetLuma) * scale,
  ];
}

function pairDifference(source: Uint8ClampedArray, first: number, second: number): number {
  return Math.abs(luma(
    source[first],
    source[first + 1],
    source[first + 2],
  ) - luma(
    source[second],
    source[second + 1],
    source[second + 2],
  ));
}

function writeWeightedPairs(
  source: Uint8ClampedArray,
  output: Uint8ClampedArray,
  outputOffset: number,
  pairCount: number,
  first0: number,
  second0: number,
  first1 = first0,
  second1 = second0,
  first2 = first0,
  second2 = second0,
  first3 = first0,
  second3 = second0,
  first4 = first0,
  second4 = second0,
  first5 = first0,
  second5 = second0,
) {
  let weightTotal = 0;
  let redTotal = 0;
  let greenTotal = 0;
  let blueTotal = 0;
  let alphaTotal = 0;
  for (let pair = 0; pair < pairCount; pair += 1) {
    let first = first0;
    let second = second0;
    if (pair === 1) { first = first1; second = second1; }
    else if (pair === 2) { first = first2; second = second2; }
    else if (pair === 3) { first = first3; second = second3; }
    else if (pair === 4) { first = first4; second = second4; }
    else if (pair === 5) { first = first5; second = second5; }
    const difference = pairDifference(source, first, second);
    const weight = 1 / (1 + (difference / 10) ** 2);
    weightTotal += weight;
    const firstAlpha = source[first + 3] / 255;
    const secondAlpha = source[second + 3] / 255;
    const pairAlpha = firstAlpha + secondAlpha;
    if (pairAlpha > 0) {
      redTotal += (source[first] * firstAlpha + source[second] * secondAlpha) / pairAlpha * weight;
      greenTotal += (source[first + 1] * firstAlpha + source[second + 1] * secondAlpha) / pairAlpha * weight;
      blueTotal += (source[first + 2] * firstAlpha + source[second + 2] * secondAlpha) / pairAlpha * weight;
    }
    alphaTotal += pairAlpha * 127.5 * weight;
  }
  const divisor = Math.max(0.0001, weightTotal);
  output[outputOffset] = redTotal / divisor;
  output[outputOffset + 1] = greenTotal / divisor;
  output[outputOffset + 2] = blueTotal / divisor;
  output[outputOffset + 3] = alphaTotal / divisor;
}

function reconstructionScale(width: number, height: number): 1 | 2 {
  const sourcePixels = width * height;
  if (
    Math.min(width, height) < MIN_SOURCE_EDGE_FOR_RECONSTRUCTION
    || sourcePixels > MAX_SOURCE_PIXELS_FOR_RECONSTRUCTION
    || sourcePixels * 4 > MAX_RECONSTRUCTED_PIXELS
  ) return 1;
  return 2;
}

/**
 * Reconstructs intermediate samples around local edge direction while retaining
 * every corrected source sample exactly on the even output grid.
 */
export function reconstructPixels(
  source: Uint8ClampedArray,
  width: number,
  height: number,
): PixelReconstructionResult {
  if (source.length !== width * height * 4) throw new Error("Corrected pixel data is incomplete.");
  const scale = reconstructionScale(width, height);
  if (scale === 1) return { pixels: source, width, height, scale };

  const outputWidth = width * 2;
  const outputHeight = height * 2;
  const output = new Uint8ClampedArray(outputWidth * outputHeight * 4);
  const sourceOffset = (x: number, y: number) => (y * width + x) * 4;
  const outputOffset = (x: number, y: number) => (y * outputWidth + x) * 4;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const input = sourceOffset(x, y);
      const target = outputOffset(x * 2, y * 2);
      output[target] = source[input];
      output[target + 1] = source[input + 1];
      output[target + 2] = source[input + 2];
      output[target + 3] = source[input + 3];
    }
  }

  // Horizontal half-samples compare the direct pair with both diagonals.
  for (let y = 0; y < height; y += 1) {
    const above = Math.max(0, y - 1);
    const below = Math.min(height - 1, y + 1);
    for (let x = 0; x < width - 1; x += 1) {
      writeWeightedPairs(
        source,
        output,
        outputOffset(x * 2 + 1, y * 2),
        3,
        sourceOffset(x, y),
        sourceOffset(x + 1, y),
        sourceOffset(x, above),
        sourceOffset(x + 1, below),
        sourceOffset(x, below),
        sourceOffset(x + 1, above),
      );
    }
    const lastSource = sourceOffset(width - 1, y);
    const lastOutput = outputOffset(outputWidth - 1, y * 2);
    output.set(source.subarray(lastSource, lastSource + 4), lastOutput);
  }

  // Vertical half-samples use the direct pair and the two cross-edge diagonals.
  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const left = Math.max(0, x - 1);
      const right = Math.min(width - 1, x + 1);
      writeWeightedPairs(
        source,
        output,
        outputOffset(x * 2, y * 2 + 1),
        3,
        sourceOffset(x, y),
        sourceOffset(x, y + 1),
        sourceOffset(left, y),
        sourceOffset(right, y + 1),
        sourceOffset(right, y),
        sourceOffset(left, y + 1),
      );
    }
    writeWeightedPairs(source, output, outputOffset(outputWidth - 1, y * 2 + 1), 1,
      sourceOffset(width - 1, y),
      sourceOffset(width - 1, y + 1),
    );
  }

  // Cell centres select between both diagonals and both axis directions.
  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const topLeft = sourceOffset(x, y);
      const topRight = sourceOffset(x + 1, y);
      const bottomLeft = sourceOffset(x, y + 1);
      const bottomRight = sourceOffset(x + 1, y + 1);
      writeWeightedPairs(
        source,
        output,
        outputOffset(x * 2 + 1, y * 2 + 1),
        6,
        topLeft,
        bottomRight,
        topRight,
        bottomLeft,
        topLeft,
        topRight,
        bottomLeft,
        bottomRight,
        topLeft,
        bottomLeft,
        topRight,
        bottomRight,
      );
    }
  }

  // Extend the final output row from the last corrected source row.
  const finalSourceRow = (height - 1) * width * 4;
  for (let x = 0; x < width; x += 1) {
    const input = finalSourceRow + x * 4;
    const even = outputOffset(x * 2, outputHeight - 1);
    output.set(source.subarray(input, input + 4), even);
    if (x < width - 1) {
      writeWeightedPairs(source, output, even + 4, 1, input, input + 4);
    } else {
      output.set(source.subarray(input, input + 4), even + 4);
    }
  }

  return { pixels: output, width: outputWidth, height: outputHeight, scale };
}

export function enhancePixels(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  strength: number,
): PixelEnhancementResult {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error("Image dimensions are invalid.");
  }
  if (source.length !== width * height * 4) throw new Error("Decoded pixel data is incomplete.");
  if (!Number.isFinite(strength) || strength < MIN_STRENGTH || strength > MAX_STRENGTH) {
    throw new Error("Enhancement strength is outside the supported range.");
  }

  const measured = analyse(source, width, height);
  const amount = strength / MAX_STRENGTH;
  const pixelCount = width * height;
  const luminance = new Uint8Array(pixelCount);
  const fineBlur = new Uint8Array(pixelCount);
  const coarseBlur = new Uint8Array(pixelCount);
  const temporary = new Uint8Array(pixelCount);
  const neutralIlluminant = (measured.illuminantRed + measured.illuminantGreen + measured.illuminantBlue) / 3;
  const balanceLimit = 0.16 * amount;
  const redBalance = clamp(neutralIlluminant / Math.max(1, measured.illuminantRed), 1 - balanceLimit, 1 + balanceLimit);
  const greenBalance = clamp(neutralIlluminant / Math.max(1, measured.illuminantGreen), 1 - balanceLimit, 1 + balanceLimit);
  const blueBalance = clamp(neutralIlluminant / Math.max(1, measured.illuminantBlue), 1 - balanceLimit, 1 + balanceLimit);

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * 4;
    luminance[pixel] = Math.round(clamp(luma(
      source[offset] * redBalance,
      source[offset + 1] * greenBalance,
      source[offset + 2] * blueBalance,
    )));
  }

  boxBlur(luminance, width, height, 1, temporary, fineBlur);
  reduceNoise(luminance, fineBlur, measured.noiseSigma, amount);
  reduceBlockBoundaries(luminance, width, height, measured.blockiness, amount);
  boxBlur(luminance, width, height, 1, temporary, fineBlur);
  boxBlur(luminance, width, height, 4, temporary, coarseBlur);
  const toneMap = buildLocalToneMap(luminance, source, width, height, amount, measured.noiseLevel);
  const shadowPoint = percentile(toneMap.globalHistogram, toneMap.visiblePixels, 0.005);
  const highlightPoint = percentile(toneMap.globalHistogram, toneMap.visiblePixels, 0.995);
  const medianLuma = percentile(toneMap.globalHistogram, toneMap.visiblePixels, 0.5);
  const range = Math.max(1, highlightPoint - shadowPoint);
  const rangeNeed = clamp((222 - range) / 150, 0, 1);
  const stretchStrength = amount * (0.08 + rangeNeed * 0.55);
  const median = clamp(medianLuma / 255, 0.02, 0.98);
  const targetMedian = median < 0.4 ? 0.47 : median > 0.64 ? 0.56 : median;
  const exposureGamma = clamp(Math.log(targetMedian) / Math.log(median), 0.78, 1.28);
  const exposureStrength = amount * clamp(Math.abs(targetMedian - median) / 0.18, 0, 0.72);
  const fineGain = 1.42 * amount * (1 - measured.noiseLevel * 0.85);
  const mediumGain = 0.62 * amount * (1 - measured.noiseLevel * 0.35);
  const detailThreshold = measured.noiseSigma * 0.8;
  const output = new Uint8ClampedArray(source.length);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const offset = pixel * 4;
      if (source[offset + 3] === 0) {
        output[offset] = source[offset];
        output[offset + 1] = source[offset + 1];
        output[offset + 2] = source[offset + 2];
        output[offset + 3] = 0;
        continue;
      }

      const currentLuma = luminance[pixel];
      const stretched = clamp((currentLuma - shadowPoint) * 247 / range + 4);
      const gammaMapped = 255 * (currentLuma / 255) ** exposureGamma;
      let targetLuma = currentLuma
        + (stretched - currentLuma) * stretchStrength
        + (gammaMapped - currentLuma) * exposureStrength;
      const local = localToneValue(toneMap, x, y, currentLuma);
      const localDelta = clamp(local.mapped - currentLuma, -38, 38);
      const endProtection = Math.min(currentLuma, 255 - currentLuma) / 24;
      targetLuma += localDelta * local.strength * clamp(endProtection, 0.18, 1);

      const fineDetail = softThreshold(currentLuma - fineBlur[pixel], detailThreshold);
      const mediumDetail = fineBlur[pixel] - coarseBlur[pixel];
      const largeEdge = Math.abs(currentLuma - coarseBlur[pixel]);
      const edgeGate = 1 - 0.58 * clamp((largeEdge - 30) / 58, 0, 1);
      const detail = clamp(fineDetail * fineGain, -18, 18)
        + clamp(mediumDetail * mediumGain * edgeGate, -11, 11);
      targetLuma = clamp(targetLuma + detail, 1, 254);

      const balancedRed = source[offset] * redBalance;
      const balancedGreen = source[offset + 1] * greenBalance;
      const balancedBlue = source[offset + 2] * blueBalance;
      const balancedLuma = luma(balancedRed, balancedGreen, balancedBlue);
      const chromaRange = Math.max(balancedRed, balancedGreen, balancedBlue) - Math.min(balancedRed, balancedGreen, balancedBlue);
      const vibrance = 1 + amount * 0.09 * (1 - clamp(chromaRange / 150, 0, 1));
      const red = targetLuma + (balancedRed - balancedLuma) * vibrance;
      const blue = targetLuma + (balancedBlue - balancedLuma) * vibrance;
      const green = (targetLuma - LUMA_RED * red - LUMA_BLUE * blue) / LUMA_GREEN;
      const fitted = fitRgbToGamut(red, green, blue, targetLuma);
      output[offset] = clamp(fitted[0]);
      output[offset + 1] = clamp(fitted[1]);
      output[offset + 2] = clamp(fitted[2]);
      output[offset + 3] = source[offset + 3];
    }
  }

  return {
    pixels: output,
    analysis: {
      noiseLevel: measured.noiseLevel,
      edgeDefinition: measured.edgeDefinition,
      tonalRange: measured.tonalRange,
      colourCast: measured.colourCast,
    },
  };
}
