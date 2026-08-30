import assert from "node:assert/strict";
import test from "node:test";
import type { CloudTasksClient } from "@google-cloud/tasks";

import {
  createJobDispatchQueue,
  GoogleCloudTasksProviderClient,
  loadCloudTasksConfig,
} from "../src/domains/jobs/cloud-tasks-client.js";
import { CloudTasksJobDispatchQueue, LocalJobDispatchQueue } from "../src/domains/jobs/dispatch.js";
import type { DurableJobRepository, JobOutboxRecord } from "../src/domains/jobs/durable-job.types.js";
import { OutboxDispatcher } from "../src/domains/jobs/outbox-dispatcher.js";
import type { RuntimeValues } from "../src/kernel/runtime.js";

const productionEnv = {
  NODE_ENV: "production",
  IPW_GCP_PROJECT_ID: "ipw-prod-001",
  IPW_CLOUD_TASKS_LOCATION: "asia-south1",
  IPW_CLOUD_TASKS_QUEUE: "file-intake",
  IPW_WORKER_TASK_URL: "https://worker.example/internal/tasks/process-job",
  IPW_WORKER_OIDC_AUDIENCE: "https://worker.example/",
  IPW_CLOUD_TASKS_SERVICE_ACCOUNT: "intake-tasks@ipw-prod-001.iam.gserviceaccount.com",
};

test("production Cloud Tasks configuration is complete, validated and never local", () => {
  assert.throws(() => loadCloudTasksConfig({ NODE_ENV: "production" }), /IPW_GCP_PROJECT_ID/);
  assert.throws(
    () => loadCloudTasksConfig({ ...productionEnv, IPW_WORKER_TASK_URL: "http://worker.example/task" }),
    /protected HTTPS/,
  );
  const provider = { async createHttpTask() {} };
  const production = createJobDispatchQueue(productionEnv, provider);
  assert.ok(production instanceof CloudTasksJobDispatchQueue);
  assert.ok(!(production instanceof LocalJobDispatchQueue));
  assert.ok(createJobDispatchQueue({ NODE_ENV: "test" }) instanceof LocalJobDispatchQueue);
});

test("official Cloud Tasks adapter constructs an OIDC request with only opaque references", async () => {
  let request: any;
  const fakeClient = {
    queuePath: (project: string, location: string, queue: string) => `projects/${project}/locations/${location}/queues/${queue}`,
    taskPath: (project: string, location: string, queue: string, task: string) =>
      `projects/${project}/locations/${location}/queues/${queue}/tasks/${task}`,
    async createTask(value: unknown) { request = value; return [{}]; },
  } as unknown as CloudTasksClient;
  const config = loadCloudTasksConfig(productionEnv);
  const provider = new GoogleCloudTasksProviderClient(config, fakeClient);
  await provider.createHttpTask({
    taskName: "dispatch-001",
    endpoint: config.targetUrl,
    audience: config.audience,
    serviceAccountEmail: config.serviceAccountEmail,
    body: { dispatchId: "dispatch-001", jobId: "job-001", traceId: "trace-001", kind: "process_job" },
  });
  assert.equal(request.parent, "projects/ipw-prod-001/locations/asia-south1/queues/file-intake");
  assert.equal(request.task.httpRequest.oidcToken.serviceAccountEmail, config.serviceAccountEmail);
  assert.equal(request.task.httpRequest.oidcToken.audience, config.audience);
  assert.deepEqual(JSON.parse(Buffer.from(request.task.httpRequest.body).toString("utf8")), {
    dispatchId: "dispatch-001",
    jobId: "job-001",
    traceId: "trace-001",
    kind: "process_job",
  });
  assert.ok(!Buffer.from(request.task.httpRequest.body).toString("utf8").match(/token|credential|bytes|object/i));
});

test("Cloud Tasks ALREADY_EXISTS is accepted as idempotent redelivery", async () => {
  const fakeClient = {
    queuePath: () => "queue",
    taskPath: () => "task",
    async createTask() { throw Object.assign(new Error("already exists"), { code: 6 }); },
  } as unknown as CloudTasksClient;
  const provider = new GoogleCloudTasksProviderClient(loadCloudTasksConfig(productionEnv), fakeClient);
  await assert.doesNotReject(provider.createHttpTask({
    taskName: "dispatch-001",
    endpoint: productionEnv.IPW_WORKER_TASK_URL,
    audience: productionEnv.IPW_WORKER_OIDC_AUDIENCE,
    serviceAccountEmail: productionEnv.IPW_CLOUD_TASKS_SERVICE_ACCOUNT,
    body: { dispatchId: "dispatch-001", jobId: "job-001", traceId: "trace-001", kind: "process_job" },
  }));
});

test("independent outbox relay releases failures and marks only successful provider creation", async () => {
  const record: JobOutboxRecord = {
    outboxId: "outbox-001",
    jobId: "job-001",
    traceId: "trace-001",
    availableAt: "2026-08-30T00:00:00.000Z",
    deliveryAttempts: 1,
    leaseOwner: "",
  };
  let pending = true;
  let marked = 0;
  let released = 0;
  const repository = {
    async claimOutbox(workerId: string) {
      if (!pending) return [];
      pending = false;
      return [{ ...record, leaseOwner: workerId }];
    },
    async markOutboxDispatched() { marked += 1; },
    async releaseOutbox() { released += 1; pending = true; },
  } as unknown as DurableJobRepository;
  let fail = true;
  const queue = {
    async enqueue() {
      if (fail) throw new Error("provider unavailable");
    },
  };
  let sequence = 0;
  const runtime: RuntimeValues = {
    id: (prefix) => `${prefix}-${++sequence}`,
    now: () => "2026-08-30T00:00:00.000Z",
  };
  const dispatcher = new OutboxDispatcher(repository, queue, runtime);
  assert.equal(await dispatcher.dispatchOnce(), 0);
  assert.equal(released, 1);
  assert.equal(marked, 0);
  fail = false;
  assert.equal(await dispatcher.dispatchOnce(), 1);
  assert.equal(marked, 1);
});
