import assert from "node:assert/strict";
import test from "node:test";

import { sameToneRecipe, sanitizeToneRecipe } from "../src/image-quality/imageTone.ts";
import {
  IMAGE_TONE_PRESETS,
  IMAGE_TONE_PRESET_IDS,
  IMAGE_TONE_PRESET_VERSION,
  imageTonePreset,
  matchingImageTonePreset,
} from "../src/image-quality/imageTonePresets.ts";

test("built-in tone presets have unique stable identities and bounded complete recipes", () => {
  assert.equal(IMAGE_TONE_PRESETS.length, IMAGE_TONE_PRESET_IDS.length);
  assert.equal(new Set(IMAGE_TONE_PRESETS.map((preset) => preset.id)).size, IMAGE_TONE_PRESETS.length);
  for (const preset of IMAGE_TONE_PRESETS) {
    assert.equal(preset.version, IMAGE_TONE_PRESET_VERSION);
    assert.ok(preset.label.length > 0);
    assert.ok(preset.description.length > 0);
    assert.equal(sameToneRecipe(preset.recipe, sanitizeToneRecipe(preset.recipe)), true);
  }
});

test("preset lookup returns an isolated expanded recipe and detects exact matches only", () => {
  const first = imageTonePreset("gentle-detail");
  const second = imageTonePreset("gentle-detail");
  assert.notEqual(first.recipe, second.recipe);
  assert.equal(matchingImageTonePreset(first.recipe)?.id, "gentle-detail");
  first.recipe.clarity += 1;
  assert.equal(matchingImageTonePreset(first.recipe), null);
  assert.equal(matchingImageTonePreset(second.recipe)?.version, IMAGE_TONE_PRESET_VERSION);
});

test("the built-in recipes remain explicit deterministic settings rather than executable effects", () => {
  const preset = imageTonePreset("balanced-light");
  assert.deepEqual(Object.keys(preset.recipe).sort(), [
    "blacks", "brightness", "clarity", "contrast", "curveBlack", "curveHighlights", "curveMidtones",
    "curveShadows", "curveWhite", "dehaze", "exposure", "gamma", "highlightRecovery", "highlights",
    "levelBlack", "levelMidtone", "levelWhite", "localContrast", "shadowRecovery", "shadows", "texture",
    "whites",
  ]);
  assert.equal(preset.recipe.shadowRecovery, 14);
  assert.equal(preset.recipe.highlightRecovery, 14);
  assert.equal(preset.recipe.localContrast, 6);
});
