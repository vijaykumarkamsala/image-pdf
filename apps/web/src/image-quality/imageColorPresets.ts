import {
  createNeutralColorRecipe,
  sameColorRecipe,
  sanitizeColorRecipe,
  type ImageColorRecipe,
} from "./imageColor.ts";

export const IMAGE_COLOR_PRESET_VERSION = "1.0.0";

export const IMAGE_COLOR_PRESET_IDS = [
  "natural-vibrance",
  "cool-clean",
  "muted-editorial",
  "balanced-monochrome",
] as const;

export type ImageColorPresetId = typeof IMAGE_COLOR_PRESET_IDS[number];

export interface ImageColorPreset {
  id: ImageColorPresetId;
  version: string;
  label: string;
  description: string;
  intent: "corrective" | "creative";
  recipe: ImageColorRecipe;
}

function preset(
  id: ImageColorPresetId,
  label: string,
  description: string,
  intent: ImageColorPreset["intent"],
  configure: (recipe: ImageColorRecipe) => void,
): ImageColorPreset {
  const recipe = createNeutralColorRecipe();
  configure(recipe);
  return {
    id,
    version: IMAGE_COLOR_PRESET_VERSION,
    label,
    description,
    intent,
    recipe: sanitizeColorRecipe(recipe),
  };
}

export const IMAGE_COLOR_PRESETS: readonly ImageColorPreset[] = [
  preset(
    "natural-vibrance",
    "Natural vibrance",
    "Adds restrained warmth and colour separation, weighted toward quieter colours.",
    "corrective",
    (recipe) => {
      recipe.temperature = 4;
      recipe.tint = 1;
      recipe.saturation = 2;
      recipe.vibrance = 12;
    },
  ),
  preset(
    "cool-clean",
    "Cool clean",
    "Uses a bounded cool balance with restrained saturation and gentle vibrance.",
    "creative",
    (recipe) => {
      recipe.temperature = -7;
      recipe.tint = -1;
      recipe.saturation = -3;
      recipe.vibrance = 8;
    },
  ),
  preset(
    "muted-editorial",
    "Muted editorial",
    "Reduces global colour intensity and applies subtle cool-shadow, warm-highlight grading.",
    "creative",
    (recipe) => {
      recipe.saturation = -16;
      recipe.vibrance = -4;
      recipe.colorGrading.shadows = { hue: 218, saturation: 5, luminance: -2 };
      recipe.colorGrading.highlights = { hue: 38, saturation: 6, luminance: 2 };
    },
  ),
  preset(
    "balanced-monochrome",
    "Balanced monochrome",
    "Converts colour through a luminance-preserving channel mix without adding grain or detail.",
    "creative",
    (recipe) => {
      recipe.blackAndWhite = { enabled: true, red: 45, green: 40, blue: 15 };
    },
  ),
];

export function imageColorPreset(id: ImageColorPresetId): ImageColorPreset {
  const match = IMAGE_COLOR_PRESETS.find((item) => item.id === id);
  if (!match) throw new Error("The selected built-in colour preset is unavailable.");
  return { ...match, recipe: sanitizeColorRecipe(match.recipe) };
}

export function matchingImageColorPreset(recipe: ImageColorRecipe): ImageColorPreset | null {
  return IMAGE_COLOR_PRESETS.find((item) => sameColorRecipe(item.recipe, recipe)) ?? null;
}
