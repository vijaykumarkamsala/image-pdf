import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { NativeFaceOutput, NativeFaceRelease, StoredNativeFaceCandidate } from "ipw-contracts-ts/product";

import { FaceQualityService } from "../src/domains/image-quality/face-quality.service.js";
import type { PostgresFaceQualityRepository } from "../src/domains/image-quality/face-quality.repository.js";
import type { IntakeService } from "../src/domains/intake/intake.service.js";
import type { PrivateObjectRef, PrivateObjectStore } from "../src/domains/intake/private-object-store.js";
import { DomainError } from "../src/kernel/errors.js";

/** Boundary-only mocks: actual native PNG rendering is tested in the Python worker. */
function boundary() {
  const bytes = new Uint8Array([1, 2, 3]);
  const release: NativeFaceRelease = { model_id: "owned-synthetic-not-production", model_version: "1",
    model_sha256: "a".repeat(64), dependency_lock_sha256: "c".repeat(64), commercial_rights: "approved",
    rights_evidence_id: "test-only", quality_review: "approved", quality_evidence_id: "test-only" };
  const output: NativeFaceOutput = { object: { owner_scope: "guest-owned", object_key: "derivative/guest-owned/face/result.png",
    generation: "owned-generation-1", byte_size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") },
    width: 1, height: 1, bit_depth: 8, changed_pixels: 1,
    evidence: { candidate: { model_sha256: release.model_sha256, dependency_lock_sha256: release.dependency_lock_sha256 } } };
  const candidatePixels = new Uint8Array([11,12,13,255]); const candidateMask = new Uint8Array([255]);
  const candidate: StoredNativeFaceCandidate = {
    candidate: { candidate_id: "candidate-owned", context: { source_sha256: "1".repeat(64), base_output_sha256: "2".repeat(64),
      source_width: 1, source_height: 1, output_width: 1, output_height: 1, bit_depth: 8,
      colour_authority_sha256: "3".repeat(64) }, model_sha256: release.model_sha256,
    dependency_lock_sha256: release.dependency_lock_sha256, fidelity_permyriad: 8000,
    region: { x: 0, y: 0, width: 1, height: 1 }, pixels_sha256: createHash("sha256").update(candidatePixels).digest("hex"),
    mask_sha256: createHash("sha256").update(candidateMask).digest("hex") },
    pixels: { owner_scope: "guest-owned", object_key: "derivative/guest-owned/face/candidate.rgba",
      generation: "candidate-pixels-generation", byte_size: candidatePixels.byteLength,
      sha256: createHash("sha256").update(candidatePixels).digest("hex") },
    mask: { owner_scope: "guest-owned", object_key: "derivative/guest-owned/face/candidate.mask",
      generation: "candidate-mask-generation", byte_size: candidateMask.byteLength,
      sha256: createHash("sha256").update(candidateMask).digest("hex") },
  };
  let current: NativeFaceRelease | null = release;
  let fetched: Uint8Array = bytes;
  let signed: { url: string; expiresAt: string } | null = null;
  let reads = 0; let authorizations = 0; let cancelled: { state: string } | null = { state: "cancel_requested" };
  const repo = { delivery: async () => output, cancel: async () => cancelled,
    candidateArtifact: async () => ({ stored: candidate, candidateSha256: "4".repeat(64), release }) } as unknown as PostgresFaceQualityRepository;
  const intake = { requireForInternal: async (headers: Record<string,string>) => {
    if (headers["x-ipw-guest-token"] !== "owned-synthetic-token") throw new DomainError(404,"upload-not-found","Upload was not found");
    return { record: {} };
  }, ownerFor: () => ({ ownerKind: "guest", ownerScope: "guest-owned", guestSessionId: "guest-owned" }) } as unknown as IntakeService;
  const objects = { authorizeDownload: async (ref: PrivateObjectRef) => {
    authorizations++; assert.equal(ref.ownerScope,"guest-owned"); assert.equal(ref.generation,output.object.generation);
    return signed;
  }, read: async (ref: PrivateObjectRef, limit: number) => {
    reads++;
    if (ref.objectKey === candidate.pixels.object_key) { assert.equal(limit,candidatePixels.byteLength); return candidatePixels; }
    if (ref.objectKey === candidate.mask.object_key) { assert.equal(limit,candidateMask.byteLength); return candidateMask; }
    assert.equal(ref.generation,output.object.generation); assert.equal(limit,output.object.byte_size); return fetched;
  } } as unknown as PrivateObjectStore;
  const service = new FaceQualityService(repo,{current:()=>current},objects,intake);
  return { service, bytes, output, release, candidate, candidatePixels, candidateMask,
    headers: {"x-ipw-guest-token":"owned-synthetic-token","x-trace-id":"trace-owned"},
    setRelease: (value: NativeFaceRelease|null) => {current=value;}, setBytes: (value: Uint8Array) => {fetched=value;},
    setSigned: (value: {url:string;expiresAt:string}) => {signed=value;}, setCancelled: (value: {state:string}|null) => {cancelled=value;},
    reads:()=>reads, authorizations:()=>authorizations };
}
const rejected = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;

test("owned face delivery checks exact bytes and rejects foreign tokens before storage access", async () => {
  const sample = boundary();
  const result = await sample.service.download(sample.headers,"upload-owned","face-owned");
  assert.deepEqual(result.bytes,sample.bytes); assert.equal(result.sha256,sample.output.object.sha256);
  sample.setBytes(new Uint8Array([3,2,1]));
  await assert.rejects(sample.service.download(sample.headers,"upload-owned","face-owned"),rejected("face-quality-output-changed"));
  await assert.rejects(sample.service.download({...sample.headers,"x-ipw-guest-token":"other-token"},"upload-owned","face-owned"),rejected("upload-not-found"));
  assert.equal(sample.reads(),2); assert.equal(sample.authorizations(),2);
});

test("revoked or changed face release prevents delivery but never prevents cancellation", async () => {
  const sample = boundary(); sample.setRelease(null);
  await assert.rejects(sample.service.download(sample.headers,"upload-owned","face-owned"),rejected("face-quality-unavailable"));
  assert.equal((await sample.service.cancel(sample.headers,"upload-owned","face-owned"))?.state,"cancel_requested");
  sample.setCancelled(null);
  await assert.rejects(sample.service.cancel(sample.headers,"upload-owned","face-expired"),rejected("face-quality-not-found"));
  sample.setRelease({...sample.release,model_sha256:"d".repeat(64)});
  await assert.rejects(sample.service.download(sample.headers,"upload-owned","face-owned"),rejected("face-quality-release-changed"));
  assert.equal(sample.authorizations(),0); assert.equal(sample.reads(),0);
});

test("large reviewed delivery signs the exact private generation without buffering the result", async () => {
  const sample = boundary(); sample.output.object.byte_size=3*1024**3;
  sample.setSigned({url:"https://owned.test/private-expiring-result",expiresAt:"2026-09-16T00:01:00Z"});
  const result = await sample.service.download(sample.headers,"upload-owned","face-owned");
  assert.equal(result.bytes,null); assert.equal(result.url,"https://owned.test/private-expiring-result");
  assert.equal(sample.authorizations(),1); assert.equal(sample.reads(),0);
});

test("candidate review artifacts are owner scoped, release bound and byte verified", async () => {
  const sample = boundary();
  const pixels = await sample.service.candidateArtifact(sample.headers,"upload-owned","face-owned","candidate-owned","pixels");
  assert.deepEqual(pixels.bytes,sample.candidatePixels); assert.equal(pixels.candidateSha256,"4".repeat(64));
  assert.equal(pixels.width,1); assert.equal(pixels.height,1); assert.equal(pixels.bitDepth,8);
  const mask = await sample.service.candidateArtifact(sample.headers,"upload-owned","face-owned","candidate-owned","mask");
  assert.deepEqual(mask.bytes,sample.candidateMask); assert.equal(mask.artifactSha256,sample.candidate.mask.sha256);
  sample.candidate.pixels.byte_size = 3;
  await assert.rejects(sample.service.candidateArtifact(sample.headers,"upload-owned","face-owned","candidate-owned","pixels"),
    rejected("face-quality-candidate-changed"));
  sample.setRelease(null);
  await assert.rejects(sample.service.candidateArtifact(sample.headers,"upload-owned","face-owned","candidate-owned","mask"),
    rejected("face-quality-unavailable"));
});
