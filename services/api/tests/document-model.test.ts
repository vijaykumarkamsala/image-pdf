import assert from "node:assert/strict";
import test from "node:test";

import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";

import { DomainError } from "../src/kernel/errors.js";
import { requiresGeneratedPreview, STUDIO_EDITABLE_MEDIA_TYPES, STUDIO_SYNC_PREVIEW_POLICY } from "../src/domains/documents/studio-format-policy.js";
import type { CommandContext } from "../src/kernel/product.types.js";
import { DeterministicRuntimeValues } from "../src/kernel/runtime.js";
import { applyMutation, initialSnapshot, neutralAdjustments, snapshotDigest, transform } from "../src/domains/documents/document-model.js";
import { MemoryDocumentRepository } from "../src/domains/documents/memory-document.repository.js";

function context(actorId: string, key: string): CommandContext {
  return {
    principal: { actorId, displayName: actorId },
    idempotencyKey: key,
    traceId: `trace-${key}`,
    requestHash: `request-${key}`,
  };
}

test("native document mutations are non-destructive, deterministic and revisioned", () => {
  const runtime = new DeterministicRuntimeValues();
  const original = initialSnapshot(runtime, "document-model", {
    workspaceId: "workspace-model",
    defaultFilesId: "default-model",
    name: "Model proof",
    intendedUse: "digital",
    intendedUseLabel: "Digital design",
  });
  const layerId = "layer-shape";
  const next = applyMutation(original, {
    schema_version: PRODUCT_SCHEMA_VERSION,
    kind: "layer.add",
    target_id: layerId,
    layer: {
      schema_version: PRODUCT_SCHEMA_VERSION,
      layer_id: layerId,
      artboard_id: original.artboards[0].artboard_id,
      parent_layer_id: null,
      layer_type: "shape",
      name: "Blue rectangle",
      order: 0,
      visible: true,
      locked: false,
      opacity: 1,
      blend_mode: "normal",
      transform: transform(20, 30, 240, 120),
      shared_style_ids: [],
      raster: null,
      vector: null,
      rich_text: null,
      shape: { schema_version: PRODUCT_SCHEMA_VERSION, shape: "rectangle", fill: "#3559e0", stroke: null, stroke_width: 0, corner_radius: 8 },
      group: null,
      extension_payload: {},
    },
    properties: {},
  });
  assert.equal(original.layers?.length, 0);
  assert.equal(next.layers?.length, 1);
  assert.equal(next.revision, 1);
  assert.equal(snapshotDigest(next), snapshotDigest(structuredClone(next)));

  assert.throws(
    () => applyMutation(next, {
      schema_version: PRODUCT_SCHEMA_VERSION,
      kind: "layer.update",
      target_id: layerId,
      adjustments: neutralAdjustments(),
      properties: {},
    }),
    (error: unknown) => error instanceof DomainError && error.code === "document-mutation-invalid",
  );
});

test("locked layers and invalid nesting fail closed", () => {
  const runtime = new DeterministicRuntimeValues();
  const original = initialSnapshot(runtime, "document-lock", {
    workspaceId: "workspace-lock",
    defaultFilesId: "default-lock",
    name: "Lock proof",
    intendedUse: "digital",
    intendedUseLabel: "Digital design",
  });
  const layer = {
    schema_version: PRODUCT_SCHEMA_VERSION,
    layer_id: "layer-locked",
    artboard_id: original.artboards[0].artboard_id,
    parent_layer_id: null,
    layer_type: "shape" as const,
    name: "Locked",
    order: 0,
    visible: true,
    locked: true,
    opacity: 1,
    blend_mode: "normal",
    transform: transform(0, 0, 10, 10),
    shared_style_ids: [],
    raster: null,
    vector: null,
    rich_text: null,
    shape: { schema_version: PRODUCT_SCHEMA_VERSION, shape: "rectangle" as const, fill: "#000000", stroke: null, stroke_width: 0, corner_radius: 0 },
    group: null,
    extension_payload: {},
  };
  const withLayer = applyMutation(original, { schema_version: PRODUCT_SCHEMA_VERSION, kind: "layer.add", layer, properties: {} });
  assert.throws(
    () => applyMutation(withLayer, { schema_version: PRODUCT_SCHEMA_VERSION, kind: "layer.update", target_id: layer.layer_id, transform: transform(2, 2, 10, 10), properties: {} }),
    (error: unknown) => error instanceof DomainError && error.code === "layer-locked",
  );
});

