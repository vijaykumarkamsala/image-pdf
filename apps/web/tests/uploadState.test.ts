import assert from "node:assert/strict";
import test from "node:test";

import {
  mediaTypeFor,
  parseActiveUpload,
  phaseFromRecords,
  presentationFor,
} from "../src/boundaries/uploadState.ts";
import type { ProcessingJobRecord, UploadSessionRecord } from "ipw-contracts-ts/product";

const upload = { state: "inspecting" } as UploadSessionRecord;
const job = { state: "running" } as ProcessingJobRecord;

test("durable records map to customer-safe upload phases", () => {
  assert.equal(phaseFromRecords(job, upload), "inspecting");
  assert.equal(phaseFromRecords({ ...job, state: "failed" }, { ...upload, state: "rejected" }), "rejected");
  assert.equal(phaseFromRecords({ ...job, state: "succeeded" }, { ...upload, state: "ready" }), "ready");
  assert.equal(presentationFor("uploading", 41.6).progress, 42);
  assert.doesNotMatch(presentationFor("queued").description, /recovery|benchmark|object key/i);
});

test("file type fallback is deterministic and limited to approved intake types", () => {
  assert.equal(mediaTypeFor(new File(["x"], "source.PDF")), "application/pdf");
  assert.equal(mediaTypeFor(new File(["x"], "source.unknown")), "");
  assert.equal(mediaTypeFor(new File(["x"], "source.bin", { type: "image/png" })), "image/png");
});

test("active upload recovery accepts identifiers but rejects malformed state", () => {
  const reference = {
    uploadSessionId: "upload-001",
    jobId: "job-001",
    displayName: "source.png",
    traceId: "trace-001",
  };
  assert.deepEqual(parseActiveUpload(JSON.stringify(reference)), reference);
  assert.equal(parseActiveUpload('{"uploadSessionId":"upload-001"}'), null);
  assert.equal(parseActiveUpload("not json"), null);
});
