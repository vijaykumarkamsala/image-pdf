import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import {
  Columns2,
  Image as ImageIcon,
  SlidersHorizontal,
  Sparkles,
  Upload,
} from "lucide-react";

import { Button, Dropzone, InlineNotice } from "../design-system";
import { IMAGE_QUALITY_INPUT_TYPES } from "./ImageQualityEngine";
import type { ImageQualityEngine } from "./ImageQualityEngine";
import {
  ColorToolPanel,
  EnhancementToolPanel,
  GeometryToolPanel,
  ImageEditorInspector,
  ImageEditorToolRail,
  ToneToolPanel,
  type ImageEditorTool,
} from "./ImageEditorWorkspacePanels";
import { createImageQualityEngine } from "./ProductionImageQualityEngine";
import { FaceDetailPanel } from "./FaceDetailPanel";
import { NativeFaceDetailPanel } from "./NativeFaceDetailPanel";
import type { NativeFaceRemoteContext } from "./NativeFaceQualityClient";
import { assertPngDimensions } from "./pngMetadata";
import type { PngGeometryMetadata } from "./pngMetadata";
import type { FaceReviewInput } from "./WorkerFaceReviewRenderer";
import { CropSelectionEditor } from "./CropSelectionEditor";
import {
  createIdentityGeometry,
  geometryOutputDimensions,
  isIdentityGeometry,
  sameGeometry,
  sanitizeGeometryRecipe,
  scaledCropRect,
  type ImageCropAspect,
  type ImageGeometryRecipe,
} from "./imageGeometry";
import { WorkerImageGeometryEngine, type ImageGeometryResult } from "./WorkerImageGeometryEngine";
import {
  createNeutralToneRecipe,
  isNeutralTone,
  sameToneRecipe,
  sanitizeToneRecipe,
  type ImageToneRecipe,
} from "./imageTone";
import { WorkerImageToneEngine, type ImageToneResult } from "./WorkerImageToneEngine";
import {
  createNeutralColorRecipe,
  isNeutralColor,
  sameColorRecipe,
  sanitizeColorRecipe,
  type ImageColorRecipe,
  type ImageWhiteBalanceSuggestion,
} from "./imageColor";
import { WorkerImageColorEngine, type ImageColorResult } from "./WorkerImageColorEngine";
import type { ImageHistogramInput } from "./ImageHistogramPanel";
import {
  imageQualitySessionReducer,
  initialImageQualitySession,
  type QualityZoom,
} from "./imageQualitySession";
import { clampViewerPan } from "./viewerGeometry";
import "./image-quality-editor.css";

const qualityZooms: Array<{ label: string; value: QualityZoom }> = [
  { label: "Fit", value: "fit" },
  { label: "100%", value: 1 },
  { label: "200%", value: 2 },
  { label: "400%", value: 4 },
];

function downloadName(filename: string, scale: 1 | 2 | 4) {
  const stem = filename.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${stem || "image"}-enhanced-${scale}x.png`;
}

function editedDownloadName(filename: string, width: number, height: number) {
  const stem = filename.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${stem || "image"}-edited-${width}x${height}.png`;
}

function adjustedDownloadName(filename: string, width: number, height: number) {
  const stem = filename.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${stem || "image"}-adjusted-${width}x${height}.png`;
}

function colorAdjustedDownloadName(filename: string, width: number, height: number) {
  const stem = filename.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${stem || "image"}-colour-adjusted-${width}x${height}.png`;
}

interface GeometryDerivative extends ImageGeometryResult {
  url: string;
  baseKind: "original" | "enhanced";
}

interface ToneDerivative extends ImageToneResult {
  url: string;
  baseOutputSha256: string;
  baseKind: "original" | "enhanced" | "geometry-original" | "geometry-enhanced";
}

interface ColorDerivative extends ImageColorResult {
  url: string;
  baseOutputSha256: string;
  baseKind: "original" | "enhanced" | "geometry-original" | "geometry-enhanced" | "tone";
}

interface WhiteBalanceReview extends ImageWhiteBalanceSuggestion {
  normalizedX: number;
  normalizedY: number;
  baseOutputSha256: string;
  baseLabel: string;
}

interface ColorBaseInput {
  blob: Blob;
  outputSha256: string;
  kind: ColorDerivative["baseKind"];
  route: string;
  strength: number | null;
  scale: number;
  width: number;
  height: number;
  label: string;
}

function useFrameSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1, height: 1 });
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => setSize({ width: node.clientWidth, height: node.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, size };
}

function viewerTransform(
  frameWidth: number,
  frameHeight: number,
  imageWidth: number,
  imageHeight: number,
  zoom: QualityZoom,
  pan: { x: number; y: number },
) {
  const fitScale = Math.min(1, Math.max(0.01, (frameWidth - 24) / imageWidth), Math.max(0.01, (frameHeight - 24) / imageHeight));
  const scale = zoom === "fit" ? fitScale : zoom;
  return {
    scale,
    style: {
      width: `${imageWidth}px`,
      height: `${imageHeight}px`,
      transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
      imageRendering: zoom === "fit" ? "auto" : "pixelated",
    } satisfies CSSProperties,
  };
}

interface ViewerProps {
  sourceUrl: string;
  enhancedUrl: string;
  filename: string;
  width: number;
  height: number;
  zoom: QualityZoom;
  pan: { x: number; y: number };
  onPan: (x: number, y: number) => void;
  label: string;
  enhanced?: boolean;
  overlay?: { slider: number };
  whiteBalanceSampler?: {
    active: boolean;
    point: { x: number; y: number } | null;
    onSample: (normalizedX: number, normalizedY: number) => void;
  };
}

function ComparisonViewer({
  sourceUrl,
  enhancedUrl,
  filename,
  width,
  height,
  zoom,
  pan,
  onPan,
  label,
  enhanced = false,
  overlay,
  whiteBalanceSampler,
}: ViewerProps) {
  const { ref, size } = useFrameSize();
  const drag = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number } | null>(null);
  const transform = viewerTransform(size.width, size.height, width, height, zoom, pan);
  const normalizedPointAt = (clientX: number, clientY: number) => {
    const bounds = ref.current?.getBoundingClientRect();
    if (!bounds) return null;
    const imageLeft = bounds.left + size.width / 2 + pan.x - width * transform.scale / 2;
    const imageTop = bounds.top + size.height / 2 + pan.y - height * transform.scale / 2;
    const normalizedX = (clientX - imageLeft) / (width * transform.scale);
    const normalizedY = (clientY - imageTop) / (height * transform.scale);
    if (normalizedX < 0 || normalizedX > 1 || normalizedY < 0 || normalizedY > 1) return null;
    return { x: normalizedX, y: normalizedY };
  };
  const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (whiteBalanceSampler?.active) {
      const point = normalizedPointAt(event.clientX, event.clientY);
      if (point) whiteBalanceSampler.onSample(point.x, point.y);
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
  };
  const stopPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  };
  const moveTo = (x: number, y: number) => {
    const next = clampViewerPan({
      frameWidth: size.width,
      frameHeight: size.height,
      imageWidth: width,
      imageHeight: height,
      scale: transform.scale,
    }, { x, y });
    onPan(next.x, next.y);
  };
  const keyboardPan = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (whiteBalanceSampler?.active && (event.key === "Enter" || event.key === " ")) {
      const bounds = ref.current?.getBoundingClientRect();
      if (!bounds) return;
      const point = normalizedPointAt(bounds.left + size.width / 2, bounds.top + size.height / 2);
      if (!point) return;
      event.preventDefault();
      whiteBalanceSampler.onSample(point.x, point.y);
      return;
    }
    const step = event.shiftKey ? 80 : 24;
    const delta = event.key === "ArrowLeft" ? { x: step, y: 0 }
      : event.key === "ArrowRight" ? { x: -step, y: 0 }
        : event.key === "ArrowUp" ? { x: 0, y: step }
          : event.key === "ArrowDown" ? { x: 0, y: -step }
            : null;
    if (!delta) return;
    event.preventDefault();
    moveTo(pan.x + delta.x, pan.y + delta.y);
  };

  return <div
    ref={ref}
    className={`quality-viewer${overlay ? " quality-viewer-slider" : ""}${whiteBalanceSampler?.active ? " quality-viewer-sampling" : ""}`}
    data-testid={overlay ? "comparison-slider-view" : `comparison-${enhanced ? "enhanced" : "original"}`}
    data-scale={transform.scale.toFixed(6)}
    tabIndex={0}
    role="group"
    aria-label={`${label} image viewer. Use arrow keys to pan when zoomed.${whiteBalanceSampler?.active ? " Select a neutral point, or press Enter to sample the viewer centre." : ""}`}
    onPointerDown={startPan}
    onPointerMove={(event) => {
      const active = drag.current;
      if (!active || active.pointerId !== event.pointerId) return;
      moveTo(active.panX + event.clientX - active.x, active.panY + event.clientY - active.y);
    }}
    onPointerUp={stopPan}
    onPointerCancel={stopPan}
    onKeyDown={keyboardPan}
  >
    <span className="quality-viewer-label">{label}</span>
    {overlay ? <>
      <img
        data-testid="slider-original-image"
        className="quality-image"
        src={sourceUrl}
        alt={`Original ${filename}`}
        draggable={false}
        style={transform.style}
      />
      <div className="quality-enhanced-clip" style={{ clipPath: `inset(0 ${100 - overlay.slider}% 0 0)` }}>
        <img
          data-testid="slider-enhanced-image"
          className="quality-image"
          src={enhancedUrl}
          alt={`Enhanced ${filename}`}
          draggable={false}
          style={transform.style}
        />
      </div>
      <span className="quality-slider-line" style={{ left: `${overlay.slider}%` }} aria-hidden="true" />
    </> : <img
      data-testid={enhanced ? "enhanced-image" : "original-image"}
      className="quality-image"
      src={enhanced ? enhancedUrl : sourceUrl}
      alt={`${enhanced ? "Enhanced" : "Original"} ${filename}`}
      draggable={false}
      style={transform.style}
    />}
    {whiteBalanceSampler?.point && <span
      className="quality-white-balance-marker"
      data-testid="white-balance-marker"
      aria-hidden="true"
      style={{
        left: `calc(50% + ${pan.x + (whiteBalanceSampler.point.x - 0.5) * width * transform.scale}px)`,
        top: `calc(50% + ${pan.y + (whiteBalanceSampler.point.y - 0.5) * height * transform.scale}px)`,
      }}
    />}
  </div>;
}

