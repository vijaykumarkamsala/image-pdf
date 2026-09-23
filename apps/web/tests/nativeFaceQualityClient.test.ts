import assert from "node:assert/strict";
import test from "node:test";
import type {
  FaceQualityCandidateRequest,
  FaceQualityCapabilities,
  FaceQualityCompositionIntent,
  FaceQualityJobView,
} from "ipw-contracts-ts/product";

import {
  NativeFaceQualityCoordinator,
  type NativeFaceCommandResponse,
  type NativeFaceCandidateArtifact,
  type NativeFaceQualityTransport,
  type NativeFaceRemoteContext,
} from "../src/image-quality/NativeFaceQualityClient.ts";
import { nativeFaceMaskRgba, nativeFacePreviewRgba } from "../src/image-quality/nativeFacePreviewPixels.ts";

const sourceSha256 = "a".repeat(64);
const baseOutputSha256 = "b".repeat(64);
const context: NativeFaceRemoteContext = {
  uploadSessionId: "upload-native-face",
  baseImageQualityRequestId: "quality-native-face",
  sourceSha256,
  baseOutputSha256,
};

function job(
  state: FaceQualityJobView["state"],
  operation: FaceQualityJobView["operation"] = "candidates",
  progress = state === "succeeded" ? 100 : 0,
): FaceQualityJobView {
  return {
    contract_version: "image-quality-face-v1",
    face_quality_job_id: operation === "candidates" ? "face-candidates-001" : "face-compose-001",
    job_id: operation === "candidates" ? "job-candidates-001" : "job-compose-001",
    operation,
    state,
    progress_percent: progress,
    source_sha256: sourceSha256,
    base_output_sha256: baseOutputSha256,
    candidates: [],
    output_sha256: operation === "compose" && state === "succeeded" ? "c".repeat(64) : null,
    failure: state === "failed" ? { code: "worker-failed", message: "failed", retryable: true } : null,
    expires_at: "2030-01-02T00:00:00.000Z",
  };
}

class MemoryStorage implements Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

class Transport implements NativeFaceQualityTransport {
  readonly candidateIntents: Array<{ intent: FaceQualityCandidateRequest; key: string }> = [];
  readonly compositionIntents: Array<{ intent: FaceQualityCompositionIntent; key: string }> = [];
  readonly gets: string[] = [];
  states: FaceQualityJobView[] = [];

  async capabilities(): Promise<FaceQualityCapabilities> {
    return {
      contract_version: "image-quality-face-v1",
      available: false,
      native_still_renderer_implemented: true,
      native_jobs_integrated: true,
      native_animation_supported: true,
      supported_still_bit_depths: [8, 16],
      supported_animation_bit_depths: [8],
      preserves_base_alpha: true,
      blockers: ["face-model-unregistered"],
    };
  }
  async createCandidates(_upload: string, intent: FaceQualityCandidateRequest, _trace: string, key: string): Promise<NativeFaceCommandResponse> {
    this.candidateIntents.push({ intent, key });
    return { value: job("queued"), replayed: false };
  }
  async createComposition(_upload: string, intent: FaceQualityCompositionIntent, _trace: string, key: string): Promise<NativeFaceCommandResponse> {
    this.compositionIntents.push({ intent, key });
    return { value: job("queued", "compose"), replayed: false };
  }
  async get(_upload: string, jobId: string): Promise<FaceQualityJobView> {
    this.gets.push(jobId);
    const next = this.states.shift();
    if (!next) throw new Error("unexpected poll");
    return next;
  }
  async cancel(_upload: string, _jobId: string): Promise<FaceQualityJobView> { return job("cancelled"); }
  async retry(): Promise<NativeFaceCommandResponse> { return { value: job("queued"), replayed: false }; }
  downloadUrl(uploadId: string, jobId: string): string { return `/private/${uploadId}/${jobId}`; }
  async candidateArtifact(
    _upload: string,
    _job: string,
    _candidate: string,
    _kind: "pixels" | "mask",
  ): Promise<NativeFaceCandidateArtifact> { throw new Error("unexpected candidate artifact"); }
}

