import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import type { FaceQualityCandidateRequest } from "ipw-contracts-ts/product";

import { DomainError, requireId } from "../../kernel/errors.js";
import type { CommandContext } from "../../kernel/product.types.js";
import { requestDigest } from "../../kernel/runtime.js";
import { IntakeService } from "../intake/intake.service.js";
import { PRIVATE_OBJECT_STORE, type PrivateObjectStore } from "../intake/private-object-store.js";
import { parseFaceQualityCompositionIntent } from "./face-quality.contract.js";
import { FACE_QUALITY_RELEASES, FACE_QUALITY_REPOSITORY, type NativeFaceReleases, PostgresFaceQualityRepository, requireFaceRelease } from "./face-quality.repository.js";

type Headers = Record<string, string | string[] | undefined>;

@Injectable()
export class FaceQualityService implements OnApplicationShutdown {
  constructor(@Inject(FACE_QUALITY_REPOSITORY) private readonly jobs: PostgresFaceQualityRepository | null,
    @Inject(FACE_QUALITY_RELEASES) private readonly releases: NativeFaceReleases,
    @Inject(PRIVATE_OBJECT_STORE) private readonly objects: PrivateObjectStore,
    private readonly intake: IntakeService) {}

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
    return this.repository().cancel(owner, uploadId, requireId(id, "face job id"), requireId(Array.isArray(raw) ? raw[0] : raw, "trace id"));
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
    const { createHash } = await import("node:crypto");
    if (bytes.byteLength !== output.object.byte_size || createHash("sha256").update(bytes).digest("hex") !== output.object.sha256) {
      throw new DomainError(409, "face-quality-output-changed", "The reviewed download failed its identity check");
    }
    return { url: null, bytes, sha256: output.object.sha256 };
  }
  async onApplicationShutdown() { await this.jobs?.close(); }
}
