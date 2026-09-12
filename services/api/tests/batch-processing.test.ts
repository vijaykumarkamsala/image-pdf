import assert from "node:assert/strict";
import test from "node:test";

import { Test } from "@nestjs/testing";
import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import type { ExportOutputProfile, ImageOperation } from "ipw-contracts-ts/product";

import { AppModule } from "../src/app.module.js";
import { ProductErrorFilter } from "../src/common/product-error.filter.js";
import { MemoryImageExportRepository } from "../src/domains/exports/memory-image-export.repository.js";
import { requireBatchPlanInput } from "../src/domains/exports/batch-validation.js";
import type { BatchPlanInput } from "../src/domains/exports/exports.types.js";
import { DomainError } from "../src/kernel/errors.js";
import type { CommandContext } from "../src/kernel/product.types.js";
import { DeterministicRuntimeValues, requestDigest } from "../src/kernel/runtime.js";

type Json = Record<string, any>;

const profile: ExportOutputProfile = {
  schema_version: PRODUCT_SCHEMA_VERSION,
  profile_id: "profile-batch-web",
  name: "Batch web PNG",
  purpose: "web",
  format: "png",
  width: 320,
  height: 180,
  percentage: null,
  physical_width: null,
  physical_height: null,
  physical_unit: null,
  ppi: null,
  fit: "contain",
  quality: null,
  lossless: true,
  resampling_algorithm: "lanczos",
  colour_profile: "srgb",
  bit_depth: 8,
  alpha_behavior: "preserve",
  background: null,
  metadata_policy: {
    schema_version: PRODUCT_SCHEMA_VERSION,
    preserve_copyright: true,
    preserve_description: false,
    preserve_capture_time: false,
    preserve_camera: false,
    preserve_location: false,
    remove_embedded_thumbnails: true,
  },
  chroma_subsampling: null,
  filename_template: "{document}-{artboard}-{profile}",
  collision_behavior: "suffix",
};

function command(actorId: string, idempotencyKey: string, name: string, payload: unknown): CommandContext {
  return {
    principal: { actorId, displayName: "Batch owner" },
    idempotencyKey,
    traceId: `trace-${idempotencyKey}`,
    requestHash: requestDigest({ command: name, payload }),
  };
}

async function localApi() {
  process.env["NODE_ENV"] = "test";
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix("v1");
  app.useGlobalFilters(new ProductErrorFilter());
  await app.listen(0, "127.0.0.1");
  const server = app.getHttpServer() as { address(): { port: number } };
  return {
    close: () => app.close(),
    request(path: string, options: RequestInit = {}, actor = "actor-batch") {
      return fetch(`http://127.0.0.1:${server.address().port}/v1${path}`, {
        ...options,
        headers: {
          "content-type": "application/json",
          "x-ipw-test-actor-id": actor,
          "x-ipw-test-actor-name": "Batch owner",
          "x-trace-id": `trace-${actor}`,
          ...options.headers,
        },
      });
    },
  };
}

async function json(response: Response): Promise<Json> {
  return await response.json() as Json;
}

