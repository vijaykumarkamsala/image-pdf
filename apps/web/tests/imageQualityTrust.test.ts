import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { selectImageQualityEngine } from "../src/image-quality/enginePortfolio.ts";
import { inspectImageFile, inspectImageHeaderBytes } from "../src/image-quality/imageFileInspection.ts";
import { candidateEvidencePasses, validateEvidenceAsset } from "../src/image-quality/imageQualityEvidence.ts";
import {
  blindReviewPasses,
  createBlindReviewAssignment,
  measurePairedQuality,
  type BlindQualityReview,
} from "../src/image-quality/imageQualityEvaluation.ts";
import { measureCoordinateMatchedFidelity } from "../src/image-quality/imageQualityFidelity.ts";
import { planImageQualityTiles } from "../src/image-quality/imageQualityTiling.ts";
import {
  classifyImageContent,
  planRequestedScale,
  processingBudget,
} from "../src/image-quality/imageQualityPolicy.ts";
import { assertPngDimensions, pngOutputSha256, tagSrgbPng } from "../src/image-quality/pngMetadata.ts";
import { sha256Blob, sha256Bytes } from "../src/image-quality/sha256.ts";
import { clampViewerPan } from "../src/image-quality/viewerGeometry.ts";

const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];

function chunk(type: string, data: Uint8Array) {
  const output = new Uint8Array(data.length + 12);
  new DataView(output.buffer).setUint32(0, data.length);
  output.set(new TextEncoder().encode(type), 4);
  output.set(data, 8);
  let crc = 0xffffffff;
  for (const value of output.subarray(4, 8 + data.length)) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  new DataView(output.buffer).setUint32(8 + data.length, (crc ^ 0xffffffff) >>> 0);
  return output;
}

function pngChunks(bytes: Uint8Array) {
  const chunks: Array<{ type: string; crcValid: boolean }> = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const end = offset + length + 12;
    let crc = 0xffffffff;
    for (const value of bytes.subarray(offset + 4, offset + 8 + length)) {
      crc ^= value;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    chunks.push({ type, crcValid: view.getUint32(offset + 8 + length) === ((crc ^ 0xffffffff) >>> 0) });
    offset = end;
    if (type === "IEND") break;
  }
  return chunks;
}

function concat(...parts: Uint8Array[]) {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function pngHeader(width = 320, height = 240, colourType = 6) {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([8, colourType, 0, 0, 0], 8);
  return concat(new Uint8Array(pngSignature), chunk("IHDR", ihdr));
}

function pngStructure(width = 320, height = 240, colourType = 6, ...metadata: Uint8Array[]) {
  return concat(
    pngHeader(width, height, colourType),
    ...metadata,
    chunk("IDAT", new Uint8Array([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])),
    chunk("IEND", new Uint8Array()),
  );
}

test("streaming SHA-256 matches the standard vector without Web Crypto buffering", async () => {
  const bytes = new TextEncoder().encode("abc");
  const expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  assert.equal(sha256Bytes(bytes), expected);
  assert.equal(await sha256Blob(new Blob([bytes])), expected);
});

test("streaming SHA-256 stays correct across many input chunks", async () => {
  const bytes = new Uint8Array(1_000_003);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 31 + 17) & 0xff;
  const expected = createHash("sha256").update(bytes).digest("hex");
  assert.equal(await sha256Blob(new Blob([bytes])), expected);
});

test("header inspection trusts PNG bytes rather than a claimed filename or MIME type", () => {
  const inspection = inspectImageHeaderBytes(pngStructure(640, 480, 6));
  assert.equal(inspection.mediaType, "image/png");
  assert.equal(inspection.width, 640);
  assert.equal(inspection.height, 480);
  assert.equal(inspection.hasAlpha, true);
  assert.throws(
    () => inspectImageHeaderBytes(concat(pngHeader(), chunk("IEND", new Uint8Array()))),
    /image data marker/i,
  );
});

