/** Separate, explicit Recreate boundary. Ordinary Enhance quality never calls it. */
export interface FaceModelRelease {
  id: string;
  version: string;
  weightsSha256: string | null;
  dependencyLockSha256: string | null;
  commercialRights: "pending" | "approved" | "rejected";
  rightsEvidenceId: string | null;
  qualityReview: "pending" | "approved" | "rejected";
  qualityEvidenceId: string | null;
}

/** No face model is currently cleared and accepted. An environment flag cannot approve it. */
export const FACE_DETAIL_RELEASE: Readonly<FaceModelRelease> = Object.freeze({
  id: "face-detail-model-not-approved",
  version: "unreleased",
  weightsSha256: null,
  dependencyLockSha256: null,
  commercialRights: "pending",
  rightsEvidenceId: null,
  qualityReview: "pending",
  qualityEvidenceId: null,
});

const sha256Pattern = /^[a-f0-9]{64}$/;

export function faceModelBlockers(release: Readonly<FaceModelRelease>): string[] {
  const blockers: string[] = [];
  if (!release.id.trim() || !release.version.trim()
    || !sha256Pattern.test(release.weightsSha256 ?? "")
    || !sha256Pattern.test(release.dependencyLockSha256 ?? "")) {
    blockers.push("Exact model weights and executed dependencies are not pinned and verified.");
  }
  if (release.commercialRights !== "approved" || !release.rightsEvidenceId?.trim()) {
    blockers.push("Commercial execution and distribution rights have not been approved.");
  }
  if (release.qualityReview !== "approved" || !release.qualityEvidenceId?.trim()) {
    blockers.push("Face-detail quality and identity-change review have not passed.");
  }
  return blockers;
}

export interface FaceDetailContext {
  sourceSha256: string;
  baseOutputSha256: string;
  sourceWidth: number;
  sourceHeight: number;
  outputWidth: number;
  outputHeight: number;
}

/** Integer output-pixel coordinates, not viewer/canvas/screenshot coordinates. */
export interface FaceDetailRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FaceDetailCandidate {
  id: string;
  context: FaceDetailContext;
  modelSha256: string;
  fidelity: number;
  region: FaceDetailRegion;
  /** Already inverse-aligned RGBA patch from the worker. No UI-thread inference. */
  pixels: Uint8ClampedArray;
  /** Explicit reconstruction/feather mask; zero means keep the base pixel exactly. */
  mask: Uint8Array;
}

export interface FaceRestorationRequest {
  context: FaceDetailContext;
  /** Immutable decoded source pixels; implementations must not use viewer pixels. */
  sourcePixels: Uint8ClampedArray;
  consent: { sourceSha256: string; allowReconstructedFaceDetail: true };
  fidelity: number;
  candidateCount: 2 | 3;
}

/** Implementations must detect/align, infer and inverse-align outside the UI thread.
 * There is deliberately no default adapter or ordinary-enhancement fallback.
 */
export interface FaceRestorationEngine {
  readonly release: Readonly<FaceModelRelease>;
  generateCandidates(request: FaceRestorationRequest, signal: AbortSignal): Promise<FaceDetailCandidate[]>;
  dispose(): void;
}

export interface FaceDetailReview {
  sourceSha256: string;
  baseOutputSha256: string;
  candidateSha256: string;
  allowReconstructedFaceDetail: true;
  acknowledgedPossibleIdentityChange: true;
}

function validateContext(context: FaceDetailContext) {
  if (!sha256Pattern.test(context.sourceSha256) || !sha256Pattern.test(context.baseOutputSha256)) {
    throw new Error("Face restoration must be bound to the original and enhanced image hashes.");
  }
  if (![context.sourceWidth, context.sourceHeight, context.outputWidth, context.outputHeight]
    .every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error("Face restoration requires valid source and output dimensions.");
  }
  if (!Number.isSafeInteger(context.outputWidth * context.outputHeight * 4)
    || !Number.isSafeInteger(context.sourceWidth * context.sourceHeight * 4)) {
    throw new Error("Face restoration dimensions exceed safe pixel addressing.");
  }
  if (context.outputWidth / context.sourceWidth !== context.outputHeight / context.sourceHeight) {
    throw new Error("Face restoration cannot stretch or change the source-image framing.");
  }
}

export { validateContext as validateFaceDetailContext };

export type FaceRecreateEvidence = Awaited<ReturnType<typeof applyReviewedFaceCandidate>>["evidence"];

