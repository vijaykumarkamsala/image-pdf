import assert from "node:assert/strict";
import test from "node:test";

import { renderedToLayerTransform, snapCoordinate } from "../src/editor/renderer/coordinates.ts";

test("renderer coordinates preserve document-space size across device and viewport scale", () => {
  const current = {
    x: 0, y: 0, width: 200, height: 100, rotation_degrees: 0,
    scale_x: 1, scale_y: 1, skew_x_degrees: 0, skew_y_degrees: 0, flip_x: false, flip_y: false,
  };
  const result = renderedToLayerTransform(current, {
    left: 12.34567, top: 8.76543, angle: 370, scaledWidth: 300, scaledHeight: 50, flipX: true, flipY: false,
  });
  assert.equal(result.x, 12.346);
  assert.equal(result.y, 8.765);
  assert.equal(result.rotation_degrees, 10);
  assert.equal(result.scale_x, 1.5);
  assert.equal(result.scale_y, 0.5);
  assert.equal(result.flip_x, true);
});

test("snapping chooses the nearest guide only inside the zoom-adjusted threshold", () => {
  assert.equal(snapCoordinate(99, [0, 100, 200], 4), 100);
  assert.equal(snapCoordinate(93, [0, 100, 200], 4), 93);
  assert.equal(snapCoordinate(102, [100, 103], 4), 103);
});
