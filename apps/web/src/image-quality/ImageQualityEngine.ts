export const IMAGE_QUALITY_INPUT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

import type { ImageFileInspection } from "./imageFileInspection";
import type { FidelityEvidence } from "./imageQualityFidelity";

export type ImageQualityPhase =
  | "inspect"
  | "upload"
  | "hash"
  | "decode"
  | "analyse"
  | "model"
  | "reconstruct"
  | "encode";

export interface ImageQualityProgress {
  phase: ImageQualityPhase;
  completed: number;
  total: number;
  message: string;
}

export interface ImageQualitySource {
  width: number;
  height: number;
  mediaType: string;
  byteSize: number;
  sourceSha256: string;
  inspection: ImageFileInspection;
}

export interface ImageQualityAnalysis {
  noiseLevel: number;
  edgeDefinition: number;
  tonalRange: number;
  colourCast: number;
}

export interface ImageQualityResult {
  bytes: ArrayBuffer | null;
  remoteViewUrl?: string;
  remoteDownloadUrl?: string;
  mediaType: "image/png";
  width: number;
  height: number;
  analysis: ImageQualityAnalysis;
  engine: string;
  route: string;
  sourceSha256: string;
  outputSha256: string;
  strength: number;
  scale: 1 | 2 | 4;
  processingTimeMs: number;
  contentClass: "flat-graphic" | "illustration" | "photograph";
  classificationConfidence: number;
  model: {
    id: string;
    version: string;
    sha256: string | null;
    usage: "deterministic" | "production-restore" | "local-research";
  };
  warnings: string[];
  fidelity: FidelityEvidence;
  /** Internal analysis-only result; never offered as a customer derivative. */
  analysisProxy?: boolean;
}

export interface ImageQualityOperationOptions {
  onProgress?: (progress: ImageQualityProgress) => void;
}

export interface ImageQualityEngine {
  load(source: Blob, options?: ImageQualityOperationOptions): Promise<ImageQualitySource>;
  enhance(strength: number, options?: ImageQualityOperationOptions): Promise<ImageQualityResult>;
  cancel(): void;
  dispose(): void;
}
