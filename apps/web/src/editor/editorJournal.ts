import type { EditorMutation } from "ipw-contracts-ts/product";

const DATABASE_NAME = "ipw-editor-journal-v1";
const STORE_NAME = "pending-operations";
const SEQUENCE_STORE_NAME = "scope-sequences";
const DATABASE_VERSION = 2;
const MAX_ENTRY_BYTES = 512 * 1024;
const PRIVATE_KEY_PATTERN = /(authorization|credential|lease.?token|signed.?url|source.?bytes|file.?bytes|password|secret)/i;

export interface EditorJournalScope {
  actorId: string;
  workspaceId: string;
  documentId: string;
}

export interface PendingEditorOperation extends EditorJournalScope {
  sequence: number;
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

export type NewPendingEditorOperation = Omit<PendingEditorOperation, "sequence">;

interface ScopeSequence {
  scopeKey: string;
  lastSequence: number;
}

type LegacyPendingEditorOperation = Omit<PendingEditorOperation, "sequence"> & { sequence?: number };

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
  if (!Number.isSafeInteger(entry.sequence) || entry.sequence < 1) {
    throw new Error("Editor recovery entry has an invalid durable sequence");
  }
  inspectKeys(entry.mutation);
  if (new TextEncoder().encode(JSON.stringify(entry)).byteLength > MAX_ENTRY_BYTES) {
    throw new Error("This edit is too large for safe local recovery");
  }
}

export async function appendPendingOperation(input: NewPendingEditorOperation): Promise<PendingEditorOperation> {
  return withTransaction([STORE_NAME, SEQUENCE_STORE_NAME], "readwrite", async (transaction) => {
    const store = transaction.objectStore(STORE_NAME);
    const sequences = transaction.objectStore(SEQUENCE_STORE_NAME);
    await migrateLegacyScope(store, sequences, input);
    const key = scopeKey(input);
    const current = await idbRequest<ScopeSequence | undefined>(sequences.get(key));
    const entry: PendingEditorOperation = { ...input, sequence: (current?.lastSequence ?? 0) + 1 };
    assertSafeJournalEntry(entry);
    await idbRequest(store.add(entry));
    await idbRequest(sequences.put({ scopeKey: key, lastSequence: entry.sequence } satisfies ScopeSequence));
    return entry;
  });
}

export async function updatePendingOperation(entry: PendingEditorOperation): Promise<void> {
  assertSafeJournalEntry(entry);
  await withTransaction([STORE_NAME], "readwrite", async (transaction) => {
    await idbRequest(transaction.objectStore(STORE_NAME).put(entry));
  });
}

export async function removePendingOperation(journalId: string): Promise<void> {
  await withTransaction([STORE_NAME], "readwrite", async (transaction) => {
    await idbRequest(transaction.objectStore(STORE_NAME).delete(journalId));
  });
}

export async function listPendingOperations(scope: EditorJournalScope): Promise<PendingEditorOperation[]> {
  return withTransaction([STORE_NAME, SEQUENCE_STORE_NAME], "readwrite", async (transaction) => {
    const store = transaction.objectStore(STORE_NAME);
    const sequences = transaction.objectStore(SEQUENCE_STORE_NAME);
    const entries = await migrateLegacyScope(store, sequences, scope);
    const ordered = entries.sort((left, right) => left.sequence - right.sequence);
    assertReplayContinuity(ordered);
    return ordered;
  });
}

export function assertReplayContinuity(entries: PendingEditorOperation[]): void {
  for (let index = 0; index < entries.length; index += 1) {
    const current = entries[index]!;
    assertSafeJournalEntry(current);
    if (index === 0) continue;
    const previous = entries[index - 1]!;
    if (current.sequence !== previous.sequence + 1 || current.baseRevision !== previous.baseRevision + 1) {
      throw new Error("Pending edits have divergent durable sequence or base revision continuity");
    }
  }
}

