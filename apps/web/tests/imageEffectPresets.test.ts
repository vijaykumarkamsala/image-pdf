import assert from "node:assert/strict";
import test from "node:test";

import {
  applyBloomToRgba,
  applyEffectsToRgba,
  isNeutralEffects,
  isSanitizedEffectsRecipe,
} from "../src/image-quality/imageEffects.ts";
import {
  IMAGE_EFFECT_PRESETS,
  IMAGE_EFFECT_PRESET_IDS,
  IMAGE_EFFECT_PRESET_VERSION,
  imageEffectPreset,
  matchingImageEffectPreset,
} from "../src/image-quality/imageEffectPresets.ts";

function fixture(width: number, height: number) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      pixels.set([40 + x * 4, 48 + y * 3, 64 + x + y, 255], offset);
    }
  }
  for (let y = 5; y <= 7; y += 1) {
    for (let x = 5; x <= 7; x += 1) pixels.set([248, 232, 190, 255], (y * width + x) * 4);
  }
  return pixels;
}

function renderPreset(source: Uint8ClampedArray, width: number, height: number, presetIndex: number) {
  const recipe = IMAGE_EFFECT_PRESETS[presetIndex]!.recipe;
  const bloom = applyBloomToRgba(source, width, height, 0, height, recipe.bloom).pixels;
  applyEffectsToRgba(bloom, recipe, width, height, 0, 0x1234abcd);
  return bloom;
}

test("built-in effect looks have stable identities and complete bounded recipes", () => {
  assert.equal(IMAGE_EFFECT_PRESETS.length, IMAGE_EFFECT_PRESET_IDS.length);
  assert.equal(new Set(IMAGE_EFFECT_PRESETS.map((preset) => preset.id)).size, IMAGE_EFFECT_PRESETS.length);
  for (const preset of IMAGE_EFFECT_PRESETS) {
    assert.equal(preset.version, IMAGE_EFFECT_PRESET_VERSION);
    assert.ok(preset.label.length > 0);
    assert.ok(preset.description.length > 0);
    assert.equal(isSanitizedEffectsRecipe(preset.recipe), true);
    assert.equal(isNeutralEffects(preset.recipe), false);
  }
});

test("effect look lookup returns an isolated recipe and detects exact matches only", () => {
  const first = imageEffectPreset("analog-finish");
  const second = imageEffectPreset("analog-finish");
  assert.notEqual(first.recipe, second.recipe);
  assert.notEqual(first.recipe.bloom, second.recipe.bloom);
  assert.notEqual(first.recipe.grain, second.recipe.grain);
  assert.notEqual(first.recipe.vignette, second.recipe.vignette);
  assert.equal(matchingImageEffectPreset(first.recipe)?.id, "analog-finish");
  first.recipe.grain.amount += 1;
  assert.equal(matchingImageEffectPreset(first.recipe), null);
  assert.equal(matchingImageEffectPreset(second.recipe)?.version, IMAGE_EFFECT_PRESET_VERSION);
});

test("built-in effect looks produce deterministic distinct pixels without external data", () => {
  const width = 13;
  const height = 13;
  const source = fixture(width, height);
  const outputs = IMAGE_EFFECT_PRESETS.map((_preset, index) => {
    const first = renderPreset(source, width, height, index);
    const second = renderPreset(source, width, height, index);
    assert.deepEqual(first, second);
    assert.notDeepEqual(first, source);
    return Buffer.from(first).toString("hex");
  });
  assert.equal(new Set(outputs).size, IMAGE_EFFECT_PRESETS.length);
});

test("published effect look settings remain explicit reviewable data", () => {
  assert.deepEqual(imageEffectPreset("soft-bloom").recipe.bloom, { amount: 28, radius: 10, threshold: 72 });
  assert.deepEqual(imageEffectPreset("fine-grain").recipe.grain, { amount: 22, size: 2 });
  assert.deepEqual(imageEffectPreset("cinematic-frame").recipe.vignette, {
    amount: -30,
    midpoint: 58,
    feather: 70,
  });
  const analog = imageEffectPreset("analog-finish").recipe;
  assert.deepEqual(analog.bloom, { amount: 16, radius: 7, threshold: 76 });
  assert.deepEqual(analog.grain, { amount: 18, size: 2 });
  assert.deepEqual(analog.vignette, { amount: -18, midpoint: 54, feather: 76 });
});
