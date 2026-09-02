import assert from "node:assert/strict";
import test from "node:test";
import type { ImageOperationKind } from "ipw-contracts-ts/product";

import { defaultOperation, moveOperation, normalizeOrder } from "../src/editor/enhancementModel.ts";
import { operationFilter, sampleCanvasHistogram } from "../src/editor/comparisonModel.ts";

const kinds: ImageOperationKind[] = [
  "orientation_normalize", "crop", "rotate", "flip", "resize",
  "exposure_brightness", "contrast", "highlights_shadows", "white_balance_temperature",
  "tint", "saturation_vibrance", "gamma", "levels", "curves", "grayscale",
  "unsharp_mask", "noise_reduction", "colour_profile_conversion", "alpha_background",
  "resampling_scale",
];

test("every deterministic operation starts editable, enabled, and ordered", () => {
  const operations = kinds.map((kind, order) => defaultOperation(kind, order));
  assert.equal(operations.length, 20);
  assert.deepEqual(operations.map((item) => item.kind), kinds);
  assert.deepEqual(operations.map((item) => item.order), kinds.map((_, index) => index));
  assert.ok(operations.every((item) => item.enabled && item.operation_id.startsWith("operation-")));
  assert.equal((operations.find((item) => item.kind === "resampling_scale")!.parameters as { label: string }).label, "Standard resampling (not AI reconstruction)");
});

test("operation reordering is immutable and normalizes the persisted order", () => {
  const source = [defaultOperation("crop", 5), defaultOperation("contrast", 8), defaultOperation("curves", 13)];
  const moved = moveOperation(source, 2, 0);
  assert.deepEqual(moved.map((item) => item.kind), ["curves", "crop", "contrast"]);
  assert.deepEqual(moved.map((item) => item.order), [0, 1, 2]);
  assert.deepEqual(source.map((item) => item.kind), ["crop", "contrast", "curves"]);
  assert.deepEqual(normalizeOrder(source).map((item) => item.order), [0, 1, 2]);
});

test("comparison filter ignores disabled operations and never claims reconstructed detail", () => {
  const brightness = defaultOperation("exposure_brightness", 0);
  brightness.parameters = { exposure_ev: 1, brightness: 10 };
  const contrast = defaultOperation("contrast", 1);
  contrast.parameters = { amount: 40 };
  contrast.enabled = false;
  const filter = operationFilter([brightness, contrast]);
  assert.match(filter, /brightness\(220/);
  assert.match(filter, /contrast\(100/);
  assert.doesNotMatch(filter, /ai|reconstruct/i);
});

test("histogram sampling fails closed to an empty non-clipping result", () => {
  assert.deepEqual(sampleCanvasHistogram(null), {
    red: Array.from({ length: 64 }, () => 0),
    green: Array.from({ length: 64 }, () => 0),
    blue: Array.from({ length: 64 }, () => 0),
    shadow_clipping: false,
    highlight_clipping: false,
  });
});
