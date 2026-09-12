import assert from "node:assert/strict";
import test from "node:test";
import type { ImageOperationKind } from "ipw-contracts-ts/product";

import {
  defaultOperation,
  executableUiOperations,
  moveOperation,
  neutralOperation,
  normalizeOrder,
  semanticallyEqualOperations,
} from "../src/editor/enhancementModel.ts";
import { sampleCanvasHistogram } from "../src/editor/comparisonModel.ts";

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

test("unavailable recipe controls cannot be serialized by the customer UI", () => {
  const operations = [
    defaultOperation("orientation_normalize", 0),
    defaultOperation("contrast", 1),
    defaultOperation("colour_profile_conversion", 2),
  ];
  const executable = executableUiOperations(operations);
  assert.deepEqual(executable.map((item) => item.kind), ["contrast"]);
  assert.deepEqual(executable.map((item) => item.order), [0]);
});

test("reset is neutral and semantic comparison ignores generated identities", () => {
  for (const kind of kinds) {
    const operation = defaultOperation(kind, 0);
    const reset = neutralOperation(operation);
    if (["orientation_normalize", "flip", "resize", "grayscale", "colour_profile_conversion", "resampling_scale"].includes(kind)) {
      assert.equal(reset.enabled, false, `${kind} must reset by disabling its effect`);
    }
    if (kind === "unsharp_mask") assert.equal((reset.parameters as { amount: number }).amount, 0);
    if (kind === "noise_reduction") assert.equal((reset.parameters as { strength: number }).strength, 0);
  }
  const left = defaultOperation("contrast", 0);
  const right = { ...structuredClone(left), operation_id: "operation-another" };
  assert.equal(semanticallyEqualOperations([left], [right]), true);
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
