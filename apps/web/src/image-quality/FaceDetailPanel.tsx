import { useEffect, useRef, useState, type PointerEvent } from "react";

import { Button } from "../design-system";
import {
  FACE_DETAIL_RELEASE, faceModelBlockers, generateFaceDetailCandidates,
  type FaceDetailCandidate, type FaceModelRelease, type FaceRestorationEngine,
} from "./faceDetailRestoration";
import { WorkerFaceReviewRenderer, type FaceReviewInput, type FaceReviewOutput, type FaceReviewRenderer } from "./WorkerFaceReviewRenderer";
import { clampViewerPan } from "./viewerGeometry";

interface FaceAdapter {
  release: Readonly<FaceModelRelease>;
  create(): FaceRestorationEngine;
}

interface PreviewUrls {
  original: string;
  base: string;
  candidates: Array<{ candidateSha256: string; url: string; mapUrl: string }>;
  width: number;
  height: number;
}

function RegionViewer({ url, mapUrl, label, width, height, zoom, pan, onPan }: {
  url: string; mapUrl?: string; label: string; width: number; height: number;
  zoom: number | "fit"; pan: { x: number; y: number }; onPan(x: number, y: number): void;
}) {
  const drag = useRef<{ id: number; x: number; y: number; panX: number; panY: number } | null>(null);
  const move = (element: HTMLDivElement, x: number, y: number) => {
    if (zoom === "fit") return;
    const bounded = clampViewerPan({ frameWidth: element.clientWidth, frameHeight: element.clientHeight,
      imageWidth: width, imageHeight: height, scale: zoom }, { x, y });
    onPan(bounded.x, bounded.y);
  };
  const style = zoom === "fit"
    ? { width, height, maxWidth: "calc(100% - 16px)", maxHeight: "calc(100% - 16px)", objectFit: "contain" as const }
    : { width, height, transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${zoom})` };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === event.pointerId) drag.current = null;
  };
  return <figure className="quality-face-figure">
    <figcaption>{label}</figcaption>
    <div className={`quality-face-region${zoom === "fit" ? " quality-face-fit" : ""}`} tabIndex={0}
      role="group" aria-label={`${label}. Arrow keys pan all face comparisons.`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
      }} onPointerMove={(event) => {
        const active = drag.current;
        if (active?.id === event.pointerId) move(event.currentTarget, active.panX + event.clientX - active.x, active.panY + event.clientY - active.y);
      }} onPointerUp={end} onPointerCancel={end} onKeyDown={(event) => {
        const dx = event.key === "ArrowLeft" ? 24 : event.key === "ArrowRight" ? -24 : 0;
        const dy = event.key === "ArrowUp" ? 24 : event.key === "ArrowDown" ? -24 : 0;
        if (dx || dy) { event.preventDefault(); move(event.currentTarget, pan.x + dx, pan.y + dy); }
      }}>
      <img src={url} alt={label} draggable={false} style={style} data-face-transform={zoom === "fit" ? "fit" : `${zoom}:${pan.x}:${pan.y}`} />
      {mapUrl && <img src={mapUrl} alt="" aria-hidden="true" className="quality-face-map" draggable={false} style={style} />}
    </div>
  </figure>;
}

/** No adapter is registered by default; test injection cannot act as a runtime flag. */
export function FaceDetailPanel({ disabled, input, filename = "image", adapter,
  createRenderer = () => new WorkerFaceReviewRenderer() }: {
  disabled: boolean; input?: FaceReviewInput; filename?: string;
  adapter?: FaceAdapter; createRenderer?: () => FaceReviewRenderer;
}) {
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState<"idle" | "generating" | "review" | "applying" | "complete">("idle");
  const [error, setError] = useState<string | null>(null);
  const [previews, setPreviews] = useState<PreviewUrls | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [output, setOutput] = useState<(FaceReviewOutput & { url: string }) | null>(null);
  const [showMap, setShowMap] = useState(true);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const revision = useRef(0);
  const active = useRef<AbortController | null>(null);
  const model = useRef<FaceRestorationEngine | null>(null);
  const renderer = useRef<FaceReviewRenderer | null>(null);
  const candidates = useRef<Array<FaceDetailCandidate & { candidateSha256: string }>>([]);
  const urls = useRef<string[]>([]);
  const release = adapter?.release ?? FACE_DETAIL_RELEASE;
  const blockers = faceModelBlockers(release);
  const unavailable = !adapter || blockers.length > 0;
  const busy = status === "generating" || status === "applying";

  const dispose = () => {
    revision.current += 1;
    active.current?.abort(); active.current = null;
    model.current?.dispose(); model.current = null;
    renderer.current?.dispose(); renderer.current = null;
    candidates.current = [];
    for (const url of urls.current) URL.revokeObjectURL(url);
    urls.current = [];
  };
  const clear = () => {
    dispose(); setConsent(false); setStatus("idle"); setError(null); setPreviews(null);
    setSelected(null); setAcknowledged(false); setOutput(null); setZoom("fit"); setPan({ x: 0, y: 0 }); setShowMap(true);
  };
  useEffect(() => {
    clear();
    return dispose;
  }, [input?.context.sourceSha256, input?.context.baseOutputSha256, input?.context.sourceWidth,
    input?.context.sourceHeight, input?.context.outputWidth, input?.context.outputHeight, disabled,
    release.id, release.version, release.weightsSha256, release.dependencyLockSha256,
    release.commercialRights, release.rightsEvidenceId, release.qualityReview, release.qualityEvidenceId]);
  const objectUrl = (blob: Blob) => {
    const url = URL.createObjectURL(blob); urls.current.push(url); return url;
  };

  const generate = async () => {
    if (unavailable || !adapter || !input || !consent || disabled || active.current) return;
    dispose(); setPreviews(null); setOutput(null); setSelected(null); setAcknowledged(false); setError(null); setStatus("generating");
    const currentRevision = revision.current;
    const aborter = new AbortController(); active.current = aborter;
    try {
      const engine = adapter.create(); model.current = engine;
      if ((Object.keys(FACE_DETAIL_RELEASE) as Array<keyof FaceModelRelease>).some((key) => engine.release[key] !== adapter.release[key])) throw new Error("The face adapter does not match its approved release.");
      const worker = createRenderer(); renderer.current = worker;
      const pixels = await worker.prepare(input, engine.release, aborter.signal);
      const proposals = await generateFaceDetailCandidates(engine, {
        context: input.context, sourcePixels: pixels,
        consent: { sourceSha256: input.context.sourceSha256, allowReconstructedFaceDetail: true },
        fidelity: 0.8, candidateCount: 3,
      }, aborter.signal);
      const regions = await worker.preview(proposals, aborter.signal);
      if (revision.current !== currentRevision) return;
      if (regions.candidates.length !== proposals.length || regions.candidates.some((view, index) => view.candidateSha256 !== proposals[index].candidateSha256)) throw new Error("Comparison previews do not match the current face candidates.");
      candidates.current = proposals;
      setPreviews({ original: objectUrl(regions.original), base: objectUrl(regions.base),
        candidates: regions.candidates.map((view) => ({ candidateSha256: view.candidateSha256, url: objectUrl(view.bytes), mapUrl: objectUrl(view.regionMap) })),
        width: regions.sourceRegion.width, height: regions.sourceRegion.height });
      setStatus("review");
    } catch (failure) {
      if (revision.current !== currentRevision) return;
      renderer.current?.dispose(); renderer.current = null;
      model.current?.dispose(); model.current = null;
      setError(failure instanceof Error ? failure.message : "Face candidates could not be prepared."); setStatus("idle");
    } finally {
      if (revision.current === currentRevision) active.current = null;
    }
  };

  const apply = async () => {
    if (!selected || !acknowledged || !input || !renderer.current || disabled || active.current) return;
    const candidate = candidates.current.find((value) => value.candidateSha256 === selected);
    if (!candidate) return;
    const aborter = new AbortController(); active.current = aborter;
    const currentRevision = revision.current;
    setStatus("applying"); setError(null);
    try {
      const result = await renderer.current.apply(candidate, {
        sourceSha256: input.context.sourceSha256, baseOutputSha256: input.context.baseOutputSha256,
        candidateSha256: selected, allowReconstructedFaceDetail: true, acknowledgedPossibleIdentityChange: true,
      }, aborter.signal);
      if (revision.current !== currentRevision) return;
      if (result.evidence.candidateSha256 !== selected || result.evidence.sourceSha256 !== input.context.sourceSha256
        || result.evidence.baseOutputSha256 !== input.context.baseOutputSha256) throw new Error("The composed face image does not match the reviewed candidate.");
      setOutput({ ...result, url: objectUrl(new Blob([result.bytes], { type: "image/png" })) }); setStatus("complete");
    } catch (failure) {
      if (revision.current === currentRevision) { setError(failure instanceof Error ? failure.message : "The reviewed face image could not be rendered."); setStatus("review"); }
    } finally { if (revision.current === currentRevision) active.current = null; }
  };
  const preview = previews?.candidates.find((value) => value.candidateSha256 === selected) ?? previews?.candidates[0];

  return <details className="quality-face-detail" onToggle={(event) => {
    if (!event.currentTarget.open) clear();
  }}>
    <summary>Restore face detail <span>{unavailable ? "Not yet available" : "Explicit review required"}</span></summary>
    <div className="quality-face-detail-content">
      <p>This separate mode would reconstruct plausible facial detail, not recover guaranteed original detail.
        It may change identity, eyes or expression. Ordinary Enhance quality does not enable it.</p>
      <label className="quality-face-consent">
        <input
          type="checkbox"
          checked={consent}
          disabled={disabled || busy}
          onChange={(event) => { if (!event.target.checked) clear(); else setConsent(true); }}
        />
        <span>I allow reconstructed face-detail candidates for this image. I will compare them with the original before approving one.</span>
      </label>
      {consent && status === "idle" && <p>Permission recorded for this image only. {unavailable
        ? "No face model has run and no pixels have changed." : "No face candidate is applied automatically."}</p>}
      {unavailable ? <>
        <p>Unavailable: no face model currently passes all release gates.</p>
        <ul>{blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
      </> : !input && <p>Enhance this image first to prepare an immutable base result for face comparison.</p>}
      <div className="quality-face-actions">
        <Button size="compact" disabled={unavailable || !input || !consent || disabled || busy} onClick={() => void generate()}>
          {unavailable ? "Generate face candidates (unavailable)" : "Generate face candidates"}
        </Button>
        {busy && <Button size="compact" onClick={clear}>Cancel face restoration</Button>}
      </div>
      <div role="status" aria-live="polite">{status === "generating" ? "Preparing three face candidates in background workers…"
        : status === "applying" ? "Rendering only your reviewed candidate…"
          : status === "complete" ? "Separate face-restored PNG ready. Your original and ordinary enhanced result are unchanged." : ""}</div>
      {error && <p role="alert">{error} Your original and previous enhanced image remain unchanged.</p>}
      {previews && preview && <section className="quality-face-review" aria-label="Face candidate review">
        <fieldset disabled={busy}><legend>Choose one candidate after comparing facial features</legend>
          {previews.candidates.map((value, index) => <label key={value.candidateSha256}>
            <input type="radio" name={`face-candidate-${input?.context.sourceSha256}`} value={value.candidateSha256}
              checked={selected === value.candidateSha256} onChange={() => {
                if (output) URL.revokeObjectURL(output.url);
                setSelected(value.candidateSha256); setAcknowledged(false); setOutput(null); setStatus("review");
              }} />Candidate {index + 1}
          </label>)}
        </fieldset>
        <div className="quality-face-actions" role="group" aria-label="Face comparison zoom">
          {(["fit", 1, 2, 4] as const).map((value) => <Button size="compact" key={value} aria-pressed={zoom === value}
            onClick={() => { setZoom(value); setPan({ x: 0, y: 0 }); }}>{value === "fit" ? "Fit face" : `${value * 100}% face`}</Button>)}
          <label><input type="checkbox" checked={showMap} onChange={(event) => setShowMap(event.target.checked)} />Show reconstructed region</label>
        </div>
        <p>Pink marks the proposed reconstructed pixels. Zoom/pan changes viewing only. No candidate is applied automatically.</p>
        <div className="quality-face-comparison">
          <RegionViewer url={previews.original} label="Original face" width={previews.width} height={previews.height} zoom={zoom} pan={pan} onPan={(x, y) => setPan({ x, y })} />
          <RegionViewer url={previews.base} label="Current enhanced face" width={previews.width} height={previews.height} zoom={zoom} pan={pan} onPan={(x, y) => setPan({ x, y })} />
          <RegionViewer url={preview.url} mapUrl={showMap ? preview.mapUrl : undefined} label="Proposed reconstructed face" width={previews.width} height={previews.height} zoom={zoom} pan={pan} onPan={(x, y) => setPan({ x, y })} />
        </div>
        <label className="quality-face-consent"><input type="checkbox" checked={acknowledged} disabled={!selected || busy}
          onChange={(event) => setAcknowledged(event.target.checked)} />I reviewed this candidate against the original and accept that identity, eyes, teeth or expression may differ.</label>
        <Button size="compact" disabled={!selected || !acknowledged || busy || disabled || Boolean(output)} onClick={() => void apply()}>Create reviewed face image</Button>
        {output && <>
          <Button size="compact" onClick={() => {
            const anchor = document.createElement("a"); anchor.href = output.url;
            anchor.download = `${filename.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]+/g, "-") || "image"}-face-recreated.png`;
            anchor.click();
          }}>Download face-restored image</Button>
          <details className="quality-face-final"><summary>View complete reviewed face image</summary><img src={output.url} alt="Complete reviewed face-restored image" />
            <p>Output SHA-256: <code>{output.outputSha256}</code></p>
            <p>{output.evidence.changedPixels} changed pixels; source region {output.evidence.sourceRegion.x}, {output.evidence.sourceRegion.y}, {output.evidence.sourceRegion.width} × {output.evidence.sourceRegion.height}.</p>
          </details>
        </>}
      </section>}
      <p>Your original and current enhanced result remain available. {unavailable ? "This is unfinished face-restoration work, not an enhancement result." : "Face reconstruction creates a separate reviewed derivative; it never replaces ordinary enhancement."}</p>
    </div>
  </details>;
}
