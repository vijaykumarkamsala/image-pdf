import assert from "node:assert/strict";
import test from "node:test";

import type { ExportOutputProfile, ImageOperation } from "ipw-contracts-ts/product";

import {
  assertExecutableExport,
  effectiveVisibleRasterAssetIds,
  requireOperations,
  requireOutputProfile,
} from "../src/domains/exports/enhancement-validation.js";

function profile(overrides: Record<string, unknown> = {}): ExportOutputProfile {
  return requireOutputProfile({
    profile_id: "profile-validation",
    name: "Validation PNG",
    purpose: "web",
    format: "png",
    lossless: true,
    alpha_behavior: "preserve",
    metadata_policy: {},
    ...overrides,
  });
}

function snapshot() {
  return {
    artboards: [{
      artboard_id: "artboard-one",
      width: 640,
      height: 480,
      unit: "px",
      background: { kind: "transparent", color: null },
    }],
    shared_assets: [{
      shared_asset_id: "asset-one",
      kind: "raster",
      source_version_id: "source-one",
      object_reference_id: "object-one",
    }],
    masks: [],
    layers: [{
      layer_id: "group-one",
      artboard_id: "artboard-one",
      parent_layer_id: null,
      layer_type: "group",
      order: 0,
      visible: true,
      opacity: 1,
      blend_mode: "normal",
      transform: { x: 0, y: 0, width: 640, height: 480 },
    }, {
      layer_id: "raster-one",
      artboard_id: "artboard-one",
      parent_layer_id: "group-one",
      layer_type: "raster_image",
      order: 0,
      visible: true,
      opacity: 1,
      blend_mode: "normal",
      transform: { x: 0, y: 0, width: 640, height: 480 },
      raster: { shared_asset_id: "asset-one", crop: { left: 0, top: 0, right: 1, bottom: 1 } },
    }],
  };
}

test("operation input rejects ignored controls and non-finite values before enqueue", () => {
  assert.throws(() => requireOperations([{
    operation_id: "operation-orientation",
    kind: "orientation_normalize",
    order: 0,
    enabled: true,
    parameters: { source_orientation: 6, apply_exactly_once: true },
  }]), /normalized once at verified source decode/);
  assert.throws(() => requireOperations([{
    operation_id: "operation-flip",
    kind: "flip",
    order: 0,
    enabled: true,
    parameters: { horizontal: false, vertical: false },
  }]), /select at least one axis/);
  assert.throws(() => requireOperations([{
    operation_id: "operation-resize",
    kind: "resize",
    order: 0,
    enabled: true,
    parameters: {
      mode: "pixels", width: 100, height: 100, aspect_locked: false,
      fit: "contain", algorithm: "lanczos",
    },
  }]), /Unlocked resize/);
  assert.throws(() => requireOperations([{
    operation_id: "operation-gamma",
    kind: "gamma",
    order: 0,
    enabled: true,
    parameters: { gamma: Number.NaN },
  }]), /outside the supported range/);
  assert.throws(() => requireOperations([{
    operation_id: "operation-curve",
    kind: "curves",
    order: 0,
    enabled: true,
    parameters: {
      channel: "rgb",
      points: [{ input: 0, output: 0 }, { input: Number.POSITIVE_INFINITY, output: 1 }],
    },
  }]), /outside the supported range/);
});

test("unsupported profile controls fail closed before an export job exists", () => {
  assert.throws(() => profile({ bit_depth: 16 }), /16-bit output is not executable/);
  assert.throws(() => profile({ colour_profile: "display-p3" }), /Display P3 output is not executable/);
  assert.throws(() => profile({
    format: "webp",
    lossless: true,
    physical_width: 2,
    physical_unit: "in",
    ppi: 300,
  }), /WebP physical-resolution metadata is not executable/);
});

