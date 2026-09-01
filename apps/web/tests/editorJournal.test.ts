import assert from "node:assert/strict";
import test from "node:test";

import { assertSafeJournalEntry, retryDelay, type PendingEditorOperation } from "../src/editor/editorJournal.ts";

function entry(): PendingEditorOperation {
  return {
    actorId: "actor-editor",
    workspaceId: "workspace-editor",
    documentId: "document-editor",
    journalId: "journal-editor",
    operationId: "document-operation-editor",
    baseDocumentVersionId: "document-version-editor",
    baseRevision: 4,
    idempotencyKey: "editor-idempotency",
    traceId: "trace-editor",
    mutation: { kind: "document.rename", target_id: null, properties: {} },
    createdAt: "2026-09-01T00:00:00.000Z",
    attempts: 0,
    nextAttemptAt: 0,
  };
}

test("editor recovery entries carry ordered replay identity without private transfer data", () => {
  assert.doesNotThrow(() => assertSafeJournalEntry(entry()));
  assert.throws(
    () => assertSafeJournalEntry({
      ...entry(),
      mutation: { kind: "document.rename", target_id: null, properties: {}, signed_url: "https://private.invalid" } as never,
    }),
    /cannot enter local recovery/,
  );
  assert.throws(
    () => assertSafeJournalEntry({ ...entry(), baseRevision: -1 }),
    /invalid base revision/,
  );
});

test("editor save retry uses bounded exponential backoff", () => {
  assert.equal(retryDelay(0), 500);
  assert.equal(retryDelay(3), 4_000);
  assert.equal(retryDelay(20), 30_000);
});
