import type { CommandContext } from "../../kernel/product.types.js";
import type { IntakeOwner } from "../intake/intake.types.js";

export type ImageQualityContentClass = "photo" | "illustration" | "flat-graphic";
export type ImageQualityRequestState =
  | "queued"
  | "running"
  | "retry_wait"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface ImageQualityRequestRecord {
  schema_version: string;
  image_quality_request_id: string;
  owner_kind: IntakeOwner["ownerKind"];
  workspace_id: string | null;
  guest_session_id: string | null;
  upload_session_id: string;
  source_version_id: string;
  source_sha256: string;
  source_media_type: "image/jpeg" | "image/png" | "image/webp";
  source_byte_size: number;
  source_width: number;
  source_height: number;
  source_frame_count: number;
  source_bit_depth: number;
  source_colour_primaries: "srgb" | "display-p3" | "bt2020" | "unknown" | null;
  source_dynamic_range: "sdr" | "hdr-pq" | "hdr-hlg" | "unknown" | null;
  content_class: ImageQualityContentClass;
  strength: number;
  job_id: string;
  state: ImageQualityRequestState;
  progress_percent: number;
  output: ImageQualityOutputRecord | null;
  failure: { code: string; message: string; retryable: boolean } | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface ImageQualityOutputRecord {
  media_type: "image/png";
  byte_size: number;
  width: number;
  height: number;
  frame_count: number;
  bit_depth: number;
  has_icc_profile: boolean;
  colour_policy: string;
  colour_primaries: "srgb" | "display-p3" | "bt2020" | "unknown" | null;
  dynamic_range: "sdr" | "hdr-pq" | "hdr-hlg" | "unknown" | null;
  sha256: string;
  model: {
    id: string;
    version: string;
    sha256: string;
    usage: "restore" | "deterministic";
    deterministic: boolean;
  };
  processor: { name: string; version: string };
  fidelity: {
    low_texture_mean_rgb_shift: number;
    high_drift_fraction: number;
    alpha_mismatch_fraction: number;
    overall_mean_rgb_difference: number;
    passed: boolean;
  };
}

export interface ImageQualityDelivery {
  ownerScope: string;
  objectKey: string;
  storageGeneration: string;
  byteSize: number;
  mediaType: "image/png";
  filename: string;
  sha256: string;
  frameCount: number;
}

export interface CreateImageQualityInput {
  owner: IntakeOwner;
  uploadSessionId: string;
  sourceVersionId: string;
  sourceObjectKey: string;
  sourceStorageGeneration: string;
  sourceSha256: string;
  sourceMediaType: "image/jpeg" | "image/png" | "image/webp";
  sourceByteSize: number;
  sourceWidth: number;
  sourceHeight: number;
  sourceFrameCount: number;
  sourceBitDepth: number;
  sourceHasIccProfile: boolean;
  sourceColourPrimaries: ImageQualityRequestRecord["source_colour_primaries"];
  sourceDynamicRange: ImageQualityRequestRecord["source_dynamic_range"];
  contentClass: ImageQualityContentClass;
  strength: number;
  expiresAt: string;
}

export interface ImageQualityRepository {
  create(
    context: CommandContext,
    input: CreateImageQualityInput,
  ): Promise<{ value: ImageQualityRequestRecord; replayed: boolean }>;
  get(owner: IntakeOwner, requestId: string): Promise<ImageQualityRequestRecord | null>;
  delivery(owner: IntakeOwner, requestId: string): Promise<ImageQualityDelivery | null>;
  close(): Promise<void>;
}

export const IMAGE_QUALITY_REPOSITORY = Symbol("IMAGE_QUALITY_REPOSITORY");
