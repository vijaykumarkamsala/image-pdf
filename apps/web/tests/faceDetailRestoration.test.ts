import assert from "node:assert/strict";
import test from "node:test";

import {
  FACE_DETAIL_RELEASE,
  applyReviewedFaceCandidate,
  faceCandidateSha256,
  faceModelBlockers,
  generateFaceDetailCandidates,
  validateFaceRestorationRequest,
  validateFaceCandidateForContext,
  type FaceDetailCandidate,
  type FaceDetailContext,
  type FaceDetailReview,
  type FaceModelRelease,
  type FaceRestorationEngine,
  type FaceRestorationRequest,
} from "../src/image-quality/faceDetailRestoration.ts";
import { deflateSync } from "node:zlib";
import { tagSrgbPng, type PngOutputMetadata } from "../src/image-quality/pngMetadata.ts";

// Test-only approval proof. Never registered in either runtime or a model licence register.
const approvedRelease: FaceModelRelease = {
  id: "synthetic-test-only", version: "1.0.0",
  weightsSha256: "c".repeat(64), dependencyLockSha256: "d".repeat(64),
  commercialRights: "approved", rightsEvidenceId: "test-only-rights",
  qualityReview: "approved", qualityEvidenceId: "test-only-quality",
};

function context(): FaceDetailContext {
  return {
    sourceSha256: "a".repeat(64), baseOutputSha256: "b".repeat(64),
    sourceWidth: 3, sourceHeight: 3, outputWidth: 6, outputHeight: 6,
  };
}

function basePixels() {
  const pixels = new Uint8ClampedArray(6 * 6 * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) pixels.set([20, 50, 100, 180], offset);
  return pixels;
}

function candidate(): FaceDetailCandidate {
  return {
    id: "test-candidate", context: context(), modelSha256: approvedRelease.weightsSha256!, fidelity: 0.8,
    region: { x: 2, y: 2, width: 2, height: 2 },
    pixels: new Uint8ClampedArray(Array.from({ length: 4 }, () => [170, 180, 190, 255]).flat()),
    mask: new Uint8Array([255, 0, 128, 255]),
  };
}

function request(): FaceRestorationRequest {
  return {
    context: context(), sourcePixels: new Uint8ClampedArray(3 * 3 * 4),
    consent: { sourceSha256: context().sourceSha256, allowReconstructedFaceDetail: true },
    fidelity: 0.8, candidateCount: 2,
  };
}

async function review(value: FaceDetailCandidate): Promise<FaceDetailReview> {
  return {
    sourceSha256: value.context.sourceSha256, baseOutputSha256: value.context.baseOutputSha256,
    candidateSha256: await faceCandidateSha256(value),
    allowReconstructedFaceDetail: true, acknowledgedPossibleIdentityChange: true,
  };
}

test("runtime has no approved face model and no environment-based licence bypass", () => {
  assert.equal(Object.isFrozen(FACE_DETAIL_RELEASE), true);
  assert.equal(faceModelBlockers(FACE_DETAIL_RELEASE).length, 3);
  assert.deepEqual(faceModelBlockers(approvedRelease), []);
  for (const release of [
    { ...approvedRelease, weightsSha256: null },
    { ...approvedRelease, dependencyLockSha256: "latest" },
    { ...approvedRelease, commercialRights: "pending" as const },
    { ...approvedRelease, rightsEvidenceId: " " },
    { ...approvedRelease, qualityReview: "rejected" as const },
    { ...approvedRelease, qualityEvidenceId: null },
  ]) assert.ok(faceModelBlockers(release).length > 0);
});

test("blocked model never invokes the candidate adapter", async () => {
  let calls = 0;
  const engine: FaceRestorationEngine = {
    release: FACE_DETAIL_RELEASE,
    async generateCandidates() { calls += 1; return []; }, dispose() {},
  };
  await assert.rejects(generateFaceDetailCandidates(engine, request(), new AbortController().signal), /unavailable/);
  assert.equal(calls, 0);
});

