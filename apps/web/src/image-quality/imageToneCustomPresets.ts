import {
  sameToneRecipe,
  sanitizeToneRecipe,
  type ImageToneRecipe,
} from "./imageTone.ts";

export const IMAGE_TONE_CUSTOM_PRESET_SCHEMA_VERSION = 1;
export const IMAGE_TONE_CUSTOM_PRESET_RECIPE_VERSION = 8;
export const IMAGE_TONE_CUSTOM_PRESET_STORAGE_KEY = `ipw-image-tone-presets:v${IMAGE_TONE_CUSTOM_PRESET_SCHEMA_VERSION}`;
export const MAX_IMAGE_TONE_CUSTOM_PRESETS = 24;
export const MAX_IMAGE_TONE_CUSTOM_PRESET_NAME_LENGTH = 48;
export const MAX_IMAGE_TONE_CUSTOM_PRESET_STORAGE_CHARACTERS = 131_072;

export interface ImageToneCustomPreset {
  id: string;
  name: string;
  recipeVersion: typeof IMAGE_TONE_CUSTOM_PRESET_RECIPE_VERSION;
  recipe: ImageToneRecipe;
}

interface ImageToneCustomPresetEnvelope {
  version: typeof IMAGE_TONE_CUSTOM_PRESET_SCHEMA_VERSION;
  presets: ImageToneCustomPreset[];
}

type PresetStorageReader = Pick<Storage, "getItem">;
type PresetStorageWriter = Pick<Storage, "setItem">;

const CUSTOM_PRESET_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function normalizeImageToneCustomPresetName(value: string): string {
  const name = value.trim().replace(/\s+/g, " ");
  if (!name) throw new Error("Enter a name for this preset.");
  if (name.length > MAX_IMAGE_TONE_CUSTOM_PRESET_NAME_LENGTH) {
    throw new Error(`Preset names must be ${MAX_IMAGE_TONE_CUSTOM_PRESET_NAME_LENGTH} characters or fewer.`);
  }
  if (CONTROL_CHARACTERS.test(name)) throw new Error("Preset names cannot contain control characters.");
  return name;
}

function validRecipe(value: unknown): value is ImageToneRecipe {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Record<keyof ImageToneRecipe, unknown>>;
  const safe = sanitizeToneRecipe(candidate as ImageToneRecipe);
  const keys = Object.keys(candidate);
  const safeKeys = Object.keys(safe) as Array<keyof ImageToneRecipe>;
  return keys.length === safeKeys.length && safeKeys.every((key) => (
    typeof candidate[key] === "number"
      && Number.isFinite(candidate[key])
      && candidate[key] === safe[key]
  ));
}

function validPreset(value: unknown): value is ImageToneCustomPreset {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ImageToneCustomPreset>;
  if (typeof candidate.id !== "string" || !CUSTOM_PRESET_ID.test(candidate.id)) return false;
  if (candidate.recipeVersion !== IMAGE_TONE_CUSTOM_PRESET_RECIPE_VERSION) return false;
  if (typeof candidate.name !== "string" || !validRecipe(candidate.recipe)) return false;
  try {
    return normalizeImageToneCustomPresetName(candidate.name) === candidate.name;
  } catch {
    return false;
  }
}

export function parseImageToneCustomPresets(raw: string | null): ImageToneCustomPreset[] {
  if (!raw || raw.length > MAX_IMAGE_TONE_CUSTOM_PRESET_STORAGE_CHARACTERS) return [];
  try {
    const envelope = JSON.parse(raw) as Partial<ImageToneCustomPresetEnvelope>;
    if (envelope.version !== IMAGE_TONE_CUSTOM_PRESET_SCHEMA_VERSION || !Array.isArray(envelope.presets)) return [];
    const accepted: ImageToneCustomPreset[] = [];
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const value of envelope.presets) {
      if (!validPreset(value)) continue;
      const foldedName = value.name.toLocaleLowerCase("en-US");
      if (ids.has(value.id) || names.has(foldedName)
        || accepted.some((preset) => sameToneRecipe(preset.recipe, value.recipe))) continue;
      ids.add(value.id);
      names.add(foldedName);
      accepted.push({ ...value, recipe: { ...value.recipe } });
      if (accepted.length === MAX_IMAGE_TONE_CUSTOM_PRESETS) break;
    }
    return accepted;
  } catch {
    return [];
  }
}

