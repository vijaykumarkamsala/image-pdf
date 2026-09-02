import { useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Eye, Grid2X2, Hand, Maximize2, SplitSquareHorizontal, X, ZoomIn } from "lucide-react";
import type { ComparisonMode, HistogramSummary, ImageOperation } from "ipw-contracts-ts/product";

import { Button, IconButton } from "../design-system";
import type { ComparisonSelection } from "./EnhancementWorkspace";
import { operationFilter } from "./comparisonModel";

export function ComparisonWorkspace({ selection, sourceUrl, currentImage, histogram, onMode, onClose }: {
  selection: ComparisonSelection;
  sourceUrl: string;
  currentImage: string;
  histogram: HistogramSummary;
  onMode: (mode: ComparisonMode) => void;
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [split, setSplit] = useState(50);
  const [holdingOriginal, setHoldingOriginal] = useState(false);
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const currentFilter = useMemo(() => operationFilter(selection.operations), [selection.operations]);
  const recommendedFilter = useMemo(() => operationFilter(selection.recommendedOperations ?? selection.operations), [selection]);
  const mode = holdingOriginal ? "original" : selection.mode;
  const transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;

  const image = (kind: "original" | "current" | "recommended", className = "") => <div className={`comparison-image ${className}`} data-comparison-image={kind}>
    <img
      src={kind === "original" ? sourceUrl : currentImage}
      alt={`${kind} interactive preview`}
      style={{ transform, filter: kind === "original" ? "none" : kind === "recommended" ? recommendedFilter : currentFilter }}
      onError={(event) => { if (event.currentTarget.src !== currentImage) event.currentTarget.src = currentImage; }}
    />
    <span>{kind === "original" ? "Original" : kind === "current" ? "Current" : "Recommended"}</span>
  </div>;

  return <section className="comparison-workspace" data-testid="comparison-workspace" data-mode={selection.mode}>
    <header className="comparison-toolbar">
      <div className="comparison-modes" role="group" aria-label="Comparison mode">
        <button type="button" aria-pressed={selection.mode === "original"} onClick={() => onMode("original")}>Original</button>
        <button type="button" aria-pressed={selection.mode === "current"} onClick={() => onMode("current")}>Current</button>
        <button type="button" aria-pressed={selection.mode === "recommended"} onClick={() => onMode("recommended")}>Recommended</button>
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
      {mode === "recommended" && image("recommended")}
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
        <span><strong>Histogram</strong><small>Interactive preview sample</small></span>
        <svg viewBox="0 0 64 36" role="img" aria-label="RGB histogram for the interactive preview">
          <HistogramPath values={histogram.red} colour="var(--color-error)" />
          <HistogramPath values={histogram.green} colour="var(--color-success)" />
          <HistogramPath values={histogram.blue} colour="var(--color-brand)" />
        </svg>
      </div>
      <div className="clipping-evidence">
        <span className={histogram.shadow_clipping ? "has-warning" : ""}>{histogram.shadow_clipping ? <AlertTriangle aria-hidden="true" /> : <Check aria-hidden="true" />}Shadow clipping {histogram.shadow_clipping ? "detected" : "not detected"}</span>
        <span className={histogram.highlight_clipping ? "has-warning" : ""}>{histogram.highlight_clipping ? <AlertTriangle aria-hidden="true" /> : <Check aria-hidden="true" />}Highlight clipping {histogram.highlight_clipping ? "detected" : "not detected"}</span>
      </div>
      <div className="comparison-dimensions"><strong>{selection.preview.width} x {selection.preview.height} px</strong><span>Estimated output dimensions</span></div>
      <div className="comparison-proxy"><Eye aria-hidden="true" /><span><strong>Interactive proxy</strong><small>Final pixels are rendered from the immutable source by the durable full-resolution worker.</small></span></div>
    </aside>

    <footer className="comparison-footer">
      <Button type="button" className="hold-original" onPointerDown={() => setHoldingOriginal(true)} onPointerUp={() => setHoldingOriginal(false)} onPointerCancel={() => setHoldingOriginal(false)} onKeyDown={(event) => { if (event.key === " " || event.key === "Enter") setHoldingOriginal(true); }} onKeyUp={() => setHoldingOriginal(false)}><Hand aria-hidden="true" />Press and hold Original</Button>
      <span>Zoom and pan stay synchronized across views.</span>
    </footer>
  </section>;
}

function HistogramPath({ values, colour }: { values: number[]; colour: string }) {
  const max = Math.max(1, ...values);
  const denominator = Math.log1p(max);
  const points = values.map((value, index) => `${index},${35 - (Math.log1p(value) / denominator) * 33}`).join(" ");
  return <polyline points={points} fill="none" stroke={colour} strokeWidth="1" opacity="0.78" />;
}
