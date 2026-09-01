import { createHash } from "node:crypto";

import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import type {
  ArtboardRecord,
  EditableMaskRecord,
  EditorDocumentSnapshot,
  EditorMutation,
  LayerRecord,
} from "ipw-contracts-ts/product";

import { DomainError } from "../../kernel/errors.js";
import type { RuntimeValues } from "../../kernel/runtime.js";
import type { CreateDocumentInput } from "./documents.types.js";

export const DOCUMENT_HISTORY_LIMIT = 100;
export const DOCUMENT_CHECKPOINT_INTERVAL = 10;
export const EDITOR_LEASE_SECONDS = 30;
export const EDITOR_LEASE_GRACE_SECONDS = 15;
const SUPPORTED_BLEND_MODES = new Set(["normal", "multiply", "screen", "overlay", "darken", "lighten"]);

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function snapshotDigest(snapshot: EditorDocumentSnapshot): string {
  return sha256(stableJson(snapshot));
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function addSeconds(instant: string, seconds: number): string {
  return new Date(new Date(instant).getTime() + seconds * 1000).toISOString();
}

export function initialSnapshot(runtime: RuntimeValues, documentId: string, input: CreateDocumentInput): EditorDocumentSnapshot {
  const sourceWidth = input.source?.width ?? undefined;
  const sourceHeight = input.source?.height ?? undefined;
  const width = input.width ?? sourceWidth ?? 1200;
  const height = input.height ?? sourceHeight ?? 800;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > 100_000 || height > 100_000) {
    throw new DomainError(400, "artboard-size-invalid", "Artboard dimensions must be between 1 and 100,000 pixels");
  }
  const artboardId = runtime.id("artboard");
  const sharedAssetId = input.source ? runtime.id("shared-asset") : null;
  const layer = input.source && sharedAssetId ? rasterLayer(runtime, artboardId, sharedAssetId, input.source.displayName, width, height) : null;
  return {
    schema_version: PRODUCT_SCHEMA_VERSION,
    document_id: documentId,
    revision: 0,
    artboards: [{
      schema_version: PRODUCT_SCHEMA_VERSION,
      artboard_id: artboardId,
      name: "Artboard 1",
      order: 0,
      width,
      height,
      unit: "px",
      orientation: orientation(width, height),
      background: { schema_version: PRODUCT_SCHEMA_VERSION, kind: "solid", color: "#ffffff" },
      intended_use: {
        schema_version: PRODUCT_SCHEMA_VERSION,
        kind: input.intendedUse,
        label: input.intendedUseLabel,
        attributes: {},
      },
    }],
    layers: layer ? [layer] : [],
    masks: [],
    shared_assets: input.source && sharedAssetId ? [{
      schema_version: PRODUCT_SCHEMA_VERSION,
      shared_asset_id: sharedAssetId,
      workspace_id: input.workspaceId,
      kind: "raster",
      name: input.source.displayName,
      asset_original_id: input.source.assetOriginalId,
      source_version_id: input.source.sourceVersionId,
      object_reference_id: input.source.objectReferenceId,
      preview_object_reference_id: null,
      linked_by_default: true,
    }] : [],
    shared_styles: [],
    variants: [],
  };
}

function rasterLayer(
  runtime: RuntimeValues,
  artboardId: string,
  sharedAssetId: string,
  name: string,
  width: number,
  height: number,
): LayerRecord {
  return {
    schema_version: PRODUCT_SCHEMA_VERSION,
    layer_id: runtime.id("layer"),
    artboard_id: artboardId,
    parent_layer_id: null,
    layer_type: "raster_image",
    name,
    order: 0,
    visible: true,
    locked: false,
    opacity: 1,
    blend_mode: "normal",
    transform: transform(0, 0, width, height),
    shared_style_ids: [],
    raster: {
      schema_version: PRODUCT_SCHEMA_VERSION,
      shared_asset_id: sharedAssetId,
      instance_mode: "linked",
      crop: { schema_version: PRODUCT_SCHEMA_VERSION, left: 0, top: 0, right: 1, bottom: 1 },
      adjustments: neutralAdjustments(),
      mask_ids: [],
    },
    vector: null,
    rich_text: null,
    shape: null,
    group: null,
    extension_payload: {},
  };
}

