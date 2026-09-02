import assert from "node:assert/strict";
import test from "node:test";

import {
  assertReplayContinuity,
  assertSafeJournalEntry,
  retryDelay,
  type PendingEditorOperation,
} from "../src/editor/editorJournal.ts";
import { SingleFlight } from "../src/editor/singleFlight.ts";

function entry(): PendingEditorOperation {
  return {
    actorId: "actor-editor",
    workspaceId: "workspace-editor",
    documentId: "document-editor",
    sequence: 1,
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

test("editor recovery replay follows durable sequence and base revision continuity", () => {
  const first = entry();
  const second = { ...entry(), journalId: "journal-editor-2", sequence: 2, baseRevision: 5 };
  assert.doesNotThrow(() => assertReplayContinuity([first, second]));
  assert.throws(
    () => assertReplayContinuity([{ ...first, sequence: 3 }, second]),
    /divergent durable sequence/,
  );
  assert.throws(
    () => assertReplayContinuity([first, { ...second, baseRevision: 7 }]),
    /base revision continuity/,
  );
});

test("concurrent drain callers await one shared in-flight operation", async () => {
  const coordinator = new SingleFlight<void>();
  let release!: () => void;
  let calls = 0;
  const controlled = new Promise<void>((resolve) => { release = resolve; });
  const first = coordinator.run(async () => { calls += 1; await controlled; });
  const second = coordinator.run(async () => { calls += 1; });
  assert.equal(first, second);
  assert.equal(coordinator.inFlight, true);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(coordinator.inFlight, false);
});

test("editor save retry uses bounded exponential backoff", () => {
  assert.equal(retryDelay(0), 500);
  assert.equal(retryDelay(3), 4_000);
  assert.equal(retryDelay(20), 30_000);
});
