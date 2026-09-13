import assert from "node:assert/strict";
import test from "node:test";

import { enhancePixels } from "../src/image-quality/imageQualityPipeline.ts";
import {
  imageQualitySessionReducer,
  initialImageQualitySession,
  type QualityResultState,
  type QualitySourceState,
} from "../src/image-quality/imageQualitySession.ts";

function testPixels(width: number, height: number) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const noise = (x * 17 + y * 11) % 9 - 4;
      pixels[offset] = 72 + x * 8 + noise;
      pixels[offset + 1] = 84 + y * 7 - noise;
      pixels[offset + 2] = 104 + (x + y) * 3 + noise;
      pixels[offset + 3] = (x + y) % 3 === 0 ? 180 : 255;
    }
  }
  return pixels;
}

test("deterministic enhancement changes decoded pixels while preserving dimensions and alpha", () => {
  const source = testPixels(12, 10);
  const first = enhancePixels(source, 12, 10, 55);
  const second = enhancePixels(source, 12, 10, 55);

  assert.deepEqual(first.pixels, second.pixels);
  assert.equal(first.pixels.length, source.length);
  assert.notDeepEqual(first.pixels, source);
  for (let offset = 3; offset < source.length; offset += 4) assert.equal(first.pixels[offset], source[offset]);
  assert.ok(first.analysis.tonalRange >= 0 && first.analysis.tonalRange <= 1);
});

test("view changes do not replace image bytes and reset restores the exact original source", () => {
  const source = {
    file: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }) as File,
    url: "blob:original",
    name: "photo.png",
    width: 12,
    height: 10,
  } satisfies QualitySourceState;
  const result = {
    url: "blob:enhanced",
    bytes: new Uint8Array([4, 5, 6]).buffer,
    width: 12,
    height: 10,
    analysis: { noiseLevel: 0.2, edgeDefinition: 0.4, tonalRange: 0.5, colourCast: 0.1 },
  } satisfies QualityResultState;
  let state = imageQualitySessionReducer(initialImageQualitySession, { type: "source-selected", source });
  state = imageQualitySessionReducer(state, { type: "source-ready", width: 12, height: 10 });
  state = imageQualitySessionReducer(state, { type: "processing-started" });
  state = imageQualitySessionReducer(state, { type: "processing-succeeded", result });
  const sourceBeforeViewChange = state.source;
  const resultBeforeViewChange = state.result;

  state = imageQualitySessionReducer(state, { type: "zoom-changed", zoom: 4 });
  state = imageQualitySessionReducer(state, { type: "pan-changed", x: 32, y: -18 });
  assert.equal(state.source, sourceBeforeViewChange);
  assert.equal(state.result, resultBeforeViewChange);

  state = imageQualitySessionReducer(state, { type: "processing-failed", message: "Worker stopped" });
  assert.equal(state.source, sourceBeforeViewChange);
  assert.equal(state.result, resultBeforeViewChange);

  state = imageQualitySessionReducer(state, { type: "reset" });
  assert.equal(state.source, sourceBeforeViewChange);
  assert.equal(state.result, null);
  assert.equal(state.zoom, "fit");
  assert.deepEqual(state.pan, { x: 0, y: 0 });
  assert.equal(state.source?.url, "blob:original");
});
