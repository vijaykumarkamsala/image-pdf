import type { EditorMutation } from "ipw-contracts-ts/product";

const DATABASE_NAME = "ipw-editor-journal-v1";
const STORE_NAME = "pending-operations";
const MAX_ENTRY_BYTES = 512 * 1024;
const PRIVATE_KEY_PATTERN = /(authorization|credential|lease.?token|signed.?url|source.?bytes|file.?bytes|password|secret)/i;

export interface EditorJournalScope {
  actorId: string;
  workspaceId: string;
  documentId: string;
}

export interface PendingEditorOperation extends EditorJournalScope {
  journalId: string;
  operationId: string;
  baseDocumentVersionId: string;
  baseRevision: number;
  idempotencyKey: string;
  traceId: string;
  mutation: EditorMutation;
  createdAt: string;
  attempts: number;
  nextAttemptAt: number;
}

export function retryDelay(attempt: number): number {
  return Math.min(30_000, 500 * 2 ** Math.min(Math.max(0, attempt), 6));
}

export function assertSafeJournalEntry(entry: PendingEditorOperation): void {
  if (!entry.actorId || !entry.workspaceId || !entry.documentId || !entry.operationId || !entry.idempotencyKey || !entry.traceId) {
    throw new Error("Editor recovery entry is missing its ownership or replay identity");
  }
  if (!Number.isSafeInteger(entry.baseRevision) || entry.baseRevision < 0) {
    throw new Error("Editor recovery entry has an invalid base revision");
  }
  inspectKeys(entry.mutation);
  if (new TextEncoder().encode(JSON.stringify(entry)).byteLength > MAX_ENTRY_BYTES) {
    throw new Error("This edit is too large for safe local recovery");
  }
}

export async function appendPendingOperation(entry: PendingEditorOperation): Promise<void> {
  assertSafeJournalEntry(entry);
  await transact("readwrite", (store) => store.add(entry));
}

export async function updatePendingOperation(entry: PendingEditorOperation): Promise<void> {
  assertSafeJournalEntry(entry);
  await transact("readwrite", (store) => store.put(entry));
}

export async function removePendingOperation(journalId: string): Promise<void> {
  await transact("readwrite", (store) => store.delete(journalId));
}

export async function listPendingOperations(scope: EditorJournalScope): Promise<PendingEditorOperation[]> {
  const all = await transact<PendingEditorOperation[]>("readonly", (store) => store.getAll());
  return all
    .filter((entry) => entry.actorId === scope.actorId
      && entry.workspaceId === scope.workspaceId
      && entry.documentId === scope.documentId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.journalId.localeCompare(right.journalId));
}

export async function clearEditorJournals(): Promise<void> {
  if (!("indexedDB" in globalThis)) return;
  await transact("readwrite", (store) => store.clear());
}

export async function cleanupEditorJournals(olderThan: number): Promise<void> {
  if (!("indexedDB" in globalThis)) return;
  const all = await transact<PendingEditorOperation[]>("readonly", (store) => store.getAll());
  const expired = all.filter((entry) => Date.parse(entry.createdAt) < olderThan);
  if (expired.length === 0) return;
  await transact("readwrite", (store) => {
    for (const entry of expired) store.delete(entry.journalId);
  });
}

function inspectKeys(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) inspectKeys(item);
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (PRIVATE_KEY_PATTERN.test(key)) throw new Error(`Private editor field ${key} cannot enter local recovery`);
    inspectKeys(item);
  }
}

function openDatabase(): Promise<IDBDatabase> {
  if (!("indexedDB" in globalThis)) return Promise.reject(new Error("Durable browser recovery is unavailable"));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: "journalId" });
        store.createIndex("scope", ["actorId", "workspaceId", "documentId"], { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Editor recovery storage could not open"));
  });
}

async function transact<T = void>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T> {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));
    let result: T;
    if (request) {
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(request.error ?? new Error("Editor recovery operation failed"));
    }
    transaction.oncomplete = () => { database.close(); resolve(result!); };
    transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error("Editor recovery transaction failed")); };
    transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error("Editor recovery transaction was cancelled")); };
  });
}