test("native candidate orchestration binds exact source/base intent, polls durable progress and retains resumable success", async () => {
  const transport = new Transport();
  transport.states = [job("running", "candidates", 45), job("succeeded")];
  const storage = new MemoryStorage();
  const progress: number[] = [];
  const coordinator = new NativeFaceQualityCoordinator(transport, storage, 0, () => Date.parse("2029-01-01"));
  const result = await coordinator.createCandidates(
    context,
    { fidelityPermyriad: 8000, candidateCount: 3 },
    new AbortController().signal,
    (value) => progress.push(value.progress_percent),
  );

  assert.equal(result.state, "succeeded");
  assert.deepEqual(progress, [0, 45, 100]);
  assert.deepEqual(transport.candidateIntents[0].intent, {
    contract_version: "image-quality-face-v1",
    base_image_quality_request_id: context.baseImageQualityRequestId,
    source_sha256: sourceSha256,
    base_output_sha256: baseOutputSha256,
    allow_reconstructed_face_detail: true,
    fidelity_permyriad: 8000,
    candidate_count: 3,
  });
  assert.match(transport.candidateIntents[0].key, /^face-candidates-[0-9a-f]{48}$/);
  assert.ok(transport.candidateIntents[0].key.length <= 64);
  const saved = [...storage.values.values()].map((value) => JSON.parse(value) as Record<string, unknown>)[0];
  assert.equal(saved["faceQualityJobId"], result.face_quality_job_id);
  assert.equal(saved["sourceSha256"], sourceSha256);
  assert.equal(JSON.stringify(saved).includes("allow_reconstructed_face_detail"), false);
});

test("recovery resumes only an unexpired job for the exact server-owned source and base", async () => {
  const transport = new Transport();
  transport.states = [job("succeeded")];
  const storage = new MemoryStorage();
  storage.setItem(`ipw-face-quality-active-v1-${context.baseImageQualityRequestId}-candidates`, JSON.stringify({
    version: 1,
    operation: "candidates",
    uploadSessionId: context.uploadSessionId,
    baseImageQualityRequestId: context.baseImageQualityRequestId,
    sourceSha256,
    baseOutputSha256,
    faceQualityJobId: "face-candidates-001",
    expiresAt: "2030-01-02T00:00:00.000Z",
  }));
  const coordinator = new NativeFaceQualityCoordinator(transport, storage, 0, () => Date.parse("2029-01-01"));

  assert.equal((await coordinator.recover(context, "candidates", new AbortController().signal))?.state, "succeeded");
  assert.deepEqual(transport.gets, ["face-candidates-001"]);

  const changed = { ...context, sourceSha256: "d".repeat(64) };
  assert.equal(await coordinator.recover(changed, "candidates", new AbortController().signal), null);
  assert.equal(storage.values.size, 0);
});

test("probing candidate recovery preserves a resumable composition job", async () => {
  const transport = new Transport();
  transport.states = [job("succeeded", "compose")];
  const storage = new MemoryStorage();
  storage.setItem(`ipw-face-quality-active-v1-${context.baseImageQualityRequestId}-compose`, JSON.stringify({
    version: 1,
    operation: "compose",
    uploadSessionId: context.uploadSessionId,
    baseImageQualityRequestId: context.baseImageQualityRequestId,
    sourceSha256,
    baseOutputSha256,
    faceQualityJobId: "face-compose-001",
    expiresAt: "2030-01-02T00:00:00.000Z",
  }));
  const coordinator = new NativeFaceQualityCoordinator(transport, storage, 0, () => Date.parse("2029-01-01"));

  assert.equal(await coordinator.recover(context, "candidates", new AbortController().signal), null);
  assert.equal(storage.values.size, 1);
  assert.equal((await coordinator.recover(context, "compose", new AbortController().signal))?.state, "succeeded");
  assert.deepEqual(transport.gets, ["face-compose-001"]);
});

