export interface PairedQualityMetrics {
  psnrDb: number;
  structuralSimilarity: number;
  edgeRetention: number;
  meanRgbError: number;
}

export interface BlindReviewAssignment {
  assignmentId: string;
  left: "reference" | "candidate";
  right: "reference" | "candidate";
}

export interface BlindQualityReview {
  assignmentId: string;
  reviewerId: string;
  candidateSide: "left" | "right";
  winner: "left" | "right" | "tie";
  detail: 1 | 2 | 3 | 4 | 5;
  naturalness: 1 | 2 | 3 | 4 | 5;
  colourFidelity: 1 | 2 | 3 | 4 | 5;
  hasHalo: boolean;
  hasInventedContent: boolean;
  hasIdentityOrTextChange: boolean;
}

export function measurePairedQuality(
  reference: Uint8ClampedArray,
  candidate: Uint8ClampedArray,
  width: number,
  height: number,
): PairedQualityMetrics {
  if (reference.length !== candidate.length || reference.length !== width * height * 4) {
    throw new Error("Paired quality inputs must be decoded and dimension-aligned.");
  }
  let squaredError = 0;
  let absoluteError = 0;
  let referenceMean = 0;
  let candidateMean = 0;
  const pixelCount = width * height;
  const referenceLuma = new Float64Array(pixelCount);
  const candidateLuma = new Float64Array(pixelCount);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * 4;
    for (let channel = 0; channel < 3; channel += 1) {
      const difference = reference[offset + channel] - candidate[offset + channel];
      squaredError += difference * difference;
      absoluteError += Math.abs(difference);
    }
    referenceLuma[pixel] = luma(reference, offset);
    candidateLuma[pixel] = luma(candidate, offset);
    referenceMean += referenceLuma[pixel];
    candidateMean += candidateLuma[pixel];
  }
  referenceMean /= pixelCount;
  candidateMean /= pixelCount;
  let referenceVariance = 0;
  let candidateVariance = 0;
  let covariance = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const first = referenceLuma[pixel] - referenceMean;
    const second = candidateLuma[pixel] - candidateMean;
    referenceVariance += first * first;
    candidateVariance += second * second;
    covariance += first * second;
  }
  const divisor = Math.max(1, pixelCount - 1);
  referenceVariance /= divisor;
  candidateVariance /= divisor;
  covariance /= divisor;
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  const structuralSimilarity = (
    (2 * referenceMean * candidateMean + c1) * (2 * covariance + c2)
    / ((referenceMean ** 2 + candidateMean ** 2 + c1) * (referenceVariance + candidateVariance + c2))
  );
  const meanSquaredError = squaredError / Math.max(1, pixelCount * 3);
  return {
    psnrDb: meanSquaredError === 0 ? Number.POSITIVE_INFINITY : 10 * Math.log10(255 ** 2 / meanSquaredError),
    structuralSimilarity: Math.max(-1, Math.min(1, structuralSimilarity)),
    edgeRetention: edgeEnergy(candidateLuma, width, height) / Math.max(0.0001, edgeEnergy(referenceLuma, width, height)),
    meanRgbError: absoluteError / Math.max(1, pixelCount * 3),
  };
}

export function createBlindReviewAssignment(assetId: string, candidateId: string): BlindReviewAssignment {
  const assignmentId = `${assetId}:${candidateId}`;
  let hash = 2166136261;
  for (const character of assignmentId) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 16777619);
  }
  const referenceFirst = (hash >>> 0) % 2 === 0;
  return {
    assignmentId,
    left: referenceFirst ? "reference" : "candidate",
    right: referenceFirst ? "candidate" : "reference",
  };
}

export function blindReviewPasses(review: BlindQualityReview): boolean {
  return !review.hasHalo
    && !review.hasInventedContent
    && !review.hasIdentityOrTextChange
    && review.detail >= 3
    && review.naturalness >= 3
    && review.colourFidelity >= 3;
}

const luma = (pixels: Uint8ClampedArray, offset: number) => (
  pixels[offset] * 0.2126 + pixels[offset + 1] * 0.7152 + pixels[offset + 2] * 0.0722
);

function edgeEnergy(luminance: Float64Array, width: number, height: number) {
  let total = 0;
  let samples = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const offset = y * width + x;
      total += Math.hypot(
        luminance[offset + 1] - luminance[offset - 1],
        luminance[offset + width] - luminance[offset - width],
      );
      samples += 1;
    }
  }
  return total / Math.max(1, samples);
}
