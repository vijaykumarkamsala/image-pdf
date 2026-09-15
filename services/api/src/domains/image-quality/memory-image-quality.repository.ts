import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";

import { DomainError } from "../../kernel/errors.js";
import type { CommandContext } from "../../kernel/product.types.js";
import type { RuntimeValues } from "../../kernel/runtime.js";
import type {
  CreateImageQualityInput,
  ImageQualityDelivery,
  ImageQualityRepository,
  ImageQualityRequestRecord,
} from "./image-quality.types.js";

interface Receipt {
  requestHash: string;
  response: ImageQualityRequestRecord;
}

export class MemoryImageQualityRepository implements ImageQualityRepository {
  private readonly requests = new Map<string, ImageQualityRequestRecord>();
  private readonly receipts = new Map<string, Receipt>();

  constructor(private readonly runtime: RuntimeValues) {}

  async create(context: CommandContext, input: CreateImageQualityInput) {
    const receiptKey = `${input.owner.ownerScope}:image-quality.create:${context.idempotencyKey}`;
    const prior = this.receipts.get(receiptKey);
    if (prior) {
      if (prior.requestHash !== context.requestHash) {
        throw new DomainError(
          409,
          "idempotency-conflict",
          "This idempotency key was already used for different enhancement work",
        );
      }
      return { value: structuredClone(prior.response), replayed: true };
    }
    const now = this.runtime.now();
    const value: ImageQualityRequestRecord = {
      schema_version: PRODUCT_SCHEMA_VERSION,
      image_quality_request_id: this.runtime.id("quality"),
      owner_kind: input.owner.ownerKind,
      workspace_id: input.owner.workspaceId ?? null,
      guest_session_id: input.owner.guestSessionId ?? null,
      upload_session_id: input.uploadSessionId,
      source_version_id: input.sourceVersionId,
      source_sha256: input.sourceSha256,
      source_media_type: input.sourceMediaType,
      source_byte_size: input.sourceByteSize,
      source_width: input.sourceWidth,
      source_height: input.sourceHeight,
      source_frame_count: input.sourceFrameCount,
      source_bit_depth: input.sourceBitDepth,
      source_colour_primaries: input.sourceColourPrimaries,
      source_dynamic_range: input.sourceDynamicRange,
      content_class: input.contentClass,
      strength: input.strength,
      job_id: this.runtime.id("job"),
      state: "queued",
      progress_percent: 0,
      output: null,
      failure: null,
      expires_at: input.expiresAt,
      created_at: now,
      updated_at: now,
    };
    this.requests.set(value.image_quality_request_id, structuredClone(value));
    this.receipts.set(receiptKey, {
      requestHash: context.requestHash,
      response: structuredClone(value),
    });
    return { value: structuredClone(value), replayed: false };
  }

  async get(owner: CreateImageQualityInput["owner"], requestId: string) {
    const value = this.requests.get(requestId);
    return value && this.ownerScope(value) === owner.ownerScope ? structuredClone(value) : null;
  }

  async delivery(): Promise<ImageQualityDelivery | null> {
    return null;
  }

  async close(): Promise<void> {}

  private ownerScope(value: ImageQualityRequestRecord): string | null {
    return value.owner_kind === "actor" ? value.workspace_id : value.guest_session_id;
  }
}
