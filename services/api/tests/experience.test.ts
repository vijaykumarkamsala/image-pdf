import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { Test } from "@nestjs/testing";
import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";

import { AppModule } from "../src/app.module.js";
import { ProductErrorFilter } from "../src/common/product-error.filter.js";
import { LocalInspectionExecutor } from "../src/domains/jobs/local-inspection-executor.js";
import { DURABLE_JOB_REPOSITORY, type DurableJobRepository } from "../src/domains/jobs/durable-job.types.js";

function png(): Uint8Array {
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(2, 16);
  bytes.writeUInt32BE(3, 20);
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
    jobs: app.get<DurableJobRepository>(DURABLE_JOB_REPOSITORY),
    request(path: string, options: RequestInit = {}, actor = "actor-experience") {
      return fetch(`http://127.0.0.1:${server.address().port}/v1${path}`, {
        ...options,
        headers: {
          "content-type": "application/json",
          "x-ipw-test-actor-id": actor,
          "x-ipw-test-actor-name": actor,
          "x-trace-id": `trace-${actor}`,
          ...options.headers,
        },
      });
    },
  };
}

async function json(response: Response): Promise<any> {
  return response.json();
}

async function bootstrap(server: Awaited<ReturnType<typeof api>>, actor: string, key: string) {
  return json(await server.request("/session/bootstrap", {
    method: "POST",
    headers: { "idempotency-key": key },
  }, actor));
}

async function submit(server: Awaited<ReturnType<typeof api>>, workspaceId: string, key: string) {
  const bytes = png();
  const created = await json(await server.request(`/workspaces/${workspaceId}/upload-sessions`, {
    method: "POST",
    headers: { "idempotency-key": `upload-${key}` },
    body: JSON.stringify({ display_name: `${key}.png`, media_type: "image/png", byte_size: bytes.byteLength }),
  }));
  const url = new URL(created.authorization.upload_url, "http://local");
  await server.request(`${url.pathname.replace("/v1", "")}${url.search}`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream", "upload-offset": "0" },
    body: bytes,
  });
  const finalised = await json(await server.request(`/upload-sessions/${created.upload_session.upload_session_id}/finalise`, {
    method: "POST",
    headers: { "idempotency-key": `finalise-${key}` },
  }));
  return { created, finalised };
}

test("Home, notifications, search and feature state are derived from real workspace records", async () => {
  const server = await api();
  try {
    const context = await bootstrap(server, "actor-experience", "bootstrap-experience");
    const workspaceId = context.workspace.workspace_id as string;
    await server.request(`/workspaces/${workspaceId}/projects`, {
      method: "POST",
      headers: { "idempotency-key": "project-experience" },
      body: JSON.stringify({ name: "Retail launch" }),
    });
    const submitted = await submit(server, workspaceId, "searchable");
    assert.equal(await server.executor.runAvailable(), true);

    const home = await json(await server.request(`/workspaces/${workspaceId}/home`));
    assert.ok(home.home.recent_work.some((item: any) => item.title === "Retail launch"));
    assert.ok(home.home.recent_work.some((item: any) => item.title === "searchable.png"));
    assert.ok(home.home.recent_jobs.some((item: any) => item.job_id === submitted.finalised.job.job_id));
    assert.ok(home.home.notifications.some((item: any) => item.kind === "upload_accepted"));
    assert.equal(home.home.usage.jobs, 1);

    const jobs = await json(await server.request(`/workspaces/${workspaceId}/jobs?view=completed&limit=1`));
    assert.equal(jobs.jobs.length, 1);
    assert.equal(jobs.jobs[0].state, "succeeded");
    const timeline = await json(await server.request(`/jobs/${jobs.jobs[0].job_id}/events?after=0&limit=100`));
    assert.deepEqual(timeline.events.map((event: any) => event.cursor), [...timeline.events].map((event: any) => event.cursor).sort((a, b) => a - b));

    const projectSearch = await json(await server.request(`/workspaces/${workspaceId}/search?q=retail&limit=1`));
    const fileSearch = await json(await server.request(`/workspaces/${workspaceId}/search?q=searchable`));
    const jobSearch = await json(await server.request(`/workspaces/${workspaceId}/search?q=file%20intake`));
    assert.equal(projectSearch.results[0].kind, "project");
    assert.equal(fileSearch.results[0].kind, "file");
    assert.equal(jobSearch.results[0].kind, "job");

    const notifications = await json(await server.request(`/workspaces/${workspaceId}/notifications?limit=1`));
    assert.equal(notifications.notifications.length, 1);
    assert.ok(notifications.next_cursor);
    const nextNotifications = await json(await server.request(
      `/workspaces/${workspaceId}/notifications?limit=1&cursor=${encodeURIComponent(notifications.next_cursor)}`,
    ));
    assert.equal(nextNotifications.notifications.length, 1);
    assert.notEqual(nextNotifications.notifications[0].notification_id, notifications.notifications[0].notification_id);
    assert.equal(nextNotifications.next_cursor, null);
    const orderedNotifications = await json(await server.request(`/workspaces/${workspaceId}/notifications?limit=10`));
    assert.deepEqual(orderedNotifications.notifications.slice(0, 2).map((item: any) => item.kind), ["upload_accepted", "job_completed"]);
    assert.equal(orderedNotifications.unread_count, 2);
    const readOptions = { method: "POST", headers: { "idempotency-key": "notification-read" } };
    const firstRead = await json(await server.request(
      `/workspaces/${workspaceId}/notifications/${notifications.notifications[0].notification_id}/read`,
      readOptions,
    ));
    const replayRead = await json(await server.request(
      `/workspaces/${workspaceId}/notifications/${notifications.notifications[0].notification_id}/read`,
      readOptions,
    ));
    assert.equal(firstRead.command.replayed, false);
    assert.equal(replayRead.command.replayed, true);
    const afterRead = await json(await server.request(`/workspaces/${workspaceId}/notifications?limit=10`));
    assert.ok(afterRead.notifications.find((item: any) => item.notification_id === notifications.notifications[0].notification_id).read_at);
    assert.equal(afterRead.unread_count, 1);

    const features = await json(await server.request(`/workspaces/${workspaceId}/features`));
    assert.equal(features.features.length, 4);
    assert.equal(features.features.find((feature: any) => feature.feature === "image-graphic-studio").active, true);
    assert.ok(features.features.filter((feature: any) => feature.feature !== "image-graphic-studio")
      .every((feature: any) => feature.active === false && feature.customer_visible === true));

    await bootstrap(server, "actor-other-experience", "bootstrap-other-experience");
    assert.equal((await server.request(`/workspaces/${workspaceId}/search?q=retail`, {}, "actor-other-experience")).status, 404);
    assert.equal((await server.request(`/workspaces/${workspaceId}/notifications`, {}, "actor-other-experience")).status, 404);
  } finally {
    await server.close();
  }
});