test("malformed transforms, crops and cyclic nesting fail at the native document boundary", () => {
  const runtime = new DeterministicRuntimeValues();
  const original = initialSnapshot(runtime, "document-validation", {
    workspaceId: "workspace-validation",
    defaultFilesId: "default-validation",
    name: "Validation proof",
    intendedUse: "source",
    intendedUseLabel: "Source size",
    source: {
      fileId: "file-validation",
      displayName: "validation.png",
      assetOriginalId: "asset-validation",
      sourceVersionId: "source-validation",
      objectReferenceId: null,
      mediaType: "image/png",
      width: 100,
      height: 80,
      byteSize: 1024,
      requiresPreview: false,
    },
  });
  const raster = original.layers![0]!;
  assert.throws(
    () => applyMutation(original, {
      kind: "layer.update",
      target_id: raster.layer_id,
      transform: { ...raster.transform, width: 0 },
      properties: {},
    }),
    (error: unknown) => error instanceof DomainError && error.code === "document-mutation-invalid",
  );
  assert.throws(
    () => applyMutation(original, {
      kind: "layer.update",
      target_id: raster.layer_id,
      crop: { left: 0.8, top: 0, right: 0.2, bottom: 1 },
      properties: {},
    }),
    (error: unknown) => error instanceof DomainError && error.code === "document-mutation-invalid",
  );

  const withoutMaskArray = structuredClone(original);
  delete withoutMaskArray.layers![0]!.raster!.mask_ids;
  const masked = applyMutation(withoutMaskArray, {
    kind: "mask.update",
    target_id: raster.layer_id,
    mask: {
      mask_id: "mask-validation",
      artboard_id: original.artboards[0].artboard_id,
      name: "Safe mask",
      kind: "shape",
      enabled: true,
      inverted: false,
      feather: 0,
      path_data: "rect(0,0,1,1)",
      object_reference_id: null,
    },
    properties: {},
  });
  assert.deepEqual(masked.layers![0]!.raster!.mask_ids, ["mask-validation"]);

  const group = (id: string, order: number) => ({
    layer_id: id,
    artboard_id: original.artboards[0].artboard_id,
    parent_layer_id: null,
    layer_type: "group" as const,
    name: id,
    order,
    visible: true,
    locked: false,
    opacity: 1,
    blend_mode: "normal",
    transform: transform(0, 0, 1, 1),
    shared_style_ids: [],
    raster: null,
    vector: null,
    rich_text: null,
    shape: null,
    group: { collapsed: false },
    extension_payload: {},
  });
  let grouped = applyMutation(original, { kind: "layer.add", layer: group("group-a", 1), properties: {} });
  grouped = applyMutation(grouped, { kind: "layer.add", layer: group("group-b", 2), properties: {} });
  grouped = applyMutation(grouped, { kind: "layer.reorder", target_id: "group-a", properties: { parent_layer_id: "group-b" } });
  assert.throws(
    () => applyMutation(grouped, { kind: "layer.reorder", target_id: "group-b", properties: { parent_layer_id: "group-a" } }),
    (error: unknown) => error instanceof DomainError && error.code === "document-mutation-invalid",
  );
});

