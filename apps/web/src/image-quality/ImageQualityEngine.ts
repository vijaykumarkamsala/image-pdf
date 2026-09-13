export const IMAGE_QUALITY_INPUT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export interface ImageQualitySource {
  width: number;
  height: number;
  mediaType: string;
}

export interface ImageQualityAnalysis {
  noiseLevel: number;
  edgeDefinition: number;
  tonalRange: number;
  colourCast: number;
}

export interface ImageQualityResult {
  bytes: ArrayBuffer;
  mediaType: "image/png";
  width: number;
  height: number;
  analysis: ImageQualityAnalysis;
}

export interface ImageQualityEngine {
  load(source: Blob): Promise<ImageQualitySource>;
  enhance(strength: number): Promise<ImageQualityResult>;
  dispose(): void;
}
