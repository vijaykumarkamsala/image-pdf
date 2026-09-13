import type { ImageQualityAnalysis } from "./ImageQualityEngine";

export type QualityStatus = "empty" | "loading" | "ready" | "processing" | "success" | "error";
export type ComparisonMode = "side-by-side" | "slider";
export type QualityZoom = "fit" | 1 | 2 | 4;

export interface QualitySourceState {
  file: File;
  url: string;
  name: string;
  width: number | null;
  height: number | null;
}

export interface QualityResultState {
  url: string;
  bytes: ArrayBuffer;
  width: number;
  height: number;
  analysis: ImageQualityAnalysis;
}

export interface ImageQualitySessionState {
  status: QualityStatus;
  source: QualitySourceState | null;
  result: QualityResultState | null;
  error: string | null;
  strength: number;
  mode: ComparisonMode;
  zoom: QualityZoom;
  pan: { x: number; y: number };
  slider: number;
}

export type ImageQualitySessionAction =
  | { type: "source-selected"; source: QualitySourceState }
  | { type: "source-ready"; width: number; height: number }
  | { type: "processing-started" }
  | { type: "processing-succeeded"; result: QualityResultState }
  | { type: "processing-failed"; message: string }
  | { type: "reset" }
  | { type: "strength-changed"; strength: number }
  | { type: "mode-changed"; mode: ComparisonMode }
  | { type: "zoom-changed"; zoom: QualityZoom }
  | { type: "pan-changed"; x: number; y: number }
  | { type: "slider-changed"; slider: number };

export const initialImageQualitySession: ImageQualitySessionState = {
  status: "empty",
  source: null,
  result: null,
  error: null,
  strength: 65,
  mode: "side-by-side",
  zoom: "fit",
  pan: { x: 0, y: 0 },
  slider: 50,
};

export function imageQualitySessionReducer(
  state: ImageQualitySessionState,
  action: ImageQualitySessionAction,
): ImageQualitySessionState {
  switch (action.type) {
    case "source-selected":
      return { ...initialImageQualitySession, status: "loading", source: action.source };
    case "source-ready":
      return state.source ? {
        ...state,
        status: "ready",
        error: null,
        source: { ...state.source, width: action.width, height: action.height },
      } : state;
    case "processing-started":
      return state.source ? { ...state, status: "processing", error: null } : state;
    case "processing-succeeded":
      return state.source ? { ...state, status: "success", result: action.result, error: null } : state;
    case "processing-failed":
      return state.source ? { ...state, status: "error", error: action.message } : state;
    case "reset":
      return state.source ? {
        ...state,
        status: state.source.width && state.source.height ? "ready" : "loading",
        result: null,
        error: null,
        zoom: "fit",
        pan: { x: 0, y: 0 },
        slider: 50,
      } : state;
    case "strength-changed":
      return { ...state, strength: action.strength };
    case "mode-changed":
      return { ...state, mode: action.mode, pan: { x: 0, y: 0 } };
    case "zoom-changed":
      return { ...state, zoom: action.zoom, pan: { x: 0, y: 0 } };
    case "pan-changed":
      return { ...state, pan: { x: action.x, y: action.y } };
    case "slider-changed":
      return { ...state, slider: action.slider };
  }
}
