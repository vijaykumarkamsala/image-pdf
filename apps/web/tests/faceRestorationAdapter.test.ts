import assert from "node:assert/strict";
import test from "node:test";
import {
  FACE_TEMPLATE, alignedFacePixels, decodeYuNet, faceCandidateFidelities, faceDetectionWindows, faceDetectorTensor,
  faceSimilarityTransform, inverseAlignedFacePatch, inverseFaceTransform, suppressDuplicateFaces,
  transformFacePoint, validatedFaceAlignment, type FacePoint,
} from "../src/image-quality/faceRestorationGeometry.ts";
import { faceInferenceManifestBytes, validateFaceInferenceAssets, YUNET_ARTIFACT, type FaceInferenceAssets } from "../src/image-quality/faceRestorationAssets.ts";
import { FACE_DETAIL_RELEASE, type FaceModelRelease } from "../src/image-quality/faceDetailRestoration.ts";
import { WorkerFaceRestorationEngine } from "../src/image-quality/WorkerFaceRestorationEngine.ts";
import { sha256Bytes } from "../src/image-quality/sha256.ts";

test("five-point alignment uses only uniform scale/rotation and round-trips source coordinates", () => {
  const points = FACE_TEMPLATE.map(([x, y]): FacePoint => [y * 0.25 + 20, -x * 0.25 + 200]);
  const transform = faceSimilarityTransform(points), inverse = inverseFaceTransform(transform);
  for (let i = 0; i < 5; i += 1) {
    const mapped = transformFacePoint(transform, ...points[i]);
    assert.ok(Math.hypot(mapped[0] - FACE_TEMPLATE[i][0], mapped[1] - FACE_TEMPLATE[i][1]) < 1e-9);
    const original = transformFacePoint(inverse, ...mapped);
    assert.ok(Math.hypot(original[0] - points[i][0], original[1] - points[i][1]) < 1e-9);
  }
});

test("every valid fidelity including both endpoints yields distinct bounded candidate settings", () => {
  for (const count of [2, 3] as const) for (const fidelity of [0, 0.01, 0.2, 0.8, 0.99, 1]) {
    const values = faceCandidateFidelities(fidelity, count);
    assert.equal(values.length, count); assert.equal(new Set(values).size, count);
    assert.ok(values.every((value) => value >= 0 && value <= 1));
  }
  assert.throws(() => faceCandidateFidelities(NaN, 3));
  assert.throws(() => faceCandidateFidelities(1.1, 3));
});

test("uncertain, tiny, coincident and non-finite landmarks fail closed", () => {
  for (const points of [[], Array.from({ length: 5 }, (): FacePoint => [0, 0]), FACE_TEMPLATE.map(([x, y]): FacePoint => [NaN, y])]) assert.throws(() => faceSimilarityTransform(points));
  const base = { box: { x: 0, y: 0, width: 512, height: 512 }, confidence: 0.99 };
  assert.throws(() => validatedFaceAlignment({ ...base, landmarks: FACE_TEMPLATE.map(([x, y]): FacePoint => [x / 100, y / 100]) }), /too small/);
  assert.throws(() => validatedFaceAlignment({ ...base, landmarks: FACE_TEMPLATE.map(([x, y], i): FacePoint => [x + (i === 2 ? 150 : 0), y]) }), /uncertain/);
});

test("detector plan covers the complete portrait and rejects unsafe scans before allocating tiles", () => {
  const windows = faceDetectionWindows(1290, 2796);
  assert.equal(windows.length, 19);
  assert.deepEqual(windows[0], { x: 0, y: 0, width: 1290, height: 2796 });
  assert.ok(windows.some((w) => w.x + w.width === 1290 && w.y + w.height === 2796));
  assert.equal(faceDetectionWindows(320, 320).length, 1);
  assert.throws(() => faceDetectionWindows(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), /server-side/);
  assert.throws(() => faceDetectionWindows(0, 640), /Invalid/);
});