test("rendering boundary rejects wrong context/model and invalid regions before cropping pixels", () => {
  assert.doesNotThrow(() => validateFaceCandidateForContext(candidate(), context(), approvedRelease));
  for (const value of [
    { ...candidate(), modelSha256: "e".repeat(64) },
    { ...candidate(), context: { ...context(), baseOutputSha256: "e".repeat(64) } },
    { ...candidate(), region: { x: 5, y: 5, width: 2, height: 2 } },
  ]) assert.throws(() => validateFaceCandidateForContext(value, context(), approvedRelease));
  assert.throws(() => validateFaceCandidateForContext(candidate(), context(), FACE_DETAIL_RELEASE), /unavailable/);
});

test("reviewed PNG embeds exact AI-region evidence and rejects undisclosed/unreviewed reconstruction", async () => {
  const value = candidate();
  const composed = await applyReviewedFaceCandidate(basePixels(), context(), value, await review(value), approvedRelease);
  // Generated rights-free opaque fixture. tagSrgbPng validates framing/proof, not model approval.
  const part = (type: string, data: Buffer) => {
    const result = Buffer.alloc(12 + data.length);
    result.writeUInt32BE(data.length, 0); result.write(type, 4, "ascii"); data.copy(result, 8);
    let crc = 0xffffffff;
    for (const byte of result.subarray(4, 8 + data.length)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8);
    return result;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(6); header.writeUInt32BE(6, 4); header.set([8, 6, 0, 0, 0], 8);
  const bytes = new Uint8Array(Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), part("IHDR", header),
    part("IDAT", deflateSync(Buffer.alloc(6 * (6 * 4 + 1)))), part("IEND", Buffer.alloc(0))]));
  const metadata: PngOutputMetadata = {
    sourceSha256: context().sourceSha256, engineId: approvedRelease.id, engineVersion: approvedRelease.version,
    route: "explicit-reviewed-face-recreate", strength: 100, scale: 2, modelSha256: approvedRelease.weightsSha256,
    usage: "explicit-face-recreate", contentClass: "photograph", classificationConfidence: 0.8,
    outputWidth: 6, outputHeight: 6, faceRecreateEvidence: composed.evidence,
  };
  const tagged = Buffer.from(tagSrgbPng(bytes, metadata));
  assert.ok(tagged.includes(Buffer.from('"usage":"explicit-face-recreate"')));
  assert.ok(tagged.includes(Buffer.from(JSON.stringify(composed.evidence))));
  for (const invalid of [
    { ...metadata, faceRecreateEvidence: undefined },
    { ...metadata, usage: "deterministic" as const },
    { ...metadata, outputWidth: 7 },
    { ...metadata, sourceSha256: "f".repeat(64) },
    { ...metadata, faceRecreateEvidence: { ...composed.evidence, acknowledgedPossibleIdentityChange: false } as never },
    { ...metadata, faceRecreateEvidence: { ...composed.evidence, changedPixels: 0 } },
  ]) assert.throws(() => tagSrgbPng(bytes, invalid));
});

test("face request requires source-bound permission, decoded pixels and bounded candidate settings", () => {
  assert.doesNotThrow(() => validateFaceRestorationRequest(request(), approvedRelease));
  const invalidRequests: FaceRestorationRequest[] = [
    { ...request(), consent: { sourceSha256: "e".repeat(64), allowReconstructedFaceDetail: true } },
    { ...request(), consent: { sourceSha256: context().sourceSha256, allowReconstructedFaceDetail: false } as never },
    { ...request(), sourcePixels: new Uint8ClampedArray(4) },
    { ...request(), fidelity: NaN }, { ...request(), fidelity: -0.1 }, { ...request(), fidelity: 1.1 },
    { ...request(), candidateCount: 1 as never },
    { ...request(), context: { ...context(), outputWidth: 0 } },
    { ...request(), context: { ...context(), sourceSha256: "not-a-hash" } },
  ];
  for (const invalid of invalidRequests) assert.throws(() => validateFaceRestorationRequest(invalid, approvedRelease));
});

