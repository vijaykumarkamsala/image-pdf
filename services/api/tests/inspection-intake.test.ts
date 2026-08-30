import assert from "node:assert/strict";
import test from "node:test";

import { Test } from "@nestjs/testing";

import { AppModule } from "../src/app.module.js";
import { ProductErrorFilter } from "../src/common/product-error.filter.js";
import { LocalInspectionExecutor } from "../src/domains/jobs/local-inspection-executor.js";

function png(width = 2, height = 3): Uint8Array {
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
    request(path: string, options: RequestInit = {}, actor = "actor-inspection") {
      return fetch(`http://127.0.0.1:${server.address().port}/v1${path}`, {
        ...options,
        headers: {
          "content-type": "application/json",
          "x-ipw-actor-id": actor,
          "x-ipw-actor-name": actor,
          "x-trace-id": "trace-inspection-test",
          ...options.headers,
        },
      });
    },
  };
}

async function json(response: Response): Promise<any> {
  return response.json();
}

test("accepted bytes become an immutable source and Default Files entry only after inspection", async () => {
  const server = await api();
  try {
    const bootstrap = await json(await server.request("/session/bootstrap", {
      method: "POST",
      headers: { "idempotency-key": "bootstrap-inspection" },
    }));
    const workspaceId = bootstrap.workspace.workspace_id as string;
    const bytes = png();
    const created = await json(await server.request(`/workspaces/${workspaceId}/upload-sessions`, {
      method: "POST",
      headers: { "idempotency-key": "upload-inspection" },
      body: JSON.stringify({ display_name: "verified.png", media_type: "image/png", byte_size: bytes.byteLength }),
    }));
    const uploadUrl = new URL(created.authorization.upload_url, "http://local");
    await server.request(`${uploadUrl.pathname.replace("/v1", "")}${uploadUrl.search}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream", "upload-offset": "0" },
      body: bytes,
    });
    const finalised = await json(await server.request(
      `/upload-sessions/${created.upload_session.upload_session_id}/finalise`,
      { method: "POST", headers: { "idempotency-key": "finalise-inspection" } },
    ));
    assert.equal((await json(await server.request(`/workspaces/${workspaceId}/files`))).files.length, 0);

    assert.equal(await server.executor.runAvailable(), true);

    const upload = await json(await server.request(`/upload-sessions/${created.upload_session.upload_session_id}`));
    const job = await json(await server.request(`/jobs/${finalised.job.job_id}`));
    const files = await json(await server.request(`/workspaces/${workspaceId}/files`));
    assert.equal(upload.upload_session.state, "ready");
    assert.equal(upload.upload_session.source_facts.detected_media_type, "image/png");
    assert.equal(upload.upload_session.source_facts.width, 2);
    assert.equal(job.job.state, "succeeded");
    assert.equal(files.files.length, 1);
    assert.equal(files.files[0].asset_original_id, upload.upload_session.asset_original_id);
    assert.equal(files.files[0].current_source_version_id, upload.upload_session.source_version_id);
    assert.equal(files.files[0].canonical_location.kind, "default_files");
  } finally {
    await server.close();
  }
});

test("malicious and spoofed inputs are rejected independently without creating files", async () => {
  const server = await api();
  try {
    const bootstrap = await json(await server.request("/session/bootstrap", {
      method: "POST",
      headers: { "idempotency-key": "bootstrap-rejections" },
    }));
    const workspaceId = bootstrap.workspace.workspace_id as string;

    async function submit(name: string, mediaType: string, bytes: Uint8Array, key: string) {
      const created = await json(await server.request(`/workspaces/${workspaceId}/upload-sessions`, {
        method: "POST",
        headers: { "idempotency-key": `upload-${key}` },
        body: JSON.stringify({ display_name: name, media_type: mediaType, byte_size: bytes.byteLength }),
      }));
      const url = new URL(created.authorization.upload_url, "http://local");
      await server.request(`${url.pathname.replace("/v1", "")}${url.search}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream", "upload-offset": "0" },
        body: bytes,
      });
      await server.request(`/upload-sessions/${created.upload_session.upload_session_id}/finalise`, {
        method: "POST",
        headers: { "idempotency-key": `finalise-${key}` },
      });
      return created.upload_session.upload_session_id as string;
    }

    const maliciousId = await submit(
      "unsafe.png",
      "image/png",
      Buffer.from("EICAR-STANDARD-ANTIVIRUS-TEST-FILE"),
      "malicious",
    );
    const spoofId = await submit("spoof.jpg", "image/jpeg", png(), "spoof");
    assert.equal(await server.executor.runAvailable(), true);
    assert.equal(await server.executor.runAvailable(), true);

    const malicious = await json(await server.request(`/upload-sessions/${maliciousId}`));
    const spoof = await json(await server.request(`/upload-sessions/${spoofId}`));
    assert.equal(malicious.upload_session.state, "rejected");
    assert.equal(malicious.upload_session.failure.code, "malware-detected");
    assert.equal(spoof.upload_session.state, "rejected");
    assert.equal(spoof.upload_session.failure.code, "signature-mismatch");
    assert.deepEqual((await json(await server.request(`/workspaces/${workspaceId}/files`))).files, []);
  } finally {
    await server.close();
  }
});

