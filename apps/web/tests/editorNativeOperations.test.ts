import assert from "node:assert/strict";
import test from "node:test";

import type { EditorDocumentSnapshot, LayerRecord } from "ipw-contracts-ts/product";

import { applyOptimisticMutation } from "../src/editor/nativeOperations.ts";

function layer(id: string, order: number, x: number): LayerRecord {
  return {
    layer_id: id,
    artboard_id: "artboard-native",
    parent_layer_id: null,
    layer_type: "shape",
    name: id,
    order,
    visible: true,
    locked: false,
    opacity: 1,
    blend_mode: "normal",
    transform: { x, y: 20, width: 100, height: 60, rotation_degrees: 0, scale_x: 1, scale_y: 1, skew_x_degrees: 0, skew_y_degrees: 0, flip_x: false, flip_y: false },
    shared_style_ids: [],
    raster: null,
    vector: null,
    rich_text: null,
    shape: { shape: "rectangle", fill: "#3559e0", stroke: null, stroke_width: 0, corner_radius: 0, points: [] },
    group: null,
    extension_payload: {},
  };
}

function snapshot(): EditorDocumentSnapshot {
  return {
    document_id: "document-native",
    revision: 0,
    artboards: [{
      artboard_id: "artboard-native", name: "Artboard", order: 0, width: 1200, height: 800, unit: "px", orientation: "landscape",
      background: { kind: "solid", color: "#ffffff" }, intended_use: { kind: "digital", label: "Digital", attributes: {} },
    }],
    layers: [layer("layer-a", 0, 20), layer("layer-b", 1, 140), layer("layer-c", 2, 260)],
    masks: [], shared_assets: [], shared_styles: [], variants: [],
  };
}

test("optimistic ordering and grouping mirror deterministic native semantics", () => {
  let current = applyOptimisticMutation(snapshot(), { kind: "layer.reorder", target_id: "layer-a", properties: { order: 2 } });
  assert.deepEqual(current.layers!.sort((a, b) => a.order - b.order).map((item) => item.layer_id), ["layer-b", "layer-c", "layer-a"]);
  current = applyOptimisticMutation(current, {
    kind: "layer.group",
    target_ids: ["layer-b", "layer-c"],
    layer: {
      layer_id: "group-native", artboard_id: "artboard-native", parent_layer_id: null, layer_type: "group", name: "Group", order: 0,
      visible: true, locked: false, opacity: 1, blend_mode: "normal",
      transform: { x: 0, y: 0, width: 1, height: 1 }, shared_style_ids: [], raster: null, vector: null, rich_text: null, shape: null,
      group: { collapsed: false }, extension_payload: {},
    },
    properties: {},
  });
  assert.deepEqual(current.layers!.filter((item) => item.parent_layer_id === "group-native").sort((a, b) => a.order - b.order).map((item) => item.layer_id), ["layer-b", "layer-c"]);
  current = applyOptimisticMutation(current, { kind: "layer.ungroup", target_id: "group-native", properties: {} });
  assert.deepEqual(current.layers!.sort((a, b) => a.order - b.order).map((item) => item.order), [0, 1, 2]);
});

test("optimistic linked-style detach materializes the last shared appearance", () => {
  let current = applyOptimisticMutation(snapshot(), {
    kind: "style.upsert",
    target_ids: ["layer-a", "layer-b"],
    shared_style: { shared_style_id: "style-native", name: "Native blue", kind: "fill", properties: { fill: "#0044aa" } },
    properties: {},
  });
  current = applyOptimisticMutation(current, { kind: "style.detach", target_id: "style-native", target_ids: ["layer-a"], properties: {} });
  assert.equal(current.layers!.find((item) => item.layer_id === "layer-a")!.shape!.fill, "#0044aa");
  assert.equal(current.layers!.find((item) => item.layer_id === "layer-b")!.shared_style_ids![0], "style-native");
});