export function transform(x: number, y: number, width: number, height: number) {
  return {
    schema_version: PRODUCT_SCHEMA_VERSION,
    x,
    y,
    width,
    height,
    rotation_degrees: 0,
    scale_x: 1,
    scale_y: 1,
    skew_x_degrees: 0,
    skew_y_degrees: 0,
    flip_x: false,
    flip_y: false,
  };
}

export function neutralAdjustments() {
  return {
    schema_version: PRODUCT_SCHEMA_VERSION,
    exposure: 0,
    brightness: 0,
    contrast: 0,
    saturation: 0,
    temperature: 0,
    tint: 0,
    sharpness: 0,
  };
}

export function applyMutation(current: EditorDocumentSnapshot, mutation: EditorMutation): EditorDocumentSnapshot {
  const next = clone(current);
  next.layers ??= [];
  next.masks ??= [];
  next.shared_assets ??= [];
  next.shared_styles ??= [];
  next.variants ??= [];
  switch (mutation.kind) {
    case "layer.add":
      if (!mutation.layer) invalidMutation("A layer is required");
      requireArtboard(next, mutation.layer.artboard_id);
      if (next.layers.some((item) => item.layer_id === mutation.layer!.layer_id)) invalidMutation("Layer already exists");
      next.layers.push(clone(mutation.layer));
      break;
    case "layer.update": {
      const layer = requireLayer(next, mutation.target_id);
      if (layer.locked && mutation.properties?.["locked"] !== false) {
        throw new DomainError(409, "layer-locked", "Unlock the layer before editing it");
      }
      if (mutation.layer) {
        if (mutation.layer.layer_id !== layer.layer_id || mutation.layer.artboard_id !== layer.artboard_id || mutation.layer.layer_type !== layer.layer_type) {
          invalidMutation("Layer identity, artboard and type cannot change during an update");
        }
        Object.assign(layer, clone(mutation.layer));
      }
      if (mutation.transform) layer.transform = clone(mutation.transform);
      if (mutation.crop) {
        if (!layer.raster) invalidMutation("Cropping applies only to raster layers");
        layer.raster.crop = clone(mutation.crop);
      }
      if (mutation.adjustments) {
        if (!layer.raster) invalidMutation("Adjustments apply only to raster layers");
        layer.raster.adjustments = clone(mutation.adjustments);
      }
      applyLayerProperties(layer, mutation.properties ?? {});
      break;
    }
    case "layer.remove": {
      const target = requireLayer(next, mutation.target_id);
      if (target.locked) throw new DomainError(409, "layer-locked", "Unlock the layer before removing it");
      const remove = descendants(next.layers, target.layer_id);
      next.layers = next.layers.filter((item) => !remove.has(item.layer_id));
      break;
    }
    case "layer.reorder": {
      const layer = requireLayer(next, mutation.target_id);
      applyLayerProperties(layer, mutation.properties ?? {}, true);
      break;
    }
    case "artboard.add":
      if (!mutation.artboard) invalidMutation("An artboard is required");
      if (next.artboards.some((item) => item.artboard_id === mutation.artboard!.artboard_id)) invalidMutation("Artboard already exists");
      next.artboards.push(clone(mutation.artboard));
      break;
    case "artboard.update": {
      const artboard = requireArtboard(next, mutation.target_id);
      if (mutation.artboard && mutation.artboard.artboard_id !== artboard.artboard_id) invalidMutation("Artboard identity cannot change");
      if (mutation.artboard) Object.assign(artboard, clone(mutation.artboard));
      break;
    }
    case "artboard.remove": {
      if (next.artboards.length === 1) invalidMutation("A document must keep at least one artboard");
      const artboard = requireArtboard(next, mutation.target_id);
      next.artboards = next.artboards.filter((item) => item.artboard_id !== artboard.artboard_id);
      next.layers = next.layers.filter((item) => item.artboard_id !== artboard.artboard_id);
      next.masks = next.masks.filter((item) => item.artboard_id !== artboard.artboard_id);
      break;
    }
    case "mask.update": {
      if (!mutation.mask) invalidMutation("A mask is required");
      requireArtboard(next, mutation.mask.artboard_id);
      const index = next.masks.findIndex((item) => item.mask_id === mutation.mask!.mask_id);
      if (index >= 0) next.masks[index] = clone(mutation.mask);
      else next.masks.push(clone(mutation.mask));
      if (mutation.target_id) {
        const layer = requireLayer(next, mutation.target_id);
        const maskIds = layer.raster
          ? (layer.raster.mask_ids ??= [])
          : layer.vector
            ? (layer.vector.mask_ids ??= [])
            : null;
        if (!maskIds) invalidMutation("Masks can be attached only to raster or vector layers");
        if (!maskIds.includes(mutation.mask.mask_id)) maskIds.push(mutation.mask.mask_id);
      }
      break;
    }
    case "document.rename":
      break;
    default:
      invalidMutation("Unsupported document operation");
  }
  next.revision = current.revision + 1;
  validateSnapshot(next);
  return next;
}

