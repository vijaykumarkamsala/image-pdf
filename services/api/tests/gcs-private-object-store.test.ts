import assert from "node:assert/strict";
import test from "node:test";
import type { Storage } from "@google-cloud/storage";

import { createPrivateObjectStore } from "../src/domains/intake/intake.module.js";
import { GcsSdkPrivateClient } from "../src/domains/intake/gcs-private-client.js";
import {
  GcsPrivateObjectStore,
  ResumableSessionProtector,
  UploadSizeMismatch,
  type GcsPrivateClient,
  type ProviderObjectMetadata,
} from "../src/domains/intake/private-object-store.js";

const uri = "https://storage.googleapis.com/upload/storage/v1/b/private/o?uploadType=resumable&upload_id=protected-secret";

class FakeGcsClient implements GcsPrivateClient {
  initiated: Record<string, unknown> | null = null;
  copied: string[] = [];
  removed: string[] = [];
  observed: ProviderObjectMetadata = {
    byteSize: 4,
    generation: "17",
    mediaType: "image/png",
    uploadSessionId: "upload-001",
    expectedSha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
    calculatedSha256: null,
  };

  async initiateResumableUpload(input: Record<string, unknown>): Promise<string> {
    this.initiated = input;
    return uri;
  }

  async metadata(): Promise<ProviderObjectMetadata> {
    return this.observed;
  }

  async read(): Promise<Uint8Array> {
    return new Uint8Array([1, 2, 3, 4]);
  }

  async copyIfAbsent(source: string, generation: string, target: string, sha256: string): Promise<string> {
    this.copied.push(source, generation, target, sha256);
    return "18";
  }

  async remove(objectKey: string, generation?: string): Promise<void> {
    this.removed.push(`${objectKey}@${generation ?? "latest"}`);
  }
}

const input = {
  uploadSessionId: "upload-001",
  resumeToken: "opaque-application-token",
  expiresAt: "2026-08-30T00:15:00.000Z",
  expectedByteSize: 4,
  expectedMediaType: "image/png",
  expectedSha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
};

test("GCS resumable authorization is provider-aware and persisted only as protected state", async () => {
  const client = new FakeGcsClient();
  const protector = new ResumableSessionProtector("a-production-secret-that-is-longer-than-32-characters");
  const store = new GcsPrivateObjectStore(client, protector);
  const ref = await store.createQuarantine("workspace-001", "upload-001");
  const authorization = await store.authorizeUpload(ref, input);

  assert.equal(authorization.provider, "google_cloud_storage");
  assert.equal(authorization.protocol, "gcs_resumable");
  assert.equal(authorization.uploadUrl, uri);
  assert.ok(authorization.protectedProviderSession);
  assert.ok(!authorization.protectedProviderSession.includes("upload_id"));
  assert.ok(!authorization.protectedProviderSession.includes("protected-secret"));
  assert.deepEqual(client.initiated, {
    objectKey: "quarantine/workspace-001/upload-001",
    ...input,
  });

  const resumed = await store.resumeUpload(ref, authorization.protectedProviderSession, input);
  assert.equal(resumed.uploadUrl, uri);
  assert.equal(resumed.protectedProviderSession, undefined);
});

test("GCS reconciliation binds size, upload metadata, checksum expectation and generation", async () => {
  const client = new FakeGcsClient();
  const store = new GcsPrivateObjectStore(
    client,
    new ResumableSessionProtector("another-production-secret-that-is-at-least-32-characters"),
  );
  const ref = await store.createQuarantine("workspace-001", "upload-001");
  const metadata = await store.reconcile(ref, input);
  assert.equal(metadata.generation, "17");

  client.observed = { ...client.observed, byteSize: 3 };
  await assert.rejects(store.reconcile(ref, input), UploadSizeMismatch);
  client.observed = { ...client.observed, byteSize: 4, expectedSha256: "0".repeat(64) };
  await assert.rejects(store.reconcile(ref, input), /checksum metadata mismatch/);
});

test("GCS immutable promotion requires and forwards the source generation", async () => {
  const client = new FakeGcsClient();
  const store = new GcsPrivateObjectStore(
    client,
    new ResumableSessionProtector("third-production-secret-that-is-at-least-32-characters"),
  );
  const source = { ownerScope: "workspace-001", objectKey: "quarantine/workspace-001/upload-001", zone: "quarantine" as const };
  await assert.rejects(store.promote(source, input.expectedSha256), /source generation/);
  const promoted = await store.promote({ ...source, generation: "17" }, input.expectedSha256);
  assert.equal(promoted.generation, "18");
  assert.deepEqual(client.copied, [source.objectKey, "17", promoted.objectKey, input.expectedSha256]);
});

test("production storage composition fails closed and never selects a local adapter", () => {
  assert.throws(() => createPrivateObjectStore({ NODE_ENV: "production" }), /IPW_GCS_BUCKET/);
  const configured = createPrivateObjectStore({
    NODE_ENV: "production",
    IPW_GCS_BUCKET: "private-intake.example",
    IPW_UPLOAD_SESSION_SECRET: "configured-production-secret-with-more-than-32-characters",
  });
  assert.ok(configured instanceof GcsPrivateObjectStore);
  assert.equal(configured.provider, "google_cloud_storage");
});

test("official GCS SDK adapter requests ADC-backed resumable and conditional operations", async () => {
  const calls: Array<{ operation: string; value: unknown }> = [];
  const metadata = {
    size: "4",
    generation: "17",
    contentType: "image/png",
    metadata: {
      "ipw-upload-session": "upload-001",
      "ipw-expected-sha256": input.expectedSha256,
      "ipw-sha256": input.expectedSha256,
    },
  };
  const files = new Map<string, any>();
  const fakeStorage = {
    bucket(bucket: string) {
      calls.push({ operation: "bucket", value: bucket });
      return {
        file(key: string, options?: unknown) {
          calls.push({ operation: "file", value: { key, options } });
          if (!files.has(key)) {
            files.set(key, {
              async createResumableUpload(options: unknown) {
                calls.push({ operation: "resumable", value: options });
                return [uri];
              },
              async getMetadata() { return [metadata]; },
              async download() { return [Buffer.from([1, 2, 3, 4])]; },
              async copy(target: unknown, options: unknown) {
                calls.push({ operation: "copy", value: { target, options } });
                return [target, {}];
              },
              async delete(options: unknown) { calls.push({ operation: "delete", value: options }); },
            });
          }
          return files.get(key);
        },
      };
    },
  } as unknown as Storage;
  const client = new GcsSdkPrivateClient({ bucket: "private-intake.example" }, fakeStorage);

  await client.initiateResumableUpload({ objectKey: "quarantine/workspace-001/upload-001", ...input });
  const resumable = calls.find((call) => call.operation === "resumable")?.value as any;
  assert.equal(resumable.preconditionOpts.ifGenerationMatch, 0);
  assert.equal(resumable.private, true);
  assert.equal(resumable.metadata.metadata["ipw-upload-session"], "upload-001");
  assert.equal(resumable.metadata.metadata["ipw-expected-bytes"], "4");

  await client.copyIfAbsent(
    "quarantine/workspace-001/upload-001",
    "17",
    `immutable/workspace-001/${input.expectedSha256}`,
    input.expectedSha256,
  );
  const copy = calls.find((call) => call.operation === "copy")?.value as any;
  assert.equal(copy.options.preconditionOpts.ifGenerationMatch, 0);
  assert.equal(copy.options.metadata["ipw-sha256"], input.expectedSha256);
  assert.ok(calls.some((call) => call.operation === "file"
    && (call.value as any).options?.generation === "17"));
});
