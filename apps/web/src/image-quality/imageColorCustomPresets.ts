import {
  createNeutralColorRecipe,
  isSanitizedColorRecipe,
  sameColorRecipe,
  sanitizeColorRecipe,
  type ImageColorRecipe,
} from "./imageColor.ts";

export const IMAGE_COLOR_CUSTOM_PRESET_SCHEMA_VERSION = 1;
export const IMAGE_COLOR_CUSTOM_PRESET_RECIPE_VERSION = 10;
export const IMAGE_COLOR_CUSTOM_PRESET_STORAGE_KEY = `ipw-image-color-presets:v${IMAGE_COLOR_CUSTOM_PRESET_SCHEMA_VERSION}`;
export const MAX_IMAGE_COLOR_CUSTOM_PRESETS = 24;
export const MAX_IMAGE_COLOR_CUSTOM_PRESET_NAME_LENGTH = 48;
export const MAX_IMAGE_COLOR_CUSTOM_PRESET_STORAGE_CHARACTERS = 262_144;

export interface ImageColorCustomPreset {
  id: string;
  name: string;
  recipeVersion: typeof IMAGE_COLOR_CUSTOM_PRESET_RECIPE_VERSION;
  recipe: ImageColorRecipe;
}

interface ImageColorCustomPresetEnvelope {
  version: typeof IMAGE_COLOR_CUSTOM_PRESET_SCHEMA_VERSION;
  presets: ImageColorCustomPreset[];
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

export function normalizeImageColorCustomPresetName(value: string): string {
  const name = value.trim().replace(/\s+/g, " ");
  if (!name) throw new Error("Enter a name for this preset.");
  if (name.length > MAX_IMAGE_COLOR_CUSTOM_PRESET_NAME_LENGTH) {
    throw new Error(`Preset names must be ${MAX_IMAGE_COLOR_CUSTOM_PRESET_NAME_LENGTH} characters or fewer.`);
  }
  if (CONTROL_CHARACTERS.test(name)) throw new Error("Preset names cannot contain control characters.");
  return name;
}

function sameSerializableValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameSerializableValue(value, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length && rightKeys.every((key) => (
    Object.prototype.hasOwnProperty.call(leftRecord, key)
      && sameSerializableValue(leftRecord[key], rightRecord[key])
  ));
}

export function hasSourceBoundImageColorSettings(recipe: ImageColorRecipe): boolean {
  const safe = sanitizeColorRecipe(recipe);
  const neutralPointColor = createNeutralColorRecipe().pointColor;
  return !sameSerializableValue(safe.pointColor, neutralPointColor)
    || safe.colorMatch !== null
    || safe.cubeLut !== null
    || safe.protectedColors.length > 0;
}

export function isPortableImageColorRecipe(value: unknown): value is ImageColorRecipe {
  if (!value || typeof value !== "object") return false;
  const recipe = value as ImageColorRecipe;
  const safe = sanitizeColorRecipe(recipe);
  return sameSerializableValue(recipe, safe)
    && isSanitizedColorRecipe(safe)
    && !hasSourceBoundImageColorSettings(safe);
}

function validPreset(value: unknown): value is ImageColorCustomPreset {
  if (!value || typeof value !== "object") return false;
  if (!hasExactKeys(value, ["id", "name", "recipeVersion", "recipe"])) return false;
  const candidate = value as Partial<ImageColorCustomPreset>;
  if (typeof candidate.id !== "string" || !CUSTOM_PRESET_ID.test(candidate.id)) return false;
  if (candidate.recipeVersion !== IMAGE_COLOR_CUSTOM_PRESET_RECIPE_VERSION) return false;
  if (typeof candidate.name !== "string" || !isPortableImageColorRecipe(candidate.recipe)) return false;
  try {
    return normalizeImageColorCustomPresetName(candidate.name) === candidate.name;
  } catch {
    return false;
  }
}

function cloneRecipe(recipe: ImageColorRecipe): ImageColorRecipe {
  return sanitizeColorRecipe(recipe);
}

export function parseImageColorCustomPresets(raw: string | null): ImageColorCustomPreset[] {
  if (!raw || raw.length > MAX_IMAGE_COLOR_CUSTOM_PRESET_STORAGE_CHARACTERS) return [];
  try {
    const envelope = JSON.parse(raw) as Partial<ImageColorCustomPresetEnvelope>;
    if (!envelope || typeof envelope !== "object"
      || !hasExactKeys(envelope, ["version", "presets"])
      || envelope.version !== IMAGE_COLOR_CUSTOM_PRESET_SCHEMA_VERSION
      || !Array.isArray(envelope.presets)) return [];
    const accepted: ImageColorCustomPreset[] = [];
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const value of envelope.presets) {
      if (!validPreset(value)) continue;
      const foldedName = value.name.toLocaleLowerCase("en-US");
      if (ids.has(value.id) || names.has(foldedName)
        || accepted.some((preset) => sameColorRecipe(preset.recipe, value.recipe))) continue;
      ids.add(value.id);
      names.add(foldedName);
      accepted.push({ ...value, recipe: cloneRecipe(value.recipe) });
      if (accepted.length === MAX_IMAGE_COLOR_CUSTOM_PRESETS) break;
    }
    return accepted;
  } catch {
    return [];
  }
}