test("retryable failed jobs reopen only the same preserved source and replay idempotently", async () => {
  const server = await api();
  try {
    const context = await bootstrap(server, "actor-experience", "bootstrap-retry-experience");
    const workspaceId = context.workspace.workspace_id as string;
    const { finalised } = await submit(server, workspaceId, "retryable");
    const jobId = finalised.job.job_id as string;
    const owner = { ownerKind: "actor" as const, ownerScope: workspaceId, workspaceId, actorId: "actor-experience" };
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const token = `lease-token-${attempt}`;
      const tokenHash = createHash("sha256").update(token).digest("hex");
      const claimed = await server.jobs.claim(
        `worker-${attempt}`,
        token,
        tokenHash,
        `2026-08-30T00:0${attempt}:00.000Z`,
        `2026-08-30T00:0${attempt + 1}:00.000Z`,
        `trace-retry-${attempt}`,
      );
      assert.equal(claimed?.job.job_id, jobId);
      await server.jobs.start(jobId, tokenHash, `2026-08-30T00:0${attempt}:10.000Z`, `trace-retry-${attempt}`);
      await server.jobs.fail(
        jobId,
        tokenHash,
        { schema_version: PRODUCT_SCHEMA_VERSION, code: "scanner-unavailable", message: "Scanner unavailable", retryable: true },
        `2026-08-30T00:0${attempt}:20.000Z`,
        `2026-08-30T00:0${attempt + 1}:00.000Z`,
        `trace-retry-${attempt}`,
      );
    }
    const retryable = await json(await server.request(`/workspaces/${workspaceId}/jobs?view=retryable`));
    assert.equal(retryable.jobs[0].job_id, jobId);
    const options = { method: "POST", headers: { "idempotency-key": "manual-retry" } };
    const retryResponse = await server.request(`/jobs/${jobId}/retry`, options);
    const retried = await json(retryResponse);
    assert.equal(retryResponse.status, 201, JSON.stringify(retried));
    const replayResponse = await server.request(`/jobs/${jobId}/retry`, options);
    const replayed = await json(replayResponse);
    assert.equal(replayResponse.status, 201, JSON.stringify(replayed));
    assert.equal(retried.job.state, "queued");
    assert.equal(retried.job.max_attempts, 4);
    assert.equal(replayed.command.replayed, true);
    const events = await json(await server.request(`/jobs/${jobId}/events?after=0&limit=100`));
    assert.equal(events.events.filter((event: any) => event.event_kind === "job.retry-requested").length, 1);
    assert.ok(await server.jobs.findJob(jobId, owner));
  } finally {
    await server.close();
  }
});
