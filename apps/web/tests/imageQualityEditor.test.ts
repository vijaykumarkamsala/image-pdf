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

function meanRgbDifference(first: Uint8ClampedArray, second: Uint8ClampedArray) {
  let total = 0;
  for (let offset = 0; offset < first.length; offset += 4) {
    total += Math.abs(first[offset] - second[offset]);
    total += Math.abs(first[offset + 1] - second[offset + 1]);
    total += Math.abs(first[offset + 2] - second[offset + 2]);
  }
  return total / (first.length / 4 * 3);
}

function channelRange(pixels: Uint8ClampedArray) {
  let minimum = 255;
  let maximum = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    minimum = Math.min(minimum, pixels[offset], pixels[offset + 1], pixels[offset + 2]);
    maximum = Math.max(maximum, pixels[offset], pixels[offset + 1], pixels[offset + 2]);
  }
  return maximum - minimum;
}

function regionLumaStats(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  startX: number,
  endX: number,
) {
  let total = 0;
  let squaredTotal = 0;
  let samples = 0;
  for (let y = 8; y < height - 8; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const offset = (y * width + x) * 4;
      const value = 0.2126 * pixels[offset] + 0.7152 * pixels[offset + 1] + 0.0722 * pixels[offset + 2];
      total += value;
      squaredTotal += value * value;
      samples += 1;
    }
  }
  const mean = total / samples;
  return { mean, deviation: Math.sqrt(squaredTotal / samples - mean * mean) };
}

function channelMeans(pixels: Uint8ClampedArray) {
  const means = [0, 0, 0];
  const samples = pixels.length / 4;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    means[0] += pixels[offset];
    means[1] += pixels[offset + 1];
    means[2] += pixels[offset + 2];
  }
  return means.map((value) => value / samples);
}

test("deterministic enhancement changes decoded pixels while preserving dimensions and alpha", () => {
  const source = testPixels(12, 10);
  const first = enhancePixels(source, 12, 10, 55);
  const second = enhancePixels(source, 12, 10, 55);

  assert.deepEqual(first.pixels, second.pixels);
  assert.equal(first.pixels.length, source.length);
  assert.notDeepEqual(first.pixels, source);
  assert.ok(meanRgbDifference(first.pixels, source) > 3, "the balanced setting must be visibly material");
  for (let offset = 3; offset < source.length; offset += 4) assert.equal(first.pixels[offset], source[offset]);
  assert.ok(first.analysis.tonalRange >= 0 && first.analysis.tonalRange <= 1);
});

test("balanced enhancement expands weak tonal separation without changing dimensions", () => {
  const width = 128;
  const height = 96;
  const source = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const value = 92 + Math.round(x / (width - 1) * 48) + ((x * 5 + y * 3) % 5 - 2);
      source[offset] = value + 6;
      source[offset + 1] = value;
      source[offset + 2] = value - 5;
      source[offset + 3] = 255;
    }
  }

  const enhanced = enhancePixels(source, width, height, 65);
  assert.equal(enhanced.pixels.length, source.length);
  assert.ok(channelRange(enhanced.pixels) >= channelRange(source) + 12);
  assert.ok(meanRgbDifference(enhanced.pixels, source) > 4);
});

test("stronger enhancement produces a stronger result from the same immutable source", () => {
  const source = testPixels(48, 32);
  const gentle = enhancePixels(source, 48, 32, 25);
  const strong = enhancePixels(source, 48, 32, 85);

  assert.ok(meanRgbDifference(strong.pixels, source) > meanRgbDifference(gentle.pixels, source) * 1.3);
  assert.deepEqual(source, testPixels(48, 32));
});

test("noise is reduced while a real edge gains separation", () => {
  const width = 160;
  const height = 120;
  const source = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const base = x < width / 2 ? 92 : 172;
      const noise = (x * 19 + y * 31) % 23 - 11;
      source[offset] = base + noise;
      source[offset + 1] = base + noise;
      source[offset + 2] = base + noise;
      source[offset + 3] = 255;
    }
  }

  const enhanced = enhancePixels(source, width, height, 65).pixels;
  const sourceLeft = regionLumaStats(source, width, height, 8, 72);
  const sourceRight = regionLumaStats(source, width, height, 88, 152);
  const resultLeft = regionLumaStats(enhanced, width, height, 8, 72);
  const resultRight = regionLumaStats(enhanced, width, height, 88, 152);

  assert.ok(resultLeft.deviation < sourceLeft.deviation * 0.8);
  assert.ok(resultRight.deviation < sourceRight.deviation * 0.8);
  assert.ok(resultRight.mean - resultLeft.mean > sourceRight.mean - sourceLeft.mean);
});

test("robust colour balancing reduces a broad warm cast", () => {
  const width = 128;
  const height = 96;
  const source = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const value = 60 + (x + y) % 120;
      source[offset] = Math.min(255, value * 1.18);
      source[offset + 1] = value;
      source[offset + 2] = value * 0.78;
      source[offset + 3] = 255;
    }
  }

  const enhanced = enhancePixels(source, width, height, 65);
  const before = channelMeans(source);
  const after = channelMeans(enhanced.pixels);
  assert.ok(Math.max(...after) - Math.min(...after) < (Math.max(...before) - Math.min(...before)) * 0.6);
  assert.ok(enhanced.analysis.colourCast > 0.1);
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
