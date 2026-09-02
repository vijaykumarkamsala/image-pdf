import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  Check,
  ChevronRight,
  Eye,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Trash2,
} from "lucide-react";
import type {
  ComparisonMode,
  DocumentReadModel,
  EnhancementPreview,
  ImageOperation,
  ImageOperationKind,
  IntendedOutcome,
  RecommendationSet,
} from "ipw-contracts-ts/product";

import { api } from "../boundaries/apiClient";
import { Button, InlineNotice } from "../design-system";
import {
  defaultOperation,
  estimateDimensions,
  moveOperation,
  normalizeOrder,
  scaleRecommendedOperation,
  summariseOperation,
  withFreshIdentity,
} from "./enhancementModel";

const OPERATION_LABELS: Record<ImageOperationKind, string> = {
  orientation_normalize: "Normalize orientation",
  crop: "Crop",
  rotate: "Rotate",
  flip: "Flip",
  resize: "Resize",
  exposure_brightness: "Exposure and brightness",
  contrast: "Contrast",
  highlights_shadows: "Highlights and shadows",
  white_balance_temperature: "White balance",
  tint: "Tint",
  saturation_vibrance: "Saturation and vibrance",
  gamma: "Gamma",
  levels: "Levels",
  curves: "Curves",
  grayscale: "Grayscale",
  unsharp_mask: "Unsharp mask",
  noise_reduction: "Noise reduction",
  colour_profile_conversion: "Colour profile",
  alpha_background: "Transparency and background",
  resampling_scale: "Standard 2x/4x resampling",
};

const BASIC_KINDS: ImageOperationKind[] = [
  "crop", "rotate", "flip", "resize", "exposure_brightness", "contrast",
  "white_balance_temperature", "saturation_vibrance",
];

const ALL_KINDS = Object.keys(OPERATION_LABELS) as ImageOperationKind[];

export interface ComparisonSelection {
  mode: ComparisonMode;
  preview: EnhancementPreview;
  operations: ImageOperation[];
  recommendedOperations?: ImageOperation[];
}