export function readImageToneCustomPresets(storage: PresetStorageReader): ImageToneCustomPreset[] {
  return parseImageToneCustomPresets(storage.getItem(IMAGE_TONE_CUSTOM_PRESET_STORAGE_KEY));
}

export function persistImageToneCustomPresets(
  storage: PresetStorageWriter,
  presets: readonly ImageToneCustomPreset[],
): void {
  if (presets.length > MAX_IMAGE_TONE_CUSTOM_PRESETS || presets.some((preset) => !validPreset(preset))) {
    throw new Error("The saved preset collection is invalid or exceeds the local limit.");
  }
  const ids = new Set(presets.map((preset) => preset.id));
  const names = new Set(presets.map((preset) => preset.name.toLocaleLowerCase("en-US")));
  if (ids.size !== presets.length || names.size !== presets.length) {
    throw new Error("Saved presets require unique names and identifiers.");
  }
  if (presets.some((preset, index) => presets
    .slice(0, index)
    .some((previous) => sameToneRecipe(previous.recipe, preset.recipe)))) {
    throw new Error("Saved presets require unique tone recipes.");
  }
  const envelope: ImageToneCustomPresetEnvelope = {
    version: IMAGE_TONE_CUSTOM_PRESET_SCHEMA_VERSION,
    presets: presets.map((preset) => ({ ...preset, recipe: { ...preset.recipe } })),
  };
  storage.setItem(IMAGE_TONE_CUSTOM_PRESET_STORAGE_KEY, JSON.stringify(envelope));
}

export function addImageToneCustomPreset(
  presets: readonly ImageToneCustomPreset[],
  nameInput: string,
  recipe: ImageToneRecipe,
  id: string,
): ImageToneCustomPreset[] {
  if (presets.length >= MAX_IMAGE_TONE_CUSTOM_PRESETS) {
    throw new Error(`This browser profile can store up to ${MAX_IMAGE_TONE_CUSTOM_PRESETS} tone presets.`);
  }
  if (!CUSTOM_PRESET_ID.test(id) || presets.some((preset) => preset.id === id)) {
    throw new Error("The new preset identifier is invalid or already used.");
  }
  const name = normalizeImageToneCustomPresetName(nameInput);
  if (presets.some((preset) => preset.name.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US"))) {
    throw new Error(`A preset named “${name}” already exists.`);
  }
  const safeRecipe = sanitizeToneRecipe(recipe);
  if (presets.some((preset) => sameToneRecipe(preset.recipe, safeRecipe))) {
    throw new Error("The current tone recipe is already saved.");
  }
  return [...presets, {
    id,
    name,
    recipeVersion: IMAGE_TONE_CUSTOM_PRESET_RECIPE_VERSION,
    recipe: safeRecipe,
  }];
}

export function renameImageToneCustomPreset(
  presets: readonly ImageToneCustomPreset[],
  id: string,
  nameInput: string,
): ImageToneCustomPreset[] {
  const index = presets.findIndex((preset) => preset.id === id);
  if (index < 0) throw new Error("The preset to rename is no longer available.");
  const name = normalizeImageToneCustomPresetName(nameInput);
  if (presets.some((preset) => preset.id !== id
    && preset.name.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US"))) {
    throw new Error(`A preset named “${name}” already exists.`);
  }
  return presets.map((preset) => preset.id === id ? { ...preset, name, recipe: { ...preset.recipe } } : preset);
}

export function removeImageToneCustomPreset(
  presets: readonly ImageToneCustomPreset[],
  id: string,
): ImageToneCustomPreset[] {
  if (!presets.some((preset) => preset.id === id)) {
    throw new Error("The preset to delete is no longer available.");
  }
  return presets.filter((preset) => preset.id !== id).map((preset) => ({ ...preset, recipe: { ...preset.recipe } }));
}
