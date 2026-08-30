import assert from "node:assert/strict";
import test from "node:test";

import {
  mediaTypeFor,
  nextGcsOffset,
  parseActiveUpload,
  parseActiveUploads,
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
  assert.equal(phaseFromRecords({ ...job, state: "succeeded" }, { ...upload, state: "rejected" }), "rejected");
  assert.equal(phaseFromRecords({ ...job, state: "succeeded" }, { ...upload, state: "cancelled" }), "cancelled");
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
    byteSize: 1024,
    traceId: "trace-001",
    stage: "processing" as const,
  };
  assert.deepEqual(parseActiveUpload(JSON.stringify(reference)), reference);
  assert.deepEqual(parseActiveUploads(JSON.stringify([reference, { nope: true }])), [reference]);
  assert.equal(parseActiveUpload('{"uploadSessionId":"upload-001"}'), null);
  assert.equal(parseActiveUpload("not json"), null);
});

test("GCS resumable responses advance from 308 Range without expecting JSON", () => {
  assert.equal(nextGcsOffset(308, null, 100), 0);
  assert.equal(nextGcsOffset(308, "bytes=0-63", 100), 64);
  assert.equal(nextGcsOffset(200, null, 100), 100);
  assert.throws(() => nextGcsOffset(308, "bytes=4-63", 100), /invalid resume position/);
  assert.throws(() => nextGcsOffset(503, null, 100), /interrupted/);
});
