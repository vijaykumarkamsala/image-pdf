import { AlertTriangle, Check, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

import {
  MATERIAL_CLIPPING_PERCENT,
  type ImageHistogramSummary,
} from "./imageHistogram";
import { WorkerImageHistogramEngine } from "./WorkerImageHistogramEngine";

export interface ImageHistogramInput {
  blob: Blob;
  sha256: string;
  width: number;
  height: number;
  label: string;
}

function histogramPoints(values: number[], maximum: number) {
  const denominator = Math.max(1, values.length - 1);
  return values.map((value, index) => {
    const x = index / denominator * 100;
    const y = 40 - value / maximum * 38;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
}

function clippingLabel(percent: number) {
  return percent >= MATERIAL_CLIPPING_PERCENT ? "Material endpoint occupancy" : "No material endpoint occupancy";
}

export function ImageHistogramPanel({ input }: { input: ImageHistogramInput | null }) {
  const [summary, setSummary] = useState<ImageHistogramSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSummary(null);
    setError(null);
    if (!input) return;
    let current = true;
    const engine = new WorkerImageHistogramEngine();
    setBusy(true);
    void engine.analyze(input.blob, input.width, input.height).then((result) => {
      if (!current) return;
      setSummary(result.summary);
      setBusy(false);
    }).catch((reason) => {
      if (!current) return;
      setError(reason instanceof Error ? reason.message : "Histogram analysis did not complete.");
      setBusy(false);
    });
    return () => {
      current = false;
      engine.dispose();
    };
  }, [input?.sha256, input?.width, input?.height]);

  const maximum = summary
    ? Math.max(1, ...summary.red, ...summary.green, ...summary.blue, ...summary.luminance)
    : 1;
  return <section
    className="quality-histogram-panel"
    data-testid="image-histogram"
    data-preview-sha256={input?.sha256 ?? ""}
    aria-label="Current preview histogram and clipping review"
  >
    <div className="quality-histogram-heading">
      <h3>Histogram</h3>
      <span>{input?.label ?? "Preview unavailable"}</span>
    </div>
    {busy && <p className="quality-histogram-state" role="status"><LoaderCircle className="quality-spin" aria-hidden="true" />Analysing exact preview pixels…</p>}
    {error && <p className="quality-histogram-state quality-histogram-error" role="status"><AlertTriangle aria-hidden="true" />{error}</p>}
    {summary && <>
      <svg
        className="quality-histogram-chart"
        viewBox="0 0 100 42"
        preserveAspectRatio="none"
        role="img"
        aria-label={`RGB and luminance histogram for ${input?.label ?? "the current preview"}`}
      >
        <polyline className="quality-histogram-luminance" points={histogramPoints(summary.luminance, maximum)} />
        <polyline className="quality-histogram-red" points={histogramPoints(summary.red, maximum)} />
        <polyline className="quality-histogram-green" points={histogramPoints(summary.green, maximum)} />
        <polyline className="quality-histogram-blue" points={histogramPoints(summary.blue, maximum)} />
      </svg>
      <div className="quality-histogram-legend" aria-hidden="true">
        <span className="is-luminance">Luma</span><span className="is-red">R</span><span className="is-green">G</span><span className="is-blue">B</span>
      </div>
      <dl className="quality-clipping-summary">
        <div data-material={summary.shadowClippedPercent >= MATERIAL_CLIPPING_PERCENT}>
          <dt>{summary.shadowClippedPercent >= MATERIAL_CLIPPING_PERCENT ? <AlertTriangle aria-hidden="true" /> : <Check aria-hidden="true" />}Shadows ≤ 2</dt>
          <dd><strong>{summary.shadowClippedPixels.toLocaleString()}</strong> ({summary.shadowClippedPercent.toFixed(2)}%)<span>{clippingLabel(summary.shadowClippedPercent)}</span></dd>
        </div>
        <div data-material={summary.highlightClippedPercent >= MATERIAL_CLIPPING_PERCENT}>
          <dt>{summary.highlightClippedPercent >= MATERIAL_CLIPPING_PERCENT ? <AlertTriangle aria-hidden="true" /> : <Check aria-hidden="true" />}Highlights ≥ 253</dt>
          <dd><strong>{summary.highlightClippedPixels.toLocaleString()}</strong> ({summary.highlightClippedPercent.toFixed(2)}%)<span>{clippingLabel(summary.highlightClippedPercent)}</span></dd>
        </div>
      </dl>
      <p className="quality-histogram-counts">{summary.visiblePixels.toLocaleString()} visible pixels analysed{summary.transparentPixels > 0 ? ` · ${summary.transparentPixels.toLocaleString()} fully transparent pixels excluded` : ""}.</p>
    </>}
    {!busy && !error && !summary && <p className="quality-histogram-state">A verified local preview is required for histogram analysis.</p>}
    <p className="quality-histogram-note">Analysis only. It does not change preview or downloaded pixels. Endpoint occupancy may be intentional in logos and graphics.</p>
  </section>;
}