test("failed and cancelled native work is removed from resumable browser state", async () => {
  const transport = new Transport();
  transport.states = [job("failed")];
  const storage = new MemoryStorage();
  const coordinator = new NativeFaceQualityCoordinator(transport, storage, 0, () => Date.parse("2029-01-01"));
  assert.equal((await coordinator.createCandidates(
    context,
    { fidelityPermyriad: 5000, candidateCount: 2 },
    new AbortController().signal,
  )).state, "failed");
  assert.equal(storage.values.size, 0);

  const cancelled = await coordinator.cancel(context, "face-candidates-001");
  assert.equal(cancelled.state, "cancelled");
  assert.equal(storage.values.size, 0);
});

test("an expired private job is cleared before another poll or download can occur", async () => {
  const transport = new Transport();
  const storage = new MemoryStorage();
  const coordinator = new NativeFaceQualityCoordinator(transport, storage, 0, () => Date.parse("2031-01-01"));
  await assert.rejects(
    coordinator.createCandidates(
      context,
      { fidelityPermyriad: 7000, candidateCount: 2 },
      new AbortController().signal,
    ),
    /expired/,
  );
  assert.equal(storage.values.size, 0);
  assert.equal(transport.gets.length, 0);
});

test("composition requires a reviewed candidate and exposes delivery only for exact succeeded compose work", async () => {
  const transport = new Transport();
  transport.states = [job("succeeded", "compose")];
  const storage = new MemoryStorage();
  storage.setItem(`ipw-face-quality-active-v1-${context.baseImageQualityRequestId}-candidates`, "retained-candidate-state");
  const coordinator = new NativeFaceQualityCoordinator(transport, storage, 0, () => Date.parse("2029-01-01"));
  const composed = await coordinator.createComposition(
    context,
    "face-candidates-001",
    "e".repeat(64),
    new AbortController().signal,
  );
  assert.equal(transport.compositionIntents[0].intent.acknowledged_possible_identity_change, true);
  assert.equal(transport.compositionIntents[0].intent.candidate_sha256, "e".repeat(64));
  assert.equal(storage.values.size, 2);
  coordinator.clear(context, "compose");
  assert.equal(storage.values.size, 1);
  assert.equal([...storage.values.values()][0], "retained-candidate-state");
  assert.equal(coordinator.downloadUrl(context, composed), "/private/upload-native-face/face-compose-001");
  assert.throws(() => coordinator.downloadUrl(context, job("queued", "compose")), /not ready/);
  await assert.rejects(
    coordinator.createComposition(context, "face-candidates-001", "bad", new AbortController().signal),
    /Review one exact/,
  );
});

test("capability preflight cannot create a job or smuggle a client model approval", async () => {
  const transport = new Transport();
  const coordinator = new NativeFaceQualityCoordinator(transport, new MemoryStorage());
  const capabilities = await coordinator.capabilities(context);
  assert.equal(capabilities.available, false);
  assert.deepEqual(capabilities.blockers, ["face-model-unregistered"]);
  assert.equal(transport.candidateIntents.length, 0);
  assert.equal(transport.compositionIntents.length, 0);
});

