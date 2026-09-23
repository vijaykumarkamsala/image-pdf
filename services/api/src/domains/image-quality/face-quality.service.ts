import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { FaceQualityCandidateRequest, FaceQualityObject } from "ipw-contracts-ts/product";

import { DomainError, requireId } from "../../kernel/errors.js";
import { RUNTIME_VALUES, type CommandContext } from "../../kernel/product.types.js";
import { requestDigest, type RuntimeValues } from "../../kernel/runtime.js";
import { IntakeService } from "../intake/intake.service.js";
import { PRIVATE_OBJECT_STORE, type PrivateObjectStore } from "../intake/private-object-store.js";
import { parseFaceQualityCompositionIntent } from "./face-quality.contract.js";
import { FACE_QUALITY_RELEASES, FACE_QUALITY_REPOSITORY, type NativeFaceReleases, PostgresFaceQualityRepository, requireFaceRelease } from "./face-quality.repository.js";

type Headers = Record<string, string | string[] | undefined>;
const CANDIDATE_PREVIEW_LIMIT = 256 * 1024 * 1024;

@Injectable()
export class FaceQualityService implements OnApplicationShutdown {
  constructor(@Inject(FACE_QUALITY_REPOSITORY) private readonly jobs: PostgresFaceQualityRepository | null,
    @Inject(FACE_QUALITY_RELEASES) private readonly releases: NativeFaceReleases,
    @Inject(PRIVATE_OBJECT_STORE) private readonly objects: PrivateObjectStore,
    private readonly intake: IntakeService,
    @Inject(RUNTIME_VALUES) private readonly runtime: RuntimeValues) {}