export async function clearEditorJournals(): Promise<void> {
  if (!("indexedDB" in globalThis)) return;
  await withTransaction([STORE_NAME, SEQUENCE_STORE_NAME], "readwrite", async (transaction) => {
    await Promise.all([
      idbRequest(transaction.objectStore(STORE_NAME).clear()),
      idbRequest(transaction.objectStore(SEQUENCE_STORE_NAME).clear()),
    ]);
  });
}

export async function cleanupEditorJournals(olderThan: number): Promise<void> {
  if (!("indexedDB" in globalThis)) return;
  const all = await withTransaction([STORE_NAME], "readonly", (transaction) =>
    idbRequest<PendingEditorOperation[]>(transaction.objectStore(STORE_NAME).getAll()));
  const expired = all.filter((entry) => Date.parse(entry.createdAt) < olderThan);
  if (expired.length === 0) return;
  await withTransaction([STORE_NAME], "readwrite", async (transaction) => {
    const store = transaction.objectStore(STORE_NAME);
    await Promise.all(expired.map((entry) => idbRequest(store.delete(entry.journalId))));
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
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: "journalId" });
        store.createIndex("scope", ["actorId", "workspaceId", "documentId"], { unique: false });
      }
      if (!database.objectStoreNames.contains(SEQUENCE_STORE_NAME)) {
        database.createObjectStore(SEQUENCE_STORE_NAME, { keyPath: "scopeKey" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Editor recovery storage could not open"));
  });
}

async function withTransaction<T>(
  stores: string[],
  mode: IDBTransactionMode,
  operation: (transaction: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const database = await openDatabase();
  const transaction = database.transaction(stores, mode);
  try {
    const result = await operation(transaction);
    await transactionComplete(transaction);
    return result;
  } catch (error) {
    try { transaction.abort(); } catch { /* Transaction already completed or aborted. */ }
    throw error;
  } finally {
    database.close();
  }
}

async function migrateLegacyScope(
  store: IDBObjectStore,
  sequences: IDBObjectStore,
  scope: EditorJournalScope,
): Promise<PendingEditorOperation[]> {
  const key = scopeKey(scope);
  const entries = await idbRequest<LegacyPendingEditorOperation[]>(
    store.index("scope").getAll([scope.actorId, scope.workspaceId, scope.documentId]),
  );
  const missing = entries.filter((entry) => !Number.isSafeInteger(entry.sequence) || (entry.sequence ?? 0) < 1);
  let upgraded: PendingEditorOperation[];
  if (missing.length > 0) {
    if (missing.length !== entries.length) {
      throw new Error("Older and current pending edits cannot be merged without risking reordering");
    }
    entries.sort((left, right) => left.baseRevision - right.baseRevision);
    for (let index = 1; index < entries.length; index += 1) {
      if (entries[index]!.baseRevision !== entries[index - 1]!.baseRevision + 1) {
        throw new Error("Older pending edits have ambiguous base revisions and were left unchanged");
      }
    }
    const current = await idbRequest<ScopeSequence | undefined>(sequences.get(key));
    let sequence = current?.lastSequence ?? 0;
    upgraded = [];
    for (const legacy of entries) {
      sequence += 1;
      const entry = { ...legacy, sequence } as PendingEditorOperation;
      assertSafeJournalEntry(entry);
      await idbRequest(store.put(entry));
      upgraded.push(entry);
    }
    await idbRequest(sequences.put({ scopeKey: key, lastSequence: sequence } satisfies ScopeSequence));
  } else upgraded = entries.map((entry) => entry as PendingEditorOperation);
  const highest = upgraded.reduce((value, entry) => Math.max(value, entry.sequence), 0);
  const sequenceRecord = await idbRequest<ScopeSequence | undefined>(sequences.get(key));
  if (highest > (sequenceRecord?.lastSequence ?? 0)) {
    await idbRequest(sequences.put({ scopeKey: key, lastSequence: highest } satisfies ScopeSequence));
  }
  return upgraded;
}

function scopeKey(scope: EditorJournalScope): string {
  return JSON.stringify([scope.actorId, scope.workspaceId, scope.documentId]);
}

function idbRequest<T = undefined>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Editor recovery operation failed"));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Editor recovery transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Editor recovery transaction was cancelled"));
  });
}