test("candidate artifact delivery verifies exact raw bytes before review", async () => {
  const pixels = new Uint8Array([10,20,30,255]); const mask = new Uint8Array([255]);
  const pixelSha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", pixels)),
    (value) => value.toString(16).padStart(2,"0")).join("");
  const maskSha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", mask)),
    (value) => value.toString(16).padStart(2,"0")).join("");
  const completed = job("succeeded");
  completed.candidates = [{ candidate_id: "candidate-owned", context: { source_sha256: sourceSha256,
    base_output_sha256: baseOutputSha256, source_width: 1, source_height: 1, output_width: 1,
    output_height: 1, bit_depth: 8, colour_authority_sha256: "f".repeat(64) },
  model_sha256: "1".repeat(64), dependency_lock_sha256: "2".repeat(64), fidelity_permyriad: 8000,
  region: { x: 0, y: 0, width: 1, height: 1 }, pixels_sha256: pixelSha, mask_sha256: maskSha }];
  const transport = new Transport();
  transport.candidateArtifact = async (
    _upload: string,
    _job: string,
    _candidate: string,
    kind: "pixels" | "mask",
  ): Promise<NativeFaceCandidateArtifact> => ({
    bytes: (kind === "pixels" ? pixels : mask).slice().buffer, candidateSha256: "9".repeat(64),
    artifactSha256: kind === "pixels" ? pixelSha : maskSha, width: 1, height: 1, frameCount: 1, bitDepth: 8 as const, kind,
    boundedPreview: false,
  });
  const coordinator = new NativeFaceQualityCoordinator(transport, new MemoryStorage());
  const artifact = await coordinator.candidateArtifact(context, completed, "candidate-owned", "pixels");
  assert.deepEqual(new Uint8Array(artifact.bytes), pixels); assert.equal(artifact.candidateSha256,"9".repeat(64));
  transport.candidateArtifact = async () => ({ bytes: new Uint8Array([0,0,0,0]).buffer,
    candidateSha256: "9".repeat(64), artifactSha256: pixelSha, width: 1, height: 1, frameCount: 1, bitDepth: 8,
    kind: "pixels", boundedPreview: false });
  await assert.rejects(coordinator.candidateArtifact(context,completed,"candidate-owned","pixels"),/does not match/);

  completed.candidates[0]!.region = { x: 0, y: 0, width: 2, height: 2 };
  const bounded = new Uint8Array([40,50,60,255]);
  const boundedSha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bounded)),
    (value) => value.toString(16).padStart(2,"0")).join("");
  transport.candidateArtifact = async () => ({ bytes: bounded.slice().buffer,
    candidateSha256: "9".repeat(64), artifactSha256: boundedSha, width: 1, height: 1, frameCount: 1, bitDepth: 8,
    kind: "pixels", boundedPreview: true });
  const proxy = await coordinator.candidateArtifact(context,completed,"candidate-owned","pixels");
  assert.equal(proxy.boundedPreview,true); assert.deepEqual(new Uint8Array(proxy.bytes),bounded);
  transport.candidateArtifact = async () => ({ ...proxy, width: 0, bytes: new ArrayBuffer(0) });
  await assert.rejects(coordinator.candidateArtifact(context,completed,"candidate-owned","pixels"),/does not match/);
});

test("native face preview converts exact 8/16-bit patch samples and the review mask without mutating input", () => {
  const eightBit = new Uint8Array([10, 20, 30, 255]);
  assert.deepEqual([...nativeFacePreviewRgba(eightBit.buffer, 1, 1, 8)], [10, 20, 30, 255]);
  assert.deepEqual([...eightBit], [10, 20, 30, 255]);

  const sixteenBit = new ArrayBuffer(8);
  const view = new DataView(sixteenBit);
  [0, 32_768, 65_535, 65_535].forEach((value, index) => view.setUint16(index * 2, value, true));
  assert.deepEqual([...nativeFacePreviewRgba(sixteenBit, 1, 1, 16)], [0, 128, 255, 255]);
  assert.deepEqual([...nativeFaceMaskRgba(new Uint8Array([0, 255]).buffer, 2, 1)],
    [255, 32, 128, 0, 255, 32, 128, 148]);
  assert.throws(() => nativeFacePreviewRgba(new ArrayBuffer(3), 1, 1, 8), /pixel count/);
  assert.throws(() => nativeFaceMaskRgba(new ArrayBuffer(1), 2, 1), /does not match/);
});