test("candidate hashing binds pixels, mask, geometry, fidelity, original and base output", async () => {
  const originalHash = await faceCandidateSha256(candidate());
  const changes: Array<(value: FaceDetailCandidate) => void> = [
    (value) => { value.pixels[0] += 1; }, (value) => { value.mask[0] -= 1; },
    (value) => { value.region.x += 1; }, (value) => { value.fidelity -= 0.1; },
    (value) => { value.context.sourceSha256 = "e".repeat(64); },
    (value) => { value.context.baseOutputSha256 = "f".repeat(64); },
    (value) => { value.modelSha256 = "e".repeat(64); },
    (value) => { value.context.sourceWidth += 1; value.context.sourceHeight += 1; },
  ];
  for (const change of changes) {
    const value = candidate(); change(value);
    assert.notEqual(await faceCandidateSha256(value), originalHash);
  }
});

test("reviewed patch changes real pixels but preserves base, alpha, masked pixels and all outside pixels exactly", async () => {
  const base = basePixels(); const before = base.slice(); const value = candidate(); const patchBefore = value.pixels.slice();
  const result = await applyReviewedFaceCandidate(base, context(), value, await review(value), approvedRelease);
  assert.deepEqual(base, before); assert.deepEqual(value.pixels, patchBefore);
  assert.equal(result.pixels.length, base.length); assert.notDeepEqual(result.pixels, base);
  for (let y = 0; y < 6; y += 1) for (let x = 0; x < 6; x += 1) {
    const offset = (y * 6 + x) * 4;
    assert.equal(result.pixels[offset + 3], base[offset + 3]);
    if (x < 2 || x > 3 || y < 2 || y > 3 || (x === 3 && y === 2)) {
      assert.deepEqual(result.pixels.slice(offset, offset + 4), base.slice(offset, offset + 4));
    }
  }
  assert.deepEqual(result.pixels.slice((2 * 6 + 2) * 4, (2 * 6 + 2) * 4 + 3), new Uint8ClampedArray([170, 180, 190]));
  assert.equal(result.evidence.changedPixels, 3);
  assert.deepEqual(result.evidence.outputRegion, value.region);
  assert.deepEqual(result.evidence.sourceRegion, { x: 1, y: 1, width: 1, height: 1 });
  assert.equal(result.evidence.kind, "explicit-face-recreate");
});

test("transparent base pixels and their hidden RGB remain untouched", async () => {
  const base = basePixels(); const value = candidate(); const offset = (2 * 6 + 2) * 4;
  base[offset + 3] = 0;
  const result = await applyReviewedFaceCandidate(base, context(), value, await review(value), approvedRelease);
  assert.deepEqual(result.pixels.slice(offset, offset + 4), base.slice(offset, offset + 4));
  assert.equal(result.evidence.changedPixels, 2);
});

test("candidate edit after review is rejected without damaging the previous result", async () => {
  const base = basePixels(); const before = base.slice(); const value = candidate(); const approval = await review(value);
  value.pixels[0] -= 1;
  await assert.rejects(applyReviewedFaceCandidate(base, context(), value, approval, approvedRelease), /changed after review/);
  assert.deepEqual(base, before);
});

test("review cannot transfer across originals, base derivatives, model weights or resized outputs", async () => {
  const value = candidate(); const approval = await review(value);
  for (const changedContext of [
    { ...context(), sourceSha256: "e".repeat(64) }, { ...context(), baseOutputSha256: "e".repeat(64) },
    { ...context(), sourceWidth: 4, sourceHeight: 4 },
  ]) await assert.rejects(applyReviewedFaceCandidate(basePixels(), changedContext, value, approval, approvedRelease), /different image/);
  await assert.rejects(applyReviewedFaceCandidate(basePixels(), context(), value, approval, {
    ...approvedRelease, weightsSha256: "e".repeat(64),
  }), /acknowledgement/);
  await assert.rejects(applyReviewedFaceCandidate(basePixels(), { ...context(), outputWidth: 7 }, value, approval, approvedRelease), /framing/);
});