export function EnhancementWorkspace({
  workspaceId,
  editor,
  readOnly,
  onCompare,
  onOpenExport,
}: {
  workspaceId: string;
  editor: DocumentReadModel;
  readOnly: boolean;
  onCompare: (selection: ComparisonSelection) => void;
  onOpenExport: () => void;
}) {
  const [recipeId, setRecipeId] = useState<string | null>(null);
  const [recipeVersion, setRecipeVersion] = useState(0);
  const [operations, setOperations] = useState<ImageOperation[]>([]);
  const [recommendations, setRecommendations] = useState<RecommendationSet | null>(null);
  const [selectedRecommendations, setSelectedRecommendations] = useState<Set<string>>(new Set());
  const [outcome, setOutcome] = useState<IntendedOutcome | "">("");
  const [strength, setStrength] = useState(70);
  const [addKind, setAddKind] = useState<ImageOperationKind>("exposure_brightness");
  const [busy, setBusy] = useState<"loading" | "recommend" | "save" | "preview" | null>("loading");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      setBusy("loading");
      setError(null);
      try {
        const [recipes, recommended] = await Promise.all([
          api.processingRecipes(workspaceId, editor.document.document_id),
          api.requestRecommendations(workspaceId, editor.document.document_id, editor.document.current_version_id, null),
        ]);
        if (!active) return;
        const current = recipes.recipes.at(-1);
        if (current) {
          setRecipeId(current.recipe_id);
          setRecipeVersion(current.version);
          setOperations(current.operations);
        }
        applyRecommendationResponse(recommended.recommendation_set);
      } catch (reason) {
        if (active) setError(message(reason, "Enhancement details could not be loaded"));
      } finally {
        if (active) setBusy(null);
      }
    };
    void load();
    return () => { active = false; };
  }, [editor.document.current_version_id, editor.document.document_id, workspaceId]);

  const activeCount = operations.filter((item) => item.enabled !== false).length;
  const outputDimensions = useMemo(() => estimateDimensions(editor, operations), [editor, operations]);

  function applyRecommendationResponse(value: RecommendationSet) {
    setRecommendations(value);
    setSelectedRecommendations(new Set(value.recommendations.filter((item) => item.target_kind !== "output_warning").map((item) => item.recommendation_id)));
  }

  async function refreshRecommendations(nextOutcome: IntendedOutcome | "") {
    setOutcome(nextOutcome);
    setBusy("recommend");
    setError(null);
    try {
      const response = await api.requestRecommendations(
        workspaceId,
        editor.document.document_id,
        editor.document.current_version_id,
        nextOutcome || null,
      );
      applyRecommendationResponse(response.recommendation_set);
    } catch (reason) {
      setError(message(reason, "Recommendations could not be refreshed"));
    } finally {
      setBusy(null);
    }
  }

  async function persist(nextOperations = operations, success = "Corrections saved") {
    setBusy("save");
    setError(null);
    try {
      const response = recipeId
        ? await api.updateProcessingRecipe(workspaceId, editor.document.document_id, recipeId, "Enhancement corrections", normalizeOrder(nextOperations))
        : await api.createProcessingRecipe(workspaceId, editor.document.document_id, "Enhancement corrections", normalizeOrder(nextOperations));
      setRecipeId(response.recipe.recipe_id);
      setRecipeVersion(response.recipe.version);
      setOperations(response.recipe.operations);
      setNotice(success);
      return response.recipe;
    } catch (reason) {
      setError(message(reason, "Corrections could not be saved"));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function acceptSelected() {
    if (!recommendations) return;
    const accepted = recommendations.recommendations
      .filter((item) => selectedRecommendations.has(item.recommendation_id) && item.operation)
      .map((item) => scaleRecommendedOperation(withFreshIdentity(item.operation!, operations.length), strength));
    const existingKinds = new Set(operations.map((item) => item.kind));
    const next = [...operations, ...accepted.filter((item) => !existingKinds.has(item.kind))];
    await persist(next, accepted.length ? "Recommended corrections added for review" : "Metadata choices will be applied during export");
  }

  async function compare(mode: ComparisonMode) {
    const currentRecipe = await persist(operations, "Corrections saved for comparison");
    if (!currentRecipe) return;
    setBusy("preview");
    setError(null);
    try {
      const response = await api.requestEnhancementPreview(
        workspaceId,
        editor.document.document_id,
        currentRecipe.recipe_id,
        currentRecipe.version,
        mode,
      );
      const proposed = recommendations?.recommendations
        .filter((item) => selectedRecommendations.has(item.recommendation_id) && item.operation)
        .map((item, index) => scaleRecommendedOperation(withFreshIdentity(item.operation!, operations.length + index), strength)) ?? [];
      onCompare({ mode, preview: response.preview, operations, recommendedOperations: [...operations, ...proposed] });
    } catch (reason) {
      setError(message(reason, "Comparison preview could not be prepared"));
    } finally {
      setBusy(null);
    }
  }

  function addOperation() {
    setOperations((current) => [...current, defaultOperation(addKind, current.length)]);
  }

  return <div className="studio-panel-body enhancement-workspace" data-testid="enhancement-workspace">
    <header className="enhancement-heading">
      <span className="enhancement-heading-icon"><Sparkles aria-hidden="true" /></span>
      <span><strong className="enhancement-title">Image enhancement</strong><small>Non-destructive corrections from the immutable source</small></span>
    </header>

    {error && <InlineNotice tone="error" title="Enhancement unavailable">{error}</InlineNotice>}
    {notice && <div className="enhancement-success" role="status"><Check aria-hidden="true" />{notice}</div>}

    <section className="enhancement-section" aria-labelledby="intended-output-heading">
      <div className="section-heading"><span><strong id="intended-output-heading">Intended outcome</strong><small>Choose only when output use changes the recommendation.</small></span></div>
      <label className="compact-field">Use
        <select value={outcome} disabled={busy === "recommend"} onChange={(event) => void refreshRecommendations(event.target.value as IntendedOutcome | "")}>
          <option value="">Let verified facts guide this</option>
          <option value="digital">Digital</option>
          <option value="archival">Archival derivative</option>
          <option value="presentation">Presentation</option>
          <option value="custom">Custom</option>
        </select>
      </label>
      {recommendations?.intended_outcome_required && !outcome && <InlineNotice tone="warning" title="Choose an intended outcome">The measured source size can support different safe output choices.</InlineNotice>}
    </section>

    <section className="enhancement-section recommendations" aria-labelledby="recommendations-heading">
      <div className="section-heading"><span><strong id="recommendations-heading">Recommended corrections</strong><small>Nothing is applied until you confirm it.</small></span>{busy === "recommend" && <span className="quiet-state">Analysing...</span>}</div>
      {recommendations?.source_facts_summary.map((fact) => <p className="measured-fact" key={fact}><BarChart3 aria-hidden="true" />{fact}</p>)}
      {recommendations?.recommendations.length ? <div className="recommendation-list">
        {recommendations.recommendations.map((item) => <label className="recommendation-row" key={item.recommendation_id}>
          <input
            type="checkbox"
            checked={selectedRecommendations.has(item.recommendation_id)}
            disabled={item.target_kind === "output_warning"}
            onChange={() => setSelectedRecommendations((current) => toggleSet(current, item.recommendation_id))}
          />
          <span><strong>{item.title}</strong><small>{item.explanation}</small>{item.evidence.map((evidence) => <em key={`${item.recommendation_id}-${evidence.explanation}`}><span>{evidence.kind === "measured" ? "Measured" : "Heuristic"}</span>{evidence.explanation}</em>)}</span>
        </label>)}
      </div> : recommendations && <div className="empty-recommendation"><Check aria-hidden="true" /><span><strong>No automatic correction needed</strong><small>You can still add and review manual corrections.</small></span></div>}
      <RangeField label="Recommendation strength" value={strength} min={10} max={100} unit="%" onChange={setStrength} />
      <Button type="button" tone="primary" disabled={readOnly || busy !== null || !recommendations} onClick={() => void acceptSelected()}>Apply selected for review</Button>
    </section>

    <section className="enhancement-section" aria-labelledby="corrections-heading">
      <div className="section-heading"><span><strong id="corrections-heading">Corrections</strong><small>{activeCount} active, applied in the order shown</small></span></div>
      <div className="add-correction">
        <select aria-label="Correction to add" value={addKind} onChange={(event) => setAddKind(event.target.value as ImageOperationKind)}>
          <optgroup label="Common">{BASIC_KINDS.map((kind) => <option key={kind} value={kind}>{OPERATION_LABELS[kind]}</option>)}</optgroup>
          <optgroup label="Advanced">{ALL_KINDS.filter((kind) => !BASIC_KINDS.includes(kind)).map((kind) => <option key={kind} value={kind}>{OPERATION_LABELS[kind]}</option>)}</optgroup>
        </select>
        <Button type="button" size="compact" disabled={readOnly || operations.length >= 64} onClick={addOperation}>Add</Button>
      </div>
      {operations.length === 0 ? <div className="empty-corrections"><SlidersHorizontal aria-hidden="true" /><span>No corrections yet</span></div> : <div className="operation-list">
        {operations.map((operation, index) => <OperationCard
          key={operation.operation_id}
          operation={operation}
          index={index}
          count={operations.length}
          readOnly={readOnly}
          update={(next) => setOperations((current) => current.map((item) => item.operation_id === operation.operation_id ? next : item))}
          move={(offset) => setOperations((current) => moveOperation(current, index, index + offset))}
          remove={() => setOperations((current) => current.filter((item) => item.operation_id !== operation.operation_id))}
        />)}
      </div>}
      <Button type="button" disabled={readOnly || busy !== null} onClick={() => void persist()}>{busy === "save" ? "Saving..." : "Save corrections"}</Button>
    </section>

    <section className="enhancement-section comparison-launcher" aria-labelledby="compare-heading">
      <div className="section-heading"><span><strong id="compare-heading">Review changes</strong><small>{outputDimensions.width} x {outputDimensions.height} px estimated output</small></span></div>
      <div className="comparison-actions">
        <Button type="button" size="compact" disabled={busy !== null} onClick={() => void compare("split")}><Eye aria-hidden="true" />Split view</Button>
        <Button type="button" size="compact" disabled={busy !== null} onClick={() => void compare("side_by_side")}>Side by side</Button>
      </div>
      <p className="proxy-copy">The browser view is an interactive proxy. A durable worker renders the full-resolution derivative after confirmation.</p>
    </section>

    <Button type="button" tone="primary" className="enhancement-export-action" onClick={onOpenExport}><ChevronRight aria-hidden="true" />Choose output and export</Button>
  </div>;
}

function OperationCard({ operation, index, count, readOnly, update, move, remove }: {
  operation: ImageOperation;
  index: number;
  count: number;
  readOnly: boolean;
  update: (operation: ImageOperation) => void;
  move: (offset: number) => void;
  remove: () => void;
}) {
  const reset = () => update({ ...defaultOperation(operation.kind, operation.order), operation_id: operation.operation_id, enabled: operation.enabled });
  return <details className="operation-card" open={index === 0}>
    <summary>
      <span className="operation-order">{index + 1}</span>
      <span><strong>{OPERATION_LABELS[operation.kind]}</strong><small>{summariseOperation(operation)}</small></span>
      <span className="operation-enabled" aria-hidden="true">{operation.enabled === false ? "Off" : "On"}</span>
    </summary>
    <label className="operation-toggle"><input aria-label={`Enable ${OPERATION_LABELS[operation.kind]}`} type="checkbox" checked={operation.enabled !== false} disabled={readOnly} onChange={(event) => update({ ...operation, enabled: event.target.checked })} />Enable correction</label>
    <fieldset disabled={readOnly || operation.enabled === false}>
      <OperationParameters operation={operation} update={update} />
    </fieldset>
    <div className="operation-actions">
      <button type="button" aria-label={`Move ${OPERATION_LABELS[operation.kind]} up`} disabled={readOnly || index === 0} onClick={() => move(-1)}><ArrowUp aria-hidden="true" /></button>
      <button type="button" aria-label={`Move ${OPERATION_LABELS[operation.kind]} down`} disabled={readOnly || index === count - 1} onClick={() => move(1)}><ArrowDown aria-hidden="true" /></button>
      <button type="button" aria-label={`Reset ${OPERATION_LABELS[operation.kind]}`} disabled={readOnly} onClick={reset}><RotateCcw aria-hidden="true" /></button>
      <button type="button" aria-label={`Remove ${OPERATION_LABELS[operation.kind]}`} disabled={readOnly} onClick={remove}><Trash2 aria-hidden="true" /></button>
    </div>
  </details>;
}

function OperationParameters({ operation, update }: { operation: ImageOperation; update: (operation: ImageOperation) => void }) {
  const parameters = operation.parameters as unknown as Record<string, unknown>;
  const set = (patch: Record<string, unknown>) => update({ ...operation, parameters: { ...parameters, ...patch } as ImageOperation["parameters"] });
  const numberValue = (name: string, fallback: number) => typeof parameters[name] === "number" ? Number(parameters[name]) : fallback;
  switch (operation.kind) {
    case "orientation_normalize":
      return <SelectControl label="Source orientation" value={String(numberValue("source_orientation", 2))} options={[["2", "Mirrored"], ["3", "180 degrees"], ["4", "Mirrored 180"], ["5", "Mirrored 90"], ["6", "90 degrees"], ["7", "Mirrored 270"], ["8", "270 degrees"]]} onChange={(value) => set({ source_orientation: Number(value), apply_exactly_once: true })} />;
    case "crop":
      return <><SelectControl label="Aspect" value={String(parameters["aspect_preset"] ?? "free")} options={[["free", "Free"], ["1:1", "Square 1:1"], ["4:3", "Classic 4:3"], ["3:2", "Photo 3:2"], ["16:9", "Widescreen 16:9"]]} onChange={(value) => set({ aspect_preset: value === "free" ? null : value })} /><div className="four-field-grid">{["left", "top", "right", "bottom"].map((name) => <NumberControl key={name} label={`${capitalize(name)} %`} value={Math.round(numberValue(name, ["left", "top"].includes(name) ? 0 : 1) * 100)} min={0} max={100} step={1} onChange={(value) => set({ [name]: value / 100 })} />)}</div></>;
    case "rotate":
      return <><RangeField label="Rotation" value={numberValue("degrees", 0)} min={-360} max={360} unit="deg" onChange={(value) => set({ degrees: value })} /><CheckboxControl label="Expand canvas to fit" checked={parameters["expand_canvas"] !== false} onChange={(value) => set({ expand_canvas: value })} /></>;
    case "flip":
      return <><CheckboxControl label="Flip horizontally" checked={parameters["horizontal"] === true} onChange={(value) => set({ horizontal: value })} /><CheckboxControl label="Flip vertically" checked={parameters["vertical"] === true} onChange={(value) => set({ vertical: value })} /></>;
    case "resize": {
      const mode = String(parameters["mode"] ?? "pixels");
      return <><SelectControl label="Size mode" value={mode} options={[["pixels", "Pixels"], ["percent", "Percentage"], ["physical", "Physical dimensions"]]} onChange={(value) => set({ mode: value, width: value === "percent" ? 100 : 1920, height: value === "percent" ? 100 : 1080, physical_unit: value === "physical" ? "in" : null, ppi: value === "physical" ? 300 : null })} /><div className="two-field-grid"><NumberControl label="Width" value={numberValue("width", 1920)} min={0.001} max={100000} step={mode === "physical" ? 0.1 : 1} onChange={(value) => set({ width: value })} /><NumberControl label="Height" value={numberValue("height", 1080)} min={0.001} max={100000} step={mode === "physical" ? 0.1 : 1} onChange={(value) => set({ height: value })} /></div>{mode === "physical" && <div className="two-field-grid"><SelectControl label="Unit" value={String(parameters["physical_unit"] ?? "in")} options={[["in", "Inches"], ["mm", "Millimetres"], ["cm", "Centimetres"]]} onChange={(value) => set({ physical_unit: value })} /><NumberControl label="PPI" value={numberValue("ppi", 300)} min={1} max={9600} step={1} onChange={(value) => set({ ppi: value })} /></div>}<CheckboxControl label="Lock aspect ratio" checked={parameters["aspect_locked"] !== false} onChange={(value) => set({ aspect_locked: value })} /><SelectControl label="Fit" value={String(parameters["fit"] ?? "contain")} options={[["contain", "Contain"], ["cover", "Cover"], ["stretch", "Stretch"]]} onChange={(value) => set({ fit: value })} /><ResamplingControl parameters={parameters} set={set} /></>;
    }
    case "exposure_brightness": return <><RangeField label="Exposure" value={numberValue("exposure_ev", 0)} min={-5} max={5} step={0.1} unit=" EV" onChange={(value) => set({ exposure_ev: value })} /><RangeField label="Brightness" value={numberValue("brightness", 0)} min={-100} max={100} onChange={(value) => set({ brightness: value })} /></>;
    case "contrast": return <RangeField label="Contrast" value={numberValue("amount", 0)} min={-100} max={100} onChange={(value) => set({ amount: value })} />;
    case "highlights_shadows": return <><RangeField label="Highlights" value={numberValue("highlights", 0)} min={-100} max={100} onChange={(value) => set({ highlights: value })} /><RangeField label="Shadows" value={numberValue("shadows", 0)} min={-100} max={100} onChange={(value) => set({ shadows: value })} /></>;
    case "white_balance_temperature": return <RangeField label="Temperature" value={numberValue("temperature_kelvin", 6500)} min={2000} max={12000} step={100} unit=" K" onChange={(value) => set({ temperature_kelvin: value })} />;
    case "tint": return <RangeField label="Tint" value={numberValue("amount", 0)} min={-100} max={100} onChange={(value) => set({ amount: value })} />;
    case "saturation_vibrance": return <><RangeField label="Saturation" value={numberValue("saturation", 0)} min={-100} max={100} onChange={(value) => set({ saturation: value })} /><RangeField label="Vibrance" value={numberValue("vibrance", 0)} min={-100} max={100} onChange={(value) => set({ vibrance: value })} /></>;
    case "gamma": return <RangeField label="Gamma" value={numberValue("gamma", 1)} min={0.1} max={5} step={0.1} onChange={(value) => set({ gamma: value })} />;
    case "levels": return <><RangeField label="Black point" value={numberValue("black", 0)} min={0} max={254} onChange={(value) => set({ black: value })} /><RangeField label="Midpoint" value={numberValue("midpoint", 1)} min={0.1} max={5} step={0.1} onChange={(value) => set({ midpoint: value })} /><RangeField label="White point" value={numberValue("white", 255)} min={1} max={255} onChange={(value) => set({ white: value })} /></>;
    case "curves": return <CurveControls parameters={parameters} set={set} />;
    case "grayscale": return <SelectControl label="Method" value={String(parameters["method"] ?? "luminance")} options={[["luminance", "Luminance"], ["average", "Channel average"]]} onChange={(value) => set({ method: value })} />;
    case "unsharp_mask": return <><RangeField label="Radius" value={numberValue("radius", 1)} min={0.1} max={50} step={0.1} unit=" px" onChange={(value) => set({ radius: value })} /><RangeField label="Amount" value={numberValue("amount", 100)} min={0} max={500} unit="%" onChange={(value) => set({ amount: value })} /><RangeField label="Threshold" value={numberValue("threshold", 3)} min={0} max={255} onChange={(value) => set({ threshold: value })} /></>;
    case "noise_reduction": return <><RangeField label="Strength" value={numberValue("strength", 20)} min={0} max={100} onChange={(value) => set({ strength: value })} /><RangeField label="Preserve edges" value={numberValue("preserve_edges", 70)} min={0} max={100} onChange={(value) => set({ preserve_edges: value })} /></>;
    case "colour_profile_conversion": return <><SelectControl label="Target profile" value={String(parameters["target_profile"] ?? "srgb")} options={[["preserve", "Preserve source profile"], ["srgb", "Convert to sRGB"], ["display-p3", "Display P3 (processor required)"]]} onChange={(value) => set({ target_profile: value })} /><SelectControl label="Rendering intent" value={String(parameters["rendering_intent"] ?? "perceptual")} options={[["perceptual", "Perceptual"], ["relative_colorimetric", "Relative colorimetric"]]} onChange={(value) => set({ rendering_intent: value })} /><CheckboxControl label="Black point compensation" checked={parameters["black_point_compensation"] !== false} onChange={(value) => set({ black_point_compensation: value })} /></>;
    case "alpha_background": {
      const flatten = parameters["behavior"] === "flatten";
      return <><SelectControl label="Transparency" value={flatten ? "flatten" : "preserve"} options={[["preserve", "Preserve alpha"], ["flatten", "Flatten on a background"]]} onChange={(value) => set({ behavior: value, background: value === "flatten" ? "#FFFFFF" : null })} />{flatten && <label className="colour-control">Background<input type="color" value={String(parameters["background"] ?? "#FFFFFF")} onChange={(event) => set({ background: event.target.value.toUpperCase() })} /></label>}</>;
    }
    case "resampling_scale": return <><SelectControl label="Scale" value={String(numberValue("scale", 2))} options={[["2", "2x standard resampling"], ["4", "4x standard resampling"]]} onChange={(value) => set({ scale: Number(value), label: "Standard resampling (not AI reconstruction)" })} /><ResamplingControl parameters={parameters} set={set} /><p className="operation-disclosure">Standard resampling only. It does not reconstruct or invent detail.</p></>;
  }
}

function CurveControls({ parameters, set }: { parameters: Record<string, unknown>; set: (patch: Record<string, unknown>) => void }) {
  const points = Array.isArray(parameters["points"]) ? parameters["points"] as Array<{ input: number; output: number }> : [{ input: 0, output: 0 }, { input: 0.5, output: 0.5 }, { input: 1, output: 1 }];
  const change = (index: number, output: number) => set({ points: points.map((point, pointIndex) => pointIndex === index ? { ...point, output } : point) });
  const add = () => {
    const before = points.at(-2)!;
    const after = points.at(-1)!;
    set({ points: [...points.slice(0, -1), { input: (before.input + after.input) / 2, output: (before.output + after.output) / 2 }, after].sort((left, right) => left.input - right.input) });
  };
  return <div className="curve-controls"><SelectControl label="Channel" value={String(parameters["channel"] ?? "rgb")} options={[["rgb", "RGB"], ["red", "Red"], ["green", "Green"], ["blue", "Blue"]]} onChange={(value) => set({ channel: value })} /><div className="curve-graph" aria-label="Editable curve control points">{points.map((point, index) => <label key={`${point.input}-${index}`}>{Math.round(point.input * 100)}<input aria-label={`Curve output at ${Math.round(point.input * 100)}`} type="number" min={0} max={100} value={Math.round(point.output * 100)} onChange={(event) => change(index, Number(event.target.value) / 100)} />{index > 0 && index < points.length - 1 && <button type="button" aria-label={`Remove curve point ${index + 1}`} onClick={() => set({ points: points.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 aria-hidden="true" /></button>}</label>)}</div><Button type="button" size="compact" disabled={points.length >= 32} onClick={add}>Add control point</Button></div>;
}

function ResamplingControl({ parameters, set }: { parameters: Record<string, unknown>; set: (patch: Record<string, unknown>) => void }) {
  return <SelectControl label="Resampling" value={String(parameters["algorithm"] ?? "lanczos")} options={[["nearest", "Nearest neighbour"], ["bilinear", "Bilinear"], ["bicubic", "Bicubic"], ["lanczos", "Lanczos"]]} onChange={(value) => set({ algorithm: value })} />;
}

function RangeField({ label, value, min, max, step = 1, unit = "", onChange }: { label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (value: number) => void }) {
  return <label className="range-field"><span>{label}<output>{value}{unit}</output></span><input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function NumberControl({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  return <label className="number-control">{label}<input type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function SelectControl({ label, value, options, onChange }: { label: string; value: string; options: Array<[string, string]>; onChange: (value: string) => void }) {
  return <label className="compact-field">{label}<select value={value} onChange={(event) => onChange(event.target.value)}>{options.map(([optionValue, optionLabel]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}</select></label>;
}

function CheckboxControl({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="checkbox-control"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />{label}</label>;
}

function toggleSet(current: Set<string>, id: string): Set<string> {
  const next = new Set(current);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

function capitalize(value: string) { return `${value.charAt(0).toUpperCase()}${value.slice(1)}`; }
function message(reason: unknown, fallback: string) { return reason instanceof Error ? reason.message : fallback; }