test("PNG colour, density and transparency metadata are inspected before decode", () => {
  const density = new Uint8Array(9);
  new DataView(density.buffer).setUint32(0, 3_780);
  new DataView(density.buffer).setUint32(4, 3_780);
  density[8] = 1;
  const inspection = inspectImageHeaderBytes(pngStructure(
    300,
    200,
    2,
    chunk("iCCP", new Uint8Array([115, 82, 71, 66, 0, 0])),
    chunk("tRNS", new Uint8Array([0, 0, 0, 0, 0, 0])),
    chunk("pHYs", density),
  ));
  assert.equal(inspection.hasIccProfile, true);
  assert.equal(inspection.hasAlpha, true);
  assert.deepEqual(inspection.physicalPixelDensity, { xPixelsPerMetre: 3_780, yPixelsPerMetre: 3_780 });
});

test("a false MIME claim is recorded but does not override verified PNG bytes", async () => {
  const inspection = await inspectImageFile(new Blob([pngStructure()], { type: "image/jpeg" }));
  assert.equal(inspection.mediaType, "image/png");
  assert.match(inspection.warnings[0], /did not match/);
});

test("header inspection reads JPEG dimensions and rejects disguised content", () => {
  const jpeg = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11,
    0x08, 0x01, 0xe0, 0x02, 0x80, 0x03,
    0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9,
  ]);
  const inspection = inspectImageHeaderBytes(jpeg);
  assert.equal(inspection.mediaType, "image/jpeg");
  assert.deepEqual([inspection.width, inspection.height], [640, 480]);
  assert.throws(() => inspectImageHeaderBytes(new TextEncoder().encode("<script>not an image</script>")), /file signature/i);
});

test("JPEG EXIF orientation and possible GPS data are disclosed before decode", () => {
  const exif = new Uint8Array(6 + 8 + 2 + 24 + 4);
  exif.set(new TextEncoder().encode("Exif\0\0"), 0);
  exif.set([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00], 6);
  const view = new DataView(exif.buffer);
  view.setUint16(14, 2, true);
  view.setUint16(16, 0x0112, true);
  view.setUint16(18, 3, true);
  view.setUint32(20, 1, true);
  view.setUint16(24, 6, true);
  view.setUint16(28, 0x8825, true);
  view.setUint16(30, 4, true);
  view.setUint32(32, 1, true);
  const app1 = new Uint8Array(exif.length + 4);
  app1.set([0xff, 0xe1], 0);
  new DataView(app1.buffer).setUint16(2, exif.length + 2);
  app1.set(exif, 4);
  const dimensions = new Uint8Array([
    0xff, 0xc0, 0x00, 0x11,
    0x08, 0x01, 0xe0, 0x02, 0x80, 0x03,
    0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  ]);
  const inspection = inspectImageHeaderBytes(concat(new Uint8Array([0xff, 0xd8]), app1, dimensions, new Uint8Array([0xff, 0xd9])));
  assert.equal(inspection.orientation, 6);
  assert.equal(inspection.mayContainGps, true);
});

test("animated PNG is detected before browser decode can flatten it", () => {
  const animation = new Uint8Array(8);
  new DataView(animation.buffer).setUint32(0, 3);
  const inspection = inspectImageHeaderBytes(pngStructure(320, 240, 6, chunk("acTL", animation)));
  assert.equal(inspection.animated, true);
  assert.equal(inspection.frameCount, 3);
});

