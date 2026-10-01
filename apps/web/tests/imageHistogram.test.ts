import assert from "node:assert/strict";
import test from "node:test";

import {
  accumulateImageHistogram,
  assertBrowserHistogramBudget,
  createImageHistogramAccumulator,
  finalizeImageHistogram,
  IMAGE_HISTOGRAM_BINS,
} from "../src/image-quality/imageHistogram.ts";

test("histogram bins exact visible RGB/luminance pixels and excludes fully transparent pixels", () => {
  const accumulator = createImageHistogramAccumulator();
  accumulateImageHistogram(accumulator, new Uint8ClampedArray([
    0, 0, 0, 255,
    255, 255, 255, 255,
    100, 120, 140, 128,
    33, 44, 55, 0,
  ]));
  const summary = finalizeImageHistogram(accumulator, 4, 1);
  assert.equal(summary.red.length, IMAGE_HISTOGRAM_BINS);
  assert.equal(summary.visiblePixels, 3);
  assert.equal(summary.transparentPixels, 1);
  assert.equal(summary.shadowClippedPixels, 1);
  assert.equal(summary.highlightClippedPixels, 1);
  assert.ok(Math.abs(summary.shadowClippedPercent - 100 / 3) < 1e-12);
  assert.ok(Math.abs(summary.highlightClippedPercent - 100 / 3) < 1e-12);
  assert.equal(summary.red[0], 1);
  assert.equal(summary.red[25], 1);
  assert.equal(summary.red[63], 1);
  assert.equal(summary.luminance.reduce((sum, value) => sum + value, 0), 3);
});

test("histogram accumulation is deterministic across tiles", () => {
  const pixels = new Uint8ClampedArray([
    2, 2, 2, 255,
    253, 253, 253, 255,
    80, 100, 120, 255,
    150, 130, 110, 255,
  ]);
  const whole = createImageHistogramAccumulator();
  accumulateImageHistogram(whole, pixels);
  const tiled = createImageHistogramAccumulator();
  accumulateImageHistogram(tiled, pixels.subarray(0, 8));
  accumulateImageHistogram(tiled, pixels.subarray(8));
  assert.deepEqual(finalizeImageHistogram(tiled, 2, 2), finalizeImageHistogram(whole, 2, 2));
});

test("histogram budget and accounting failures are explicit", () => {
  assert.equal(assertBrowserHistogramBudget(8192, 8192), 67_108_864);
  assert.throws(() => assertBrowserHistogramBudget(8193, 8192), /No sampled substitute was shown/);
  assert.throws(() => finalizeImageHistogram(createImageHistogramAccumulator(), 1, 1), /did not account for every decoded pixel/);
});
