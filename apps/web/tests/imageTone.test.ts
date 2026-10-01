import assert from "node:assert/strict";
import test from "node:test";

import {
  applyToneToRgba,
  assertBrowserToneBudget,
  createNeutralToneRecipe,
  isNeutralTone,
  sameToneRecipe,
  sanitizeToneRecipe,
} from "../src/image-quality/imageTone.ts";
import { inspectPngDimensions, tagTonePng } from "../src/image-quality/pngMetadata.ts";

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

test("tone recipes are bounded, normalized and comparable", () => {
  const neutral = createNeutralToneRecipe();
  assert.equal(isNeutralTone(neutral), true);
  const safe = sanitizeToneRecipe({
    levelBlack: 300,
    levelWhite: 20,
    levelMidtone: Number.NaN,
    exposure: 4.17,
    brightness: -101,
    contrast: 10.7,
    gamma: Number.NaN,
    highlights: 200,
    shadows: -200,
    whites: 49.5,
    blacks: -49.5,
  });
  assert.deepEqual(safe, {
    levelBlack: 254,
    levelWhite: 255,
    levelMidtone: 1,
    exposure: 3,
    brightness: -100,
    contrast: 11,
    gamma: 0,
    highlights: 100,
    shadows: -100,
    whites: 50,
    blacks: -49,
  });
  assert.equal(sameToneRecipe(safe, { ...safe }), true);
  assert.equal(sameToneRecipe(safe, { ...safe, exposure: 2.9 }), false);
  assert.equal(assertBrowserToneBudget(8192, 8192), 67_108_864);
  assert.throws(() => assertBrowserToneBudget(8193, 8192), /beyond this browser's 67,108,864-pixel safety budget/);
});

test("luminance levels map bounded endpoints and progressively control midtones", () => {
  const endpoints = new Uint8ClampedArray([
    32, 32, 32, 255,
    220, 220, 220, 255,
  ]);
  applyToneToRgba(endpoints, {
    ...createNeutralToneRecipe(),
    levelBlack: 32,
    levelWhite: 220,
  });
  assert.deepEqual(Array.from(endpoints), [0, 0, 0, 255, 255, 255, 255, 255]);

  const source = new Uint8ClampedArray([128, 128, 128, 255]);
  const darker = source.slice();
  const brighter = source.slice();
  applyToneToRgba(darker, { ...createNeutralToneRecipe(), levelMidtone: 0.5 });
  applyToneToRgba(brighter, { ...createNeutralToneRecipe(), levelMidtone: 2 });
  assert.ok(darker[0] < source[0]);
  assert.ok(brighter[0] > source[0]);
  assert.deepEqual([darker[0], darker[1], darker[2]], [darker[0], darker[0], darker[0]]);
  assert.deepEqual([brighter[0], brighter[1], brighter[2]], [brighter[0], brighter[0], brighter[0]]);
});

test("neutral tone is an exact no-op and non-neutral tone preserves every alpha byte", () => {
  const original = new Uint8ClampedArray([
    31, 47, 89, 0,
    20, 40, 60, 64,
    100, 120, 140, 128,
    230, 220, 210, 255,
  ]);
  const neutralPixels = original.slice();
  assert.deepEqual(applyToneToRgba(neutralPixels, createNeutralToneRecipe()), {
    processedPixels: 0,
    changedPixels: 0,
    newShadowClippedPixels: 0,
    newHighlightClippedPixels: 0,
  });
  assert.deepEqual(neutralPixels, original);

  const adjusted = original.slice();
  const statistics = applyToneToRgba(adjusted, {
    ...createNeutralToneRecipe(),
    exposure: 0.7,
    shadows: 35,
    highlights: -20,
  });
  assert.equal(statistics.processedPixels, 3);
  assert.equal(statistics.changedPixels, 3);
  assert.deepEqual([adjusted[3], adjusted[7], adjusted[11], adjusted[15]], [0, 64, 128, 255]);
  assert.deepEqual(Array.from(adjusted.subarray(0, 4)), [31, 47, 89, 0], "hidden RGB must survive transparent pixels");
});

test("shadow and highlight controls are region-selective and deterministic", () => {
  const base = new Uint8ClampedArray([32, 32, 32, 255, 220, 220, 220, 255]);
  const lifted = base.slice();
  const liftedAgain = base.slice();
  const liftRecipe = { ...createNeutralToneRecipe(), shadows: 60 };
  applyToneToRgba(lifted, liftRecipe);
  applyToneToRgba(liftedAgain, liftRecipe);
  assert.deepEqual(lifted, liftedAgain);
  assert.ok(lifted[0] - base[0] > lifted[4] - base[4], "shadows must primarily affect darker pixels");

  const recovered = base.slice();
  applyToneToRgba(recovered, { ...createNeutralToneRecipe(), highlights: -60 });
  assert.ok(base[4] - recovered[4] > base[0] - recovered[0], "highlights must primarily affect brighter pixels");
  assert.notDeepEqual(lifted, recovered);
});

test("tone PNG tagging preserves exact dimensions and records verified base provenance", () => {
  const sourceHash = "a".repeat(64);
  const baseHash = "b".repeat(64);
  const recipe = { ...createNeutralToneRecipe(), exposure: 0.5, shadows: 20, highlights: -15 };
  const tagged = tagTonePng(framedPng(64, 48), {
    sourceSha256: sourceHash,
    baseOutputSha256: baseHash,
    baseKind: "geometry-enhanced",
    baseRoute: "geometry:photograph-production-x2",
    baseStrength: 50,
    baseScale: 2,
    recipe,
    statistics: {
      processedPixels: 3072,
      changedPixels: 3000,
      newShadowClippedPixels: 0,
      newHighlightClippedPixels: 2,
    },
    outputWidth: 64,
    outputHeight: 48,
  });
  assert.deepEqual(inspectPngDimensions(tagged), { width: 64, height: 48 });
  const text = new TextDecoder().decode(tagged);
  assert.match(text, /ipw\.image-edit\.tone\.provenance\.v2/);
  assert.match(text, /"operation_order":\["levels_black","levels_white","levels_midtone","exposure","brightness","shadows","highlights","blacks","whites","contrast","gamma"\]/);
  assert.match(text, /"base_kind":"geometry-enhanced"/);
  assert.match(text, /"exposure":0.5/);
  assert.match(text, /"levelBlack":0/);
  assert.match(text, /"levelWhite":255/);
  assert.match(text, /"levelMidtone":1/);
  assert.match(text, new RegExp(sourceHash));
  assert.match(text, new RegExp(baseHash));

  assert.throws(() => tagTonePng(framedPng(64, 48), {
    sourceSha256: sourceHash,
    baseOutputSha256: baseHash,
    baseKind: "enhanced",
    baseRoute: "",
    baseStrength: 50,
    baseScale: 2,
    recipe,
    statistics: {
      processedPixels: 3072,
      changedPixels: 4000,
      newShadowClippedPixels: 0,
      newHighlightClippedPixels: 0,
    },
    outputWidth: 64,
    outputHeight: 48,
  }), /valid bounded source-derived recipe/);
});
