import { blindReviewPasses, type BlindQualityReview, type PairedQualityMetrics } from "./imageQualityEvaluation.ts";
import type { FidelityEvidence } from "./imageQualityFidelity";

export const IMAGE_QUALITY_EVIDENCE_CATEGORIES = [
  "flat_logo",
  "soft_illustration",
  "face_portrait",
  "old_photograph",
  "modern_mobile_photo",
  "low_light_noisy",
  "text_or_screenshot",
  "product_with_labels",
  "transparent_artwork",
  "wide_gamut_or_profiled",
  "large_professional",
] as const;

export type ImageQualityEvidenceCategory = typeof IMAGE_QUALITY_EVIDENCE_CATEGORIES[number];

export interface ImageQualityEvidenceAsset {
  assetId: string;
  sourceSha256: string;
  category: ImageQualityEvidenceCategory;
  owner: string;
  licenceOrPermission: string;
  permittedBenchmarkUse: boolean;
  publicDemoPermitted: boolean;
  containsPeople: boolean;
  containsSensitiveInformation: boolean;
}

export interface ImageQualityCandidateEvidence {
  assetId: string;
  sourceSha256: string;
  outputSha256: string;
  engineId: string;
  engineVersion: string;
  route: string;
  strength: number;
  fidelity: FidelityEvidence;
  pairedMetrics?: PairedQualityMetrics;
  blindReviews: BlindQualityReview[];
}

export function validateEvidenceAsset(asset: ImageQualityEvidenceAsset): string[] {
  const errors: string[] = [];
  if (!/^[a-z0-9][a-z0-9._-]{2,127}$/i.test(asset.assetId)) errors.push("assetId must be an opaque stable identifier.");
  if (!/^[a-f0-9]{64}$/.test(asset.sourceSha256)) errors.push("sourceSha256 must be a lowercase SHA-256 digest.");
  if (!IMAGE_QUALITY_EVIDENCE_CATEGORIES.includes(asset.category)) errors.push("category is not supported.");
  if (!asset.owner.trim()) errors.push("owner is required.");
  if (!asset.licenceOrPermission.trim()) errors.push("licenceOrPermission is required.");
  if (!asset.permittedBenchmarkUse) errors.push("permittedBenchmarkUse must be true before pixels can enter a benchmark.");
  if (asset.containsSensitiveInformation) errors.push("sensitive customer content is blocked from this local benchmark evidence set.");
  return errors;
}

export function candidateEvidencePasses(candidate: ImageQualityCandidateEvidence): boolean {
  const candidateWins = candidate.blindReviews.filter((review) => review.winner === review.candidateSide).length;
  const independentReviewers = new Set(candidate.blindReviews.map((review) => review.reviewerId));
  return candidate.fidelity.passed
    && /^[a-f0-9]{64}$/.test(candidate.sourceSha256)
    && /^[a-f0-9]{64}$/.test(candidate.outputSha256)
    && candidate.blindReviews.length >= 3
    && independentReviewers.size >= 3
    && candidate.blindReviews.every(blindReviewPasses)
    && candidateWins > candidate.blindReviews.length / 2;
}
