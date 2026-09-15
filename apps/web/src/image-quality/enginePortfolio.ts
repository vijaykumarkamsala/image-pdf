import type { ImageContentClass } from "./imageQualityPolicy";

export type EnginePurpose = "production" | "local-research";

export interface ImageQualityEngineDescriptor {
  id: string;
  version: string;
  implementation: "deterministic" | "neural";
  supportedContent: readonly ImageContentClass[];
  requiresWebGpu: boolean;
  permittedPurposes: readonly EnginePurpose[];
  weightsSha256: string | null;
}

export const IMAGE_QUALITY_ENGINE_PORTFOLIO = Object.freeze({
  deterministic: {
    id: "ipw-deterministic-image-quality",
    version: "1.0.0",
    implementation: "deterministic",
    supportedContent: ["flat-graphic", "illustration", "photograph"],
    requiresWebGpu: false,
    permittedPurposes: ["production", "local-research"],
    weightsSha256: null,
  },
  realEsrganLocalResearch: {
    id: "realesr-general-x4v3-local-research",
    version: "v0.2.5.0/onnx-tile128",
    implementation: "neural",
    supportedContent: ["illustration", "photograph"],
    requiresWebGpu: true,
    permittedPurposes: ["local-research"],
    weightsSha256: "5c5af5908e7438a965cffb1ba62a764e319aac069c35c50ba6851bb4a300760c",
  },
} satisfies Record<string, ImageQualityEngineDescriptor>);

export function selectImageQualityEngine(options: {
  contentClass: ImageContentClass;
  purpose: EnginePurpose;
  webGpuAvailable: boolean;
}): ImageQualityEngineDescriptor {
  const neural = IMAGE_QUALITY_ENGINE_PORTFOLIO.realEsrganLocalResearch;
  if (
    options.contentClass !== "flat-graphic"
    && options.webGpuAvailable
    && neural.permittedPurposes.some((purpose: EnginePurpose) => purpose === options.purpose)
    && neural.supportedContent.includes(options.contentClass)
  ) return neural;
  return IMAGE_QUALITY_ENGINE_PORTFOLIO.deterministic;
}