export function validateFaceRestorationRequest(request: FaceRestorationRequest, release: Readonly<FaceModelRelease>) {
  const blockers = faceModelBlockers(release);
  if (blockers.length) throw new Error(`Face detail is unavailable. ${blockers.join(" ")}`);
  validateContext(request.context);
  if (request.consent?.allowReconstructedFaceDetail !== true
    || request.consent.sourceSha256 !== request.context.sourceSha256) {
    throw new Error("Explicit permission for this original image is required.");
  }
  if (!(request.sourcePixels instanceof Uint8ClampedArray)
    || request.sourcePixels.length !== request.context.sourceWidth * request.context.sourceHeight * 4) {
    throw new Error("Face restoration requires complete decoded source pixels.");
  }
  if (!Number.isFinite(request.fidelity) || request.fidelity < 0 || request.fidelity > 1
    || (request.candidateCount !== 2 && request.candidateCount !== 3)) {
    throw new Error("Request two or three candidates with a valid fidelity setting.");
  }
}

function validateCandidate(candidate: FaceDetailCandidate) {
  validateContext(candidate.context);
  const { x, y, width, height } = candidate.region;
  if (!candidate.id.trim() || !sha256Pattern.test(candidate.modelSha256)
    || !Number.isFinite(candidate.fidelity) || candidate.fidelity < 0 || candidate.fidelity > 1) {
    throw new Error("The face candidate has invalid model or fidelity evidence.");
  }
  if (![x, y, width, height].every(Number.isSafeInteger) || x < 0 || y < 0 || width <= 0 || height <= 0
    || x + width > candidate.context.outputWidth || y + height > candidate.context.outputHeight
    || !(candidate.pixels instanceof Uint8ClampedArray) || !(candidate.mask instanceof Uint8Array)
    || candidate.pixels.length !== width * height * 4 || candidate.mask.length !== width * height) {
    throw new Error("The reconstructed region must fit the existing output without resizing it.");
  }
}

function sameContext(first: FaceDetailContext, second: FaceDetailContext): boolean {
  return first.sourceSha256 === second.sourceSha256 && first.baseOutputSha256 === second.baseOutputSha256
    && first.sourceWidth === second.sourceWidth && first.sourceHeight === second.sourceHeight
    && first.outputWidth === second.outputWidth && first.outputHeight === second.outputHeight;
}

/** Used again inside the isolated rendering worker, not just trusted to the UI. */
export function validateFaceCandidateForContext(candidate: FaceDetailCandidate, context: FaceDetailContext, release: Readonly<FaceModelRelease>) {
  const blockers = faceModelBlockers(release);
  if (blockers.length) throw new Error(`Face detail is unavailable. ${blockers.join(" ")}`);
  validateCandidate(candidate);
  if (!sameContext(candidate.context, context) || candidate.modelSha256 !== release.weightsSha256) {
    throw new Error("This face candidate belongs to a different image, base result or approved model.");
  }
}

/** Fail closed before invoking an adapter, and reject cancelled/stale candidate sets. */
export async function generateFaceDetailCandidates(
  engine: FaceRestorationEngine,
  request: FaceRestorationRequest,
  signal: AbortSignal,
) {
  const release = { ...engine.release };
  validateFaceRestorationRequest(request, release);
  signal.throwIfAborted();
  const expectedContext = { ...request.context };
  const expectedCount = request.candidateCount;
  const results = await engine.generateCandidates({
    ...request, context: { ...expectedContext }, consent: { ...request.consent },
    sourcePixels: request.sourcePixels.slice(),
  }, signal);
  signal.throwIfAborted();
  if (results.length !== expectedCount || new Set(results.map((candidate) => candidate.id)).size !== expectedCount) {
    throw new Error("Face restoration must produce the requested distinct candidates for review.");
  }
  return Promise.all(results.map(async (candidate) => {
    validateCandidate(candidate);
    const firstRegion = results[0].region;
    if (!sameContext(candidate.context, expectedContext) || candidate.modelSha256 !== release.weightsSha256
      || candidate.region.x !== firstRegion.x || candidate.region.y !== firstRegion.y
      || candidate.region.width !== firstRegion.width || candidate.region.height !== firstRegion.height) {
      throw new Error("Face candidates must share the current image, approved model and reconstructed region.");
    }
    const snapshot = {
      ...candidate, context: { ...candidate.context }, region: { ...candidate.region },
      pixels: candidate.pixels.slice(), mask: candidate.mask.slice(),
    };
    const candidateSha256 = await faceCandidateSha256(snapshot);
    signal.throwIfAborted();
    return { ...snapshot, candidateSha256 };
  }));
}

