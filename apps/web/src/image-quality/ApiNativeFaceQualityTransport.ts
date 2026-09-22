import { api } from "../boundaries/apiClient";
import {
  NativeFaceQualityCoordinator,
  type NativeFaceQualityTransport,
} from "./NativeFaceQualityClient";

export const apiNativeFaceQualityTransport: NativeFaceQualityTransport = {
  capabilities: (uploadSessionId, traceId, signal) => api.faceQualityCapabilities(uploadSessionId, traceId, signal),
  createCandidates: (uploadSessionId, intent, traceId, idempotencyKey, signal) =>
    api.createFaceQualityCandidates(uploadSessionId, intent, traceId, idempotencyKey, signal),
  createComposition: (uploadSessionId, intent, traceId, idempotencyKey, signal) =>
    api.createFaceQualityComposition(uploadSessionId, intent, traceId, idempotencyKey, signal),
  get: (uploadSessionId, jobId, traceId, signal) => api.faceQualityJob(uploadSessionId, jobId, traceId, signal),
  cancel: (uploadSessionId, jobId, traceId, signal) => api.cancelFaceQualityJob(uploadSessionId, jobId, traceId, signal),
  retry: (uploadSessionId, jobId, traceId, idempotencyKey, signal) =>
    api.retryFaceQualityJob(uploadSessionId, jobId, traceId, idempotencyKey, signal),
  downloadUrl: (uploadSessionId, jobId) => api.faceQualityDownloadUrl(uploadSessionId, jobId),
  candidateArtifact: (uploadSessionId, jobId, candidateId, kind, signal) =>
    api.faceQualityCandidateArtifact(uploadSessionId, jobId, candidateId, kind, signal),
};

export function createApiNativeFaceQualityCoordinator(): NativeFaceQualityCoordinator {
  return new NativeFaceQualityCoordinator(apiNativeFaceQualityTransport);
}
