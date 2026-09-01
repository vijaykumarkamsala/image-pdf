import assert from "node:assert/strict";
import test from "node:test";

import { Test } from "@nestjs/testing";

import { AppModule } from "../src/app.module.js";
import { ProductErrorFilter } from "../src/common/product-error.filter.js";
import { LocalInspectionExecutor } from "../src/domains/jobs/local-inspection-executor.js";

function png(width = 120, height = 80): Uint8Array {
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
    request(path: string, options: RequestInit = {}, actor = "actor-editor") {
      return fetch(`http://127.0.0.1:${server.address().port}/v1${path}`, {
        ...options,
        headers: {
          "content-type": "application/json",
          "x-ipw-test-actor-id": actor,
          "x-ipw-test-actor-name": actor === "actor-editor" ? "Editor Owner" : "Another Editor",
          "x-trace-id": `trace-${actor}`,
          ...options.headers,
        },
      });
    },
  };
}

async function json(response: Response): Promise<any> { return response.json(); }

test("verified raster becomes an immutable-source native document with lease, autosave, history and versions", async () => {
  const server = await api();
  try {
    const bootstrap = await json(await server.request("/session/bootstrap", { method: "POST", headers: { "idempotency-key": "editor-bootstrap" } }));
    const workspaceId = bootstrap.workspace.workspace_id as string;
    const bytes = png();
    const upload = await json(await server.request(`/workspaces/${workspaceId}/upload-sessions`, {
      method: "POST", headers: { "idempotency-key": "editor-upload" },
      body: JSON.stringify({ display_name: "studio-source.png", media_type: "image/png", byte_size: bytes.byteLength }),
    }));
    const uploadUrl = new URL(upload.authorization.upload_url, "http://local");
    await server.request(`${uploadUrl.pathname.replace("/v1", "")}${uploadUrl.search}`, {
      method: "PUT", headers: { "content-type": "application/octet-stream", "upload-offset": "0" }, body: bytes,
    });
    await server.request(`/upload-sessions/${upload.upload_session.upload_session_id}/finalise`, { method: "POST", headers: { "idempotency-key": "editor-finalise" } });
    assert.equal(await server.executor.runAvailable(), true);
    const accepted = await json(await server.request(`/upload-sessions/${upload.upload_session.upload_session_id}`));
    const sourceFileId = accepted.upload_session.file_id as string;

    const createOptions = {
      method: "POST",
      headers: { "idempotency-key": "editor-create" },
      body: JSON.stringify({ name: "Campaign graphic", source_file_id: sourceFileId, intended_use: "digital" }),
    };
    const created = await json(await server.request(`/workspaces/${workspaceId}/documents`, createOptions));
    const replay = await json(await server.request(`/workspaces/${workspaceId}/documents`, createOptions));
    const documentId = created.editor.document.document_id as string;
    assert.equal(replay.replayed, true);
    assert.equal(replay.editor.document.document_id, documentId);
    assert.equal(created.editor.document.source_asset_original_id, accepted.upload_session.asset_original_id);
    assert.equal(created.editor.document.source_version_id, accepted.upload_session.source_version_id);
    assert.equal(created.editor.snapshot.layers[0].raster.adjustments.brightness, 0);
    assert.equal(created.editor.snapshot.artboards[0].width, 120);

    const lease = await json(await server.request(`/workspaces/${workspaceId}/documents/${documentId}/lease`, {
      method: "POST", headers: { "idempotency-key": "editor-lease" },
    }));
    const leaseToken = lease.grant.lease_token as string;
    const layer = created.editor.snapshot.layers[0];
    const mutationOptions = {
      method: "PATCH",
      headers: { "idempotency-key": "editor-mutation", "x-editor-lease": leaseToken },
      body: JSON.stringify({
        base_revision: 0,
        mutation: { kind: "layer.update", target_id: layer.layer_id, transform: { ...layer.transform, x: 12, y: 8 }, properties: {} },
      }),
    };
    const mutated = await json(await server.request(`/workspaces/${workspaceId}/documents/${documentId}`, mutationOptions));
    const mutationReplay = await json(await server.request(`/workspaces/${workspaceId}/documents/${documentId}`, mutationOptions));
    assert.equal(mutated.mutation.snapshot.revision, 1);
    assert.equal(mutated.mutation.snapshot.layers[0].transform.x, 12);
    assert.equal(mutationReplay.mutation.replayed, true);

    const stale = await server.request(`/workspaces/${workspaceId}/documents/${documentId}`, {
      method: "PATCH",
      headers: { "idempotency-key": "editor-stale", "x-editor-lease": leaseToken },
      body: JSON.stringify({ base_revision: 0, mutation: { kind: "document.rename", properties: {} } }),
    });
    assert.equal(stale.status, 409);
    assert.equal((await json(stale)).error.code, "document-revision-conflict");

    const undone = await json(await server.request(`/workspaces/${workspaceId}/documents/${documentId}/undo`, {
      method: "POST", headers: { "idempotency-key": "editor-undo", "x-editor-lease": leaseToken },
    }));
    assert.equal(undone.history.snapshot.layers[0].transform.x, 0);
    const redone = await json(await server.request(`/workspaces/${workspaceId}/documents/${documentId}/redo`, {
      method: "POST", headers: { "idempotency-key": "editor-redo", "x-editor-lease": leaseToken },
    }));
    assert.equal(redone.history.snapshot.layers[0].transform.x, 12);

    const version = await json(await server.request(`/workspaces/${workspaceId}/documents/${documentId}/versions`, {
      method: "POST", headers: { "idempotency-key": "editor-version" }, body: JSON.stringify({ name: "Approved layout" }),
    }));
    assert.equal(version.version.kind, "named");
    const compatibility = await json(await server.request(`/workspaces/${workspaceId}/documents/${documentId}/compatibility-reports`));
    assert.equal(compatibility.reports[0].state, "compatible");
    assert.equal(compatibility.reports[0].source_preserved, true);

    const project = await json(await server.request(`/workspaces/${workspaceId}/projects`, {
      method: "POST", headers: { "idempotency-key": "editor-project" }, body: JSON.stringify({ name: "Campaign" }),
    }));
    await server.request(`/workspaces/${workspaceId}/files/${sourceFileId}/location`, {
      method: "PATCH", headers: { "idempotency-key": "editor-source-move" }, body: JSON.stringify({ kind: "project", project_id: project.project.project_id }),
    });
    const afterMove = await json(await server.request(`/workspaces/${workspaceId}/documents/${documentId}`));
    assert.equal(afterMove.editor.document.source_asset_original_id, created.editor.document.source_asset_original_id);
    assert.equal(afterMove.editor.document.source_version_id, created.editor.document.source_version_id);

    const saveAsOptions = {
      method: "POST",
      headers: { "idempotency-key": "editor-save-as" },
      body: JSON.stringify({ name: "Campaign copy", project_id: project.project.project_id }),
    };
    const savedAs = await json(await server.request(`/workspaces/${workspaceId}/documents/${documentId}/save-as`, saveAsOptions));
    const savedAsReplay = await json(await server.request(`/workspaces/${workspaceId}/documents/${documentId}/save-as`, saveAsOptions));
    assert.notEqual(savedAs.editor.document.document_id, documentId);
    assert.equal(savedAs.editor.document.location.kind, "project");
    assert.equal(savedAs.editor.document.location.project_id, project.project.project_id);
    assert.equal(savedAs.editor.document.source_asset_original_id, created.editor.document.source_asset_original_id);
    assert.equal(savedAs.editor.document.source_version_id, created.editor.document.source_version_id);
    assert.equal(savedAs.editor.snapshot.document_id, savedAs.editor.document.document_id);
    assert.equal(savedAsReplay.replayed, true);
    assert.equal(savedAsReplay.editor.document.document_id, savedAs.editor.document.document_id);

    const source = await server.request(`/workspaces/${workspaceId}/documents/${documentId}/source`, { headers: { "content-type": "" } });
    assert.equal(source.status, 200);
    assert.match(source.headers.get("cache-control") ?? "", /no-store/);
    assert.deepEqual([...new Uint8Array(await source.arrayBuffer())], [...bytes]);

    const audit = await json(await server.request(`/workspaces/${workspaceId}/audit-events`));
    const usage = await json(await server.request(`/workspaces/${workspaceId}/usage-summary`));
    assert.equal(audit.events.filter((event: any) => event.action === "document.created").length, 1);
    assert.ok(usage.activities.some((event: any) => event.event_kind === "document.created"));
    assert.doesNotMatch(JSON.stringify(usage), /customer_amount|currency|credit_debit/i);
  } finally {
    await server.close();
  }
});