test("guest handoff preserves inspected source identity and requires explicit workspace authentication", async () => {
  const server = await api();
  try {
    const bootstrap = await json(await server.request("/session/bootstrap", {
      method: "POST",
      headers: { "idempotency-key": "bootstrap-handoff" },
    }));
    const workspaceId = bootstrap.workspace.workspace_id as string;
    const guest = await json(await server.request("/guest-sessions", { method: "POST" }));
    const bytes = png(4, 5);
    const created = await json(await server.request("/guest/upload-sessions", {
      method: "POST",
      headers: { "idempotency-key": "guest-handoff-upload", "x-ipw-guest-token": guest.token },
      body: JSON.stringify({ display_name: "guest-ready.png", media_type: "image/png", byte_size: bytes.byteLength }),
    }));
    const uploadUrl = new URL(created.authorization.upload_url, "http://local");
    await server.request(`${uploadUrl.pathname.replace("/v1", "")}${uploadUrl.search}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream", "upload-offset": "0" },
      body: bytes,
    });
    const finalised = await json(await server.request(
      `/upload-sessions/${created.upload_session.upload_session_id}/finalise`,
      {
        method: "POST",
        headers: { "idempotency-key": "guest-handoff-finalise", "x-ipw-guest-token": guest.token },
      },
    ));
    assert.equal(finalised.job.owner_kind, "guest");
    await server.executor.runAvailable();
    const ready = await json(await server.request(`/upload-sessions/${created.upload_session.upload_session_id}`, {
      headers: { "x-ipw-guest-token": guest.token },
    }));
    assert.equal(ready.upload_session.state, "ready");
    assert.equal(ready.upload_session.file_id, null);

    const handoffOptions = {
      method: "POST",
      headers: { "idempotency-key": "guest-handoff-save", "x-ipw-guest-token": guest.token },
      body: JSON.stringify({ workspace_id: workspaceId }),
    };
    const handedOff = await json(await server.request(
      `/upload-sessions/${created.upload_session.upload_session_id}/handoff`,
      handoffOptions,
    ));
    const replay = await json(await server.request(
      `/upload-sessions/${created.upload_session.upload_session_id}/handoff`,
      handoffOptions,
    ));
    assert.equal(handedOff.asset_original_id, ready.upload_session.asset_original_id);
    assert.equal(handedOff.source_version_id, ready.upload_session.source_version_id);
    assert.equal(replay.command.replayed, true);
    assert.equal(replay.file.file_id, handedOff.file.file_id);
    const files = await json(await server.request(`/workspaces/${workspaceId}/files`));
    assert.equal(files.files.length, 1);
    assert.equal(files.files[0].asset_original_id, ready.upload_session.asset_original_id);
  } finally {
    await server.close();
  }
});