function applyLayerProperties(layer: LayerRecord, properties: Partial<Record<string, string | number | boolean | null>>, reorderOnly = false) {
  const allowed = reorderOnly
    ? new Set(["order", "parent_layer_id"])
    : new Set(["name", "visible", "locked", "opacity", "blend_mode", "order", "parent_layer_id"]);
  for (const [key, value] of Object.entries(properties)) {
    if (!allowed.has(key)) invalidMutation(`Layer property ${key} is not editable`);
    if (key === "name" && typeof value === "string" && value.trim()) layer.name = value.trim();
    else if (key === "visible" && typeof value === "boolean") layer.visible = value;
    else if (key === "locked" && typeof value === "boolean") layer.locked = value;
    else if (key === "opacity" && typeof value === "number" && value >= 0 && value <= 1) layer.opacity = value;
    else if (key === "blend_mode" && typeof value === "string" && value.trim()) layer.blend_mode = value.trim();
    else if (key === "order" && typeof value === "number" && Number.isInteger(value) && value >= 0) layer.order = value;
    else if (key === "parent_layer_id" && (typeof value === "string" || value === null)) layer.parent_layer_id = value;
    else invalidMutation(`Layer property ${key} has an invalid value`);
  }
}

function descendants(layers: LayerRecord[], root: string): Set<string> {
  const result = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const layer of layers) {
      if (layer.parent_layer_id && result.has(layer.parent_layer_id) && !result.has(layer.layer_id)) {
        result.add(layer.layer_id);
        changed = true;
      }
    }
  }
  return result;
}

function requireLayer(snapshot: EditorDocumentSnapshot, id: string | null | undefined): LayerRecord {
  const layer = (snapshot.layers ?? []).find((item) => item.layer_id === id);
  if (!layer) throw new DomainError(404, "layer-not-found", "Layer was not found");
  return layer;
}

function requireArtboard(snapshot: EditorDocumentSnapshot, id: string | null | undefined): ArtboardRecord {
  const artboard = snapshot.artboards.find((item) => item.artboard_id === id);
  if (!artboard) throw new DomainError(404, "artboard-not-found", "Artboard was not found");
  return artboard;
}

