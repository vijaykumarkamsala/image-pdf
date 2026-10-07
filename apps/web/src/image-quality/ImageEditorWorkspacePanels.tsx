import {
  Aperture,
  Crop,
  Download,
  FlipHorizontal2,
  FlipVertical2,
  Palette,
  Pipette,
  RotateCcw,
  RotateCw,
  SlidersHorizontal,
  Sparkles,
  SunMedium,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "../design-system";
import type { ImageQualityOutputScale } from "./ImageQualityEngine";
import {
  createIdentityPerspective,
  cropToAspect,
  geometryNaturalDimensions,
  isIdentityGeometry,
  MAX_BROWSER_PERSPECTIVE_PIXELS,
  rotateGeometry,
  sanitizeCropRect,
  type ImageCropAspect,
  type ImageGeometryRecipe,
} from "./imageGeometry";
import {
  isNeutralTone,
  MAX_BROWSER_TONE_PIXELS,
  recommendToneCorrection,
  sameToneRecipe,
  sanitizeToneRecipe,
  type ImageToneRecommendation,
  type ImageToneRecipe,
  type ImageToneStatistics,
} from "./imageTone";
import {
  IMAGE_TONE_PRESETS,
  IMAGE_TONE_PRESET_VERSION,
  imageTonePreset,
  matchingImageTonePreset,
} from "./imageTonePresets";
import {
  addImageToneCustomPreset,
  IMAGE_TONE_CUSTOM_PRESET_STORAGE_KEY,
  MAX_IMAGE_TONE_CUSTOM_PRESETS,
  MAX_IMAGE_TONE_CUSTOM_PRESET_NAME_LENGTH,
  persistImageToneCustomPresets,
  readImageToneCustomPresets,
  removeImageToneCustomPreset,
  renameImageToneCustomPreset,
  type ImageToneCustomPreset,
} from "./imageToneCustomPresets";
import {
  IMAGE_COLOR_GRADING_RANGES,
  IMAGE_SELECTIVE_COLOR_RANGES,
  isNeutralColor,
  MAX_BROWSER_COLOR_PIXELS,
  sameColorRecipe,
  sanitizeColorRecipe,
  type ImageBlackAndWhiteRecipe,
  type ImageColorGrade,
  type ImageColorGradingRange,
  type ImageColorRecipe,
  type ImageColorStatistics,
  type ImageDuotoneRecipe,
  type ImagePointColorSample,
  type ImageSelectiveColorRange,
  type ImageSelectiveHslAdjustment,
  type ImageWhiteBalanceSuggestion,
} from "./imageColor";
import {
  IMAGE_COLOR_PRESETS,
  IMAGE_COLOR_PRESET_VERSION,
  imageColorPreset,
  matchingImageColorPreset,
} from "./imageColorPresets";
import {
  addImageColorCustomPreset,
  hasSourceBoundImageColorSettings,
  IMAGE_COLOR_CUSTOM_PRESET_STORAGE_KEY,
  isPortableImageColorRecipe,
  MAX_IMAGE_COLOR_CUSTOM_PRESETS,
  MAX_IMAGE_COLOR_CUSTOM_PRESET_NAME_LENGTH,
  persistImageColorCustomPresets,
  readImageColorCustomPresets,
  removeImageColorCustomPreset,
  renameImageColorCustomPreset,
  type ImageColorCustomPreset,
} from "./imageColorCustomPresets";
import type { ImportedImageCubeLut } from "./imageCubeLut";
import {
  analysisMatchesColorMatchRecipe,
  type ImageColorMatchAnalysis,
} from "./imageColorMatch";
import {
  IMAGE_PROTECTED_COLOR_KINDS,
  MAX_PROTECTED_COLOR_ANCHORS,
  type ImageProtectedColorKind,
} from "./imageProtectedColor";
import {
  IMAGE_COLOR_VISION_LABELS,
  IMAGE_COLOR_VISION_MODES,
  type ImageColorVisionSelection,
} from "./imageColorVision";
import { ImageHistogramPanel, type ImageHistogramInput } from "./ImageHistogramPanel";
import { ToneCurveControl } from "./ToneCurveControl";
import { WorkerImageHistogramEngine } from "./WorkerImageHistogramEngine";
import {
  isNeutralEffects,
  MAX_BROWSER_EFFECT_PIXELS,
  sameEffectsRecipe,
  sanitizeEffectsRecipe,
  type ImageEffectsRecipe,
  type ImageEffectsStatistics,
} from "./imageEffects";
import {
  IMAGE_EFFECT_PRESETS,
  IMAGE_EFFECT_PRESET_VERSION,
  imageEffectPreset,
  matchingImageEffectPreset,
} from "./imageEffectPresets";
import {
  addImageEffectCustomPreset,
  IMAGE_EFFECT_CUSTOM_PRESET_STORAGE_KEY,
  MAX_IMAGE_EFFECT_CUSTOM_PRESETS,
  MAX_IMAGE_EFFECT_CUSTOM_PRESET_NAME_LENGTH,
  persistImageEffectCustomPresets,
  readImageEffectCustomPresets,
  removeImageEffectCustomPreset,
  renameImageEffectCustomPreset,
  type ImageEffectCustomPreset,
} from "./imageEffectCustomPresets";

export type ImageEditorTool = "enhance" | "adjust" | "color" | "effects" | "geometry";

function strengthLabel(strength: number) {
  if (strength === 0) return "Neutral";
  if (strength < 35) return "Gentle";
  if (strength < 70) return "Balanced";
  return "Strong";
}

export function ImageEditorToolRail({
  activeTool,
  onChange,
}: {
  activeTool: ImageEditorTool;
  onChange: (tool: ImageEditorTool) => void;
}) {
  return <nav className="quality-tool-rail" aria-label="Image editor tools">
    <button type="button" aria-current={activeTool === "enhance" ? "page" : undefined} onClick={() => onChange("enhance")}>
      <Sparkles aria-hidden="true" /><span>Enhance</span>
    </button>
    <button type="button" aria-current={activeTool === "adjust" ? "page" : undefined} onClick={() => onChange("adjust")}>
      <SunMedium aria-hidden="true" /><span>Adjust</span>
    </button>
    <button type="button" aria-current={activeTool === "color" ? "page" : undefined} onClick={() => onChange("color")}>
      <Palette aria-hidden="true" /><span>Colour</span>
    </button>
    <button type="button" aria-current={activeTool === "effects" ? "page" : undefined} onClick={() => onChange("effects")}>
      <Aperture aria-hidden="true" /><span>Effects</span>
    </button>
    <button type="button" aria-current={activeTool === "geometry" ? "page" : undefined} onClick={() => onChange("geometry")}>
      <Crop aria-hidden="true" /><span>Crop</span>
    </button>
  </nav>;
}

interface EffectsToolPanelProps {
  recipe: ImageEffectsRecipe;
  statistics: ImageEffectsStatistics | null;
  busy: boolean;
  canApply: boolean;
  canDownload: boolean;
  onRecipe: (recipe: ImageEffectsRecipe) => void;
  onApply: () => void;
  onReset: () => void;
  onDownload: () => void;
}

function vignetteAmountLabel(amount: number) {
  if (amount === 0) return "Neutral";
  return amount < 0 ? `Dark ${Math.abs(amount)}` : `Light ${amount}`;
}

export function EffectsToolPanel(props: EffectsToolPanelProps) {
  const [customPresets, setCustomPresets] = useState<ImageEffectCustomPreset[]>([]);
  const [customPresetName, setCustomPresetName] = useState("");
  const [customPresetMessage, setCustomPresetMessage] = useState<string | null>(null);
  const [customPresetError, setCustomPresetError] = useState<string | null>(null);
  const [renamingPresetId, setRenamingPresetId] = useState<string | null>(null);
  const [renamingPresetName, setRenamingPresetName] = useState("");
  const [deletingPresetId, setDeletingPresetId] = useState<string | null>(null);
  useEffect(() => {
    const refresh = () => {
      try {
        setCustomPresets(readImageEffectCustomPresets(localStorage));
      } catch {
        setCustomPresetError("Saved presets are unavailable in this browser profile.");
      }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === IMAGE_EFFECT_CUSTOM_PRESET_STORAGE_KEY) refresh();
    };
    refresh();
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const neutral = isNeutralEffects(props.recipe);
  const activePreset = matchingImageEffectPreset(props.recipe);
  const activeCustomPreset = customPresets.find((preset) => sameEffectsRecipe(preset.recipe, props.recipe)) ?? null;
  const commitCustomPresets = (next: ImageEffectCustomPreset[], message: string) => {
    try {
      persistImageEffectCustomPresets(localStorage, next);
      setCustomPresets(next);
      setCustomPresetError(null);
      setCustomPresetMessage(message);
      return true;
    } catch {
      setCustomPresetMessage(null);
      setCustomPresetError("The browser could not save this preset. Existing presets were left unchanged.");
      return false;
    }
  };
  const saveCustomPreset = () => {
    try {
      const next = addImageEffectCustomPreset(
        customPresets,
        customPresetName,
        props.recipe,
        `effect-${crypto.randomUUID()}`,
      );
      const saved = next[next.length - 1]!;
      if (commitCustomPresets(next, `Saved “${saved.name}” in this browser profile.`)) setCustomPresetName("");
    } catch (error) {
      setCustomPresetMessage(null);
      setCustomPresetError(error instanceof Error ? error.message : "The effects preset could not be saved.");
    }
  };
  return <aside className="quality-tool-panel quality-controls" aria-label="Effects controls">
    <div className="quality-panel-heading"><Aperture aria-hidden="true" /><div><h2>Effects</h2><p>Bounded creative finishing after colour.</p></div></div>
    <fieldset className="quality-tone-presets">
      <legend>Built-in looks</legend>
      <div className="quality-tone-preset-status">
        <span>{activePreset ? activePreset.label : neutral ? "Neutral settings" : "Custom settings"}</span>
        <small>Built-in collection v{IMAGE_EFFECT_PRESET_VERSION}</small>
      </div>
      <div className="quality-tone-preset-grid">
        {IMAGE_EFFECT_PRESETS.map((preset) => <button
          key={preset.id}
          type="button"
          aria-pressed={activePreset?.id === preset.id}
          disabled={props.busy}
          onClick={() => props.onRecipe(imageEffectPreset(preset.id).recipe)}
        >
          <span><strong>{preset.label}</strong><small>{preset.focus}</small></span>
          <span>{preset.description}</span>
        </button>)}
      </div>
      <p>A look loads one complete, versioned deterministic effects recipe. Review its controls, then choose Apply effects; selecting a look alone never changes pixels.</p>
    </fieldset>
    <fieldset className="quality-custom-presets quality-custom-effect-presets">
      <legend>My effects presets</legend>
      <p>Saved names and complete Effects settings stay only in this browser profile. They are not synced, shared or embedded as preset names in exported files.</p>
      <form className="quality-custom-preset-create" onSubmit={(event) => {
        event.preventDefault();
        saveCustomPreset();
      }}>
        <label>
          <span>Effects preset name</span>
          <input
            type="text"
            maxLength={MAX_IMAGE_EFFECT_CUSTOM_PRESET_NAME_LENGTH}
            value={customPresetName}
            disabled={props.busy || customPresets.length >= MAX_IMAGE_EFFECT_CUSTOM_PRESETS}
            onChange={(event) => {
              setCustomPresetName(event.target.value);
              setCustomPresetError(null);
              setCustomPresetMessage(null);
            }}
          />
        </label>
        <Button
          type="submit"
          size="compact"
          disabled={props.busy || !customPresetName.trim() || neutral || Boolean(activePreset)
            || Boolean(activeCustomPreset) || customPresets.length >= MAX_IMAGE_EFFECT_CUSTOM_PRESETS}
        >Save current effects</Button>
      </form>
      {neutral && <small>Change at least one Effects setting before saving.</small>}
      {activePreset && <small>“{activePreset.label}” is already available in the built-in collection.</small>}
      {!activePreset && activeCustomPreset && <small>This recipe is already saved as “{activeCustomPreset.name}”.</small>}
      <small>{customPresets.length} of {MAX_IMAGE_EFFECT_CUSTOM_PRESETS} local presets used.</small>
      {customPresetMessage && <p className="quality-custom-preset-message" role="status">{customPresetMessage}</p>}
      {customPresetError && <p className="quality-custom-preset-error" role="alert">{customPresetError}</p>}
      {customPresets.length === 0
        ? <p className="quality-custom-preset-empty">No saved Effects presets in this browser profile.</p>
        : <ul className="quality-custom-preset-list" aria-label="Saved effects presets">
          {customPresets.map((preset) => <li key={preset.id}>
            {renamingPresetId === preset.id
              ? <form className="quality-custom-preset-rename" onSubmit={(event) => {
                event.preventDefault();
                try {
                  const next = renameImageEffectCustomPreset(customPresets, preset.id, renamingPresetName);
                  const renamed = next.find((item) => item.id === preset.id)!;
                  if (commitCustomPresets(next, `Renamed preset to “${renamed.name}”.`)) {
                    setRenamingPresetId(null);
                    setRenamingPresetName("");
                  }
                } catch (error) {
                  setCustomPresetMessage(null);
                  setCustomPresetError(error instanceof Error ? error.message : "The effects preset could not be renamed.");
                }
              }}>
                <label><span>Rename {preset.name}</span><input
                  type="text"
                  maxLength={MAX_IMAGE_EFFECT_CUSTOM_PRESET_NAME_LENGTH}
                  value={renamingPresetName}
                  autoFocus
                  onChange={(event) => setRenamingPresetName(event.target.value)}
                /></label>
                <div><Button type="submit" size="compact" disabled={!renamingPresetName.trim()}>Save name</Button><Button type="button" size="compact" onClick={() => {
                  setRenamingPresetId(null);
                  setRenamingPresetName("");
                }}>Cancel rename</Button></div>
              </form>
              : <>
                <button
                  type="button"
                  className="quality-custom-preset-apply"
                  aria-pressed={activeCustomPreset?.id === preset.id && !activePreset}
                  disabled={props.busy}
                  onClick={() => {
                    setCustomPresetError(null);
                    setCustomPresetMessage(`Loaded “${preset.name}”. Choose Apply effects to change pixels.`);
                    props.onRecipe(sanitizeEffectsRecipe(preset.recipe));
                  }}
                ><strong>{preset.name}</strong><span>Load saved effects</span></button>
                <div className="quality-custom-preset-actions">
                  <Button type="button" size="compact" disabled={props.busy} onClick={() => {
                    setRenamingPresetId(preset.id);
                    setRenamingPresetName(preset.name);
                    setDeletingPresetId(null);
                    setCustomPresetError(null);
                    setCustomPresetMessage(null);
                  }}>Rename {preset.name}</Button>
                  {deletingPresetId === preset.id
                    ? <><Button type="button" size="compact" tone="danger" onClick={() => {
                      try {
                        const next = removeImageEffectCustomPreset(customPresets, preset.id);
                        if (commitCustomPresets(next, `Deleted “${preset.name}” from this browser profile.`)) {
                          setDeletingPresetId(null);
                        }
                      } catch (error) {
                        setCustomPresetMessage(null);
                        setCustomPresetError(error instanceof Error ? error.message : "The effects preset could not be deleted.");
                      }
                    }}>Confirm delete {preset.name}</Button><Button type="button" size="compact" onClick={() => setDeletingPresetId(null)}>Cancel delete</Button></>
                    : <Button type="button" size="compact" tone="danger" disabled={props.busy} onClick={() => {
                      setDeletingPresetId(preset.id);
                      setRenamingPresetId(null);
                      setCustomPresetError(null);
                      setCustomPresetMessage(null);
                    }}>Delete {preset.name}</Button>}
                </div>
              </>}
          </li>)}
        </ul>}
    </fieldset>
    <fieldset className="quality-levels-control quality-vignette-control">
      <legend>Highlight bloom</legend>
      <label className="quality-adjustment-control">
        <span><strong>Amount</strong><output>{props.recipe.bloom.amount === 0 ? "Neutral" : `${props.recipe.bloom.amount}%`}</output></span>
        <input
          aria-label="Highlight bloom amount"
          type="range"
          min="0"
          max="100"
          step="1"
          value={props.recipe.bloom.amount}
          disabled={props.busy}
          onChange={(event) => props.onRecipe({
            ...props.recipe,
            bloom: { ...props.recipe.bloom, amount: Number(event.target.value) },
          })}
        />
      </label>
      <label className="quality-adjustment-control">
        <span><strong>Radius</strong><output>{props.recipe.bloom.radius} px</output></span>
        <input
          aria-label="Highlight bloom radius"
          type="range"
          min="1"
          max="32"
          step="1"
          value={props.recipe.bloom.radius}
          disabled={props.busy}
          onChange={(event) => props.onRecipe({
            ...props.recipe,
            bloom: { ...props.recipe.bloom, radius: Number(event.target.value) },
          })}
        />
      </label>
      <label className="quality-adjustment-control">
        <span><strong>Threshold</strong><output>{props.recipe.bloom.threshold}% brightness</output></span>
        <input
          aria-label="Highlight bloom threshold"
          type="range"
          min="0"
          max="100"
          step="1"
          value={props.recipe.bloom.threshold}
          disabled={props.busy}
          onChange={(event) => props.onRecipe({
            ...props.recipe,
            bloom: { ...props.recipe.bloom, threshold: Number(event.target.value) },
          })}
        />
      </label>
      <p>Spreads measured source highlights within visible pixels only. It preserves alpha, prevents new clipped whites and does not invent a light source.</p>
    </fieldset>
    <fieldset className="quality-levels-control quality-vignette-control">
      <legend>Posterization</legend>
      <label className="quality-adjustment-control">
        <span><strong>Colour levels</strong><output>{props.recipe.posterize.levels === 256
          ? "Neutral (256)"
          : `${props.recipe.posterize.levels} per channel`}</output></span>
        <input
          aria-label="Posterization colour levels"
          type="range"
          min="2"
          max="256"
          step="1"
          value={props.recipe.posterize.levels}
          disabled={props.busy}
          onChange={(event) => props.onRecipe({
            ...props.recipe,
            posterize: { levels: Number(event.target.value) },
          })}
        />
      </label>
      <p>Reduces each visible RGB channel to evenly spaced values. Lower levels create stronger colour bands; 256 levels is neutral. Alpha and fully transparent hidden colour stay unchanged.</p>
    </fieldset>
    <fieldset className="quality-levels-control quality-vignette-control">
      <legend>Halftone dots</legend>
      <label className="quality-adjustment-control">
        <span><strong>Amount</strong><output>{props.recipe.halftone.amount === 0 ? "Neutral" : `${props.recipe.halftone.amount}%`}</output></span>
        <input
          aria-label="Halftone amount"
          type="range"
          min="0"
          max="100"
          step="1"
          value={props.recipe.halftone.amount}
          disabled={props.busy}
          onChange={(event) => props.onRecipe({
            ...props.recipe,
            halftone: { ...props.recipe.halftone, amount: Number(event.target.value) },
          })}
        />
      </label>
      <label className="quality-adjustment-control">
        <span><strong>Cell size</strong><output>{props.recipe.halftone.size} px</output></span>
        <input
          aria-label="Halftone cell size"
          type="range"
          min="3"
          max="32"
          step="1"
          value={props.recipe.halftone.size}
          disabled={props.busy}
          onChange={(event) => props.onRecipe({
            ...props.recipe,
            halftone: { ...props.recipe.halftone, size: Number(event.target.value) },
          })}
        />
      </label>
      <label className="quality-adjustment-control">
        <span><strong>Angle</strong><output>{props.recipe.halftone.angle}°</output></span>
        <input
          aria-label="Halftone angle"
          type="range"
          min="-90"
          max="90"
          step="1"
          value={props.recipe.halftone.angle}
          disabled={props.busy}
          onChange={(event) => props.onRecipe({
            ...props.recipe,
            halftone: { ...props.recipe.halftone, angle: Number(event.target.value) },
          })}
        />
      </label>
      <p>Blends visible colour into a deterministic monochrome dot screen anchored to source coordinates. Amount 0 is neutral; alpha and fully transparent hidden colour stay unchanged.</p>
    </fieldset>
    <fieldset className="quality-levels-control quality-vignette-control">
      <legend>Film grain</legend>
      <label className="quality-adjustment-control">
        <span><strong>Amount</strong><output>{props.recipe.grain.amount === 0 ? "Neutral" : `${props.recipe.grain.amount}%`}</output></span>
        <input
          aria-label="Film grain amount"
          type="range"
          min="0"
          max="100"
          step="1"
          value={props.recipe.grain.amount}
          disabled={props.busy}
          onChange={(event) => props.onRecipe({
            ...props.recipe,
            grain: { ...props.recipe.grain, amount: Number(event.target.value) },
          })}
        />
      </label>
      <label className="quality-adjustment-control">
        <span><strong>Size</strong><output>{props.recipe.grain.size} px</output></span>
        <input
          aria-label="Film grain size"
          type="range"
          min="1"
          max="8"
          step="1"
          value={props.recipe.grain.size}
          disabled={props.busy}
          onChange={(event) => props.onRecipe({
            ...props.recipe,
            grain: { ...props.recipe.grain, size: Number(event.target.value) },
          })}
        />
      </label>
      <p>Deterministic monochrome grain is anchored to source coordinates and the verified base hash. It preserves hue, bounds highlights and shadows, and does not invent scene detail.</p>
    </fieldset>
    <fieldset className="quality-levels-control quality-vignette-control">
      <legend>Vignette</legend>
      <label className="quality-adjustment-control">
        <span><strong>Amount</strong><output>{vignetteAmountLabel(props.recipe.vignette.amount)}</output></span>
        <input
          aria-label="Vignette amount"
          type="range"
          min="-100"
          max="100"
          step="1"
          value={props.recipe.vignette.amount}
          disabled={props.busy}
          onChange={(event) => props.onRecipe({
            ...props.recipe,
            vignette: { ...props.recipe.vignette, amount: Number(event.target.value) },
          })}
        />
      </label>
      <label className="quality-adjustment-control">
        <span><strong>Midpoint</strong><output>{props.recipe.vignette.midpoint}%</output></span>
        <input
          aria-label="Vignette midpoint"
          type="range"
          min="0"
          max="100"
          step="1"
          value={props.recipe.vignette.midpoint}
          disabled={props.busy}
          onChange={(event) => props.onRecipe({
            ...props.recipe,
            vignette: { ...props.recipe.vignette, midpoint: Number(event.target.value) },
          })}
        />
      </label>
      <label className="quality-adjustment-control">
        <span><strong>Feather</strong><output>{props.recipe.vignette.feather}%</output></span>
        <input
          aria-label="Vignette feather"
          type="range"
          min="1"
          max="100"
          step="1"
          value={props.recipe.vignette.feather}
          disabled={props.busy}
          onChange={(event) => props.onRecipe({
            ...props.recipe,
            vignette: { ...props.recipe.vignette, feather: Number(event.target.value) },
          })}
        />
      </label>
      <p>Negative amounts darken the perimeter; positive amounts lighten it. The source-coordinate ellipse leaves the centre unchanged and never invents detail.</p>
    </fieldset>
    {props.statistics && <dl className="quality-adjustment-statistics">
      <div><dt>Changed pixels</dt><dd>{props.statistics.changedPixels.toLocaleString()}</dd></div>
      <div><dt>Bloom pixels</dt><dd>{props.statistics.bloomChangedPixels.toLocaleString()}</dd></div>
      <div><dt>Posterized pixels</dt><dd>{props.statistics.posterizedPixels.toLocaleString()}</dd></div>
      <div><dt>Halftone pixels</dt><dd>{props.statistics.halftonedPixels.toLocaleString()}</dd></div>
      <div><dt>Grain pixels</dt><dd>{props.statistics.grainChangedPixels.toLocaleString()}</dd></div>
      <div><dt>Vignette pixels</dt><dd>{props.statistics.vignetteChangedPixels.toLocaleString()}</dd></div>
      <div><dt>Darkened pixels</dt><dd>{props.statistics.darkenedPixels.toLocaleString()}</dd></div>
      <div><dt>Lightened pixels</dt><dd>{props.statistics.lightenedPixels.toLocaleString()}</dd></div>
    </dl>}
    <div className="quality-actions">
      <Button tone="primary" disabled={!props.canApply} onClick={props.onApply}><Aperture aria-hidden="true" />{props.busy ? "Applying…" : "Apply effects"}</Button>
      <Button disabled={props.busy || isNeutralEffects(props.recipe)} onClick={props.onReset}><RotateCcw aria-hidden="true" />Reset effects</Button>
      <Button disabled={!props.canDownload || props.busy} onClick={props.onDownload}><Download aria-hidden="true" />Download effects-adjusted image</Button>
    </div>
    <p className="quality-view-note">Processing is browser-local and deterministic up to {MAX_BROWSER_EFFECT_PIXELS.toLocaleString()} pixels. Preview and download share the same verified PNG bytes.</p>
  </aside>;
}

interface ToneToolPanelProps {
  recipe: ImageToneRecipe;
  statistics: ImageToneStatistics | null;
  recommendationInput: ImageHistogramInput | null;
  busy: boolean;
  canApply: boolean;
  canDownload: boolean;
  onRecipe: (recipe: ImageToneRecipe) => void;
  onApply: () => void;
  onReset: () => void;
  onDownload: () => void;
}

const toneControls: Array<{
  key: keyof ImageToneRecipe;
  label: string;
  minimum: number;
  maximum: number;
  step: number;
}> = [
  { key: "exposure", label: "Exposure", minimum: -3, maximum: 3, step: 0.1 },
  { key: "brightness", label: "Brightness", minimum: -100, maximum: 100, step: 1 },
  { key: "contrast", label: "Contrast", minimum: -100, maximum: 100, step: 1 },
  { key: "gamma", label: "Gamma", minimum: -100, maximum: 100, step: 1 },
  { key: "highlights", label: "Highlights", minimum: -100, maximum: 100, step: 1 },
  { key: "shadows", label: "Shadows", minimum: -100, maximum: 100, step: 1 },
  { key: "whites", label: "Whites", minimum: -100, maximum: 100, step: 1 },
  { key: "blacks", label: "Blacks", minimum: -100, maximum: 100, step: 1 },
];

const recoveryControls: Array<{
  key: "shadowRecovery" | "highlightRecovery";
  label: string;
}> = [
  { key: "shadowRecovery", label: "Shadow recovery" },
  { key: "highlightRecovery", label: "Highlight recovery" },
];

function toneValue(control: typeof toneControls[number], value: number) {
  if (control.key === "exposure") return `${value > 0 ? "+" : ""}${value.toFixed(1)} EV`;
  return `${value > 0 ? "+" : ""}${value}`;
}

export function ToneToolPanel(props: ToneToolPanelProps) {
  const [recommendation, setRecommendation] = useState<ImageToneRecommendation | null>(null);
  const [recommendationBusy, setRecommendationBusy] = useState(false);
  const [recommendationError, setRecommendationError] = useState<string | null>(null);
  const [recommendationUsed, setRecommendationUsed] = useState(false);
  const [customPresets, setCustomPresets] = useState<ImageToneCustomPreset[]>([]);
  const [customPresetName, setCustomPresetName] = useState("");
  const [customPresetMessage, setCustomPresetMessage] = useState<string | null>(null);
  const [customPresetError, setCustomPresetError] = useState<string | null>(null);
  const [renamingPresetId, setRenamingPresetId] = useState<string | null>(null);
  const [renamingPresetName, setRenamingPresetName] = useState("");
  const [deletingPresetId, setDeletingPresetId] = useState<string | null>(null);
  const recommendationEngine = useRef<WorkerImageHistogramEngine | null>(null);
  const recommendationOperation = useRef(0);
  const recommendationKey = props.recommendationInput
    ? `${props.recommendationInput.sha256}:${props.recommendationInput.width}x${props.recommendationInput.height}`
    : "";
  useEffect(() => {
    recommendationOperation.current += 1;
    recommendationEngine.current?.dispose();
    recommendationEngine.current = null;
    setRecommendation(null);
    setRecommendationBusy(false);
    setRecommendationError(null);
    setRecommendationUsed(false);
  }, [recommendationKey]);
  useEffect(() => () => {
    recommendationOperation.current += 1;
    recommendationEngine.current?.dispose();
  }, []);
  useEffect(() => {
    const refresh = () => {
      try {
        setCustomPresets(readImageToneCustomPresets(localStorage));
      } catch {
        setCustomPresetError("Saved presets are unavailable in this browser profile.");
      }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === IMAGE_TONE_CUSTOM_PRESET_STORAGE_KEY) refresh();
    };
    refresh();
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const analyseTone = async () => {
    const input = props.recommendationInput;
    if (!input || props.busy || recommendationBusy) return;
    const currentOperation = ++recommendationOperation.current;
    recommendationEngine.current?.dispose();
    const next = new WorkerImageHistogramEngine();
    recommendationEngine.current = next;
    setRecommendationBusy(true);
    setRecommendation(null);
    setRecommendationError(null);
    setRecommendationUsed(false);
    try {
      const result = await next.analyze(input.blob, input.width, input.height);
      if (recommendationOperation.current !== currentOperation) return;
      setRecommendation(recommendToneCorrection(result.summary));
    } catch (error) {
      if (recommendationOperation.current !== currentOperation) return;
      setRecommendationError(error instanceof Error ? error.message : "Automatic tone analysis did not complete.");
    } finally {
      if (recommendationOperation.current === currentOperation) {
        setRecommendationBusy(false);
        next.dispose();
        if (recommendationEngine.current === next) recommendationEngine.current = null;
      }
    }
  };
  const neutral = isNeutralTone(props.recipe);
  const activePreset = matchingImageTonePreset(props.recipe);
  const activeCustomPreset = customPresets.find((preset) => sameToneRecipe(preset.recipe, props.recipe)) ?? null;
  const commitCustomPresets = (next: ImageToneCustomPreset[], message: string) => {
    try {
      persistImageToneCustomPresets(localStorage, next);
      setCustomPresets(next);
      setCustomPresetError(null);
      setCustomPresetMessage(message);
      return true;
    } catch {
      setCustomPresetMessage(null);
      setCustomPresetError("The browser could not save this preset. Existing presets were left unchanged.");
      return false;
    }
  };
  const saveCustomPreset = () => {
    try {
      const next = addImageToneCustomPreset(
        customPresets,
        customPresetName,
        props.recipe,
        `tone-${crypto.randomUUID()}`,
      );
      const saved = next[next.length - 1]!;
      if (commitCustomPresets(next, `Saved “${saved.name}” in this browser profile.`)) setCustomPresetName("");
    } catch (error) {
      setCustomPresetMessage(null);
      setCustomPresetError(error instanceof Error ? error.message : "The preset could not be saved.");
    }
  };
  return <aside className="quality-tool-panel quality-controls" aria-label="Light and tone controls">
    <div className="quality-panel-heading"><SunMedium aria-hidden="true" /><div><h2>Light &amp; tone</h2><p>Deterministic correction from the latest verified base.</p></div></div>
    <fieldset className="quality-tone-presets">
      <legend>Built-in presets</legend>
      <div className="quality-tone-preset-status">
        <span>{activePreset ? activePreset.label : neutral ? "Neutral settings" : "Custom settings"}</span>
        <small>Built-in collection v{IMAGE_TONE_PRESET_VERSION}</small>
      </div>
      <div className="quality-tone-preset-grid">
        {IMAGE_TONE_PRESETS.map((preset) => <button
          key={preset.id}
          type="button"
          aria-pressed={activePreset?.id === preset.id}
          disabled={props.busy}
          onClick={() => {
            setRecommendationUsed(false);
            props.onRecipe(imageTonePreset(preset.id).recipe);
          }}
        >
          <span><strong>{preset.label}</strong><small>{preset.intent === "corrective" ? "Corrective" : "Creative"}</small></span>
          <span>{preset.description}</span>
        </button>)}
      </div>
      <p>A preset loads a complete, versioned deterministic recipe into the controls. Review the values, then choose Apply adjustments; selecting a preset alone never changes pixels.</p>
    </fieldset>
    <fieldset className="quality-custom-presets">
      <legend>My presets</legend>
      <p>Saved names and tone settings stay only in this browser profile. They are not synced, shared or embedded as preset names in exported files.</p>
      <form className="quality-custom-preset-create" onSubmit={(event) => {
        event.preventDefault();
        saveCustomPreset();
      }}>
        <label>
          <span>Preset name</span>
          <input
            type="text"
            maxLength={MAX_IMAGE_TONE_CUSTOM_PRESET_NAME_LENGTH}
            value={customPresetName}
            disabled={props.busy || customPresets.length >= MAX_IMAGE_TONE_CUSTOM_PRESETS}
            onChange={(event) => {
              setCustomPresetName(event.target.value);
              setCustomPresetError(null);
              setCustomPresetMessage(null);
            }}
          />
        </label>
        <Button
          type="submit"
          size="compact"
          disabled={props.busy || !customPresetName.trim() || neutral || Boolean(activePreset) || Boolean(activeCustomPreset)
            || customPresets.length >= MAX_IMAGE_TONE_CUSTOM_PRESETS}
        >Save current recipe</Button>
      </form>
      {neutral && <small>Change at least one tone setting before saving.</small>}
      {activePreset && <small>“{activePreset.label}” is already available in the built-in collection.</small>}
      {!activePreset && activeCustomPreset && <small>This recipe is already saved as “{activeCustomPreset.name}”.</small>}
      <small>{customPresets.length} of {MAX_IMAGE_TONE_CUSTOM_PRESETS} local presets used.</small>
      {customPresetMessage && <p className="quality-custom-preset-message" role="status">{customPresetMessage}</p>}
      {customPresetError && <p className="quality-custom-preset-error" role="alert">{customPresetError}</p>}
      {customPresets.length === 0
        ? <p className="quality-custom-preset-empty">No saved presets in this browser profile.</p>
        : <ul className="quality-custom-preset-list" aria-label="Saved tone presets">
          {customPresets.map((preset) => <li key={preset.id}>
            {renamingPresetId === preset.id
              ? <form className="quality-custom-preset-rename" onSubmit={(event) => {
                event.preventDefault();
                try {
                  const next = renameImageToneCustomPreset(customPresets, preset.id, renamingPresetName);
                  const renamed = next.find((item) => item.id === preset.id)!;
                  if (commitCustomPresets(next, `Renamed preset to “${renamed.name}”.`)) {
                    setRenamingPresetId(null);
                    setRenamingPresetName("");
                  }
                } catch (error) {
                  setCustomPresetMessage(null);
                  setCustomPresetError(error instanceof Error ? error.message : "The preset could not be renamed.");
                }
              }}>
                <label><span>Rename {preset.name}</span><input
                  type="text"
                  maxLength={MAX_IMAGE_TONE_CUSTOM_PRESET_NAME_LENGTH}
                  value={renamingPresetName}
                  autoFocus
                  onChange={(event) => setRenamingPresetName(event.target.value)}
                /></label>
                <div><Button type="submit" size="compact" disabled={!renamingPresetName.trim()}>Save name</Button><Button type="button" size="compact" onClick={() => {
                  setRenamingPresetId(null);
                  setRenamingPresetName("");
                }}>Cancel rename</Button></div>
              </form>
              : <>
                <button
                  type="button"
                  className="quality-custom-preset-apply"
                  aria-pressed={activeCustomPreset?.id === preset.id && !activePreset}
                  disabled={props.busy}
                  onClick={() => {
                    setRecommendationUsed(false);
                    setCustomPresetError(null);
                    setCustomPresetMessage(`Loaded “${preset.name}”. Choose Apply adjustments to change pixels.`);
                    props.onRecipe({ ...preset.recipe });
                  }}
                ><strong>{preset.name}</strong><span>Apply saved recipe</span></button>
                <div className="quality-custom-preset-actions">
                  <Button type="button" size="compact" disabled={props.busy} onClick={() => {
                    setRenamingPresetId(preset.id);
                    setRenamingPresetName(preset.name);
                    setDeletingPresetId(null);
                    setCustomPresetError(null);
                    setCustomPresetMessage(null);
                  }}>Rename {preset.name}</Button>
                  {deletingPresetId === preset.id
                    ? <><Button type="button" size="compact" tone="danger" onClick={() => {
                      try {
                        const next = removeImageToneCustomPreset(customPresets, preset.id);
                        if (commitCustomPresets(next, `Deleted “${preset.name}” from this browser profile.`)) {
                          setDeletingPresetId(null);
                        }
                      } catch (error) {
                        setCustomPresetMessage(null);
                        setCustomPresetError(error instanceof Error ? error.message : "The preset could not be deleted.");
                      }
                    }}>Confirm delete {preset.name}</Button><Button type="button" size="compact" onClick={() => setDeletingPresetId(null)}>Cancel delete</Button></>
                    : <Button type="button" size="compact" tone="danger" disabled={props.busy} onClick={() => {
                      setDeletingPresetId(preset.id);
                      setRenamingPresetId(null);
                      setCustomPresetError(null);
                      setCustomPresetMessage(null);
                    }}>Delete {preset.name}</Button>}
                </div>
              </>}
          </li>)}
        </ul>}
    </fieldset>
    <fieldset className="quality-auto-tone">
      <legend>Automatic tonal correction</legend>
      <Button
        size="compact"
        disabled={props.busy || recommendationBusy || !props.recommendationInput}
        onClick={() => void analyseTone()}
      ><Sparkles aria-hidden="true" />{recommendationBusy ? "Analysing…" : "Analyse verified base"}</Button>
      <p>Measures every visible pixel and proposes conservative Levels and protected recovery values. Nothing changes until you use the suggestion and apply it.</p>
      {recommendationError && <p className="quality-auto-tone-error" role="alert">{recommendationError}</p>}
      {recommendation && <div className="quality-auto-tone-result">
        <strong role="status">{recommendation.isNeutral ? "No automatic correction suggested" : "Review suggested correction"}</strong>
        <p>Analysed {props.recommendationInput?.label ?? "the verified base"}.</p>
        <dl>
          <div><dt>Levels</dt><dd>{recommendation.levelBlack}–{recommendation.levelWhite}</dd></div>
          <div><dt>Midtone</dt><dd>{recommendation.levelMidtone.toFixed(2)}</dd></div>
          <div><dt>Recovery</dt><dd>Shadows {recommendation.shadowRecovery}% · Highlights {recommendation.highlightRecovery}%</dd></div>
        </dl>
        <ul>{recommendation.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
        <div className="quality-control-group">
          {!recommendation.isNeutral && <Button size="compact" disabled={props.busy} onClick={() => {
            props.onRecipe(sanitizeToneRecipe({
              ...props.recipe,
              levelBlack: recommendation.levelBlack,
              levelWhite: recommendation.levelWhite,
              levelMidtone: recommendation.levelMidtone,
              shadowRecovery: recommendation.shadowRecovery,
              highlightRecovery: recommendation.highlightRecovery,
            }));
            setRecommendationUsed(true);
          }}>Use suggestion</Button>}
          <Button size="compact" disabled={props.busy} onClick={() => {
            setRecommendation(null);
            setRecommendationUsed(false);
          }}>Dismiss</Button>
        </div>
        {recommendationUsed && <p>Suggestion loaded into the controls. Review it, then choose Apply adjustments.</p>}
      </div>}
    </fieldset>
    <fieldset className="quality-levels-control">
      <legend>Input luminance levels</legend>
      <label className="quality-adjustment-control">
        <span><strong>Black point</strong><output>{props.recipe.levelBlack}</output></span>
        <input
          aria-label="Black point"
          type="range"
          min="0"
          max={Math.max(0, props.recipe.levelWhite - 1)}
          step="1"
          value={props.recipe.levelBlack}
          disabled={props.busy}
          onChange={(event) => props.onRecipe({ ...props.recipe, levelBlack: Number(event.target.value) })}
        />
      </label>
      <label className="quality-adjustment-control">
        <span><strong>Levels midtone</strong><output>{props.recipe.levelMidtone.toFixed(2)}</output></span>
        <input
          aria-label="Levels midtone"
          type="range"
          min="0.1"
          max="3"
          step="0.01"
          value={props.recipe.levelMidtone}
          disabled={props.busy}
          onChange={(event) => props.onRecipe({ ...props.recipe, levelMidtone: Number(event.target.value) })}
        />
      </label>
      <label className="quality-adjustment-control">
        <span><strong>White point</strong><output>{props.recipe.levelWhite}</output></span>
        <input
          aria-label="White point"
          type="range"
          min={Math.min(255, props.recipe.levelBlack + 1)}
          max="255"
          step="1"
          value={props.recipe.levelWhite}
          disabled={props.busy}
          onChange={(event) => props.onRecipe({ ...props.recipe, levelWhite: Number(event.target.value) })}
        />
      </label>
      <p>Maps the selected input range to full black and white before the remaining tone controls. Black and white points cannot cross.</p>
    </fieldset>
    <ToneCurveControl recipe={props.recipe} disabled={props.busy} onChange={props.onRecipe} />
    <fieldset className="quality-levels-control quality-protected-recovery">
      <legend>Protected dynamic range</legend>
      {recoveryControls.map((control) => <label className="quality-adjustment-control" key={control.key}>
        <span><strong>{control.label}</strong><output>{props.recipe[control.key]}%</output></span>
        <input
          aria-label={control.label}
          type="range"
          min="0"
          max="100"
          step="1"
          value={props.recipe[control.key]}
          disabled={props.busy}
          onChange={(event) => props.onRecipe({ ...props.recipe, [control.key]: Number(event.target.value) })}
        />
      </label>)}
      <p>Redistributes recoverable dark and bright tones while preserving true black, true white and RGB headroom. It cannot recreate detail already clipped in the source.</p>
    </fieldset>
    <fieldset className="quality-levels-control quality-local-contrast">
      <legend>Local contrast</legend>
      <label className="quality-adjustment-control">
        <span><strong>Local contrast</strong><output>{props.recipe.localContrast > 0 ? "+" : ""}{props.recipe.localContrast}</output></span>
        <input
          aria-label="Local contrast"
          type="range"
          min="-100"
          max="100"
          step="1"
          value={props.recipe.localContrast}
          disabled={props.busy}
          onChange={(event) => props.onRecipe({ ...props.recipe, localContrast: Number(event.target.value) })}
        />
      </label>
      <p>Separates or softens neighbourhood tones without sharpening. Halo-aware source tiles, endpoint protection and a noise floor limit seams, clipping and grain amplification.</p>
    </fieldset>
    <fieldset className="quality-levels-control quality-clarity">
      <legend>Clarity</legend>
      <label className="quality-adjustment-control">
        <span><strong>Clarity</strong><output>{props.recipe.clarity > 0 ? "+" : ""}{props.recipe.clarity}</output></span>
        <input
          aria-label="Clarity"
          type="range"
          min="-100"
          max="100"
          step="1"
          value={props.recipe.clarity}
          disabled={props.busy}
          onChange={(event) => props.onRecipe({ ...props.recipe, clarity: Number(event.target.value) })}
        />
      </label>
      <p>Adds or softens medium-scale definition without pixel sharpening. Two source-neighbourhood averages suppress fine noise while endpoint and colour headroom protections limit halos and clipping.</p>
    </fieldset>
    <fieldset className="quality-levels-control quality-texture">
      <legend>Texture</legend>
      <label className="quality-adjustment-control">
        <span><strong>Texture</strong><output>{props.recipe.texture > 0 ? "+" : ""}{props.recipe.texture}</output></span>
        <input
          aria-label="Texture"
          type="range"
          min="-100"
          max="100"
          step="1"
          value={props.recipe.texture}
          disabled={props.busy}
          onChange={(event) => props.onRecipe({ ...props.recipe, texture: Number(event.target.value) })}
        />
      </label>
      <p>Strengthens or softens fine repeated tonal detail without sharpening strong outlines. Local-variance, noise, endpoint and colour-headroom gates limit grain, halos and clipping.</p>
    </fieldset>
    <fieldset className="quality-levels-control quality-dehaze">
      <legend>Dehaze</legend>
      <label className="quality-adjustment-control">
        <span><strong>Dehaze</strong><output>{props.recipe.dehaze > 0 ? "+" : ""}{props.recipe.dehaze}</output></span>
        <input
          aria-label="Dehaze"
          type="range"
          min="-100"
          max="100"
          step="1"
          value={props.recipe.dehaze}
          disabled={props.busy}
          onChange={(event) => props.onRecipe({ ...props.recipe, dehaze: Number(event.target.value) })}
        />
      </label>
      <p>Positive values conservatively reduce a measured neutral veil; negative values add a bounded veil. Broad-structure and endpoint protection limit halos and clipping. It cannot recover detail obscured in the source.</p>
    </fieldset>
    <div className="quality-adjustment-controls">
      {toneControls.map((control) => <label className="quality-adjustment-control" key={control.key}>
        <span><strong>{control.label}</strong><output>{toneValue(control, props.recipe[control.key])}</output></span>
        <input
          aria-label={control.label}
          type="range"
          min={control.minimum}
          max={control.maximum}
          step={control.step}
          value={props.recipe[control.key]}
          disabled={props.busy}
          onChange={(event) => props.onRecipe({ ...props.recipe, [control.key]: Number(event.target.value) })}
        />
      </label>)}
    </div>
    {props.statistics && <dl className="quality-adjustment-statistics">
      <div><dt>Changed pixels</dt><dd>{props.statistics.changedPixels.toLocaleString()}</dd></div>
      <div><dt>New shadow clipping</dt><dd>{props.statistics.newShadowClippedPixels.toLocaleString()}</dd></div>
      <div><dt>New highlight clipping</dt><dd>{props.statistics.newHighlightClippedPixels.toLocaleString()}</dd></div>
    </dl>}
    <div className="quality-actions">
      <Button tone="primary" disabled={!props.canApply} onClick={props.onApply}><SunMedium aria-hidden="true" />{props.busy ? "Applying…" : "Apply adjustments"}</Button>
      <Button disabled={neutral && !props.statistics} onClick={props.onReset}><RotateCcw aria-hidden="true" />Reset adjustments</Button>
      <Button disabled={!props.canDownload || props.busy} onClick={props.onDownload}><Download aria-hidden="true" />Download adjusted image</Button>
    </div>
    <p className="quality-view-note">Every apply starts from the latest verified original, enhancement or geometry result—not a previous tone result. Alpha is preserved. Local work is limited to {MAX_BROWSER_TONE_PIXELS.toLocaleString()} pixels and larger requests fail visibly.</p>
  </aside>;
}

interface ColorToolPanelProps {
  recipe: ImageColorRecipe;
  statistics: ImageColorStatistics | null;
  whiteBalanceSuggestion: ImageWhiteBalanceSuggestion | null;
  whiteBalanceBaseLabel: string | null;
  whiteBalanceSuggestionUsed: boolean;
  whiteBalancePicking: boolean;
  whiteBalanceAnalysing: boolean;
  pointColorSample: ImagePointColorSample | null;
  pointColorBaseLabel: string | null;
  pointColorPicking: boolean;
  pointColorAnalysing: boolean;
  protectedColorReview: (ImagePointColorSample & { baseLabel: string }) | null;
  protectedColorPicking: boolean;
  protectedColorAnalysing: boolean;
  colorMatchReview: (ImageColorMatchAnalysis & {
    fileName: string;
    baseOutputSha256: string;
    baseLabel: string;
  }) | null;
  colorMatchAnalysing: boolean;
  cubeLut: ImportedImageCubeLut | null;
  cubeLutImporting: boolean;
  colorVisionMode: ImageColorVisionSelection;
  colorVisionBusy: boolean;
  colorVisionError: string | null;
  colorVisionSourceLabel: string | null;
  busy: boolean;
  canSampleWhiteBalance: boolean;
  canSamplePointColor: boolean;
  canSampleProtectedColor: boolean;
  canAnalyzeColorMatch: boolean;
  canPreviewColorVision: boolean;
  canApply: boolean;
  canDownload: boolean;
  onRecipe: (recipe: ImageColorRecipe) => void;
  onToggleWhiteBalancePicker: () => void;
  onUseWhiteBalanceSuggestion: () => void;
  onDismissWhiteBalanceSuggestion: () => void;
  onTogglePointColorPicker: () => void;
  onDismissPointColor: () => void;
  onToggleProtectedColorPicker: () => void;
  onAddProtectedColor: (kind: ImageProtectedColorKind) => void;
  onDismissProtectedColorReview: () => void;
  onAnalyzeColorMatch: (file: File) => void;
  onUseColorMatch: () => void;
  onDismissColorMatchReview: () => void;
  onClearColorMatch: () => void;
  onImportCubeLut: (file: File) => void;
  onClearCubeLut: () => void;
  onColorVisionMode: (mode: ImageColorVisionSelection) => void;
  onApply: () => void;
  onReset: () => void;
  onDownload: () => void;
}

const colorControls: Array<{
  key: "temperature" | "tint" | "saturation" | "vibrance";
  label: string;
}> = [
  { key: "temperature", label: "Temperature" },
  { key: "tint", label: "Tint" },
  { key: "saturation", label: "Saturation" },
  { key: "vibrance", label: "Vibrance" },
];

const selectiveColorLabels: Record<ImageSelectiveColorRange, string> = {
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  aqua: "Aqua",
  blue: "Blue",
  purple: "Purple",
  magenta: "Magenta",
};

const selectiveHslControls: Array<{
  key: keyof ImageSelectiveHslAdjustment;
  label: string;
}> = [
  { key: "hue", label: "Hue" },
  { key: "saturation", label: "Saturation" },
  { key: "lightness", label: "Lightness" },
];

const colorGradingLabels: Record<ImageColorGradingRange, string> = {
  shadows: "Shadows",
  midtones: "Midtones",
  highlights: "Highlights",
};

const colorGradingControls: Array<{
  key: keyof ImageColorGrade;
  label: string;
  minimum: number;
  maximum: number;
}> = [
  { key: "hue", label: "Hue", minimum: 0, maximum: 359 },
  { key: "saturation", label: "Saturation", minimum: 0, maximum: 100 },
  { key: "luminance", label: "Luminance", minimum: -100, maximum: 100 },
];

const blackAndWhiteControls: Array<{
  key: keyof Pick<ImageBlackAndWhiteRecipe, "red" | "green" | "blue">;
  label: string;
}> = [
  { key: "red", label: "Red" },
  { key: "green", label: "Green" },
  { key: "blue", label: "Blue" },
];

const duotoneToneControls: Array<{
  label: string;
  hueKey: keyof Pick<ImageDuotoneRecipe, "shadowHue" | "highlightHue">;
  saturationKey: keyof Pick<ImageDuotoneRecipe, "shadowSaturation" | "highlightSaturation">;
}> = [
  { label: "Shadow", hueKey: "shadowHue", saturationKey: "shadowSaturation" },
  { label: "Highlight", hueKey: "highlightHue", saturationKey: "highlightSaturation" },
];

const protectedColorKindLabels: Record<ImageProtectedColorKind, string> = {
  brand: "Brand colour",
  product: "Product colour",
  "skin-critical": "Skin-critical colour",
};

export function ColorToolPanel(props: ColorToolPanelProps) {
  const colorMatchInput = useRef<HTMLInputElement>(null);
  const cubeLutInput = useRef<HTMLInputElement>(null);
  const [selectedRange, setSelectedRange] = useState<ImageSelectiveColorRange>("red");
  const [selectedGrade, setSelectedGrade] = useState<ImageColorGradingRange>("shadows");
  const [protectedColorKind, setProtectedColorKind] = useState<ImageProtectedColorKind>("brand");
  const [customColorPresets, setCustomColorPresets] = useState<ImageColorCustomPreset[]>([]);
  const [customColorPresetName, setCustomColorPresetName] = useState("");
  const [customColorPresetMessage, setCustomColorPresetMessage] = useState<string | null>(null);
  const [customColorPresetError, setCustomColorPresetError] = useState<string | null>(null);
  const [renamingColorPresetId, setRenamingColorPresetId] = useState<string | null>(null);
  const [renamingColorPresetName, setRenamingColorPresetName] = useState("");
  const [deletingColorPresetId, setDeletingColorPresetId] = useState<string | null>(null);
  useEffect(() => {
    const refresh = () => {
      try {
        setCustomColorPresets(readImageColorCustomPresets(localStorage));
      } catch {
        setCustomColorPresetError("Saved colour presets are unavailable in this browser profile.");
      }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === IMAGE_COLOR_CUSTOM_PRESET_STORAGE_KEY) refresh();
    };
    refresh();
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const neutral = isNeutralColor(props.recipe);
  const activeColorPreset = matchingImageColorPreset(props.recipe);
  const activeCustomColorPreset = customColorPresets.find((preset) => sameColorRecipe(preset.recipe, props.recipe)) ?? null;
  const hasSourceBoundColorSettings = hasSourceBoundImageColorSettings(props.recipe);
  const portableColorRecipe = isPortableImageColorRecipe(props.recipe);
  const suggestionLoaded = props.whiteBalanceSuggestionUsed;
  const selectedAdjustment = props.recipe.selectiveHsl[selectedRange];
  const selectedRangeNeutral = Object.values(selectedAdjustment).every((value) => value === 0);
  const selectedGradeAdjustment = props.recipe.colorGrading[selectedGrade];
  const selectedGradeNeutral = selectedGradeAdjustment.saturation === 0 && selectedGradeAdjustment.luminance === 0;
  const blackAndWhiteTotal = props.recipe.blackAndWhite.red
    + props.recipe.blackAndWhite.green
    + props.recipe.blackAndWhite.blue;
  const blackAndWhiteInvalid = props.recipe.blackAndWhite.enabled && blackAndWhiteTotal === 0;
  const duotoneIsDefault = !props.recipe.duotone.enabled
    && props.recipe.duotone.shadowHue === 220 && props.recipe.duotone.shadowSaturation === 35
    && props.recipe.duotone.highlightHue === 40 && props.recipe.duotone.highlightSaturation === 25
    && props.recipe.duotone.balance === 0;
  const colorMatchLoaded = Boolean(props.recipe.colorMatch && props.colorMatchReview
    && analysisMatchesColorMatchRecipe(
      props.colorMatchReview,
      props.recipe.colorMatch,
      props.colorMatchReview.baseOutputSha256,
    ));
  const commitCustomColorPresets = (next: ImageColorCustomPreset[], message: string) => {
    try {
      persistImageColorCustomPresets(localStorage, next);
      setCustomColorPresets(next);
      setCustomColorPresetError(null);
      setCustomColorPresetMessage(message);
      return true;
    } catch {
      setCustomColorPresetMessage(null);
      setCustomColorPresetError("The browser could not save this colour preset. Existing presets were left unchanged.");
      return false;
    }
  };
  const saveCustomColorPreset = () => {
    try {
      const next = addImageColorCustomPreset(
        customColorPresets,
        customColorPresetName,
        props.recipe,
        `colour-${crypto.randomUUID()}`,
      );
      const saved = next[next.length - 1]!;
      if (commitCustomColorPresets(next, `Saved "${saved.name}" in this browser profile.`)) {
        setCustomColorPresetName("");
      }
    } catch (error) {
      setCustomColorPresetMessage(null);
      setCustomColorPresetError(error instanceof Error ? error.message : "The colour preset could not be saved.");
    }
  };
  return <aside className="quality-tool-panel quality-controls" aria-label="Colour controls">
    <div className="quality-panel-heading"><Palette aria-hidden="true" /><div><h2>Colour</h2><p>Bounded global and selective correction after light and tone.</p></div></div>
    <fieldset className="quality-tone-presets quality-color-presets">
      <legend>Built-in colour looks</legend>
      <div className="quality-tone-preset-status">
        <span>{activeColorPreset ? activeColorPreset.label : neutral ? "Neutral colour" : "Custom colour"}</span>
        <small>Built-in collection v{IMAGE_COLOR_PRESET_VERSION}</small>
      </div>
      <div className="quality-tone-preset-grid">
        {IMAGE_COLOR_PRESETS.map((preset) => <button
          key={preset.id}
          type="button"
          aria-pressed={activeColorPreset?.id === preset.id}
          disabled={props.busy || hasSourceBoundColorSettings}
          onClick={() => props.onRecipe(imageColorPreset(preset.id).recipe)}
        >
          <span><strong>{preset.label}</strong><small>{preset.intent === "corrective" ? "Corrective" : "Creative"}</small></span>
          <span>{preset.description}</span>
        </button>)}
      </div>
      <p>A look loads a complete, versioned deterministic colour recipe. Review the controls, then choose Apply colour; selection alone never changes pixels.</p>
      {hasSourceBoundColorSettings && <p className="quality-color-preset-warning" role="status">Remove active point-colour, reference-match, LUT and protected-colour settings before replacing the recipe with a built-in look.</p>}
    </fieldset>
    <fieldset className="quality-custom-presets quality-custom-color-presets">
      <legend>My colour presets</legend>
      <p>Saved names and portable colour settings stay only in this browser profile. They are not synced, shared or embedded as preset names in exported files.</p>
      <form className="quality-custom-preset-create" onSubmit={(event) => {
        event.preventDefault();
        saveCustomColorPreset();
      }}>
        <label>
          <span>Colour preset name</span>
          <input
            type="text"
            maxLength={MAX_IMAGE_COLOR_CUSTOM_PRESET_NAME_LENGTH}
            value={customColorPresetName}
            disabled={props.busy || customColorPresets.length >= MAX_IMAGE_COLOR_CUSTOM_PRESETS}
            onChange={(event) => {
              setCustomColorPresetName(event.target.value);
              setCustomColorPresetError(null);
              setCustomColorPresetMessage(null);
            }}
          />
        </label>
        <Button
          type="submit"
          size="compact"
          disabled={props.busy || !customColorPresetName.trim() || neutral || Boolean(activeColorPreset)
            || Boolean(activeCustomColorPreset) || !portableColorRecipe
            || customColorPresets.length >= MAX_IMAGE_COLOR_CUSTOM_PRESETS}
        >Save current colour recipe</Button>
      </form>
      {neutral && <small>Change at least one portable colour setting before saving.</small>}
      {activeColorPreset && <small>"{activeColorPreset.label}" is already available in the built-in collection.</small>}
      {!activeColorPreset && activeCustomColorPreset && <small>This recipe is already saved as "{activeCustomColorPreset.name}".</small>}
      {hasSourceBoundColorSettings && <small className="quality-color-preset-warning" role="status">Source-bound point colour, reference matching, LUTs and protected-colour anchors cannot be saved in a reusable preset. Clear them first.</small>}
      {!hasSourceBoundColorSettings && !portableColorRecipe && !neutral && <small className="quality-color-preset-warning" role="status">Resolve invalid colour controls before saving this recipe.</small>}
      <small>{customColorPresets.length} of {MAX_IMAGE_COLOR_CUSTOM_PRESETS} local colour presets used.</small>
      {customColorPresetMessage && <p className="quality-custom-preset-message" role="status">{customColorPresetMessage}</p>}
      {customColorPresetError && <p className="quality-custom-preset-error" role="alert">{customColorPresetError}</p>}
      {customColorPresets.length === 0
        ? <p className="quality-custom-preset-empty">No saved colour presets in this browser profile.</p>
        : <ul className="quality-custom-preset-list" aria-label="Saved colour presets">
          {customColorPresets.map((preset) => <li key={preset.id}>
            {renamingColorPresetId === preset.id
              ? <form className="quality-custom-preset-rename" onSubmit={(event) => {
                event.preventDefault();
                try {
                  const next = renameImageColorCustomPreset(customColorPresets, preset.id, renamingColorPresetName);
                  const renamed = next.find((item) => item.id === preset.id)!;
                  if (commitCustomColorPresets(next, `Renamed colour preset to "${renamed.name}".`)) {
                    setRenamingColorPresetId(null);
                    setRenamingColorPresetName("");
                  }
                } catch (error) {
                  setCustomColorPresetMessage(null);
                  setCustomColorPresetError(error instanceof Error ? error.message : "The colour preset could not be renamed.");
                }
              }}>
                <label><span>Rename {preset.name}</span><input
                  type="text"
                  maxLength={MAX_IMAGE_COLOR_CUSTOM_PRESET_NAME_LENGTH}
                  value={renamingColorPresetName}
                  autoFocus
                  onChange={(event) => setRenamingColorPresetName(event.target.value)}
                /></label>
                <div><Button type="submit" size="compact" disabled={!renamingColorPresetName.trim()}>Save name</Button><Button type="button" size="compact" onClick={() => {
                  setRenamingColorPresetId(null);
                  setRenamingColorPresetName("");
                }}>Cancel rename</Button></div>
              </form>
              : <>
                <button
                  type="button"
                  className="quality-custom-preset-apply"
                  aria-pressed={activeCustomColorPreset?.id === preset.id && !activeColorPreset}
                  disabled={props.busy || hasSourceBoundColorSettings}
                  onClick={() => {
                    setCustomColorPresetError(null);
                    setCustomColorPresetMessage(`Loaded "${preset.name}". Choose Apply colour to change pixels.`);
                    props.onRecipe(sanitizeColorRecipe(preset.recipe));
                  }}
                ><strong>{preset.name}</strong><span>Apply saved colour recipe</span></button>
                <div className="quality-custom-preset-actions">
                  <Button type="button" size="compact" disabled={props.busy} onClick={() => {
                    setRenamingColorPresetId(preset.id);
                    setRenamingColorPresetName(preset.name);
                    setDeletingColorPresetId(null);
                    setCustomColorPresetError(null);
                    setCustomColorPresetMessage(null);
                  }}>Rename {preset.name}</Button>
                  {deletingColorPresetId === preset.id
                    ? <><Button type="button" size="compact" tone="danger" onClick={() => {
                      try {
                        const next = removeImageColorCustomPreset(customColorPresets, preset.id);
                        if (commitCustomColorPresets(next, `Deleted "${preset.name}" from this browser profile.`)) {
                          setDeletingColorPresetId(null);
                        }
                      } catch (error) {
                        setCustomColorPresetMessage(null);
                        setCustomColorPresetError(error instanceof Error ? error.message : "The colour preset could not be deleted.");
                      }
                    }}>Confirm delete {preset.name}</Button><Button type="button" size="compact" onClick={() => setDeletingColorPresetId(null)}>Cancel delete</Button></>
                    : <Button type="button" size="compact" tone="danger" disabled={props.busy} onClick={() => {
                      setDeletingColorPresetId(preset.id);
                      setRenamingColorPresetId(null);
                      setCustomColorPresetError(null);
                      setCustomColorPresetMessage(null);
                    }}>Delete {preset.name}</Button>}
                </div>
              </>}
          </li>)}
        </ul>}
    </fieldset>
    <fieldset className="quality-auto-tone quality-white-balance">
      <legend>Neutral-point white balance</legend>
      <Button
        size="compact"
        disabled={props.busy || !props.canSampleWhiteBalance}
        onClick={props.onToggleWhiteBalancePicker}
      ><Pipette aria-hidden="true" />{props.whiteBalancePicking ? "Cancel neutral sampling" : "Pick neutral point"}</Button>
      <p>Choose a surface that should be neutral grey or white. The worker measures a small visible patch from the exact pre-colour base and proposes Temperature and Tint; nothing changes until you use and apply it.</p>
      {props.whiteBalancePicking && <p role="status">Select a point in the Result viewer. Keyboard users can zoom and pan, then press Enter or Space to sample the viewer centre.</p>}
      {props.whiteBalanceAnalysing && <p role="status">Measuring the selected neutral patch.</p>}
      {props.whiteBalanceSuggestion && <div className="quality-auto-tone-result" data-testid="white-balance-suggestion">
        <strong role="status">{props.whiteBalanceSuggestion.temperature === 0 && props.whiteBalanceSuggestion.tint === 0
          ? "The sampled patch is already neutral"
          : "Review white-balance suggestion"}</strong>
        <p>Sampled from {props.whiteBalanceBaseLabel ?? "the verified pre-colour image"}.</p>
        <dl>
          <div><dt>Source point</dt><dd>{props.whiteBalanceSuggestion.sourceX}, {props.whiteBalanceSuggestion.sourceY}</dd></div>
          <div><dt>Measured RGB</dt><dd>{props.whiteBalanceSuggestion.red}, {props.whiteBalanceSuggestion.green}, {props.whiteBalanceSuggestion.blue}</dd></div>
          <div><dt>Proposed Temperature</dt><dd>{props.whiteBalanceSuggestion.temperature > 0 ? "+" : ""}{props.whiteBalanceSuggestion.temperature}</dd></div>
          <div><dt>Proposed Tint</dt><dd>{props.whiteBalanceSuggestion.tint > 0 ? "+" : ""}{props.whiteBalanceSuggestion.tint}</dd></div>
        </dl>
        {props.whiteBalanceSuggestion.atLimit && <p>The measured cast reaches a safe correction limit. Confirm that the sampled surface is truly neutral before applying.</p>}
        <div className="quality-control-group">
          <Button size="compact" disabled={props.busy || suggestionLoaded} onClick={props.onUseWhiteBalanceSuggestion}>Use suggestion</Button>
          <Button size="compact" disabled={props.busy} onClick={props.onDismissWhiteBalanceSuggestion}>Dismiss</Button>
        </div>
        {suggestionLoaded && <p>Suggested values are loaded into Temperature and Tint. Review them, then choose Apply colour.</p>}
      </div>}
    </fieldset>
    <div className="quality-adjustment-controls">
      {colorControls.map((control) => <label className="quality-adjustment-control" key={control.key}>
        <span><strong>{control.label}</strong><output>{props.recipe[control.key] > 0 ? "+" : ""}{props.recipe[control.key]}</output></span>
        <input
          aria-label={control.label}
          type="range"
          min="-100"
          max="100"
          step="1"
          value={props.recipe[control.key]}
          disabled={props.busy}
          onChange={(event) => props.onRecipe({ ...props.recipe, [control.key]: Number(event.target.value) })}
        />
      </label>)}
    </div>
    <fieldset className="quality-levels-control quality-selective-hsl">
      <legend>Selective HSL</legend>
      <div className="quality-selective-ranges" role="group" aria-label="Selective colour range">
        {IMAGE_SELECTIVE_COLOR_RANGES.map((range) => {
          const adjusted = Object.values(props.recipe.selectiveHsl[range]).some((value) => value !== 0);
          return <button
            type="button"
            key={range}
            data-range={range}
            data-adjusted={adjusted}
            aria-label={`${selectiveColorLabels[range]} range, ${adjusted ? "adjusted" : "neutral"}`}
            aria-pressed={selectedRange === range}
            disabled={props.busy}
            onClick={() => setSelectedRange(range)}
          ><span aria-hidden="true" />{selectiveColorLabels[range]}</button>;
        })}
      </div>
      <div className="quality-adjustment-controls">
        {selectiveHslControls.map((control) => <label className="quality-adjustment-control" key={control.key}>
          <span><strong>{selectiveColorLabels[selectedRange]} {control.label.toLowerCase()}</strong><output>{selectedAdjustment[control.key] > 0 ? "+" : ""}{selectedAdjustment[control.key]}</output></span>
          <input
            aria-label={`${selectiveColorLabels[selectedRange]} ${control.label.toLowerCase()}`}
            type="range"
            min="-100"
            max="100"
            step="1"
            value={selectedAdjustment[control.key]}
            disabled={props.busy}
            onChange={(event) => props.onRecipe({
              ...props.recipe,
              selectiveHsl: {
                ...props.recipe.selectiveHsl,
                [selectedRange]: {
                  ...selectedAdjustment,
                  [control.key]: Number(event.target.value),
                },
              },
            })}
          />
        </label>)}
      </div>
      <Button size="compact" disabled={props.busy || selectedRangeNeutral} onClick={() => props.onRecipe({
        ...props.recipe,
        selectiveHsl: {
          ...props.recipe.selectiveHsl,
          [selectedRange]: { hue: 0, saturation: 0, lightness: 0 },
        },
      })}><RotateCcw aria-hidden="true" />Reset {selectiveColorLabels[selectedRange]}</Button>
      <p>Adjusts the selected hue family with smooth transitions into neighbouring ranges. Hue rotates by at most 30 degrees. Near-neutral colours, transparency and alpha are protected.</p>
    </fieldset>
    <fieldset className="quality-levels-control quality-point-color">
      <legend>Point colour</legend>
      <Button
        size="compact"
        disabled={props.busy || !props.canSamplePointColor}
        onClick={props.onTogglePointColorPicker}
      ><Pipette aria-hidden="true" />{props.pointColorPicking ? "Cancel colour sampling" : "Pick colour from image"}</Button>
      <p>Sample one visible coloured area from the exact pre-colour base. Its hue becomes a source-bound target; no pixels change until you adjust the controls and apply colour.</p>
      {props.pointColorPicking && <p role="status">Select a coloured point in the Result viewer. Keyboard users can zoom and pan, then press Enter or Space to sample the viewer centre.</p>}
      {props.pointColorAnalysing && <p role="status">Measuring the selected colour patch.</p>}
      {props.pointColorSample && <div className="quality-auto-tone-result" data-testid="point-color-sample">
        <div className="quality-point-color-heading">
          <span
            className="quality-point-color-swatch"
            aria-hidden="true"
            style={{ backgroundColor: `rgb(${props.pointColorSample.red} ${props.pointColorSample.green} ${props.pointColorSample.blue})` }}
          />
          <div><strong role="status">Sampled colour ready</strong><p>Sampled from {props.pointColorBaseLabel ?? "the verified pre-colour image"}.</p></div>
        </div>
        <dl>
          <div><dt>Source point</dt><dd>{props.pointColorSample.sourceX}, {props.pointColorSample.sourceY}</dd></div>
          <div><dt>Measured RGB</dt><dd>{props.pointColorSample.red}, {props.pointColorSample.green}, {props.pointColorSample.blue}</dd></div>
          <div><dt>Target hue</dt><dd>{props.pointColorSample.hue} degrees</dd></div>
          <div><dt>Measured S/L</dt><dd>{props.pointColorSample.saturation}% / {props.pointColorSample.lightness}%</dd></div>
        </dl>
      </div>}
      <div className="quality-adjustment-controls">
        <label className="quality-adjustment-control">
          <span><strong>Target tolerance</strong><output>{props.recipe.pointColor.tolerance} degrees</output></span>
          <input
            aria-label="Point-colour target tolerance"
            type="range"
            min="5"
            max="60"
            step="1"
            value={props.recipe.pointColor.tolerance}
            disabled={props.busy || !props.recipe.pointColor.enabled}
            onChange={(event) => props.onRecipe({
              ...props.recipe,
              pointColor: { ...props.recipe.pointColor, tolerance: Number(event.target.value) },
            })}
          />
        </label>
        <label className="quality-adjustment-control">
          <span><strong>Edge feather</strong><output>{props.recipe.pointColor.feather} degrees</output></span>
          <input
            aria-label="Point-colour edge feather"
            type="range"
            min="1"
            max="60"
            step="1"
            value={props.recipe.pointColor.feather}
            disabled={props.busy || !props.recipe.pointColor.enabled}
            onChange={(event) => props.onRecipe({
              ...props.recipe,
              pointColor: { ...props.recipe.pointColor, feather: Number(event.target.value) },
            })}
          />
        </label>
        {selectiveHslControls.map((control) => <label className="quality-adjustment-control" key={control.key}>
          <span><strong>Point {control.label.toLowerCase()}</strong><output>{props.recipe.pointColor[control.key] > 0 ? "+" : ""}{props.recipe.pointColor[control.key]}</output></span>
          <input
            aria-label={`Point-colour ${control.label.toLowerCase()}`}
            type="range"
            min="-100"
            max="100"
            step="1"
            value={props.recipe.pointColor[control.key]}
            disabled={props.busy || !props.recipe.pointColor.enabled}
            onChange={(event) => props.onRecipe({
              ...props.recipe,
              pointColor: { ...props.recipe.pointColor, [control.key]: Number(event.target.value) },
            })}
          />
        </label>)}
      </div>
      <div className="quality-control-group">
        <Button size="compact" disabled={props.busy || !props.recipe.pointColor.enabled
          || (props.recipe.pointColor.hue === 0 && props.recipe.pointColor.saturation === 0 && props.recipe.pointColor.lightness === 0
            && props.recipe.pointColor.tolerance === 18 && props.recipe.pointColor.feather === 18)} onClick={() => props.onRecipe({
          ...props.recipe,
          pointColor: { ...props.recipe.pointColor, tolerance: 18, feather: 18, hue: 0, saturation: 0, lightness: 0 },
        })}><RotateCcw aria-hidden="true" />Reset point adjustments</Button>
        <Button size="compact" disabled={props.busy || !props.recipe.pointColor.enabled} onClick={props.onDismissPointColor}><X aria-hidden="true" />Clear sampled colour</Button>
      </div>
      <p>Pixels inside the tolerance receive the full adjustment; feathering creates a smooth circular hue transition. Near-neutral colours, transparency and alpha remain protected.</p>
    </fieldset>
    <fieldset className="quality-levels-control quality-protected-colors">
      <legend>Protected colours</legend>
      <div className="quality-control-group">
        <Button
          size="compact"
          disabled={props.busy || !props.canSampleProtectedColor}
          onClick={props.onToggleProtectedColorPicker}
        ><Pipette aria-hidden="true" />{props.protectedColorPicking ? "Cancel protection sampling" : "Pick colour to protect"}</Button>
        <span>{props.recipe.protectedColors.length} / {MAX_PROTECTED_COLOR_ANCHORS} anchors</span>
      </div>
      <p>Sample an exact colour from the verified pre-colour base, review its purpose, then add it. Sampling alone never changes pixels.</p>
      {props.protectedColorPicking && <p role="status">Select the colour to protect in the Result viewer. Keyboard users can press Enter or Space to sample the viewer centre.</p>}
      {props.protectedColorAnalysing && <p role="status">Measuring the protected colour patch.</p>}
      {props.protectedColorReview && <div className="quality-auto-tone-result" data-testid="protected-color-review">
        <div className="quality-point-color-heading">
          <span
            className="quality-point-color-swatch"
            aria-hidden="true"
            style={{ backgroundColor: `rgb(${props.protectedColorReview.red} ${props.protectedColorReview.green} ${props.protectedColorReview.blue})` }}
          />
          <div><strong role="status">Protected-colour sample ready for review</strong><p>Sampled from {props.protectedColorReview.baseLabel}.</p></div>
        </div>
        <dl>
          <div><dt>Source point</dt><dd>{props.protectedColorReview.sourceX}, {props.protectedColorReview.sourceY}</dd></div>
          <div><dt>Measured RGB</dt><dd>{props.protectedColorReview.red}, {props.protectedColorReview.green}, {props.protectedColorReview.blue}</dd></div>
          <div><dt>Measured H/S/L</dt><dd>{props.protectedColorReview.hue}° / {props.protectedColorReview.saturation}% / {props.protectedColorReview.lightness}%</dd></div>
        </dl>
        <label className="quality-field">
          <span>Protection purpose</span>
          <select
            aria-label="Protected-colour purpose"
            value={protectedColorKind}
            disabled={props.busy}
            onChange={(event) => setProtectedColorKind(event.target.value as ImageProtectedColorKind)}
          >
            {IMAGE_PROTECTED_COLOR_KINDS.map((kind) => <option key={kind} value={kind}>{protectedColorKindLabels[kind]}</option>)}
          </select>
        </label>
        <div className="quality-control-group">
          <Button size="compact" disabled={props.busy} onClick={() => props.onAddProtectedColor(protectedColorKind)}>
            <Palette aria-hidden="true" />Add protected colour
          </Button>
          <Button size="compact" disabled={props.busy} onClick={props.onDismissProtectedColorReview}>
            <X aria-hidden="true" />Dismiss sample
          </Button>
        </div>
      </div>}
      {props.recipe.protectedColors.map((anchor, index) => <section
        className="quality-protected-color-anchor"
        data-testid="protected-color-anchor"
        key={`${anchor.sourceBaseSha256}-${anchor.sourceX}-${anchor.sourceY}-${index}`}
      >
        <div className="quality-point-color-heading">
          <span className="quality-point-color-swatch" aria-hidden="true" style={{ backgroundColor: `rgb(${anchor.red} ${anchor.green} ${anchor.blue})` }} />
          <div><strong>{protectedColorKindLabels[anchor.kind]}</strong><p>RGB {anchor.red}, {anchor.green}, {anchor.blue} · source {anchor.sourceX}, {anchor.sourceY}</p></div>
        </div>
        <label className="quality-toggle-control">
          <input
            type="checkbox"
            checked={anchor.enabled}
            disabled={props.busy}
            onChange={(event) => props.onRecipe({
              ...props.recipe,
              protectedColors: props.recipe.protectedColors.map((item, itemIndex) => (
                itemIndex === index ? { ...item, enabled: event.target.checked } : item
              )),
            })}
          />
          <span><strong>Enable protection</strong><small>Keep this reviewed anchor while temporarily disabling its blend-back.</small></span>
        </label>
        {([
          { key: "tolerance", label: "Hue tolerance", minimum: 5, maximum: 60, suffix: "°" },
          { key: "feather", label: "Hue feather", minimum: 1, maximum: 60, suffix: "°" },
          { key: "strength", label: "Protection strength", minimum: 0, maximum: 100, suffix: "%" },
        ] as const).map((control) => <label className="quality-adjustment-control" key={control.key}>
          <span><strong>{control.label}</strong><output>{anchor[control.key]}{control.suffix}</output></span>
          <input
            aria-label={`${protectedColorKindLabels[anchor.kind]} ${control.label.toLowerCase()}`}
            type="range"
            min={control.minimum}
            max={control.maximum}
            step="1"
            value={anchor[control.key]}
            disabled={props.busy || !anchor.enabled}
            onChange={(event) => props.onRecipe({
              ...props.recipe,
              protectedColors: props.recipe.protectedColors.map((item, itemIndex) => (
                itemIndex === index ? { ...item, [control.key]: Number(event.target.value) } : item
              )),
            })}
          />
        </label>)}
        <Button size="compact" disabled={props.busy} onClick={() => props.onRecipe({
          ...props.recipe,
          protectedColors: props.recipe.protectedColors.filter((_, itemIndex) => itemIndex !== index),
        })}><X aria-hidden="true" />Remove protected colour</Button>
      </section>)}
      <p>This protects only pixels similar in hue, saturation and lightness to each reviewed sample. It does not identify people, skin, brands, products or object boundaries. Precise region isolation belongs in a future Select/Mask tool.</p>
    </fieldset>
    <fieldset className="quality-levels-control quality-color-grading">
      <legend>Tonal colour grading</legend>
      <div className="quality-grading-ranges" role="group" aria-label="Tonal grading range">
        {IMAGE_COLOR_GRADING_RANGES.map((range) => {
          const grade = props.recipe.colorGrading[range];
          const adjusted = grade.saturation !== 0 || grade.luminance !== 0;
          return <button
            type="button"
            key={range}
            data-adjusted={adjusted}
            aria-label={`${colorGradingLabels[range]} grade, ${adjusted ? "adjusted" : "neutral"}`}
            aria-pressed={selectedGrade === range}
            disabled={props.busy}
            onClick={() => setSelectedGrade(range)}
          >{colorGradingLabels[range]}</button>;
        })}
      </div>
      <div className="quality-grade-preview" aria-hidden="true">
        <span style={{ backgroundColor: `hsl(${selectedGradeAdjustment.hue} 100% 50%)` }} />
        <strong>{colorGradingLabels[selectedGrade]}</strong>
      </div>
      <div className="quality-adjustment-controls">
        {colorGradingControls.map((control) => <label className="quality-adjustment-control" key={control.key}>
          <span><strong>{colorGradingLabels[selectedGrade]} {control.label.toLowerCase()}</strong><output>{control.key !== "hue" && selectedGradeAdjustment[control.key] > 0 ? "+" : ""}{selectedGradeAdjustment[control.key]}{control.key === "hue" ? " degrees" : ""}</output></span>
          <input
            className={control.key === "hue" ? "quality-grade-hue" : undefined}
            aria-label={`${colorGradingLabels[selectedGrade]} ${control.label.toLowerCase()}`}
            type="range"
            min={control.minimum}
            max={control.maximum}
            step="1"
            value={selectedGradeAdjustment[control.key]}
            disabled={props.busy}
            onChange={(event) => props.onRecipe({
              ...props.recipe,
              colorGrading: {
                ...props.recipe.colorGrading,
                [selectedGrade]: {
                  ...selectedGradeAdjustment,
                  [control.key]: Number(event.target.value),
                },
              },
            })}
          />
        </label>)}
      </div>
      <Button size="compact" disabled={props.busy || selectedGradeNeutral} onClick={() => props.onRecipe({
        ...props.recipe,
        colorGrading: {
          ...props.recipe.colorGrading,
          [selectedGrade]: { hue: 0, saturation: 0, luminance: 0 },
        },
      })}><RotateCcw aria-hidden="true" />Reset {colorGradingLabels[selectedGrade]}</Button>
      <p>Uses smooth, overlapping luminance masks so edits transition naturally between tonal ranges. Exact black, exact white, transparency and alpha are protected. Tinting is bounded to available gamut and does not generate detail.</p>
    </fieldset>
    <fieldset className="quality-levels-control quality-black-and-white">
      <legend>Black-and-white mixer</legend>
      <label className="quality-toggle-control">
        <input
          type="checkbox"
          checked={props.recipe.blackAndWhite.enabled}
          disabled={props.busy}
          onChange={(event) => props.onRecipe({
            ...props.recipe,
            blackAndWhite: { ...props.recipe.blackAndWhite, enabled: event.target.checked },
          })}
        />
        <span><strong>Enable black-and-white mixer</strong><small>Convert the final colour result using weighted source channels.</small></span>
      </label>
      <div className="quality-adjustment-controls">
        {blackAndWhiteControls.map((control) => <label className="quality-adjustment-control" key={control.key}>
          <span><strong>{control.label} mix</strong><output>{props.recipe.blackAndWhite[control.key]}%</output></span>
          <input
            aria-label={`Black-and-white ${control.label.toLowerCase()} mix`}
            type="range"
            min="0"
            max="100"
            step="1"
            value={props.recipe.blackAndWhite[control.key]}
            disabled={props.busy || !props.recipe.blackAndWhite.enabled}
            onChange={(event) => props.onRecipe({
              ...props.recipe,
              blackAndWhite: {
                ...props.recipe.blackAndWhite,
                [control.key]: Number(event.target.value),
              },
            })}
          />
        </label>)}
      </div>
      <p className={blackAndWhiteInvalid ? "quality-control-error" : undefined} role={blackAndWhiteInvalid ? "alert" : "status"}>
        {blackAndWhiteInvalid
          ? "Set at least one colour channel above zero before applying."
          : `Channel total: ${blackAndWhiteTotal}%. The worker normalizes these weights, so their relative balance controls the monochrome result.`}
      </p>
      <Button size="compact" disabled={props.busy || (!props.recipe.blackAndWhite.enabled
        && props.recipe.blackAndWhite.red === 40 && props.recipe.blackAndWhite.green === 40
        && props.recipe.blackAndWhite.blue === 20)} onClick={() => props.onRecipe({
        ...props.recipe,
        blackAndWhite: { enabled: false, red: 40, green: 40, blue: 20 },
      })}><RotateCcw aria-hidden="true" />Reset black and white</Button>
      <p>The mixer runs last in linear light. It creates no detail, preserves exact black and white, and leaves transparency and alpha unchanged.</p>
    </fieldset>
    <fieldset className="quality-levels-control quality-duotone">
      <legend>Duotone</legend>
      <label className="quality-toggle-control">
        <input
          type="checkbox"
          checked={props.recipe.duotone.enabled}
          disabled={props.busy}
          onChange={(event) => props.onRecipe({
            ...props.recipe,
            duotone: { ...props.recipe.duotone, enabled: event.target.checked },
          })}
        />
        <span><strong>Enable duotone</strong><small>Map luminance between separately controlled shadow and highlight tints.</small></span>
      </label>
      <div className="quality-duotone-tones">
        {duotoneToneControls.map((tone) => <section key={tone.label} aria-label={`${tone.label} duotone colour`}>
          <div className="quality-grade-preview" aria-hidden="true">
            <span style={{ backgroundColor: `hsl(${props.recipe.duotone[tone.hueKey]} ${props.recipe.duotone[tone.saturationKey]}% 50%)` }} />
            <strong>{tone.label}</strong>
          </div>
          <label className="quality-adjustment-control">
            <span><strong>{tone.label} hue</strong><output>{props.recipe.duotone[tone.hueKey]} degrees</output></span>
            <input
              className="quality-grade-hue"
              aria-label={`Duotone ${tone.label.toLowerCase()} hue`}
              type="range"
              min="0"
              max="359"
              step="1"
              value={props.recipe.duotone[tone.hueKey]}
              disabled={props.busy || !props.recipe.duotone.enabled}
              onChange={(event) => props.onRecipe({
                ...props.recipe,
                duotone: { ...props.recipe.duotone, [tone.hueKey]: Number(event.target.value) },
              })}
            />
          </label>
          <label className="quality-adjustment-control">
            <span><strong>{tone.label} saturation</strong><output>{props.recipe.duotone[tone.saturationKey]}%</output></span>
            <input
              aria-label={`Duotone ${tone.label.toLowerCase()} saturation`}
              type="range"
              min="0"
              max="100"
              step="1"
              value={props.recipe.duotone[tone.saturationKey]}
              disabled={props.busy || !props.recipe.duotone.enabled}
              onChange={(event) => props.onRecipe({
                ...props.recipe,
                duotone: { ...props.recipe.duotone, [tone.saturationKey]: Number(event.target.value) },
              })}
            />
          </label>
        </section>)}
      </div>
      <label className="quality-adjustment-control">
        <span><strong>Duotone balance</strong><output>{props.recipe.duotone.balance > 0 ? "+" : ""}{props.recipe.duotone.balance}</output></span>
        <input
          aria-label="Duotone balance"
          type="range"
          min="-100"
          max="100"
          step="1"
          value={props.recipe.duotone.balance}
          disabled={props.busy || !props.recipe.duotone.enabled}
          onChange={(event) => props.onRecipe({
            ...props.recipe,
            duotone: { ...props.recipe.duotone, balance: Number(event.target.value) },
          })}
        />
      </label>
      <Button size="compact" disabled={props.busy || duotoneIsDefault} onClick={() => props.onRecipe({
        ...props.recipe,
        duotone: {
          enabled: false,
          shadowHue: 220,
          shadowSaturation: 35,
          highlightHue: 40,
          highlightSaturation: 25,
          balance: 0,
        },
      })}><RotateCcw aria-hidden="true" />Reset duotone</Button>
      <p>Duotone runs after the optional channel mixer. Balance shifts the tint crossover: negative favors highlights and positive favors shadows. Luminance, exact black/white, transparency and alpha remain protected.</p>
    </fieldset>
    <fieldset className="quality-levels-control quality-color-match">
      <legend>Match colour from reference</legend>
      <input
        ref={colorMatchInput}
        className="sr-only"
        aria-label="Choose colour-match reference image"
        type="file"
        accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
        disabled={props.busy || props.colorMatchAnalysing || !props.canAnalyzeColorMatch}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) props.onAnalyzeColorMatch(file);
        }}
      />
      <div className="quality-control-group">
        <Button
          size="compact"
          disabled={props.busy || props.colorMatchAnalysing || !props.canAnalyzeColorMatch}
          onClick={() => colorMatchInput.current?.click()}
        ><Upload aria-hidden="true" />{props.colorMatchAnalysing
            ? "Analysing referenceâ€¦"
            : props.colorMatchReview || props.recipe.colorMatch ? "Analyse another reference" : "Choose reference image"}</Button>
        {props.colorMatchReview && !colorMatchLoaded && <Button
          size="compact"
          disabled={props.busy}
          onClick={props.onDismissColorMatchReview}
        ><X aria-hidden="true" />Dismiss proposal</Button>}
        {props.recipe.colorMatch && <Button size="compact" disabled={props.busy} onClick={props.onClearColorMatch}>
          <X aria-hidden="true" />Remove active match
        </Button>}
      </div>
      {props.colorMatchReview && <div className="quality-auto-tone-result" data-testid="color-match-review">
        <strong role="status">Reference analysis ready for review</strong>
        <p>Compared locally with {props.colorMatchReview.baseLabel}.</p>
        <dl>
          <div><dt>File</dt><dd>{props.colorMatchReview.fileName}</dd></div>
          <div><dt>Reference</dt><dd>{props.colorMatchReview.referenceWidth} Ã— {props.colorMatchReview.referenceHeight} px</dd></div>
          <div><dt>Verified type</dt><dd>{props.colorMatchReview.referenceMediaType}</dd></div>
          <div><dt>Reference SHA-256</dt><dd><code>{props.colorMatchReview.referenceSha256.slice(0, 12)}â€¦</code></dd></div>
          <div><dt>Source sample</dt><dd>{props.colorMatchReview.source.visiblePixels.toLocaleString()} visible pixels</dd></div>
          <div><dt>Reference sample</dt><dd>{props.colorMatchReview.reference.visiblePixels.toLocaleString()} visible pixels</dd></div>
        </dl>
        {!colorMatchLoaded && <Button size="compact" disabled={props.busy} onClick={props.onUseColorMatch}>
          <Palette aria-hidden="true" />Use colour match
        </Button>}
        {colorMatchLoaded && <p>The reviewed distribution is loaded. Adjust the controls below, then apply colour.</p>}
      </div>}
      {props.recipe.colorMatch && <div className="quality-adjustment-controls">
        <label className="quality-toggle-control">
          <input
            type="checkbox"
            checked={props.recipe.colorMatch.enabled}
            disabled={props.busy}
            onChange={(event) => props.onRecipe({
              ...props.recipe,
              colorMatch: { ...props.recipe.colorMatch!, enabled: event.target.checked },
            })}
          />
          <span><strong>Enable reference match</strong><small>Keep the reviewed recipe while temporarily disabling its transform.</small></span>
        </label>
        {([
          { key: "intensity", label: "Match strength" },
          { key: "luminance", label: "Luminance match" },
          { key: "colorIntensity", label: "Colour intensity" },
        ] as const).map((control) => <label className="quality-adjustment-control" key={control.key}>
          <span><strong>{control.label}</strong><output>{props.recipe.colorMatch![control.key]}%</output></span>
          <input
            aria-label={control.label}
            type="range"
            min="0"
            max="100"
            step="1"
            value={props.recipe.colorMatch![control.key]}
            disabled={props.busy || !props.recipe.colorMatch!.enabled}
            onChange={(event) => props.onRecipe({
              ...props.recipe,
              colorMatch: { ...props.recipe.colorMatch!, [control.key]: Number(event.target.value) },
            })}
          />
        </label>)}
        <label className="quality-toggle-control">
          <input
            type="checkbox"
            checked={props.recipe.colorMatch.protectNeutrals}
            disabled={props.busy || !props.recipe.colorMatch.enabled}
            onChange={(event) => props.onRecipe({
              ...props.recipe,
              colorMatch: { ...props.recipe.colorMatch!, protectNeutrals: event.target.checked },
            })}
          />
          <span><strong>Protect neutral colours</strong><small>Reduce chroma transfer on low-saturation greys and whites.</small></span>
        </label>
      </div>}
      <p>This deterministic local match transfers bounded display-referred sRGB colour-distribution statistics only. It does not copy structure or detail, infer semantic regions, retain reference bytes, or replace selective colour work. Exact black/white, transparency and alpha are protected.</p>
    </fieldset>
    <fieldset className="quality-levels-control quality-cube-lut">
      <legend>3D LUT</legend>
      <input
        ref={cubeLutInput}
        className="sr-only"
        aria-label="Choose 3D LUT file"
        type="file"
        accept=".cube,text/plain"
        disabled={props.busy || props.cubeLutImporting}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) props.onImportCubeLut(file);
        }}
      />
      <div className="quality-control-group">
        <Button
          size="compact"
          disabled={props.busy || props.cubeLutImporting}
          onClick={() => cubeLutInput.current?.click()}
        ><Upload aria-hidden="true" />{props.cubeLutImporting ? "Reading LUT…" : props.cubeLut ? "Replace LUT" : "Import .cube LUT"}</Button>
        {props.cubeLut && <Button size="compact" disabled={props.busy || props.cubeLutImporting} onClick={props.onClearCubeLut}>
          <X aria-hidden="true" />Remove LUT
        </Button>}
      </div>
      {props.cubeLut && props.recipe.cubeLut && <div className="quality-auto-tone-result" data-testid="cube-lut-review">
        <strong role="status">Reviewed 3D LUT ready</strong>
        <dl>
          <div><dt>File</dt><dd>{props.cubeLut.fileName}</dd></div>
          <div><dt>Title</dt><dd>{props.cubeLut.definition.title ?? "Not declared"}</dd></div>
          <div><dt>Grid</dt><dd>{props.cubeLut.definition.size} × {props.cubeLut.definition.size} × {props.cubeLut.definition.size}</dd></div>
          <div><dt>Input domain</dt><dd>{props.cubeLut.definition.domainMin.join(", ")} to {props.cubeLut.definition.domainMax.join(", ")}</dd></div>
          <div><dt>Interpolation</dt><dd>Tetrahedral</dd></div>
          <div><dt>SHA-256</dt><dd><code>{props.cubeLut.definition.sha256.slice(0, 12)}…</code></dd></div>
        </dl>
        <label className="quality-toggle-control">
          <input
            type="checkbox"
            checked={props.recipe.cubeLut.enabled}
            disabled={props.busy}
            onChange={(event) => props.onRecipe({
              ...props.recipe,
              cubeLut: { ...props.recipe.cubeLut!, enabled: event.target.checked },
            })}
          />
          <span><strong>Enable imported LUT</strong><small>Keep the reviewed file loaded while temporarily disabling its colour transform.</small></span>
        </label>
        <label className="quality-adjustment-control">
          <span><strong>LUT intensity</strong><output>{props.recipe.cubeLut.intensity}%</output></span>
          <input
            aria-label="3D LUT intensity"
            type="range"
            min="0"
            max="100"
            step="1"
            value={props.recipe.cubeLut.intensity}
            disabled={props.busy || !props.recipe.cubeLut.enabled}
            onChange={(event) => props.onRecipe({
              ...props.recipe,
              cubeLut: { ...props.recipe.cubeLut!, intensity: Number(event.target.value) },
            })}
          />
        </label>
      </div>}
      <p>This bounded local path accepts reviewed 3D IRIDAS .cube files up to a 65³ grid and applies them after creative colour transforms in display-referred sRGB. Reviewed protected-colour blend-back is the final safety constraint. One-dimensional, shaper and malformed LUTs fail visibly rather than being guessed. Out-of-gamut output is clipped and counted.</p>
    </fieldset>
    <fieldset className="quality-levels-control quality-color-vision">
      <legend>Colour-vision preview</legend>
      <div className="quality-control-group" role="group" aria-label="Colour-vision preview mode">
        <Button
          size="compact"
          aria-pressed={props.colorVisionMode === "standard"}
          disabled={props.colorVisionBusy}
          onClick={() => props.onColorVisionMode("standard")}
        >{IMAGE_COLOR_VISION_LABELS.standard}</Button>
        {IMAGE_COLOR_VISION_MODES.map((mode) => <Button
          key={mode}
          size="compact"
          aria-pressed={props.colorVisionMode === mode}
          disabled={props.colorVisionBusy || !props.canPreviewColorVision}
          onClick={() => props.onColorVisionMode(mode)}
        >{IMAGE_COLOR_VISION_LABELS[mode]}</Button>)}
      </div>
      {props.colorVisionBusy && <p role="status">Rendering the selected colour-vision preview locally…</p>}
      {props.colorVisionError && <p role="alert">{props.colorVisionError}</p>}
      {props.colorVisionMode !== "standard" && !props.colorVisionBusy && !props.colorVisionError && <p role="status">
        {IMAGE_COLOR_VISION_LABELS[props.colorVisionMode]} preview is active for {props.colorVisionSourceLabel ?? "the current verified image"}.
      </p>}
      <p>This is an approximate, display-referred sRGB simulation for design review. It changes only the Result preview; recipes, provenance and downloaded bytes stay unchanged. It is not a diagnosis, contrast conformance test, device proof or substitute for testing with people.</p>
    </fieldset>
    {props.statistics && <dl className="quality-adjustment-statistics">
      <div><dt>Changed pixels</dt><dd>{props.statistics.changedPixels.toLocaleString()}</dd></div>
      <div><dt>Gamut-clipped pixels</dt><dd>{props.statistics.gamutClippedPixels.toLocaleString()}</dd></div>
    </dl>}
    <div className="quality-actions">
      <Button tone="primary" disabled={!props.canApply || blackAndWhiteInvalid} onClick={props.onApply}><Palette aria-hidden="true" />{props.busy && !props.whiteBalanceAnalysing ? "Applying…" : "Apply colour"}</Button>
      <Button disabled={neutral && !props.statistics} onClick={props.onReset}><RotateCcw aria-hidden="true" />Reset colour</Button>
      <Button disabled={!props.canDownload || props.busy} onClick={props.onDownload}><Download aria-hidden="true" />Download colour-adjusted image</Button>
    </div>
    <p className="quality-view-note">Every apply starts from the latest verified geometry or tone result—not a previous colour result. Alpha is preserved. Local work is limited to {MAX_BROWSER_COLOR_PIXELS.toLocaleString()} pixels and larger requests fail visibly.</p>
  </aside>;
}

