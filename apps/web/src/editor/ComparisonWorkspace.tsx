import { useRef, useState } from "react";
import { AlertTriangle, Check, Grid2X2, Hand, Maximize2, ShieldCheck, SplitSquareHorizontal, X, ZoomIn } from "lucide-react";
import type { EnhancementPreview, HistogramSummary } from "ipw-contracts-ts/product";

import { api } from "../boundaries/apiClient";
import { Button, IconButton } from "../design-system";
import type { ComparisonSelection, ComparisonViewMode } from "./EnhancementWorkspace";

const EMPTY_HISTOGRAM: HistogramSummary = {
  red: Array.from({ length: 64 }, () => 0),
  green: Array.from({ length: 64 }, () => 0),
  blue: Array.from({ length: 64 }, () => 0),
  shadow_clipping: false,
  highlight_clipping: false,
};

export function ComparisonWorkspace({ workspaceId, selection, onMode, onClose }: {
  workspaceId: string;
  selection: ComparisonSelection;
  onMode: (mode: ComparisonViewMode) => void;
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [split, setSplit] = useState(50);
  const [holdingOriginal, setHoldingOriginal] = useState(false);
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const mode: ComparisonViewMode = holdingOriginal ? "original" : selection.mode;
  const transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
  const recommendedAvailable = selection.previews.recommended !== null;
  const evidencePreview = mode === "original"
    ? selection.previews.original
    : mode === "recommended"
      ? selection.previews.recommended
      : selection.previews.current;
  const histogram = evidencePreview?.histogram ?? EMPTY_HISTOGRAM;

  const image = (kind: keyof ComparisonSelection["previews"], className = "") => {
    const preview = selection.previews[kind];
    if (!preview) return null;
    return <div className={`comparison-image ${className}`} data-comparison-image={kind} data-preview-id={preview.preview_id}>
      <img
        src={api.exportOutputDownloadUrl(workspaceId, preview.output_id)}
        alt={`${previewLabel(kind)} registered preview`}
        style={{ transform }}
      />
      <span>{previewLabel(kind)}</span>
    </div>;
  };

  return <section className="comparison-workspace" data-testid="comparison-workspace" data-mode={selection.mode}>
    <header className="comparison-toolbar">
      <div className="comparison-modes" role="group" aria-label="Comparison mode">
        <button type="button" aria-pressed={selection.mode === "original"} onClick={() => onMode("original")}>Original</button>
        <button type="button" aria-pressed={selection.mode === "current"} onClick={() => onMode("current")}>Current</button>
        <button type="button" disabled={!recommendedAvailable} aria-pressed={selection.mode === "recommended"} onClick={() => onMode("recommended")}>Recommended</button>
        <button type="button" aria-pressed={selection.mode === "split"} onClick={() => onMode("split")}><SplitSquareHorizontal aria-hidden="true" />Split</button>
        <button type="button" aria-pressed={selection.mode === "side_by_side"} onClick={() => onMode("side_by_side")}><Grid2X2 aria-hidden="true" />Side by side</button>
      </div>
      <div className="comparison-zoom" role="group" aria-label="Synchronized preview zoom">
        <button type="button" aria-pressed={zoom === 1} onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>100%</button>
        <button type="button" onClick={() => { setZoom(0.8); setPan({ x: 0, y: 0 }); }}><Maximize2 aria-hidden="true" />Fit</button>
        <button type="button" onClick={() => setZoom((value) => Math.min(4, value * 1.25))}><ZoomIn aria-hidden="true" />{Math.round(zoom * 100)}%</button>
      </div>
      <IconButton label="Close comparison" onClick={onClose}><X aria-hidden="true" /></IconButton>
    </header>

    <div
      className="comparison-stage"
      data-alpha-preview="checkerboard"
      onPointerDown={(event) => { drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={(event) => { if (drag.current) setPan({ x: drag.current.panX + event.clientX - drag.current.x, y: drag.current.panY + event.clientY - drag.current.y }); }}
      onPointerUp={(event) => { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }}
    >
      {mode === "original" && image("original")}
      {mode === "current" && image("current")}
      {mode === "recommended" && (recommendedAvailable
        ? image("recommended")
        : <div className="comparison-unavailable" role="status">No distinct recommended preview is available.</div>)}
      {mode === "side_by_side" && <div className="comparison-side-by-side">{image("original")}{image("current")}</div>}
      {mode === "split" && <div className="comparison-split">
        {image("original", "comparison-split-original")}
        <div className="comparison-split-current" style={{ clipPath: `inset(0 0 0 ${split}%)` }}>{image("current")}</div>
        <span className="comparison-divider" style={{ left: `${split}%` }} aria-hidden="true" />
        <input aria-label="Before and after split" type="range" min={10} max={90} value={split} onChange={(event) => setSplit(Number(event.target.value))} />
      </div>}
    </div>

    <aside className="comparison-evidence" aria-label="Preview evidence">
      <div className="comparison-histogram">
        <span><strong>Histogram</strong><small>{evidencePreview ? `Registered ${previewLabel(evidencePreview.mode).toLowerCase()} preview` : "No recommended preview"}</small></span>
        <svg viewBox="0 0 64 36" role="img" aria-label={evidencePreview ? `RGB histogram for the ${previewLabel(evidencePreview.mode).toLowerCase()} preview` : "Empty histogram because no distinct recommended preview exists"}>
          <HistogramPath values={histogram.red} colour="var(--color-error)" />
          <HistogramPath values={histogram.green} colour="var(--color-success)" />
          <HistogramPath values={histogram.blue} colour="var(--color-brand)" />
        </svg>
      </div>
      <div className="clipping-evidence">
        <span className={histogram.shadow_clipping ? "has-warning" : ""}>{histogram.shadow_clipping ? <AlertTriangle aria-hidden="true" /> : <Check aria-hidden="true" />}Shadow clipping {histogram.shadow_clipping ? "detected" : "not detected"}</span>
        <span className={histogram.highlight_clipping ? "has-warning" : ""}>{histogram.highlight_clipping ? <AlertTriangle aria-hidden="true" /> : <Check aria-hidden="true" />}Highlight clipping {histogram.highlight_clipping ? "detected" : "not detected"}</span>
      </div>
      {evidencePreview && <div className="comparison-dimensions"><strong>{evidencePreview.width} x {evidencePreview.height} px</strong><span>Registered preview dimensions</span></div>}
      <div className="comparison-proxy"><ShieldCheck aria-hidden="true" /><span><strong>Authoritative registered preview</strong><small>Rendered from the immutable document version by the durable export processor.</small></span></div>
      {!recommendedAvailable && <p className="comparison-no-recommendation">No distinct recommended preview is available for this recipe.</p>}
    </aside>

    <footer className="comparison-footer">
      <Button type="button" className="hold-original" onPointerDown={() => setHoldingOriginal(true)} onPointerUp={() => setHoldingOriginal(false)} onPointerCancel={() => setHoldingOriginal(false)} onKeyDown={(event) => { if (event.key === " " || event.key === "Enter") setHoldingOriginal(true); }} onKeyUp={() => setHoldingOriginal(false)}><Hand aria-hidden="true" />Press and hold Original</Button>
      <span>Zoom, pan and registration stay synchronized across views.</span>
    </footer>
  </section>;
}

function previewLabel(kind: EnhancementPreview["mode"]): string {
  return kind === "original" ? "Original" : kind === "current" ? "Current" : "Recommended";
}

function HistogramPath({ values, colour }: { values: number[]; colour: string }) {
  const max = Math.max(1, ...values);
  const denominator = Math.log1p(max);
  const points = values.map((value, index) => `${index},${35 - (Math.log1p(value) / denominator) * 33}`).join(" ");
  return <polyline points={points} fill="none" stroke={colour} strokeWidth="1" opacity="0.78" />;
}
