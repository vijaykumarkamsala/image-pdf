import assert from "node:assert/strict";
import test from "node:test";
import type { EditorDocumentSnapshot, LayerRecord } from "ipw-contracts-ts/product";

import { applyOptimisticMutation, replayPendingMutations } from "../src/editor/nativeOperations.ts";

const artboard = {
  artboard_id: "artboard-one",
  name: "Artboard 1",
  order: 0,
  width: 800,
  height: 600,
  unit: "px" as const,
  orientation: "landscape" as const,
  background: { kind: "solid" as const, color: "#ffffff" },
  intended_use: { kind: "digital" as const, label: "Digital", attributes: {} },
};

function shape(id: string, parent: string | null, order: number): LayerRecord {
  return {
    layer_id: id,
    artboard_id: artboard.artboard_id,
    parent_layer_id: parent,
    layer_type: "shape",
    name: id,
    order,
    visible: true,
    locked: false,
    opacity: 1,
    blend_mode: "normal",
    transform: {
      x: 10, y: 10, width: 100, height: 80, rotation_degrees: 0,
      scale_x: 1, scale_y: 1, skew_x_degrees: 0, skew_y_degrees: 0,
      flip_x: false, flip_y: false,
    },
    shared_style_ids: [],
    raster: null,
    vector: null,
    rich_text: null,
    shape: { shape: "rectangle", fill: "#3559e0", stroke: null, stroke_width: 0, corner_radius: 0 },
    group: null,
    extension_payload: {},
  };
}

function snapshot(): EditorDocumentSnapshot {
  return {
    document_id: "document-editor",
    revision: 0,
    artboards: [artboard],
    layers: [],
    masks: [],
    shared_assets: [],
    shared_styles: [],
    variants: [],
  };
}

test("pending native operations replay in strict base-revision order", () => {
  const first = shape("layer-one", null, 0);
  const next = replayPendingMutations(snapshot(), [
    { baseRevision: 0, mutation: { kind: "layer.add", target_id: first.layer_id, layer: first, properties: {} } },
    { baseRevision: 1, mutation: { kind: "layer.update", target_id: first.layer_id, transform: { ...first.transform, x: 42 }, properties: {} } },
  ]);
  assert.equal(next.revision, 2);
  assert.equal(next.layers?.[0]?.transform.x, 42);
  assert.throws(
    () => replayPendingMutations(snapshot(), [{ baseRevision: 9, mutation: { kind: "document.rename", properties: {} } }]),
    /no longer share/,
  );
});

test("optimistic group removal removes descendants without touching the server source", () => {
  const group: LayerRecord = { ...shape("group", null, 0), layer_type: "group", shape: null, group: { collapsed: false } };
  const child = shape("child", group.layer_id, 0);
  const current = { ...snapshot(), layers: [group, child] };
  const next = applyOptimisticMutation(current, { kind: "layer.remove", target_id: group.layer_id, properties: {} });
  assert.deepEqual(next.layers, []);
  assert.equal(current.layers.length, 2);
});
