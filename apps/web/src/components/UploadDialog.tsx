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
import type { StoredGuestSession } from "../boundaries/session.ts";
import { IntakeFacts } from "./IntakeFacts.tsx";
import {
  mediaTypeFor,
  parseActiveUploads,
  phaseFromRecords,
  presentationFor,
  type ActiveUploadReference,
  type UploadPhase,
} from "../boundaries/uploadState.ts";

interface UploadDialogProps {
  open: boolean;
  workspaceId?: string;
  guestSession?: StoredGuestSession;
  embedded?: boolean;
  onOpenChange: (open: boolean) => void;
  onReady: () => void;
}

interface UploadItem {
  id: string;
  file?: File;
  displayName: string;
  byteSize: number;
  phase: UploadPhase;
  progress: number;
  errorMessage?: string;
  retryEligible: boolean;
  needsFile: boolean;
  saved: boolean;
  upload?: UploadSessionRecord;
  job?: ProcessingJobRecord;
  traceId: string;
}

const terminalPhases = new Set<UploadPhase>(["ready", "rejected", "cancelled", "error"]);

function storageKey(ownerScope: string): string {
  return `ipw-active-uploads-${ownerScope}`;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function customerError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "The upload could not be completed. Please try again.";
}

function canRetry(error: unknown): boolean {
  return error instanceof ApiError
    ? error.status >= 500 || ["upload-transfer-failed", "upload-response-invalid"].includes(error.code)
    : true;
}

function phaseLabel(item: UploadItem): string {
  if (item.needsFile) return "Choose the same file to resume";
  if (item.saved) return "Saved to Default Files";
  return presentationFor(item.phase, item.progress).title;
}

