import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";

import { DomainError, requireId } from "../../kernel/errors.js";
import {
  PRODUCT_REPOSITORY,
  RUNTIME_VALUES,
  type CommandContext,
  type ProductKernelRepository,
} from "../../kernel/product.types.js";
import { requestDigest, type RuntimeValues } from "../../kernel/runtime.js";
import { IdentityBoundary } from "../identity/identity.service.js";
import { IntakeService } from "../intake/intake.service.js";
import { PRIVATE_OBJECT_STORE, type PrivateObjectStore } from "../intake/private-object-store.js";
import type { IntakeOwner } from "../intake/intake.types.js";
import { faceQualityCapabilities, parseFaceQualityCandidateRequest } from "./face-quality.contract.js";
import {
  IMAGE_QUALITY_REPOSITORY,
  type ImageQualityContentClass,
  type ImageQualityRepository,
} from "./image-quality.types.js";

type Headers = Record<string, string | string[] | undefined>;
const MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const CONTENT_CLASSES = new Set<ImageQualityContentClass>([
  "photo",
  "illustration",
  "flat-graphic",
]);
const API_DOWNLOAD_LIMIT = 256 * 1024 * 1024;

@Injectable()
export class ImageQualityService implements OnApplicationShutdown {
  constructor(
    @Inject(IMAGE_QUALITY_REPOSITORY) private readonly requests: ImageQualityRepository,
    @Inject(PRIVATE_OBJECT_STORE) private readonly objects: PrivateObjectStore,
    @Inject(RUNTIME_VALUES) private readonly runtime: RuntimeValues,
    @Inject(PRODUCT_REPOSITORY) private readonly product: ProductKernelRepository,
    private readonly identity: IdentityBoundary,
    private readonly intake: IntakeService,
  ) {}

  async faceCapabilities(headers: Headers, uploadSessionId: string) {
    // Resolve the current source owner before exposing a source-specific capability.
    await this.intake.requireForInternal(headers, requireId(uploadSessionId, "upload id"));
    return faceQualityCapabilities();
  }

  async createFaceCandidates(headers: Headers, uploadSessionId: string, body: unknown): Promise<never> {
    const stored = await this.intake.requireForInternal(headers, requireId(uploadSessionId, "upload id"));
    const intent = parseFaceQualityCandidateRequest(body);
    const facts = stored.record.source_facts;
    if (stored.record.state !== "ready" || !facts || facts.sha256 !== intent.source_sha256) {
      throw new DomainError(409, "face-quality-source-changed", "Face permission must match the ready immutable source");
    }
    if (!MEDIA_TYPES.has(facts.detected_media_type)) {
      throw new DomainError(415, "face-quality-source-unsupported", "Choose a verified image for face reconstruction");
    }
    const owner = this.intake.ownerFor(stored.record);
    const base = await this.requests.get(owner, intent.base_image_quality_request_id);
    if (!base || base.upload_session_id !== stored.record.upload_session_id
      || base.source_sha256 !== facts.sha256) {
      throw new DomainError(404, "face-quality-base-not-found", "The base enhancement was not found for this source");
    }
    if (base.state !== "succeeded" || !base.output || base.output.sha256 !== intent.base_output_sha256) {
      throw new DomainError(409, "face-quality-base-changed", "Wait for the exact enhanced image before face review");
    }
    // Do not create an inert durable job, accept client pixels/model approvals,
    // or disguise ordinary Restore as a face result while release gates are open.
    throw new DomainError(503, "face-quality-unavailable",
      "Face reconstruction is not released: model rights, face-quality acceptance and durable native integration are pending");
  }

