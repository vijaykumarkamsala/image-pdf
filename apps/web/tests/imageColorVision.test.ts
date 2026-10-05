import assert from "node:assert/strict";
import test from "node:test";

import {
  applyColorVisionToRgba,
  IMAGE_COLOR_VISION_MODES,
} from "../src/image-quality/imageColorVision.ts";

const source = new Uint8ClampedArray([
  255, 0, 0, 255,
  0, 255, 0, 192,
  0, 0, 255, 64,
  17, 34, 51, 0,
]);

test("full-severity colour-vision modes are deterministic and distinct", () => {
  const outputs = IMAGE_COLOR_VISION_MODES.map((mode) => {
    const first = new Uint8ClampedArray(source);
    const second = new Uint8ClampedArray(source);
    const firstStatistics = applyColorVisionToRgba(first, mode);
    const secondStatistics = applyColorVisionToRgba(second, mode);
    assert.deepEqual(first, second);
    assert.deepEqual(firstStatistics, secondStatistics);
    assert.equal(firstStatistics.processedPixels, 3);
    assert.equal(firstStatistics.changedPixels, 3);
    return Array.from(first).join(",");
  });
  assert.equal(new Set(outputs).size, IMAGE_COLOR_VISION_MODES.length);
});

test("colour-vision simulation applies the published matrices while preserving alpha and hidden RGB", () => {
  const protanopia = new Uint8ClampedArray(source);
  const statistics = applyColorVisionToRgba(protanopia, "protanopia");
  assert.deepEqual(Array.from(protanopia.slice(0, 4)), [39, 29, 0, 255]);
  assert.deepEqual(Array.from(protanopia.slice(12, 16)), [17, 34, 51, 0]);
  assert.equal(protanopia[7], 192);
  assert.equal(protanopia[11], 64);
  assert.equal(statistics.processedPixels, 3);
  assert.ok(statistics.clippedChannels > 0);
});

test("colour-vision simulation rejects incomplete RGBA input", () => {
  assert.throws(
    () => applyColorVisionToRgba(new Uint8ClampedArray([1, 2, 3]), "deuteranopia"),
    /complete RGBA pixels/,
  );
});