export function readImageColorCustomPresets(storage: PresetStorageReader): ImageColorCustomPreset[] {
  return parseImageColorCustomPresets(storage.getItem(IMAGE_COLOR_CUSTOM_PRESET_STORAGE_KEY));
}

export function persistImageColorCustomPresets(
  storage: PresetStorageWriter,
  presets: readonly ImageColorCustomPreset[],
): void {
  if (presets.length > MAX_IMAGE_COLOR_CUSTOM_PRESETS || presets.some((preset) => !validPreset(preset))) {
    throw new Error("The saved preset collection is invalid or exceeds the local limit.");
  }
  const ids = new Set(presets.map((preset) => preset.id));
  const names = new Set(presets.map((preset) => preset.name.toLocaleLowerCase("en-US")));
  if (ids.size !== presets.length || names.size !== presets.length) {
    throw new Error("Saved presets require unique names and identifiers.");
  }
  if (presets.some((preset, index) => presets
    .slice(0, index)
    .some((previous) => sameColorRecipe(previous.recipe, preset.recipe)))) {
    throw new Error("Saved presets require unique colour recipes.");
  }
  const envelope: ImageColorCustomPresetEnvelope = {
    version: IMAGE_COLOR_CUSTOM_PRESET_SCHEMA_VERSION,
    presets: presets.map((preset) => ({ ...preset, recipe: cloneRecipe(preset.recipe) })),
  };
  const serialized = JSON.stringify(envelope);
  if (serialized.length > MAX_IMAGE_COLOR_CUSTOM_PRESET_STORAGE_CHARACTERS) {
    throw new Error("The saved preset collection exceeds the local storage budget.");
  }
  storage.setItem(IMAGE_COLOR_CUSTOM_PRESET_STORAGE_KEY, serialized);
}

export function addImageColorCustomPreset(
  presets: readonly ImageColorCustomPreset[],
  nameInput: string,
  recipe: ImageColorRecipe,
  id: string,
): ImageColorCustomPreset[] {
  if (presets.length >= MAX_IMAGE_COLOR_CUSTOM_PRESETS) {
    throw new Error(`This browser profile can store up to ${MAX_IMAGE_COLOR_CUSTOM_PRESETS} colour presets.`);
  }
  if (!CUSTOM_PRESET_ID.test(id) || presets.some((preset) => preset.id === id)) {
    throw new Error("The new preset identifier is invalid or already used.");
  }
  const name = normalizeImageColorCustomPresetName(nameInput);
  if (presets.some((preset) => preset.name.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US"))) {
    throw new Error(`A preset named “${name}” already exists.`);
  }
  if (!isPortableImageColorRecipe(recipe)) {
    throw new Error("Only portable colour settings can be saved. Clear sampled colours, reference matching, LUTs and protected-colour anchors first.");
  }
  const safeRecipe = cloneRecipe(recipe);
  if (presets.some((preset) => sameColorRecipe(preset.recipe, safeRecipe))) {
    throw new Error("The current colour recipe is already saved.");
  }
  return [...presets, {
    id,
    name,
    recipeVersion: IMAGE_COLOR_CUSTOM_PRESET_RECIPE_VERSION,
    recipe: safeRecipe,
  }];
}

export function renameImageColorCustomPreset(
  presets: readonly ImageColorCustomPreset[],
  id: string,
  nameInput: string,
): ImageColorCustomPreset[] {
  const index = presets.findIndex((preset) => preset.id === id);
  if (index < 0) throw new Error("The preset to rename is no longer available.");
  const name = normalizeImageColorCustomPresetName(nameInput);
  if (presets.some((preset) => preset.id !== id
    && preset.name.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US"))) {
    throw new Error(`A preset named “${name}” already exists.`);
  }
  return presets.map((preset) => preset.id === id
    ? { ...preset, name, recipe: cloneRecipe(preset.recipe) }
    : preset);
}

export function removeImageColorCustomPreset(
  presets: readonly ImageColorCustomPreset[],
  id: string,
): ImageColorCustomPreset[] {
  if (!presets.some((preset) => preset.id === id)) {
    throw new Error("The preset to delete is no longer available.");
  }
  return presets
    .filter((preset) => preset.id !== id)
    .map((preset) => ({ ...preset, recipe: cloneRecipe(preset.recipe) }));
}