/** Hash geometry, settings and every patch/mask byte. Review becomes stale on any change. */
export async function faceCandidateSha256(candidate: FaceDetailCandidate): Promise<string> {
  validateCandidate(candidate);
  const metadata = new TextEncoder().encode(JSON.stringify([
    "ipw-face-detail-candidate-v1", candidate.id,
    candidate.context.sourceSha256, candidate.context.baseOutputSha256,
    candidate.context.sourceWidth, candidate.context.sourceHeight,
    candidate.context.outputWidth, candidate.context.outputHeight,
    candidate.modelSha256, candidate.fidelity,
    candidate.region.x, candidate.region.y, candidate.region.width, candidate.region.height,
  ]));
  const bytes = new Uint8Array(metadata.length + candidate.pixels.length + candidate.mask.length);
  bytes.set(metadata);
  bytes.set(candidate.pixels, metadata.length);
  bytes.set(candidate.mask, metadata.length + candidate.pixels.length);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Pure pixel composition, for a future encoding worker. Never alters the base or source. */
export async function applyReviewedFaceCandidate(
  basePixels: Uint8ClampedArray,
  context: FaceDetailContext,
  candidate: FaceDetailCandidate,
  review: FaceDetailReview,
  release: Readonly<FaceModelRelease>,
) {
  const blockers = faceModelBlockers(release);
  if (blockers.length) throw new Error(`Face detail is unavailable. ${blockers.join(" ")}`);
  validateContext(context);
  validateCandidate(candidate);
  if (!(basePixels instanceof Uint8ClampedArray)
    || basePixels.length !== context.outputWidth * context.outputHeight * 4
    || !sameContext(context, candidate.context)) throw new Error("This face candidate belongs to a different image or output.");
  if (review?.allowReconstructedFaceDetail !== true || review.acknowledgedPossibleIdentityChange !== true
    || review.sourceSha256 !== context.sourceSha256 || review.baseOutputSha256 !== context.baseOutputSha256
    || candidate.modelSha256 !== release.weightsSha256) {
    throw new Error("Review and explicit identity-change acknowledgement are required for this candidate.");
  }
  // Copy before awaiting hashing so a stale/mutated worker buffer cannot change approved pixels.
  const snapshot = {
    ...candidate, context: { ...candidate.context }, region: { ...candidate.region },
    pixels: candidate.pixels.slice(), mask: candidate.mask.slice(),
  };
  const expectedContext = { ...context };
  const expectedReview = { ...review };
  const expectedRelease = { ...release };
  const output = basePixels.slice();
  const candidateSha256 = await faceCandidateSha256(snapshot);
  if (candidateSha256 !== expectedReview.candidateSha256) throw new Error("The face candidate changed after review. Review it again.");
  const { x, y, width, height } = snapshot.region;
  let changedPixels = 0;
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const patchIndex = row * width + column;
      const offset = ((y + row) * expectedContext.outputWidth + x + column) * 4;
      const weight = snapshot.mask[patchIndex] / 255;
      if (weight === 0 || output[offset + 3] === 0) continue;
      let changed = false;
      for (let channel = 0; channel < 3; channel += 1) {
        const prior = output[offset + channel];
        output[offset + channel] = prior + (snapshot.pixels[patchIndex * 4 + channel] - prior) * weight;
        changed ||= output[offset + channel] !== prior;
      }
      if (changed) changedPixels += 1;
      // Alpha always remains exactly the base alpha, including partly transparent pixels.
    }
  }
  if (!changedPixels) throw new Error("This candidate contains no visible pixel correction.");
  return {
    pixels: output,
    evidence: {
      kind: "explicit-face-recreate" as const,
      sourceSha256: expectedContext.sourceSha256,
      baseOutputSha256: expectedContext.baseOutputSha256,
      candidateSha256,
      modelSha256: snapshot.modelSha256,
      rightsEvidenceId: expectedRelease.rightsEvidenceId!,
      qualityEvidenceId: expectedRelease.qualityEvidenceId!,
      fidelity: snapshot.fidelity,
      changedPixels,
      outputRegion: { ...snapshot.region },
      sourceRegion: {
        x: x * expectedContext.sourceWidth / expectedContext.outputWidth,
        y: y * expectedContext.sourceHeight / expectedContext.outputHeight,
        width: width * expectedContext.sourceWidth / expectedContext.outputWidth,
        height: height * expectedContext.sourceHeight / expectedContext.outputHeight,
      },
      acknowledgedPossibleIdentityChange: true as const,
    },
  };
}
