import {
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
  sanitizeToneRecipe,
  type ImageToneRecommendation,
  type ImageToneRecipe,
  type ImageToneStatistics,
} from "./imageTone";
import {
  IMAGE_COLOR_GRADING_RANGES,
  IMAGE_SELECTIVE_COLOR_RANGES,
  isNeutralColor,
  MAX_BROWSER_COLOR_PIXELS,
  type ImageBlackAndWhiteRecipe,
  type ImageColorGrade,
  type ImageColorGradingRange,
  type ImageColorRecipe,
  type ImageColorStatistics,
  type ImageDuotoneRecipe,
  type ImageSelectiveColorRange,
  type ImageSelectiveHslAdjustment,
  type ImageWhiteBalanceSuggestion,
} from "./imageColor";
import { ImageHistogramPanel, type ImageHistogramInput } from "./ImageHistogramPanel";
import { ToneCurveControl } from "./ToneCurveControl";
import { WorkerImageHistogramEngine } from "./WorkerImageHistogramEngine";

export type ImageEditorTool = "enhance" | "adjust" | "color" | "geometry";

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
    <button type="button" aria-current={activeTool === "geometry" ? "page" : undefined} onClick={() => onChange("geometry")}>
      <Crop aria-hidden="true" /><span>Crop</span>
    </button>
  </nav>;
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
  return <aside className="quality-tool-panel quality-controls" aria-label="Light and tone controls">
    <div className="quality-panel-heading"><SunMedium aria-hidden="true" /><div><h2>Light &amp; tone</h2><p>Deterministic correction from the latest verified base.</p></div></div>
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
  busy: boolean;
  canSampleWhiteBalance: boolean;
  canApply: boolean;
  canDownload: boolean;
  onRecipe: (recipe: ImageColorRecipe) => void;
  onToggleWhiteBalancePicker: () => void;
  onUseWhiteBalanceSuggestion: () => void;
  onDismissWhiteBalanceSuggestion: () => void;
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

export function ColorToolPanel(props: ColorToolPanelProps) {
  const [selectedRange, setSelectedRange] = useState<ImageSelectiveColorRange>("red");
  const [selectedGrade, setSelectedGrade] = useState<ImageColorGradingRange>("shadows");
  const neutral = isNeutralColor(props.recipe);
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
  return <aside className="quality-tool-panel quality-controls" aria-label="Colour controls">
    <div className="quality-panel-heading"><Palette aria-hidden="true" /><div><h2>Colour</h2><p>Bounded global and selective correction after light and tone.</p></div></div>
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
  histogramInput: ImageHistogramInput | null;
}) {
  return <aside className="quality-inspector" aria-label="Image properties" tabIndex={0}>
    <div className="quality-panel-heading"><SlidersHorizontal aria-hidden="true" /><div><h2>Properties</h2><p>Current source and derivative.</p></div></div>
    <dl className="quality-dimensions">
      <div><dt>Original</dt><dd>{dimensionsReady ? `${sourceWidth} × ${sourceHeight} px` : "Reading dimensions…"}</dd></div>
      <div><dt>Output</dt><dd>{outputDimensions}</dd></div>
      <div><dt>Light &amp; tone</dt><dd>{toneStatus}</dd></div>
      <div><dt>Colour</dt><dd>{colorStatus}</dd></div>
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
    <p className="quality-inspector-note">Original bytes are immutable. Enhancement, geometry, tone and colour remain separate, traceable derivative stages.</p>
  </aside>;
}