  async create(
    headers: Headers,
    uploadSessionId: string,
    body: Record<string, unknown>,
  ) {
    const stored = await this.intake.requireForInternal(headers, requireId(uploadSessionId, "upload id"));
    const facts = stored.record.source_facts;
    if (stored.record.state !== "ready" || !facts || !stored.record.source_version_id
      || stored.quarantineRef.zone !== "immutable" || !stored.quarantineRef.generation) {
      throw new DomainError(409, "source-not-ready", "Wait for the verified upload to become ready");
    }
    if (!MEDIA_TYPES.has(facts.detected_media_type) || !facts.width || !facts.height) {
      throw new DomainError(415, "image-quality-source-unsupported", "Choose a verified JPEG, PNG or WebP image");
    }
    const contentClass = body["content_class"];
    if (typeof contentClass !== "string" || !CONTENT_CLASSES.has(contentClass as ImageQualityContentClass)) {
      throw new DomainError(
        400,
        "image-quality-content-class-invalid",
        "Choose photo, illustration or protected flat-graphic restoration",
      );
    }
    const strength = Number(body["strength"]);
    if (!Number.isInteger(strength) || strength < 1 || strength > 100) {
      throw new DomainError(400, "image-quality-strength-invalid", "Strength must be from 1 to 100");
    }
    const frameCount = facts.frame_count ?? 1;
    const owner = this.intake.ownerFor(stored.record);
    const context = this.command(headers, owner, stored.record.upload_session_id, strength, contentClass);
    const expiresAt = new Date(
      new Date(this.runtime.now()).getTime()
        + (owner.ownerKind === "guest" ? 24 : 24 * 7) * 60 * 60 * 1000,
    ).toISOString();
    const created = await this.requests.create(context, {
      owner,
      uploadSessionId: stored.record.upload_session_id,
      sourceVersionId: stored.record.source_version_id,
      sourceObjectKey: stored.quarantineRef.objectKey,
      sourceStorageGeneration: stored.quarantineRef.generation,
      sourceSha256: facts.sha256,
      sourceMediaType: facts.detected_media_type as "image/jpeg" | "image/png" | "image/webp",
      sourceByteSize: facts.byte_size,
      sourceWidth: facts.width,
      sourceHeight: facts.height,
      sourceFrameCount: frameCount,
      sourceBitDepth: facts.bit_depth ?? 8,
      sourceHasIccProfile: facts.has_icc_profile ?? false,
      sourceColourPrimaries: facts.colour_primaries ?? null,
      sourceDynamicRange: facts.dynamic_range ?? null,
      contentClass: contentClass as ImageQualityContentClass,
      strength,
      expiresAt,
    });
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      image_quality_request: created.value,
      replayed: created.replayed,
    };
  }

  async get(headers: Headers, requestId: string) {
    const owner = await this.guestOwner(headers);
    const value = await this.requests.get(owner, requireId(requestId, "image quality request id"));
    if (!value) {
      throw new DomainError(404, "image-quality-not-found", "Enhancement request was not found");
    }
    return { schema_version: PRODUCT_SCHEMA_VERSION, image_quality_request: value };
  }

  async download(headers: Headers, requestId: string) {
    const owner = await this.guestOwner(headers);
    return this.deliveryForOwner(owner, requestId, "attachment");
  }

  async view(headers: Headers, requestId: string) {
    const owner = await this.guestOwner(headers);
    return this.deliveryForOwner(owner, requestId, "inline");
  }

  async getForWorkspace(headers: Headers, workspaceId: string, requestId: string) {
    const owner = await this.workspaceOwner(headers, workspaceId);
    const value = await this.requests.get(owner, requireId(requestId, "image quality request id"));
    if (!value) {
      throw new DomainError(404, "image-quality-not-found", "Enhancement request was not found");
    }
    return { schema_version: PRODUCT_SCHEMA_VERSION, image_quality_request: value };
  }

  async downloadForWorkspace(headers: Headers, workspaceId: string, requestId: string) {
    const owner = await this.workspaceOwner(headers, workspaceId);
    return this.deliveryForOwner(owner, requestId, "attachment");
  }

  async viewForWorkspace(headers: Headers, workspaceId: string, requestId: string) {
    const owner = await this.workspaceOwner(headers, workspaceId);
    return this.deliveryForOwner(owner, requestId, "inline");
  }

  private async deliveryForOwner(
    owner: IntakeOwner,
    requestId: string,
    disposition: "attachment" | "inline",
  ) {
    const delivery = await this.requests.delivery(
      owner,
      requireId(requestId, "image quality request id"),
    );
    if (!delivery) {
      throw new DomainError(409, "image-quality-not-ready", "The enhanced image is not ready to download");
    }
    const ref = {
      ownerScope: delivery.ownerScope,
      objectKey: delivery.objectKey,
      zone: "derivative" as const,
      generation: delivery.storageGeneration,
    };
    if (delivery.byteSize > API_DOWNLOAD_LIMIT) {
      const authorization = await this.objects.authorizeDownload(
        ref,
        delivery.filename,
        disposition,
      );
      if (!authorization) {
        throw new DomainError(
          413,
          "image-quality-direct-download-required",
          "This result is too large for the local development download route",
        );
      }
      return { ...delivery, bytes: null, downloadUrl: authorization.url };
    }
    const bytes = await this.objects.read(ref, API_DOWNLOAD_LIMIT);
    return { ...delivery, bytes, downloadUrl: null };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.requests.close();
  }

  private async guestOwner(headers: Headers): Promise<IntakeOwner> {
    if (!this.intake.hasGuestToken(headers)) {
      throw new DomainError(
        401,
        "image-quality-session-required",
        "Open the editor session that created this enhancement",
      );
    }
    return this.intake.guestOwner(headers);
  }

  private async workspaceOwner(headers: Headers, workspaceId: string): Promise<IntakeOwner> {
    const id = requireId(workspaceId, "workspace id");
    const principal = await this.identity.resolve(headers);
    const context = await this.product.workspaceContext(principal.actorId, id);
    const allowed = context?.effectivePermissions.some(
      (permission) => permission.permission === "upload.read" && permission.allowed,
    );
    if (!allowed) {
      throw new DomainError(404, "image-quality-not-found", "Enhancement request was not found");
    }
    return { ownerKind: "actor", ownerScope: id, workspaceId: id, actorId: principal.actorId };
  }

  private command(
    headers: Headers,
    owner: IntakeOwner,
    uploadSessionId: string,
    strength: number,
    contentClass: string,
  ): CommandContext {
    const idempotencyKey = requireId(this.header(headers, "idempotency-key"), "Idempotency-Key");
    const traceId = requireId(this.header(headers, "x-trace-id"), "trace id");
    return {
      principal: {
        actorId: owner.actorId ?? owner.guestSessionId!,
        displayName: owner.ownerKind,
      },
      idempotencyKey,
      traceId,
      requestHash: requestDigest({
        command: "image-quality.create",
        uploadSessionId,
        strength,
        contentClass,
      }),
    };
  }

  private header(headers: Headers, name: string): string | undefined {
    const value = headers[name];
    return (Array.isArray(value) ? value[0] : value)?.trim();
  }
}
