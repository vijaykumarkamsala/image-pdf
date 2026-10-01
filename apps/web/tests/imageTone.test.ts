import assert from "node:assert/strict";
import test from "node:test";

import {
  applyToneToRgba,
  assertBrowserToneBudget,
  createNeutralToneRecipe,
  evaluateProtectedRecovery,
  evaluateToneCurve,
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
    curveBlack: 20,
    curveShadows: 10,
    curveMidtones: -1,
    curveHighlights: 200,
    curveWhite: 50,
    shadowRecovery: 150,
    highlightRecovery: -20,
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
    curveBlack: 20,
    curveShadows: 20,
    curveMidtones: 20,
    curveHighlights: 100,
    curveWhite: 100,
    shadowRecovery: 100,
    highlightRecovery: 0,
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

test("tone curve is anchor-exact, monotone and creates a bounded contrast curve", () => {
  const recipe = {
    ...createNeutralToneRecipe(),
    curveBlack: 5,
    curveShadows: 18,
    curveMidtones: 50,
    curveHighlights: 82,
    curveWhite: 95,
  };
  assert.equal(evaluateToneCurve(0, recipe), 0.05);
  assert.equal(evaluateToneCurve(0.25, recipe), 0.18);
  assert.equal(evaluateToneCurve(0.5, recipe), 0.5);
  assert.equal(evaluateToneCurve(0.75, recipe), 0.82);
  assert.equal(evaluateToneCurve(1, recipe), 0.95);
  let previous = evaluateToneCurve(0, recipe);
  for (let index = 1; index <= 100; index += 1) {
    const current = evaluateToneCurve(index / 100, recipe);
    assert.ok(current >= previous, "safe curve must never invert tones");
    previous = current;
  }

  const contrast = new Uint8ClampedArray([64, 64, 64, 255, 192, 192, 192, 255]);
  applyToneToRgba(contrast, {
    ...createNeutralToneRecipe(),
    curveShadows: 18,
    curveHighlights: 82,
  });
  assert.ok(contrast[0] < 64);
  assert.ok(contrast[4] > 192);
});

test("protected recovery is monotone, preserves endpoints and respects channel headroom", () => {
  assert.equal(evaluateProtectedRecovery(0, 100, 100), 0);
  assert.equal(evaluateProtectedRecovery(1, 100, 100), 1);
  for (const shadowRecovery of [0, 50, 100]) {
    for (const highlightRecovery of [0, 50, 100]) {
      let previous = evaluateProtectedRecovery(0, shadowRecovery, highlightRecovery);
      for (let index = 1; index <= 1000; index += 1) {
        const current = evaluateProtectedRecovery(index / 1000, shadowRecovery, highlightRecovery);
        assert.ok(current >= previous, "protected recovery must never invert tones");
        previous = current;
      }
    }
  }

  const base = new Uint8ClampedArray([
    0, 0, 0, 255,
    32, 32, 32, 255,
    128, 128, 128, 255,
    220, 220, 220, 255,
    255, 255, 255, 255,
  ]);
  const shadows = base.slice();
  const shadowStatistics = applyToneToRgba(shadows, {
    ...createNeutralToneRecipe(),
    shadowRecovery: 100,
  });
  assert.equal(shadows[0], 0);
  assert.equal(shadows[16], 255);
  assert.ok(shadows[4] - base[4] > shadows[12] - base[12]);
  assert.equal(shadowStatistics.newHighlightClippedPixels, 0);

  const highlights = base.slice();
  const highlightStatistics = applyToneToRgba(highlights, {
    ...createNeutralToneRecipe(),
    highlightRecovery: 100,
  });
  assert.equal(highlights[0], 0);
  assert.equal(highlights[16], 255);
  assert.ok(base[12] - highlights[12] > base[4] - highlights[4]);
  assert.equal(highlightStatistics.newShadowClippedPixels, 0);

  const noLiftHeadroom = new Uint8ClampedArray([255, 20, 20, 255]);
  const protectedLift = noLiftHeadroom.slice();
  applyToneToRgba(protectedLift, {
    ...createNeutralToneRecipe(),
    shadowRecovery: 100,
  });
  assert.deepEqual(protectedLift, noLiftHeadroom);
  const noLowerHeadroom = new Uint8ClampedArray([20, 20, 0, 255]);
  const protectedLowering = noLowerHeadroom.slice();
  applyToneToRgba(protectedLowering, {
    ...createNeutralToneRecipe(),
    highlightRecovery: 100,
  });
  assert.deepEqual(protectedLowering, noLowerHeadroom, "recovery must not push a channel beyond available RGB headroom");
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
  assert.match(text, /ipw\.image-edit\.tone\.provenance\.v4/);
  assert.match(text, /"operation_order":\["levels_black","levels_white","levels_midtone","tone_curve","shadow_recovery","highlight_recovery","exposure","brightness","shadows","highlights","blacks","whites","contrast","gamma"\]/);
  assert.match(text, /"base_kind":"geometry-enhanced"/);
  assert.match(text, /"exposure":0.5/);
  assert.match(text, /"levelBlack":0/);
  assert.match(text, /"levelWhite":255/);
  assert.match(text, /"levelMidtone":1/);
  assert.match(text, /"curveBlack":0/);
  assert.match(text, /"curveShadows":25/);
  assert.match(text, /"curveMidtones":50/);
  assert.match(text, /"curveHighlights":75/);
  assert.match(text, /"curveWhite":100/);
  assert.match(text, /"shadowRecovery":0/);
  assert.match(text, /"highlightRecovery":0/);
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
