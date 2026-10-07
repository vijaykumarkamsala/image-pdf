import assert from "node:assert/strict";
import test from "node:test";

import {
  applyBloomToRgba,
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
    bloom: { amount: 200, radius: 100, threshold: -20 },
    posterize: { levels: -50 },
    grain: { amount: 200, size: 20 },
    vignette: { amount: -200.4, midpoint: 120, feather: Number.NaN },
  });
  assert.deepEqual(safe, {
    bloom: { amount: 100, radius: 32, threshold: 0 },
    posterize: { levels: 2 },
    grain: { amount: 100, size: 8 },
    vignette: { amount: -100, midpoint: 100, feather: 50 },
  });
  assert.equal(sameEffectsRecipe(safe, {
    bloom: { ...safe.bloom },
    posterize: { ...safe.posterize },
    grain: { ...safe.grain },
    vignette: { ...safe.vignette },
  }), true);
  assert.equal(sameEffectsRecipe(safe, {
    bloom: { ...safe.bloom },
    posterize: { ...safe.posterize },
    grain: { ...safe.grain },
    vignette: { ...safe.vignette, feather: 49 },
  }), false);
  assert.equal(assertBrowserEffectsBudget(8192, 8192), 67_108_864);
  assert.throws(() => assertBrowserEffectsBudget(8193, 8192), /beyond this browser's 67,108,864-pixel safety budget/);
});

test("vignette deterministically changes the perimeter while preserving the centre and alpha", () => {
  const width = 5;
  const height = 5;
  const source = solid(width, height);
  const dark = source.slice();
  const darkAgain = source.slice();
  const recipe = {
    bloom: { amount: 0, radius: 8, threshold: 70 },
    posterize: { levels: 256 },
    grain: { amount: 0, size: 2 },
    vignette: { amount: -80, midpoint: 35, feather: 55 },
  };
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
    bloom: { amount: 0, radius: 8, threshold: 70 },
    posterize: { levels: 256 },
    grain: { amount: 0, size: 2 },
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
  const recipe = {
    bloom: { amount: 0, radius: 8, threshold: 70 },
    posterize: { levels: 256 },
    grain: { amount: 0, size: 2 },
    vignette: { amount: -67, midpoint: 20, feather: 72 },
  };
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
    bloomChangedPixels: 0,
    posterizedPixels: 0,
    grainChangedPixels: 0,
    vignetteChangedPixels: 0,
    darkenedPixels: 0,
    lightenedPixels: 0,
  });
  assert.deepEqual(neutral, source);
});

test("posterization is deterministic, level-bounded and preserves alpha and hidden RGB", () => {
  const width = 257;
  const height = 2;
  const source = new Uint8ClampedArray(width * height * 4);
  source.set([17, 29, 43, 0], 0);
  for (let y = 0; y < height; y += 1) {
    for (let x = 1; x < width; x += 1) {
      const value = x - 1;
      source.set([value, 255 - value, value, 255], (y * width + x) * 4);
    }
  }
  const recipe = createNeutralEffectsRecipe();
  recipe.posterize.levels = 4;
  const first = source.slice();
  const repeated = source.slice();
  const statistics = applyEffectsToRgba(first, recipe, width, height);
  applyEffectsToRgba(repeated, recipe, width, height);
  assert.deepEqual(first, repeated);
  assert.deepEqual(Array.from(first.subarray(0, 4)), [17, 29, 43, 0]);
  assert.equal(statistics.posterizedPixels, statistics.changedPixels);
  assert.ok(statistics.posterizedPixels > 0);
  assert.equal(statistics.grainChangedPixels, 0);
  assert.equal(statistics.vignetteChangedPixels, 0);
  const redValues = new Set<number>();
  for (let x = 1; x < width; x += 1) {
    const offset = x * 4;
    redValues.add(first[offset]);
    assert.equal(first[offset + 3], 255);
  }
  assert.deepEqual([...redValues], [0, 85, 170, 255]);

  const finerRecipe = createNeutralEffectsRecipe();
  finerRecipe.posterize.levels = 16;
  const finer = source.slice();
  applyEffectsToRgba(finer, finerRecipe, width, height);
  const finerRedValues = new Set<number>();
  for (let x = 1; x < width; x += 1) finerRedValues.add(finer[x * 4]);
  assert.equal(finerRedValues.size, 16);
  assert.notDeepEqual(finer, first);
});

