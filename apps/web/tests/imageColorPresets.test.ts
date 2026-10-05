import assert from "node:assert/strict";
import test from "node:test";

import {
  applyColorToRgba,
  isNeutralColor,
  isSanitizedColorRecipe,
} from "../src/image-quality/imageColor.ts";
import {
  IMAGE_COLOR_PRESETS,
  IMAGE_COLOR_PRESET_IDS,
  IMAGE_COLOR_PRESET_VERSION,
  imageColorPreset,
  matchingImageColorPreset,
} from "../src/image-quality/imageColorPresets.ts";

test("built-in colour presets have stable identities and complete safe recipes", () => {
  assert.equal(IMAGE_COLOR_PRESETS.length, IMAGE_COLOR_PRESET_IDS.length);
  assert.equal(new Set(IMAGE_COLOR_PRESETS.map((preset) => preset.id)).size, IMAGE_COLOR_PRESETS.length);
  for (const preset of IMAGE_COLOR_PRESETS) {
    assert.equal(preset.version, IMAGE_COLOR_PRESET_VERSION);
    assert.ok(preset.label.length > 0);
    assert.ok(preset.description.length > 0);
    assert.equal(isSanitizedColorRecipe(preset.recipe), true);
    assert.equal(isNeutralColor(preset.recipe), false);
    assert.equal(preset.recipe.pointColor.enabled, false);
    assert.equal(preset.recipe.colorMatch, null);
    assert.equal(preset.recipe.cubeLut, null);
    assert.deepEqual(preset.recipe.protectedColors, []);
  }
});

test("colour preset lookup returns an isolated recipe and detects exact matches only", () => {
  const first = imageColorPreset("muted-editorial");
  const second = imageColorPreset("muted-editorial");
  assert.notEqual(first.recipe, second.recipe);
  assert.notEqual(first.recipe.colorGrading, second.recipe.colorGrading);
  assert.equal(matchingImageColorPreset(first.recipe)?.id, "muted-editorial");
  first.recipe.colorGrading.shadows.saturation += 1;
  assert.equal(matchingImageColorPreset(first.recipe), null);
  assert.equal(matchingImageColorPreset(second.recipe)?.version, IMAGE_COLOR_PRESET_VERSION);
});

test("built-in colour looks produce deterministic distinct pixels without external data", () => {
  const source = new Uint8ClampedArray([
    180, 90, 40, 255,
    20, 100, 180, 255,
    120, 160, 80, 255,
    100, 100, 100, 255,
  ]);
  const outputs = IMAGE_COLOR_PRESETS.map((preset) => {
    const first = source.slice();
    const second = source.slice();
    applyColorToRgba(first, preset.recipe);
    applyColorToRgba(second, preset.recipe);
    assert.deepEqual(first, second);
    assert.notDeepEqual(first, source);
    return Buffer.from(first).toString("hex");
  });
  assert.equal(new Set(outputs).size, IMAGE_COLOR_PRESETS.length);
});

test("published colour preset settings remain reviewable data", () => {
  const natural = imageColorPreset("natural-vibrance").recipe;
  assert.equal(natural.temperature, 4);
  assert.equal(natural.tint, 1);
  assert.equal(natural.saturation, 2);
  assert.equal(natural.vibrance, 12);
  const monochrome = imageColorPreset("balanced-monochrome").recipe;
  assert.deepEqual(monochrome.blackAndWhite, { enabled: true, red: 45, green: 40, blue: 15 });
});
