import { useCallback, useEffect, useRef, useState } from "react";
import type { DocumentReadModel, EditorDocumentSnapshot, EditorMutation } from "ipw-contracts-ts/product";

import { ApiError, api, createTraceId } from "../boundaries/apiClient";
import {
  appendPendingOperation,
  cleanupEditorJournals,
  listPendingOperations,
  removePendingOperation,
  retryDelay,
  updatePendingOperation,
  type NewPendingEditorOperation,
  type PendingEditorOperation,
} from "./editorJournal";
import { EditorTabCoordinator } from "./editorTabs";
import { applyOptimisticMutation } from "./nativeOperations";
import { SingleFlight } from "./singleFlight";

export type SaveState = "saved" | "saving" | "offline" | "conflict" | "failed" | "read-only";

export function useDurableEditorSession(workspaceId: string, documentId: string) {
  const serverRef = useRef<DocumentReadModel | null>(null);
  const editorRef = useRef<DocumentReadModel | null>(null);
  const actorIdRef = useRef("");
  const leaseRef = useRef("");
  const pendingRef = useRef<PendingEditorOperation[]>([]);
  const drainFlightRef = useRef(new SingleFlight<void>());
  const releaseFlightRef = useRef(new SingleFlight<boolean>());
  const journalWritesRef = useRef<Promise<void>>(Promise.resolve());
  const retryTimerRef = useRef<number | null>(null);
  const acquireKeyRef = useRef(`editor-lease-${crypto.randomUUID()}`);
  const leaseStorageKeyRef = useRef("");
  const tabRef = useRef<EditorTabCoordinator | null>(null);
  const mountedRef = useRef(true);
  const unloadingRef = useRef(false);
  const saveStateRef = useRef<SaveState>("saving");
  const [editor, setEditor] = useState<DocumentReadModel | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saving");
  const [message, setMessage] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [leaseHeld, setLeaseHeld] = useState(false);
  const [takeoverRequest, setTakeoverRequest] = useState<{
    actorId: string;
    actorDisplayName: string;
    reason: string;
    requestedAt: string;
  } | null>(null);

  const publish = useCallback((server = serverRef.current, pending = pendingRef.current) => {
    if (!server) return;
    let snapshot = structuredClone(server.snapshot);
    try {
      for (const operation of pending) snapshot = applyOptimisticMutation(snapshot, operation.mutation);
    } catch (reason) {
      setSaveState("conflict");
      setMessage(reason instanceof Error ? reason.message : "Pending edits need review");
      return;
    }
    const next: DocumentReadModel = {
      ...server,
      document: { ...server.document, current_revision: snapshot.revision },
      snapshot,
    };
    editorRef.current = next;
    if (mountedRef.current) {
      setEditor(next);
      setPendingCount(pending.length);
    }
  }, []);

  const scheduleDrain = useCallback((delay: number, drain: () => Promise<void>) => {
    if (!mountedRef.current) return;
    if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = window.setTimeout(() => void drain(), delay);
  }, []);

  const drain = useCallback(function drainQueue(): Promise<void> {
    return drainFlightRef.current.run(async () => {
      if (!leaseRef.current || pendingRef.current.length === 0) return;
      if (!navigator.onLine) {
        if (mountedRef.current) setSaveState("offline");
        return;
      }
      while (pendingRef.current.length > 0 && leaseRef.current && navigator.onLine) {
        const operation = pendingRef.current[0]!;
        const wait = operation.nextAttemptAt - Date.now();
        if (wait > 0) {
          scheduleDrain(wait, drainQueue);
          return;
        }
        if (mountedRef.current) setSaveState("saving");
        try {
          const response = await api.mutateDocument(
            workspaceId,
            documentId,
            leaseRef.current,
            operation.baseRevision,
            operation.mutation,
            {
              operationId: operation.operationId,
              idempotencyKey: operation.idempotencyKey,
              traceId: operation.traceId,
            },
          );
          const currentServer = serverRef.current!;
          const nextServer: DocumentReadModel = {
            ...currentServer,
            document: response.mutation.document,
            snapshot: response.mutation.snapshot,
            versions: response.mutation.checkpoint
              ? [response.mutation.checkpoint, ...currentServer.versions]
              : currentServer.versions,
          };
          await removePendingOperation(operation.journalId);
          pendingRef.current.shift();
          serverRef.current = nextServer;
          publish(nextServer, pendingRef.current);
          if (mountedRef.current) {
            setMessage(null);
            setSaveState(pendingRef.current.length ? "saving" : "saved");
          }
        } catch (reason) {
          if (reason instanceof ApiError && reason.code === "document-revision-conflict") {
            if (mountedRef.current) {
              setSaveState("conflict");
              setMessage("This document changed elsewhere. Your pending edits are preserved for review.");
            }
            return;
          }
          if (reason instanceof ApiError && ["document-lease-required", "document-lease-expired", "document-lease-grace"].includes(reason.code)) {
            leaseRef.current = "";
            if (mountedRef.current) {
              setLeaseHeld(false);
              setSaveState("read-only");
              setMessage("Editing access ended. Your pending edits remain safely stored on this device.");
            }
            return;
          }
          operation.attempts += 1;
          operation.nextAttemptAt = Date.now() + retryDelay(operation.attempts);
          await updatePendingOperation(operation);
          if (mountedRef.current) {
            setSaveState(navigator.onLine ? "failed" : "offline");
            setMessage(reason instanceof Error ? reason.message : "Changes could not be saved");
          }
          scheduleDrain(retryDelay(operation.attempts), drainQueue);
          return;
        }
      }
    });
  }, [documentId, publish, scheduleDrain, workspaceId]);

  const flushPending = useCallback(async () => {
    await journalWritesRef.current;
    await drain();
  }, [drain]);

  const releaseLeaseAfterDrain = useCallback(async () => {
    await flushPending();
    if (pendingRef.current.length > 0 || !leaseRef.current) return false;
    return releaseFlightRef.current.run(async () => {
      const token = leaseRef.current;
      if (!token || pendingRef.current.length > 0) return false;
      await api.releaseDocumentLease(workspaceId, documentId, token);
      if (leaseRef.current === token) {
        leaseRef.current = "";
        if (leaseStorageKeyRef.current) sessionStorage.removeItem(leaseStorageKeyRef.current);
      }
      return true;
    });
  }, [documentId, flushPending, workspaceId]);

  const acquire = useCallback(async () => {
    try {
      const response = await api.acquireDocumentLease(workspaceId, documentId, acquireKeyRef.current);
      leaseRef.current = response.grant.lease_token;
      if (leaseStorageKeyRef.current) sessionStorage.setItem(leaseStorageKeyRef.current, response.grant.lease_token);
      setLeaseHeld(true);
      setSaveState(pendingRef.current.length ? "saving" : "saved");
      setMessage(null);
      void drain();
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === "document-lease-held") {
        setSaveState("read-only");
        setMessage(reason.message);
      } else {
        setSaveState("failed");
        setMessage(reason instanceof Error ? reason.message : "Editing access could not be acquired");
      }
    }
  }, [documentId, drain, workspaceId]);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    let unsubscribeRelease: () => void = () => undefined;
    void (async () => {
      try {
        const [session, response] = await Promise.all([api.authSession(), api.document(workspaceId, documentId)]);
        if (cancelled) return;
        if (!session.authenticated) throw new Error("Your sign-in session ended. Sign in again to recover this document.");
        actorIdRef.current = session.actor.actor_id;
        leaseStorageKeyRef.current = leaseStorageKey(session.actor.actor_id, workspaceId, documentId);
        serverRef.current = response.editor;
        await cleanupEditorJournals(Date.now() - 30 * 24 * 60 * 60 * 1000);
        pendingRef.current = await listPendingOperations({
          actorId: session.actor.actor_id,
          workspaceId,
          documentId,
        });
        publish(response.editor, pendingRef.current);
        const tab = new EditorTabCoordinator(
          { actorId: session.actor.actor_id, workspaceId, documentId },
          () => {
            leaseRef.current = "";
            setLeaseHeld(false);
            setSaveState("read-only");
            setMessage("This document is active in another tab. Pending edits remain on this device.");
          },
        );
        tabRef.current = tab;
        unsubscribeRelease = tab.onPeerReleased(() => {
          if (!leaseRef.current) {
            acquireKeyRef.current = `editor-lease-${crypto.randomUUID()}`;
            void acquire();
          }
        });
        if (!await tab.claim()) {
          setSaveState("read-only");
          setMessage("This document is already open for editing in another tab.");
          return;
        }
        const resumableToken = sessionStorage.getItem(leaseStorageKeyRef.current);
        if (resumableToken) {
          try {
            await api.heartbeatDocumentLease(workspaceId, documentId, resumableToken);
            leaseRef.current = resumableToken;
            setLeaseHeld(true);
            setSaveState(pendingRef.current.length ? "saving" : "saved");
            setMessage(null);
            void drain();
            return;
          } catch {
            sessionStorage.removeItem(leaseStorageKeyRef.current);
          }
        }
        await acquire();
      } catch (reason) {
        if (!cancelled) {
          setSaveState("failed");
          setMessage(reason instanceof Error ? reason.message : "The document could not be opened");
        }
      }
    })();
    return () => {
      cancelled = true;
      mountedRef.current = false;
      unsubscribeRelease();
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
      void (async () => {
        await flushPending();
        if (unloadingRef.current) {
          tabRef.current?.dispose();
          tabRef.current = null;
          return;
        }
        await releaseLeaseAfterDrain().catch(() => false);
        tabRef.current?.dispose();
        tabRef.current = null;
      })();
    };
  }, [acquire, documentId, flushPending, publish, releaseLeaseAfterDrain, workspaceId]);

  useEffect(() => {
    if (!leaseHeld) return;
    const heartbeat = window.setInterval(() => {
      const token = leaseRef.current;
      if (!token || !navigator.onLine) return;
      void Promise.all([
        api.heartbeatDocumentLease(workspaceId, documentId, token),
        api.documentLeaseStatus(workspaceId, documentId, token),
      ]).then(([, status]) => setTakeoverRequest(status.status.takeoverRequest)).catch((reason: unknown) => {
        if (reason instanceof ApiError && ["document-lease-required", "document-lease-expired"].includes(reason.code)) {
          leaseRef.current = "";
          if (leaseStorageKeyRef.current) sessionStorage.removeItem(leaseStorageKeyRef.current);
          setLeaseHeld(false);
          setSaveState("read-only");
          setMessage("Editing access expired. Pending edits are preserved and can be recovered.");
        }
      });
    }, 10_000);
    return () => window.clearInterval(heartbeat);
  }, [documentId, leaseHeld, workspaceId]);

  useEffect(() => {
    saveStateRef.current = saveState;
  }, [saveState]);

  useEffect(() => {
    const online = () => { if (pendingRef.current.length) void drain(); else if (leaseRef.current) setSaveState("saved"); };
    const offline = () => { if (pendingRef.current.length) setSaveState("offline"); };
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => { window.removeEventListener("online", online); window.removeEventListener("offline", offline); };
  }, [drain]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      unloadingRef.current = true;
      window.setTimeout(() => { unloadingRef.current = false; }, 0);
      if (pendingRef.current.length === 0) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);

  const commit = useCallback((mutation: EditorMutation) => {
    if (!leaseRef.current || saveStateRef.current === "read-only" || saveStateRef.current === "conflict") return;
    const queuedState: SaveState = navigator.onLine ? "saving" : "offline";
    saveStateRef.current = queuedState;
    if (mountedRef.current) {
      setSaveState(queuedState);
      setMessage(navigator.onLine ? null : "Your edits are stored on this device and will sync when you reconnect.");
    }
    const write = journalWritesRef.current.then(async () => {
      const current = editorRef.current;
      const server = serverRef.current;
      if (!current || !server || !actorIdRef.current || !leaseRef.current) return;
      const operation: NewPendingEditorOperation = {
        actorId: actorIdRef.current,
        workspaceId,
        documentId,
        journalId: `journal-${crypto.randomUUID()}`,
        operationId: `document-operation-${crypto.randomUUID()}`,
        baseDocumentVersionId: server.document.current_version_id,
        baseRevision: current.snapshot.revision,
        idempotencyKey: `editor-mutation-${crypto.randomUUID()}`,
        traceId: createTraceId(),
        mutation: structuredClone(mutation),
        createdAt: new Date().toISOString(),
        attempts: 0,
        nextAttemptAt: 0,
      };
      const persisted = await appendPendingOperation(operation);
      pendingRef.current.push(persisted);
      publish(serverRef.current, pendingRef.current);
      if (mountedRef.current) {
        setSaveState(queuedState);
        setMessage(navigator.onLine ? null : "Your edits are stored on this device and will sync when you reconnect.");
      }
      void drain();
    });
    journalWritesRef.current = write.then(() => undefined, () => undefined);
    void write.catch((reason: unknown) => {
      if (mountedRef.current) {
        setSaveState("failed");
        setMessage(reason instanceof Error ? reason.message : "This edit could not enter durable recovery");
      }
    });
  }, [documentId, drain, publish, workspaceId]);

  const replaceServer = useCallback((next: DocumentReadModel) => {
    serverRef.current = next;
    publish(next, pendingRef.current);
  }, [publish]);

  const adoptLease = useCallback((token: string) => {
    leaseRef.current = token;
    if (leaseStorageKeyRef.current) sessionStorage.setItem(leaseStorageKeyRef.current, token);
    setLeaseHeld(true);
    setSaveState(pendingRef.current.length ? "saving" : "saved");
    setMessage(null);
    void drain();
  }, [drain]);

  const retryPending = useCallback(() => {
    for (const operation of pendingRef.current) operation.nextAttemptAt = 0;
    setSaveState("saving");
    void Promise.all(pendingRef.current.map(updatePendingOperation)).then(() => drain());
  }, [drain]);

  const reloadCurrent = useCallback(async () => {
    const current = await api.document(workspaceId, documentId);
    serverRef.current = current.editor;
    editorRef.current = current.editor;
    setEditor(current.editor);
    setSaveState("conflict");
    setMessage(`${pendingRef.current.length} pending ${pendingRef.current.length === 1 ? "edit is" : "edits are"} preserved for review.`);
  }, [documentId, workspaceId]);

  const denyTakeover = useCallback(async (reason: string) => {
    if (!leaseRef.current) return;
    await api.denyTakeoverDocumentLease(workspaceId, documentId, leaseRef.current, reason);
    setTakeoverRequest(null);
  }, [documentId, workspaceId]);

  const releaseForTakeover = useCallback(async () => {
    if (!await releaseLeaseAfterDrain()) return false;
    setLeaseHeld(false);
    setTakeoverRequest(null);
    setSaveState("read-only");
    setMessage("Your saved work is secure. Editing access was released to the requester.");
    tabRef.current?.release();
    return true;
  }, [releaseLeaseAfterDrain]);

  const reapplyPending = useCallback(async () => {
    const current = await api.document(workspaceId, documentId);
    let revision = current.editor.snapshot.revision;
    for (const operation of pendingRef.current) {
      operation.baseDocumentVersionId = current.editor.document.current_version_id;
      operation.baseRevision = revision;
      operation.attempts = 0;
      operation.nextAttemptAt = 0;
      revision += 1;
      await updatePendingOperation(operation);
    }
    serverRef.current = current.editor;
    publish(current.editor, pendingRef.current);
    setSaveState("saving");
    setMessage(null);
    void drain();
  }, [documentId, drain, publish, workspaceId]);

  return {
    editor,
    editorRef,
    leaseRef,
    saveState,
    message,
    setMessage,
    pendingCount,
    getPendingCount: () => pendingRef.current.length,
    readOnly: !leaseHeld || saveState === "read-only" || saveState === "conflict",
    commit,
    replaceServer,
    adoptLease,
    flushPending,
    retryPending,
    reloadCurrent,
    reapplyPending,
    recoveredSnapshot: editor?.snapshot ?? null,
    takeoverRequest,
    denyTakeover,
    releaseForTakeover,
    retryAcquire: acquire,
  };
}

function leaseStorageKey(actorId: string, workspaceId: string, documentId: string): string {
  return `ipw-editor-lease:${actorId}:${workspaceId}:${documentId}`;
}