test("additional Studio assets are server-authorised, replay-safe and independently delivered", async () => {
  const server = await api();
  try {
    const bootstrap = await json(await server.request("/session/bootstrap", { method: "POST", headers: { "idempotency-key": "asset-bootstrap" } }));
    const workspaceId = bootstrap.workspace.workspace_id as string;
    const accept = async (name: string, bytes: Uint8Array, key: string) => {
      const upload = await json(await server.request(`/workspaces/${workspaceId}/upload-sessions`, {
        method: "POST", headers: { "idempotency-key": `${key}-upload` },
        body: JSON.stringify({ display_name: name, media_type: "image/png", byte_size: bytes.byteLength }),
      }));
      const uploadUrl = new URL(upload.authorization.upload_url, "http://local");
      await server.request(`${uploadUrl.pathname.replace("/v1", "")}${uploadUrl.search}`, {
        method: "PUT", headers: { "content-type": "application/octet-stream", "upload-offset": "0" }, body: bytes,
      });
      await server.request(`/upload-sessions/${upload.upload_session.upload_session_id}/finalise`, { method: "POST", headers: { "idempotency-key": `${key}-finalise` } });
      assert.equal(await server.executor.runAvailable(), true);
      return json(await server.request(`/upload-sessions/${upload.upload_session.upload_session_id}`));
    };
    const first = await accept("first.png", png(120, 80), "asset-first");
    const secondBytes = png(64, 64);
    const second = await accept("second.png", secondBytes, "asset-second");
    const created = await json(await server.request(`/workspaces/${workspaceId}/documents`, {
      method: "POST", headers: { "idempotency-key": "asset-document" },
      body: JSON.stringify({ name: "Multi asset", source_file_id: first.upload_session.file_id, intended_use: "digital" }),
    }));
    const documentId = created.editor.document.document_id as string;
    const lease = await json(await server.request(`/workspaces/${workspaceId}/documents/${documentId}/lease`, {
      method: "POST", headers: { "idempotency-key": "asset-lease" },
    }));
    const options = {
      method: "POST",
      headers: { "idempotency-key": "asset-add", "x-editor-lease": lease.grant.lease_token },
      body: JSON.stringify({ base_revision: 0, file_id: second.upload_session.file_id, artboard_id: created.editor.snapshot.artboards[0].artboard_id }),
    };
    const added = await json(await server.request(`/workspaces/${workspaceId}/documents/${documentId}/assets`, options));
    const replay = await json(await server.request(`/workspaces/${workspaceId}/documents/${documentId}/assets`, options));
    assert.equal(added.mutation.snapshot.shared_assets.length, 2);
    assert.equal(added.mutation.snapshot.layers.length, 2);
    assert.equal(replay.mutation.replayed, true);
    const addedAssetId = added.mutation.snapshot.layers.find((item: any) => item.name === "second.png").raster.shared_asset_id as string;
    const delivered = await server.request(`/workspaces/${workspaceId}/documents/${documentId}/assets/${addedAssetId}/source`, { headers: { "content-type": "" } });
    assert.equal(delivered.status, 200);
    assert.deepEqual([...new Uint8Array(await delivered.arrayBuffer())], [...secondBytes]);

    const spoofed = await server.request(`/workspaces/${workspaceId}/documents/${documentId}`, {
      method: "PATCH", headers: { "idempotency-key": "asset-spoof", "x-editor-lease": lease.grant.lease_token },
      body: JSON.stringify({ base_revision: 1, mutation: { kind: "asset.add", shared_asset: { shared_asset_id: "forged" }, properties: {} } }),
    });
    assert.equal(spoofed.status, 400);
    assert.equal((await json(spoofed)).error.code, "document-mutation-invalid");
  } finally {
    await server.close();
  }
});