interface EnhancementToolPanelProps {
  outputScale: ImageQualityOutputScale;
  strength: number;
  processing: boolean;
  processorRestarting: boolean;
  geometryBusy: boolean;
  dimensionsReady: boolean;
  canEnhance: boolean;
  canDownload: boolean;
  downloadLabel: string;
  onScale: (scale: ImageQualityOutputScale) => void;
  onStrength: (strength: number) => void;
  onEnhance: () => void;
  onCancel: () => void;
  onReset: () => void;
  onDownload: () => void;
}

export function EnhancementToolPanel(props: EnhancementToolPanelProps) {
  return <aside className="quality-tool-panel quality-controls" aria-label="Enhancement controls">
    <div className="quality-panel-heading"><Sparkles aria-hidden="true" /><div><h2>Enhance</h2><p>Restore from the immutable original.</p></div></div>
    <div className="quality-scale-control">
      <strong>Output scale</strong>
      <div className="quality-control-group" role="group" aria-label="Output scale">
        {([2, 4] as ImageQualityOutputScale[]).map((scale) => <Button
          key={scale}
          size="compact"
          disabled={props.processing}
          aria-pressed={props.outputScale === scale}
          onClick={() => props.onScale(scale)}
        >{scale}×</Button>)}
      </div>
    </div>
    <label className="quality-strength">
      <span><strong>Enhancement strength</strong><output>{strengthLabel(props.strength)} · {props.strength}%</output></span>
      <input type="range" min="0" max="100" value={props.strength} disabled={props.processing}
        onChange={(event) => props.onStrength(Number(event.target.value))} />
    </label>
    <div className="quality-actions">
      <Button tone="primary" disabled={!props.canEnhance} onClick={props.onEnhance}><Sparkles aria-hidden="true" />{props.processing ? "Enhancing…" : props.processorRestarting ? "Preparing…" : "Enhance quality"}</Button>
      {props.processing
        ? <Button onClick={props.onCancel}><X aria-hidden="true" />Cancel</Button>
        : <Button disabled={!props.dimensionsReady} onClick={props.onReset}><RotateCcw aria-hidden="true" />Reset all</Button>}
      <Button disabled={!props.canDownload || props.processing || props.geometryBusy} onClick={props.onDownload}><Download aria-hidden="true" />{props.downloadLabel}</Button>
    </div>
    <p className="quality-view-note">Strength and output scale are independent. Every run starts from the immutable source, never a previous enhancement.</p>
  </aside>;
}