test("ordering, grouping, linked styles and unit conversion remain deterministic", () => {
  const runtime = new DeterministicRuntimeValues();
  let snapshot = initialSnapshot(runtime, "document-semantics", {
    workspaceId: "workspace-semantics",
    defaultFilesId: "default-semantics",
    name: "Semantic proof",
    intendedUse: "digital",
    intendedUseLabel: "Digital design",
  });
  const artboardId = snapshot.artboards[0].artboard_id;
  const shape = (id: string, order: number, x: number, fill: string) => ({
    layer_id: id,
    artboard_id: artboardId,
    parent_layer_id: null,
    layer_type: "shape" as const,
    name: id,
    order,
    visible: true,
    locked: false,
    opacity: 1,
    blend_mode: "normal",
    transform: transform(x, 20, 100, 80),
    shared_style_ids: [],
    raster: null,
    vector: null,
    rich_text: null,
    shape: { shape: "rectangle" as const, fill, stroke: null, stroke_width: 0, corner_radius: 0, points: [] },
    group: null,
    extension_payload: {},
  });
  snapshot = applyMutation(snapshot, { kind: "layer.add", layer: shape("layer-a", 0, 20, "#111111"), properties: {} });
  snapshot = applyMutation(snapshot, { kind: "layer.add", layer: shape("layer-b", 1, 140, "#222222"), properties: {} });
  snapshot = applyMutation(snapshot, { kind: "layer.add", layer: shape("layer-c", 2, 260, "#333333"), properties: {} });
  snapshot = applyMutation(snapshot, { kind: "layer.reorder", target_id: "layer-a", properties: { order: 2 } });
  assert.deepEqual(snapshot.layers!.filter((item) => !item.parent_layer_id).sort((a, b) => a.order - b.order).map((item) => item.layer_id), ["layer-b", "layer-c", "layer-a"]);

  snapshot = applyMutation(snapshot, {
    kind: "layer.group",
    target_id: "group-semantic",
    target_ids: ["layer-b", "layer-c"],
    layer: {
      layer_id: "group-semantic", artboard_id: artboardId, parent_layer_id: null, layer_type: "group", name: "Semantic group", order: 0,
      visible: true, locked: false, opacity: 1, blend_mode: "normal", transform: transform(0, 0, 1, 1), shared_style_ids: [],
      raster: null, vector: null, rich_text: null, shape: null, group: { collapsed: false }, extension_payload: {},
    },
    properties: {},
  });
  assert.deepEqual(snapshot.layers!.filter((item) => item.parent_layer_id === "group-semantic").sort((a, b) => a.order - b.order).map((item) => item.layer_id), ["layer-b", "layer-c"]);
  assert.deepEqual(snapshot.layers!.filter((item) => !item.parent_layer_id).sort((a, b) => a.order - b.order).map((item) => item.layer_id), ["group-semantic", "layer-a"]);

  snapshot = applyMutation(snapshot, {
    kind: "style.upsert",
    target_ids: ["layer-b", "layer-c"],
    shared_style: { shared_style_id: "style-semantic", name: "Shared blue", kind: "fill", properties: { fill: "#0055aa" } },
    properties: {},
  });
  assert.ok(snapshot.layers!.filter((item) => item.parent_layer_id === "group-semantic").every((item) => item.shared_style_ids?.includes("style-semantic")));
  snapshot = applyMutation(snapshot, { kind: "style.detach", target_id: "style-semantic", target_ids: ["layer-b"], properties: {} });
  assert.equal(snapshot.layers!.find((item) => item.layer_id === "layer-b")!.shape!.fill, "#0055aa");
  assert.equal(snapshot.layers!.find((item) => item.layer_id === "layer-c")!.shared_style_ids![0], "style-semantic");

  snapshot = applyMutation(snapshot, { kind: "layer.ungroup", target_id: "group-semantic", properties: {} });
  assert.equal(snapshot.layers!.some((item) => item.layer_id === "group-semantic"), false);
  assert.ok(snapshot.layers!.every((item) => item.parent_layer_id === null));
  assert.deepEqual(snapshot.layers!.sort((a, b) => a.order - b.order).map((item) => item.order), [0, 1, 2]);

  const beforeWidth = snapshot.layers![0]!.transform.width;
  const artboard = snapshot.artboards[0];
  snapshot = applyMutation(snapshot, {
    kind: "artboard.update",
    target_id: artboard.artboard_id,
    artboard: { ...artboard, width: artboard.width / 96, height: artboard.height / 96, unit: "in", orientation: "landscape" },
    properties: {},
  });
  assert.ok(Math.abs(snapshot.layers![0]!.transform.width - beforeWidth / 96) < 1e-12);
});

