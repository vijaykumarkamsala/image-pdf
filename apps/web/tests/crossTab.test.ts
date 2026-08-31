import assert from "node:assert/strict";
import test from "node:test";

import { parseCoordinationEvent } from "../src/boundaries/crossTab.ts";

test("cross-tab events contain only safe opaque references", () => {
  const event = {
    eventId: "event-001",
    type: "upload.changed" as const,
    occurredAt: "2026-08-31T00:00:00.000Z",
    ownerScope: "guest-001",
    uploadSessionId: "upload-001",
  };
  assert.deepEqual(parseCoordinationEvent(event), event);
  assert.equal(parseCoordinationEvent({ ...event, uploadSessionId: "https://storage.invalid/resumable?token=secret" }), null);
  assert.equal(parseCoordinationEvent({ ...event, type: "credential.shared" }), null);
  assert.doesNotMatch(JSON.stringify(event), /token|authorization|resumable|uri/i);
});
