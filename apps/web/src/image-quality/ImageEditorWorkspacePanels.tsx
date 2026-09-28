import {
  Crop,
  Download,
  FlipHorizontal2,
  FlipVertical2,
  RotateCcw,
  RotateCw,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";

import { Button } from "../design-system";
import type { ImageQualityOutputScale } from "./ImageQualityEngine";
import {
  cropToAspect,
  geometryNaturalDimensions,
  isIdentityGeometry,
  rotateGeometry,
  sanitizeCropRect,
  type ImageCropAspect,
  type ImageGeometryRecipe,
} from "./imageGeometry";

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
  activeTool: "enhance" | "geometry";
  onChange: (tool: "enhance" | "geometry") => void;
}) {
  return <nav className="quality-tool-rail" aria-label="Image editor tools">
    <button type="button" aria-current={activeTool === "enhance" ? "page" : undefined} onClick={() => onChange("enhance")}>
      <Sparkles aria-hidden="true" /><span>Enhance</span>
    </button>
    <button type="button" aria-current={activeTool === "geometry" ? "page" : undefined} onClick={() => onChange("geometry")}>
      <Crop aria-hidden="true" /><span>Crop</span>
    </button>
  </nav>;
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
      <Button disabled={!props.canDownload || props.processing || props.geometryBusy} onClick={props.onDownload}><Download aria-hidden="true" />Download enhanced image</Button>
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
  onRecipe: (recipe: ImageGeometryRecipe) => void;
  onAspect: (aspect: ImageCropAspect) => void;
  onResizeAspectLocked: (locked: boolean) => void;
  onApply: () => void;
  onReset: () => void;
  onDownload: () => void;
}

export function GeometryToolPanel(props: GeometryToolPanelProps) {
  const recipe = props.recipe;
  if (!recipe || !props.dimensionsReady) {
    return <aside className="quality-tool-panel quality-controls" aria-label="Crop and rotate controls"><p>Preparing geometry controls…</p></aside>;
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
  return <aside className="quality-tool-panel quality-controls" aria-label="Crop, rotate, flip and resize controls">
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
      <Button disabled={!props.canDownload || props.busy} onClick={props.onDownload}><Download aria-hidden="true" />Download edited image</Button>
    </div>
    <p className="quality-view-note">Order: crop, flip, rotate, straighten, then optional exact resize. Straighten fills the frame without transparent corners.</p>
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
}: {
  dimensionsReady: boolean;
  sourceWidth: number;
  sourceHeight: number;
  outputDimensions: string;
  recipe: ImageGeometryRecipe | null;
  geometryIsDirty: boolean;
  geometryDisplayReady: boolean;
}) {
  return <aside className="quality-inspector" aria-label="Image properties">
    <div className="quality-panel-heading"><SlidersHorizontal aria-hidden="true" /><div><h2>Properties</h2><p>Current source and derivative.</p></div></div>
    <dl className="quality-dimensions">
      <div><dt>Original</dt><dd>{dimensionsReady ? `${sourceWidth} × ${sourceHeight} px` : "Reading dimensions…"}</dd></div>
      <div><dt>Output</dt><dd>{outputDimensions}</dd></div>
    </dl>
    {recipe && dimensionsReady && <dl className="quality-geometry-properties">
      <div><dt>Crop</dt><dd>{recipe.crop.width} × {recipe.crop.height} px</dd></div>
      <div><dt>Position</dt><dd>{recipe.crop.x}, {recipe.crop.y}</dd></div>
      <div><dt>Rotation</dt><dd>{recipe.quarterTurns * 90 + recipe.straighten}°</dd></div>
      <div><dt>Flip</dt><dd>{recipe.flipHorizontal || recipe.flipVertical
        ? [recipe.flipHorizontal && "horizontal", recipe.flipVertical && "vertical"].filter(Boolean).join(" + ")
        : "None"}</dd></div>
      <div><dt>Resize</dt><dd>{recipe.resize ? `${recipe.resize.width} x ${recipe.resize.height} px` : "Natural size"}</dd></div>
      <div><dt>Recipe</dt><dd>{geometryIsDirty ? "Unapplied changes" : geometryDisplayReady ? "Applied" : "None"}</dd></div>
    </dl>}
    <p className="quality-inspector-note">Original bytes are immutable. Enhancement and geometry remain separate, traceable derivative stages.</p>
  </aside>;
}
