import assert from "node:assert/strict";
import test from "node:test";

import { Test } from "@nestjs/testing";

import { AppModule } from "../src/app.module.js";
import { ProductErrorFilter } from "../src/common/product-error.filter.js";
import { LocalInspectionExecutor } from "../src/domains/jobs/local-inspection-executor.js";
import { preflightScreenPdf } from "../src/domains/pdf/pdf-preflight.js";

type Json = Record<string, any>;

function png(width: number, height: number): Uint8Array {
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 2;
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
    request(path: string, options: RequestInit = {}) {
      return fetch(`http://127.0.0.1:${server.address().port}/v1${path}`, {
        ...options,
        headers: {
          "content-type": "application/json",
          "x-ipw-test-actor-id": "actor-pdf",
          "x-ipw-test-actor-name": "PDF owner",
          "x-trace-id": "trace-pdf",
          ...options.headers,
        },
      });
    },
  };
}

async function json(response: Response): Promise<Json> { return await response.json() as Json; }

test("image-to-PDF creation preserves ordered sources and queues only a ready Screen PDF", async () => {
  const server = await api();
  try {
    const bootstrap = await json(await server.request("/session/bootstrap", {
      method: "POST",
      headers: { "idempotency-key": "pdf-bootstrap" },
    }));
    const workspaceId = bootstrap.workspace.workspace_id as string;
    const accepted: string[] = [];
    for (const [index, dimensions] of [[400, 200], [100, 300]].entries()) {
      const bytes = png(dimensions[0]!, dimensions[1]!);
      const upload = await json(await server.request(`/workspaces/${workspaceId}/upload-sessions`, {
        method: "POST",
        headers: { "idempotency-key": `pdf-upload-${index}` },
        body: JSON.stringify({ display_name: `page-${index + 1}.png`, media_type: "image/png", byte_size: bytes.byteLength }),
      }));
      const uploadUrl = new URL(upload.authorization.upload_url, "http://local");
      await server.request(`${uploadUrl.pathname.replace("/v1", "")}${uploadUrl.search}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream", "upload-offset": "0" },
        body: bytes,
      });
      await server.request(`/upload-sessions/${upload.upload_session.upload_session_id}/finalise`, {
        method: "POST",
        headers: { "idempotency-key": `pdf-finalise-${index}` },
      });
      assert.equal(await server.executor.runAvailable(), true);
      const state = await json(await server.request(`/upload-sessions/${upload.upload_session.upload_session_id}`));
      accepted.push(state.upload_session.file_id as string);
    }

    const createOptions = {
      method: "POST",
      headers: { "idempotency-key": "pdf-create" },
      body: JSON.stringify({
        name: "Customer brief",
        source_file_ids: accepted,
        page_preset: "a4",
        orientation: "portrait",
        image_placement: "contain",
        language: "en-GB",
      }),
    };
    const created = await json(await server.request(`/workspaces/${workspaceId}/documents/pdf`, createOptions));
    const replay = await json(await server.request(`/workspaces/${workspaceId}/documents/pdf`, createOptions));
    const editor = created.editor;
    assert.equal(replay.replayed, true);
    assert.equal(editor.document.kind, "pdf");
    assert.equal(editor.snapshot.artboards.length, 2);
    assert.deepEqual(editor.snapshot.artboards.map((page: Json) => page.order), [0, 1]);
    assert.ok(Math.abs(editor.snapshot.artboards[0].width - 595.2756) < 0.001);
    assert.equal(editor.snapshot.pdf_settings.language, "en-GB");
    assert.equal(editor.snapshot.layers[0].transform.width, 547.2756);
    assert.equal(editor.snapshot.layers[0].transform.height, 273.6378);
    assert.equal(editor.snapshot.layers[1].transform.height, 793.8898);

    const documentId = editor.document.document_id as string;
    const copied = await json(await server.request(`/workspaces/${workspaceId}/documents/${documentId}/save-as`, {
      method: "POST",
      headers: { "idempotency-key": "pdf-save-as" },
      body: JSON.stringify({ name: "Customer brief copy" }),
    }));
    assert.equal(copied.editor.document.kind, "pdf");
    assert.equal(copied.editor.snapshot.pdf_settings.title, "Customer brief copy");
    const preflight = await json(await server.request(`/workspaces/${workspaceId}/documents/${documentId}/pdf-preflight`));
    assert.equal(preflight.preflight.state, "ready");
    assert.equal(preflight.preflight.page_count, 2);
    assert.equal(preflight.preflight.profile.tagged_pdf, false);
    assert.equal(preflight.preflight.profile.archival_conformance, null);
    assert.ok(preflight.preflight.issues.some((issue: Json) => issue.code === "screen-profile-untagged"));
    const exportOptions = { method: "POST", headers: { "idempotency-key": "pdf-export" } };
    const submitted = await json(await server.request(`/workspaces/${workspaceId}/documents/${documentId}/pdf-exports`, exportOptions));
    const exportReplay = await json(await server.request(`/workspaces/${workspaceId}/documents/${documentId}/pdf-exports`, exportOptions));
    assert.equal(submitted.pdf_export.request.state, "queued");
    assert.equal(exportReplay.replayed, true);
    assert.equal(exportReplay.pdf_export.request.pdf_export_request_id, submitted.pdf_export.request.pdf_export_request_id);

    const requestId = submitted.pdf_export.request.pdf_export_request_id as string;
    const cancelled = await json(await server.request(`/workspaces/${workspaceId}/pdf-exports/${requestId}/cancel`, {
      method: "PATCH",
      headers: { "idempotency-key": "pdf-cancel" },
    }));
    assert.equal(cancelled.pdf_export.request.state, "cancelled");
    const retried = await json(await server.request(`/workspaces/${workspaceId}/pdf-exports/${requestId}/retry`, {
      method: "POST",
      headers: { "idempotency-key": "pdf-retry" },
    }));
    assert.equal(retried.pdf_export.request.state, "queued");
    assert.notEqual(retried.pdf_export.request.job_id, submitted.pdf_export.request.job_id);
  } finally {
    await server.close();
  }
});

test("PDF creation rejects cropping placement and preflight blocks grouped rendering", async () => {
  const server = await api();
  try {
    const bootstrap = await json(await server.request("/session/bootstrap", {
      method: "POST",
      headers: { "idempotency-key": "pdf-invalid-bootstrap" },
    }));
    const workspaceId = bootstrap.workspace.workspace_id as string;
    const invalid = await server.request(`/workspaces/${workspaceId}/documents/pdf`, {
      method: "POST",
      headers: { "idempotency-key": "pdf-invalid-create" },
      body: JSON.stringify({ name: "Invalid", image_placement: "cover" }),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await json(invalid)).error.code, "pdf-image-placement-invalid");

    const created = await json(await server.request(`/workspaces/${workspaceId}/documents/pdf`, {
      method: "POST",
      headers: { "idempotency-key": "pdf-blank-create" },
      body: JSON.stringify({ name: "Blank" }),
    }));
    created.editor.snapshot.layers.push({
      layer_id: "layer-group",
      artboard_id: created.editor.snapshot.artboards[0].artboard_id,
      parent_layer_id: null,
      layer_type: "group",
      name: "Group",
      order: 0,
      visible: false,
      transform: { x: 0, y: 0, width: 10, height: 10 },
      group: { child_layer_ids: [] },
    });
    const hiddenReport = preflightScreenPdf(created.editor, "2026-09-12T00:00:00.000Z");
    assert.ok(!(hiddenReport.issues ?? []).some((issue) => issue.code === "group-layer-unsupported"));
    created.editor.snapshot.layers[0].visible = true;
    const report = preflightScreenPdf(created.editor, "2026-09-12T00:00:00.000Z");
    assert.equal(report.state, "blocked");
    assert.ok((report.issues ?? []).some((issue) => issue.code === "group-layer-unsupported" && issue.blocks_export));
    created.editor.snapshot.layers = [{
      layer_id: "layer-linked-style",
      artboard_id: created.editor.snapshot.artboards[0].artboard_id,
      parent_layer_id: null,
      layer_type: "shape",
      name: "Styled rectangle",
      order: 0,
      visible: true,
      shared_style_ids: ["style-linked"],
      transform: { x: 0, y: 0, width: 10, height: 10 },
      shape: { shape: "rectangle", fill: "#ffffff", corner_radius: 0 },
    }];
    created.editor.snapshot.shared_styles = [{
      shared_style_id: "style-linked",
      name: "Linked fill",
      kind: "fill",
      properties: { fill: "#000000" },
    }];
    const linkedStyleReport = preflightScreenPdf(created.editor, "2026-09-12T00:00:00.000Z");
    assert.ok((linkedStyleReport.issues ?? []).some(
      (issue) => issue.code === "linked-style-unsupported" && issue.blocks_export,
    ));
  } finally {
    await server.close();
  }
});