test("highlight bloom is progressive, source-derived, alpha-safe and tile-stable", () => {
  const width = 11;
  const height = 10;
  const source = solid(width, height, 28);
  for (let y = 4; y <= 5; y += 1) {
    for (let x = 5; x <= 6; x += 1) source.set([248, 224, 180, 255], (y * width + x) * 4);
  }
  source.set([17, 29, 43, 0], 0);
  const recipe = { amount: 60, radius: 3, threshold: 60 };
  const bloom = applyBloomToRgba(source, width, height, 0, height, recipe);
  const repeated = applyBloomToRgba(source, width, height, 0, height, recipe);
  assert.deepEqual(bloom, repeated);
  assert.ok(bloom.changedPixels > 0);
  const nearOffset = (4 * width + 4) * 4;
  assert.ok(bloom.pixels[nearOffset] > source[nearOffset]);
  assert.deepEqual(Array.from(bloom.pixels.subarray(0, 4)), [17, 29, 43, 0]);
  for (let offset = 0; offset < bloom.pixels.length; offset += 4) {
    assert.equal(bloom.pixels[offset + 3], source[offset + 3]);
    if (source[offset] < 255) assert.ok(bloom.pixels[offset] < 255);
    if (source[offset + 1] < 255) assert.ok(bloom.pixels[offset + 1] < 255);
    if (source[offset + 2] < 255) assert.ok(bloom.pixels[offset + 2] < 255);
  }

  const stronger = applyBloomToRgba(source, width, height, 0, height, {
    amount: 100,
    radius: 3,
    threshold: 60,
  });
  const difference = (pixels: Uint8ClampedArray) => pixels.reduce((total, value, index) => (
    index % 4 === 3 ? total : total + Math.abs(value - source[index])
  ), 0);
  assert.ok(difference(stronger.pixels) > difference(bloom.pixels));
  const broader = applyBloomToRgba(source, width, height, 0, height, {
    amount: 60,
    radius: 5,
    threshold: 60,
  });
  assert.notDeepEqual(broader.pixels, bloom.pixels);
  const excluded = applyBloomToRgba(source, width, height, 0, height, {
    amount: 100,
    radius: 3,
    threshold: 100,
  });
  assert.equal(excluded.changedPixels, 0);
  assert.deepEqual(excluded.pixels, source);

  const split = 4;
  const firstBottom = Math.min(height, split + recipe.radius);
  const firstTile = source.slice(0, firstBottom * width * 4);
  const firstCore = applyBloomToRgba(firstTile, width, firstBottom, 0, split, recipe).pixels;
  const secondTop = Math.max(0, split - recipe.radius);
  const secondTile = source.slice(secondTop * width * 4);
  const secondCore = applyBloomToRgba(
    secondTile,
    width,
    height - secondTop,
    split - secondTop,
    height - split,
    recipe,
  ).pixels;
  const tiled = new Uint8ClampedArray(source.length);
  tiled.set(firstCore);
  tiled.set(secondCore, firstCore.length);
  assert.deepEqual(tiled, bloom.pixels);
});