test("durable batch aggregate accepts 1, 10 and 50 independent items without multiplying groups", async () => {
  for (const count of [1, 10, 50]) {
    const repository = new MemoryImageExportRepository(new DeterministicRuntimeValues());
    const items: BatchPlanInput["items"] = [];
    for (let index = 0; index < count; index += 1) {
      const documentId = `document-${count}-${index}`;
      const recipeInput = {
        workspaceId: "workspace-batch",
        documentId,
        name: "Standard web output",
        operations: [] as ImageOperation[],
      };
      const saved = await repository.createRecipe(
        command("actor-batch", `recipe-${count}-${index}`, "recipe.save", recipeInput),
        recipeInput,
      );
      items.push({
        clientItemId: `item-${count}-${index}`,
        displayName: `Image ${index + 1}`,
        documentId,
        documentVersionId: `version-${count}-${index}`,
        recipeId: saved.value.recipe_id,
        recipeVersion: saved.value.version,
        outputs: [{ artboardId: `artboard-${count}-${index}`, profile, filename: `image-${index + 1}.png` }],
        included: true,
        exclusionReason: null,
      });
    }
    const input = { workspaceId: "workspace-batch", name: `${count}-file batch`, items };
    const plan = await repository.planBatch("actor-batch", input);
    assert.equal(plan.items.length, count);
    assert.equal(plan.groups.length, 1);
    const createInput = {
      ...input,
      planSha256: plan.plan_sha256,
      groupApprovals: plan.groups.map((group) => ({
        schema_version: PRODUCT_SCHEMA_VERSION,
        group_id: group.group_id,
        representative_client_item_id: group.representative_client_item_id,
        representative_preview_id: `preview-${count}`,
        confirmation_state: "confirmed" as const,
      })),
      confirmedClientItemIds: [],
    };
    const submitted = await repository.submitBatch(
      command("actor-batch", `submit-${count}`, "batch.submit", createInput),
      createInput,
    );
    assert.equal(submitted.value.item_count, count);
    assert.equal(submitted.value.queued_count, count);
    assert.equal(new Set(submitted.value.items.map((item) => item.job_id)).size, count);
    const cancelled = await repository.cancelBatch(
      command("actor-batch", `cancel-${count}`, "batch.cancel", { batchId: submitted.value.batch_id }),
      "workspace-batch",
      submitted.value.batch_id,
    );
    assert.equal(cancelled.value.cancelled_count, count);
    assert.equal(cancelled.value.state, "cancelled");
    assert.equal((await repository.batchReport("actor-batch", "workspace-batch", submitted.value.batch_id))?.item_count, count);
  }
});

test("batch HTTP journey is reviewed, replay-safe, reportable and tenant isolated", async () => {
  const server = await localApi();
  try {
    const bootstrap = await json(await server.request("/session/bootstrap", {
      method: "POST",
      headers: { "idempotency-key": "batch-bootstrap" },
    }));
    const workspaceId = String(bootstrap.workspace.workspace_id);
    const created = await json(await server.request(`/workspaces/${workspaceId}/documents`, {
      method: "POST",
      headers: { "idempotency-key": "batch-document" },
      body: JSON.stringify({ name: "Campaign hero", width: 640, height: 360, intended_use: "digital" }),
    }));
    const documentId = String(created.editor.document.document_id);
    const recipe = await json(await server.request(`/workspaces/${workspaceId}/documents/${documentId}/recipes`, {
      method: "POST",
      headers: { "idempotency-key": "batch-recipe" },
      body: JSON.stringify({ name: "Standard output", operations: [] }),
    }));
    const body = {
      name: "Campaign launch",
      items: [{
        client_item_id: "campaign-hero",
        display_name: "Campaign hero",
        document_id: documentId,
        document_version_id: created.editor.document.current_version_id,
        recipe_id: recipe.recipe.recipe_id,
        recipe_version: recipe.recipe.version,
        outputs: [{
          artboard_id: created.editor.snapshot.artboards[0].artboard_id,
          filename: "campaign-hero",
          profile,
        }],
        included: true,
      }],
    };
    const planned = await json(await server.request(`/workspaces/${workspaceId}/batches/plan`, {
      method: "POST",
      body: JSON.stringify(body),
    }));
    assert.equal(planned.plan.included_count, 1);
    const submission = {
      ...body,
      plan_sha256: planned.plan.plan_sha256,
      group_approvals: planned.plan.groups.map((group: Json) => ({
        group_id: group.group_id,
        representative_client_item_id: group.representative_client_item_id,
        representative_preview_id: "preview-reviewed",
        confirmation_state: "confirmed",
      })),
      confirmed_client_item_ids: [],
    };
    const options = {
      method: "POST",
      headers: { "idempotency-key": "batch-submit" },
      body: JSON.stringify(submission),
    };
    const submitted = await json(await server.request(`/workspaces/${workspaceId}/batches`, options));
    const replay = await json(await server.request(`/workspaces/${workspaceId}/batches`, options));
    assert.equal(submitted.batch.zero_charge, true);
    assert.equal(replay.replayed, true);
    assert.equal(replay.batch.batch_id, submitted.batch.batch_id);

    const listed = await json(await server.request(`/workspaces/${workspaceId}/batches`));
    assert.equal(listed.batches.length, 1);
    const report = await json(await server.request(
      `/workspaces/${workspaceId}/batches/${submitted.batch.batch_id}/report`,
    ));
    assert.equal(report.report.items[0].display_name, "Campaign hero");
    assert.equal(report.report.groups.length, 1);
    assert.equal(report.report.groups[0].item_count, 1);
    assert.equal(report.report.groups[0].queued_count, 1);
    assert.doesNotMatch(JSON.stringify(report), /object_key|storage_generation|token|secret/i);

    await server.request("/session/bootstrap", {
      method: "POST",
      headers: { "idempotency-key": "batch-outsider-bootstrap" },
    }, "actor-batch-outsider");
    const isolated = await server.request(
      `/workspaces/${workspaceId}/batches/${submitted.batch.batch_id}`,
      {},
      "actor-batch-outsider",
    );
    assert.equal(isolated.status, 404);
  } finally {
    await server.close();
  }
});

