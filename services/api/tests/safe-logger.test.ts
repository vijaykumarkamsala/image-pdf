import assert from "node:assert/strict";
import test from "node:test";

import { redactProtected } from "../src/common/logger.js";

test("protected headers, upload URLs, signed queries, and storage paths are redacted", () => {
  const protectedValue = redactProtected({
    authorization: "Bearer header-secret",
    uploadUrl: "https://storage.googleapis.com/upload/storage/v1/b/bucket/o?upload_id=session-secret",
    message:
      "request Bearer inline-secret failed at https://example.test/object?X-Goog-Signature=signed-secret",
    object: "quarantine/tenant/private-object.png",
    safe: "job-123",
  });

  assert.deepEqual(protectedValue, {
    authorization: "[redacted]",
    uploadUrl: "[redacted]",
    message:
      "request Bearer [redacted] failed at https://example.test/object?X-Goog-Signature=[redacted]",
    object: "[protected-storage-path]",
    safe: "job-123",
  });
});

test("errors and nested causes cannot reintroduce protected values through stacks", () => {
  const cause = new Error("gs://private-bucket/quarantine/tenant/object");
  cause.stack = "Error: Bearer cause-secret at quarantine/tenant/object";
  const error = new Error("upload failed?token=query-secret", { cause });
  error.stack = "Error at https://storage.test/session?upload_id=resume-secret";

  const protectedValue = redactProtected(error) as {
    message: string;
    stack: string;
    cause: { message: string; stack: string };
  };

  assert.equal(protectedValue.message, "upload failed?token=[redacted]");
  assert.equal(protectedValue.stack, "Error at https://storage.test/session?upload_id=[redacted]");
  assert.equal(protectedValue.cause.message, "[protected-storage-path]");
  assert.equal(protectedValue.cause.stack, "Error: Bearer [redacted] at [protected-storage-path]");
});

test("cycles are bounded instead of recursed into logger failures", () => {
  const value: { child?: unknown } = {};
  value.child = value;

  assert.deepEqual(redactProtected(value), { child: "[circular]" });
});
