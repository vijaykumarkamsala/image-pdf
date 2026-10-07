import assert from "node:assert/strict";
import test from "node:test";

import { createNeutralEffectsRecipe } from "../src/image-quality/imageEffects.ts";
import {
  addImageEffectCustomPreset,
  IMAGE_EFFECT_CUSTOM_PRESET_RECIPE_VERSION,
  IMAGE_EFFECT_CUSTOM_PRESET_SCHEMA_VERSION,
  IMAGE_EFFECT_CUSTOM_PRESET_STORAGE_KEY,
  MAX_IMAGE_EFFECT_CUSTOM_PRESETS,
  MAX_IMAGE_EFFECT_CUSTOM_PRESET_STORAGE_CHARACTERS,
  parseImageEffectCustomPresets,
  persistImageEffectCustomPresets,
  readImageEffectCustomPresets,
  removeImageEffectCustomPreset,
  renameImageEffectCustomPreset,
} from "../src/image-quality/imageEffectCustomPresets.ts";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

function customRecipe() {
  const recipe = createNeutralEffectsRecipe();
  recipe.bloom = { amount: 19, radius: 6, threshold: 78 };
  recipe.grain = { amount: 13, size: 3 };
  recipe.vignette = { amount: -21, midpoint: 57, feather: 73 };
  return recipe;
}

test("custom effects presets persist as a versioned bounded recipe collection", () => {
  const storage = memoryStorage();
  const presets = addImageEffectCustomPreset([], "  Quiet   finish  ", customRecipe(), "preset-one");
  persistImageEffectCustomPresets(storage, presets);

  const envelope = JSON.parse(storage.values.get(IMAGE_EFFECT_CUSTOM_PRESET_STORAGE_KEY)!) as Record<string, any>;
  assert.equal(envelope.version, IMAGE_EFFECT_CUSTOM_PRESET_SCHEMA_VERSION);
  assert.equal(envelope.presets[0].recipeVersion, IMAGE_EFFECT_CUSTOM_PRESET_RECIPE_VERSION);
  assert.equal(envelope.presets[0].name, "Quiet finish");
  assert.deepEqual(readImageEffectCustomPresets(storage), presets);
  const reloaded = readImageEffectCustomPresets(storage)[0]!;
  assert.notEqual(reloaded.recipe, presets[0]!.recipe);
  assert.notEqual(reloaded.recipe.bloom, presets[0]!.recipe.bloom);
  assert.notEqual(reloaded.recipe.halftone, presets[0]!.recipe.halftone);
  assert.notEqual(reloaded.recipe.grain, presets[0]!.recipe.grain);
  assert.notEqual(reloaded.recipe.vignette, presets[0]!.recipe.vignette);
});