export function UploadDialog({
  open,
  workspaceId,
  guestSession,
  embedded = false,
  onOpenChange,
  onReady,
}: UploadDialogProps) {
  const ownerScope = guestSession?.guestSessionId ?? workspaceId ?? "unavailable";
  const [items, setItems] = useState<UploadItem[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const itemsRef = useRef<UploadItem[]>([]);
  const transfers = useRef(new Map<string, AbortController>());
  const monitors = useRef(new Map<string, number>());
  const wasOpen = useRef(open);

  const setQueue = (next: UploadItem[]) => {
    itemsRef.current = next;
    setItems(next);
  };

  const patchItem = (id: string, patch: Partial<UploadItem>) => {
    setQueue(itemsRef.current.map((item) => item.id === id ? { ...item, ...patch } : item));
  };

  function references(): ActiveUploadReference[] {
    return parseActiveUploads(sessionStorage.getItem(storageKey(ownerScope)));
  }

  function persist(reference: ActiveUploadReference): void {
    const next = [...references().filter((item) => item.uploadSessionId !== reference.uploadSessionId), reference];
    sessionStorage.setItem(storageKey(ownerScope), JSON.stringify(next));
  }

  function forget(uploadSessionId: string): void {
    const next = references().filter((item) => item.uploadSessionId !== uploadSessionId);
    if (next.length) sessionStorage.setItem(storageKey(ownerScope), JSON.stringify(next));
    else sessionStorage.removeItem(storageKey(ownerScope));
  }

  function stop(id: string): void {
    monitors.current.set(id, (monitors.current.get(id) ?? 0) + 1);
    transfers.current.get(id)?.abort();
    transfers.current.delete(id);
  }

  async function monitor(id: string, reference: ActiveUploadReference): Promise<void> {
    if (!reference.jobId) return;
    const version = (monitors.current.get(id) ?? 0) + 1;
    monitors.current.set(id, version);
    let cursor = 0;
    let temporaryFailures = 0;
    while (monitors.current.get(id) === version) {
      try {
        const [uploadResult, jobResult, eventsResult] = await Promise.all([
          api.uploadStatus(reference.uploadSessionId, reference.traceId),
          api.jobStatus(reference.jobId, reference.traceId),
          api.jobEvents(reference.jobId, cursor, reference.traceId),
        ]);
        if (monitors.current.get(id) !== version) return;
        temporaryFailures = 0;
        cursor = eventsResult.next_cursor;
        const latestEvent = eventsResult.events.at(-1);
        const nextPhase = phaseFromRecords(jobResult.job, uploadResult.upload_session);
        patchItem(id, {
          upload: uploadResult.upload_session,
          job: jobResult.job,
          progress: latestEvent?.progress_percent ?? jobResult.job.progress_percent,
          phase: nextPhase,
          errorMessage: uploadResult.upload_session.failure?.message ?? jobResult.job.failure?.message ?? undefined,
          retryEligible: Boolean(uploadResult.upload_session.failure?.retryable || jobResult.job.failure?.retryable),
        });
        if (nextPhase === "ready") {
          if (guestSession) persist({ ...reference, stage: "ready" });
          else forget(reference.uploadSessionId);
          onReady();
          return;
        }
        if (nextPhase === "rejected" || nextPhase === "cancelled") {
          forget(reference.uploadSessionId);
          return;
        }
      } catch (error) {
        temporaryFailures += 1;
        if (temporaryFailures >= 5) {
          patchItem(id, {
            phase: "error",
            errorMessage: customerError(error),
            retryEligible: true,
          });
          return;
        }
      }
      await wait(400);
    }
  }

  async function processItem(id: string): Promise<void> {
    const selected = itemsRef.current.find((item) => item.id === id);
    if (!selected?.file) return;
    const mediaType = mediaTypeFor(selected.file);
    if (!mediaType) {
      patchItem(id, {
        phase: "error",
        errorMessage: "Choose a supported image or PDF file.",
        retryEligible: false,
      });
      return;
    }
    const traceId = selected.traceId || createTraceId();
    patchItem(id, { phase: "authorising", errorMessage: undefined, traceId, needsFile: false });
    try {
      let upload = selected.upload;
      let authorization;
      if (upload && !selected.job) {
        const resumed = await api.resumeUploadSession(upload.upload_session_id, traceId);
        upload = resumed.upload_session;
        authorization = resumed.authorization;
      } else {
        const created = guestSession
          ? await api.createGuestUploadSession(selected.file, mediaType, traceId)
          : await api.createUploadSession(workspaceId!, selected.file, mediaType, traceId);
        upload = created.upload_session;
        authorization = created.authorization;
      }
      patchItem(id, { upload, phase: "uploading" });
      persist({
        uploadSessionId: upload.upload_session_id,
        displayName: selected.displayName,
        byteSize: selected.byteSize,
        traceId,
        stage: "transferring",
      });
      const transfer = new AbortController();
      transfers.current.set(id, transfer);
      const transferred = await api.transferFile(
        authorization,
        selected.file,
        upload.bytes_received,
        (progress) => patchItem(id, { progress }),
        transfer.signal,
      );
      transfers.current.delete(id);
      patchItem(id, {
        upload: transferred.uploadSession ?? {
          ...upload,
          bytes_received: transferred.bytesReceived,
          state: "uploading",
        },
        phase: "queued",
      });
      const finalised = await api.finaliseUpload(upload.upload_session_id, traceId);
      const reference: ActiveUploadReference = {
        uploadSessionId: upload.upload_session_id,
        jobId: finalised.job.job_id,
        displayName: selected.displayName,
        byteSize: selected.byteSize,
        traceId,
        stage: "processing",
      };
      patchItem(id, { upload: finalised.upload_session, job: finalised.job, phase: "queued" });
      persist(reference);
      await monitor(id, reference);
    } catch (error) {
      if (error instanceof ApiError && error.code === "upload-cancelled") return;
      patchItem(id, {
        phase: "error",
        errorMessage: customerError(error),
        retryEligible: canRetry(error),
      });
    }
  }

  async function cancel(item: UploadItem): Promise<void> {
    stop(item.id);
    try {
      if (item.job?.job_id) {
        await api.cancelJob(item.job.job_id, item.traceId);
      } else if (item.upload?.upload_session_id) {
        await api.cancelUpload(item.upload.upload_session_id, item.traceId);
      }
      if (item.upload?.upload_session_id) forget(item.upload.upload_session_id);
      patchItem(item.id, { phase: "cancelled", progress: 0, errorMessage: undefined, retryEligible: false });
    } catch (error) {
      patchItem(item.id, { phase: "error", errorMessage: customerError(error), retryEligible: true });
    }
  }

  function saveGuest(item: UploadItem): void {
    if (!guestSession || !item.upload?.upload_session_id) return;
    window.location.assign(api.loginUrl(window.location.pathname + window.location.search, item.upload.upload_session_id));
  }

  function selectFiles(selected: File[]): void {
    // A recovered queue can render before the ref update is observed by this
    // input event. Prefer the fuller snapshot so reselecting never replaces it.
    const current = items.length > itemsRef.current.length ? items : itemsRef.current;
    let next = [...current];
    for (const file of selected) {
      const recoveredIndex = next.findIndex((item) => item.needsFile
        && item.displayName === file.name && item.byteSize === file.size);
      if (recoveredIndex >= 0) {
        next = next.map((item, index) => index === recoveredIndex ? {
          ...item,
          file,
          needsFile: false,
          retryEligible: true,
          errorMessage: "Ready to resume from the verified upload position.",
        } : item);
      } else {
        next.push({
          id: crypto.randomUUID(),
          file,
          displayName: file.name,
          byteSize: file.size,
          phase: "selecting",
          progress: 0,
          retryEligible: false,
          needsFile: false,
          saved: false,
          traceId: createTraceId(),
        });
      }
    }
    setQueue(next);
  }

  function reset(): void {
    for (const item of itemsRef.current) stop(item.id);
    setQueue([]);
  }

  useEffect(() => {
    const recovered = references();
    if (!recovered.length) return;
    const restored = recovered.map<UploadItem>((reference) => ({
      id: reference.uploadSessionId,
      displayName: reference.displayName,
      byteSize: reference.byteSize,
      phase: reference.stage === "transferring" ? "error" : "queued",
      progress: 0,
      errorMessage: reference.stage === "transferring"
        ? "Choose the same file to continue this upload."
        : undefined,
      retryEligible: reference.stage !== "transferring",
      needsFile: reference.stage === "transferring",
      saved: false,
      upload: { upload_session_id: reference.uploadSessionId, display_name: reference.displayName } as UploadSessionRecord,
      job: reference.jobId ? { job_id: reference.jobId } as ProcessingJobRecord : undefined,
      traceId: reference.traceId,
    }));
    setQueue(restored);
    onOpenChange(true);
    for (const [index, reference] of recovered.entries()) {
      if (reference.jobId) void monitor(restored[index].id, reference);
    }
    return () => {
      for (const item of restored) stop(item.id);
    };
    // Recovery is keyed by the server-issued owner scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerScope]);

  useEffect(() => {
    if (open && !wasOpen.current && items.length > 0
      && items.every((item) => terminalPhases.has(item.phase) && !item.needsFile)) {
      reset();
    }
    wasOpen.current = open;
    // Reset only on a closed-to-open transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const busy = items.some((item) => ["authorising", "uploading", "queued", "inspecting"].includes(item.phase));
  const eligible = items.filter((item) => item.file && (
    item.phase === "selecting" || (item.phase === "error" && item.retryEligible)
  ));
  const content = (
    <section
      className={embedded ? "upload-workspace" : "dialog upload-dialog upload-dialog-multi"}
      role={embedded ? undefined : "dialog"}
      aria-modal={embedded ? undefined : "true"}
      aria-labelledby="upload-dialog-title"
    >
      <div className="dialog-heading">
        <div className="upload-title">
          <span className="upload-status-icon phase-selecting"><FileUp aria-hidden="true" /></span>
          <div>
            <h2 id="upload-dialog-title">{items.length ? `${items.length} ${items.length === 1 ? "file" : "files"} selected` : "Upload files"}</h2>
            <p>Each file is checked separately before it becomes available.</p>
          </div>
        </div>
        {!embedded && <button type="button" className="icon-button" onClick={() => onOpenChange(false)} title="Close"><X aria-hidden="true" /></button>}
      </div>

      <label
        className={dragActive ? "upload-drop upload-drop-compact active" : "upload-drop upload-drop-compact"}
        onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setDragActive(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragActive(false);
          selectFiles([...event.dataTransfer.files]);
        }}
      >
        <Upload aria-hidden="true" />
        <strong>Drop images or PDFs here</strong>
        <span>or choose files from this device</span>
        <span className="button upload-choose">Choose files</span>
        <input
          type="file"
          multiple
          accept="image/*,.pdf,application/pdf"
          onChange={(event) => selectFiles([...(event.target.files ?? [])])}
        />
      </label>

      {items.length > 0 && (
        <ul className="upload-queue" aria-label="Selected files">
          {items.map((item) => {
            const active = ["authorising", "uploading", "queued", "inspecting"].includes(item.phase);
            const Icon = item.phase === "ready"
              ? CheckCircle2
              : item.phase === "error" || item.phase === "rejected"
                ? AlertTriangle
                : active ? LoaderCircle : FileUp;
            return (
              <li className={`upload-item phase-${item.phase}`} key={item.id}>
                <span className="upload-item-icon"><Icon aria-hidden="true" /></span>
                <div className="upload-item-copy">
                  <strong>{item.displayName}</strong>
                  <span>{phaseLabel(item)}</span>
                  {active && <progress value={item.progress} max="100">{item.progress}%</progress>}
                  {item.errorMessage && <span className="upload-item-error" role="alert">{item.errorMessage}</span>}
                </div>
                <div className="upload-item-actions">
                  {active && <button type="button" className="icon-button" title={`Cancel ${item.displayName}`} onClick={() => void cancel(item)}><X aria-hidden="true" /></button>}
                  {item.phase === "error" && item.retryEligible && !item.needsFile && (
                    <button type="button" className="button compact" onClick={() => item.job ? void monitor(item.id, {
                      uploadSessionId: item.upload!.upload_session_id,
                      jobId: item.job.job_id,
                      displayName: item.displayName,
                      byteSize: item.byteSize,
                      traceId: item.traceId,
                      stage: "processing",
                    }) : void processItem(item.id)}><RotateCcw aria-hidden="true" />Retry</button>
                  )}
                  {guestSession && item.phase === "ready" && !item.saved && (
                    <button type="button" className="button primary compact" onClick={() => void saveGuest(item)}>Sign in to save</button>
                  )}
                </div>
                {item.phase === "ready" && item.upload?.source_facts && (
                  <IntakeFacts upload={item.upload} traceId={item.traceId} />
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="upload-privacy">
        <ShieldCheck aria-hidden="true" />
        <span>{guestSession
          ? "Temporary files stay private and expire after 24 hours unless you sign in to save them."
          : "Files stay private while they are checked and added to this workspace."}</span>
      </div>

      <div className="dialog-actions upload-actions">
        {!embedded && <button type="button" className="button" onClick={() => onOpenChange(false)}>Close</button>}
        {items.length > 0 && items.every((item) => terminalPhases.has(item.phase)) && !busy && (
          <button type="button" className="button" onClick={reset}>Clear</button>
        )}
        <button
          type="button"
          className="button primary"
          disabled={!eligible.length || busy}
          onClick={() => void Promise.allSettled(eligible.map((item) => processItem(item.id)))}
        >
          <Upload aria-hidden="true" />Upload {eligible.length || "files"}
        </button>
      </div>
    </section>
  );

  if (embedded) return content;
  return (
    <div className="dialog-layer" role="presentation">
      <button className="dialog-scrim" aria-label="Close upload" onClick={() => onOpenChange(false)} />
      {content}
    </div>
  );
}
