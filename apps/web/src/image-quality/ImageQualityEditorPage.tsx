import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import {
  Columns2,
  Download,
  Image as ImageIcon,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Upload,
  X,
} from "lucide-react";

import { Button, Dropzone, InlineNotice } from "../design-system";
import { IMAGE_QUALITY_INPUT_TYPES } from "./ImageQualityEngine";
import type { ImageQualityEngine } from "./ImageQualityEngine";
import { createImageQualityEngine } from "./ProductionImageQualityEngine";
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

function strengthLabel(strength: number) {
  if (strength < 35) return "Gentle";
  if (strength < 70) return "Balanced";
  return "Strong";
}

function downloadName(filename: string) {
  const stem = filename.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${stem || "image"}-enhanced.png`;
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
  const engine = useRef<ImageQualityEngine | null>(null);
  const selection = useRef(0);
  const operation = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const sourceObjectUrl = useRef<string | null>(null);
  const resultObjectUrl = useRef<string | null>(null);
  const deterministicPreference = useRef(false);

  useEffect(() => () => {
    selection.current += 1;
    operation.current += 1;
    engine.current?.dispose();
    if (sourceObjectUrl.current) URL.revokeObjectURL(sourceObjectUrl.current);
    if (resultObjectUrl.current) URL.revokeObjectURL(resultObjectUrl.current);
  }, []);

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
    selection.current += 1;
    operation.current += 1;
    const currentSelection = selection.current;
    const preferDeterministic = new URLSearchParams(globalThis.location.search).get("engine") === "deterministic";
    deterministicPreference.current = preferDeterministic;
    if (sourceObjectUrl.current) URL.revokeObjectURL(sourceObjectUrl.current);
    if (resultObjectUrl.current) URL.revokeObjectURL(resultObjectUrl.current);
    resultObjectUrl.current = null;
    const url = URL.createObjectURL(file);
    sourceObjectUrl.current = url;
    dispatch({ type: "source-selected", source: { file, url, name: file.name, width: null, height: null, facts: null } });
    navigate("/image-quality/editor");
    try {
      engine.current ??= createImageQualityEngine({ preferDeterministic });
      const loaded = await engine.current.load(file, {
        onProgress: (progress) => {
          if (selection.current === currentSelection) dispatch({ type: "processing-progress", progress });
        },
      });
      if (selection.current === currentSelection) dispatch({ type: "source-ready", facts: loaded });
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
        onProgress: (progress) => {
          if (operation.current === currentOperation) dispatch({ type: "processing-progress", progress });
        },
      });
      if (operation.current !== currentOperation) return;
      if (resultObjectUrl.current) URL.revokeObjectURL(resultObjectUrl.current);
      const url = result.bytes
        ? URL.createObjectURL(new Blob([result.bytes], { type: result.mediaType }))
        : result.remoteViewUrl;
      if (!url) throw new Error("The processed image has no authorised viewing source.");
      resultObjectUrl.current = result.bytes ? url : null;
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

  const reset = () => {
    if (resultObjectUrl.current) URL.revokeObjectURL(resultObjectUrl.current);
    resultObjectUrl.current = null;
    dispatch({ type: "reset" });
  };

  const download = () => {
    if (!state.source || !state.result) return;
    const anchor = document.createElement("a");
    anchor.href = state.result.remoteDownloadUrl ?? state.result.url;
    anchor.download = downloadName(state.source.name);
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
  const enhancedUrl = state.result?.url ?? state.source.url;
  const outputDimensions = state.result ? `${state.result.width} × ${state.result.height} px` : "Not created yet";
  const processing = state.status === "processing";
  const canEnhance = dimensionsReady && !processing && !processorRestarting;
  const resultIsStale = Boolean(state.result && state.result.strength !== state.strength);
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
          ? `Enhancement strength changed to ${state.strength}%. The displayed result is still the verified ${state.result?.strength}% result; enhance again before downloading.`
          : state.result?.model.usage === "production-restore"
            ? `AI-restored image ready (${state.result.engine}). The full image contains bounded reconstructed detail; compare it closely before downloading.`
            : `Enhanced image ready (${state.result?.engine ?? "reconstruction engine"}). Compare it closely before downloading.`
        : state.status === "ready" && !state.result
          ? "Original ready. Enhance quality uses disclosed Restore processing for photos and illustrations, and protected deterministic processing for graphics."
          : null;

  return <main className="quality-page quality-editor" data-testid="image-quality-editor" aria-busy={processing}>
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
        <Button size="compact" disabled={processing || processorRestarting} onClick={() => fileInput.current?.click()}><Upload aria-hidden="true" />Change image</Button>
        <dl className="quality-dimensions">
        <div><dt>Original</dt><dd>{dimensionsReady ? `${state.source.width} × ${state.source.height} px` : "Reading dimensions…"}</dd></div>
        <div><dt>Output</dt><dd>{outputDimensions}</dd></div>
        </dl>
      </div>
    </header>

    <section className="quality-controls" aria-label="Image quality controls">
      <div className="quality-control-group" role="group" aria-label="Comparison view">
        <Button size="compact" aria-pressed={state.mode === "side-by-side"} onClick={() => dispatch({ type: "mode-changed", mode: "side-by-side" })}><Columns2 aria-hidden="true" />Side by side</Button>
        <Button size="compact" aria-pressed={state.mode === "slider"} onClick={() => dispatch({ type: "mode-changed", mode: "slider" })}><SlidersHorizontal aria-hidden="true" />Slider</Button>
      </div>
      <div className="quality-control-group" role="group" aria-label="Zoom">
        {qualityZooms.map((item) => <Button
          key={String(item.value)}
          size="compact"
          aria-pressed={state.zoom === item.value}
          onClick={() => dispatch({ type: "zoom-changed", zoom: item.value })}
        >{item.label}</Button>)}
      </div>
      <label className="quality-strength">
        <span><strong>Enhancement strength</strong><output>{strengthLabel(state.strength)} · {state.strength}%</output></span>
        <input
          type="range"
          min="1"
          max="100"
          value={state.strength}
          disabled={processing}
          onChange={(event) => dispatch({ type: "strength-changed", strength: Number(event.target.value) })}
        />
      </label>
      <div className="quality-actions">
        <Button tone="primary" disabled={!canEnhance} onClick={() => void enhance()}><Sparkles aria-hidden="true" />{processing ? "Enhancing…" : processorRestarting ? "Preparing…" : "Enhance quality"}</Button>
        {processing
          ? <Button onClick={cancel}><X aria-hidden="true" />Cancel</Button>
          : <Button disabled={!dimensionsReady} onClick={reset}><RotateCcw aria-hidden="true" />Reset</Button>}
        <Button disabled={!state.result || processing || resultIsStale} onClick={download}><Download aria-hidden="true" />Download enhanced image</Button>
      </div>
      <p className="quality-view-note">Viewer zoom changes comparison only; it never reprocesses the image. Original and Enhanced stay locked to the same source coordinates.</p>
    </section>

    <section className="quality-status" aria-live="polite">
      {statusMessage && <InlineNotice tone={state.status === "success" && !resultIsStale ? "success" : "info"} title={statusMessage}>
        {(processing || state.status === "loading") && progressPercent !== null && <progress value={progressPercent} max="100">{progressPercent}%</progress>}
      </InlineNotice>}
      {state.error && <InlineNotice tone="error" title="Enhancement did not complete"><p>{state.error}</p><p>Your original image is still unchanged and available above.</p></InlineNotice>}

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
    </section>

    {dimensionsReady && <section className="quality-comparison" aria-label="Original and enhanced comparison">
      {state.mode === "side-by-side" ? <div className="quality-side-by-side">
        <ComparisonViewer
          sourceUrl={state.source.url}
          enhancedUrl={enhancedUrl}
          filename={state.source.name}
          width={state.source.width!}
          height={state.source.height!}
          zoom={state.zoom}
          pan={state.pan}
          onPan={(x, y) => dispatch({ type: "pan-changed", x, y })}
          label="Original"
        />
        <ComparisonViewer
          sourceUrl={state.source.url}
          enhancedUrl={enhancedUrl}
          filename={state.source.name}
          width={state.source.width!}
          height={state.source.height!}
          zoom={state.zoom}
          pan={state.pan}
          onPan={(x, y) => dispatch({ type: "pan-changed", x, y })}
          label={state.result ? `Enhanced · ${state.result.strength}%${resultIsStale ? " · previous result" : ""}` : "Enhanced · awaiting processing"}
          enhanced
        />
      </div> : <>
        <ComparisonViewer
          sourceUrl={state.source.url}
          enhancedUrl={enhancedUrl}
          filename={state.source.name}
          width={state.source.width!}
          height={state.source.height!}
          zoom={state.zoom}
          pan={state.pan}
          onPan={(x, y) => dispatch({ type: "pan-changed", x, y })}
          label="Original · Enhanced"
          overlay={{ slider: state.slider }}
        />
        <label className="quality-slider-control"><span>Comparison position</span><input type="range" min="0" max="100" value={state.slider} onChange={(event) => dispatch({ type: "slider-changed", slider: Number(event.target.value) })} /></label>
      </>}
    </section>}
  </main>;
}