function validateSnapshot(snapshot: EditorDocumentSnapshot) {
  if (snapshot.artboards.length === 0) invalidMutation("A document must keep at least one artboard");
  const artboards = new Set(snapshot.artboards.map((item) => item.artboard_id));
  const snapshotLayers = snapshot.layers ?? [];
  const layers = new Set(snapshotLayers.map((item) => item.layer_id));
  if (artboards.size !== snapshot.artboards.length || layers.size !== snapshotLayers.length) invalidMutation("Document identifiers must be unique");
  const artboardOrders = new Set<number>();
  for (const artboard of snapshot.artboards) {
    finiteRange(artboard.width, 0, 100_000, "Artboard width", false);
    finiteRange(artboard.height, 0, 100_000, "Artboard height", false);
    if (!Number.isSafeInteger(artboard.order) || artboard.order < 0 || artboardOrders.has(artboard.order)) {
      invalidMutation("Artboard order must be unique and deterministic");
    }
    artboardOrders.add(artboard.order);
  }
  const sharedAssets = new Map((snapshot.shared_assets ?? []).map((item) => [item.shared_asset_id, item]));
  const sharedStyles = new Map((snapshot.shared_styles ?? []).map((item) => [item.shared_style_id, item]));
  const maskRecords = new Map((snapshot.masks ?? []).map((item) => [item.mask_id, item]));
  if (sharedAssets.size !== (snapshot.shared_assets ?? []).length) invalidMutation("Shared asset identifiers must be unique");
  if (sharedStyles.size !== (snapshot.shared_styles ?? []).length) invalidMutation("Shared style identifiers must be unique");
  if (maskRecords.size !== (snapshot.masks ?? []).length) invalidMutation("Mask identifiers must be unique");
  const siblingOrders = new Set<string>();
  const referencedMasks = new Set<string>();
  for (const layer of snapshotLayers) {
    if (!artboards.has(layer.artboard_id)) invalidMutation("Every layer must belong to an artboard");
    if (layer.parent_layer_id && (!layers.has(layer.parent_layer_id) || layer.parent_layer_id === layer.layer_id)) {
      invalidMutation("Layer nesting is invalid");
    }
    if (layer.parent_layer_id) {
      const parent = snapshotLayers.find((item) => item.layer_id === layer.parent_layer_id)!;
      if (parent.artboard_id !== layer.artboard_id || parent.layer_type !== "group") {
        invalidMutation("Parent and child layers must belong to the same artboard and the parent must be a group");
      }
    }
    if (!Number.isSafeInteger(layer.order) || layer.order < 0) invalidMutation("Layer order must be a non-negative integer");
    const orderKey = `${layer.artboard_id}:${layer.parent_layer_id ?? "root"}:${layer.order}`;
    if (siblingOrders.has(orderKey)) invalidMutation("Sibling layer order must be unique and deterministic");
    siblingOrders.add(orderKey);
    if (typeof layer.name !== "string" || !layer.name.trim()) invalidMutation("Every layer must have a name");
    finiteRange(layer.opacity, 0, 1, "Layer opacity");
    if (!layer.blend_mode || !SUPPORTED_BLEND_MODES.has(layer.blend_mode)) {
      invalidMutation(`Blend mode ${layer.blend_mode ?? "missing"} is not supported`);
    }
    if ((layer.shared_style_ids ?? []).some((styleId) => !sharedStyles.has(styleId))) {
      invalidMutation("Every shared style reference must exist in the snapshot");
    }
    validateTransform(layer.transform);
    validateLayerContent(layer);
    if (layer.raster) {
      const asset = sharedAssets.get(layer.raster.shared_asset_id);
      if (!asset || !["raster", "brand"].includes(asset.kind)) invalidMutation("Raster layers require a valid raster shared asset");
      for (const maskId of layer.raster.mask_ids ?? []) {
        if (!maskId) invalidMutation("Mask identifiers must not be empty");
        validateMaskReference(maskRecords, maskId, layer.artboard_id, referencedMasks);
      }
    }
    if (layer.vector) {
      if (layer.vector.shared_asset_id && !sharedAssets.has(layer.vector.shared_asset_id)) {
        invalidMutation("Vector shared asset reference must exist in the snapshot");
      }
      for (const maskId of layer.vector.mask_ids ?? []) {
        if (!maskId) invalidMutation("Mask identifiers must not be empty");
        validateMaskReference(maskRecords, maskId, layer.artboard_id, referencedMasks);
      }
    }
    const visited = new Set([layer.layer_id]);
    let parentId = layer.parent_layer_id;
    while (parentId) {
      if (visited.has(parentId)) invalidMutation("Layer nesting cannot contain a cycle");
      visited.add(parentId);
      parentId = snapshotLayers.find((item) => item.layer_id === parentId)?.parent_layer_id ?? null;
    }
  }
  for (const mask of snapshot.masks ?? []) {
    if (!artboards.has(mask.artboard_id)) invalidMutation("Every mask must belong to an artboard");
    finiteRange(mask.feather, 0, 1_000, "Mask feather");
    if (!referencedMasks.has(mask.mask_id)) invalidMutation("Masks must be attached to a layer in the same artboard");
  }
  for (const style of snapshot.shared_styles ?? []) {
    for (const value of Object.values(style.properties ?? {})) {
      if (typeof value === "number" && !Number.isFinite(value)) invalidMutation("Shared style values must be finite");
    }
  }
}