test("extended WebP dimensions, alpha, ICC, EXIF and animation flags are inspected", () => {
  const vp8x = new Uint8Array(10);
  vp8x[0] = 0x20 | 0x10 | 0x08 | 0x02;
  vp8x.set([0x7f, 0x02, 0], 4); // 640 - 1
  vp8x.set([0xdf, 0x01, 0], 7); // 480 - 1
  const body = new Uint8Array(18);
  body.set(new TextEncoder().encode("VP8X"), 0);
  new DataView(body.buffer).setUint32(4, vp8x.length, true);
  body.set(vp8x, 8);
  const riff = concat(
    new TextEncoder().encode("RIFF"),
    new Uint8Array(4),
    new TextEncoder().encode("WEBP"),
    body,
  );
  new DataView(riff.buffer).setUint32(4, riff.length - 8, true);
  const inspection = inspectImageHeaderBytes(riff);
  assert.deepEqual([inspection.width, inspection.height], [640, 480]);
  assert.equal(inspection.hasAlpha, true);
  assert.equal(inspection.hasIccProfile, true);
  assert.equal(inspection.hasExif, true);
  assert.equal(inspection.animated, true);
});

test("processed PNG is tagged as sRGB and carries source-bound provenance", () => {
  const source = concat(pngHeader(4, 4), chunk("sRGB", new Uint8Array([2])), chunk("IEND", new Uint8Array()));
  const tagged = tagSrgbPng(source, {
    sourceSha256: "a".repeat(64),
    engineId: "engine",
    engineVersion: "1.2.3",
    route: "photograph-deterministic-x2",
    strength: 65,
    scale: 2,
    modelSha256: null,
    usage: "deterministic",
    contentClass: "photograph",
    classificationConfidence: 0.91,
    outputWidth: 4,
    outputHeight: 4,
    xPixelsPerMetre: 3_780,
    yPixelsPerMetre: 3_780,
  });
  const text = new TextDecoder().decode(tagged);
  assert.match(text, /sRGB/);
  assert.match(text, /gAMA/);
  assert.match(text, /pHYs/);
  assert.match(text, /ImageQualityProvenance/);
  assert.match(text, /photograph-deterministic-x2/);
  assert.equal(pngOutputSha256(tagged).length, 64);
  const chunks = pngChunks(tagged);
  assert.ok(chunks.every((item) => item.crcValid));
  assert.equal(chunks.filter((item) => item.type === "sRGB").length, 1, "conflicting colour chunks are replaced, not duplicated");
});

test("download-boundary PNG inspection rejects dimensions that differ from the selected target", () => {
  const exact = pngStructure(2_636, 2_840, 6);
  assert.doesNotThrow(() => assertPngDimensions(exact, 2_636, 2_840));
  assert.throws(
    () => assertPngDimensions(pngStructure(1_900, 2_048, 6), 2_636, 2_840),
    /encoded PNG is 1900 × 2048 px instead of the required 2636 × 2840 px.*no mismatched download/i,
  );
});

test("content routing reports confidence and keeps accepted flat graphics deterministic", () => {
  const result = classifyImageContent({
    isFlatGraphic: true,
    dominantPaletteFraction: 0.98,
    flatNeighbourFraction: 0.97,
    quantizedColours: 12,
  }, { noiseLevel: 0.01, edgeDefinition: 0.8, tonalRange: 0.7, colourCast: 0.02 });
  assert.equal(result.contentClass, "flat-graphic");
  assert.ok(result.confidence > 0.9);
});

test("production selects only the approved neural model while research weights stay quarantined", () => {
  const production = selectImageQualityEngine({ contentClass: "photograph", purpose: "production", webGpuAvailable: true });
  const research = selectImageQualityEngine({ contentClass: "photograph", purpose: "local-research", webGpuAvailable: true });
  const protectedGraphic = selectImageQualityEngine({ contentClass: "flat-graphic", purpose: "production", webGpuAvailable: true });
  assert.equal(production.id, "public-realplksr-2x");
  assert.ok(production.permittedPurposes.includes("production"));
  assert.equal(production.weightsSha256, "4c5c658893c927af11238d4aa767a7cb0bfcae773b98a7da3a6c486efa024f5f");
  assert.equal(research.id, "realesr-general-x4v3-local-research");
  assert.equal(research.implementation, "neural");
  assert.ok(research.weightsSha256);
  assert.equal(protectedGraphic.implementation, "deterministic");
  assert.equal(protectedGraphic.weightsSha256, null);
});

