import {
  createNeutralEffectsRecipe,
  sameEffectsRecipe,
  sanitizeEffectsRecipe,
  type ImageEffectsRecipe,
} from "./imageEffects.ts";

export const IMAGE_EFFECT_PRESET_VERSION = "1.0.0";

export const IMAGE_EFFECT_PRESET_IDS = [
  "soft-bloom",
  "fine-grain",
  "cinematic-frame",
  "analog-finish",
] as const;

export type ImageEffectPresetId = typeof IMAGE_EFFECT_PRESET_IDS[number];

export interface ImageEffectPreset {
  id: ImageEffectPresetId;
  version: string;
  label: string;
  description: string;
  focus: "Light" | "Texture" | "Frame" | "Combined";
  recipe: ImageEffectsRecipe;
}

function preset(
  id: ImageEffectPresetId,
  label: string,
  description: string,
  focus: ImageEffectPreset["focus"],
  configure: (recipe: ImageEffectsRecipe) => void,
): ImageEffectPreset {
  const recipe = createNeutralEffectsRecipe();
  configure(recipe);
  return {
    id,
    version: IMAGE_EFFECT_PRESET_VERSION,
    label,
    description,
    focus,
    recipe: sanitizeEffectsRecipe(recipe),
  };
}

export const IMAGE_EFFECT_PRESETS: readonly ImageEffectPreset[] = [
  preset(
    "soft-bloom",
    "Soft bloom",
    "Adds a restrained spread around measured highlights without clipping new whites.",
    "Light",
    (recipe) => {
      recipe.bloom = { amount: 28, radius: 10, threshold: 72 };
    },
  ),
  preset(
    "fine-grain",
    "Fine grain",
    "Adds a subtle source-bound monochrome texture with no vignette or glow.",
    "Texture",
    (recipe) => {
      recipe.grain = { amount: 22, size: 2 };
    },
  ),
  preset(
    "cinematic-frame",
    "Cinematic frame",
    "Applies a broad dark perimeter while retaining an unchanged central region.",
    "Frame",
    (recipe) => {
      recipe.vignette = { amount: -30, midpoint: 58, feather: 70 };
    },
  ),
  preset(
    "analog-finish",
    "Analog finish",
    "Combines restrained highlight bloom, fine grain and a gentle dark perimeter.",
    "Combined",
    (recipe) => {
      recipe.bloom = { amount: 16, radius: 7, threshold: 76 };
      recipe.grain = { amount: 18, size: 2 };
      recipe.vignette = { amount: -18, midpoint: 54, feather: 76 };
    },
  ),
];

export function imageEffectPreset(id: ImageEffectPresetId): ImageEffectPreset {
  const match = IMAGE_EFFECT_PRESETS.find((item) => item.id === id);
  if (!match) throw new Error("The selected built-in effect preset is unavailable.");
  return { ...match, recipe: sanitizeEffectsRecipe(match.recipe) };
}

export function matchingImageEffectPreset(recipe: ImageEffectsRecipe): ImageEffectPreset | null {
  return IMAGE_EFFECT_PRESETS.find((item) => sameEffectsRecipe(item.recipe, recipe)) ?? null;
}
