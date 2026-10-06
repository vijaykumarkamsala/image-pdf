import {
  isSanitizedEffectsRecipe,
  sameEffectsRecipe,
  sanitizeEffectsRecipe,
  type ImageEffectsRecipe,
} from "./imageEffects.ts";

export const IMAGE_EFFECT_CUSTOM_PRESET_SCHEMA_VERSION = 1;
export const IMAGE_EFFECT_CUSTOM_PRESET_RECIPE_VERSION = 3;
export const IMAGE_EFFECT_CUSTOM_PRESET_STORAGE_KEY = `ipw-image-effect-presets:v${IMAGE_EFFECT_CUSTOM_PRESET_SCHEMA_VERSION}`;
export const MAX_IMAGE_EFFECT_CUSTOM_PRESETS = 24;
export const MAX_IMAGE_EFFECT_CUSTOM_PRESET_NAME_LENGTH = 48;
export const MAX_IMAGE_EFFECT_CUSTOM_PRESET_STORAGE_CHARACTERS = 131_072;

export interface ImageEffectCustomPreset {
  id: string;
  name: string;
  recipeVersion: typeof IMAGE_EFFECT_CUSTOM_PRESET_RECIPE_VERSION;
  recipe: ImageEffectsRecipe;
}

interface ImageEffectCustomPresetEnvelope {
  version: typeof IMAGE_EFFECT_CUSTOM_PRESET_SCHEMA_VERSION;
  presets: ImageEffectCustomPreset[];
}

type PresetStorageReader = Pick<Storage, "getItem">;
type PresetStorageWriter = Pick<Storage, "setItem">;

const CUSTOM_PRESET_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => (
    Object.prototype.hasOwnProperty.call(value, key)
  ));
}

export function normalizeImageEffectCustomPresetName(value: string): string {
  const name = value.trim().replace(/\s+/g, " ");
  if (!name) throw new Error("Enter a name for this preset.");
  if (name.length > MAX_IMAGE_EFFECT_CUSTOM_PRESET_NAME_LENGTH) {
    throw new Error(`Preset names must be ${MAX_IMAGE_EFFECT_CUSTOM_PRESET_NAME_LENGTH} characters or fewer.`);
  }
  if (CONTROL_CHARACTERS.test(name)) throw new Error("Preset names cannot contain control characters.");
  return name;
}

export function isPortableImageEffectsRecipe(value: unknown): value is ImageEffectsRecipe {
  if (!value || typeof value !== "object" || !hasExactKeys(value, ["bloom", "grain", "vignette"])) return false;
  const recipe = value as ImageEffectsRecipe;
  if (!recipe.bloom || typeof recipe.bloom !== "object"
    || !hasExactKeys(recipe.bloom, ["amount", "radius", "threshold"])
    || !recipe.grain || typeof recipe.grain !== "object"
    || !hasExactKeys(recipe.grain, ["amount", "size"])
    || !recipe.vignette || typeof recipe.vignette !== "object"
    || !hasExactKeys(recipe.vignette, ["amount", "midpoint", "feather"])) return false;
  return isSanitizedEffectsRecipe(recipe);
}

function validPreset(value: unknown): value is ImageEffectCustomPreset {
  if (!value || typeof value !== "object"
    || !hasExactKeys(value, ["id", "name", "recipeVersion", "recipe"])) return false;
  const candidate = value as Partial<ImageEffectCustomPreset>;
  if (typeof candidate.id !== "string" || !CUSTOM_PRESET_ID.test(candidate.id)) return false;
  if (candidate.recipeVersion !== IMAGE_EFFECT_CUSTOM_PRESET_RECIPE_VERSION) return false;
  if (typeof candidate.name !== "string" || !isPortableImageEffectsRecipe(candidate.recipe)) return false;
  try {
    return normalizeImageEffectCustomPresetName(candidate.name) === candidate.name;
  } catch {
    return false;
  }
}

function cloneRecipe(recipe: ImageEffectsRecipe): ImageEffectsRecipe {
  return sanitizeEffectsRecipe(recipe);
}

export function parseImageEffectCustomPresets(raw: string | null): ImageEffectCustomPreset[] {
  if (!raw || raw.length > MAX_IMAGE_EFFECT_CUSTOM_PRESET_STORAGE_CHARACTERS) return [];
  try {
    const envelope = JSON.parse(raw) as Partial<ImageEffectCustomPresetEnvelope>;
    if (!envelope || typeof envelope !== "object"
      || !hasExactKeys(envelope, ["version", "presets"])
      || envelope.version !== IMAGE_EFFECT_CUSTOM_PRESET_SCHEMA_VERSION
      || !Array.isArray(envelope.presets)) return [];
    const accepted: ImageEffectCustomPreset[] = [];
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const value of envelope.presets) {
      if (!validPreset(value)) continue;
      const foldedName = value.name.toLocaleLowerCase("en-US");
      if (ids.has(value.id) || names.has(foldedName)
        || accepted.some((preset) => sameEffectsRecipe(preset.recipe, value.recipe))) continue;
      ids.add(value.id);
      names.add(foldedName);
      accepted.push({ ...value, recipe: cloneRecipe(value.recipe) });
      if (accepted.length === MAX_IMAGE_EFFECT_CUSTOM_PRESETS) break;
    }
    return accepted;
  } catch {
    return [];
  }
}