test("native hierarchy ownership, cycles and effective visibility are enforced", () => {
  const valid = snapshot();
  assert.doesNotThrow(() => assertExecutableExport(
    valid,
    [] as ImageOperation[],
    [{ artboardId: "artboard-one", profile: profile() }],
  ));
  assert.deepEqual([...effectiveVisibleRasterAssetIds(valid, ["artboard-one"])], ["asset-one"]);

  const hidden = structuredClone(valid);
  hidden.layers[0]!.visible = false;
  assert.deepEqual([...effectiveVisibleRasterAssetIds(hidden, ["artboard-one"])], []);

  const crossArtboard = structuredClone(valid);
  crossArtboard.layers[0]!.artboard_id = "artboard-other";
  assert.throws(() => assertExecutableExport(
    crossArtboard,
    [],
    [{ artboardId: "artboard-one", profile: profile() }],
  ), /parent is outside the selected artboard/);

  const cyclic = structuredClone(valid);
  cyclic.layers[1]!.layer_type = "group";
  cyclic.layers[0]!.parent_layer_id = "raster-one";
  cyclic.layers[0]!.order = 1;
  assert.throws(() => assertExecutableExport(
    cyclic,
    [],
    [{ artboardId: "artboard-one", profile: profile() }],
  ), /cyclic layer hierarchy/);

  const duplicateOrder = structuredClone(valid);
  duplicateOrder.layers.push({
    ...structuredClone(duplicateOrder.layers[1]!),
    layer_id: "raster-two",
  });
  assert.throws(() => assertExecutableExport(
    duplicateOrder,
    [],
    [{ artboardId: "artboard-one", profile: profile() }],
  ), /sibling layer order must be unique/);

  const text: any = structuredClone(valid);
  text.layers.push({
    layer_id: "text-one", artboard_id: "artboard-one", parent_layer_id: null,
    layer_type: "rich_text", order: 1, visible: true, opacity: 1, blend_mode: "normal",
    transform: { x: 10, y: 10, width: 200, height: 80, rotation_degrees: 12 },
    rich_text: {
      text: "Native text", runs: [], font_family: "IPW Standard", font_size: 24,
      color: "#162033", text_align: "center",
    },
  });
  assert.doesNotThrow(() => assertExecutableExport(
    text,
    [],
    [{ artboardId: "artboard-one", profile: profile() }],
  ));

  for (const [field, value, message] of [
    ["font_family", "Arial", /IPW Standard font/],
    ["runs", [{ start: 0, end: 6, style: { font_weight: "bold" } }], /Rich-text runs/],
    ["text_align", "justify", /text alignment/],
    ["text", "Native café", /glyphs outside/],
    ["line_height", 1.2, /Advanced text field/],
  ] as const) {
    const unsupported: any = structuredClone(text);
    unsupported.layers[2]!.rich_text[field] = value;
    assert.throws(() => assertExecutableExport(
      unsupported,
      [],
      [{ artboardId: "artboard-one", profile: profile() }],
    ), message);
  }

  const skewed: any = structuredClone(valid);
  skewed.layers[1]!.transform.skew_x_degrees = 8;
  assert.throws(() => assertExecutableExport(
    skewed,
    [],
    [{ artboardId: "artboard-one", profile: profile() }],
  ), /Native skew export is not executable in this build/);
});

test("full enhancement executes at exactly 16 megapixels and rejects one pixel-column more", () => {
  const exact: any = snapshot();
  exact.artboards[0].width = 4_000;
  exact.artboards[0].height = 4_000;
  exact.layers = [];
  exact.shared_assets = [];
  assert.doesNotThrow(() => assertExecutableExport(
    exact,
    [],
    [{ artboardId: "artboard-one", profile: profile() }],
  ));

  const over = structuredClone(exact);
  over.artboards[0]!.width = 4_001;
  assert.throws(() => assertExecutableExport(
    over,
    [],
    [{ artboardId: "artboard-one", profile: profile() }],
  ), /16 megapixel processing limit/);
});
