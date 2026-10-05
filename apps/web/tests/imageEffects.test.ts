import assert from "node:assert/strict";
import test from "node:test";

import {
  applyEffectsToRgba,
  assertBrowserEffectsBudget,
  createNeutralEffectsRecipe,
  isNeutralEffects,
  sameEffectsRecipe,
  sanitizeEffectsRecipe,
} from "../src/image-quality/imageEffects.ts";
import { inspectPngDimensions, tagEffectPng } from "../src/image-quality/pngMetadata.ts";

function framedPng(width: number, height: number) {
  const bytes = new Uint8Array(45);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13, false);
  bytes.set([73, 72, 68, 82], 12);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  bytes[24] = 8;
  bytes[25] = 6;
  view.setUint32(33, 0, false);
  bytes.set([73, 69, 78, 68], 37);
  return bytes;
}

function solid(width: number, height: number, value = 128) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) pixels.set([value, value, value, 255], offset);
  return pixels;
}

test("effects recipes are bounded, neutral and comparable", () => {
  const neutral = createNeutralEffectsRecipe();
  assert.equal(isNeutralEffects(neutral), true);
  const safe = sanitizeEffectsRecipe({
    vignette: { amount: -200.4, midpoint: 120, feather: Number.NaN },
  });
  assert.deepEqual(safe, { vignette: { amount: -100, midpoint: 100, feather: 50 } });
  assert.equal(sameEffectsRecipe(safe, { vignette: { ...safe.vignette } }), true);
  assert.equal(sameEffectsRecipe(safe, { vignette: { ...safe.vignette, feather: 49 } }), false);
  assert.equal(assertBrowserEffectsBudget(8192, 8192), 67_108_864);
  assert.throws(() => assertBrowserEffectsBudget(8193, 8192), /beyond this browser's 67,108,864-pixel safety budget/);
});

test("vignette deterministically changes the perimeter while preserving the centre and alpha", () => {
  const width = 5;
  const height = 5;
  const source = solid(width, height);
  const dark = source.slice();
  const darkAgain = source.slice();
  const recipe = { vignette: { amount: -80, midpoint: 35, feather: 55 } };
  const statistics = applyEffectsToRgba(dark, recipe, width, height);
  applyEffectsToRgba(darkAgain, recipe, width, height);
  assert.deepEqual(dark, darkAgain);
  assert.deepEqual(Array.from(dark.subarray((2 * width + 2) * 4, (2 * width + 2) * 4 + 4)), [128, 128, 128, 255]);
  assert.ok(dark[0] < source[0]);
  assert.ok(statistics.changedPixels > 0);
  assert.equal(statistics.darkenedPixels, statistics.changedPixels);
  assert.equal(statistics.lightenedPixels, 0);
  for (let offset = 3; offset < dark.length; offset += 4) assert.equal(dark[offset], 255);

  const light = source.slice();
  const lightStatistics = applyEffectsToRgba(light, {
    vignette: { amount: 80, midpoint: 35, feather: 55 },
  }, width, height);
  assert.ok(light[0] > source[0]);
  assert.equal(lightStatistics.lightenedPixels, lightStatistics.changedPixels);
  assert.notDeepEqual(light, dark);
});

test("vignette tiles use immutable full-image coordinates and preserve hidden RGB", () => {
  const width = 7;
  const height = 6;
  const source = solid(width, height, 96);
  source.set([17, 29, 43, 0], 0);
  const recipe = { vignette: { amount: -67, midpoint: 20, feather: 72 } };
  const full = source.slice();
  applyEffectsToRgba(full, recipe, width, height);

  const tiled = source.slice();
  const first = tiled.slice(0, width * 2 * 4);
  const second = tiled.slice(width * 2 * 4);
  applyEffectsToRgba(first, recipe, width, height, 0);
  applyEffectsToRgba(second, recipe, width, height, 2);
  tiled.set(first, 0);
  tiled.set(second, first.length);
  assert.deepEqual(tiled, full);
  assert.deepEqual(Array.from(tiled.subarray(0, 4)), [17, 29, 43, 0]);

  const neutral = source.slice();
  assert.deepEqual(applyEffectsToRgba(neutral, createNeutralEffectsRecipe(), width, height), {
    processedPixels: 0,
    changedPixels: 0,
    darkenedPixels: 0,
    lightenedPixels: 0,
  });
  assert.deepEqual(neutral, source);
});

test("effect PNG tagging preserves dimensions and binds the vignette to its verified base", () => {
  const sourceHash = "a".repeat(64);
  const baseHash = "b".repeat(64);
  const tagged = tagEffectPng(framedPng(64, 48), {
    sourceSha256: sourceHash,
    baseOutputSha256: baseHash,
    baseKind: "colour",
    baseRoute: "colour:tone",
    baseStrength: 50,
    baseScale: 2,
    recipe: { vignette: { amount: -35, midpoint: 52, feather: 61 } },
    statistics: {
      processedPixels: 3072,
      changedPixels: 1200,
      darkenedPixels: 1200,
      lightenedPixels: 0,
    },
    outputWidth: 64,
    outputHeight: 48,
  });
  assert.deepEqual(inspectPngDimensions(tagged), { width: 64, height: 48 });
  const text = new TextDecoder().decode(tagged);
  assert.match(text, /ipw\.image-edit\.effects\.provenance\.v1/);
  assert.match(text, /"operation_order":\["source_coordinate_vignette"\]/);
  assert.match(text, /"base_kind":"colour"/);
  assert.match(text, /"amount":-35/);
  assert.match(text, /"midpoint":52/);
  assert.match(text, /"feather":61/);
  assert.match(text, new RegExp(sourceHash));
  assert.match(text, new RegExp(baseHash));

  assert.throws(() => tagEffectPng(framedPng(64, 48), {
    sourceSha256: sourceHash,
    baseOutputSha256: baseHash,
    baseKind: "colour",
    baseRoute: "colour:tone",
    baseStrength: 50,
    baseScale: 2,
    recipe: { vignette: { amount: -35, midpoint: 52, feather: 61 } },
    statistics: {
      processedPixels: 3072,
      changedPixels: 1200,
      darkenedPixels: 1199,
      lightenedPixels: 0,
    },
    outputWidth: 64,
    outputHeight: 48,
  }), /valid bounded source-derived recipe/);
});
