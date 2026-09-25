import type { ImageQualityAnalysis, ImageQualityOutputScale } from "./ImageQualityEngine";
import type { GraphicClassification } from "./imageQualityPipeline";

export type ImageContentClass = "flat-graphic" | "illustration" | "photograph";

export interface ContentClassification {
  contentClass: ImageContentClass;
  confidence: number;
  rationale: string;
}

export interface ProcessingBudget {
  sourcePixels: number;
  outputPixels: number;
  maxCanvasEdge: number;
  estimatedWorkingBytes: number;
}

export interface ScalePlan {
  scale: 1 | 2 | 4;
  rationale: string;
  estimatedOutputBytes: number;
}

export function planRequestedScale(
  width: number,
  height: number,
  scale: ImageQualityOutputScale,
  budget: ProcessingBudget,
): ScalePlan {
  const outputWidth = width * scale;
  const outputHeight = height * scale;
  const outputPixels = outputWidth * outputHeight;
  const exactDimensionsAreSafe = Number.isSafeInteger(outputWidth)
    && Number.isSafeInteger(outputHeight)
    && Number.isSafeInteger(outputPixels);
  if (
    !exactDimensionsAreSafe
    || outputWidth > budget.maxCanvasEdge
    || outputHeight > budget.maxCanvasEdge
    || outputPixels > budget.outputPixels
  ) {
    const requestedMegapixels = Number.isFinite(outputPixels)
      ? (outputPixels / 1_000_000).toFixed(1)
      : "an unsupported number of";
    const budgetMegapixels = (budget.outputPixels / 1_000_000).toFixed(1);
    throw new Error(
      `The requested ${scale}× output requires ${outputWidth} × ${outputHeight} px (${requestedMegapixels} MP), `
      + `which exceeds this browser/device's verified local limit of ${budget.maxCanvasEdge} px per edge and ${budgetMegapixels} MP. `
      + "Choose 2× if it fits, or use a higher-memory processing environment. No smaller output was created.",
    );
  }
  return {
    scale,
    rationale: `${scale}× was explicitly selected and produced at the exact requested dimensions; it was not silently clamped.`,
    estimatedOutputBytes: outputPixels * 4,
  };
}

const gibibyte = 1024 ** 3;

export function classifyImageContent(
  graphic: GraphicClassification,
  analysis: ImageQualityAnalysis,
): ContentClassification {
  if (graphic.isFlatGraphic) {
    const margin = Math.min(
      (graphic.dominantPaletteFraction - 0.72) / 0.28,
      (graphic.flatNeighbourFraction - 0.72) / 0.28,
    );
    return {
      contentClass: "flat-graphic",
      confidence: clamp01(0.72 + Math.max(0, margin) * 0.28),
      rationale: "A compact palette and broad uniform regions favour contour-preserving reconstruction.",
    };
  }

  const illustrationScore = (
    clamp01((graphic.flatNeighbourFraction - 0.38) / 0.34) * 0.5
    + clamp01((graphic.dominantPaletteFraction - 0.30) / 0.42) * 0.3
    + clamp01((0.24 - analysis.noiseLevel) / 0.24) * 0.2
  );
  if (illustrationScore >= 0.52) {
    return {
      contentClass: "illustration",
      confidence: clamp01(0.55 + Math.abs(illustrationScore - 0.52)),
      rationale: "Mixed soft texture and repeated colours favour fidelity-constrained restoration.",
    };
  }
  return {
    contentClass: "photograph",
    confidence: clamp01(0.56 + (1 - illustrationScore) * 0.34),
    rationale: "Continuous colour and texture favour photographic restoration.",
  };
}

export function processingBudget(
  deviceMemoryGiB: number | undefined,
  maxCanvasEdge = 16_384,
): ProcessingBudget {
  const memoryGiB = Number.isFinite(deviceMemoryGiB) ? Math.max(1, deviceMemoryGiB!) : 4;
  // Only a bounded fraction of reported memory is claimed. Browsers, the decoded
  // source, model tensors, canvases and the OS all need headroom at the same time.
  const outputPixels = Math.floor(Math.min(140_000_000, Math.max(32_000_000, memoryGiB * gibibyte * 0.16 / 12)));
  const sourcePixels = Math.floor(Math.min(
    outputPixels,
    160_000_000,
    Math.max(24_000_000, memoryGiB * gibibyte * 0.12 / 16),
  ));
  return {
    sourcePixels,
    outputPixels,
    maxCanvasEdge,
    estimatedWorkingBytes: Math.floor(memoryGiB * gibibyte * 0.28),
  };
}

export function qualityNeed(analysis: ImageQualityAnalysis): "subtle" | "material" | "strong" {
  const score = analysis.noiseLevel * 0.35
    + (1 - analysis.edgeDefinition) * 0.30
    + (1 - analysis.tonalRange) * 0.20
    + analysis.colourCast * 0.15;
  if (score < 0.24) return "subtle";
  if (score < 0.52) return "material";
  return "strong";
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
