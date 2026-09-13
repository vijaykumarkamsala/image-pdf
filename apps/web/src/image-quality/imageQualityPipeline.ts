import type { ImageQualityAnalysis } from "./ImageQualityEngine";

export const MIN_STRENGTH = 1;
export const MAX_STRENGTH = 100;

export interface PixelEnhancementResult {
  pixels: Uint8ClampedArray;
  analysis: ImageQualityAnalysis;
}

const clamp = (value: number, minimum = 0, maximum = 255) => Math.min(maximum, Math.max(minimum, value));
const luma = (red: number, green: number, blue: number) => 0.2126 * red + 0.7152 * green + 0.0722 * blue;

function percentile(histogram: Uint32Array, count: number, fraction: number): number {
  const target = Math.max(1, Math.round(count * fraction));
  let seen = 0;
  for (let value = 0; value < histogram.length; value += 1) {
    seen += histogram[value];
    if (seen >= target) return value;
  }
  return 255;
}

function analyse(source: Uint8ClampedArray, width: number, height: number): ImageQualityAnalysis & {
  meanRed: number;
  meanGreen: number;
  meanBlue: number;
  meanLuma: number;
  shadowPoint: number;
  highlightPoint: number;
} {
  const histogram = new Uint32Array(256);
  const pixelCount = width * height;
  const sampleStep = Math.max(1, Math.floor(pixelCount / 1_000_000));
  let samples = 0;
  let redTotal = 0;
  let greenTotal = 0;
  let blueTotal = 0;
  let lumaTotal = 0;
  let neighborDifference = 0;
  let edgeTotal = 0;
  let neighborSamples = 0;

  for (let pixel = 0; pixel < pixelCount; pixel += sampleStep) {
    const offset = pixel * 4;
    const red = source[offset];
    const green = source[offset + 1];
    const blue = source[offset + 2];
    const value = Math.round(luma(red, green, blue));
    histogram[value] += 1;
    redTotal += red;
    greenTotal += green;
    blueTotal += blue;
    lumaTotal += value;
    samples += 1;

    const x = pixel % width;
    if (x + sampleStep < width && pixel + sampleStep < pixelCount) {
      const neighborOffset = (pixel + sampleStep) * 4;
      const neighbor = luma(source[neighborOffset], source[neighborOffset + 1], source[neighborOffset + 2]);
      const difference = Math.abs(value - neighbor);
      edgeTotal += difference;
      if (difference < 18) neighborDifference += difference;
      neighborSamples += 1;
    }
  }

  const meanRed = redTotal / samples;
  const meanGreen = greenTotal / samples;
  const meanBlue = blueTotal / samples;
  const meanLuma = lumaTotal / samples;
  const shadowPoint = percentile(histogram, samples, 0.01);
  const highlightPoint = percentile(histogram, samples, 0.99);
  const neutralMean = (meanRed + meanGreen + meanBlue) / 3;
  const colourCast = Math.max(
    Math.abs(meanRed - neutralMean),
    Math.abs(meanGreen - neutralMean),
    Math.abs(meanBlue - neutralMean),
  ) / 255;

  return {
    noiseLevel: clamp(neighborDifference / Math.max(1, neighborSamples) / 18, 0, 1),
    edgeDefinition: clamp(edgeTotal / Math.max(1, neighborSamples) / 32, 0, 1),
    tonalRange: (highlightPoint - shadowPoint) / 255,
    colourCast,
    meanRed,
    meanGreen,
    meanBlue,
    meanLuma,
    shadowPoint,
    highlightPoint,
  };
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
  const corrected = new Uint8ClampedArray(source.length);
  const neutralMean = (measured.meanRed + measured.meanGreen + measured.meanBlue) / 3;
  const whiteBalanceLimit = 0.06 * amount;
  const redBalance = clamp(neutralMean / Math.max(1, measured.meanRed), 1 - whiteBalanceLimit, 1 + whiteBalanceLimit);
  const greenBalance = clamp(neutralMean / Math.max(1, measured.meanGreen), 1 - whiteBalanceLimit, 1 + whiteBalanceLimit);
  const blueBalance = clamp(neutralMean / Math.max(1, measured.meanBlue), 1 - whiteBalanceLimit, 1 + whiteBalanceLimit);
  const exposure = clamp(122 / Math.max(48, measured.meanLuma), 0.94, 1.06) ** amount;
  const contrastNeed = clamp((0.72 - measured.tonalRange) / 0.72, 0, 1);
  const contrast = 1 + contrastNeed * 0.09 * amount;
  const denoise = clamp(measured.noiseLevel * 0.38 * amount, 0, 0.28);
  const similarityThreshold = 10 + measured.noiseLevel * 20;

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width * 4;
    const aboveOffset = (y === 0 ? y : y - 1) * width * 4;
    const belowOffset = (y === height - 1 ? y : y + 1) * width * 4;
    for (let x = 0; x < width; x += 1) {
      const offset = rowOffset + x * 4;
      const centerLuma = luma(source[offset], source[offset + 1], source[offset + 2]);
      const left = x === 0 ? offset : offset - 4;
      const right = x === width - 1 ? offset : offset + 4;
      const above = aboveOffset + x * 4;
      const below = belowOffset + x * 4;
      let red = source[offset];
      let green = source[offset + 1];
      let blue = source[offset + 2];
      let accepted = 0;
      let redTotal = 0;
      let greenTotal = 0;
      let blueTotal = 0;
      for (let direction = 0; direction < 4; direction += 1) {
        const candidate = direction === 0 ? left : direction === 1 ? right : direction === 2 ? above : below;
        const candidateLuma = luma(source[candidate], source[candidate + 1], source[candidate + 2]);
        if (Math.abs(centerLuma - candidateLuma) <= similarityThreshold) {
          redTotal += source[candidate];
          greenTotal += source[candidate + 1];
          blueTotal += source[candidate + 2];
          accepted += 1;
        }
      }
      if (accepted > 0 && denoise > 0) {
        red += (redTotal / accepted - red) * denoise;
        green += (greenTotal / accepted - green) * denoise;
        blue += (blueTotal / accepted - blue) * denoise;
      }
      corrected[offset] = clamp(((red * redBalance * exposure) - 127.5) * contrast + 127.5);
      corrected[offset + 1] = clamp(((green * greenBalance * exposure) - 127.5) * contrast + 127.5);
      corrected[offset + 2] = clamp(((blue * blueBalance * exposure) - 127.5) * contrast + 127.5);
      corrected[offset + 3] = source[offset + 3];
    }
  }

  const output = new Uint8ClampedArray(source.length);
  const sharpenNeed = clamp((0.82 - measured.edgeDefinition) / 0.82, 0.25, 1);
  const sharpenAmount = 0.48 * sharpenNeed * amount;
  const localContrastAmount = 0.11 * contrastNeed * amount;
  const detailThreshold = 1.5 + measured.noiseLevel * 3.5;
  const detailLimit = 11 * amount;

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width * 4;
    const aboveOffset = (y === 0 ? y : y - 1) * width * 4;
    const belowOffset = (y === height - 1 ? y : y + 1) * width * 4;
    for (let x = 0; x < width; x += 1) {
      const offset = rowOffset + x * 4;
      const center = luma(corrected[offset], corrected[offset + 1], corrected[offset + 2]);
      const left = x === 0 ? offset : offset - 4;
      const right = x === width - 1 ? offset : offset + 4;
      const above = aboveOffset + x * 4;
      const below = belowOffset + x * 4;
      const localMean = (
        luma(corrected[left], corrected[left + 1], corrected[left + 2])
        + luma(corrected[right], corrected[right + 1], corrected[right + 2])
        + luma(corrected[above], corrected[above + 1], corrected[above + 2])
        + luma(corrected[below], corrected[below + 1], corrected[below + 2])
      ) / 4;
      const highPass = center - localMean;
      const sharpen = Math.abs(highPass) <= detailThreshold ? 0 : highPass * sharpenAmount;
      const localContrast = highPass * localContrastAmount;
      const detail = clamp(sharpen + localContrast, -detailLimit, detailLimit);
      output[offset] = clamp(corrected[offset] + detail);
      output[offset + 1] = clamp(corrected[offset + 1] + detail);
      output[offset + 2] = clamp(corrected[offset + 2] + detail);
      output[offset + 3] = corrected[offset + 3];
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