export function readImageEffectCustomPresets(storage: PresetStorageReader): ImageEffectCustomPreset[] {
  return parseImageEffectCustomPresets(storage.getItem(IMAGE_EFFECT_CUSTOM_PRESET_STORAGE_KEY));
}

export function persistImageEffectCustomPresets(
  storage: PresetStorageWriter,
  presets: readonly ImageEffectCustomPreset[],
): void {
  if (presets.length > MAX_IMAGE_EFFECT_CUSTOM_PRESETS || presets.some((preset) => !validPreset(preset))) {
    throw new Error("The saved preset collection is invalid or exceeds the local limit.");
  }
  const ids = new Set(presets.map((preset) => preset.id));
  const names = new Set(presets.map((preset) => preset.name.toLocaleLowerCase("en-US")));
  if (ids.size !== presets.length || names.size !== presets.length) {
    throw new Error("Saved presets require unique names and identifiers.");
  }
  if (presets.some((preset, index) => presets
    .slice(0, index)
    .some((previous) => sameEffectsRecipe(previous.recipe, preset.recipe)))) {
    throw new Error("Saved presets require unique effects recipes.");
  }
  const envelope: ImageEffectCustomPresetEnvelope = {
    version: IMAGE_EFFECT_CUSTOM_PRESET_SCHEMA_VERSION,
    presets: presets.map((preset) => ({ ...preset, recipe: cloneRecipe(preset.recipe) })),
  };
  const serialized = JSON.stringify(envelope);
  if (serialized.length > MAX_IMAGE_EFFECT_CUSTOM_PRESET_STORAGE_CHARACTERS) {
    throw new Error("The saved preset collection exceeds the local storage budget.");
  }
  storage.setItem(IMAGE_EFFECT_CUSTOM_PRESET_STORAGE_KEY, serialized);
}

export function addImageEffectCustomPreset(
  presets: readonly ImageEffectCustomPreset[],
  nameInput: string,
  recipe: ImageEffectsRecipe,
  id: string,
): ImageEffectCustomPreset[] {
  if (presets.length >= MAX_IMAGE_EFFECT_CUSTOM_PRESETS) {
    throw new Error(`This browser profile can store up to ${MAX_IMAGE_EFFECT_CUSTOM_PRESETS} effects presets.`);
  }
  if (!CUSTOM_PRESET_ID.test(id) || presets.some((preset) => preset.id === id)) {
    throw new Error("The new preset identifier is invalid or already used.");
  }
  const name = normalizeImageEffectCustomPresetName(nameInput);
  if (presets.some((preset) => preset.name.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US"))) {
    throw new Error(`A preset named “${name}” already exists.`);
  }
  const safeRecipe = cloneRecipe(recipe);
  if (presets.some((preset) => sameEffectsRecipe(preset.recipe, safeRecipe))) {
    throw new Error("The current effects recipe is already saved.");
  }
  return [...presets, {
    id,
    name,
    recipeVersion: IMAGE_EFFECT_CUSTOM_PRESET_RECIPE_VERSION,
    recipe: safeRecipe,
  }];
}

export function renameImageEffectCustomPreset(
  presets: readonly ImageEffectCustomPreset[],
  id: string,
  nameInput: string,
): ImageEffectCustomPreset[] {
  const index = presets.findIndex((preset) => preset.id === id);
  if (index < 0) throw new Error("The preset to rename is no longer available.");
  const name = normalizeImageEffectCustomPresetName(nameInput);
  if (presets.some((preset) => preset.id !== id
    && preset.name.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US"))) {
    throw new Error(`A preset named “${name}” already exists.`);
  }
  return presets.map((preset) => preset.id === id
    ? { ...preset, name, recipe: cloneRecipe(preset.recipe) }
    : preset);
}

export function removeImageEffectCustomPreset(
  presets: readonly ImageEffectCustomPreset[],
  id: string,
): ImageEffectCustomPreset[] {
  if (!presets.some((preset) => preset.id === id)) {
    throw new Error("The preset to delete is no longer available.");
  }
  return presets
    .filter((preset) => preset.id !== id)
    .map((preset) => ({ ...preset, recipe: cloneRecipe(preset.recipe) }));
}
