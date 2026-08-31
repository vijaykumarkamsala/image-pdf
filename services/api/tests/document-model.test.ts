import assert from "node:assert/strict";
import test from "node:test";

import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";

import { DomainError } from "../src/kernel/errors.js";
import { DeterministicRuntimeValues } from "../src/kernel/runtime.js";
import { applyMutation, initialSnapshot, neutralAdjustments, snapshotDigest, transform } from "../src/domains/documents/document-model.js";

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
