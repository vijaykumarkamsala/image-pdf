import assert from "node:assert/strict";
import test from "node:test";

import { Test } from "@nestjs/testing";

import { AppModule } from "../src/app.module.js";
import { ProductErrorFilter } from "../src/common/product-error.filter.js";

async function api() {
  process.env["NODE_ENV"] = "test";
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix("v1");
  app.useGlobalFilters(new ProductErrorFilter());
  await app.listen(0, "127.0.0.1");
  const server = app.getHttpServer() as { address(): { port: number } };
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  return {
    close: () => app.close(),
    request(path: string, options: RequestInit = {}, actor = "actor-intake") {
      return fetch(`${base}${path}`, {
        ...options,
        headers: {
          "content-type": "application/json",
          "x-ipw-actor-id": actor,
          "x-ipw-actor-name": actor,
          "x-trace-id": "trace-intake-test",
          ...options.headers,
        },
      });
    },
  };
}

async function body(response: Response): Promise<any> {
  const result = await response.json();
  assert.ok(response.headers.get("content-type")?.includes("application/json"));
  return result;
}

test("authenticated upload authorization is resumable, private, isolated and cancellable", async () => {
  const server = await api();
  try {
    const bootstrap = await body(await server.request("/session/bootstrap", {
      method: "POST",
      headers: { "idempotency-key": "bootstrap-intake" },
    }));
    const workspaceId = bootstrap.workspace.workspace_id as string;
    const createOptions = {
      method: "POST",
      headers: { "idempotency-key": "upload-create-001" },
      body: JSON.stringify({ display_name: "proof.png", media_type: "image/png", byte_size: 4 }),
    };
    const createdResponse = await server.request(`/workspaces/${workspaceId}/upload-sessions`, createOptions);
    assert.equal(createdResponse.status, 201);
    const created = await body(createdResponse);
    assert.equal(created.upload_session.state, "initiated");
    assert.equal(created.authorization.transfer_kind, "resumable");
    assert.equal(created.authorization.provider, "local_api");
    assert.equal(created.authorization.protocol, "ipw_offset_json");
    assert.match(created.authorization.resume_token, /^[A-Za-z0-9_-]{40,}$/);
    assert.match(created.authorization.upload_url, /^\/v1\/uploads\//);
    assert.ok(!JSON.stringify(created).includes("quarantine/"));

    const replay = await body(await server.request(`/workspaces/${workspaceId}/upload-sessions`, createOptions));
    assert.equal(replay.command.replayed, true);
    assert.equal(replay.upload_session.upload_session_id, created.upload_session.upload_session_id);
    assert.notEqual(replay.authorization.upload_url, created.authorization.upload_url);

    const idempotencyConflict = await server.request(`/workspaces/${workspaceId}/upload-sessions`, {
      ...createOptions,
      body: JSON.stringify({ display_name: "different.png", media_type: "image/png", byte_size: 4 }),
    });
    assert.equal(idempotencyConflict.status, 409);
    assert.equal((await body(idempotencyConflict)).error.code, "idempotency-conflict");

    const resumed = await body(await server.request(
      `/upload-sessions/${created.upload_session.upload_session_id}/resume`,
      { method: "POST" },
    ));
    assert.notEqual(resumed.authorization.resume_token, replay.authorization.resume_token);
    assert.notEqual(resumed.authorization.upload_url, replay.authorization.upload_url);

    const expiredAuthorization = new URL(replay.authorization.upload_url, "http://local");
    const expired = await server.request(`${expiredAuthorization.pathname.replace("/v1", "")}${expiredAuthorization.search}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream", "upload-offset": "0" },
      body: new Uint8Array([1]),
    });
    assert.equal(expired.status, 401);

    const firstUrl = new URL(resumed.authorization.upload_url, "http://local");
    const first = await server.request(`${firstUrl.pathname.replace("/v1", "")}${firstUrl.search}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream", "upload-offset": "0" },
      body: new Uint8Array([1, 2]),
    });
    assert.equal(first.status, 200);
    assert.equal((await body(first)).upload_offset, 2);

    const conflict = await server.request(`${firstUrl.pathname.replace("/v1", "")}${firstUrl.search}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream", "upload-offset": "0" },
      body: new Uint8Array([3]),
    });
    assert.equal(conflict.status, 409);
    assert.equal((await body(conflict)).error.code, "upload-offset-conflict");

    const isolated = await server.request(`/upload-sessions/${created.upload_session.upload_session_id}`, {}, "actor-other");
    assert.equal(isolated.status, 404);

    const cancelled = await server.request(`/upload-sessions/${created.upload_session.upload_session_id}`, {
      method: "DELETE",
      headers: { "idempotency-key": "upload-cancel-001" },
    });
    assert.equal(cancelled.status, 200);
    assert.equal((await body(cancelled)).upload_session.state, "cancelled");

    const usage = await body(await server.request(`/workspaces/${workspaceId}/usage-summary`));
    assert.ok(usage.events.some((event: any) => event.event_kind === "upload.created"));
    assert.ok(usage.events.every((event: any) => event.customer_amount === "0.00" && event.credit_debit === 0));
  } finally {
    await server.close();
  }
});

test("guest bearer tokens are opaque, expiring and tenant isolated", async () => {
  const server = await api();
  try {
    const firstGuest = await body(await server.request("/guest-sessions", { method: "POST" }));
    const secondGuest = await body(await server.request("/guest-sessions", { method: "POST" }));
    assert.match(firstGuest.token, /^[A-Za-z0-9_-]{40,}$/);
    assert.ok(!JSON.stringify(firstGuest.guest_session).includes(firstGuest.token));
    const created = await body(await server.request("/guest/upload-sessions", {
      method: "POST",
      headers: {
        "idempotency-key": "guest-upload-001",
        "x-ipw-guest-token": firstGuest.token,
      },
      body: JSON.stringify({ display_name: "guest.pdf", media_type: "application/pdf", byte_size: 10 }),
    }));
    const denied = await server.request(`/upload-sessions/${created.upload_session.upload_session_id}`, {
      headers: { "x-ipw-guest-token": secondGuest.token },
    });
    assert.equal(denied.status, 404);
    const allowed = await server.request(`/upload-sessions/${created.upload_session.upload_session_id}`, {
      headers: { "x-ipw-guest-token": firstGuest.token },
    });
    assert.equal(allowed.status, 200);
  } finally {
    await server.close();
  }
});
