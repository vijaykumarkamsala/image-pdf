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
import { browserCoordinator } from "../boundaries/crossTab.ts";
import type { StoredGuestSession } from "../boundaries/session.ts";
import { Button, Dropzone, IconButton } from "../design-system";
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
    return parseActiveUploads(localStorage.getItem(storageKey(ownerScope)));
  }

  function persist(reference: ActiveUploadReference): void {
    const current = references();
    const prior = current.find((item) => item.uploadSessionId === reference.uploadSessionId);
    if (prior && JSON.stringify(prior) === JSON.stringify(reference)) return;
    const next = [...current.filter((item) => item.uploadSessionId !== reference.uploadSessionId), reference];
    localStorage.setItem(storageKey(ownerScope), JSON.stringify(next));
    browserCoordinator?.publish({ type: "upload.changed", ownerScope, uploadSessionId: reference.uploadSessionId });
  }

  function forget(uploadSessionId: string): void {
    const next = references().filter((item) => item.uploadSessionId !== uploadSessionId);
    if (next.length) localStorage.setItem(storageKey(ownerScope), JSON.stringify(next));
    else localStorage.removeItem(storageKey(ownerScope));
    browserCoordinator?.publish({ type: "upload.changed", ownerScope, uploadSessionId });
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
    if (!selected) return;
    const leadershipId = selected.upload?.upload_session_id ?? selected.id;
    const completed = await browserCoordinator?.withUploadLeadership(leadershipId, () => processItemAsLeader(id));
    if (completed === null) {
      const reference = references().find((item) => item.uploadSessionId === selected.upload?.upload_session_id);
      patchItem(id, {
        phase: reference?.jobId ? "queued" : "error",
        errorMessage: "This upload is continuing in another open tab. Its verified status will appear here.",
        retryEligible: !reference?.jobId,
      });
      if (reference?.jobId) await monitor(id, reference);
    }
  }

  async function processItemAsLeader(id: string): Promise<void> {
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
    const mutationId = item.upload?.upload_session_id ?? item.id;
    const completed = await browserCoordinator?.withUploadLeadership(mutationId, async () => {
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
    });
    if (completed === null) patchItem(item.id, {
      errorMessage: "This upload is controlled by another open tab. Close it there or wait for its status to update.",
    });
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
    const restore = () => {
      const recovered = references();
      if (!recovered.length) return;
      const restored = recovered.map<UploadItem>((reference) => {
        const current = itemsRef.current.find((item) => item.upload?.upload_session_id === reference.uploadSessionId);
        return {
          id: current?.id ?? reference.uploadSessionId,
          displayName: reference.displayName,
          byteSize: reference.byteSize,
          phase: reference.stage === "transferring" ? "error" : reference.stage === "ready" ? "queued" : "queued",
          progress: current?.progress ?? 0,
          errorMessage: reference.stage === "transferring"
            ? "Choose the same file to continue this upload."
            : undefined,
          retryEligible: reference.stage !== "transferring",
          needsFile: reference.stage === "transferring",
          saved: false,
          upload: { ...(current?.upload ?? {}), upload_session_id: reference.uploadSessionId, display_name: reference.displayName } as UploadSessionRecord,
          job: reference.jobId ? { ...(current?.job ?? {}), job_id: reference.jobId } as ProcessingJobRecord : undefined,
          traceId: reference.traceId,
        };
      });
      const recoveredIds = new Set(restored.map((item) => item.upload?.upload_session_id));
      setQueue([...itemsRef.current.filter((item) => !recoveredIds.has(item.upload?.upload_session_id)), ...restored]);
      onOpenChange(true);
      for (const [index, reference] of recovered.entries()) {
        if (reference.jobId) void monitor(restored[index].id, reference);
      }
    };
    restore();
    const unsubscribe = browserCoordinator?.subscribe((event) => {
      if (event.type === "upload.changed" && event.ownerScope === ownerScope) restore();
    });
    return () => {
      unsubscribe?.();
      for (const item of itemsRef.current) stop(item.id);
    };
    // Server-issued owner scope keeps resumable references isolated.
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
    item.phase === "selecting" || (item.phase === "error" && item.retryEligible && !item.job)
  ));
  const uploadLabel = eligible.length === 1 ? "Upload 1 file" : `Upload ${eligible.length} files`;
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
        {!embedded && <IconButton label="Close upload" onClick={() => onOpenChange(false)}><X aria-hidden="true" /></IconButton>}
      </div>

      <Dropzone
        label="Drop images or PDFs here"
        description="or choose files from this device"
        accept="image/*,.pdf,application/pdf"
        onFiles={selectFiles}
      />

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
                  {active && <IconButton label={`Cancel ${item.displayName}`} onClick={() => void cancel(item)}><X aria-hidden="true" /></IconButton>}
                  {item.phase === "error" && item.retryEligible && !item.needsFile && item.job && (
                    <Button size="compact" onClick={() => item.job ? void monitor(item.id, {
                      uploadSessionId: item.upload!.upload_session_id,
                      jobId: item.job.job_id,
                      displayName: item.displayName,
                      byteSize: item.byteSize,
                      traceId: item.traceId,
                      stage: "processing",
                    }) : void processItem(item.id)}><RotateCcw aria-hidden="true" />Retry</Button>
                  )}
                  {guestSession && item.phase === "ready" && !item.saved && (
                    <Button tone="primary" size="compact" onClick={() => void saveGuest(item)}>Sign in to save</Button>
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
        {!embedded && <Button onClick={() => onOpenChange(false)}>Close</Button>}
        {items.length > 0 && items.every((item) => terminalPhases.has(item.phase)) && !busy && (
          <Button onClick={reset}>Clear</Button>
        )}
        {busy && <Button tone="primary" disabled><LoaderCircle aria-hidden="true" />Upload in progress</Button>}
        {!busy && eligible.length > 0 && <Button
          tone="primary"
          onClick={() => void Promise.allSettled(eligible.map((item) => processItem(item.id)))}
        >
          <Upload aria-hidden="true" />{uploadLabel}
        </Button>}
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
