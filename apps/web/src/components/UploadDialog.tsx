import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileUp,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import type { ProcessingJobRecord, UploadSessionRecord } from "ipw-contracts-ts/product";

import { ApiError, api, createTraceId } from "../boundaries/apiClient.ts";
import {
  mediaTypeFor,
  parseActiveUpload,
  phaseFromRecords,
  presentationFor,
  type ActiveUploadReference,
  type UploadPhase,
} from "../boundaries/uploadState.ts";

interface UploadDialogProps {
  open: boolean;
  workspaceId: string;
  onOpenChange: (open: boolean) => void;
  onReady: () => void;
}

const terminalPhases = new Set<UploadPhase>(["ready", "rejected", "cancelled", "error"]);

function storageKey(workspaceId: string): string {
  return `ipw-active-upload-${workspaceId}`;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function customerError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "The upload could not be completed. Please try again.";
}

export function UploadDialog({ open, workspaceId, onOpenChange, onReady }: UploadDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<UploadPhase>("selecting");
  const [progress, setProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [upload, setUpload] = useState<UploadSessionRecord | null>(null);
  const [job, setJob] = useState<ProcessingJobRecord | null>(null);
  const [traceId, setTraceId] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const generation = useRef(0);
  const transfer = useRef<AbortController | null>(null);
  const wasOpen = useRef(open);

  const presentation = presentationFor(phase, progress);
  const busy = ["authorising", "uploading", "queued", "inspecting"].includes(phase);

  function reset() {
    generation.current += 1;
    transfer.current?.abort();
    transfer.current = null;
    setFile(null);
    setPhase("selecting");
    setProgress(0);
    setErrorMessage(null);
    setUpload(null);
    setJob(null);
    setTraceId(null);
  }

  async function monitor(reference: ActiveUploadReference) {
    const activeGeneration = ++generation.current;
    let cursor = 0;
    let temporaryFailures = 0;
    while (generation.current === activeGeneration) {
      try {
        const [uploadResult, jobResult, eventsResult] = await Promise.all([
          api.uploadStatus(reference.uploadSessionId, reference.traceId),
          api.jobStatus(reference.jobId, reference.traceId),
          api.jobEvents(reference.jobId, cursor, reference.traceId),
        ]);
        if (generation.current !== activeGeneration) return;
        temporaryFailures = 0;
        cursor = eventsResult.next_cursor;
        const latestEvent = eventsResult.events.at(-1);
        const nextPhase = phaseFromRecords(jobResult.job, uploadResult.upload_session);
        setUpload(uploadResult.upload_session);
        setJob(jobResult.job);
        setProgress(latestEvent?.progress_percent ?? jobResult.job.progress_percent);
        setPhase(nextPhase);
        if (nextPhase === "ready") {
          sessionStorage.removeItem(storageKey(workspaceId));
          onReady();
          return;
        }
        if (nextPhase === "rejected" || nextPhase === "cancelled") {
          sessionStorage.removeItem(storageKey(workspaceId));
          setErrorMessage(uploadResult.upload_session.failure?.message ?? jobResult.job.failure?.message ?? null);
          return;
        }
      } catch (error) {
        temporaryFailures += 1;
        if (temporaryFailures >= 5) {
          setPhase("error");
          setErrorMessage(customerError(error));
          return;
        }
      }
      await wait(400);
    }
  }

  useEffect(() => {
    const reference = parseActiveUpload(sessionStorage.getItem(storageKey(workspaceId)));
    if (!reference) return;
    setPhase("queued");
    setTraceId(reference.traceId);
    setUpload({ upload_session_id: reference.uploadSessionId, display_name: reference.displayName } as UploadSessionRecord);
    setJob({ job_id: reference.jobId } as ProcessingJobRecord);
    onOpenChange(true);
    void monitor(reference);
    return () => { generation.current += 1; };
    // Recovery runs once for each workspace; callbacks remain stable for this shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  useEffect(() => {
    if (open && !wasOpen.current && terminalPhases.has(phase)) reset();
    wasOpen.current = open;
  }, [open, phase]);

  function selectFile(selected: File | null) {
    if (!selected) return;
    reset();
    setFile(selected);
  }

  async function begin() {
    if (!file) return;
    const mediaType = mediaTypeFor(file);
    if (!mediaType) {
      setPhase("error");
      setErrorMessage("Choose a supported image or PDF file.");
      return;
    }
    const operationTrace = createTraceId();
    setTraceId(operationTrace);
    setErrorMessage(null);
    setPhase("authorising");
    try {
      const created = await api.createUploadSession(workspaceId, file, mediaType, operationTrace);
      setUpload(created.upload_session);
      setPhase("uploading");
      transfer.current = new AbortController();
      const uploaded = await api.transferFile(
        created.authorization,
        file,
        created.upload_session.bytes_received,
        setProgress,
        transfer.current.signal,
      );
      transfer.current = null;
      setUpload(uploaded);
      setPhase("queued");
      const finalised = await api.finaliseUpload(created.upload_session.upload_session_id, operationTrace);
      setUpload(finalised.upload_session);
      setJob(finalised.job);
      const reference: ActiveUploadReference = {
        uploadSessionId: created.upload_session.upload_session_id,
        jobId: finalised.job.job_id,
        displayName: file.name,
        traceId: operationTrace,
      };
      sessionStorage.setItem(storageKey(workspaceId), JSON.stringify(reference));
      await monitor(reference);
    } catch (error) {
      if (error instanceof ApiError && error.code === "upload-cancelled") return;
      setPhase("error");
      setErrorMessage(customerError(error));
    }
  }

  async function cancel() {
    generation.current += 1;
    transfer.current?.abort();
    transfer.current = null;
    try {
      if (job?.job_id) await api.cancelJob(job.job_id, traceId ?? createTraceId());
      else if (upload?.upload_session_id) await api.cancelUpload(upload.upload_session_id, traceId ?? createTraceId());
      sessionStorage.removeItem(storageKey(workspaceId));
      setPhase("cancelled");
      setErrorMessage(null);
    } catch (error) {
      setPhase("error");
      setErrorMessage(customerError(error));
    }
  }

  if (!open) return null;

  const StatusIcon = phase === "ready" ? CheckCircle2 : phase === "rejected" || phase === "error" ? AlertTriangle : busy ? LoaderCircle : FileUp;
  return (
    <div className="dialog-layer" role="presentation">
      <button className="dialog-scrim" aria-label="Close upload" onClick={() => onOpenChange(false)} />
      <section className="dialog upload-dialog" role="dialog" aria-modal="true" aria-labelledby="upload-dialog-title">
        <div className="dialog-heading">
          <div className="upload-title"><span className={`upload-status-icon phase-${phase}`}><StatusIcon aria-hidden="true" /></span><div><h2 id="upload-dialog-title">{presentation.title}</h2><p>{presentation.description}</p></div></div>
          <button type="button" className="icon-button" onClick={() => onOpenChange(false)} title="Close"><X aria-hidden="true" /></button>
        </div>

        {phase === "selecting" && (
          <>
            <label
              className={dragActive ? "upload-drop active" : "upload-drop"}
              onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setDragActive(false)}
              onDrop={(event) => { event.preventDefault(); setDragActive(false); selectFile(event.dataTransfer.files.item(0)); }}
            >
              <Upload aria-hidden="true" />
              <strong>{file ? file.name : "Drop an image or PDF here"}</strong>
              <span>{file ? `${Math.max(1, Math.ceil(file.size / 1024))} KB selected` : "or choose a file from this device"}</span>
              <span className="button upload-choose">Choose file</span>
              <input type="file" accept="image/*,.pdf,application/pdf" onChange={(event) => selectFile(event.target.files?.item(0) ?? null)} />
            </label>
            <div className="upload-privacy"><ShieldCheck aria-hidden="true" /><span>Your file stays private while it is checked and added to this workspace.</span></div>
          </>
        )}

        {phase !== "selecting" && (
          <div className="upload-progress" aria-live="polite">
            <div className="upload-file-line"><FileUp aria-hidden="true" /><span>{file?.name ?? upload?.display_name ?? "Selected file"}</span><strong>{presentation.progress}%</strong></div>
            <progress value={presentation.progress} max="100">{presentation.progress}%</progress>
            {(errorMessage || upload?.failure?.message || job?.failure?.message) && (
              <div className="upload-message" role="alert">{errorMessage ?? upload?.failure?.message ?? job?.failure?.message}</div>
            )}
          </div>
        )}

        {(traceId || upload?.upload_session_id || job?.job_id) && (
          <details className="upload-details">
            <summary>Advanced details</summary>
            <dl>
              {upload?.upload_session_id && <><dt>Upload ID</dt><dd>{upload.upload_session_id}</dd></>}
              {job?.job_id && <><dt>Job ID</dt><dd>{job.job_id}</dd></>}
              {traceId && <><dt>Trace ID</dt><dd>{traceId}</dd></>}
            </dl>
          </details>
        )}

        <div className="dialog-actions upload-actions">
          {phase === "selecting" && <><button type="button" className="button" onClick={() => onOpenChange(false)}>Cancel</button><button type="button" className="button primary" disabled={!file} onClick={() => void begin()}><Upload aria-hidden="true" />Upload</button></>}
          {busy && <button type="button" className="button" onClick={() => void cancel()}>Cancel upload</button>}
          {phase === "ready" && <button type="button" className="button primary" onClick={() => onOpenChange(false)}><CheckCircle2 aria-hidden="true" />Done</button>}
          {(phase === "rejected" || phase === "cancelled" || phase === "error") && <button type="button" className="button primary" onClick={reset}><RotateCcw aria-hidden="true" />Choose another file</button>}
        </div>
      </section>
    </div>
  );
}