test("film grain is deterministic, progressive, hue-preserving and tile-stable", () => {
  const width = 9;
  const height = 8;
  const source = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < source.length; offset += 4) source.set([72, 102, 132, 255], offset);
  source.set([17, 29, 43, 0], 0);
  const recipe = {
    bloom: { amount: 0, radius: 8, threshold: 70 },
    posterize: { levels: 256 },
    grain: { amount: 50, size: 3 },
    vignette: { amount: 0, midpoint: 50, feather: 50 },
  };
  const first = source.slice();
  const repeated = source.slice();
  const statistics = applyEffectsToRgba(first, recipe, width, height, 0, 0x1234abcd);
  applyEffectsToRgba(repeated, recipe, width, height, 0, 0x1234abcd);
  assert.deepEqual(first, repeated);
  assert.ok(statistics.changedPixels > 0);
  assert.equal(statistics.changedPixels, statistics.grainChangedPixels);
  assert.equal(statistics.vignetteChangedPixels, 0);
  assert.deepEqual(Array.from(first.subarray(0, 4)), [17, 29, 43, 0]);
  for (let offset = 4; offset < first.length; offset += 4) {
    assert.equal(first[offset] - source[offset], first[offset + 1] - source[offset + 1]);
    assert.equal(first[offset] - source[offset], first[offset + 2] - source[offset + 2]);
    assert.equal(first[offset + 3], 255);
  }

  const stronger = source.slice();
  applyEffectsToRgba(stronger, {
    bloom: { amount: 0, radius: 8, threshold: 70 },
    posterize: { levels: 256 },
    grain: { amount: 100, size: 3 },
    vignette: { amount: 0, midpoint: 50, feather: 50 },
  }, width, height, 0, 0x1234abcd);
  const difference = (pixels: Uint8ClampedArray) => pixels.reduce((total, value, index) => (
    index % 4 === 3 ? total : total + Math.abs(value - source[index])
  ), 0);
  assert.ok(difference(stronger) > difference(first));

  const otherSeed = source.slice();
  applyEffectsToRgba(otherSeed, recipe, width, height, 0, 0x89abcdef);
  assert.notDeepEqual(otherSeed, first);
  const otherSize = source.slice();
  applyEffectsToRgba(otherSize, {
    bloom: { amount: 0, radius: 8, threshold: 70 },
    posterize: { levels: 256 },
    grain: { amount: 50, size: 6 },
    vignette: { amount: 0, midpoint: 50, feather: 50 },
  }, width, height, 0, 0x1234abcd);
  assert.notDeepEqual(otherSize, first);

  const tiled = source.slice();
  const firstTile = tiled.slice(0, width * 3 * 4);
  const secondTile = tiled.slice(width * 3 * 4);
  applyEffectsToRgba(firstTile, recipe, width, height, 0, 0x1234abcd);
  applyEffectsToRgba(secondTile, recipe, width, height, 3, 0x1234abcd);
  tiled.set(firstTile);
  tiled.set(secondTile, firstTile.length);
  assert.deepEqual(tiled, first);
});

test("effect PNG tagging preserves dimensions and binds ordered effects to the verified base", () => {
  const sourceHash = "a".repeat(64);
  const baseHash = "b".repeat(64);
  const tagged = tagEffectPng(framedPng(64, 48), {
    sourceSha256: sourceHash,
    baseOutputSha256: baseHash,
    baseKind: "colour",
    baseRoute: "colour:tone",
    baseStrength: 50,
    baseScale: 2,
    recipe: {
      bloom: { amount: 55, radius: 12, threshold: 68 },
      posterize: { levels: 8 },
      grain: { amount: 35, size: 3 },
      vignette: { amount: -35, midpoint: 52, feather: 61 },
    },
    statistics: {
      processedPixels: 3072,
      changedPixels: 1400,
      bloomChangedPixels: 600,
      posterizedPixels: 1200,
      grainChangedPixels: 900,
      vignetteChangedPixels: 1200,
      darkenedPixels: 1200,
      lightenedPixels: 0,
    },
    outputWidth: 64,
    outputHeight: 48,
  });
  assert.deepEqual(inspectPngDimensions(tagged), { width: 64, height: 48 });
  const text = new TextDecoder().decode(tagged);
  assert.match(text, /ipw\.image-edit\.effects\.provenance\.v4/);
  assert.match(text, /"operation_order":\["source_neighbourhood_highlight_bloom","per_channel_posterization","source_coordinate_film_grain","source_coordinate_vignette"\]/);
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
    recipe: {
      bloom: { amount: 55, radius: 12, threshold: 68 },
      posterize: { levels: 8 },
      grain: { amount: 35, size: 3 },
      vignette: { amount: -35, midpoint: 52, feather: 61 },
    },
    statistics: {
      processedPixels: 3072,
      changedPixels: 1400,
      bloomChangedPixels: 600,
      posterizedPixels: 1200,
      grainChangedPixels: 900,
      vignetteChangedPixels: 1200,
      darkenedPixels: 1199,
      lightenedPixels: 0,
    },
    outputWidth: 64,
    outputHeight: 48,
  }), /valid bounded source-derived recipe/);
});
