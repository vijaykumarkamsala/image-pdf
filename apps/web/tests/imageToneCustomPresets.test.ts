import assert from "node:assert/strict";
import test from "node:test";

import { createNeutralToneRecipe } from "../src/image-quality/imageTone.ts";
import {
  addImageToneCustomPreset,
  IMAGE_TONE_CUSTOM_PRESET_RECIPE_VERSION,
  IMAGE_TONE_CUSTOM_PRESET_SCHEMA_VERSION,
  IMAGE_TONE_CUSTOM_PRESET_STORAGE_KEY,
  MAX_IMAGE_TONE_CUSTOM_PRESETS,
  MAX_IMAGE_TONE_CUSTOM_PRESET_STORAGE_CHARACTERS,
  parseImageToneCustomPresets,
  persistImageToneCustomPresets,
  readImageToneCustomPresets,
  removeImageToneCustomPreset,
  renameImageToneCustomPreset,
} from "../src/image-quality/imageToneCustomPresets.ts";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

test("custom tone presets persist as a versioned bounded recipe collection", () => {
  const storage = memoryStorage();
  const recipe = { ...createNeutralToneRecipe(), clarity: 17, texture: 9 };
  const presets = addImageToneCustomPreset([], "  Fine   detail  ", recipe, "preset-one");
  persistImageToneCustomPresets(storage, presets);

  const envelope = JSON.parse(storage.values.get(IMAGE_TONE_CUSTOM_PRESET_STORAGE_KEY)!) as Record<string, any>;
  assert.equal(envelope.version, IMAGE_TONE_CUSTOM_PRESET_SCHEMA_VERSION);
  assert.equal(envelope.presets[0].recipeVersion, IMAGE_TONE_CUSTOM_PRESET_RECIPE_VERSION);
  assert.equal(envelope.presets[0].name, "Fine detail");
  assert.deepEqual(readImageToneCustomPresets(storage), presets);
  assert.notEqual(readImageToneCustomPresets(storage)[0]!.recipe, presets[0]!.recipe);
});

test("custom tone preset parsing rejects obsolete and unsafe entries without accepting duplicates", () => {
  const valid = addImageToneCustomPreset(
    [],
    "Detail",
    { ...createNeutralToneRecipe(), clarity: 12 },
    "preset-valid",
  )[0]!;
  const unsafe = { ...valid, id: "preset-unsafe", recipe: { ...valid.recipe, clarity: 500 } };
  const duplicateName = { ...valid, id: "preset-duplicate", name: "DETAIL" };
  const duplicateId = { ...valid, name: "Other" };
  const unknownRecipeField = { ...valid, id: "preset-extra", name: "Extra", recipe: { ...valid.recipe, futureEffect: 1 } };
  const parsed = parseImageToneCustomPresets(JSON.stringify({
    version: IMAGE_TONE_CUSTOM_PRESET_SCHEMA_VERSION,
    presets: [valid, unsafe, duplicateName, duplicateId, unknownRecipeField],
  }));
  assert.deepEqual(parsed, [valid]);
  assert.deepEqual(parseImageToneCustomPresets(JSON.stringify({ version: 0, presets: [valid] })), []);
  assert.deepEqual(parseImageToneCustomPresets("{broken"), []);
  assert.deepEqual(parseImageToneCustomPresets("x".repeat(MAX_IMAGE_TONE_CUSTOM_PRESET_STORAGE_CHARACTERS + 1)), []);
});

test("add and rename reject ambiguous names and duplicate recipes", () => {
  const first = addImageToneCustomPreset(
    [],
    "Detail",
    { ...createNeutralToneRecipe(), clarity: 12 },
    "preset-first",
  );
  assert.throws(
    () => addImageToneCustomPreset(first, " detail ", { ...createNeutralToneRecipe(), texture: 4 }, "preset-second"),
    /already exists/,
  );
  assert.throws(
    () => addImageToneCustomPreset(first, "Same recipe", first[0]!.recipe, "preset-second"),
    /already saved/,
  );
  const second = addImageToneCustomPreset(
    first,
    "Texture",
    { ...createNeutralToneRecipe(), texture: 4 },
    "preset-second",
  );
  assert.throws(() => renameImageToneCustomPreset(second, "preset-second", "DETAIL"), /already exists/);
  const renamed = renameImageToneCustomPreset(second, "preset-second", " Texture lift ");
  assert.equal(renamed[1]!.name, "Texture lift");
  assert.equal(second[1]!.name, "Texture");
});

test("custom tone preset limits and deletion are explicit and immutable", () => {
  let presets = [] as ReturnType<typeof addImageToneCustomPreset>;
  for (let index = 0; index < MAX_IMAGE_TONE_CUSTOM_PRESETS; index += 1) {
    presets = addImageToneCustomPreset(
      presets,
      `Preset ${index + 1}`,
      { ...createNeutralToneRecipe(), clarity: index - 50 },
      `preset-${index + 1}`,
    );
  }
  assert.throws(
    () => addImageToneCustomPreset(presets, "Too many", createNeutralToneRecipe(), "preset-overflow"),
    /up to 24/,
  );
  const removed = removeImageToneCustomPreset(presets, "preset-1");
  assert.equal(removed.length, MAX_IMAGE_TONE_CUSTOM_PRESETS - 1);
  assert.equal(presets.length, MAX_IMAGE_TONE_CUSTOM_PRESETS);
  assert.throws(() => removeImageToneCustomPreset(removed, "preset-1"), /no longer available/);
});