export function ImageQualityEditorPage() {
  const navigate = useNavigate();
  const [state, dispatch] = useReducer(imageQualitySessionReducer, initialImageQualitySession);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [processorRestarting, setProcessorRestarting] = useState(false);
  const [faceDetailRevision, setFaceDetailRevision] = useState(0);
  const [activeTool, setActiveTool] = useState<ImageEditorTool>("enhance");
  const [cropAspect, setCropAspect] = useState<ImageCropAspect>("original");
  const [resizeAspectLocked, setResizeAspectLocked] = useState(true);
  const [geometrySelectionOpen, setGeometrySelectionOpen] = useState(false);
  const [geometryRecipe, setGeometryRecipe] = useState<ImageGeometryRecipe | null>(null);
  const [appliedGeometry, setAppliedGeometry] = useState<ImageGeometryRecipe | null>(null);
  const [geometryOriginal, setGeometryOriginal] = useState<GeometryDerivative | null>(null);
  const [geometryEdited, setGeometryEdited] = useState<GeometryDerivative | null>(null);
  const [geometryBusy, setGeometryBusy] = useState(false);
  const [geometryError, setGeometryError] = useState<string | null>(null);
  const [geometryMessage, setGeometryMessage] = useState<string | null>(null);
  const [toneRecipe, setToneRecipe] = useState<ImageToneRecipe>(createNeutralToneRecipe);
  const [appliedTone, setAppliedTone] = useState<ImageToneRecipe | null>(null);
  const [toneResult, setToneResult] = useState<ToneDerivative | null>(null);
  const [toneBusy, setToneBusy] = useState(false);
  const [toneError, setToneError] = useState<string | null>(null);
  const [toneMessage, setToneMessage] = useState<string | null>(null);
  const [colorRecipe, setColorRecipe] = useState<ImageColorRecipe>(createNeutralColorRecipe);
  const [appliedColor, setAppliedColor] = useState<ImageColorRecipe | null>(null);
  const [colorResult, setColorResult] = useState<ColorDerivative | null>(null);
  const [colorBusy, setColorBusy] = useState(false);
  const [colorError, setColorError] = useState<string | null>(null);
  const [colorMessage, setColorMessage] = useState<string | null>(null);
  const [whiteBalanceReview, setWhiteBalanceReview] = useState<WhiteBalanceReview | null>(null);
  const [whiteBalancePicking, setWhiteBalancePicking] = useState(false);
  const [whiteBalanceAnalysing, setWhiteBalanceAnalysing] = useState(false);
  const [whiteBalanceSuggestionUsed, setWhiteBalanceSuggestionUsed] = useState(false);
  const engine = useRef<ImageQualityEngine | null>(null);
  const originalGeometryEngine = useRef<WorkerImageGeometryEngine | null>(null);
  const enhancedGeometryEngine = useRef<WorkerImageGeometryEngine | null>(null);
  const toneEngine = useRef<WorkerImageToneEngine | null>(null);
  const colorEngine = useRef<WorkerImageColorEngine | null>(null);
  const selection = useRef(0);
  const operation = useRef(0);
  const geometryOperation = useRef(0);
  const toneOperation = useRef(0);
  const colorOperation = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const sourceObjectUrl = useRef<string | null>(null);
  const resultObjectUrl = useRef<string | null>(null);
  const resultBlob = useRef<Blob | null>(null);
  const geometryOriginalObjectUrl = useRef<string | null>(null);
  const geometryEditedObjectUrl = useRef<string | null>(null);
  const toneObjectUrl = useRef<string | null>(null);
  const colorObjectUrl = useRef<string | null>(null);
  const deterministicPreference = useRef(false);

  // Reuse the already-created result Blob. Pan/zoom must not copy a large pixel buffer.
  const faceReviewInput = useMemo<FaceReviewInput | undefined>(() => {
    const source = state.source; const result = state.result;
    if (!source?.facts || !source.width || !source.height || !result?.bytes || !resultBlob.current) return undefined;
    return { original: source.file, base: resultBlob.current,
      context: { sourceSha256: source.facts.sourceSha256, baseOutputSha256: result.outputSha256,
        sourceWidth: source.width, sourceHeight: source.height, outputWidth: result.width, outputHeight: result.height },
      metadata: { sourceSha256: result.sourceSha256, engineId: result.model.id,
        engineVersion: result.model.version, route: result.route, strength: result.strength,
        scale: result.scale, modelSha256: result.model.sha256, usage: result.model.usage,
        contentClass: result.contentClass, classificationConfidence: result.classificationConfidence,
        outputWidth: result.width, outputHeight: result.height },
    };
  }, [state.source, state.result]);
  const nativeFaceContext = useMemo<NativeFaceRemoteContext | undefined>(() => {
    const source = state.source; const result = state.result;
    if (!source?.facts || !result?.remoteContext) return undefined;
    return {
      uploadSessionId: result.remoteContext.uploadSessionId,
      baseImageQualityRequestId: result.remoteContext.imageQualityRequestId,
      sourceSha256: source.facts.sourceSha256,
      baseOutputSha256: result.outputSha256,
    };
  }, [state.source, state.result]);

  useEffect(() => () => {
    selection.current += 1;
    operation.current += 1;
    geometryOperation.current += 1;
    toneOperation.current += 1;
    colorOperation.current += 1;
    engine.current?.dispose();
    originalGeometryEngine.current?.dispose();
    enhancedGeometryEngine.current?.dispose();
    toneEngine.current?.dispose();
    colorEngine.current?.dispose();
    if (sourceObjectUrl.current) URL.revokeObjectURL(sourceObjectUrl.current);
    if (resultObjectUrl.current) URL.revokeObjectURL(resultObjectUrl.current);
    if (geometryOriginalObjectUrl.current) URL.revokeObjectURL(geometryOriginalObjectUrl.current);
    if (geometryEditedObjectUrl.current) URL.revokeObjectURL(geometryEditedObjectUrl.current);
    if (toneObjectUrl.current) URL.revokeObjectURL(toneObjectUrl.current);
    if (colorObjectUrl.current) URL.revokeObjectURL(colorObjectUrl.current);
  }, []);

  const clearWhiteBalanceReview = () => {
    setWhiteBalanceReview(null);
    setWhiteBalancePicking(false);
    setWhiteBalanceAnalysing(false);
    setWhiteBalanceSuggestionUsed(false);
  };

  const clearColorDerivative = () => {
    if (colorObjectUrl.current) URL.revokeObjectURL(colorObjectUrl.current);
    colorObjectUrl.current = null;
    setColorResult(null);
    setAppliedColor(null);
  };

  const disposeColorEngine = () => {
    colorEngine.current?.dispose();
    colorEngine.current = null;
  };

  const invalidateColorDerivative = (message: string) => {
    colorOperation.current += 1;
    disposeColorEngine();
    setColorBusy(false);
    setColorError(null);
    clearWhiteBalanceReview();
    clearColorDerivative();
    setColorMessage(isNeutralColor(colorRecipe) ? null : message);
  };

  const clearToneDerivative = () => {
    if (toneObjectUrl.current) URL.revokeObjectURL(toneObjectUrl.current);
    toneObjectUrl.current = null;
    setToneResult(null);
    setAppliedTone(null);
  };

  const disposeToneEngine = () => {
    toneEngine.current?.dispose();
    toneEngine.current = null;
  };

  const invalidateToneDerivative = (message: string) => {
    toneOperation.current += 1;
    disposeToneEngine();
    setToneBusy(false);
    setToneError(null);
    clearToneDerivative();
    setToneMessage(isNeutralTone(toneRecipe) ? null : message);
    invalidateColorDerivative("An earlier processing stage changed. Apply the colour recipe again to update the final derivative.");
  };

  const clearGeometryDerivatives = () => {
    if (geometryOriginalObjectUrl.current) URL.revokeObjectURL(geometryOriginalObjectUrl.current);
    if (geometryEditedObjectUrl.current) URL.revokeObjectURL(geometryEditedObjectUrl.current);
    geometryOriginalObjectUrl.current = null;
    geometryEditedObjectUrl.current = null;
    setGeometryOriginal(null);
    setGeometryEdited(null);
    setAppliedGeometry(null);
  };

  const disposeGeometryEngines = () => {
    originalGeometryEngine.current?.dispose();
    enhancedGeometryEngine.current?.dispose();
    originalGeometryEngine.current = null;
    enhancedGeometryEngine.current = null;
  };

  const selectFile = async (files: File[]) => {
    const file = files[0];
    const supportedExtension = file ? /\.(?:jpe?g|png|webp)$/i.test(file.name) : false;
    const supportedType = file ? IMAGE_QUALITY_INPUT_TYPES.includes(file.type as typeof IMAGE_QUALITY_INPUT_TYPES[number]) : false;
    if (!file || (!supportedType && !supportedExtension)) {
      setUploadError("Choose a JPEG, PNG or WebP image.");
      return;
    }
    setUploadError(null);
    setProcessorRestarting(false);
    setFaceDetailRevision((revision) => revision + 1);
    setActiveTool("enhance");
    setCropAspect("original");
    setResizeAspectLocked(true);
    setGeometrySelectionOpen(false);
    setGeometryRecipe(null);
    setGeometryBusy(false);
    setGeometryError(null);
    setGeometryMessage(null);
    setToneRecipe(createNeutralToneRecipe());
    setToneBusy(false);
    setToneError(null);
    setToneMessage(null);
    setColorRecipe(createNeutralColorRecipe());
    setColorBusy(false);
    setColorError(null);
    setColorMessage(null);
    clearWhiteBalanceReview();
    clearColorDerivative();
    disposeColorEngine();
    clearToneDerivative();
    disposeToneEngine();
    clearGeometryDerivatives();
    disposeGeometryEngines();
    selection.current += 1;
    operation.current += 1;
    geometryOperation.current += 1;
    toneOperation.current += 1;
    colorOperation.current += 1;
    const currentSelection = selection.current;
    const preferDeterministic = new URLSearchParams(globalThis.location.search).get("engine") === "deterministic";
    deterministicPreference.current = preferDeterministic;
    // A worker captures the configured processing route when it is constructed.
    // Replace it for every source selection so an editor tab kept open across a
    // development-mode restart cannot silently retain the previous route.
    engine.current?.dispose();
    engine.current = null;
    if (sourceObjectUrl.current) URL.revokeObjectURL(sourceObjectUrl.current);
    if (resultObjectUrl.current) URL.revokeObjectURL(resultObjectUrl.current);
    resultObjectUrl.current = null;
    resultBlob.current = null;
    const url = URL.createObjectURL(file);
    sourceObjectUrl.current = url;
    dispatch({ type: "source-selected", source: { file, url, name: file.name, width: null, height: null, facts: null } });
    navigate("/image-quality/editor");
    try {
      engine.current = createImageQualityEngine({ preferDeterministic });
      const loaded = await engine.current.load(file, {
        onProgress: (progress) => {
          if (selection.current === currentSelection) dispatch({ type: "processing-progress", progress });
        },
      });
      if (selection.current === currentSelection) {
        dispatch({ type: "source-ready", facts: loaded });
        setGeometryRecipe(createIdentityGeometry(loaded.width, loaded.height));
      }
    } catch (error) {
      if (selection.current === currentSelection) {
        engine.current?.dispose();
        engine.current = null;
        dispatch({
          type: "processing-failed",
          message: error instanceof Error ? error.message : "This image could not be prepared.",
        });
      }
    }
  };

  const enhance = async () => {
    if (!state.source || !engine.current || state.status === "processing" || geometryBusy || toneBusy || colorBusy) return;
    dispatch({ type: "processing-started" });
    const currentOperation = ++operation.current;
    try {
      const result = await engine.current.enhance(state.strength, {
        outputScale: state.outputScale,
        onProgress: (progress) => {
          if (operation.current === currentOperation) dispatch({ type: "processing-progress", progress });
        },
      });
      if (operation.current !== currentOperation) return;
      const expectedWidth = state.source.width! * state.outputScale;
      const expectedHeight = state.source.height! * state.outputScale;
      if (result.bytes) assertPngDimensions(new Uint8Array(result.bytes), expectedWidth, expectedHeight);
      if (result.width !== expectedWidth || result.height !== expectedHeight || result.scale !== state.outputScale) {
        throw new Error(
          `The processor returned ${result.width} × ${result.height} px instead of the requested exact ${state.outputScale}× `
          + `output (${expectedWidth} × ${expectedHeight} px). No smaller output was accepted.`,
        );
      }
      const blob = result.bytes ? new Blob([result.bytes], { type: result.mediaType }) : null;
      const url = blob
        ? URL.createObjectURL(blob)
        : result.remoteViewUrl;
      if (!url) throw new Error("The processed image has no authorised viewing source.");
      if (resultObjectUrl.current) URL.revokeObjectURL(resultObjectUrl.current);
      resultObjectUrl.current = result.bytes ? url : null;
      resultBlob.current = blob;
      enhancedGeometryEngine.current?.dispose();
      enhancedGeometryEngine.current = null;
      if (geometryEditedObjectUrl.current) URL.revokeObjectURL(geometryEditedObjectUrl.current);
      geometryEditedObjectUrl.current = null;
      setGeometryEdited(null);
      if (appliedGeometry) setGeometryMessage("Enhancement changed. Apply the geometry recipe again to update the combined derivative.");
      invalidateToneDerivative("Enhancement changed. Apply the light-and-tone recipe again to update the adjusted derivative.");
      dispatch({ type: "processing-succeeded", result: { ...result, url } });
    } catch (error) {
      if (operation.current !== currentOperation) return;
      dispatch({
        type: "processing-failed",
        message: error instanceof Error ? error.message : "Enhancement did not complete. Your original is unchanged.",
      });
    }
  };

  const cancel = () => {
    if (state.status !== "processing" || !state.source) return;
    operation.current += 1;
    engine.current?.cancel();
    engine.current = null;
    dispatch({ type: "processing-cancelled" });
    setProcessorRestarting(true);
    const currentSelection = selection.current;
    const replacement = createImageQualityEngine({ preferDeterministic: deterministicPreference.current });
    engine.current = replacement;
    void replacement.load(state.source.file).then((facts) => {
      if (selection.current === currentSelection && engine.current === replacement) {
        dispatch({ type: "source-ready", facts });
        setProcessorRestarting(false);
      }
    }).catch((error) => {
      if (selection.current === currentSelection && engine.current === replacement) {
        replacement.dispose();
        engine.current = null;
        setProcessorRestarting(false);
        dispatch({
          type: "processing-failed",
          message: error instanceof Error ? error.message : "The image processor could not restart.",
        });
      }
    });
  };

  const applyGeometry = async () => {
    const source = state.source;
    if (!source?.facts || !source.width || !source.height || !geometryRecipe || geometryBusy || toneBusy || colorBusy || processing) return;
    const safe = sanitizeGeometryRecipe(geometryRecipe, source.width, source.height, Math.min(32, source.width, source.height));
    if (isIdentityGeometry(safe, source.width, source.height)) return;
    if (state.result && (state.result.strength !== state.strength || state.result.scale !== state.outputScale)) {
      setGeometryError("Enhancement settings changed. Enhance again or reset the enhancement before applying geometry.");
      return;
    }
    const currentGeometryOperation = ++geometryOperation.current;
    setGeometryBusy(true);
    setGeometryError(null);
    setGeometryMessage("Rendering the source-bound transform recipe…");
    try {
      if (!originalGeometryEngine.current) {
        const next = new WorkerImageGeometryEngine();
        const loaded = await next.load(source.file);
        if (loaded.width !== source.width || loaded.height !== source.height) {
          next.dispose();
          throw new Error(`The geometry decoder returned ${loaded.width} × ${loaded.height} px instead of ${source.width} × ${source.height} px.`);
        }
        originalGeometryEngine.current = next;
      }

      const originalDimensions = geometryOutputDimensions(safe);
      const originalMetadata: PngGeometryMetadata = {
        sourceSha256: source.facts.sourceSha256,
        baseOutputSha256: source.facts.sourceSha256,
        baseKind: "original",
        baseRoute: "immutable-original",
        baseStrength: null,
        baseScale: 1,
        crop: safe.crop,
        quarterTurns: safe.quarterTurns,
        straighten: safe.straighten,
        flipHorizontal: safe.flipHorizontal,
        flipVertical: safe.flipVertical,
        perspective: safe.perspective,
        resize: safe.resize,
        outputWidth: originalDimensions.width,
        outputHeight: originalDimensions.height,
      };
      const originalPromise = originalGeometryEngine.current.render(safe, originalMetadata);

      let enhancedPromise: Promise<ImageGeometryResult> | null = null;
      if (state.result) {
        const enhancedBlob = resultBlob.current;
        if (!enhancedBlob) {
          throw new Error("This remote enhancement needs the future cloud geometry route. The original remains unchanged; no partial derivative was created.");
        }
        if (!enhancedGeometryEngine.current) {
          const next = new WorkerImageGeometryEngine();
          const loaded = await next.load(enhancedBlob);
          if (loaded.width !== state.result.width || loaded.height !== state.result.height) {
            next.dispose();
            throw new Error("The enhanced geometry source did not match its verified output dimensions.");
          }
          enhancedGeometryEngine.current = next;
        }
        const scaledRecipe = { ...safe, crop: scaledCropRect(safe.crop, state.result.scale) };
        const enhancedDimensions = geometryOutputDimensions(safe, state.result.scale);
        enhancedPromise = enhancedGeometryEngine.current.render(scaledRecipe, {
          sourceSha256: source.facts.sourceSha256,
          baseOutputSha256: state.result.outputSha256,
          baseKind: "enhanced",
          baseRoute: state.result.route,
          baseStrength: state.result.strength,
          baseScale: state.result.scale,
          crop: safe.crop,
          quarterTurns: safe.quarterTurns,
          straighten: safe.straighten,
          flipHorizontal: safe.flipHorizontal,
          flipVertical: safe.flipVertical,
          perspective: safe.perspective,
          resize: safe.resize,
          outputWidth: enhancedDimensions.width,
          outputHeight: enhancedDimensions.height,
        });
      }

      const [originalResult, enhancedResult] = await Promise.all([
        originalPromise,
        enhancedPromise ?? Promise.resolve(null),
      ]);
      if (geometryOperation.current !== currentGeometryOperation) return;
      assertPngDimensions(new Uint8Array(originalResult.bytes), originalResult.width, originalResult.height);
      if (enhancedResult) assertPngDimensions(new Uint8Array(enhancedResult.bytes), enhancedResult.width, enhancedResult.height);

      const originalUrl = URL.createObjectURL(new Blob([originalResult.bytes], { type: "image/png" }));
      const enhancedUrl = enhancedResult
        ? URL.createObjectURL(new Blob([enhancedResult.bytes], { type: "image/png" }))
        : null;
      if (geometryOriginalObjectUrl.current) URL.revokeObjectURL(geometryOriginalObjectUrl.current);
      if (geometryEditedObjectUrl.current) URL.revokeObjectURL(geometryEditedObjectUrl.current);
      geometryOriginalObjectUrl.current = originalUrl;
      geometryEditedObjectUrl.current = enhancedUrl;
      setGeometryOriginal({ ...originalResult, url: originalUrl, baseKind: "original" });
      setGeometryEdited(enhancedResult && enhancedUrl
        ? { ...enhancedResult, url: enhancedUrl, baseKind: "enhanced" }
        : null);
      setGeometryRecipe(safe);
      setAppliedGeometry(safe);
      setGeometrySelectionOpen(false);
      setGeometryMessage(state.result
        ? "Combined enhancement and geometry derivative ready. Preview and download use the same verified PNG bytes."
        : "Geometry derivative ready from the immutable original. Preview and download use the same verified PNG bytes.");
      invalidateToneDerivative("Geometry changed. Apply the light-and-tone recipe again to update the adjusted derivative.");
      dispatch({ type: "zoom-changed", zoom: "fit" });
    } catch (error) {
      if (geometryOperation.current !== currentGeometryOperation) return;
      setGeometryError(error instanceof Error ? error.message : "The geometry edit could not be rendered.");
      setGeometryMessage(null);
    } finally {
      if (geometryOperation.current === currentGeometryOperation) setGeometryBusy(false);
    }
  };

  const applyTone = async () => {
    const source = state.source;
    const safe = sanitizeToneRecipe(toneRecipe);
    if (!source?.facts || !source.width || !source.height || toneBusy || colorBusy || processing || geometryBusy) return;
    if (isNeutralTone(safe)) return;
    const enhancementIsStale = Boolean(state.result && (
      state.result.strength !== state.strength || state.result.scale !== state.outputScale
    ));
    if (enhancementIsStale) {
      setToneError("Enhancement settings changed. Enhance again or reset the enhancement before applying light adjustments.");
      return;
    }
    const geometryCurrent = Boolean(
      geometryRecipe && sameGeometry(appliedGeometry, geometryRecipe)
      && geometryOriginal && (!state.result || geometryEdited),
    );
    if (appliedGeometry && !geometryCurrent) {
      setToneError("Geometry settings changed. Apply or reset geometry before applying light adjustments.");
      return;
    }

    let baseBlob: Blob;
    let baseOutputSha256: string;
    let baseKind: ToneDerivative["baseKind"];
    let baseRoute: string;
    let baseStrength: number | null;
    let baseScale: number;
    let width: number;
    let height: number;
    if (geometryCurrent) {
      const derivative = state.result ? geometryEdited! : geometryOriginal!;
      baseBlob = new Blob([derivative.bytes], { type: "image/png" });
      baseOutputSha256 = derivative.outputSha256;
      baseKind = state.result ? "geometry-enhanced" : "geometry-original";
      baseRoute = state.result ? `geometry:${state.result.route}` : "geometry:immutable-original";
      baseStrength = state.result?.strength ?? null;
      baseScale = state.result?.scale ?? 1;
      width = derivative.width;
      height = derivative.height;
    } else if (state.result) {
      if (!resultBlob.current) {
        setToneError("This remote enhancement needs the future cloud adjustment route. The original remains unchanged; no partial derivative was created.");
        return;
      }
      baseBlob = resultBlob.current;
      baseOutputSha256 = state.result.outputSha256;
      baseKind = "enhanced";
      baseRoute = state.result.route;
      baseStrength = state.result.strength;
      baseScale = state.result.scale;
      width = state.result.width;
      height = state.result.height;
    } else {
      baseBlob = source.file;
      baseOutputSha256 = source.facts.sourceSha256;
      baseKind = "original";
      baseRoute = "immutable-original";
      baseStrength = null;
      baseScale = 1;
      width = source.width;
      height = source.height;
    }

    const currentToneOperation = ++toneOperation.current;
    disposeToneEngine();
    const next = new WorkerImageToneEngine();
    toneEngine.current = next;
    setToneBusy(true);
    setToneError(null);
    setToneMessage("Rendering deterministic light-and-tone adjustments from the latest verified base…");
    try {
      const loaded = await next.load(baseBlob);
      if (loaded.width !== width || loaded.height !== height) {
        throw new Error(`The adjustment decoder returned ${loaded.width} × ${loaded.height} px instead of ${width} × ${height} px.`);
      }
      const result = await next.render(safe, {
        sourceSha256: source.facts.sourceSha256,
        baseOutputSha256,
        baseKind,
        baseRoute,
        baseStrength,
        baseScale,
        outputWidth: width,
        outputHeight: height,
      });
      if (toneOperation.current !== currentToneOperation) return;
      assertPngDimensions(new Uint8Array(result.bytes), width, height);
      const url = URL.createObjectURL(new Blob([result.bytes], { type: "image/png" }));
      if (toneObjectUrl.current) URL.revokeObjectURL(toneObjectUrl.current);
      toneObjectUrl.current = url;
      setToneRecipe(safe);
      setAppliedTone(safe);
      setToneResult({ ...result, url, baseOutputSha256, baseKind });
      setToneMessage("Light-and-tone derivative ready. Preview and download use the same verified PNG bytes.");
      invalidateColorDerivative("Light and tone changed. Apply the colour recipe again to update the final derivative.");
      dispatch({ type: "zoom-changed", zoom: "fit" });
    } catch (error) {
      if (toneOperation.current !== currentToneOperation) return;
      setToneError(error instanceof Error ? error.message : "The light adjustment could not be rendered.");
      setToneMessage(null);
    } finally {
      if (toneOperation.current === currentToneOperation) {
        setToneBusy(false);
        next.dispose();
        if (toneEngine.current === next) toneEngine.current = null;
      }
    }
  };

  const resetToneState = (invalidateColor: boolean) => {
    toneOperation.current += 1;
    disposeToneEngine();
    setToneBusy(false);
    setToneError(null);
    setToneMessage(null);
    setToneRecipe(createNeutralToneRecipe());
    clearToneDerivative();
    if (invalidateColor) {
      invalidateColorDerivative("Light and tone changed. Apply the colour recipe again to update the final derivative.");
    }
    dispatch({ type: "zoom-changed", zoom: "fit" });
  };

  const resetTone = () => resetToneState(true);

  const resolveColorBase = (): ColorBaseInput | null => {
    const source = state.source;
    if (!source?.facts || !source.width || !source.height || resultIsStale || geometryIsDirty || toneIsDirty) return null;
    if (toneDisplayReady && toneResult) {
      return {
        blob: new Blob([toneResult.bytes], { type: "image/png" }),
        outputSha256: toneResult.outputSha256,
        kind: "tone",
        route: `tone:${toneResult.baseKind}`,
        strength: state.result?.strength ?? null,
        scale: state.result?.scale ?? 1,
        width: toneResult.width,
        height: toneResult.height,
        label: "verified light-and-tone derivative",
      };
    }
    if (geometryDisplayReady) {
      const derivative = state.result ? geometryEdited! : geometryOriginal!;
      return {
        blob: new Blob([derivative.bytes], { type: "image/png" }),
        outputSha256: derivative.outputSha256,
        kind: state.result ? "geometry-enhanced" : "geometry-original",
        route: state.result ? `geometry:${state.result.route}` : "geometry:immutable-original",
        strength: state.result?.strength ?? null,
        scale: state.result?.scale ?? 1,
        width: derivative.width,
        height: derivative.height,
        label: state.result ? "verified geometry-adjusted enhancement" : "verified geometry-adjusted original",
      };
    }
    if (state.result) {
      if (!resultBlob.current) return null;
      return {
        blob: resultBlob.current,
        outputSha256: state.result.outputSha256,
        kind: "enhanced",
        route: state.result.route,
        strength: state.result.strength,
        scale: state.result.scale,
        width: state.result.width,
        height: state.result.height,
        label: "verified enhancement",
      };
    }
    return {
      blob: source.file,
      outputSha256: source.facts.sourceSha256,
      kind: "original",
      route: "immutable-original",
      strength: null,
      scale: 1,
      width: source.width,
      height: source.height,
      label: "immutable original",
    };
  };

  const toggleWhiteBalancePicker = () => {
    if (whiteBalancePicking) {
      setWhiteBalancePicking(false);
      setColorMessage(null);
      return;
    }
    if (!resolveColorBase()) {
      setColorError("The latest verified pre-colour image is unavailable. Apply or reset earlier-stage changes before sampling white balance.");
      return;
    }
    setWhiteBalanceReview(null);
    setWhiteBalanceSuggestionUsed(false);
    setWhiteBalancePicking(true);
    setColorError(null);
    setColorMessage("White-balance picker ready. Select a known neutral point in the Result viewer.");
    dispatch({ type: "mode-changed", mode: "side-by-side" });
  };

  const sampleWhiteBalance = async (normalizedX: number, normalizedY: number) => {
    if (!whiteBalancePicking || colorBusy) return;
    const base = resolveColorBase();
    if (!base) {
      setWhiteBalancePicking(false);
      setColorError("The verified pre-colour image changed before sampling. Start the white-balance picker again.");
      return;
    }
    const x = Math.min(base.width - 1, Math.max(0, Math.round(normalizedX * (base.width - 1))));
    const y = Math.min(base.height - 1, Math.max(0, Math.round(normalizedY * (base.height - 1))));
    const currentColorOperation = ++colorOperation.current;
    disposeColorEngine();
    const next = new WorkerImageColorEngine();
    colorEngine.current = next;
    setColorBusy(true);
    setWhiteBalanceAnalysing(true);
    setWhiteBalancePicking(false);
    setColorError(null);
    setColorMessage("Measuring the selected neutral patch from the verified pre-colour image.");
    try {
      const loaded = await next.load(base.blob);
      if (loaded.width !== base.width || loaded.height !== base.height) {
        throw new Error(`The white-balance decoder returned ${loaded.width} × ${loaded.height} px instead of ${base.width} × ${base.height} px.`);
      }
      const suggestion = await next.sampleWhiteBalance(x, y);
      if (colorOperation.current !== currentColorOperation) return;
      setWhiteBalanceReview({
        ...suggestion,
        normalizedX,
        normalizedY,
        baseOutputSha256: base.outputSha256,
        baseLabel: base.label,
      });
      setWhiteBalanceSuggestionUsed(false);
      setColorMessage("White-balance sample ready. Review the measured values before using the suggestion.");
    } catch (error) {
      if (colorOperation.current !== currentColorOperation) return;
      setWhiteBalanceReview(null);
      setColorError(error instanceof Error ? error.message : "White-balance sampling did not complete.");
      setColorMessage(null);
    } finally {
      if (colorOperation.current === currentColorOperation) {
        setColorBusy(false);
        setWhiteBalanceAnalysing(false);
        next.dispose();
        if (colorEngine.current === next) colorEngine.current = null;
      }
    }
  };

  const useWhiteBalanceSuggestion = () => {
    const base = resolveColorBase();
    if (!whiteBalanceReview || !base || whiteBalanceReview.baseOutputSha256 !== base.outputSha256) {
      clearWhiteBalanceReview();
      setColorError("The verified pre-colour image changed. Take a new white-balance sample before using a suggestion.");
      return;
    }
    setColorRecipe(sanitizeColorRecipe({
      ...colorRecipe,
      temperature: whiteBalanceReview.temperature,
      tint: whiteBalanceReview.tint,
    }));
    clearColorDerivative();
    setWhiteBalanceSuggestionUsed(true);
    setColorError(null);
    setColorMessage("White-balance suggestion loaded. Review the controls, then apply colour.");
  };

  const dismissWhiteBalanceSuggestion = () => {
    setWhiteBalanceReview(null);
    setWhiteBalancePicking(false);
    setWhiteBalanceSuggestionUsed(false);
    setColorMessage(null);
  };

  const applyColor = async () => {
    const source = state.source;
    const safe = sanitizeColorRecipe(colorRecipe);
    if (!source?.facts || !source.width || !source.height || colorBusy || toneBusy || processing || geometryBusy) return;
    if (isNeutralColor(safe)) return;
    if (resultIsStale) {
      setColorError("Enhancement settings changed. Enhance again or reset the enhancement before applying colour.");
      return;
    }
    if (geometryIsDirty) {
      setColorError("Geometry settings changed. Apply or reset geometry before applying colour.");
      return;
    }
    if (toneHasChanges && !toneDisplayReady) {
      setColorError("Light-and-tone settings changed. Apply or reset them before applying colour.");
      return;
    }

    const base = resolveColorBase();
    if (!base) {
      setColorError("The latest verified pre-colour image is unavailable. Apply or reset earlier-stage changes before applying colour.");
      return;
    }
    const whiteBalanceSample: ImageWhiteBalanceSuggestion | null = whiteBalanceSuggestionUsed && whiteBalanceReview
      && whiteBalanceReview.baseOutputSha256 === base.outputSha256
      && whiteBalanceReview.temperature === safe.temperature
      && whiteBalanceReview.tint === safe.tint
      ? {
          sourceX: whiteBalanceReview.sourceX,
          sourceY: whiteBalanceReview.sourceY,
          radius: whiteBalanceReview.radius,
          visiblePixels: whiteBalanceReview.visiblePixels,
          red: whiteBalanceReview.red,
          green: whiteBalanceReview.green,
          blue: whiteBalanceReview.blue,
          temperature: whiteBalanceReview.temperature,
          tint: whiteBalanceReview.tint,
          atLimit: whiteBalanceReview.atLimit,
        }
      : null;
    const baseBlob = base.blob;
    const baseOutputSha256 = base.outputSha256;
    const baseKind = base.kind;
    const baseRoute = base.route;
    const baseStrength = base.strength;
    const baseScale = base.scale;
    const width = base.width;
    const height = base.height;

    const currentColorOperation = ++colorOperation.current;
    disposeColorEngine();
    const next = new WorkerImageColorEngine();
    colorEngine.current = next;
    setColorBusy(true);
    setColorError(null);
    setColorMessage("Rendering deterministic colour adjustments from the latest verified derivative…");
    try {
      const loaded = await next.load(baseBlob);
      if (loaded.width !== width || loaded.height !== height) {
        throw new Error(`The colour decoder returned ${loaded.width} × ${loaded.height} px instead of ${width} × ${height} px.`);
      }
      const result = await next.render(safe, {
        sourceSha256: source.facts.sourceSha256,
        baseOutputSha256,
        baseKind,
        baseRoute,
        baseStrength,
        baseScale,
        whiteBalanceSample,
        outputWidth: width,
        outputHeight: height,
      });
      if (colorOperation.current !== currentColorOperation) return;
      assertPngDimensions(new Uint8Array(result.bytes), width, height);
      const url = URL.createObjectURL(new Blob([result.bytes], { type: "image/png" }));
      if (colorObjectUrl.current) URL.revokeObjectURL(colorObjectUrl.current);
      colorObjectUrl.current = url;
      setColorRecipe(safe);
      setAppliedColor(safe);
      setColorResult({ ...result, url, baseOutputSha256: base.outputSha256, baseKind: base.kind });
      setColorMessage("Colour derivative ready. Preview and download use the same verified PNG bytes.");
      dispatch({ type: "zoom-changed", zoom: "fit" });
    } catch (error) {
      if (colorOperation.current !== currentColorOperation) return;
      setColorError(error instanceof Error ? error.message : "The colour adjustment could not be rendered.");
      setColorMessage(null);
    } finally {
      if (colorOperation.current === currentColorOperation) {
        setColorBusy(false);
        next.dispose();
        if (colorEngine.current === next) colorEngine.current = null;
      }
    }
  };

  const resetColor = () => {
    colorOperation.current += 1;
    disposeColorEngine();
    setColorBusy(false);
    setColorError(null);
    setColorMessage(null);
    setColorRecipe(createNeutralColorRecipe());
    clearWhiteBalanceReview();
    clearColorDerivative();
    dispatch({ type: "zoom-changed", zoom: "fit" });
  };

  const resetGeometryState = (invalidateTone: boolean) => {
    if (!state.source?.width || !state.source.height) return;
    geometryOperation.current += 1;
    setGeometryBusy(false);
    setGeometryError(null);
    setGeometryMessage(null);
    setCropAspect("original");
    setResizeAspectLocked(true);
    setGeometrySelectionOpen(false);
    setGeometryRecipe(createIdentityGeometry(state.source.width, state.source.height));
    clearGeometryDerivatives();
    if (invalidateTone) {
      invalidateToneDerivative("Geometry changed. Apply the light-and-tone recipe again to update the adjusted derivative.");
    }
    dispatch({ type: "zoom-changed", zoom: "fit" });
  };

  const resetGeometry = () => resetGeometryState(true);

  const reset = () => {
    resetColor();
    resetToneState(false);
    resetGeometryState(false);
    enhancedGeometryEngine.current?.dispose();
    enhancedGeometryEngine.current = null;
    setFaceDetailRevision((revision) => revision + 1);
    if (resultObjectUrl.current) URL.revokeObjectURL(resultObjectUrl.current);
    resultObjectUrl.current = null;
    resultBlob.current = null;
    dispatch({ type: "reset" });
  };

  const download = () => {
    if (!state.source) return;
    const enhancementIsStale = Boolean(state.result && (
      state.result.strength !== state.strength || state.result.scale !== state.outputScale
    ));
    if (enhancementIsStale || toneIsDirty || colorIsDirty) return;
    if (colorDisplayReady && colorResult) {
      try {
        assertPngDimensions(new Uint8Array(colorResult.bytes), colorResult.width, colorResult.height);
      } catch (error) {
        setColorError(error instanceof Error ? error.message : "The colour-adjusted PNG dimensions could not be verified.");
        return;
      }
      const anchor = document.createElement("a");
      anchor.href = colorResult.url;
      anchor.download = colorAdjustedDownloadName(state.source.name, colorResult.width, colorResult.height);
      anchor.click();
      return;
    }
    if (toneDisplayReady && toneResult) {
      try {
        assertPngDimensions(new Uint8Array(toneResult.bytes), toneResult.width, toneResult.height);
      } catch (error) {
        setToneError(error instanceof Error ? error.message : "The adjusted PNG dimensions could not be verified.");
        return;
      }
      const anchor = document.createElement("a");
      anchor.href = toneResult.url;
      anchor.download = adjustedDownloadName(state.source.name, toneResult.width, toneResult.height);
      anchor.click();
      return;
    }
    const geometryIsCurrent = Boolean(geometryRecipe && sameGeometry(appliedGeometry, geometryRecipe));
    const geometryDownload = geometryIsCurrent
      ? (state.result ? geometryEdited : geometryOriginal)
      : null;
    if (geometryDownload) {
      try {
        assertPngDimensions(new Uint8Array(geometryDownload.bytes), geometryDownload.width, geometryDownload.height);
      } catch (error) {
        setGeometryError(error instanceof Error ? error.message : "The edited PNG dimensions could not be verified.");
        return;
      }
      const anchor = document.createElement("a");
      anchor.href = geometryDownload.url;
      anchor.download = editedDownloadName(state.source.name, geometryDownload.width, geometryDownload.height);
      anchor.click();
      return;
    }
    if (!state.result) return;
    try {
      if (state.result.bytes) {
        assertPngDimensions(
          new Uint8Array(state.result.bytes),
          state.source.width! * state.outputScale,
          state.source.height! * state.outputScale,
        );
      }
    } catch (error) {
      dispatch({
        type: "processing-failed",
        message: error instanceof Error ? error.message : "The encoded PNG dimensions could not be verified.",
      });
      return;
    }
    const anchor = document.createElement("a");
    anchor.href = state.result.remoteDownloadUrl ?? state.result.url;
    anchor.download = downloadName(state.source.name, state.result.scale);
    anchor.click();
  };

  if (!state.source) return <main className="quality-page quality-upload-page" data-testid="image-quality-upload">
    <section className="quality-upload-card">
      <span className="quality-kicker"><Sparkles aria-hidden="true" />Image Quality Editor</span>
      <h1>Improve one image</h1>
      <p>Choose a JPEG, PNG or WebP image. Your original file remains untouched; enhancement creates a separate reconstructed result.</p>
      <Dropzone
        label="Choose an image"
        description="JPEG, PNG or WebP"
        accept={IMAGE_QUALITY_INPUT_TYPES.join(",")}
        multiple={false}
        onFiles={(files) => void selectFile(files)}
      />
      {uploadError && <InlineNotice tone="error" title="Image not supported"><p>{uploadError}</p></InlineNotice>}
    </section>
  </main>;

  const dimensionsReady = state.source.width !== null && state.source.height !== null;
  const sourceWidth = state.source.width ?? 1;
  const sourceHeight = state.source.height ?? 1;
  const processing = state.status === "processing";
  const canEnhance = dimensionsReady && !processing && !processorRestarting && !geometryBusy && !toneBusy && !colorBusy;
  const resultIsStale = Boolean(state.result && (
    state.result.strength !== state.strength || state.result.scale !== state.outputScale
  ));
  const geometryRecipeIsApplied = Boolean(geometryRecipe && sameGeometry(appliedGeometry, geometryRecipe));
  const geometryDisplayReady = Boolean(
    geometryRecipeIsApplied && geometryOriginal && (!state.result || geometryEdited),
  );
  const geometryHasChanges = Boolean(
    geometryRecipe && !isIdentityGeometry(geometryRecipe, sourceWidth, sourceHeight),
  );
  const geometryIsDirty = Boolean(
    geometryHasChanges && !sameGeometry(appliedGeometry, geometryRecipe!),
  ) || Boolean(appliedGeometry && state.result && !geometryEdited);
  const baseOriginalUrl = geometryDisplayReady ? geometryOriginal!.url : state.source.url;
  const baseResultUrl = geometryDisplayReady
    ? (geometryEdited?.url ?? geometryOriginal!.url)
    : (state.result?.url ?? state.source.url);
  const baseOutputSha256 = geometryDisplayReady
    ? (state.result ? geometryEdited!.outputSha256 : geometryOriginal!.outputSha256)
    : (state.result?.outputSha256 ?? state.source.facts?.sourceSha256 ?? "");
  const toneHasChanges = !isNeutralTone(toneRecipe);
  const toneDisplayReady = Boolean(
    toneResult && appliedTone && sameToneRecipe(appliedTone, toneRecipe)
    && toneResult.baseOutputSha256 === baseOutputSha256 && !resultIsStale && !geometryIsDirty,
  );
  const toneIsDirty = toneHasChanges && !toneDisplayReady;
  const preColorOutputSha256 = toneDisplayReady ? toneResult!.outputSha256 : baseOutputSha256;
  const colorHasChanges = !isNeutralColor(colorRecipe);
  const colorDisplayReady = Boolean(
    colorResult && appliedColor && sameColorRecipe(appliedColor, colorRecipe)
    && colorResult.baseOutputSha256 === preColorOutputSha256
    && !resultIsStale && !geometryIsDirty && !toneIsDirty,
  );
  const colorIsDirty = colorHasChanges && !colorDisplayReady;
  const displayOriginalUrl = baseOriginalUrl;
  const whiteBalanceShowingBase = activeTool === "color" && (whiteBalancePicking || whiteBalanceAnalysing);
  const enhancedUrl = colorDisplayReady && !whiteBalanceShowingBase
    ? colorResult!.url
    : toneDisplayReady ? toneResult!.url : baseResultUrl;
  const histogramGeometryDerivative = geometryDisplayReady
    ? (state.result ? geometryEdited : geometryOriginal)
    : null;
  const toneRecommendationInput: ImageHistogramInput | null = resultIsStale || geometryIsDirty
    ? null
    : histogramGeometryDerivative
      ? {
          blob: new Blob([histogramGeometryDerivative.bytes], { type: "image/png" }),
          sha256: histogramGeometryDerivative.outputSha256,
          width: histogramGeometryDerivative.width,
          height: histogramGeometryDerivative.height,
          label: state.result ? "verified geometry-adjusted enhancement" : "verified geometry-adjusted original",
        }
      : state.result && resultBlob.current
        ? {
            blob: resultBlob.current,
            sha256: state.result.outputSha256,
            width: state.result.width,
            height: state.result.height,
            label: "verified enhancement",
          }
        : state.source.facts && state.source.width && state.source.height
          ? {
              blob: state.source.file,
              sha256: state.source.facts.sourceSha256,
              width: state.source.width,
              height: state.source.height,
              label: "immutable original",
            }
          : null;
  const histogramInput: ImageHistogramInput | null = colorDisplayReady && colorResult
    ? {
        blob: new Blob([colorResult.bytes], { type: "image/png" }),
        sha256: colorResult.outputSha256,
        width: colorResult.width,
        height: colorResult.height,
        label: "Colour-adjusted preview",
      }
    : toneDisplayReady && toneResult
      ? {
          blob: new Blob([toneResult.bytes], { type: "image/png" }),
          sha256: toneResult.outputSha256,
          width: toneResult.width,
          height: toneResult.height,
          label: "Light-and-tone preview",
        }
      : histogramGeometryDerivative
        ? {
            blob: new Blob([histogramGeometryDerivative.bytes], { type: "image/png" }),
            sha256: histogramGeometryDerivative.outputSha256,
            width: histogramGeometryDerivative.width,
            height: histogramGeometryDerivative.height,
            label: state.result ? "Geometry-adjusted enhanced preview" : "Geometry-adjusted original preview",
          }
        : state.result && resultBlob.current
          ? {
              blob: resultBlob.current,
              sha256: state.result.outputSha256,
              width: state.result.width,
              height: state.result.height,
              label: resultIsStale ? "Previous enhanced preview" : "Enhanced preview",
            }
          : state.source.facts && state.source.width && state.source.height
            ? {
                blob: state.source.file,
                sha256: state.source.facts.sourceSha256,
                width: state.source.width,
                height: state.source.height,
                label: "Immutable original preview",
              }
            : null;
  const displaySourceDimensions = geometryDisplayReady && appliedGeometry
    ? geometryOutputDimensions(appliedGeometry)
    : { width: state.source.width ?? 1, height: state.source.height ?? 1 };
  const downloadableGeometry = geometryRecipeIsApplied && !resultIsStale
    ? (state.result ? geometryEdited : geometryOriginal)
    : null;
  const pendingGeometryDimensions = activeTool === "geometry" && geometryRecipe
    ? geometryOutputDimensions(geometryRecipe, state.result?.scale ?? 1)
    : null;
  const outputDimensions = colorDisplayReady
    ? `${colorResult!.width} × ${colorResult!.height} px`
    : toneDisplayReady
    ? `${toneResult!.width} × ${toneResult!.height} px`
    : downloadableGeometry
    ? `${downloadableGeometry.width} × ${downloadableGeometry.height} px`
    : pendingGeometryDimensions
      ? `${pendingGeometryDimensions.width} × ${pendingGeometryDimensions.height} px after apply`
      : state.result
        ? `${state.result.width} × ${state.result.height} px`
        : dimensionsReady
          ? `${state.source.width! * state.outputScale} × ${state.source.height! * state.outputScale} px selected`
          : "Not created yet";
  const canDownload = Boolean(
    colorDisplayReady
    || (!colorIsDirty && (toneDisplayReady
      || (!toneIsDirty && (downloadableGeometry || (state.result && !resultIsStale && !appliedGeometry))))),
  );
  const currentDownloadLabel = colorDisplayReady
    ? "Download colour-adjusted image"
    : toneDisplayReady
    ? "Download adjusted image"
    : downloadableGeometry
      ? "Download edited image"
      : "Download enhanced image";
  const toneCanApply = Boolean(
    dimensionsReady && toneHasChanges && !toneBusy && !colorBusy && !processing && !processorRestarting && !geometryBusy
    && !resultIsStale && !geometryIsDirty && !toneDisplayReady,
  );
  const colorCanApply = Boolean(
    dimensionsReady && colorHasChanges && !colorBusy && !toneBusy && !processing && !processorRestarting && !geometryBusy
    && !resultIsStale && !geometryIsDirty && !toneIsDirty && !colorDisplayReady,
  );
  const colorBaseAvailable = Boolean(
    dimensionsReady && !resultIsStale && !geometryIsDirty && !toneIsDirty
    && (toneDisplayReady || geometryDisplayReady || !state.result || resultBlob.current),
  );
  const whiteBalancePoint = whiteBalanceReview?.baseOutputSha256 === preColorOutputSha256
    ? { x: whiteBalanceReview.normalizedX, y: whiteBalanceReview.normalizedY }
    : null;
  const whiteBalanceSampler = activeTool === "color"
    ? {
        active: whiteBalancePicking,
        point: whiteBalancePoint,
        onSample: (x: number, y: number) => void sampleWhiteBalance(x, y),
      }
    : undefined;
  const geometryCanApply = Boolean(
    dimensionsReady && geometryRecipe && !isIdentityGeometry(geometryRecipe, state.source.width!, state.source.height!)
    && !geometryBusy && !toneBusy && !colorBusy && !processing && !processorRestarting && !resultIsStale
    && (geometryIsDirty || !geometryDisplayReady),
  );
  const geometryEditing = activeTool === "geometry" && Boolean(geometryRecipe)
    && (geometrySelectionOpen || geometryIsDirty || !geometryDisplayReady);
  const progressPercent = state.progress && state.progress.total > 0
    ? Math.max(0, Math.min(100, Math.round(state.progress.completed / state.progress.total * 100)))
    : null;
  const statusMessage = processorRestarting
    ? "Cancellation complete. Preparing the original for another enhancement…"
    : state.status === "loading"
    ? state.progress?.message ?? "Preparing decoded source pixels…"
    : processing
      ? state.progress?.message ?? "Analysing the image and running its dedicated reconstruction path in a background worker…"
      : state.status === "success"
        ? resultIsStale
          ? `Enhancement settings changed. The displayed result is still the verified ${state.result?.strength}% at ${state.result?.scale}×; enhance again before downloading.`
          : state.result?.model.usage === "production-restore"
            ? `AI-restored image ready (${state.result.engine}). The full image contains bounded reconstructed detail; compare it closely before downloading.`
            : `Enhanced image ready (${state.result?.engine ?? "reconstruction engine"}). Compare it closely before downloading.`
        : state.status === "ready" && !state.result
          ? "Original ready. Enhance quality uses disclosed Restore processing for photos and illustrations, and protected deterministic processing for graphics."
          : null;

  return <main className="quality-page quality-editor" data-testid="image-quality-editor" aria-busy={processing || geometryBusy || toneBusy || colorBusy}>
    <header className="quality-header">
      <div>
        <span className="quality-kicker"><ImageIcon aria-hidden="true" />Image Quality Editor</span>
        <h1>{state.source.name}</h1>
        {state.source.facts && <p className="quality-source-summary">
          Verified {state.source.facts.mediaType.replace("image/", "").toUpperCase()} · {Math.max(1, Math.round(state.source.facts.byteSize / 1024))} KB · source <code>{state.source.facts.sourceSha256.slice(0, 12)}…</code>
        </p>}
      </div>
      <div className="quality-header-actions">
        <input
          ref={fileInput}
          className="quality-file-input"
          type="file"
          aria-label="Choose replacement image"
          accept={IMAGE_QUALITY_INPUT_TYPES.join(",")}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            if (files.length) void selectFile(files);
          }}
        />
        <Button size="compact" disabled={processing || processorRestarting || geometryBusy || toneBusy || colorBusy} onClick={() => fileInput.current?.click()}><Upload aria-hidden="true" />Change image</Button>
      </div>
    </header>

    <section className="quality-workspace">
      <ImageEditorToolRail activeTool={activeTool} onChange={(tool) => {
        setActiveTool(tool);
        if (tool !== "color") setWhiteBalancePicking(false);
        if (tool === "geometry") setGeometrySelectionOpen(true);
      }} />
      {activeTool === "enhance"
        ? <EnhancementToolPanel
            outputScale={state.outputScale}
            strength={state.strength}
            processing={processing}
            processorRestarting={processorRestarting}
            geometryBusy={geometryBusy}
            dimensionsReady={dimensionsReady}
            canEnhance={canEnhance}
            canDownload={canDownload}
            downloadLabel={currentDownloadLabel}
            onScale={(outputScale) => dispatch({ type: "output-scale-changed", outputScale })}
            onStrength={(strength) => dispatch({ type: "strength-changed", strength })}
            onEnhance={() => void enhance()}
            onCancel={cancel}
            onReset={reset}
            onDownload={download}
          />
        : activeTool === "adjust"
          ? <ToneToolPanel
              recipe={toneRecipe}
              statistics={toneDisplayReady ? toneResult!.statistics : null}
              recommendationInput={toneRecommendationInput}
              busy={toneBusy}
              canApply={toneCanApply}
              canDownload={toneDisplayReady && !colorDisplayReady}
              onRecipe={(recipe) => {
                setToneRecipe(sanitizeToneRecipe(recipe));
                setToneError(null);
                setToneMessage(null);
              }}
              onApply={() => void applyTone()}
              onReset={resetTone}
              onDownload={download}
            />
          : activeTool === "color"
            ? <ColorToolPanel
                recipe={colorRecipe}
                statistics={colorDisplayReady ? colorResult!.statistics : null}
                whiteBalanceSuggestion={whiteBalanceReview}
                whiteBalanceBaseLabel={whiteBalanceReview?.baseLabel ?? null}
                whiteBalanceSuggestionUsed={whiteBalanceSuggestionUsed}
                whiteBalancePicking={whiteBalancePicking}
                whiteBalanceAnalysing={whiteBalanceAnalysing}
                busy={colorBusy}
                canSampleWhiteBalance={colorBaseAvailable && !toneBusy && !processing && !processorRestarting && !geometryBusy}
                canApply={colorCanApply}
                canDownload={colorDisplayReady}
                onRecipe={(recipe) => {
                  const safe = sanitizeColorRecipe(recipe);
                  setColorRecipe(safe);
                  if (!whiteBalanceReview
                    || safe.temperature !== whiteBalanceReview.temperature
                    || safe.tint !== whiteBalanceReview.tint) {
                    setWhiteBalanceSuggestionUsed(false);
                  }
                  setColorError(null);
                  setColorMessage(null);
                }}
                onToggleWhiteBalancePicker={toggleWhiteBalancePicker}
                onUseWhiteBalanceSuggestion={useWhiteBalanceSuggestion}
                onDismissWhiteBalanceSuggestion={dismissWhiteBalanceSuggestion}
                onApply={() => void applyColor()}
                onReset={resetColor}
                onDownload={download}
              />
            : <GeometryToolPanel
            recipe={geometryRecipe}
            aspect={cropAspect}
            resizeAspectLocked={resizeAspectLocked}
            baseScale={state.result?.scale ?? 1}
            sourceWidth={sourceWidth}
            sourceHeight={sourceHeight}
            dimensionsReady={dimensionsReady}
            busy={geometryBusy}
            canApply={geometryCanApply}
            canDownload={Boolean(colorDisplayReady || toneDisplayReady || downloadableGeometry)}
            downloadLabel={colorDisplayReady
              ? "Download colour-adjusted image"
              : toneDisplayReady ? "Download adjusted image" : "Download edited image"}
            onRecipe={setGeometryRecipe}
            onAspect={setCropAspect}
            onResizeAspectLocked={setResizeAspectLocked}
            onEditCanvas={() => setGeometrySelectionOpen(true)}
            onApply={() => void applyGeometry()}
            onReset={resetGeometry}
            onDownload={download}
          />}

      <div className="quality-canvas-column">
        <section className="quality-status" aria-live="polite">
          {statusMessage && <InlineNotice tone={state.status === "success" && !resultIsStale ? "success" : "info"} title={statusMessage}>
            {(processing || state.status === "loading") && progressPercent !== null && <progress value={progressPercent} max="100">{progressPercent}%</progress>}
          </InlineNotice>}
          {state.error && <InlineNotice tone="error" title="Enhancement did not complete"><p>{state.error}</p><p>Your original image is still unchanged and available above.</p></InlineNotice>}
          {geometryMessage && <InlineNotice tone={geometryDisplayReady ? "success" : "info"} title={geometryMessage} />}
          {geometryError && <InlineNotice tone="error" title="Geometry edit did not complete"><p>{geometryError}</p><p>Your original image is still unchanged.</p></InlineNotice>}
          {toneMessage && <InlineNotice tone={toneDisplayReady ? "success" : "info"} title={toneMessage} />}
          {toneError && <InlineNotice tone="error" title="Light adjustment did not complete"><p>{toneError}</p><p>The verified base image is still unchanged.</p></InlineNotice>}
          {colorMessage && <InlineNotice tone={colorDisplayReady ? "success" : "info"} title={colorMessage} />}
          {colorError && <InlineNotice tone="error" title="Colour adjustment did not complete"><p>{colorError}</p><p>The verified base image is still unchanged.</p></InlineNotice>}
          {state.result && <details className="quality-provenance">
            <summary>Result details and provenance</summary>
            <dl>
              <div><dt>Detected content</dt><dd>{state.result.contentClass} ({Math.round(state.result.classificationConfidence * 100)}% confidence)</dd></div>
              <div><dt>Applied strength</dt><dd>{state.result.strength}%</dd></div>
              <div><dt>Route</dt><dd>{state.result.route}</dd></div>
              <div><dt>Processing</dt><dd>{(state.result.processingTimeMs / 1000).toFixed(1)} seconds</dd></div>
              <div><dt>Source fidelity</dt><dd>{state.result.fidelity.passed ? "Passed" : "Failed"} · protected-field shift {state.result.fidelity.lowTextureMeanRgbShift.toFixed(1)}</dd></div>
              <div><dt>Source SHA-256</dt><dd><code>{state.result.sourceSha256}</code></dd></div>
              <div><dt>Output SHA-256</dt><dd><code>{state.result.outputSha256}</code></dd></div>
            </dl>
            {state.result.warnings.map((warning) => <p key={warning}>{warning}</p>)}
          </details>}
          {dimensionsReady && (nativeFaceContext && state.result
            ? <NativeFaceDetailPanel key={`native-${faceDetailRevision}`} disabled={processing || processorRestarting || resultIsStale || geometryBusy || toneBusy || colorBusy}
              context={nativeFaceContext} filename={state.source.name} viewer={{ originalUrl: state.source.url,
                baseUrl: state.result.url, sourceWidth: state.source.width!, sourceHeight: state.source.height!,
                outputWidth: state.result.width, outputHeight: state.result.height }} />
            : <FaceDetailPanel key={faceDetailRevision} disabled={processing || processorRestarting || resultIsStale || geometryBusy || toneBusy || colorBusy}
              filename={state.source.name} input={faceReviewInput} />)}
        </section>

        {geometryEditing && geometryRecipe && dimensionsReady
          ? <CropSelectionEditor
              sourceUrl={state.source.url}
              filename={state.source.name}
              sourceWidth={state.source.width!}
              sourceHeight={state.source.height!}
              crop={geometryRecipe.crop}
              perspective={geometryRecipe.perspective}
              aspect={cropAspect}
              disabled={geometryBusy || toneBusy || colorBusy}
              onChange={(crop) => setGeometryRecipe({ ...geometryRecipe, crop })}
              onPerspectiveChange={(perspective) => setGeometryRecipe({ ...geometryRecipe, perspective })}
            />
          : dimensionsReady && <section className="quality-comparison" aria-label="Original and enhanced comparison">
              {state.mode === "side-by-side" ? <div className="quality-side-by-side">
                <ComparisonViewer
                  sourceUrl={displayOriginalUrl}
                  enhancedUrl={enhancedUrl}
                  filename={state.source.name}
                  width={displaySourceDimensions.width}
                  height={displaySourceDimensions.height}
                  zoom={state.zoom}
                  pan={state.pan}
                  onPan={(x, y) => dispatch({ type: "pan-changed", x, y })}
                  label={geometryDisplayReady ? "Original · geometry applied" : "Original"}
                />
                <ComparisonViewer
                  sourceUrl={displayOriginalUrl}
                  enhancedUrl={enhancedUrl}
                  filename={state.source.name}
                  width={displaySourceDimensions.width}
                  height={displaySourceDimensions.height}
                  zoom={state.zoom}
                  pan={state.pan}
                  onPan={(x, y) => dispatch({ type: "pan-changed", x, y })}
                  label={whiteBalanceShowingBase
                    ? "White-balance sampling base"
                    : colorDisplayReady
                    ? state.result ? `Colour-adjusted enhanced · ${state.result.strength}%` : "Colour-adjusted original"
                    : toneDisplayReady
                    ? state.result ? `Adjusted enhanced · ${state.result.strength}%` : "Adjusted original"
                    : state.result ? `Enhanced · ${state.result.strength}%${geometryDisplayReady ? " · geometry applied" : ""}${resultIsStale ? " · previous result" : ""}` : geometryDisplayReady ? "Edited original" : "Enhanced · awaiting processing"}
                  enhanced
                  whiteBalanceSampler={whiteBalanceSampler}
                />
              </div> : <>
                <ComparisonViewer
                  sourceUrl={displayOriginalUrl}
                  enhancedUrl={enhancedUrl}
                  filename={state.source.name}
                  width={displaySourceDimensions.width}
                  height={displaySourceDimensions.height}
                  zoom={state.zoom}
                  pan={state.pan}
                  onPan={(x, y) => dispatch({ type: "pan-changed", x, y })}
                  label="Original · Result"
                  overlay={{ slider: state.slider }}
                  whiteBalanceSampler={whiteBalanceSampler}
                />
                <label className="quality-slider-control"><span>Comparison position</span><input type="range" min="0" max="100" value={state.slider} onChange={(event) => dispatch({ type: "slider-changed", slider: Number(event.target.value) })} /></label>
              </>}
            </section>}

        {!geometryEditing && <div className="quality-view-toolbar" aria-label="Canvas view controls">
          <div className="quality-control-group" role="group" aria-label="Comparison view">
            <Button size="compact" aria-pressed={state.mode === "side-by-side"} onClick={() => dispatch({ type: "mode-changed", mode: "side-by-side" })}><Columns2 aria-hidden="true" />Side by side</Button>
            <Button size="compact" aria-pressed={state.mode === "slider"} onClick={() => dispatch({ type: "mode-changed", mode: "slider" })}><SlidersHorizontal aria-hidden="true" />Slider</Button>
          </div>
          <div className="quality-control-group" role="group" aria-label="Zoom">
            {qualityZooms.map((item) => <Button key={String(item.value)} size="compact" aria-pressed={state.zoom === item.value}
              onClick={() => dispatch({ type: "zoom-changed", zoom: item.value })}>{item.label}</Button>)}
          </div>
        </div>}
      </div>

      <ImageEditorInspector
        dimensionsReady={dimensionsReady}
        sourceWidth={sourceWidth}
        sourceHeight={sourceHeight}
        outputDimensions={outputDimensions}
        recipe={geometryRecipe}
        geometryIsDirty={geometryIsDirty}
        geometryDisplayReady={geometryDisplayReady}
        toneStatus={toneDisplayReady ? "Applied" : toneIsDirty ? "Unapplied changes" : "None"}
        colorStatus={colorDisplayReady ? "Applied" : colorIsDirty ? "Unapplied changes" : "None"}
        histogramInput={histogramInput}
      />
    </section>
  </main>;
}