test("custom effects preset parsing migrates safe v3 and v4 recipes and rejects malformed or duplicate entries", () => {
  const valid = addImageEffectCustomPreset([], "Quiet finish", customRecipe(), "preset-valid")[0]!;
  const unsafe = {
    ...valid,
    id: "preset-unsafe",
    name: "Unsafe",
    recipe: { ...valid.recipe, grain: { ...valid.recipe.grain, amount: 500 } },
  };
  const unknownRecipeField = {
    ...valid,
    id: "preset-recipe-field",
    name: "Recipe field",
    recipe: { ...valid.recipe, futureEffect: 1 },
  };
  const unknownNestedField = {
    ...valid,
    id: "preset-nested-field",
    name: "Nested field",
    recipe: { ...valid.recipe, bloom: { ...valid.recipe.bloom, futureEffect: 1 } },
  };
  const unknownPresetField = { ...valid, id: "preset-field", name: "Field", futureSetting: true };
  const duplicateName = { ...valid, id: "preset-duplicate", name: "QUIET FINISH" };
  const duplicateId = { ...valid, name: "Other" };
  const parsed = parseImageEffectCustomPresets(JSON.stringify({
    version: IMAGE_EFFECT_CUSTOM_PRESET_SCHEMA_VERSION,
    presets: [valid, unsafe, unknownRecipeField, unknownNestedField, unknownPresetField, duplicateName, duplicateId],
  }));
  assert.deepEqual(parsed, [valid]);
  assert.deepEqual(parseImageEffectCustomPresets(JSON.stringify({
    version: IMAGE_EFFECT_CUSTOM_PRESET_SCHEMA_VERSION,
    presets: [valid],
    futureEnvelope: true,
  })), []);
  assert.deepEqual(parseImageEffectCustomPresets(JSON.stringify({ version: 0, presets: [valid] })), []);
  assert.deepEqual(parseImageEffectCustomPresets("{broken"), []);
  assert.deepEqual(parseImageEffectCustomPresets("x".repeat(MAX_IMAGE_EFFECT_CUSTOM_PRESET_STORAGE_CHARACTERS + 1)), []);

  const { posterize: _posterize, halftone: _halftone, ...legacyV3Recipe } = valid.recipe;
  const migratedV3 = parseImageEffectCustomPresets(JSON.stringify({
    version: IMAGE_EFFECT_CUSTOM_PRESET_SCHEMA_VERSION,
    presets: [{ ...valid, recipeVersion: 3, recipe: legacyV3Recipe }],
  }));
  assert.deepEqual(migratedV3, [{
    ...valid,
    recipeVersion: IMAGE_EFFECT_CUSTOM_PRESET_RECIPE_VERSION,
    recipe: {
      ...legacyV3Recipe,
      posterize: { levels: 256 },
      halftone: { amount: 0, size: 8, angle: 45 },
    },
  }]);

  const { halftone: _legacyHalftone, ...legacyV4Recipe } = valid.recipe;
  const migratedV4 = parseImageEffectCustomPresets(JSON.stringify({
    version: IMAGE_EFFECT_CUSTOM_PRESET_SCHEMA_VERSION,
    presets: [{ ...valid, recipeVersion: 4, recipe: legacyV4Recipe }],
  }));
  assert.deepEqual(migratedV4, [{
    ...valid,
    recipeVersion: IMAGE_EFFECT_CUSTOM_PRESET_RECIPE_VERSION,
    recipe: { ...legacyV4Recipe, halftone: { amount: 0, size: 8, angle: 45 } },
  }]);
});

test("custom effects presets reject ambiguous names and duplicate recipes", () => {
  const first = addImageEffectCustomPreset([], "Quiet finish", customRecipe(), "preset-first");
  const secondRecipe = customRecipe();
  secondRecipe.grain.amount = 25;
  assert.throws(
    () => addImageEffectCustomPreset(first, " quiet finish ", secondRecipe, "preset-second"),
    /already exists/,
  );
  assert.throws(
    () => addImageEffectCustomPreset(first, "Same recipe", first[0]!.recipe, "preset-second"),
    /already saved/,
  );
  const second = addImageEffectCustomPreset(first, "Textured", secondRecipe, "preset-second");
  assert.throws(() => renameImageEffectCustomPreset(second, "preset-second", "QUIET FINISH"), /already exists/);
  const renamed = renameImageEffectCustomPreset(second, "preset-second", " Textured frame ");
  assert.equal(renamed[1]!.name, "Textured frame");
  assert.equal(second[1]!.name, "Textured");
});

test("custom effects preset limits and deletion are explicit and immutable", () => {
  let presets = [] as ReturnType<typeof addImageEffectCustomPreset>;
  for (let index = 0; index < MAX_IMAGE_EFFECT_CUSTOM_PRESETS; index += 1) {
    const recipe = createNeutralEffectsRecipe();
    recipe.grain.amount = index + 1;
    presets = addImageEffectCustomPreset(presets, `Preset ${index + 1}`, recipe, `preset-${index + 1}`);
  }
  assert.throws(
    () => addImageEffectCustomPreset(presets, "Too many", customRecipe(), "preset-overflow"),
    /up to 24/,
  );
  const removed = removeImageEffectCustomPreset(presets, "preset-1");
  assert.equal(removed.length, MAX_IMAGE_EFFECT_CUSTOM_PRESETS - 1);
  assert.equal(presets.length, MAX_IMAGE_EFFECT_CUSTOM_PRESETS);
  assert.throws(() => removeImageEffectCustomPreset(removed, "preset-1"), /no longer available/);
});
