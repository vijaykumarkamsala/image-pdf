import { createHash } from "node:crypto";

import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import type {
  ArtboardRecord,
  EditableMaskRecord,
  EditorDocumentSnapshot,
  EditorMutation,
  LayerRecord,
  SharedStyleRecord,
} from "ipw-contracts-ts/product";

import { DomainError } from "../../kernel/errors.js";
import type { RuntimeValues } from "../../kernel/runtime.js";
import type { CreateDocumentInput } from "./documents.types.js";

export const DOCUMENT_HISTORY_LIMIT = 100;
export const DOCUMENT_CHECKPOINT_INTERVAL = 10;
export const EDITOR_LEASE_SECONDS = 30;
export const EDITOR_LEASE_GRACE_SECONDS = 15;
const SUPPORTED_BLEND_MODES = new Set(["normal", "multiply", "screen", "overlay", "darken", "lighten"]);
const SUPPORTED_STYLE_PROPERTIES = new Set([
  "fill", "stroke", "stroke_width", "font_family", "font_size", "color", "text_align", "opacity", "blend_mode",
]);
const SUPPORTED_RICH_TEXT_PROPERTIES = new Set(["font_family", "font_size", "color", "font_weight", "font_style", "underline"]);
const APPROVED_FONTS = new Set(["system-ui", "arial", "times new roman", "courier new"]);
const SAFE_VECTOR_PATH = /^[MmLlHhVvCcSsQqTtAaZz0-9eE+.,\s-]+$/;
const SAFE_MASK_PATH = /^(?:rect|ellipse)\(\s*(?:0(?:\.\d+)?|1(?:\.0+)?)\s*,\s*(?:0(?:\.\d+)?|1(?:\.0+)?)\s*,\s*(?:0(?:\.\d+)?|1(?:\.0+)?)\s*,\s*(?:0(?:\.\d+)?|1(?:\.0+)?)\s*\)$/;

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
      insertLayer(next, clone(mutation.layer));
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
      const parentId = target.parent_layer_id ?? null;
      const artboardId = target.artboard_id;
      const remove = descendants(next.layers, target.layer_id);
      next.layers = next.layers.filter((item) => !remove.has(item.layer_id));
      normalizeLayerOrders(next.layers, artboardId, parentId);
      break;
    }
    case "layer.reorder": {
      const layer = requireLayer(next, mutation.target_id);
      if (layer.locked) throw new DomainError(409, "layer-locked", "Unlock the layer before moving it");
      reorderLayer(next, layer, mutation.properties ?? {});
      break;
    }
    case "layer.group": {
      if (!mutation.layer?.group) invalidMutation("A group layer is required");
      groupLayers(next, mutation.layer, mutation.target_ids ?? []);
      break;
    }
    case "layer.ungroup": {
      ungroupLayer(next, requireLayer(next, mutation.target_id));
      break;
    }
    case "artboard.add":
      if (!mutation.artboard) invalidMutation("An artboard is required");
      if (next.artboards.some((item) => item.artboard_id === mutation.artboard!.artboard_id)) invalidMutation("Artboard already exists");
      insertArtboard(next, clone(mutation.artboard));
      break;
    case "artboard.update": {
      const artboard = requireArtboard(next, mutation.target_id);
      if (mutation.artboard && mutation.artboard.artboard_id !== artboard.artboard_id) invalidMutation("Artboard identity cannot change");
      if (mutation.artboard) {
        const desiredOrder = mutation.artboard.order;
        if ((mutation.artboard.unit ?? "px") !== (artboard.unit ?? "px")) {
          const ratio = unitScale(artboard.unit) / unitScale(mutation.artboard.unit);
          for (const layer of next.layers.filter((item) => item.artboard_id === artboard.artboard_id)) {
            layer.transform.x *= ratio;
            layer.transform.y *= ratio;
            layer.transform.width *= ratio;
            layer.transform.height *= ratio;
          }
        }
        Object.assign(artboard, clone(mutation.artboard), { order: artboard.order });
        moveArtboard(next, artboard, desiredOrder);
      }
      break;
    }
    case "artboard.remove": {
      if (next.artboards.length === 1) invalidMutation("A document must keep at least one artboard");
      const artboard = requireArtboard(next, mutation.target_id);
      next.artboards = next.artboards.filter((item) => item.artboard_id !== artboard.artboard_id);
      next.layers = next.layers.filter((item) => item.artboard_id !== artboard.artboard_id);
      next.masks = next.masks.filter((item) => item.artboard_id !== artboard.artboard_id);
      normalizeArtboardOrders(next.artboards);
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
    case "asset.add":
      if (!mutation.shared_asset || !mutation.layer?.raster) invalidMutation("An authorised raster asset and layer are required");
      if (next.shared_assets.some((item) => item.shared_asset_id === mutation.shared_asset!.shared_asset_id)) invalidMutation("Shared asset already exists");
      if (mutation.layer.raster.shared_asset_id !== mutation.shared_asset.shared_asset_id) invalidMutation("Raster layer must reference the supplied asset");
      next.shared_assets.push(clone(mutation.shared_asset));
      insertLayer(next, clone(mutation.layer));
      break;
    case "style.upsert": {
      if (!mutation.shared_style) invalidMutation("A shared style is required");
      validateStyle(mutation.shared_style);
      const index = next.shared_styles.findIndex((style) => style.shared_style_id === mutation.shared_style!.shared_style_id);
      if (index < 0) next.shared_styles.push(clone(mutation.shared_style));
      else next.shared_styles[index] = clone(mutation.shared_style);
      for (const layerId of mutation.target_ids ?? []) {
        const layer = requireLayer(next, layerId);
        layer.shared_style_ids ??= [];
        if (!layer.shared_style_ids.includes(mutation.shared_style.shared_style_id)) layer.shared_style_ids.push(mutation.shared_style.shared_style_id);
      }
      break;
    }
    case "style.detach": {
      const style = next.shared_styles.find((item) => item.shared_style_id === mutation.target_id);
      if (!style) invalidMutation("Shared style was not found");
      const targets = mutation.target_ids?.length ? mutation.target_ids : next.layers.filter((item) => item.shared_style_ids?.includes(style.shared_style_id)).map((item) => item.layer_id);
      for (const layerId of targets) {
        const layer = requireLayer(next, layerId);
        if (!layer.shared_style_ids?.includes(style.shared_style_id)) invalidMutation("Layer is not linked to the shared style");
        materializeStyle(layer, style);
        layer.shared_style_ids = layer.shared_style_ids.filter((styleId) => styleId !== style.shared_style_id);
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

function insertLayer(snapshot: EditorDocumentSnapshot, layer: LayerRecord) {
  requireArtboard(snapshot, layer.artboard_id);
  if (layer.parent_layer_id) {
    const parent = requireLayer(snapshot, layer.parent_layer_id);
    if (parent.layer_type !== "group" || parent.artboard_id !== layer.artboard_id) invalidMutation("A layer parent must be a group on the same artboard");
  }
  const siblings = layerSiblings(snapshot.layers ?? [], layer.artboard_id, layer.parent_layer_id ?? null);
  const index = Math.min(Math.max(0, layer.order), siblings.length);
  siblings.splice(index, 0, layer);
  snapshot.layers = [...(snapshot.layers ?? []).filter((item) => item.parent_layer_id !== (layer.parent_layer_id ?? null) || item.artboard_id !== layer.artboard_id), ...siblings];
  normalizeLayerOrders(snapshot.layers, layer.artboard_id, layer.parent_layer_id ?? null);
}

function reorderLayer(snapshot: EditorDocumentSnapshot, layer: LayerRecord, properties: EditorMutation["properties"]) {
  const allowed = new Set(["order", "parent_layer_id"]);
  for (const key of Object.keys(properties ?? {})) if (!allowed.has(key)) invalidMutation(`Layer property ${key} is not editable during reorder`);
  const oldParent = layer.parent_layer_id ?? null;
  const newParentValue = properties?.["parent_layer_id"];
  const newParent = newParentValue === undefined ? oldParent : newParentValue;
  if (newParent !== null && typeof newParent !== "string") invalidMutation("Layer parent has an invalid value");
  if (newParent) {
    const parent = requireLayer(snapshot, newParent);
    if (parent.layer_type !== "group" || parent.artboard_id !== layer.artboard_id) invalidMutation("A layer parent must be a group on the same artboard");
    if (descendants(snapshot.layers ?? [], layer.layer_id).has(parent.layer_id)) invalidMutation("Layer nesting cannot contain a cycle");
  }
  const desired = properties?.["order"] ?? layer.order;
  if (!Number.isSafeInteger(desired) || Number(desired) < 0) invalidMutation("Layer order has an invalid value");
  snapshot.layers = (snapshot.layers ?? []).filter((item) => item.layer_id !== layer.layer_id);
  normalizeLayerOrders(snapshot.layers, layer.artboard_id, oldParent);
  layer.parent_layer_id = newParent;
  const siblings = layerSiblings(snapshot.layers, layer.artboard_id, newParent);
  siblings.splice(Math.min(Number(desired), siblings.length), 0, layer);
  normalizeArrayOrders(siblings);
  snapshot.layers.push(layer);
  normalizeLayerOrders(snapshot.layers, layer.artboard_id, newParent);
}

function groupLayers(snapshot: EditorDocumentSnapshot, proposed: LayerRecord, targetIds: string[]) {
  const uniqueIds = [...new Set(targetIds)];
  if (uniqueIds.length < 2 || uniqueIds.length !== targetIds.length) invalidMutation("Grouping requires at least two distinct layers");
  if ((snapshot.layers ?? []).some((item) => item.layer_id === proposed.layer_id)) invalidMutation("Group layer already exists");
  const selected = uniqueIds.map((id) => requireLayer(snapshot, id));
  const first = selected[0]!;
  const parentId = first.parent_layer_id ?? null;
  if (selected.some((item) => item.artboard_id !== first.artboard_id || (item.parent_layer_id ?? null) !== parentId)) {
    invalidMutation("Grouped layers must be siblings on the same artboard");
  }
  if (selected.some((item) => item.locked || item.layer_type === "group" && descendants(snapshot.layers ?? [], item.layer_id).size > 1)) {
    invalidMutation("Unlock layers and ungroup nested content before regrouping");
  }
  const minX = Math.min(...selected.map((item) => item.transform.x));
  const minY = Math.min(...selected.map((item) => item.transform.y));
  const maxX = Math.max(...selected.map((item) => item.transform.x + item.transform.width * (item.transform.scale_x ?? 1)));
  const maxY = Math.max(...selected.map((item) => item.transform.y + item.transform.height * (item.transform.scale_y ?? 1)));
  const insertionOrder = Math.min(...selected.map((item) => item.order));
  const selectedSet = new Set(uniqueIds);
  snapshot.layers = (snapshot.layers ?? []).filter((item) => !selectedSet.has(item.layer_id));
  normalizeLayerOrders(snapshot.layers, first.artboard_id, parentId);
  const group = clone(proposed);
  group.artboard_id = first.artboard_id;
  group.parent_layer_id = parentId;
  group.order = insertionOrder;
  group.transform = transform(minX, minY, Math.max(1, maxX - minX), Math.max(1, maxY - minY));
  group.extension_payload = { ...group.extension_payload, semantic_group: true };
  insertLayer(snapshot, group);
  selected.sort((left, right) => left.order - right.order || left.layer_id.localeCompare(right.layer_id));
  selected.forEach((item, index) => {
    item.parent_layer_id = group.layer_id;
    item.order = index;
    item.transform.x -= minX;
    item.transform.y -= minY;
    snapshot.layers!.push(item);
  });
}

function ungroupLayer(snapshot: EditorDocumentSnapshot, group: LayerRecord) {
  if (group.layer_type !== "group" || !group.group) invalidMutation("The selected layer is not a group");
  if (group.locked) throw new DomainError(409, "layer-locked", "Unlock the group before ungrouping it");
  const children = layerSiblings(snapshot.layers ?? [], group.artboard_id, group.layer_id);
  if (children.length === 0) invalidMutation("The group has no child layers");
  const parentId = group.parent_layer_id ?? null;
  const insertionOrder = group.order;
  const radians = (group.transform.rotation_degrees ?? 0) * Math.PI / 180;
  const groupScaleX = (group.transform.scale_x ?? 1) * (group.transform.flip_x ? -1 : 1);
  const groupScaleY = (group.transform.scale_y ?? 1) * (group.transform.flip_y ? -1 : 1);
  snapshot.layers = (snapshot.layers ?? []).filter((item) => item.layer_id !== group.layer_id && item.parent_layer_id !== group.layer_id);
  normalizeLayerOrders(snapshot.layers, group.artboard_id, parentId);
  children.forEach((child, index) => {
    const localX = child.transform.x * groupScaleX;
    const localY = child.transform.y * groupScaleY;
    child.transform.x = group.transform.x + localX * Math.cos(radians) - localY * Math.sin(radians);
    child.transform.y = group.transform.y + localX * Math.sin(radians) + localY * Math.cos(radians);
    child.transform.scale_x = (child.transform.scale_x ?? 1) * Math.abs(groupScaleX);
    child.transform.scale_y = (child.transform.scale_y ?? 1) * Math.abs(groupScaleY);
    child.transform.rotation_degrees = normalizeAngle((child.transform.rotation_degrees ?? 0) + (group.transform.rotation_degrees ?? 0));
    child.transform.flip_x = Boolean(child.transform.flip_x) !== Boolean(group.transform.flip_x);
    child.transform.flip_y = Boolean(child.transform.flip_y) !== Boolean(group.transform.flip_y);
    child.parent_layer_id = parentId;
    child.order = insertionOrder + index;
    child.visible = group.visible !== false && child.visible !== false;
    child.opacity = (group.opacity ?? 1) * (child.opacity ?? 1);
    if (child.blend_mode === "normal" && group.blend_mode !== "normal") child.blend_mode = group.blend_mode;
    snapshot.layers!.push(child);
  });
  normalizeLayerOrders(snapshot.layers, group.artboard_id, parentId);
}

function insertArtboard(snapshot: EditorDocumentSnapshot, artboard: ArtboardRecord) {
  const ordered = [...snapshot.artboards].sort(orderThenId);
  ordered.splice(Math.min(Math.max(0, artboard.order), ordered.length), 0, artboard);
  snapshot.artboards = ordered;
  normalizeArtboardOrders(snapshot.artboards);
}

function moveArtboard(snapshot: EditorDocumentSnapshot, artboard: ArtboardRecord, desiredOrder: number) {
  if (!Number.isSafeInteger(desiredOrder) || desiredOrder < 0) invalidMutation("Artboard order has an invalid value");
  const ordered = snapshot.artboards.filter((item) => item.artboard_id !== artboard.artboard_id).sort(orderThenId);
  ordered.splice(Math.min(desiredOrder, ordered.length), 0, artboard);
  snapshot.artboards = ordered;
  normalizeArtboardOrders(snapshot.artboards);
}

function layerSiblings(layers: LayerRecord[], artboardId: string, parentId: string | null) {
  return layers.filter((item) => item.artboard_id === artboardId && (item.parent_layer_id ?? null) === parentId).sort(orderThenId);
}

function normalizeLayerOrders(layers: LayerRecord[], artboardId: string, parentId: string | null) {
  normalizeArrayOrders(layerSiblings(layers, artboardId, parentId));
}

function normalizeArtboardOrders(artboards: ArtboardRecord[]) { normalizeArrayOrders(artboards.sort(orderThenId)); }
function normalizeArrayOrders(items: Array<{ order: number }>) { items.forEach((item, index) => { item.order = index; }); }
function orderThenId(left: { order: number; layer_id?: string; artboard_id?: string }, right: { order: number; layer_id?: string; artboard_id?: string }) {
  return left.order - right.order || (left.layer_id ?? left.artboard_id ?? "").localeCompare(right.layer_id ?? right.artboard_id ?? "");
}

function materializeStyle(layer: LayerRecord, style: SharedStyleRecord) {
  validateStyle(style);
  const properties = style.properties ?? {};
  if (typeof properties["opacity"] === "number") layer.opacity = properties["opacity"];
  if (typeof properties["blend_mode"] === "string") layer.blend_mode = properties["blend_mode"];
  const paint = layer.shape ?? layer.vector;
  if (paint) {
    if (typeof properties["fill"] === "string" || properties["fill"] === null) paint.fill = properties["fill"] as string | null;
    if (typeof properties["stroke"] === "string" || properties["stroke"] === null) paint.stroke = properties["stroke"] as string | null;
    if (typeof properties["stroke_width"] === "number") paint.stroke_width = properties["stroke_width"];
  }
  if (layer.rich_text) {
    if (typeof properties["font_family"] === "string") layer.rich_text.font_family = properties["font_family"];
    if (typeof properties["font_size"] === "number") layer.rich_text.font_size = properties["font_size"];
    if (typeof properties["color"] === "string") layer.rich_text.color = properties["color"];
    if (["left", "center", "right", "justify"].includes(String(properties["text_align"]))) layer.rich_text.text_align = properties["text_align"] as "left" | "center" | "right" | "justify";
  }
}

function validateStyle(style: SharedStyleRecord) {
  for (const [key, value] of Object.entries(style.properties ?? {})) {
    if (!SUPPORTED_STYLE_PROPERTIES.has(key)) invalidMutation(`Shared style property ${key} is not supported`);
    if (typeof value === "number" && !Number.isFinite(value)) invalidMutation("Shared style values must be finite");
  }
  const opacity = style.properties?.["opacity"];
  if (opacity !== undefined && (typeof opacity !== "number" || opacity < 0 || opacity > 1)) invalidMutation("Shared style opacity is outside the supported range");
  const blend = style.properties?.["blend_mode"];
  if (blend !== undefined && (typeof blend !== "string" || !SUPPORTED_BLEND_MODES.has(blend))) invalidMutation("Shared style blend mode is not supported");
  const font = style.properties?.["font_family"];
  if (font !== undefined && (typeof font !== "string" || !APPROVED_FONTS.has(font.toLowerCase()))) invalidMutation("Shared styles require an approved deterministic font");
}

function normalizeAngle(value: number) {
  const normalized = ((value % 360) + 360) % 360;
  return normalized > 180 ? normalized - 360 : normalized;
}

function unitScale(unit: ArtboardRecord["unit"] | undefined) {
  return { px: 1, in: 96, mm: 96 / 25.4, pt: 96 / 72 }[unit ?? "px"];
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

export function validateSnapshot(snapshot: EditorDocumentSnapshot) {
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
    const expectedOrientation = orientation(artboard.width, artboard.height);
    if (artboard.orientation !== expectedOrientation) invalidMutation("Artboard orientation must match its dimensions");
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
    if (mask.kind === "shape" && (!mask.path_data || !SAFE_MASK_PATH.test(mask.path_data))) {
      invalidMutation("Shape masks require a supported normalized rectangle or ellipse");
    }
    if (mask.kind === "shape" && mask.path_data) {
      const values = mask.path_data.slice(mask.path_data.indexOf("(") + 1, -1).split(",").map(Number);
      if (values.length !== 4 || values.some((value) => !Number.isFinite(value)) || values[0]! + values[2]! > 1 || values[1]! + values[3]! > 1 || values[2]! <= 0 || values[3]! <= 0) {
        invalidMutation("Shape mask bounds must stay inside the target layer");
      }
    }
    if (!referencedMasks.has(mask.mask_id)) invalidMutation("Masks must be attached to a layer in the same artboard");
  }
  for (const style of snapshot.shared_styles ?? []) {
    validateStyle(style);
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
    let previousEnd = 0;
    for (const run of layer.rich_text.runs ?? []) {
      if (!Number.isSafeInteger(run.start) || !Number.isSafeInteger(run.end) || run.start < 0 || run.end < run.start || run.end > layer.rich_text.text.length) {
        invalidMutation("Rich-text ranges must stay within their text");
      }
      if (run.start < previousEnd) invalidMutation("Rich-text ranges must be ordered and non-overlapping");
      for (const [key, value] of Object.entries(run.style ?? {})) {
        if (!SUPPORTED_RICH_TEXT_PROPERTIES.has(key)) invalidMutation(`Rich-text property ${key} is not supported`);
        if (typeof value === "number" && !Number.isFinite(value)) invalidMutation("Rich-text style values must be finite");
      }
      if (typeof run.style?.["font_family"] === "string" && !APPROVED_FONTS.has(run.style["font_family"].toLowerCase())) {
        invalidMutation("Rich-text runs require an approved deterministic font");
      }
      previousEnd = run.end;
    }
    if (!APPROVED_FONTS.has((layer.rich_text.font_family ?? "system-ui").toLowerCase())) {
      invalidMutation("Rich-text layers require an approved deterministic font");
    }
  }
  if (layer.shape) {
    finiteRange(layer.shape.stroke_width, 0, 10_000, "Shape stroke width");
    finiteRange(layer.shape.corner_radius, 0, 100_000, "Shape corner radius");
    const points = layer.shape.points ?? [];
    if (points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)) {
      invalidMutation("Shape points must be normalized to the layer bounds");
    }
    if (["rectangle", "ellipse"].includes(layer.shape.shape) && points.length) invalidMutation("Rectangle and ellipse shapes do not use explicit points");
    if (layer.shape.shape === "line" && points.length !== 2) invalidMutation("Line shapes require exactly two points");
    if (layer.shape.shape === "polygon" && points.length < 3) invalidMutation("Polygon shapes require at least three points");
  }
  if (layer.vector?.path_data && (layer.vector.path_data.length > 20_000 || !SAFE_VECTOR_PATH.test(layer.vector.path_data))) {
    invalidMutation("Vector path uses unsupported commands or markup");
  }
  if (layer.vector && !layer.vector.path_data && (layer.vector.sanitised_svg_object_reference_id || layer.vector.shared_asset_id)) {
    invalidMutation("External SVG content is not enabled for editable rendering");
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
