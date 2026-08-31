import assert from "node:assert/strict";
import test from "node:test";

import { Test } from "@nestjs/testing";

import { AppModule } from "../src/app.module.js";
import { ProductErrorFilter } from "../src/common/product-error.filter.js";
import { MemoryProductKernelRepository } from "../src/kernel/memory.repository.js";
import { DeterministicRuntimeValues } from "../src/kernel/runtime.js";

interface TestApi {
  base: string;
  close(): Promise<void>;
  request(path: string, options?: RequestInit, actor?: string): Promise<Response>;
}

async function api(): Promise<TestApi> {
  process.env["NODE_ENV"] = "test";
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix("v1");
  app.useGlobalFilters(new ProductErrorFilter());
  await app.listen(0, "127.0.0.1");
  const server = app.getHttpServer() as { address(): { port: number } };
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  return {
    base,
    close: () => app.close(),
    request(path, options = {}, actor = "actor-alex") {
      return fetch(`${base}${path}`, {
        ...options,
        headers: {
          "content-type": "application/json",
          "x-ipw-test-actor-id": actor,
          "x-ipw-test-actor-name": actor === "actor-alex" ? "Alex Morgan" : "Other actor",
          "x-trace-id": "trace-api-test",
          ...options.headers,
        },
      });
    },
  };
}

async function json<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T;
  assert.ok(response.headers.get("content-type")?.includes("application/json"));
  return body;
}

test("bootstrap is idempotent and exposes permission origin", async () => {
  const server = await api();
  try {
    const options = { method: "POST", headers: { "idempotency-key": "bootstrap-001" } };
    const first = await json<any>(await server.request("/session/bootstrap", options));
    const replay = await json<any>(await server.request("/session/bootstrap", options));
    const secondKey = await json<any>(
      await server.request("/session/bootstrap", {
        method: "POST",
        headers: { "idempotency-key": "bootstrap-002" },
      }),
    );

    assert.equal(first.workspace.workspace_id, replay.workspace.workspace_id);
    assert.equal(first.default_files.default_files_id, replay.default_files.default_files_id);
    assert.equal(first.workspace.workspace_id, secondKey.workspace.workspace_id);
    assert.equal(first.default_files.default_files_id, secondKey.default_files.default_files_id);
    assert.equal(first.command.replayed, false);
    assert.equal(replay.command.replayed, true);
    assert.equal(first.effective_permissions[0].origin, "role");
    assert.equal(first.membership.role, "owner");
  } finally {
    await server.close();
  }
});

test("project and file journey preserves immutable identity across source and location changes", async () => {
  const server = await api();
  try {
    const bootstrap = await json<any>(
      await server.request("/session/bootstrap", {
        method: "POST",
        headers: { "idempotency-key": "bootstrap-journey" },
      }),
    );
    const workspaceId = bootstrap.workspace.workspace_id as string;
    const projectResponse = await server.request(`/workspaces/${workspaceId}/projects`, {
      method: "POST",
      headers: { "idempotency-key": "project-journey" },
      body: JSON.stringify({ name: "Launch kit" }),
    });
    assert.equal(projectResponse.status, 201);
    const created = await json<any>(projectResponse);

    const fileResponse = await server.request(`/workspaces/${workspaceId}/files`, {
      method: "POST",
      headers: { "idempotency-key": "file-journey" },
      body: JSON.stringify({
        display_name: "cover-source.png",
        object_key: "objects/alex/cover-source.png",
        sha256: "0".repeat(64),
        media_type: "image/png",
        byte_size: 2048,
      }),
    });
    const registered = await json<any>(fileResponse);
    const originalId = registered.original.asset_original_id as string;
    const sourceId = registered.source_version.source_version_id as string;
    const fileId = registered.file.file_id as string;

    await json<any>(
      await server.request(`/workspaces/${workspaceId}/files/${fileId}/references`, {
        method: "POST",
        headers: { "idempotency-key": "reference-journey" },
        body: JSON.stringify({ owner_kind: "project", owner_id: created.project.project_id, purpose: "cover" }),
      }),
    );
    const moved = await json<any>(
      await server.request(`/workspaces/${workspaceId}/files/${fileId}/location`, {
        method: "PATCH",
        headers: { "idempotency-key": "move-journey" },
        body: JSON.stringify({ kind: "project", project_id: created.project.project_id }),
      }),
    );
    assert.equal(moved.file.asset_original_id, originalId);
    assert.equal(moved.file.current_source_version_id, sourceId);
    assert.equal(moved.file.canonical_location.project_id, created.project.project_id);

    const nextSource = await json<any>(
      await server.request(`/workspaces/${workspaceId}/files/${fileId}/source-versions`, {
        method: "POST",
        headers: { "idempotency-key": "source-journey" },
        body: JSON.stringify({
          object_key: "objects/alex/cover-source-v2.png",
          sha256: "1".repeat(64),
          media_type: "image/png",
          byte_size: 2304,
        }),
      }),
    );
    assert.equal(nextSource.file.asset_original_id, originalId);
    assert.notEqual(nextSource.file.current_source_version_id, sourceId);
    assert.equal(nextSource.source_version.previous_source_version_id, sourceId);

    const references = await json<any>(
      await server.request(`/workspaces/${workspaceId}/files/${fileId}/references`),
    );
    assert.equal(references.references.length, 1);
    assert.equal(references.references[0].owner_id, created.project.project_id);
  } finally {
    await server.close();
  }
});

