export interface FidelityEvidence {
  lowTextureMeanRgbShift: number;
  highDriftFraction: number;
  alphaMismatchFraction: number;
  overallMeanRgbDifference: number;
  passed: boolean;
}

export function measureCoordinateMatchedFidelity(
  source: Uint8ClampedArray,
  result: Uint8ClampedArray,
  width: number,
  height: number,
): FidelityEvidence {
  if (source.length !== result.length || source.length !== width * height * 4) {
    throw new Error("Fidelity samples are not coordinate-aligned.");
  }
  let lowTextureShift = 0;
  let lowTextureChannels = 0;
  let highDrift = 0;
  let alphaMismatch = 0;
  let overallDifference = 0;
  let visiblePixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      if (source[offset + 3] < 8 && result[offset + 3] < 8) continue;
      const difference = (
        Math.abs(source[offset] - result[offset])
        + Math.abs(source[offset + 1] - result[offset + 1])
        + Math.abs(source[offset + 2] - result[offset + 2])
      ) / 3;
      overallDifference += difference;
      visiblePixels += 1;
      if (difference > 42) highDrift += 1;
      // A reconstruction may legitimately change fractional alpha coverage at
      // the source contour by less than a source pixel. Protect the topology,
      // however: new opacity in stable transparent regions (or holes in stable
      // opaque regions) is always counted as drift.
      if (
        Math.abs(source[offset + 3] - result[offset + 3]) > 16
        && !isSourceAlphaEdge(source, width, height, x, y)
      ) alphaMismatch += 1;
      const localRange = neighbourhoodRange(source, width, height, x, y);
      if (localRange <= 10) {
        lowTextureShift += difference * 3;
        lowTextureChannels += 3;
      }
    }
  }
  const lowTextureMeanRgbShift = lowTextureShift / Math.max(1, lowTextureChannels);
  const highDriftFraction = highDrift / Math.max(1, visiblePixels);
  const alphaMismatchFraction = alphaMismatch / Math.max(1, visiblePixels);
  const overallMeanRgbDifference = overallDifference / Math.max(1, visiblePixels);
  return {
    lowTextureMeanRgbShift,
    highDriftFraction,
    alphaMismatchFraction,
    overallMeanRgbDifference,
    passed: lowTextureMeanRgbShift <= 12
      && highDriftFraction <= 0.08
      && alphaMismatchFraction <= 0.005,
  };
}

function isSourceAlphaEdge(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
) {
  let minimum = 255;
  let maximum = 0;
  for (let sampleY = Math.max(0, y - 1); sampleY <= Math.min(height - 1, y + 1); sampleY += 1) {
    for (let sampleX = Math.max(0, x - 1); sampleX <= Math.min(width - 1, x + 1); sampleX += 1) {
      const alpha = pixels[(sampleY * width + sampleX) * 4 + 3];
      minimum = Math.min(minimum, alpha);
      maximum = Math.max(maximum, alpha);
    }
  }
  return maximum - minimum > 16;
}

function neighbourhoodRange(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
) {
  let minimum = 255;
  let maximum = 0;
  for (let sampleY = Math.max(0, y - 1); sampleY <= Math.min(height - 1, y + 1); sampleY += 1) {
    for (let sampleX = Math.max(0, x - 1); sampleX <= Math.min(width - 1, x + 1); sampleX += 1) {
      const offset = (sampleY * width + sampleX) * 4;
      const value = pixels[offset] * 0.2126 + pixels[offset + 1] * 0.7152 + pixels[offset + 2] * 0.0722;
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
  }
  return maximum - minimum;
}
