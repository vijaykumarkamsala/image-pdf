import assert from "node:assert/strict";
import test from "node:test";

import { Test } from "@nestjs/testing";

import { AppModule } from "../src/app.module.js";
import { ProductErrorFilter } from "../src/common/product-error.filter.js";
import { LocalInspectionExecutor } from "../src/domains/jobs/local-inspection-executor.js";

function png(width = 8, height = 6): Uint8Array {
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

async function api() {
  process.env["NODE_ENV"] = "test";
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix("v1");
  app.useGlobalFilters(new ProductErrorFilter());
  await app.listen(0, "127.0.0.1");
  const server = app.getHttpServer() as { address(): { port: number } };
  return {
    close: () => app.close(),
    executor: app.get(LocalInspectionExecutor),
    request(path: string, options: RequestInit = {}, actor = "actor-quality") {
      return fetch(`http://127.0.0.1:${server.address().port}/v1${path}`, {
        ...options,
        headers: {
          "content-type": "application/json",
          "x-ipw-test-actor-id": actor,
          "x-ipw-test-actor-name": actor,
          "x-trace-id": "trace-image-quality-test",
          ...options.headers,
        },
      });
    },
  };
}

async function json(response: Response): Promise<any> {
  return response.json();
}

async function readyGuestUpload(server: Awaited<ReturnType<typeof api>>, token: string) {
  const bytes = png();
  const created = await json(await server.request("/guest/upload-sessions", {
    method: "POST",
    headers: { "idempotency-key": "quality-upload", "x-ipw-guest-token": token },
    body: JSON.stringify({ display_name: "quality-source.png", media_type: "image/png", byte_size: bytes.byteLength }),
  }));
  const uploadUrl = new URL(created.authorization.upload_url, "http://local");
  const transferred = await server.request(`${uploadUrl.pathname.replace("/v1", "")}${uploadUrl.search}`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream", "upload-offset": "0" },
    body: bytes,
  });
  assert.equal(transferred.status, 200);
  await server.request(`/upload-sessions/${created.upload_session.upload_session_id}/finalise`, {
    method: "POST",
    headers: { "idempotency-key": "quality-finalise", "x-ipw-guest-token": token },
  });
  await server.executor.runAvailable();
  return created.upload_session.upload_session_id as string;
}

test("verified guest image creates one durable, idempotent Restore job", async () => {
  const server = await api();
  try {
    const guest = await json(await server.request("/guest-sessions", { method: "POST" }));
    const uploadId = await readyGuestUpload(server, guest.token);
    const options = {
      method: "POST",
      headers: {
        "idempotency-key": "quality-create",
        "x-ipw-guest-token": guest.token,
      },
      body: JSON.stringify({ content_class: "photo", strength: 72 }),
    };
    const first = await json(await server.request(`/upload-sessions/${uploadId}/image-quality-requests`, options));
    const replay = await json(await server.request(`/upload-sessions/${uploadId}/image-quality-requests`, options));
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.image_quality_request.image_quality_request_id, first.image_quality_request.image_quality_request_id);
    assert.equal(first.image_quality_request.state, "queued");
    assert.equal(first.image_quality_request.source_sha256.length, 64);
    assert.equal(first.image_quality_request.content_class, "photo");
    assert.equal(first.image_quality_request.strength, 72);

    const status = await json(await server.request(
      `/image-quality-requests/${first.image_quality_request.image_quality_request_id}`,
      { headers: { "x-ipw-guest-token": guest.token } },
    ));
    assert.equal(status.image_quality_request.job_id, first.image_quality_request.job_id);
  } finally {
    await server.close();
  }
});

test("image-quality requests validate intent and remain tenant isolated", async () => {
  const server = await api();
  try {
    const guest = await json(await server.request("/guest-sessions", { method: "POST" }));
    const other = await json(await server.request("/guest-sessions", { method: "POST" }));
    const uploadId = await readyGuestUpload(server, guest.token);
    const invalid = await server.request(`/upload-sessions/${uploadId}/image-quality-requests`, {
      method: "POST",
      headers: { "idempotency-key": "quality-invalid", "x-ipw-guest-token": guest.token },
      body: JSON.stringify({ content_class: "flat-graphic", strength: 101 }),
    });
    assert.equal(invalid.status, 400);

    const created = await json(await server.request(`/upload-sessions/${uploadId}/image-quality-requests`, {
      method: "POST",
      headers: { "idempotency-key": "quality-valid", "x-ipw-guest-token": guest.token },
      body: JSON.stringify({ content_class: "illustration", strength: 45 }),
    }));
    const protectedGraphic = await json(await server.request(
      `/upload-sessions/${uploadId}/image-quality-requests`,
      {
        method: "POST",
        headers: {
          "idempotency-key": "quality-flat-graphic",
          "x-ipw-guest-token": guest.token,
        },
        body: JSON.stringify({ content_class: "flat-graphic", strength: 65 }),
      },
    ));
    assert.equal(protectedGraphic.image_quality_request.content_class, "flat-graphic");
    const denied = await server.request(
      `/image-quality-requests/${created.image_quality_request.image_quality_request_id}`,
      { headers: { "x-ipw-guest-token": other.token } },
    );
    assert.equal(denied.status, 404);
  } finally {
    await server.close();
  }
});

test("signed-in workspace owners can read their own queued restoration", async () => {
  const server = await api();
  try {
    const bootstrap = await json(await server.request("/session/bootstrap", {
      method: "POST",
      headers: { "idempotency-key": "quality-bootstrap" },
    }));
    const workspaceId = bootstrap.workspace.workspace_id as string;
    const bytes = png(5, 7);
    const upload = await json(await server.request(`/workspaces/${workspaceId}/upload-sessions`, {
      method: "POST",
      headers: { "idempotency-key": "quality-actor-upload" },
      body: JSON.stringify({ display_name: "actor-source.png", media_type: "image/png", byte_size: bytes.byteLength }),
    }));
    const uploadUrl = new URL(upload.authorization.upload_url, "http://local");
    await server.request(`${uploadUrl.pathname.replace("/v1", "")}${uploadUrl.search}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream", "upload-offset": "0" },
      body: bytes,
    });
    await server.request(`/upload-sessions/${upload.upload_session.upload_session_id}/finalise`, {
      method: "POST",
      headers: { "idempotency-key": "quality-actor-finalise" },
    });
    await server.executor.runAvailable();
    const created = await json(await server.request(
      `/upload-sessions/${upload.upload_session.upload_session_id}/image-quality-requests`,
      {
        method: "POST",
        headers: { "idempotency-key": "quality-actor-create" },
        body: JSON.stringify({ content_class: "photo", strength: 60 }),
      },
    ));
    const requestId = created.image_quality_request.image_quality_request_id;
    const owned = await server.request(`/workspaces/${workspaceId}/image-quality-requests/${requestId}`);
    const isolated = await server.request(
      `/workspaces/${workspaceId}/image-quality-requests/${requestId}`,
      {},
      "actor-other",
    );
    assert.equal(owned.status, 200);
    assert.equal(isolated.status, 404);
  } finally {
    await server.close();
  }
});
