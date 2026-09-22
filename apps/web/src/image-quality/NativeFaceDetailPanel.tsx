import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { FaceQualityCapabilities, FaceQualityJobView, NativeFaceCandidate } from "ipw-contracts-ts/product";

import { Button } from "../design-system";
import { createApiNativeFaceQualityCoordinator } from "./ApiNativeFaceQualityTransport";
import { NativeFaceQualityCoordinator, type NativeFaceRemoteContext } from "./NativeFaceQualityClient";
import { WorkerNativeFacePreview, type NativeFacePreview, type NativeFacePreviewer } from "./WorkerNativeFacePreview";
import { clampViewerPan } from "./viewerGeometry";

export interface NativeFaceViewerContext {
  originalUrl: string;
  baseUrl: string;
  sourceWidth: number;
  sourceHeight: number;
  outputWidth: number;
  outputHeight: number;
}

interface ReviewPreview extends NativeFacePreview {
  patchUrl: string;
  mapUrl: string;
  candidateId: string;
}

function CandidateViewer({ label, imageUrl, viewer, candidate, preview, showMap, zoom, pan, onPan }: {
  label: string; imageUrl: string; viewer: NativeFaceViewerContext; candidate?: NativeFaceCandidate;
  preview?: ReviewPreview; showMap: boolean; zoom: number | "fit"; pan: { x: number; y: number };
  onPan(x: number, y: number): void;
}) {
  const drag = useRef<{ id: number; x: number; y: number; panX: number; panY: number } | null>(null);
  const move = (element: HTMLDivElement, x: number, y: number) => {
    if (zoom === "fit") return;
    const bounded = clampViewerPan({ frameWidth: element.clientWidth, frameHeight: element.clientHeight,
      imageWidth: viewer.outputWidth, imageHeight: viewer.outputHeight, scale: zoom }, { x, y });
    onPan(bounded.x, bounded.y);
  };
  const stop = (event: PointerEvent<HTMLDivElement>) => { if (drag.current?.id === event.pointerId) drag.current = null; };
  const style = zoom === "fit" ? { width: "100%", height: "100%" }
    : { width: viewer.outputWidth, height: viewer.outputHeight,
      transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${zoom})` };
  return <figure className="quality-face-figure">
    <figcaption>{label}</figcaption>
    <div className={`quality-face-region quality-native-face-viewer${zoom === "fit" ? " quality-face-fit" : ""}`}
      tabIndex={0} role="group" aria-label={`${label}. Arrow keys pan all native face comparisons.`}
      onPointerDown={(event) => {
        if (event.button !== 0 || zoom === "fit") return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
      }} onPointerMove={(event) => {
        const active = drag.current;
        if (active?.id === event.pointerId) move(event.currentTarget,
          active.panX + event.clientX - active.x, active.panY + event.clientY - active.y);
      }} onPointerUp={stop} onPointerCancel={stop} onKeyDown={(event) => {
        const dx = event.key === "ArrowLeft" ? 24 : event.key === "ArrowRight" ? -24 : 0;
        const dy = event.key === "ArrowUp" ? 24 : event.key === "ArrowDown" ? -24 : 0;
        if (dx || dy) { event.preventDefault(); move(event.currentTarget, pan.x + dx, pan.y + dy); }
      }}>
      <svg viewBox={`0 0 ${viewer.outputWidth} ${viewer.outputHeight}`} preserveAspectRatio="xMidYMid meet"
        style={style} data-face-transform={zoom === "fit" ? "fit" : `${zoom}:${pan.x}:${pan.y}`}>
        <image href={imageUrl} x="0" y="0" width={viewer.outputWidth} height={viewer.outputHeight}
          preserveAspectRatio="none" />
        {candidate && preview && <>
          <image href={preview.patchUrl} x={candidate.region.x} y={candidate.region.y}
            width={candidate.region.width} height={candidate.region.height} />
          {showMap && <image href={preview.mapUrl} x={candidate.region.x} y={candidate.region.y}
            width={candidate.region.width} height={candidate.region.height} />}
        </>}
      </svg>
    </div>
  </figure>;
}

export function NativeFaceDetailPanel({ disabled, context, viewer, filename,
  createCoordinator = createApiNativeFaceQualityCoordinator,
  createPreviewer = () => new WorkerNativeFacePreview() }: {
  disabled: boolean; context: NativeFaceRemoteContext; viewer: NativeFaceViewerContext; filename: string;
  createCoordinator?: () => NativeFaceQualityCoordinator; createPreviewer?: () => NativeFacePreviewer;
}) {
  const [expanded, setExpanded] = useState(false);
  const [capabilities, setCapabilities] = useState<FaceQualityCapabilities | null>(null);
  const [consent, setConsent] = useState(false);
  const [job, setJob] = useState<FaceQualityJobView | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<ReviewPreview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [composition, setComposition] = useState<FaceQualityJobView | null>(null);
  const [busy, setBusy] = useState<"capability" | "candidate" | "preview" | "compose" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showMap, setShowMap] = useState(true);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const coordinator = useRef<NativeFaceQualityCoordinator | null>(null);
  const previewer = useRef<NativeFacePreviewer | null>(null);
  const active = useRef<AbortController | null>(null);
  const urls = useRef<string[]>([]);

  const releaseUrls = () => { for (const url of urls.current) URL.revokeObjectURL(url); urls.current = []; };
  const stopLocal = () => { active.current?.abort(); active.current = null; previewer.current?.dispose(); previewer.current = null; };
  const clearReview = () => {
    stopLocal(); releaseUrls(); setSelected(null); setPreview(null); setAcknowledged(false); setComposition(null);
    setJob(null); setBusy(null); setError(null); setZoom("fit"); setPan({ x: 0, y: 0 }); setShowMap(true);
  };
  useEffect(() => () => { stopLocal(); releaseUrls(); }, []);
  useEffect(() => {
    stopLocal(); releaseUrls(); coordinator.current = null; setCapabilities(null); setConsent(false); setJob(null);
    setSelected(null); setPreview(null); setAcknowledged(false); setComposition(null); setBusy(null); setError(null);
  }, [context.uploadSessionId, context.baseImageQualityRequestId, context.sourceSha256, context.baseOutputSha256]);

  const owner = () => coordinator.current ??= createCoordinator();
  const checkCapabilities = async () => {
    if (active.current) return;
    const aborter = new AbortController(); active.current = aborter; setBusy("capability"); setError(null);
    try {
      const value = await owner().capabilities(context, aborter.signal); setCapabilities(value);
      if (value.available) {
        const recoveredComposition = await owner().recover(context, "compose", aborter.signal, setComposition);
        if (recoveredComposition) {
          setComposition(recoveredComposition);
          return;
        }
        const recovered = await owner().recover(context, "candidates", aborter.signal, setJob);
        if (recovered) setJob(recovered);
      }
    } catch (failure) {
      if (!aborter.signal.aborted) setError(failure instanceof Error ? failure.message : "Native face availability could not be checked.");
    } finally { if (active.current === aborter) { active.current = null; setBusy(null); } }
  };
  const generate = async () => {
    if (!consent || !Boolean(capabilities?.available) || active.current || disabled) return;
    clearReview(); const aborter = new AbortController(); active.current = aborter; setBusy("candidate");
    try {
      const value = await owner().createCandidates(context, { fidelityPermyriad: 8000, candidateCount: 3 }, aborter.signal, setJob);
      if (value.state !== "succeeded") throw new Error(value.failure?.["message"] as string ?? "Native face candidates did not complete.");
      setJob(value);
    } catch (failure) {
      if (!aborter.signal.aborted) setError(failure instanceof Error ? failure.message : "Native face candidates could not be prepared.");
    } finally { if (active.current === aborter) { active.current = null; setBusy(null); } }
  };
  const choose = async (candidate: NativeFaceCandidate) => {
    if (!job || active.current || disabled) return;
    stopLocal(); releaseUrls(); setSelected(candidate.candidate_id); setPreview(null); setAcknowledged(false);
    setComposition(null); owner().clear(context, "compose"); setBusy("preview"); setError(null);
    const aborter = new AbortController(); active.current = aborter;
    try {
      const [pixels, mask] = await Promise.all([
        owner().candidateArtifact(context, job, candidate.candidate_id, "pixels", aborter.signal),
        owner().candidateArtifact(context, job, candidate.candidate_id, "mask", aborter.signal),
      ]);
      if (pixels.candidateSha256 !== mask.candidateSha256) throw new Error("The native candidate patch and mask review identities differ.");
      const worker = createPreviewer(); previewer.current = worker;
      const rendered = await worker.render(pixels, mask, aborter.signal);
      if (rendered.candidateSha256 !== pixels.candidateSha256) throw new Error("The native preview does not match the selected candidate.");
      const patchUrl = URL.createObjectURL(rendered.patch); const mapUrl = URL.createObjectURL(rendered.regionMap);
      urls.current.push(patchUrl, mapUrl); setPreview({ ...rendered, patchUrl, mapUrl, candidateId: candidate.candidate_id });
    } catch (failure) {
      if (!aborter.signal.aborted) setError(failure instanceof Error ? failure.message : "The native candidate comparison could not be prepared.");
    } finally { if (active.current === aborter) { active.current = null; setBusy(null); } }
  };
  const compose = async () => {
    if (!job || !preview || !acknowledged || active.current || disabled) return;
    const aborter = new AbortController(); active.current = aborter; setBusy("compose"); setError(null);
    try {
      const value = await owner().createComposition(context, job.face_quality_job_id,
        preview.candidateSha256, aborter.signal, setComposition);
      if (value.state !== "succeeded") throw new Error(value.failure?.["message"] as string ?? "Reviewed face composition did not complete.");
      setComposition(value);
    } catch (failure) {
      if (!aborter.signal.aborted) setError(failure instanceof Error ? failure.message : "The reviewed native face image could not be created.");
    } finally { if (active.current === aborter) { active.current = null; setBusy(null); } }
  };
  const cancel = async () => {
    const current = composition ?? job;
    active.current?.abort(); active.current = null;
    if (!current) { setBusy(null); return; }
    const aborter = new AbortController(); active.current = aborter; setBusy("cancel"); setError(null);
    try { const cancelled = await owner().cancel(context, current.face_quality_job_id, aborter.signal);
      if (current.operation === "compose") setComposition(cancelled); else setJob(cancelled); }
    catch (failure) { if (!aborter.signal.aborted) setError(failure instanceof Error ? failure.message : "Native face cancellation failed."); }
    finally { if (active.current === aborter) { active.current = null; setBusy(null); } }
  };
  const retry = async (current: FaceQualityJobView) => {
    if (active.current || disabled) return;
    const aborter = new AbortController(); active.current = aborter;
    setBusy(current.operation === "compose" ? "compose" : "candidate"); setError(null);
    try {
      const retried = await owner().retry(context, current.face_quality_job_id, aborter.signal,
        current.operation === "compose" ? setComposition : setJob);
      if (current.operation === "compose") setComposition(retried); else setJob(retried);
    } catch (failure) {
      if (!aborter.signal.aborted) setError(failure instanceof Error ? failure.message : "Native face retry failed.");
    } finally { if (active.current === aborter) { active.current = null; setBusy(null); } }
  };
  const withdrawConsent = () => {
    setConsent(false); clearReview(); owner().clear(context);
  };
  const selectedCandidate = job?.candidates.find((value) => value.candidate_id === selected);
  const available = Boolean(capabilities?.available);
  const retryable = composition?.state === "failed" ? composition : job?.state === "failed" ? job : null;

  return <details className="quality-face-detail" onToggle={(event) => {
    setExpanded(event.currentTarget.open);
    if (event.currentTarget.open && !active.current) void checkCapabilities();
    if (!event.currentTarget.open) {
      setConsent(false); stopLocal(); releaseUrls(); setSelected(null); setPreview(null); setAcknowledged(false);
      setBusy(null); setError(null); setZoom("fit"); setPan({ x: 0, y: 0 }); setShowMap(true);
    }
  }}>
    <summary>Restore face detail <span>{available ? "Explicit review required" : "Not yet available"}</span></summary>
    <div className="quality-face-detail-content">
      <p>This separate native mode can reconstruct plausible facial detail. It cannot recover guaranteed identity,
        and it never replaces the original or ordinary enhanced image.</p>
      {expanded && busy === "capability" && <p role="status">Checking the private server release gates…</p>}
      {capabilities && !available && <><p>The native route remains closed. No face job was created and no pixels were sent to a model.</p>
        <ul>{capabilities.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></>}
      {available && <>
        <label className="quality-face-consent"><input type="checkbox" checked={consent} disabled={disabled || Boolean(busy)}
          onChange={(event) => { if (!event.target.checked) withdrawConsent(); else setConsent(true); }} />
          I allow reconstructed face-detail candidates for this image. I will compare them with the original before approving one.</label>
        <div className="quality-face-actions">
          <Button size="compact" disabled={!consent || disabled || Boolean(busy) || job?.state === "succeeded"} onClick={() => void generate()}>
            Generate face candidates</Button>
          {(busy === "candidate" || busy === "compose") && <Button size="compact" onClick={() => void cancel()}>Cancel native face work</Button>}
          {retryable?.failure?.["retryable"] === true && consent && <Button size="compact" disabled={Boolean(busy) || disabled}
            onClick={() => void retry(retryable)}>Retry native face work</Button>}
        </div>
      </>}
      {job && <p role="status">Candidate job: {job.state.replaceAll("_", " ")} · {job.progress_percent}%</p>}
      {error && <p role="alert">{error} Your original and ordinary enhanced image remain unchanged.</p>}
      {available && consent && job?.state === "succeeded" && job.candidates.length > 0
        && <section className="quality-face-review" aria-label="Native face candidate review">
        <fieldset disabled={Boolean(busy)}><legend>Choose one candidate after comparing facial features</legend>
          {job.candidates.map((candidate, index) => <label key={candidate.candidate_id}>
            <input type="radio" name={`native-face-${job.face_quality_job_id}`} checked={selected === candidate.candidate_id}
              onChange={() => void choose(candidate)} />Candidate {index + 1}</label>)}
        </fieldset>
        {busy === "preview" && <p role="status">Preparing an integrity-checked comparison outside the UI thread…</p>}
        {selectedCandidate && preview && <>
          <div className="quality-face-actions" role="group" aria-label="Native face comparison zoom">
            {(["fit",1,2,4] as const).map((value) => <Button size="compact" key={value} aria-pressed={zoom === value}
              onClick={() => { setZoom(value); setPan({ x: 0, y: 0 }); }}>{value === "fit" ? "Fit face" : `${value * 100}% face`}</Button>)}
            <label><input type="checkbox" checked={showMap} onChange={(event) => setShowMap(event.target.checked)} />Show reconstructed region</label>
          </div>
          <p>Pink marks reconstructed pixels. This display preview may reduce 16-bit samples to the screen;
            the reviewed native composition retains its recorded precision.</p>
          <div className="quality-face-comparison">
            <CandidateViewer label="Original image" imageUrl={viewer.originalUrl} viewer={viewer} zoom={zoom} pan={pan} showMap={false} onPan={(x,y)=>setPan({x,y})} />
            <CandidateViewer label="Current enhanced image" imageUrl={viewer.baseUrl} viewer={viewer} zoom={zoom} pan={pan} showMap={false} onPan={(x,y)=>setPan({x,y})} />
            <CandidateViewer label="Proposed reconstructed face" imageUrl={viewer.baseUrl} viewer={viewer}
              candidate={selectedCandidate} preview={preview} showMap={showMap} zoom={zoom} pan={pan} onPan={(x,y)=>setPan({x,y})} />
          </div>
          <label className="quality-face-consent"><input type="checkbox" checked={acknowledged} disabled={Boolean(busy)}
            onChange={(event) => { setAcknowledged(event.target.checked); setComposition(null); owner().clear(context, "compose"); }} />
            I reviewed this candidate against the original and accept that identity, eyes, teeth or expression may differ.</label>
          <Button size="compact" disabled={!acknowledged || Boolean(busy) || disabled} onClick={() => void compose()}>
            Create reviewed face image</Button>
        </>}
      </section>}
      {composition && <p role="status">Reviewed composition: {composition.state.replaceAll("_", " ")} · {composition.progress_percent}%</p>}
      {composition?.state === "succeeded" && <Button size="compact" onClick={() => {
        const anchor = document.createElement("a"); anchor.href = owner().downloadUrl(context, composition);
        anchor.download = `${filename.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]+/g,"-") || "image"}-face-recreated.png`; anchor.click();
      }}>Download reviewed face image</Button>}
      <p>Closing this panel stops browser polling but leaves private durable work resumable until its displayed expiry.</p>
    </div>
  </details>;
}