test("tenant isolation, idempotency conflicts, audit and zero-charge ledger are enforced", async () => {
  const server = await api();
  try {
    const bootstrap = await json<any>(
      await server.request("/session/bootstrap", {
        method: "POST",
        headers: { "idempotency-key": "bootstrap-security" },
      }),
    );
    const workspaceId = bootstrap.workspace.workspace_id as string;
    const create = (name: string) =>
      server.request(`/workspaces/${workspaceId}/projects`, {
        method: "POST",
        headers: { "idempotency-key": "same-project-key" },
        body: JSON.stringify({ name }),
      });
    assert.equal((await create("First name")).status, 201);
    const conflict = await create("Different name");
    assert.equal(conflict.status, 409);
    assert.equal((await json<any>(conflict)).error.code, "idempotency-conflict");

    const denied = await server.request(`/workspaces/${workspaceId}/context`, {}, "actor-other");
    assert.equal(denied.status, 403);
    assert.equal((await json<any>(denied)).error.code, "access-denied");

    const audit = await json<any>(await server.request(`/workspaces/${workspaceId}/audit-events`));
    const usage = await json<any>(await server.request(`/workspaces/${workspaceId}/usage-summary`));
    assert.ok(audit.events.some((event: any) => event.action === "project.created"));
    assert.equal(usage.files, 0);
    assert.equal(usage.storage_bytes, 0);
    assert.equal(usage.jobs, 0);
    assert.equal(usage.high_cost_processing, 0);
    assert.ok(usage.activities.some((event: any) => event.event_kind === "project.created"));
    assert.doesNotMatch(JSON.stringify(usage), /amount|currency|credit_debit/i);
  } finally {
    await server.close();
  }
});

test("workspace listing and context stop authorizing a removed membership", async () => {
  const repository = new MemoryProductKernelRepository(new DeterministicRuntimeValues());
  const principal = { actorId: "actor-membership", displayName: "Membership Customer" };
  const bootstrapped = await repository.bootstrap({
    principal,
    idempotencyKey: "bootstrap-membership",
    traceId: "trace-membership",
    requestHash: "request-membership",
  });
  assert.equal((await repository.listWorkspaces(principal.actorId)).length, 1);
  assert.ok(await repository.workspaceContext(principal.actorId, bootstrapped.workspace.workspace_id));

  const internals = repository as unknown as { memberships: Map<string, unknown> };
  internals.memberships.delete(`${principal.actorId}:${bootstrapped.workspace.workspace_id}`);
  assert.deepEqual(await repository.listWorkspaces(principal.actorId), []);
  assert.equal(await repository.workspaceContext(principal.actorId, bootstrapped.workspace.workspace_id), null);
});
