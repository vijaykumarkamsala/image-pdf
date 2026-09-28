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
  EnhancementToolPanel,
  GeometryToolPanel,
  ImageEditorInspector,
  ImageEditorToolRail,
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

interface GeometryDerivative extends ImageGeometryResult {
  url: string;
  baseKind: "original" | "enhanced";
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
}: ViewerProps) {
  const { ref, size } = useFrameSize();
  const drag = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number } | null>(null);
  const transform = viewerTransform(size.width, size.height, width, height, zoom, pan);
  const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
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
    className={`quality-viewer${overlay ? " quality-viewer-slider" : ""}`}
    data-testid={overlay ? "comparison-slider-view" : `comparison-${enhanced ? "enhanced" : "original"}`}
    data-scale={transform.scale.toFixed(6)}
    tabIndex={0}
    role="group"
    aria-label={`${label} image viewer. Use arrow keys to pan when zoomed.`}
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
  </div>;
}

export function ImageQualityEditorPage() {
  const navigate = useNavigate();
  const [state, dispatch] = useReducer(imageQualitySessionReducer, initialImageQualitySession);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [processorRestarting, setProcessorRestarting] = useState(false);
  const [faceDetailRevision, setFaceDetailRevision] = useState(0);
  const [activeTool, setActiveTool] = useState<"enhance" | "geometry">("enhance");
  const [cropAspect, setCropAspect] = useState<ImageCropAspect>("original");
  const [resizeAspectLocked, setResizeAspectLocked] = useState(true);
  const [geometryRecipe, setGeometryRecipe] = useState<ImageGeometryRecipe | null>(null);
  const [appliedGeometry, setAppliedGeometry] = useState<ImageGeometryRecipe | null>(null);
  const [geometryOriginal, setGeometryOriginal] = useState<GeometryDerivative | null>(null);
  const [geometryEdited, setGeometryEdited] = useState<GeometryDerivative | null>(null);
  const [geometryBusy, setGeometryBusy] = useState(false);
  const [geometryError, setGeometryError] = useState<string | null>(null);
  const [geometryMessage, setGeometryMessage] = useState<string | null>(null);
  const engine = useRef<ImageQualityEngine | null>(null);
  const originalGeometryEngine = useRef<WorkerImageGeometryEngine | null>(null);
  const enhancedGeometryEngine = useRef<WorkerImageGeometryEngine | null>(null);
  const selection = useRef(0);
  const operation = useRef(0);
  const geometryOperation = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const sourceObjectUrl = useRef<string | null>(null);
  const resultObjectUrl = useRef<string | null>(null);
  const resultBlob = useRef<Blob | null>(null);
  const geometryOriginalObjectUrl = useRef<string | null>(null);
  const geometryEditedObjectUrl = useRef<string | null>(null);
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
    engine.current?.dispose();
    originalGeometryEngine.current?.dispose();
    enhancedGeometryEngine.current?.dispose();
    if (sourceObjectUrl.current) URL.revokeObjectURL(sourceObjectUrl.current);
    if (resultObjectUrl.current) URL.revokeObjectURL(resultObjectUrl.current);
    if (geometryOriginalObjectUrl.current) URL.revokeObjectURL(geometryOriginalObjectUrl.current);
    if (geometryEditedObjectUrl.current) URL.revokeObjectURL(geometryEditedObjectUrl.current);
  }, []);

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
    setGeometryRecipe(null);
    setGeometryBusy(false);
    setGeometryError(null);
    setGeometryMessage(null);
    clearGeometryDerivatives();
    disposeGeometryEngines();
    selection.current += 1;
    operation.current += 1;
    geometryOperation.current += 1;
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
    if (!state.source || !engine.current || state.status === "processing") return;
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
    if (!source?.facts || !source.width || !source.height || !geometryRecipe || geometryBusy || processing) return;
    const safe = sanitizeGeometryRecipe(geometryRecipe, source.width, source.height, Math.min(32, source.width, source.height));
    if (isIdentityGeometry(safe, source.width, source.height)) return;
    if (state.result && (state.result.strength !== state.strength || state.result.scale !== state.outputScale)) {
      setGeometryError("Enhancement settings changed. Enhance again or reset the enhancement before applying geometry.");
      return;
    }
    const currentGeometryOperation = ++geometryOperation.current;
    setGeometryBusy(true);
    setGeometryError(null);
    setGeometryMessage("Rendering the crop and rotation from verified source coordinates…");
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
      setGeometryMessage(state.result
        ? "Combined enhancement and geometry derivative ready. Preview and download use the same verified PNG bytes."
        : "Geometry derivative ready from the immutable original. Preview and download use the same verified PNG bytes.");
      dispatch({ type: "zoom-changed", zoom: "fit" });
    } catch (error) {
      if (geometryOperation.current !== currentGeometryOperation) return;
      setGeometryError(error instanceof Error ? error.message : "The geometry edit could not be rendered.");
      setGeometryMessage(null);
    } finally {
      if (geometryOperation.current === currentGeometryOperation) setGeometryBusy(false);
    }
  };

  const resetGeometry = () => {
    if (!state.source?.width || !state.source.height) return;
    geometryOperation.current += 1;
    setGeometryBusy(false);
    setGeometryError(null);
    setGeometryMessage(null);
    setCropAspect("original");
    setResizeAspectLocked(true);
    setGeometryRecipe(createIdentityGeometry(state.source.width, state.source.height));
    clearGeometryDerivatives();
    dispatch({ type: "zoom-changed", zoom: "fit" });
  };

  const reset = () => {
    resetGeometry();
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
    if (enhancementIsStale) return;
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
  const canEnhance = dimensionsReady && !processing && !processorRestarting && !geometryBusy;
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
  const displayOriginalUrl = geometryDisplayReady ? geometryOriginal!.url : state.source.url;
  const enhancedUrl = geometryDisplayReady
    ? (geometryEdited?.url ?? geometryOriginal!.url)
    : (state.result?.url ?? state.source.url);
  const displaySourceDimensions = geometryDisplayReady && appliedGeometry
    ? geometryOutputDimensions(appliedGeometry)
    : { width: state.source.width ?? 1, height: state.source.height ?? 1 };
  const downloadableGeometry = geometryRecipeIsApplied && !resultIsStale
    ? (state.result ? geometryEdited : geometryOriginal)
    : null;
  const pendingGeometryDimensions = activeTool === "geometry" && geometryRecipe
    ? geometryOutputDimensions(geometryRecipe, state.result?.scale ?? 1)
    : null;
  const outputDimensions = downloadableGeometry
    ? `${downloadableGeometry.width} × ${downloadableGeometry.height} px`
    : pendingGeometryDimensions
      ? `${pendingGeometryDimensions.width} × ${pendingGeometryDimensions.height} px after apply`
      : state.result
        ? `${state.result.width} × ${state.result.height} px`
        : dimensionsReady
          ? `${state.source.width! * state.outputScale} × ${state.source.height! * state.outputScale} px selected`
          : "Not created yet";
  const canDownload = Boolean(downloadableGeometry || (state.result && !resultIsStale && !appliedGeometry));
  const geometryCanApply = Boolean(
    dimensionsReady && geometryRecipe && !isIdentityGeometry(geometryRecipe, state.source.width!, state.source.height!)
    && !geometryBusy && !processing && !processorRestarting && !resultIsStale
    && (geometryIsDirty || !geometryDisplayReady),
  );
  const geometryEditing = activeTool === "geometry" && Boolean(geometryRecipe) && (geometryIsDirty || !geometryDisplayReady);
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

  return <main className="quality-page quality-editor" data-testid="image-quality-editor" aria-busy={processing || geometryBusy}>
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
        <Button size="compact" disabled={processing || processorRestarting || geometryBusy} onClick={() => fileInput.current?.click()}><Upload aria-hidden="true" />Change image</Button>
      </div>
    </header>

    <section className="quality-workspace">
      <ImageEditorToolRail activeTool={activeTool} onChange={setActiveTool} />
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
            onScale={(outputScale) => dispatch({ type: "output-scale-changed", outputScale })}
            onStrength={(strength) => dispatch({ type: "strength-changed", strength })}
            onEnhance={() => void enhance()}
            onCancel={cancel}
            onReset={reset}
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
            canDownload={Boolean(downloadableGeometry)}
            onRecipe={setGeometryRecipe}
            onAspect={setCropAspect}
            onResizeAspectLocked={setResizeAspectLocked}
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
            ? <NativeFaceDetailPanel key={`native-${faceDetailRevision}`} disabled={processing || processorRestarting || resultIsStale}
              context={nativeFaceContext} filename={state.source.name} viewer={{ originalUrl: state.source.url,
                baseUrl: state.result.url, sourceWidth: state.source.width!, sourceHeight: state.source.height!,
                outputWidth: state.result.width, outputHeight: state.result.height }} />
            : <FaceDetailPanel key={faceDetailRevision} disabled={processing || processorRestarting || resultIsStale}
              filename={state.source.name} input={faceReviewInput} />)}
        </section>

        {geometryEditing && geometryRecipe && dimensionsReady
          ? <CropSelectionEditor
              sourceUrl={state.source.url}
              filename={state.source.name}
              sourceWidth={state.source.width!}
              sourceHeight={state.source.height!}
              crop={geometryRecipe.crop}
              aspect={cropAspect}
              disabled={geometryBusy}
              onChange={(crop) => setGeometryRecipe({ ...geometryRecipe, crop })}
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
                  label={state.result ? `Enhanced · ${state.result.strength}%${geometryDisplayReady ? " · geometry applied" : ""}${resultIsStale ? " · previous result" : ""}` : geometryDisplayReady ? "Edited original" : "Enhanced · awaiting processing"}
                  enhanced
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
      />
    </section>
  </main>;
}