test("approval must explicitly acknowledge possible identity change, never just enhancement success", async () => {
  const value = candidate(); const approval = await review(value);
  await assert.rejects(applyReviewedFaceCandidate(basePixels(), context(), value, {
    ...approval, acknowledgedPossibleIdentityChange: false,
  } as never, approvedRelease), /acknowledgement/);
  await assert.rejects(applyReviewedFaceCandidate(basePixels(), context(), value, {
    ...approval, allowReconstructedFaceDetail: false,
  } as never, approvedRelease), /acknowledgement/);
  await assert.rejects(applyReviewedFaceCandidate(basePixels(), context(), value, approval, FACE_DETAIL_RELEASE), /unavailable/);
});

test("invalid/outside patches, incomplete masks and no-op candidates do not become enhancement success", async () => {
  for (const region of [
    { x: -1, y: 2, width: 2, height: 2 }, { x: 5, y: 2, width: 2, height: 2 },
    { x: 2.5, y: 2, width: 2, height: 2 }, { x: 2, y: 2, width: 0, height: 2 },
  ]) await assert.rejects(faceCandidateSha256({ ...candidate(), region }), /region/);
  await assert.rejects(faceCandidateSha256({ ...candidate(), mask: new Uint8Array(1) }), /region/);
  const value = candidate(); value.mask.fill(0);
  await assert.rejects(applyReviewedFaceCandidate(basePixels(), context(), value, await review(value), approvedRelease), /no visible pixel/);
});

test("composition uses a snapshot of reviewed bytes, context and proof across async hashing", async () => {
  const value = candidate(); const approval = await review(value); const base = basePixels();
  const currentContext = context(); const release = { ...approvedRelease };
  const expected = await applyReviewedFaceCandidate(base, currentContext, value, approval, release);
  const pending = applyReviewedFaceCandidate(base, currentContext, value, approval, release);
  value.pixels.fill(0); value.mask.fill(0); value.region.x = 0; base.fill(0);
  currentContext.outputWidth = 1; approval.candidateSha256 = "e".repeat(64); release.rightsEvidenceId = "changed";
  assert.deepEqual(await pending, expected);
});

test("candidate adapter gets isolated source pixels and returns hash-bound review proposals only", async () => {
  const input = request(); const sourceBefore = input.sourcePixels.slice();
  const engine: FaceRestorationEngine = {
    release: approvedRelease,
    async generateCandidates(incoming) {
      incoming.sourcePixels.fill(255);
      return [candidate(), { ...candidate(), id: "second-candidate", fidelity: 0.9 }];
    }, dispose() {},
  };
  const results = await generateFaceDetailCandidates(engine, input, new AbortController().signal);
  assert.equal(results.length, 2); assert.deepEqual(input.sourcePixels, sourceBefore);
  for (const result of results) assert.equal(result.candidateSha256, await faceCandidateSha256(result));
});

test("cancelled, missing, stale or wrong-model candidate sets are never shown as reviewable", async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const engine: FaceRestorationEngine = {
    release: approvedRelease, async generateCandidates() { calls += 1; return []; }, dispose() {},
  };
  await assert.rejects(generateFaceDetailCandidates(engine, request(), controller.signal), /abort/i);
  assert.equal(calls, 0);
  for (const results of [
    [], [candidate()], [candidate(), candidate()],
    [candidate(), { ...candidate(), id: "second", modelSha256: "e".repeat(64) }],
    [candidate(), { ...candidate(), id: "second", context: { ...context(), sourceSha256: "e".repeat(64) } }],
    [candidate(), { ...candidate(), id: "second", region: { x: 1, y: 2, width: 2, height: 2 } }],
  ]) await assert.rejects(generateFaceDetailCandidates({
    ...engine, async generateCandidates() { return results; },
  }, request(), new AbortController().signal));
  const running = new AbortController();
  await assert.rejects(generateFaceDetailCandidates({
    ...engine, async generateCandidates() { running.abort(); return [candidate(), { ...candidate(), id: "second" }]; },
  }, request(), running.signal), /abort/i);
});
