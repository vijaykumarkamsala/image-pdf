import {
  createNeutralToneRecipe,
  sameToneRecipe,
  sanitizeToneRecipe,
  type ImageToneRecipe,
} from "./imageTone";

export const IMAGE_TONE_PRESET_VERSION = "1.0.0";

export const IMAGE_TONE_PRESET_IDS = [
  "balanced-light",
  "gentle-detail",
  "soft-finish",
  "clear-atmosphere",
] as const;

export type ImageTonePresetId = typeof IMAGE_TONE_PRESET_IDS[number];

export interface ImageTonePreset {
  id: ImageTonePresetId;
  version: string;
  label: string;
  description: string;
  intent: "corrective" | "creative";
  recipe: ImageToneRecipe;
}

function preset(
  id: ImageTonePresetId,
  label: string,
  description: string,
  intent: ImageTonePreset["intent"],
  values: Partial<ImageToneRecipe>,
): ImageTonePreset {
  return {
    id,
    version: IMAGE_TONE_PRESET_VERSION,
    label,
    description,
    intent,
    recipe: sanitizeToneRecipe({ ...createNeutralToneRecipe(), ...values }),
  };
}

export const IMAGE_TONE_PRESETS: readonly ImageTonePreset[] = [
  preset(
    "balanced-light",
    "Balanced light",
    "Opens compressed shadows and highlights with restrained global contrast.",
    "corrective",
    { shadowRecovery: 14, highlightRecovery: 14, localContrast: 6, contrast: 5, highlights: -8, shadows: 8 },
  ),
  preset(
    "gentle-detail",
    "Gentle detail",
    "Adds bounded neighbourhood definition without pixel sharpening.",
    "corrective",
    { localContrast: 10, clarity: 8, texture: 6, contrast: 4 },
  ),
  preset(
    "soft-finish",
    "Soft finish",
    "Softens medium and fine tonal texture while retaining the source framing and colour.",
    "creative",
    { localContrast: -5, clarity: -10, texture: -8, contrast: -4, highlights: -4, shadows: 4 },
  ),
  preset(
    "clear-atmosphere",
    "Clear atmosphere",
    "Applies conservative veil reduction with protected highlight and shadow recovery.",
    "corrective",
    { shadowRecovery: 8, highlightRecovery: 10, localContrast: 8, clarity: 5, dehaze: 8, contrast: 4 },
  ),
];

export function imageTonePreset(id: ImageTonePresetId): ImageTonePreset {
  const match = IMAGE_TONE_PRESETS.find((item) => item.id === id);
  if (!match) throw new Error("The selected built-in tone preset is unavailable.");
  return { ...match, recipe: { ...match.recipe } };
}

export function matchingImageTonePreset(recipe: ImageToneRecipe): ImageTonePreset | null {
  return IMAGE_TONE_PRESETS.find((item) => sameToneRecipe(item.recipe, recipe)) ?? null;
}