test("2× and 4× scale planning is exact and never silently clamps", () => {
  const budget = processingBudget(8);
  const double = planRequestedScale(960, 1_114, 2, budget);
  const quadruple = planRequestedScale(2_048, 2_048, 4, budget);
  assert.equal(double.scale, 2);
  assert.equal(double.estimatedOutputBytes, 1_920 * 2_228 * 4);
  assert.equal(quadruple.scale, 4);
  assert.equal(quadruple.estimatedOutputBytes, 8_192 * 8_192 * 4);
  assert.match(quadruple.rationale, /exact requested dimensions/i);
  assert.ok(budget.sourcePixels <= budget.outputPixels);
});

test("an over-budget 4× request fails visibly instead of returning 2× or 1×", () => {
  const budget = processingBudget(8);
  assert.doesNotThrow(() => planRequestedScale(5_000, 3_000, 2, budget));
  assert.throws(
    () => planRequestedScale(5_000, 3_000, 4, budget),
    (error: unknown) => error instanceof Error
      && /requested 4× output requires 20000 × 12000 px/i.test(error.message)
      && /No smaller output was created/i.test(error.message),
  );
});

test("tile planning covers every source pixel exactly once, including uneven edges", () => {
  const width = 257;
  const height = 223;
  const coverage = new Uint8Array(width * height);
  const tiles = planImageQualityTiles(width, height, 108);
  for (const tile of tiles) {
    assert.ok(tile.width > 0 && tile.height > 0);
    for (let y = tile.top; y < tile.top + tile.height; y += 1) {
      for (let x = tile.left; x < tile.left + tile.width; x += 1) coverage[y * width + x] += 1;
    }
  }
  assert.ok(coverage.every((value) => value === 1), "no gaps or overlapping core pixels may create seams");
});

test("fidelity gate rejects repainting of protected low-texture regions and alpha", () => {
  const source = new Uint8ClampedArray(16 * 16 * 4);
  const repainted = new Uint8ClampedArray(source.length);
  for (let offset = 0; offset < source.length; offset += 4) {
    source.set([220, 210, 200, 255], offset);
    repainted.set([245, 245, 245, 180], offset);
  }
  const evidence = measureCoordinateMatchedFidelity(source, repainted, 16, 16);
  assert.equal(evidence.passed, false);
  assert.ok(evidence.lowTextureMeanRgbShift > 12);
  assert.ok(evidence.alphaMismatchFraction > 0.9);
});

test("fidelity gate permits sub-pixel alpha coverage only at the original contour", () => {
  const width = 12;
  const height = 12;
  const source = new Uint8ClampedArray(width * height * 4);
  const antialiased = new Uint8ClampedArray(source.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const alpha = x >= 4 && x <= 8 && y >= 3 && y <= 9 ? 255 : 0;
      source.set([20, 100, 220, alpha], offset);
      antialiased.set([20, 100, 220, alpha], offset);
      if ((x === 3 || x === 9) && y >= 3 && y <= 9) antialiased[offset + 3] = 96;
    }
  }
  const allowed = measureCoordinateMatchedFidelity(source, antialiased, width, height);
  assert.equal(allowed.passed, true);
  assert.equal(allowed.alphaMismatchFraction, 0);

  const opaqueLeak = new Uint8ClampedArray(antialiased);
  for (let y = 0; y < height; y += 1) opaqueLeak[(y * width + 0) * 4 + 3] = 255;
  const rejected = measureCoordinateMatchedFidelity(source, opaqueLeak, width, height);
  assert.equal(rejected.passed, false);
  assert.ok(rejected.alphaMismatchFraction > 0.08);
});