  private repository(): PostgresFaceQualityRepository {
    if (!this.jobs) throw new DomainError(503, "face-quality-unavailable", "Durable native face processing requires the private database worker");
    return this.jobs;
  }
  private async owner(headers: Headers, uploadId: string) {
    return this.intake.ownerFor((await this.intake.requireForInternal(headers, requireId(uploadId, "upload id"))).record);
  }
  private command(headers: Headers, payload: unknown): CommandContext {
    const value = (name: string) => { const raw = headers[name]; return Array.isArray(raw) ? raw[0] : raw; };
    return { principal: { actorId: "server-face-boundary", displayName: "face-quality" },
      traceId: requireId(value("x-trace-id"), "trace id"), idempotencyKey: requireId(value("idempotency-key"), "Idempotency-Key"),
      requestHash: requestDigest(payload) };
  }
  async candidates(headers: Headers, uploadId: string, intent: FaceQualityCandidateRequest) {
    const owner = await this.owner(headers, uploadId);
    const release = requireFaceRelease(this.releases.current());
    return this.repository().createCandidates(this.command(headers, { uploadId, intent }), owner, uploadId, intent, release);
  }
  async compose(headers: Headers, uploadId: string, body: unknown) {
    const owner = await this.owner(headers, uploadId);
    const intent = parseFaceQualityCompositionIntent(body);
    const release = requireFaceRelease(this.releases.current());
    return this.repository().createComposition(this.command(headers, { uploadId, intent }), owner, uploadId, intent, release);
  }
  async get(headers: Headers, uploadId: string, id: string) {
    const owner = await this.owner(headers, uploadId);
    const value = await this.repository().get(owner, uploadId, requireId(id, "face job id"));
    if (!value) throw new DomainError(404, "face-quality-not-found", "Face work was not found for this image");
    return value;
  }
  async cancel(headers: Headers, uploadId: string, id: string) {
    const owner = await this.owner(headers, uploadId);
    const raw = headers["x-trace-id"];
    const value = await this.repository().cancel(owner, uploadId, requireId(id, "face job id"), requireId(Array.isArray(raw) ? raw[0] : raw, "trace id"));
    if (!value) throw new DomainError(404, "face-quality-not-found", "Face work was not found for this image");
    return value;
  }
  async retry(headers: Headers, uploadId: string, id: string) {
    const owner = await this.owner(headers, uploadId);
    const release = requireFaceRelease(this.releases.current());
    return this.repository().retry(this.command(headers, { command: "face-quality.retry", uploadId, id }), owner, uploadId, requireId(id, "face job id"), release);
  }
  async download(headers: Headers, uploadId: string, id: string) {
    const owner = await this.owner(headers, uploadId);
    // Revocation closes delivery as well as new inference; old ordinary output is unaffected.
    const release = requireFaceRelease(this.releases.current());
    const output = await this.repository().delivery(owner, uploadId, requireId(id, "face job id"));
    if (!output || output.object.owner_scope !== owner.ownerScope || !output.object.object_key.startsWith(`derivative/${owner.ownerScope}/`)) {
      throw new DomainError(409, "face-quality-not-ready", "The reviewed face derivative is not ready");
    }
    const candidate = output.evidence["candidate"] as { model_sha256?: string; dependency_lock_sha256?: string } | undefined;
    if (candidate?.model_sha256 !== release.model_sha256 || candidate.dependency_lock_sha256 !== release.dependency_lock_sha256) {
      throw new DomainError(503, "face-quality-release-changed", "The reviewed result belongs to a different model release");
    }
    const ref = { ownerScope: owner.ownerScope, objectKey: output.object.object_key, zone: "derivative" as const, generation: output.object.generation };
    const authorization = await this.objects.authorizeDownload(ref, `reviewed-face-${id}.png`);
    if (authorization) return { url: authorization.url, bytes: null, sha256: output.object.sha256 };
    if (output.object.byte_size > 256 * 1024 * 1024) {
      throw new DomainError(413, "face-quality-direct-download-required", "Use private object-storage delivery for this large result");
    }
    const bytes = await this.objects.read(ref, output.object.byte_size);
    if (bytes.byteLength !== output.object.byte_size || createHash("sha256").update(bytes).digest("hex") !== output.object.sha256) {
      throw new DomainError(409, "face-quality-output-changed", "The reviewed download failed its identity check");
    }
    return { url: null, bytes, sha256: output.object.sha256 };
  }
  async candidateArtifact(
    headers: Headers,
    uploadId: string,
    id: string,
    candidateId: string,
    kind: "pixels" | "mask",
  ) {
    const owner = await this.owner(headers, uploadId);
    const release = requireFaceRelease(this.releases.current());
    const value = await this.repository().candidateArtifact(
      owner,
      uploadId,
      requireId(id, "face job id"),
      requireId(candidateId, "face candidate id"),
    );
    if (!value) throw new DomainError(404, "face-quality-candidate-not-found", "Face candidate was not found for this image");
    const candidate = value.stored.candidate;
    if (value.release.model_sha256 !== release.model_sha256
      || value.release.dependency_lock_sha256 !== release.dependency_lock_sha256
      || candidate.model_sha256 !== release.model_sha256
      || candidate.dependency_lock_sha256 !== release.dependency_lock_sha256) {
      throw new DomainError(503, "face-quality-release-changed", "The candidate belongs to a different model release");
    }
    const boundedPreview = Boolean(value.stored.review_pixels || value.stored.review_mask
      || value.stored.review_width || value.stored.review_height)
      || value.stored.pixels.byte_size > CANDIDATE_PREVIEW_LIMIT
      || value.stored.mask.byte_size > CANDIDATE_PREVIEW_LIMIT;
    if (boundedPreview && (!value.stored.review_pixels || !value.stored.review_mask
      || !value.stored.review_width || !value.stored.review_height)) {
      throw new DomainError(413, "face-quality-candidate-preview-too-large", "This face comparison requires a bounded server preview");
    }
    const object: FaceQualityObject = boundedPreview
      ? kind === "pixels" ? value.stored.review_pixels! : value.stored.review_mask!
      : kind === "pixels" ? value.stored.pixels : value.stored.mask;
    const width = boundedPreview ? value.stored.review_width! : candidate.region.width;
    const height = boundedPreview ? value.stored.review_height! : candidate.region.height;
    const expectedSha256 = boundedPreview ? object.sha256
      : kind === "pixels" ? candidate.pixels_sha256 : candidate.mask_sha256;
    const frameCount = candidate.context.frame_count ?? 1;
    const expectedBytes = width * height * frameCount
      * (kind === "pixels" ? 4 * (candidate.context.bit_depth === 16 ? 2 : 1) : 1);
    if (!/^[0-9a-f]{64}$/.test(value.candidateSha256)
      || !/^[0-9a-f]{64}$/.test(expectedSha256)
      || (boundedPreview && (Math.max(candidate.region.width, candidate.region.height) <= 2048
        || Math.max(width, height) > 2048))
      || !Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes !== object.byte_size
      || object.sha256 !== expectedSha256 || object.owner_scope !== owner.ownerScope
      || !object.object_key.startsWith(`derivative/${owner.ownerScope}/`)) {
      throw new DomainError(409, "face-quality-candidate-changed", "The private face candidate failed its identity check");
    }
    if (object.byte_size > CANDIDATE_PREVIEW_LIMIT) {
      throw new DomainError(413, "face-quality-candidate-preview-too-large", "This face comparison requires a bounded server preview");
    }
    const bytes = await this.objects.read({ ownerScope: owner.ownerScope, objectKey: object.object_key,
      zone: "derivative", generation: object.generation }, object.byte_size);
    if (bytes.byteLength !== object.byte_size || createHash("sha256").update(bytes).digest("hex") !== object.sha256) {
      throw new DomainError(409, "face-quality-candidate-changed", "The private face candidate failed its identity check");
    }
    return { bytes, artifactSha256: object.sha256, candidateSha256: value.candidateSha256,
      width, height, frameCount, bitDepth: candidate.context.bit_depth, kind, boundedPreview };
  }
  async cleanupExpiredArtifacts(limit = 100): Promise<{ cleaned: number; objectsRemoved: number; failed: number }> {
    const now = this.runtime.now();
    const workerId = this.runtime.id("face-cleanup");
    const leaseExpiresAt = new Date(new Date(now).getTime() + 90_000).toISOString();
    const candidates = await this.repository().claimArtifactCleanup(workerId, now, leaseExpiresAt, limit);
    let cleaned = 0; let objectsRemoved = 0; let failed = 0;
    for (const candidate of candidates) {
      try {
        let removedForCandidate = 0;
        const unique = new Map<string, FaceQualityObject>();
        for (const object of candidate.objects) {
          if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(object.owner_scope)
            || !object.object_key.startsWith(`derivative/${object.owner_scope}/face/`)
            || !object.generation || !/^[0-9a-f]{64}$/.test(object.sha256)) {
            throw new Error("face cleanup object reference is invalid");
          }
          unique.set(`${object.object_key}\0${object.generation}`, object);
        }
        for (const object of unique.values()) {
          await this.objects.remove({ ownerScope: object.owner_scope, objectKey: object.object_key,
            zone: "derivative", generation: object.generation });
          removedForCandidate += 1;
        }
        await this.repository().completeArtifactCleanup(candidate.faceQualityJobId, workerId, this.runtime.now());
        objectsRemoved += removedForCandidate;
        cleaned += 1;
      } catch {
        failed += 1;
        await this.repository().releaseArtifactCleanup(
          candidate.faceQualityJobId, workerId, this.runtime.now(),
        ).catch(() => undefined);
      }
    }
    return { cleaned, objectsRemoved, failed };
  }
  async onApplicationShutdown() { await this.jobs?.close(); }
}