interface GeometryToolPanelProps {
  recipe: ImageGeometryRecipe | null;
  aspect: ImageCropAspect;
  resizeAspectLocked: boolean;
  baseScale: number;
  sourceWidth: number;
  sourceHeight: number;
  dimensionsReady: boolean;
  busy: boolean;
  canApply: boolean;
  canDownload: boolean;
  downloadLabel: string;
  onRecipe: (recipe: ImageGeometryRecipe) => void;
  onAspect: (aspect: ImageCropAspect) => void;
  onResizeAspectLocked: (locked: boolean) => void;
  onEditCanvas: () => void;
  onApply: () => void;
  onReset: () => void;
  onDownload: () => void;
}

export function GeometryToolPanel(props: GeometryToolPanelProps) {
  const recipe = props.recipe;
  if (!recipe || !props.dimensionsReady) {
    return <aside className="quality-tool-panel quality-controls" aria-label="Transform controls"><p>Preparing geometry controls…</p></aside>;
  }
  const natural = geometryNaturalDimensions(recipe, props.baseScale);
  const resize = recipe.resize ?? natural;
  const updateResize = (field: "width" | "height", value: number) => {
    const next = Math.max(1, Math.round(Number.isFinite(value) ? value : 1));
    const ratio = natural.width / natural.height;
    props.onRecipe({
      ...recipe,
      resize: props.resizeAspectLocked
        ? field === "width"
          ? { width: next, height: Math.max(1, Math.round(next / ratio)) }
          : { width: Math.max(1, Math.round(next * ratio)), height: next }
        : { ...resize, [field]: next },
    });
  };
  return <aside className="quality-tool-panel quality-controls" aria-label="Crop, perspective, rotate, flip and resize controls">
    <div className="quality-panel-heading"><Crop aria-hidden="true" /><div><h2>Transform</h2><p>Non-destructive source-coordinate recipe.</p></div></div>
    <fieldset className="quality-aspect-control">
      <legend>Aspect ratio</legend>
      <div className="quality-control-group">
        {(["free", "original", "1:1", "4:5", "16:9"] as ImageCropAspect[]).map((aspect) => <Button
          key={aspect}
          size="compact"
          aria-pressed={props.aspect === aspect}
          disabled={props.busy}
          onClick={() => {
            props.onAspect(aspect);
            props.onRecipe({
              ...recipe,
              crop: cropToAspect(recipe.crop, aspect, props.sourceWidth, props.sourceHeight),
            });
          }}
        >{aspect === "original" ? "Original" : aspect === "free" ? "Free" : aspect}</Button>)}
      </div>
    </fieldset>
    <fieldset className="quality-crop-fields">
      <legend>Crop rectangle · pixels</legend>
      {(["x", "y", "width", "height"] as const).map((field) => <label key={field}>
        <span>{field === "x" ? "Left" : field === "y" ? "Top" : field[0].toUpperCase() + field.slice(1)}</span>
        <input
          type="number"
          min={field === "width" || field === "height" ? 1 : 0}
          value={recipe.crop[field]}
          disabled={props.busy}
          onChange={(event) => {
            props.onAspect("free");
            props.onRecipe({
              ...recipe,
              crop: sanitizeCropRect(
                { ...recipe.crop, [field]: Number(event.target.value) },
                props.sourceWidth,
                props.sourceHeight,
                Math.min(32, props.sourceWidth, props.sourceHeight),
              ),
            });
          }}
        />
      </label>)}
    </fieldset>
    <fieldset className="quality-resize-control quality-perspective-control">
      <legend>Perspective</legend>
      <label className="quality-check-control">
        <input type="checkbox" checked={recipe.perspective !== null} disabled={props.busy}
          onChange={(event) => props.onRecipe({
            ...recipe,
            perspective: event.target.checked ? createIdentityPerspective() : null,
          })} />
        <span>Enable four-corner correction</span>
      </label>
      {recipe.perspective && <div className="quality-control-group">
        <Button size="compact" disabled={props.busy} onClick={props.onEditCanvas}>
          <Crop aria-hidden="true" />Edit corner points
        </Button>
        <Button size="compact" disabled={props.busy}
          onClick={() => props.onRecipe({ ...recipe, perspective: createIdentityPerspective() })}>
          <RotateCcw aria-hidden="true" />Reset perspective
        </Button>
      </div>}
      <p>Drag the four blue corner points on the canvas. Points remain in stable corner zones. Local perspective work is limited to {MAX_BROWSER_PERSPECTIVE_PIXELS.toLocaleString()} crop pixels and larger requests fail visibly.</p>
    </fieldset>
    <div className="quality-rotate-controls">
      <strong>Rotate</strong>
      <div className="quality-control-group">
        <Button size="compact" disabled={props.busy} onClick={() => props.onRecipe(rotateGeometry(recipe, -1))}><RotateCcw aria-hidden="true" />90° left</Button>
        <Button size="compact" disabled={props.busy} onClick={() => props.onRecipe(rotateGeometry(recipe, 1))}><RotateCw aria-hidden="true" />90° right</Button>
      </div>
    </div>
    <div className="quality-rotate-controls">
      <strong>Flip</strong>
      <div className="quality-control-group">
        <Button size="compact" aria-pressed={recipe.flipHorizontal} disabled={props.busy}
          onClick={() => props.onRecipe({ ...recipe, flipHorizontal: !recipe.flipHorizontal })}>
          <FlipHorizontal2 aria-hidden="true" />Horizontal
        </Button>
        <Button size="compact" aria-pressed={recipe.flipVertical} disabled={props.busy}
          onClick={() => props.onRecipe({ ...recipe, flipVertical: !recipe.flipVertical })}>
          <FlipVertical2 aria-hidden="true" />Vertical
        </Button>
      </div>
    </div>
    <label className="quality-strength quality-straighten">
      <span><strong>Straighten</strong><output>{recipe.straighten.toFixed(1)}°</output></span>
      <input type="range" min="-15" max="15" step="0.1" value={recipe.straighten} disabled={props.busy}
        onChange={(event) => props.onRecipe({ ...recipe, straighten: Number(event.target.value) })} />
    </label>
    <fieldset className="quality-resize-control">
      <legend>Resize output</legend>
      <label className="quality-check-control">
        <input type="checkbox" checked={recipe.resize !== null} disabled={props.busy}
          onChange={(event) => props.onRecipe({ ...recipe, resize: event.target.checked ? natural : null })} />
        <span>Use exact pixel dimensions</span>
      </label>
      <div className="quality-resize-fields">
        <label><span>Width</span><input aria-label="Output width" type="number" min="1" value={resize.width}
          disabled={props.busy || recipe.resize === null}
          onChange={(event) => updateResize("width", Number(event.target.value))} /></label>
        <span aria-hidden="true">x</span>
        <label><span>Height</span><input aria-label="Output height" type="number" min="1" value={resize.height}
          disabled={props.busy || recipe.resize === null}
          onChange={(event) => updateResize("height", Number(event.target.value))} /></label>
      </div>
      <label className="quality-check-control">
        <input type="checkbox" checked={props.resizeAspectLocked} disabled={props.busy || recipe.resize === null}
          onChange={(event) => props.onResizeAspectLocked(event.target.checked)} />
        <span>Lock current aspect ratio</span>
      </label>
      <p>Natural size: {natural.width} x {natural.height} px. Requests beyond the browser limit fail visibly; they are never reduced silently.</p>
    </fieldset>
    <div className="quality-actions">
      <Button tone="primary" disabled={!props.canApply} onClick={props.onApply}><Crop aria-hidden="true" />{props.busy ? "Applying…" : "Apply geometry"}</Button>
      <Button disabled={props.busy || isIdentityGeometry(recipe, props.sourceWidth, props.sourceHeight)} onClick={props.onReset}><RotateCcw aria-hidden="true" />Reset geometry</Button>
      <Button disabled={!props.canDownload || props.busy} onClick={props.onDownload}><Download aria-hidden="true" />{props.downloadLabel}</Button>
    </div>
    <p className="quality-view-note">Order: crop, perspective, flip, rotate, straighten, then optional exact resize. Straighten fills the frame without transparent corners.</p>
  </aside>;
}

