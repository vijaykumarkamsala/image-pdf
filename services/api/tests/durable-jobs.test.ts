import assert from "node:assert/strict";
import test from "node:test";

import { Test } from "@nestjs/testing";

import { AppModule } from "../src/app.module.js";
import { ProductErrorFilter } from "../src/common/product-error.filter.js";
import { JOB_DISPATCH_QUEUE, LocalJobDispatchQueue } from "../src/domains/jobs/dispatch.js";

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
    queue: app.get<LocalJobDispatchQueue>(JOB_DISPATCH_QUEUE),
    request(path: string, options: RequestInit = {}, actor = "actor-jobs") {
      return fetch(`http://127.0.0.1:${server.address().port}/v1${path}`, {
        ...options,
        headers: {
          "content-type": "application/json",
          "x-ipw-actor-id": actor,
          "x-ipw-actor-name": actor,
          "x-trace-id": "trace-jobs-test",
          ...options.headers,
        },
      });
    },
  };
}

async function json(response: Response): Promise<any> {
  return response.json();
}

test("finalisation atomically creates one durable job with reconnectable ordered events", async () => {
  const server = await api();
  try {
    const bootstrap = await json(await server.request("/session/bootstrap", {
      method: "POST",
      headers: { "idempotency-key": "bootstrap-jobs" },
    }));
    const workspaceId = bootstrap.workspace.workspace_id as string;
    const created = await json(await server.request(`/workspaces/${workspaceId}/upload-sessions`, {
      method: "POST",
      headers: { "idempotency-key": "upload-jobs" },
      body: JSON.stringify({ display_name: "durable.png", media_type: "image/png", byte_size: 4 }),
    }));
    const uploadUrl = new URL(created.authorization.upload_url, "http://local");
    const uploaded = await server.request(`${uploadUrl.pathname.replace("/v1", "")}${uploadUrl.search}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream", "upload-offset": "0" },
      body: new Uint8Array([1, 2, 3, 4]),
    });
    assert.equal(uploaded.status, 200);

    const finaliseOptions = { method: "POST", headers: { "idempotency-key": "finalise-jobs" } };
    const finalisedResponse = await server.request(
      `/upload-sessions/${created.upload_session.upload_session_id}/finalise`,
      finaliseOptions,
    );
    assert.equal(finalisedResponse.status, 201);
    const finalised = await json(finalisedResponse);
    assert.equal(finalised.upload_session.state, "finalising");
    assert.equal(finalised.job.state, "queued");
    assert.equal(finalised.job.attempt, 0);
    assert.equal(server.queue.pending().length, 1);
    assert.deepEqual(Object.keys(server.queue.pending()[0]).sort(), ["dispatchId", "jobId", "kind"]);

    const replay = await json(await server.request(
      `/upload-sessions/${created.upload_session.upload_session_id}/finalise`,
      finaliseOptions,
    ));
    assert.equal(replay.command.replayed, true);
    assert.equal(replay.job.job_id, finalised.job.job_id);
    assert.equal(server.queue.pending().length, 1);

    const refreshed = await json(await server.request(`/jobs/${finalised.job.job_id}`));
    assert.equal(refreshed.job.job_id, finalised.job.job_id);
    const events = await json(await server.request(`/jobs/${finalised.job.job_id}/events?after=0&limit=20`));
    assert.equal(events.events[0].event_kind, "job.queued");
    assert.equal(events.next_cursor, events.events[0].cursor);
    const noDuplicates = await json(
      await server.request(`/jobs/${finalised.job.job_id}/events?after=${events.next_cursor}&limit=20`),
    );
    assert.deepEqual(noDuplicates.events, []);

    const denied = await server.request(`/jobs/${finalised.job.job_id}`, {}, "actor-other");
    assert.equal(denied.status, 404);

    const cancelled = await json(await server.request(`/jobs/${finalised.job.job_id}/cancel`, {
      method: "POST",
      headers: { "idempotency-key": "cancel-jobs" },
    }));
    assert.equal(cancelled.job.state, "cancelled");
    const afterCancel = await json(await server.request(`/jobs/${finalised.job.job_id}/events?after=0&limit=20`));
    assert.deepEqual(afterCancel.events.map((event: any) => event.event_kind), ["job.queued", "job.cancelled"]);
  } finally {
    await server.close();
  }
});

test("finalisation rejects incomplete uploads without creating a dispatch", async () => {
  const server = await api();
  try {
    const bootstrap = await json(await server.request("/session/bootstrap", {
      method: "POST",
      headers: { "idempotency-key": "bootstrap-incomplete" },
    }));
    const created = await json(await server.request(`/workspaces/${bootstrap.workspace.workspace_id}/upload-sessions`, {
      method: "POST",
      headers: { "idempotency-key": "upload-incomplete" },
      body: JSON.stringify({ display_name: "partial.pdf", media_type: "application/pdf", byte_size: 8 }),
    }));
    const response = await server.request(`/upload-sessions/${created.upload_session.upload_session_id}/finalise`, {
      method: "POST",
      headers: { "idempotency-key": "finalise-incomplete" },
    });
    assert.equal(response.status, 409);
    assert.equal((await json(response)).error.code, "upload-incomplete");
    assert.equal(server.queue.pending().length, 0);
  } finally {
    await server.close();
  }
});
