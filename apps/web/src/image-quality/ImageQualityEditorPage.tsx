import {
  type CSSProperties,
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
} from "lucide-react";

import { Button, Dropzone, InlineNotice } from "../design-system";
import { IMAGE_QUALITY_INPUT_TYPES } from "./ImageQualityEngine";
import { WorkerImageQualityEngine } from "./WorkerImageQualityEngine";
import {
  imageQualitySessionReducer,
  initialImageQualitySession,
  type QualityZoom,
} from "./imageQualitySession";
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
  const movePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    onPan(active.panX + event.clientX - active.x, active.panY + event.clientY - active.y);
  };
  const stopPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  };

  return <div
    ref={ref}
    className={`quality-viewer${overlay ? " quality-viewer-slider" : ""}`}
    data-testid={overlay ? "comparison-slider-view" : `comparison-${enhanced ? "enhanced" : "original"}`}
    data-scale={transform.scale.toFixed(6)}
    onPointerDown={startPan}
    onPointerMove={movePan}
    onPointerUp={stopPan}
    onPointerCancel={stopPan}
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
  const engine = useRef<WorkerImageQualityEngine | null>(null);
  const selection = useRef(0);
  const sourceObjectUrl = useRef<string | null>(null);
  const resultObjectUrl = useRef<string | null>(null);

  useEffect(() => () => {
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
    selection.current += 1;
    const currentSelection = selection.current;
    if (sourceObjectUrl.current) URL.revokeObjectURL(sourceObjectUrl.current);
    if (resultObjectUrl.current) URL.revokeObjectURL(resultObjectUrl.current);
    resultObjectUrl.current = null;
    const url = URL.createObjectURL(file);
    sourceObjectUrl.current = url;
    dispatch({ type: "source-selected", source: { file, url, name: file.name, width: null, height: null } });
    navigate("/image-quality/editor");
    try {
      engine.current?.dispose();
      engine.current = new WorkerImageQualityEngine();
      const loaded = await engine.current.load(file);
      if (selection.current === currentSelection) dispatch({ type: "source-ready", width: loaded.width, height: loaded.height });
    } catch (error) {
      if (selection.current === currentSelection) {
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
    try {
      const result = await engine.current.enhance(state.strength);
      if (resultObjectUrl.current) URL.revokeObjectURL(resultObjectUrl.current);
      const url = URL.createObjectURL(new Blob([result.bytes], { type: result.mediaType }));
      resultObjectUrl.current = url;
      dispatch({ type: "processing-succeeded", result: { ...result, url } });
    } catch (error) {
      dispatch({
        type: "processing-failed",
        message: error instanceof Error ? error.message : "Enhancement did not complete. Your original is unchanged.",
      });
    }
  };

  const reset = () => {
    if (resultObjectUrl.current) URL.revokeObjectURL(resultObjectUrl.current);
    resultObjectUrl.current = null;
    dispatch({ type: "reset" });
  };

  const download = () => {
    if (!state.source || !state.result) return;
    const anchor = document.createElement("a");
    anchor.href = state.result.url;
    anchor.download = downloadName(state.source.name);
    anchor.click();
  };

  if (!state.source) return <main className="quality-page quality-upload-page" data-testid="image-quality-upload">
    <section className="quality-upload-card">
      <span className="quality-kicker"><Sparkles aria-hidden="true" />Image Quality Editor</span>
      <h1>Improve one photograph</h1>
      <p>Choose a JPEG, PNG or WebP image. Your original file remains untouched; enhancement creates a separate reconstructed result.</p>
      <Dropzone
        label="Choose a photograph"
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
  const canEnhance = dimensionsReady && !processing;
  const statusMessage = state.status === "loading"
    ? "Preparing decoded source pixels…"
    : processing
      ? "Analysing the image and running its dedicated reconstruction path in a background worker…"
      : state.status === "success"
        ? `Enhanced image ready (${state.result?.engine ?? "reconstruction engine"}). Compare it closely before downloading.`
        : state.status === "ready" && !state.result
          ? "Original ready. Choose a strength and enhance quality."
          : null;

  return <main className="quality-page quality-editor" data-testid="image-quality-editor" aria-busy={processing}>
    <header className="quality-header">
      <div>
        <span className="quality-kicker"><ImageIcon aria-hidden="true" />Image Quality Editor</span>
        <h1>{state.source.name}</h1>
      </div>
      <dl className="quality-dimensions">
        <div><dt>Original</dt><dd>{dimensionsReady ? `${state.source.width} × ${state.source.height} px` : "Reading dimensions…"}</dd></div>
        <div><dt>Output</dt><dd>{outputDimensions}</dd></div>
      </dl>
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
        <Button tone="primary" disabled={!canEnhance} onClick={() => void enhance()}><Sparkles aria-hidden="true" />{processing ? "Enhancing…" : "Enhance quality"}</Button>
        <Button disabled={processing || !dimensionsReady} onClick={reset}><RotateCcw aria-hidden="true" />Reset</Button>
        <Button disabled={!state.result || processing} onClick={download}><Download aria-hidden="true" />Download enhanced image</Button>
      </div>
    </section>

    <section className="quality-status" aria-live="polite">
      {statusMessage && <InlineNotice tone={state.status === "success" ? "success" : "info"} title={statusMessage} />}
      {state.error && <InlineNotice tone="error" title="Enhancement did not complete"><p>{state.error}</p><p>Your original image is still unchanged and available above.</p></InlineNotice>}
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
          label={state.result ? "Enhanced" : "Enhanced · awaiting processing"}
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
