import type { FaceQualityCandidateRequest, FaceQualityCapabilities, FaceQualityCompositionIntent } from "ipw-contracts-ts/product";

import { DomainError, requireId, requireSha256 } from "../../kernel/errors.js";

/** No caller, environment flag or test adapter can register a commercial model. */
export function faceQualityCapabilities(): FaceQualityCapabilities {
  return {
    contract_version: "image-quality-face-v1",
    available: false,
    native_still_renderer_implemented: true,
    native_jobs_integrated: true,
    native_animation_supported: true,
    supported_still_bit_depths: [8, 16],
    supported_animation_bit_depths: [8],
    preserves_base_alpha: true,
    blockers: [
      "face-model-unregistered",
      "commercial-rights-pending",
      "face-quality-review-pending",
      "native-face-model-adapter-unregistered",
    ],
  };
}

export function parseFaceQualityCompositionIntent(value: unknown): FaceQualityCompositionIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError(400, "face-quality-review-invalid", "Review one exact face candidate");
  }
  const body = value as Record<string, unknown>;
  const fields = ["contract_version", "candidate_request_id", "candidate_sha256", "source_sha256",
    "base_output_sha256", "allow_reconstructed_face_detail", "acknowledged_possible_identity_change"];
  if (Object.keys(body).length !== fields.length || !fields.every((field) => Object.hasOwn(body, field))
    || body["contract_version"] !== "image-quality-face-v1"
    || body["allow_reconstructed_face_detail"] !== true
    || body["acknowledged_possible_identity_change"] !== true) {
    throw new DomainError(400, "face-quality-review-invalid", "Exact candidate review and literal identity-risk acknowledgement are required");
  }
  return { contract_version: "image-quality-face-v1",
    candidate_request_id: requireId(body["candidate_request_id"], "face candidate request id"),
    candidate_sha256: requireSha256(body["candidate_sha256"]), source_sha256: requireSha256(body["source_sha256"]),
    base_output_sha256: requireSha256(body["base_output_sha256"]), allow_reconstructed_face_detail: true,
    acknowledged_possible_identity_change: true };
}

export function parseFaceQualityCandidateRequest(value: unknown): FaceQualityCandidateRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError(400, "face-quality-intent-invalid", "Choose explicit face reconstruction settings");
  }
  const body = value as Record<string, unknown>;
  const fields = ["contract_version", "base_image_quality_request_id", "source_sha256",
    "base_output_sha256", "allow_reconstructed_face_detail", "fidelity_permyriad", "candidate_count"];
  if (Object.keys(body).length !== fields.length || !fields.every((field) => Object.hasOwn(body, field))
    || body["contract_version"] !== "image-quality-face-v1"
    || body["allow_reconstructed_face_detail"] !== true
    || !Number.isInteger(body["fidelity_permyriad"])
    || Number(body["fidelity_permyriad"]) < 0 || Number(body["fidelity_permyriad"]) > 10_000
    || (body["candidate_count"] !== 2 && body["candidate_count"] !== 3)) {
    throw new DomainError(400, "face-quality-intent-invalid",
      "Explicit source-bound permission, two or three candidates and valid fidelity are required");
  }
  return {
    contract_version: "image-quality-face-v1",
    base_image_quality_request_id: requireId(body["base_image_quality_request_id"], "base enhancement id"),
    source_sha256: requireSha256(body["source_sha256"]),
    base_output_sha256: requireSha256(body["base_output_sha256"]),
    allow_reconstructed_face_detail: true,
    fidelity_permyriad: Number(body["fidelity_permyriad"]),
    candidate_count: body["candidate_count"],
  };
}
