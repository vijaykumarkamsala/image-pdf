import { createHash } from "node:crypto";

import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import type {
  ArtboardRecord,
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
      if (mutation.transform) layer.transform = clone(mutation.transform);
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
  const artboards = new Set(snapshot.artboards.map((item) => item.artboard_id));
  const snapshotLayers = snapshot.layers ?? [];
  const layers = new Set(snapshotLayers.map((item) => item.layer_id));
  if (artboards.size !== snapshot.artboards.length || layers.size !== snapshotLayers.length) invalidMutation("Document identifiers must be unique");
  for (const layer of snapshotLayers) {
    if (!artboards.has(layer.artboard_id)) invalidMutation("Every layer must belong to an artboard");
    if (layer.parent_layer_id && (!layers.has(layer.parent_layer_id) || layer.parent_layer_id === layer.layer_id)) {
      invalidMutation("Layer nesting is invalid");
    }
  }
}

function invalidMutation(message: string): never {
  throw new DomainError(400, "document-mutation-invalid", message);
}

function orientation(width: number, height: number): "portrait" | "landscape" | "square" {
  if (width === height) return "square";
  return width > height ? "landscape" : "portrait";
}