test("pan is bounded and stays centred when an image fits the viewer", () => {
  assert.deepEqual(clampViewerPan({ frameWidth: 800, frameHeight: 600, imageWidth: 400, imageHeight: 300, scale: 1 }, { x: 99, y: -99 }), { x: 0, y: 0 });
  assert.deepEqual(clampViewerPan({ frameWidth: 800, frameHeight: 600, imageWidth: 800, imageHeight: 600, scale: 2 }, { x: 999, y: -999 }), { x: 400, y: -300 });
});

test("paired metrics and blind review gates cannot hide invented content", () => {
  const reference = new Uint8ClampedArray([
    10, 20, 30, 255, 40, 50, 60, 255,
    70, 80, 90, 255, 100, 110, 120, 255,
  ]);
  const exact = measurePairedQuality(reference, new Uint8ClampedArray(reference), 2, 2);
  assert.equal(exact.psnrDb, Number.POSITIVE_INFINITY);
  assert.equal(exact.structuralSimilarity, 1);
  assert.deepEqual(
    createBlindReviewAssignment("asset-1", "candidate-1"),
    createBlindReviewAssignment("asset-1", "candidate-1"),
  );
  assert.equal(blindReviewPasses({
    assignmentId: "asset-1:candidate-1",
    reviewerId: "reviewer-1",
    candidateSide: "right",
    winner: "right",
    detail: 5,
    naturalness: 5,
    colourFidelity: 5,
    hasHalo: false,
    hasInventedContent: true,
    hasIdentityOrTextChange: false,
  }), false);
  assert.equal(blindReviewPasses({
    assignmentId: "asset-1:candidate-1",
    reviewerId: "reviewer-2",
    candidateSide: "left",
    winner: "left",
    detail: 5,
    naturalness: 5,
    colourFidelity: 5,
    hasHalo: true,
    hasInventedContent: false,
    hasIdentityOrTextChange: false,
  }), false);
});

test("private evidence is blocked until provenance, permission and human review are complete", () => {
  assert.ok(validateEvidenceAsset({
    assetId: "animal-example",
    sourceSha256: "a".repeat(64),
    category: "soft_illustration",
    owner: "",
    licenceOrPermission: "",
    permittedBenchmarkUse: false,
    publicDemoPermitted: false,
    containsPeople: false,
    containsSensitiveInformation: false,
  }).length >= 3);
  assert.equal(candidateEvidencePasses({
    assetId: "animal-example",
    sourceSha256: "a".repeat(64),
    outputSha256: "b".repeat(64),
    engineId: "engine",
    engineVersion: "1",
    route: "illustration",
    strength: 100,
    fidelity: { lowTextureMeanRgbShift: 1, highDriftFraction: 0, alphaMismatchFraction: 0, overallMeanRgbDifference: 4, passed: true },
    blindReviews: [],
  }), false);

  const review = (reviewerId: string, winner: "left" | "right" | "tie"): BlindQualityReview => ({
    assignmentId: "animal-example:candidate-1",
    reviewerId,
    candidateSide: "right",
    winner,
    detail: 4,
    naturalness: 4,
    colourFidelity: 4,
    hasHalo: false,
    hasInventedContent: false,
    hasIdentityOrTextChange: false,
  });
  const candidate = {
    assetId: "animal-example",
    sourceSha256: "a".repeat(64),
    outputSha256: "b".repeat(64),
    engineId: "engine",
    engineVersion: "1",
    route: "illustration",
    strength: 100,
    fidelity: { lowTextureMeanRgbShift: 1, highDriftFraction: 0, alphaMismatchFraction: 0, overallMeanRgbDifference: 4, passed: true },
    blindReviews: [review("reviewer-1", "right"), review("reviewer-2", "right"), review("reviewer-3", "tie")],
  };
  assert.equal(candidateEvidencePasses(candidate), true);
  assert.equal(candidateEvidencePasses({
    ...candidate,
    blindReviews: [review("same-reviewer", "right"), review("same-reviewer", "right"), review("same-reviewer", "right")],
  }), false);
});
