import assert from "node:assert/strict";
import test from "node:test";

import {
  applyColorToRgba,
  createNeutralColorRecipe,
  isNeutralColor,
} from "../src/image-quality/imageColor.ts";
import {
  analysisMatchesColorMatchRecipe,
  analyzeColorDistribution,
  createColorMatchRecipe,
  isSanitizedColorMatchRecipe,
  sameColorMatchRecipe,
  sanitizeColorMatchRecipe,
  type ImageColorMatchAnalysis,
} from "../src/image-quality/imageColorMatch.ts";

function sample(width: number, height: number, offset: number) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    pixels[index * 4] = 35 + ((index * 17 + offset) % 145);
    pixels[index * 4 + 1] = 45 + ((index * 11 + offset * 2) % 135);
    pixels[index * 4 + 2] = 55 + ((index * 7 + offset * 3) % 125);
    pixels[index * 4 + 3] = index === 0 ? 0 : 255;
  }
  return pixels;
}

function analysis(): ImageColorMatchAnalysis {
  const width = 8;
  const height = 8;
  return {
    referenceSha256: "b".repeat(64),
    referenceWidth: 640,
    referenceHeight: 480,
    referenceMediaType: "image/png",
    source: analyzeColorDistribution(sample(width, height, 3), width, height),
    reference: analyzeColorDistribution(sample(width, height, 67), width, height),
  };
}

function distance(left: Uint8ClampedArray, right: Uint8ClampedArray) {
  return left.reduce((total, value, index) => total + Math.abs(value - right[index]), 0);
}

test("colour-match analysis is deterministic and ignores fully transparent pixels", () => {
  const pixels = sample(8, 8, 3);
  const first = analyzeColorDistribution(pixels, 8, 8);
  const second = analyzeColorDistribution(pixels.slice(), 8, 8);
  assert.deepEqual(first, second);
  assert.equal(first.visiblePixels, 63);
  assert.deepEqual(first, analysis().source);
});

test("reviewed colour matching is deterministic and progressive at 0, 50 and 100 percent", () => {
  const baseSha256 = "a".repeat(64);
  const original = new Uint8ClampedArray([
    70, 96, 128, 255,
    150, 92, 54, 255,
    42, 132, 98, 255,
  ]);
  const outputs = [0, 50, 100].map((intensity) => {
    const recipe = createNeutralColorRecipe();
    recipe.colorMatch = { ...createColorMatchRecipe(analysis(), baseSha256), intensity };
    const pixels = original.slice();
    const repeated = original.slice();
    const statistics = applyColorToRgba(pixels, recipe);
    assert.deepEqual(applyColorToRgba(repeated, recipe), statistics);
    assert.deepEqual(repeated, pixels);
    return { pixels, recipe };
  });
  assert.equal(isNeutralColor(outputs[0].recipe), true);
  assert.deepEqual(outputs[0].pixels, original);
  const halfDistance = distance(outputs[1].pixels, original);
  const fullDistance = distance(outputs[2].pixels, original);
  assert.ok(halfDistance > 0);
  assert.ok(fullDistance > halfDistance);
  assert.notDeepEqual(outputs[1].pixels, outputs[2].pixels);
});

test("colour matching preserves alpha, hidden RGB, exact endpoints and protected neutrals", () => {
  const recipe = createNeutralColorRecipe();
  recipe.colorMatch = {
    ...createColorMatchRecipe(analysis(), "a".repeat(64)),
    intensity: 100,
    luminance: 0,
    colorIntensity: 100,
    protectNeutrals: true,
  };
  const original = new Uint8ClampedArray([
    0, 0, 0, 255,
    255, 255, 255, 255,
    128, 128, 128, 127,
    14, 28, 42, 0,
    64, 96, 160, 255,
  ]);
  const pixels = original.slice();
  const statistics = applyColorToRgba(pixels, recipe);
  assert.deepEqual(Array.from(pixels.slice(0, 16)), Array.from(original.slice(0, 16)));
  assert.equal(pixels[19], 255);
  assert.notDeepEqual(Array.from(pixels.slice(16, 19)), Array.from(original.slice(16, 19)));
  assert.equal(statistics.processedPixels, 4);
  assert.equal(statistics.changedPixels, 1);
});

test("colour-match metadata is bounded and remains bound to the reviewed source SHA", () => {
  const baseSha256 = "a".repeat(64);
  const recipe = createColorMatchRecipe(analysis(), baseSha256);
  assert.equal(isSanitizedColorMatchRecipe(recipe), true);
  assert.equal(analysisMatchesColorMatchRecipe(analysis(), recipe, baseSha256), true);
  assert.equal(analysisMatchesColorMatchRecipe(analysis(), recipe, "c".repeat(64)), false);
  const bounded = sanitizeColorMatchRecipe({
    ...recipe,
    intensity: 999,
    luminance: -20,
    colorIntensity: 45.6,
    protectNeutrals: false,
  });
  assert.ok(bounded);
  assert.equal(bounded.intensity, 100);
  assert.equal(bounded.luminance, 0);
  assert.equal(bounded.colorIntensity, 46);
  assert.equal(bounded.protectNeutrals, false);
  assert.equal(sameColorMatchRecipe(bounded, sanitizeColorMatchRecipe(bounded)), true);
  assert.equal(sanitizeColorMatchRecipe({ ...recipe, referenceSha256: "not-a-hash" }), null);
});

test("colour-match analysis rejects incomplete or unreliable samples", () => {
  assert.throws(() => analyzeColorDistribution(new Uint8ClampedArray(7), 1, 1), /complete bounded RGBA/);
  assert.throws(
    () => analyzeColorDistribution(new Uint8ClampedArray(8 * 8 * 4), 8, 8),
    /enough visible pixels/,
  );
});