export function ImageEditorInspector({
  dimensionsReady,
  sourceWidth,
  sourceHeight,
  outputDimensions,
  recipe,
  geometryIsDirty,
  geometryDisplayReady,
  toneStatus,
  colorStatus,
  effectsStatus,
  histogramInput,
}: {
  dimensionsReady: boolean;
  sourceWidth: number;
  sourceHeight: number;
  outputDimensions: string;
  recipe: ImageGeometryRecipe | null;
  geometryIsDirty: boolean;
  geometryDisplayReady: boolean;
  toneStatus: "Applied" | "Unapplied changes" | "None";
  colorStatus: "Applied" | "Unapplied changes" | "None";
  effectsStatus: "Applied" | "Unapplied changes" | "None";
  histogramInput: ImageHistogramInput | null;
}) {
  return <aside className="quality-inspector" aria-label="Image properties" tabIndex={0}>
    <div className="quality-panel-heading"><SlidersHorizontal aria-hidden="true" /><div><h2>Properties</h2><p>Current source and derivative.</p></div></div>
    <dl className="quality-dimensions">
      <div><dt>Original</dt><dd>{dimensionsReady ? `${sourceWidth} × ${sourceHeight} px` : "Reading dimensions…"}</dd></div>
      <div><dt>Output</dt><dd>{outputDimensions}</dd></div>
      <div><dt>Light &amp; tone</dt><dd>{toneStatus}</dd></div>
      <div><dt>Colour</dt><dd>{colorStatus}</dd></div>
      <div><dt>Effects</dt><dd>{effectsStatus}</dd></div>
    </dl>
    {recipe && dimensionsReady && <dl className="quality-geometry-properties">
      <div><dt>Crop</dt><dd>{recipe.crop.width} × {recipe.crop.height} px</dd></div>
      <div><dt>Position</dt><dd>{recipe.crop.x}, {recipe.crop.y}</dd></div>
      <div><dt>Rotation</dt><dd>{recipe.quarterTurns * 90 + recipe.straighten}°</dd></div>
      <div><dt>Perspective</dt><dd>{recipe.perspective ? "Four-corner" : "None"}</dd></div>
      <div><dt>Flip</dt><dd>{recipe.flipHorizontal || recipe.flipVertical
        ? [recipe.flipHorizontal && "horizontal", recipe.flipVertical && "vertical"].filter(Boolean).join(" + ")
        : "None"}</dd></div>
      <div><dt>Resize</dt><dd>{recipe.resize ? `${recipe.resize.width} x ${recipe.resize.height} px` : "Natural size"}</dd></div>
      <div><dt>Recipe</dt><dd>{geometryIsDirty ? "Unapplied changes" : geometryDisplayReady ? "Applied" : "None"}</dd></div>
    </dl>}
    <ImageHistogramPanel input={histogramInput} />
    <p className="quality-inspector-note">Original bytes are immutable. Enhancement, geometry, tone, colour and effects remain separate, traceable derivative stages.</p>
  </aside>;
}