test("detector receives decoded BGR source data with letterbox padding, without mutating pixels", () => {
  const pixels = new Uint8ClampedArray(8 * 4 * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set([20, 50, 100, 255], i);
  const before = pixels.slice();
  const { data, scale } = faceDetectorTensor(pixels, 8, 4, { x: 0, y: 0, width: 8, height: 4 });
  assert.equal(scale, 80); assert.equal(data[0], 100); assert.equal(data[640 * 640], 50); assert.equal(data[2 * 640 * 640], 20);
  assert.equal(data[400 * 640], 0); assert.deepEqual(pixels, before);
  assert.throws(() => faceDetectorTensor(pixels, 8, 4, { x: 0, y: 0, width: 0, height: 4 }));
});

function heads() {
  const values: Record<string, Float32Array> = {};
  for (const stride of [8, 16, 32]) for (const [name, channels] of [["cls", 1], ["obj", 1], ["bbox", 4], ["kps", 10]] as const) values[`${name}_${stride}`] = new Float32Array((640 / stride) ** 2 * channels);
  return values;
}

test("YuNet heads decode into source coordinates with explicit eye/nose/mouth ordering", () => {
  const outputs = heads(), i = 20 * 80 + 20;
  outputs.cls_8[i] = outputs.obj_8[i] = 1;
  outputs.bbox_8.set([0, 0, Math.log(4), Math.log(4)], i * 4);
  outputs.kps_8.set([-1, -1, 1, -1, 0, 0, -1, 1, 1, 1], i * 10);
  const faces = decodeYuNet(outputs, { x: 100, y: 200, width: 640, height: 640 });
  assert.equal(faces.length, 1); assert.ok(Math.abs(faces[0].box.width - 32) < 1e-5);
  assert.deepEqual(faces[0].landmarks, [[252, 352], [268, 352], [260, 360], [252, 368], [268, 368]]);
  assert.equal(suppressDuplicateFaces([faces[0], { ...faces[0], confidence: 0.9 }]).length, 1);
  assert.equal(suppressDuplicateFaces([faces[0], { ...faces[0], box: { ...faces[0].box, x: 500 } }]).length, 2);
});

test("missing, non-finite or incorrectly shaped detector heads cannot create candidates", () => {
  assert.throws(() => decodeYuNet({}, { x: 0, y: 0, width: 640, height: 640 }), /invalid prediction/);
  const outputs = heads(); outputs.cls_8[0] = NaN;
  assert.throws(() => decodeYuNet(outputs, { x: 0, y: 0, width: 640, height: 640 }), /invalid prediction/);
});

test("inverse-aligned masks preserve source framing at native and four-times output scales", () => {
  const pixels = new Uint8ClampedArray(512 * 512 * 4);
  for (let y = 0; y < 512; y += 1) for (let x = 0; x < 512; x += 1) pixels.set([x % 256, y % 256, 90, 255], (y * 512 + x) * 4);
  assert.deepEqual(alignedFacePixels(pixels, 512, 512, [1, 0, 0, 0]), pixels);
  const before = pixels.slice();
  for (const scale of [1, 4]) {
    const patch = inverseAlignedFacePatch(pixels, [1, 0, 0, 0], 512 * scale, 512 * scale, scale);
    assert.equal(patch.pixels.length, patch.region.width * patch.region.height * 4);
    assert.ok(patch.mask.some((weight) => weight === 0)); assert.ok(patch.mask.some((weight) => weight === 255));
    assert.ok(patch.mask.some((weight) => weight > 0 && weight < 255));
    const ox = 200 * scale, oy = 300 * scale, index = (oy - patch.region.y) * patch.region.width + ox - patch.region.x;
    const sx = (ox + 0.5) / scale - 0.5, sy = (oy + 0.5) / scale - 0.5;
    assert.ok(Math.abs(patch.pixels[index * 4] - sx) <= 0.5);
    assert.ok(Math.abs(patch.pixels[index * 4 + 1] - (sy - 256)) <= 0.5);
    assert.equal(patch.mask[index], 255);
  }
  assert.deepEqual(pixels, before);
});

async function bundle() {
  const restorer = new Blob([new Uint8Array([1, 2, 3])]);
  const weightsSha256 = await sha256Bytes(new Uint8Array(await restorer.arrayBuffer()));
  const assets: FaceInferenceAssets = { detector: new Blob([new Uint8Array(YUNET_ARTIFACT.bytes)]), restorer,
    manifest: { runtime: "onnxruntime-web@1.29.0/wasm-single-thread", detector: { ...YUNET_ARTIFACT },
      restorer: { sha256: weightsSha256, bytes: 3, imageInput: "input", imageOutput: "output", fidelityInput: { name: "weight", type: "float32", dims: [] } } } };
  const release: FaceModelRelease = { id: "test-only", version: "1", weightsSha256,
    dependencyLockSha256: await sha256Bytes(faceInferenceManifestBytes(assets.manifest)),
    commercialRights: "approved", rightsEvidenceId: "test-only", qualityReview: "approved", qualityEvidenceId: "test-only" };
  return { assets, release };
}

test("an uncleared face model cannot construct the worker adapter", async () => {
  const { assets } = await bundle();
  assert.throws(() => new WorkerFaceRestorationEngine(FACE_DETAIL_RELEASE, assets), /unavailable/);
  await assert.rejects(validateFaceInferenceAssets(assets, FACE_DETAIL_RELEASE), /unavailable/);
});

test("bundle lock pins runtime, detector, restoration bytes and input contract", async () => {
  const { assets, release } = await bundle();
  await assert.rejects(validateFaceInferenceAssets(assets, release), /SHA-256/);
  const changed = structuredClone(assets); changed.manifest.restorer.fidelityInput.dims = [1];
  await assert.rejects(validateFaceInferenceAssets(changed, release), /bundle changed/);
  const corrupted = structuredClone(assets); corrupted.manifest.detector.sha256 = "a".repeat(64);
  await assert.rejects(validateFaceInferenceAssets(corrupted, release), /pinned runtime/);
  const runtime = structuredClone(assets); runtime.manifest.runtime = "wrong" as never;
  await assert.rejects(validateFaceInferenceAssets(runtime, release), /pinned runtime/);
});
