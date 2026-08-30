import assert from "node:assert/strict";
import test from "node:test";

import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";

import { IdentityBoundary } from "../src/domains/identity/identity.service.js";
import type { GuestHandoffRepository } from "../src/domains/intake/guest-handoff.repository.js";
import { IntakeService } from "../src/domains/intake/intake.service.js";
import { MemoryIntakeRepository } from "../src/domains/intake/memory-intake.repository.js";
import { MemoryPrivateObjectStore } from "../src/domains/intake/private-object-store.js";
import { MemoryProductKernelRepository } from "../src/kernel/memory.repository.js";
import type { RuntimeValues } from "../src/kernel/runtime.js";

test("independent cleanup expires, removes, audits, and does not repeat an actor upload", async () => {
  let sequence = 0;
  const runtime: RuntimeValues = {
    id(prefix) {
      sequence += 1;
      return `${prefix}-${String(sequence).padStart(6, "0")}`;
    },
    now: () => "2026-09-02T00:00:00.000Z",
  };
  const product = new MemoryProductKernelRepository(runtime);
  const bootstrap = await product.bootstrap({
    principal: { actorId: "actor-cleanup", displayName: "Cleanup owner" },
    idempotencyKey: "bootstrap-cleanup",
    traceId: "trace-bootstrap-cleanup",
    requestHash: "0".repeat(64),
  });
  const workspaceId = bootstrap.workspace.workspace_id;
  const intake = new MemoryIntakeRepository();
  const objects = new MemoryPrivateObjectStore();
  const uploadSessionId = "upload-cleanup-001";
  const object = await objects.createQuarantine(workspaceId, uploadSessionId);
  await intake.createUpload({
    record: {
      schema_version: PRODUCT_SCHEMA_VERSION,
      upload_session_id: uploadSessionId,
      owner_kind: "actor",
      workspace_id: workspaceId,
      actor_id: "actor-cleanup",
      guest_session_id: null,
      display_name: "expired.png",
      expected_media_type: "image/png",
      expected_byte_size: 4,
      expected_sha256: null,
      verified_sha256: null,
      bytes_received: 0,
      state: "initiated",
      constraints: {
        schema_version: PRODUCT_SCHEMA_VERSION,
        allowed_media_types: ["image/png"],
        max_bytes: 1024,
        max_pixels: 1024,
        max_pages: 1,
      },
      job_id: null,
      asset_original_id: null,
      source_version_id: null,
      file_id: null,
      source_facts: null,
      failure: null,
      created_at: "2026-08-30T00:00:00.000Z",
      expires_at: "2026-08-31T00:00:00.000Z",
      updated_at: "2026-08-30T00:00:00.000Z",
    },
    quarantineRef: object,
    uploadTokenHash: "1".repeat(64),
    uploadTokenExpiresAt: "2026-08-30T00:15:00.000Z",
    transferProvider: "local_api",
    protectedProviderSession: null,
    providerMetadata: null,
  }, {
    ownerScope: workspaceId,
    idempotencyKey: "upload-cleanup-create",
    commandName: "upload.create",
    requestHash: "2".repeat(64),
  });
  const handoffs: GuestHandoffRepository = {
    handoff: async () => { throw new Error("not used"); },
    close: async () => undefined,
  };
  const service = new IntakeService(
    intake,
    objects,
    product,
    runtime,
    handoffs,
    new IdentityBoundary(),
  );

  assert.deepEqual(await service.cleanupExpired(), { cleaned: 1, failed: 0 });
  assert.deepEqual(await service.cleanupExpired(), { cleaned: 0, failed: 0 });
  await assert.rejects(objects.read(object, 1024), /not found/);
  const audits = await product.listAuditEvents("actor-cleanup", workspaceId);
  assert.equal(audits.filter((event) => event.action === "source.cleanup").length, 1);
});