test("Studio format and synchronous preview limits are central, measured and fail closed", () => {
  assert.deepEqual([...STUDIO_EDITABLE_MEDIA_TYPES].sort(), ["image/jpeg", "image/png", "image/webp"]);
  assert.equal(requiresGeneratedPreview({
    byteSize: STUDIO_SYNC_PREVIEW_POLICY.maxCompressedBytes,
    width: 4000,
    height: 3000,
  }), false);
  assert.equal(requiresGeneratedPreview({
    byteSize: STUDIO_SYNC_PREVIEW_POLICY.maxCompressedBytes + 1,
    width: 4000,
    height: 3000,
  }), true);
  assert.equal(requiresGeneratedPreview({ byteSize: 1024, width: 9000, height: 100 }), true);
  assert.equal(requiresGeneratedPreview({ byteSize: 1024, width: 6000, height: 5000 }), true);
  assert.equal(requiresGeneratedPreview({ byteSize: 1024, width: null, height: null }), true);
});

test("autosave checkpoints, bounded history and lease takeover remain deterministic", async () => {
  const runtime = new DeterministicRuntimeValues();
  const repository = new MemoryDocumentRepository(runtime);
  const created = await repository.create(context("actor-owner", "create-history"), {
    workspaceId: "workspace-history",
    defaultFilesId: "default-history",
    name: "History proof",
    intendedUse: "digital",
    intendedUseLabel: "Digital design",
  });
  const documentId = created.value.document.document_id;
  const originalLease = await repository.acquireLease(context("actor-owner", "lease-owner"), "workspace-history", documentId);
  const originalLeaseHash = (await import("../src/domains/documents/document-model.js")).sha256(originalLease.lease_token);
  await assert.rejects(
    repository.acquireLease(context("actor-peer", "lease-peer"), "workspace-history", documentId),
    (error: unknown) => error instanceof DomainError && error.code === "document-lease-held",
  );
  assert.equal((await repository.requestTakeover(
    context("actor-peer", "takeover-request"), "workspace-history", documentId, "Please let me continue",
  )).status, "requested");
  const requested = await repository.leaseStatus("actor-owner", "workspace-history", documentId, originalLeaseHash);
  assert.equal(requested.takeoverRequest?.actorId, "actor-peer");
  await repository.denyTakeover(
    context("actor-owner", "takeover-deny"), "workspace-history", documentId, originalLeaseHash, "Finishing a saved edit",
  );
  assert.equal((await repository.leaseStatus("actor-owner", "workspace-history", documentId, originalLeaseHash)).takeoverRequest, null);
  await repository.requestTakeover(
    context("actor-peer", "takeover-request-again"), "workspace-history", documentId, "Please let me continue",
  );
  const forced = await repository.forceTakeover(
    context("actor-peer", "takeover-force"), "workspace-history", documentId, "Owner recovery",
  );
  assert.equal(forced.status, "acquired");

  const replacement = forced.grant!;
  const replacementHash = (await import("../src/domains/documents/document-model.js")).sha256(replacement.lease_token);
  let revision = 0;
  for (let index = 1; index <= 101; index += 1) {
    const result = await repository.mutate(context("actor-peer", `mutation-${index}`), {
      workspaceId: "workspace-history",
      documentId,
      baseRevision: revision,
      leaseTokenHash: replacementHash,
      mutation: { kind: "document.rename", properties: {} },
    });
    revision = result.snapshot.revision;
    assert.equal(Boolean(result.checkpoint), index % 10 === 0);
  }
  for (let index = 0; index < 100; index += 1) {
    const result = await repository.undo(context("actor-peer", `undo-${index}`), "workspace-history", documentId, replacementHash);
    if (index === 99) assert.equal(result.value.canUndo, false);
  }
  await assert.rejects(
    repository.undo(context("actor-peer", "undo-beyond-window"), "workspace-history", documentId, replacementHash),
    (error: unknown) => error instanceof DomainError && error.code === "document-history-start",
  );
  assert.notEqual(originalLeaseHash, replacementHash);
});
