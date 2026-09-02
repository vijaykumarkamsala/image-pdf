import assert from "node:assert/strict";
import test from "node:test";

import { Test } from "@nestjs/testing";

import { AppModule } from "../src/app.module.js";
import { ProductErrorFilter } from "../src/common/product-error.filter.js";

type Json = Record<string, any>;

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
    request(path: string, options: RequestInit = {}, actor = "actor-export") {
      return fetch(`http://127.0.0.1:${server.address().port}/v1${path}`, {
        ...options,
        headers: {
          "content-type": "application/json",
          "x-ipw-test-actor-id": actor,
          "x-ipw-test-actor-name": "Export owner",
          "x-trace-id": `trace-${actor}`,
          ...options.headers,
        },
      });
    },
  };
}

async function json(response: Response): Promise<Json> { return await response.json() as Json; }

test("recipes, safe recommendations, proxy comparison and durable image export are real API journeys", async () => {
  const server = await api();
  try {
    const bootstrap = await json(await server.request("/session/bootstrap", {
      method: "POST", headers: { "idempotency-key": "export-bootstrap" },
    }));
    const workspaceId = bootstrap.workspace.workspace_id as string;
    const created = await json(await server.request(`/workspaces/${workspaceId}/documents`, {
      method: "POST", headers: { "idempotency-key": "export-document" },
      body: JSON.stringify({ name: "Launch graphic", width: 640, height: 360, intended_use: "digital" }),
    }));
    const documentId = created.editor.document.document_id as string;
    const versionId = created.editor.document.current_version_id as string;
    const artboardId = created.editor.snapshot.artboards[0].artboard_id as string;
    const operations = [{
      operation_id: "operation-brightness", kind: "exposure_brightness", order: 0,
      enabled: true, parameters: { exposure_ev: 0.25, brightness: 5 },
    }, {
      operation_id: "operation-upscale", kind: "resampling_scale", order: 1,
      enabled: false, parameters: { scale: 2, algorithm: "lanczos" },
    }];
    const recipeOptions = {
      method: "POST",
      headers: { "idempotency-key": "export-recipe" },
      body: JSON.stringify({ name: "Digital clean-up", operations }),
    };
    const saved = await json(await server.request(`/workspaces/${workspaceId}/documents/${documentId}/recipes`, recipeOptions));
    const replay = await json(await server.request(`/workspaces/${workspaceId}/documents/${documentId}/recipes`, recipeOptions));
    assert.equal(saved.recipe.operations[1].parameters.label, "Standard resampling (not AI reconstruction)");
    assert.equal(replay.replayed, true);
    assert.equal(replay.recipe.recipe_id, saved.recipe.recipe_id);

    const recommendations = await json(await server.request(`/workspaces/${workspaceId}/documents/${documentId}/recommendations`, {
      method: "POST", headers: { "idempotency-key": "export-recommendations" },
      body: JSON.stringify({ document_version_id: versionId, intended_outcome: "digital" }),
    }));
    assert.equal(recommendations.recommendation_set.no_correction_needed, true);
    assert.deepEqual(recommendations.recommendation_set.recommendations, []);

    const preview = await json(await server.request(`/workspaces/${workspaceId}/documents/${documentId}/enhancement-previews`, {
      method: "POST",
      body: JSON.stringify({ recipe_id: saved.recipe.recipe_id, recipe_version: 1, mode: "split" }),
    }));
    assert.equal(preview.preview.proxy, true);
    assert.equal(preview.preview.quality_label, "Interactive proxy; final output is rendered by a durable worker");

    const profile = {
      profile_id: "profile-web", name: "Web PNG", purpose: "web", format: "png",
      width: 320, height: 180, alpha_behavior: "preserve", bit_depth: 8,
      metadata_policy: {}, collision_behavior: "suffix",
    };
    const exportOptions = {
      method: "POST",
      headers: { "idempotency-key": "export-submit" },
      body: JSON.stringify({
        document_version_id: versionId, recipe_id: saved.recipe.recipe_id, recipe_version: 1,
        outputs: [
          { artboard_id: artboardId, filename: "launch", profile },
          { artboard_id: artboardId, filename: "launch", profile: { ...profile, profile_id: "profile-web-copy" } },
        ],
      }),
    };
    const submitted = await json(await server.request(`/workspaces/${workspaceId}/documents/${documentId}/exports`, exportOptions));
    const submittedReplay = await json(await server.request(`/workspaces/${workspaceId}/documents/${documentId}/exports`, exportOptions));
    assert.equal(submitted.export_request.zero_charge, true);
    assert.deepEqual(submitted.export_request.outputs.map((item: Json) => item.filename), ["launch.png", "launch-2.png"]);
    assert.equal(submittedReplay.replayed, true);
    assert.equal(submittedReplay.export_request.job_id, submitted.export_request.job_id);

    const listed = await json(await server.request(`/workspaces/${workspaceId}/exports?document_id=${documentId}`));
    assert.equal(listed.exports.length, 1);
    const cancelOptions = { method: "POST", headers: { "idempotency-key": "export-cancel" } };
    const cancelled = await json(await server.request(`/workspaces/${workspaceId}/exports/${submitted.export_request.export_request_id}/cancel`, cancelOptions));
    const cancelReplay = await json(await server.request(`/workspaces/${workspaceId}/exports/${submitted.export_request.export_request_id}/cancel`, cancelOptions));
    assert.equal(cancelled.export_request.state, "cancelled");
    assert.equal(cancelReplay.replayed, true);

    const unsafe = await server.request(`/workspaces/${workspaceId}/documents/${documentId}/exports`, {
      method: "POST", headers: { "idempotency-key": "export-unsafe" },
      body: JSON.stringify({
        document_version_id: versionId, recipe_id: saved.recipe.recipe_id, recipe_version: 1,
        outputs: [{ artboard_id: artboardId, filename: "wrong.avif", profile: { ...profile, format: "avif" } }],
      }),
    });
    assert.equal(unsafe.status, 400);
    assert.equal((await json(unsafe)).error.code, "enhancement-input-invalid");
  } finally {
    await server.close();
  }
});
