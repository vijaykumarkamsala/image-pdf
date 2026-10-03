import assert from "node:assert/strict";
import test from "node:test";

import {
  applyColorToRgba,
  assertBrowserColorBudget,
  createNeutralColorRecipe,
  isNeutralColor,
  recommendWhiteBalanceFromRgba,
  sameColorRecipe,
  sanitizeColorRecipe,
  whiteBalanceSampleRadius,
} from "../src/image-quality/imageColor.ts";
import { inspectPngDimensions, tagColorPng } from "../src/image-quality/pngMetadata.ts";

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

test("colour recipes are bounded, normalized and comparable", () => {
  const neutral = createNeutralColorRecipe();
  assert.equal(isNeutralColor(neutral), true);
  const safe = sanitizeColorRecipe({
    temperature: 101,
    tint: -101,
    saturation: 42.6,
    vibrance: Number.NaN,
  });
  assert.deepEqual(safe, { temperature: 100, tint: -100, saturation: 43, vibrance: 0 });
  assert.equal(sameColorRecipe(safe, { ...safe }), true);
  assert.equal(sameColorRecipe(safe, { ...safe, vibrance: 1 }), false);
  assert.equal(assertBrowserColorBudget(8192, 8192), 67_108_864);
  assert.throws(() => assertBrowserColorBudget(8193, 8192), /beyond this browser's 67,108,864-pixel safety budget/);
});

test("neutral colour is exact and adjusted colour preserves alpha and transparent hidden RGB", () => {
  const original = new Uint8ClampedArray([
    31, 47, 89, 0,
    20, 40, 60, 64,
    100, 120, 140, 128,
    230, 220, 210, 255,
  ]);
  const neutralPixels = original.slice();
  assert.deepEqual(applyColorToRgba(neutralPixels, createNeutralColorRecipe()), {
    processedPixels: 0,
    changedPixels: 0,
    gamutClippedPixels: 0,
  });
  assert.deepEqual(neutralPixels, original);

  const adjusted = original.slice();
  const statistics = applyColorToRgba(adjusted, {
    temperature: 35,
    tint: -15,
    saturation: 20,
    vibrance: 30,
  });
  assert.equal(statistics.processedPixels, 3);
  assert.equal(statistics.changedPixels, 3);
  assert.deepEqual([adjusted[3], adjusted[7], adjusted[11], adjusted[15]], [0, 64, 128, 255]);
  assert.deepEqual(Array.from(adjusted.subarray(0, 4)), [31, 47, 89, 0]);
});

test("temperature, tint, saturation and vibrance follow their disclosed axes", () => {
  const neutral = new Uint8ClampedArray([100, 100, 100, 255]);
  const warm = neutral.slice();
  applyColorToRgba(warm, { ...createNeutralColorRecipe(), temperature: 60 });
  assert.ok(warm[0] > warm[2], "positive temperature must warm red relative to blue");
  const cool = neutral.slice();
  applyColorToRgba(cool, { ...createNeutralColorRecipe(), temperature: -60 });
  assert.ok(cool[2] > cool[0], "negative temperature must cool blue relative to red");

  const magenta = neutral.slice();
  applyColorToRgba(magenta, { ...createNeutralColorRecipe(), tint: 60 });
  assert.ok((magenta[0] + magenta[2]) / 2 > magenta[1], "positive tint must add magenta relative to green");

  const colour = new Uint8ClampedArray([180, 90, 30, 255]);
  const grayscale = colour.slice();
  applyColorToRgba(grayscale, { ...createNeutralColorRecipe(), saturation: -100 });
  assert.equal(grayscale[0], grayscale[1]);
  assert.equal(grayscale[1], grayscale[2]);

  const mixed = new Uint8ClampedArray([120, 110, 100, 255, 220, 70, 20, 255]);
  const vibrant = mixed.slice();
  applyColorToRgba(vibrant, { ...createNeutralColorRecipe(), vibrance: 70 });
  const mutedGain = (Math.max(...vibrant.subarray(0, 3)) - Math.min(...vibrant.subarray(0, 3)))
    - (Math.max(...mixed.subarray(0, 3)) - Math.min(...mixed.subarray(0, 3)));
  const vividGain = (Math.max(...vibrant.subarray(4, 7)) - Math.min(...vibrant.subarray(4, 7)))
    - (Math.max(...mixed.subarray(4, 7)) - Math.min(...mixed.subarray(4, 7)));
  assert.ok(mutedGain > 0);
  assert.ok(mutedGain > vividGain, "vibrance must favor less-saturated pixels");
});

test("neutral-point white balance is deterministic, inverse-modelled and rejects unusable patches", () => {
  assert.equal(whiteBalanceSampleRadius(48, 40), 1);
  assert.equal(whiteBalanceSampleRadius(4096, 2048), 4);
  assert.equal(whiteBalanceSampleRadius(20_000, 20_000), 8);
  assert.throws(() => whiteBalanceSampleRadius(0, 40), /positive integer image dimensions/);

  const warmPatch = new Uint8ClampedArray([
    180, 170, 160, 255, 180, 170, 160, 255, 180, 170, 160, 255,
    180, 170, 160, 255, 180, 170, 160, 255, 180, 170, 160, 255,
    180, 170, 160, 255, 180, 170, 160, 255, 4, 250, 22, 0,
  ]);
  const suggestion = recommendWhiteBalanceFromRgba(warmPatch, 24, 20, 1);
  assert.deepEqual(suggestion, {
    sourceX: 24,
    sourceY: 20,
    radius: 1,
    visiblePixels: 8,
    red: 180,
    green: 170,
    blue: 160,
    temperature: -54,
    tint: 0,
    atLimit: false,
  });
  assert.deepEqual(suggestion, recommendWhiteBalanceFromRgba(warmPatch, 24, 20, 1));
  const corrected = new Uint8ClampedArray([180, 170, 160, 255]);
  applyColorToRgba(corrected, { ...createNeutralColorRecipe(), temperature: suggestion.temperature, tint: suggestion.tint });
  assert.ok(Math.max(...corrected.subarray(0, 3)) - Math.min(...corrected.subarray(0, 3)) < 20);

  const greenPatch = new Uint8ClampedArray([160, 175, 160, 255, 160, 175, 160, 255]);
  assert.ok(recommendWhiteBalanceFromRgba(greenPatch, 2, 3, 1).tint > 0);
  const neutralPatch = new Uint8ClampedArray([128, 128, 128, 255, 128, 128, 128, 255]);
  assert.deepEqual(
    (({ temperature, tint }) => ({ temperature, tint }))(recommendWhiteBalanceFromRgba(neutralPatch, 1, 1, 1)),
    { temperature: 0, tint: 0 },
  );
  assert.throws(
    () => recommendWhiteBalanceFromRgba(new Uint8ClampedArray([0, 0, 0, 255]), 0, 0, 1),
    /too dark/,
  );
  assert.throws(
    () => recommendWhiteBalanceFromRgba(new Uint8ClampedArray([255, 255, 255, 255]), 0, 0, 1),
    /clipped near white/,
  );
  assert.throws(
    () => recommendWhiteBalanceFromRgba(new Uint8ClampedArray([20, 30, 40, 0]), 0, 0, 1),
    /enough visible pixels/,
  );
});

test("colour PNG tagging preserves exact dimensions and binds the verified tone base", () => {
  const sourceHash = "a".repeat(64);
  const baseHash = "b".repeat(64);
  const recipe = { temperature: 20, tint: -10, saturation: 25, vibrance: 30 };
  const tagged = tagColorPng(framedPng(64, 48), {
    sourceSha256: sourceHash,
    baseOutputSha256: baseHash,
    baseKind: "tone",
    baseRoute: "tone:geometry-enhanced",
    baseStrength: 50,
    baseScale: 2,
    whiteBalanceSample: {
      sourceX: 20,
      sourceY: 18,
      radius: 2,
      visiblePixels: 25,
      red: 170,
      green: 180,
      blue: 175,
      temperature: 20,
      tint: -10,
      atLimit: false,
    },
    recipe,
    statistics: { processedPixels: 3072, changedPixels: 3000, gamutClippedPixels: 12 },
    outputWidth: 64,
    outputHeight: 48,
  });
  assert.deepEqual(inspectPngDimensions(tagged), { width: 64, height: 48 });
  const text = new TextDecoder().decode(tagged);
  assert.match(text, /ipw\.image-edit\.color\.provenance\.v2/);
  assert.match(text, /"operation_order":\["temperature","tint","saturation","vibrance"\]/);
  assert.match(text, /"white_balance_sample":\{"sourceX":20,"sourceY":18/);
  assert.match(text, /"base_kind":"tone"/);
  assert.match(text, /"temperature":20/);
  assert.match(text, new RegExp(sourceHash));
  assert.match(text, new RegExp(baseHash));

  assert.throws(() => tagColorPng(framedPng(64, 48), {
    sourceSha256: sourceHash,
    baseOutputSha256: baseHash,
    baseKind: "original",
    baseRoute: "immutable-original",
    baseStrength: null,
    baseScale: 1,
    whiteBalanceSample: null,
    recipe,
    statistics: { processedPixels: 3072, changedPixels: 3073, gamutClippedPixels: 0 },
    outputWidth: 64,
    outputHeight: 48,
  }), /valid bounded source-derived recipe/);
});
