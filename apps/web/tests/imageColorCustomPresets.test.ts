import assert from "node:assert/strict";
import test from "node:test";

import { createNeutralColorRecipe } from "../src/image-quality/imageColor.ts";
import {
  addImageColorCustomPreset,
  IMAGE_COLOR_CUSTOM_PRESET_RECIPE_VERSION,
  IMAGE_COLOR_CUSTOM_PRESET_SCHEMA_VERSION,
  IMAGE_COLOR_CUSTOM_PRESET_STORAGE_KEY,
  isPortableImageColorRecipe,
  MAX_IMAGE_COLOR_CUSTOM_PRESETS,
  MAX_IMAGE_COLOR_CUSTOM_PRESET_STORAGE_CHARACTERS,
  parseImageColorCustomPresets,
  persistImageColorCustomPresets,
  readImageColorCustomPresets,
  removeImageColorCustomPreset,
  renameImageColorCustomPreset,
} from "../src/image-quality/imageColorCustomPresets.ts";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

function portableRecipe() {
  const recipe = createNeutralColorRecipe();
  recipe.temperature = 5;
  recipe.vibrance = 11;
  recipe.selectiveHsl.blue.saturation = 9;
  recipe.colorGrading.shadows = { hue: 215, saturation: 4, luminance: -2 };
  return recipe;
}

test("custom colour presets persist as a versioned bounded portable recipe collection", () => {
  const storage = memoryStorage();
  const presets = addImageColorCustomPreset([], "  Cool   detail  ", portableRecipe(), "preset-one");
  persistImageColorCustomPresets(storage, presets);

  const envelope = JSON.parse(storage.values.get(IMAGE_COLOR_CUSTOM_PRESET_STORAGE_KEY)!) as Record<string, any>;
  assert.equal(envelope.version, IMAGE_COLOR_CUSTOM_PRESET_SCHEMA_VERSION);
  assert.equal(envelope.presets[0].recipeVersion, IMAGE_COLOR_CUSTOM_PRESET_RECIPE_VERSION);
  assert.equal(envelope.presets[0].name, "Cool detail");
  assert.deepEqual(readImageColorCustomPresets(storage), presets);
  assert.notEqual(readImageColorCustomPresets(storage)[0]!.recipe, presets[0]!.recipe);
  assert.notEqual(readImageColorCustomPresets(storage)[0]!.recipe.selectiveHsl, presets[0]!.recipe.selectiveHsl);
});

test("custom colour preset parsing rejects obsolete, unsafe and non-portable entries", () => {
  const valid = addImageColorCustomPreset([], "Cool detail", portableRecipe(), "preset-valid")[0]!;
  const unsafe = { ...valid, id: "preset-unsafe", name: "Unsafe", recipe: { ...valid.recipe, vibrance: 500 } };
  const extra = {
    ...valid,
    id: "preset-extra",
    name: "Extra",
    recipe: { ...valid.recipe, colorGrading: { ...valid.recipe.colorGrading, futureRange: { hue: 1, saturation: 1, luminance: 1 } } },
  };
  const sampledRecipe = portableRecipe();
  sampledRecipe.pointColor = { ...sampledRecipe.pointColor, enabled: true, targetHue: 230 };
  const sampled = { ...valid, id: "preset-sampled", name: "Sampled", recipe: sampledRecipe };
  const unknownPresetField = { ...valid, id: "preset-field", name: "Field", futureSetting: true };
  const duplicateName = { ...valid, id: "preset-duplicate", name: "COOL DETAIL" };
  const duplicateId = { ...valid, name: "Other" };
  const parsed = parseImageColorCustomPresets(JSON.stringify({
    version: IMAGE_COLOR_CUSTOM_PRESET_SCHEMA_VERSION,
    presets: [valid, unsafe, extra, sampled, unknownPresetField, duplicateName, duplicateId],
  }));
  assert.deepEqual(parsed, [valid]);
  assert.deepEqual(parseImageColorCustomPresets(JSON.stringify({
    version: IMAGE_COLOR_CUSTOM_PRESET_SCHEMA_VERSION,
    presets: [valid],
    futureField: true,
  })), []);
  assert.deepEqual(parseImageColorCustomPresets(JSON.stringify({ version: 0, presets: [valid] })), []);
  assert.deepEqual(parseImageColorCustomPresets("{broken"), []);
  assert.deepEqual(parseImageColorCustomPresets("x".repeat(MAX_IMAGE_COLOR_CUSTOM_PRESET_STORAGE_CHARACTERS + 1)), []);
});

test("source-bound colour evidence cannot be saved as a portable preset", () => {
  const sampled = portableRecipe();
  sampled.pointColor = { ...sampled.pointColor, enabled: true, targetHue: 180 };
  assert.equal(isPortableImageColorRecipe(sampled), false);
  assert.throws(
    () => addImageColorCustomPreset([], "Sampled", sampled, "preset-sampled"),
    /Only portable colour settings/,
  );

  const protectedRecipe = portableRecipe();
  protectedRecipe.protectedColors = [{
    enabled: true,
    kind: "brand",
    sourceX: 2,
    sourceY: 3,
    radius: 2,
    visiblePixels: 9,
    red: 20,
    green: 100,
    blue: 180,
    hue: 210,
    saturation: 80,
    lightness: 39,
    tolerance: 12,
    feather: 10,
    strength: 80,
    sourceBaseSha256: "a".repeat(64),
  }];
  assert.equal(isPortableImageColorRecipe(protectedRecipe), false);
});

test("add, rename, limits and deletion preserve unique immutable colour presets", () => {
  const first = addImageColorCustomPreset([], "Cool detail", portableRecipe(), "preset-first");
  const secondRecipe = portableRecipe();
  secondRecipe.temperature = -5;
  assert.throws(
    () => addImageColorCustomPreset(first, " cool detail ", secondRecipe, "preset-second"),
    /already exists/,
  );
  assert.throws(
    () => addImageColorCustomPreset(first, "Same recipe", first[0]!.recipe, "preset-second"),
    /already saved/,
  );
  const second = addImageColorCustomPreset(first, "Cooler", secondRecipe, "preset-second");
  assert.throws(() => renameImageColorCustomPreset(second, "preset-second", "COOL DETAIL"), /already exists/);
  const renamed = renameImageColorCustomPreset(second, "preset-second", " Blue finish ");
  assert.equal(renamed[1]!.name, "Blue finish");
  assert.equal(second[1]!.name, "Cooler");

  let presets = [] as ReturnType<typeof addImageColorCustomPreset>;
  for (let index = 0; index < MAX_IMAGE_COLOR_CUSTOM_PRESETS; index += 1) {
    const recipe = createNeutralColorRecipe();
    recipe.vibrance = index - 50;
    presets = addImageColorCustomPreset(presets, `Preset ${index + 1}`, recipe, `preset-${index + 1}`);
  }
  assert.throws(
    () => addImageColorCustomPreset(presets, "Too many", portableRecipe(), "preset-overflow"),
    /up to 24/,
  );
  const removed = removeImageColorCustomPreset(presets, "preset-1");
  assert.equal(removed.length, MAX_IMAGE_COLOR_CUSTOM_PRESETS - 1);
  assert.equal(presets.length, MAX_IMAGE_COLOR_CUSTOM_PRESETS);
  assert.throws(() => removeImageColorCustomPreset(removed, "preset-1"), /no longer available/);
});