function validateMaskReference(
  masks: Map<string, EditableMaskRecord>,
  maskId: string,
  artboardId: string,
  referenced: Set<string>,
) {
  const mask = masks.get(maskId);
  if (!mask || mask.artboard_id !== artboardId) invalidMutation("Mask references must exist in the same artboard");
  referenced.add(maskId);
}

function validateTransform(value: LayerRecord["transform"]) {
  if (!value || typeof value !== "object") invalidMutation("Every layer must have a transform");
  finiteRange(value.x, -1_000_000, 1_000_000, "Layer x position");
  finiteRange(value.y, -1_000_000, 1_000_000, "Layer y position");
  finiteRange(value.width, 0, 1_000_000, "Layer width", false);
  finiteRange(value.height, 0, 1_000_000, "Layer height", false);
  finiteRange(value.rotation_degrees, -360, 360, "Layer rotation");
  finiteRange(value.scale_x, 0, 1_000, "Layer horizontal scale", false);
  finiteRange(value.scale_y, 0, 1_000, "Layer vertical scale", false);
  finiteRange(value.skew_x_degrees, -89, 89, "Layer horizontal skew");
  finiteRange(value.skew_y_degrees, -89, 89, "Layer vertical skew");
}

function validateLayerContent(layer: LayerRecord) {
  const payloads = [layer.raster, layer.vector, layer.rich_text, layer.shape, layer.group]
    .filter((value) => value !== null && value !== undefined);
  if (payloads.length > 1) invalidMutation("A layer can carry only one built-in content payload");
  const expected = layer.layer_type === "raster_image" ? layer.raster
    : layer.layer_type === "vector_svg" ? layer.vector
      : layer.layer_type === "rich_text" ? layer.rich_text
        : layer.layer_type === "shape" ? layer.shape
          : layer.layer_type === "group" ? layer.group
            : undefined;
  if (["raster_image", "vector_svg", "rich_text", "shape", "group"].includes(layer.layer_type) && !expected) {
    invalidMutation("Layer content must match its type");
  }
  if (layer.raster) {
    const crop = layer.raster.crop;
    if (!crop || typeof crop !== "object") invalidMutation("Raster layers require a crop region");
    const { left, top, right, bottom } = crop;
    finiteRange(left, 0, 1, "Crop left");
    finiteRange(top, 0, 1, "Crop top");
    finiteRange(right, 0, 1, "Crop right");
    finiteRange(bottom, 0, 1, "Crop bottom");
    if (right <= left || bottom <= top) invalidMutation("Crop region must have positive area");
    if (!layer.raster.adjustments || typeof layer.raster.adjustments !== "object") invalidMutation("Raster layers require adjustment values");
    for (const [name, value] of Object.entries(layer.raster.adjustments)) {
      if (name === "schema_version") continue;
      finiteRange(value, name === "sharpness" ? 0 : -100, 100, `Adjustment ${name}`);
    }
  }
  if (layer.rich_text) {
    if (typeof layer.rich_text.text !== "string") invalidMutation("Rich-text layers require text");
    finiteRange(layer.rich_text.font_size, 0, 2_000, "Text size", false);
    for (const run of layer.rich_text.runs ?? []) {
      if (!Number.isSafeInteger(run.start) || !Number.isSafeInteger(run.end) || run.start < 0 || run.end < run.start || run.end > layer.rich_text.text.length) {
        invalidMutation("Rich-text ranges must stay within their text");
      }
    }
  }
  if (layer.shape) {
    finiteRange(layer.shape.stroke_width, 0, 10_000, "Shape stroke width");
    finiteRange(layer.shape.corner_radius, 0, 100_000, "Shape corner radius");
  }
}

function finiteRange(value: unknown, minimum: number, maximum: number, name: string, includeMinimum = true): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value > maximum || (includeMinimum ? value < minimum : value <= minimum)) {
    invalidMutation(`${name} is outside the supported range`);
  }
}

function invalidMutation(message: string): never {
  throw new DomainError(400, "document-mutation-invalid", message);
}

function orientation(width: number, height: number): "portrait" | "landscape" | "square" {
  if (width === height) return "square";
  return width > height ? "landscape" : "portrait";
}