test("changed plans and incomplete representative approvals fail closed", async () => {
  const repository = new MemoryImageExportRepository(new DeterministicRuntimeValues());
  const recipeInput = { workspaceId: "workspace-plan", documentId: "document-plan", name: "Plan", operations: [] };
  const recipe = await repository.createRecipe(command("actor-plan", "recipe-plan", "recipe.save", recipeInput), recipeInput);
  const input = {
    workspaceId: "workspace-plan",
    name: "Reviewed plan",
    items: [{
      clientItemId: "item-plan",
      displayName: "Plan image",
      documentId: "document-plan",
      documentVersionId: "version-plan",
      recipeId: recipe.value.recipe_id,
      recipeVersion: recipe.value.version,
      outputs: [{ artboardId: "artboard-plan", profile, filename: "plan.png" }],
      included: true,
      exclusionReason: null,
    }],
  };
  const plan = await repository.planBatch("actor-plan", input);
  await assert.rejects(
    repository.submitBatch(command("actor-plan", "changed-plan", "batch.submit", input), {
      ...input,
      planSha256: "0".repeat(64),
      groupApprovals: [],
      confirmedClientItemIds: [],
    }),
    (error: unknown) => (error as { code?: string }).code === "batch-plan-changed",
  );
  await assert.rejects(
    repository.submitBatch(command("actor-plan", "missing-approval", "batch.submit", input), {
      ...input,
      planSha256: plan.plan_sha256,
      groupApprovals: [],
      confirmedClientItemIds: [],
    }),
    (error: unknown) => (error as { code?: string }).code === "batch-approval-incomplete",
  );
});

test("batch input rejects duplicate document versions and aggregate output amplification", () => {
  const rawItem = (index: number, outputCount = 1) => ({
    client_item_id: `item-${index}`,
    display_name: `Image ${index}`,
    document_id: `document-${index}`,
    document_version_id: `version-${index}`,
    recipe_id: `recipe-${index}`,
    recipe_version: 1,
    included: true,
    outputs: Array.from({ length: outputCount }, (_, outputIndex) => ({
      artboard_id: `artboard-${index}`,
      filename: `image-${index}-${outputIndex}.png`,
      profile,
    })),
  });
  const duplicated = rawItem(2);
  duplicated.document_id = "document-1";
  duplicated.document_version_id = "version-1";
  assert.throws(
    () => requireBatchPlanInput({ name: "Duplicate version", items: [rawItem(1), duplicated] }, "workspace-batch"),
    (error: unknown) => error instanceof DomainError && error.code === "batch-input-invalid"
      && /document version may appear only once/i.test(error.message),
  );
  assert.throws(
    () => requireBatchPlanInput({
      name: "Output amplification",
      items: Array.from({ length: 5 }, (_, index) => rawItem(index, 41)),
    }, "workspace-batch"),
    (error: unknown) => error instanceof DomainError && error.code === "batch-input-invalid"
      && /at most 200 outputs/i.test(error.message),
  );
});
