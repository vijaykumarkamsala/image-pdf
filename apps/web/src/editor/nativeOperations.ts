import type { EditorDocumentSnapshot, EditorMutation, LayerRecord } from "ipw-contracts-ts/product";

export function applyOptimisticMutation(snapshot: EditorDocumentSnapshot, mutation: EditorMutation): EditorDocumentSnapshot {
  const next = structuredClone(snapshot);
  next.layers ??= [];
  next.masks ??= [];
  switch (mutation.kind) {
    case "layer.add":
      if (!mutation.layer) throw new Error("A layer is required");
      insertLayer(next.layers, structuredClone(mutation.layer));
      break;
    case "layer.update": {
      const layer = requireLayer(next.layers, mutation.target_id);
      if (mutation.layer) Object.assign(layer, structuredClone(mutation.layer));
      if (mutation.transform) layer.transform = structuredClone(mutation.transform);
      if (mutation.crop && layer.raster) layer.raster.crop = structuredClone(mutation.crop);
      if (mutation.adjustments && layer.raster) layer.raster.adjustments = structuredClone(mutation.adjustments);
      Object.assign(layer, mutation.properties ?? {});
      break;
    }
    case "layer.remove": {
      const target = requireLayer(next.layers, mutation.target_id);
      const ids = descendants(next.layers, mutation.target_id);
      next.layers = next.layers.filter((layer) => !ids.has(layer.layer_id));
      normalizeSiblings(next.layers, target.artboard_id, target.parent_layer_id ?? null);
      break;
    }
    case "layer.reorder": {
      const layer = requireLayer(next.layers, mutation.target_id);
      const oldParent = layer.parent_layer_id ?? null;
      const newParent = mutation.properties?.["parent_layer_id"] === undefined ? oldParent : mutation.properties["parent_layer_id"] as string | null;
      const order = Number(mutation.properties?.["order"] ?? layer.order);
      next.layers = next.layers.filter((item) => item.layer_id !== layer.layer_id);
      normalizeSiblings(next.layers, layer.artboard_id, oldParent);
      layer.parent_layer_id = newParent;
      layer.order = order;
      insertLayer(next.layers, layer);
      break;
    }
    case "layer.group": {
      if (!mutation.layer?.group || (mutation.target_ids ?? []).length < 2) throw new Error("A group and two layers are required");
      const targets = (mutation.target_ids ?? []).map((id) => requireLayer(next.layers!, id));
      const first = targets[0]!;
      const minX = Math.min(...targets.map((item) => item.transform.x));
      const minY = Math.min(...targets.map((item) => item.transform.y));
      const maxX = Math.max(...targets.map((item) => item.transform.x + item.transform.width * (item.transform.scale_x ?? 1)));
      const maxY = Math.max(...targets.map((item) => item.transform.y + item.transform.height * (item.transform.scale_y ?? 1)));
      const ids = new Set(targets.map((item) => item.layer_id));
      next.layers = next.layers.filter((item) => !ids.has(item.layer_id));
      normalizeSiblings(next.layers, first.artboard_id, first.parent_layer_id ?? null);
      const group = structuredClone(mutation.layer);
      group.artboard_id = first.artboard_id;
      group.parent_layer_id = first.parent_layer_id ?? null;
      group.order = Math.min(...targets.map((item) => item.order));
      group.transform = baseTransform(minX, minY, Math.max(1, maxX - minX), Math.max(1, maxY - minY));
      group.extension_payload = { ...group.extension_payload, semantic_group: true };
      insertLayer(next.layers, group);
      targets.sort((left, right) => left.order - right.order || left.layer_id.localeCompare(right.layer_id)).forEach((item, index) => {
        item.parent_layer_id = group.layer_id;
        item.order = index;
        item.transform.x -= minX;
        item.transform.y -= minY;
        next.layers!.push(item);
      });
      break;
    }
    case "layer.ungroup": {
      const group = requireLayer(next.layers, mutation.target_id);
      const children = siblings(next.layers, group.artboard_id, group.layer_id);
      const parentId = group.parent_layer_id ?? null;
      const radians = (group.transform.rotation_degrees ?? 0) * Math.PI / 180;
      const sx = (group.transform.scale_x ?? 1) * (group.transform.flip_x ? -1 : 1);
      const sy = (group.transform.scale_y ?? 1) * (group.transform.flip_y ? -1 : 1);
      next.layers = next.layers.filter((item) => item.layer_id !== group.layer_id && item.parent_layer_id !== group.layer_id);
      children.forEach((child, index) => {
        const x = child.transform.x * sx;
        const y = child.transform.y * sy;
        child.transform.x = group.transform.x + x * Math.cos(radians) - y * Math.sin(radians);
        child.transform.y = group.transform.y + x * Math.sin(radians) + y * Math.cos(radians);
        child.transform.scale_x = (child.transform.scale_x ?? 1) * Math.abs(sx);
        child.transform.scale_y = (child.transform.scale_y ?? 1) * Math.abs(sy);
        child.transform.rotation_degrees = normalAngle((child.transform.rotation_degrees ?? 0) + (group.transform.rotation_degrees ?? 0));
        child.transform.flip_x = Boolean(child.transform.flip_x) !== Boolean(group.transform.flip_x);
        child.transform.flip_y = Boolean(child.transform.flip_y) !== Boolean(group.transform.flip_y);
        child.parent_layer_id = parentId;
        child.order = group.order + index;
        child.visible = group.visible !== false && child.visible !== false;
        child.opacity = (group.opacity ?? 1) * (child.opacity ?? 1);
        if (child.blend_mode === "normal" && group.blend_mode !== "normal") child.blend_mode = group.blend_mode;
        next.layers!.push(child);
      });
      normalizeSiblings(next.layers, group.artboard_id, parentId);
      break;
    }
    case "artboard.add":
      if (!mutation.artboard) throw new Error("An artboard is required");
      next.artboards.push(structuredClone(mutation.artboard));
      normalizeOrders(next.artboards);
      break;
    case "artboard.update": {
      const artboard = next.artboards.find((item) => item.artboard_id === mutation.target_id);
      if (!artboard || !mutation.artboard) throw new Error("The artboard was not found");
      const replacement = structuredClone(mutation.artboard);
      if ((replacement.unit ?? "px") !== (artboard.unit ?? "px")) {
        const ratio = unitScale(artboard.unit) / unitScale(replacement.unit);
        next.layers.filter((item) => item.artboard_id === artboard.artboard_id).forEach((item) => {
          item.transform.x *= ratio;
          item.transform.y *= ratio;
          item.transform.width *= ratio;
          item.transform.height *= ratio;
        });
      }
      Object.assign(artboard, replacement);
      normalizeOrders(next.artboards);
      break;
    }
    case "artboard.remove":
      next.artboards = next.artboards.filter((item) => item.artboard_id !== mutation.target_id);
      next.layers = next.layers.filter((item) => item.artboard_id !== mutation.target_id);
      next.masks = next.masks.filter((item) => item.artboard_id !== mutation.target_id);
      normalizeOrders(next.artboards);
      break;
    case "mask.update": {
      if (!mutation.mask) throw new Error("A mask is required");
      const index = next.masks.findIndex((item) => item.mask_id === mutation.mask!.mask_id);
      if (index < 0) next.masks.push(structuredClone(mutation.mask));
      else next.masks[index] = structuredClone(mutation.mask);
      if (mutation.target_id) {
        const layer = requireLayer(next.layers, mutation.target_id);
        const maskIds = layer.raster?.mask_ids ?? layer.vector?.mask_ids;
        if (maskIds && !maskIds.includes(mutation.mask.mask_id)) maskIds.push(mutation.mask.mask_id);
      }
      break;
    }
    case "style.upsert": {
      if (!mutation.shared_style) throw new Error("A shared style is required");
      next.shared_styles ??= [];
      const index = next.shared_styles.findIndex((item) => item.shared_style_id === mutation.shared_style!.shared_style_id);
      if (index < 0) next.shared_styles.push(structuredClone(mutation.shared_style));
      else next.shared_styles[index] = structuredClone(mutation.shared_style);
      for (const layerId of mutation.target_ids ?? []) {
        const layer = requireLayer(next.layers, layerId);
        layer.shared_style_ids ??= [];
        if (!layer.shared_style_ids.includes(mutation.shared_style.shared_style_id)) layer.shared_style_ids.push(mutation.shared_style.shared_style_id);
      }
      break;
    }
    case "style.detach": {
      const style = next.shared_styles?.find((item) => item.shared_style_id === mutation.target_id);
      if (!style) throw new Error("The shared style was not found");
      for (const layerId of mutation.target_ids ?? []) {
        const layer = requireLayer(next.layers, layerId);
        materializeStyle(layer, style.properties ?? {});
        layer.shared_style_ids = (layer.shared_style_ids ?? []).filter((id) => id !== style.shared_style_id);
      }
      break;
    }
    case "document.rename":
      break;
  }
  next.revision = snapshot.revision + 1;
  return next;
}

function insertLayer(layers: LayerRecord[], layer: LayerRecord) {
  const group = siblings(layers, layer.artboard_id, layer.parent_layer_id ?? null);
  group.splice(Math.min(Math.max(0, layer.order), group.length), 0, layer);
  normalizeOrders(group);
  layers.push(layer);
  normalizeSiblings(layers, layer.artboard_id, layer.parent_layer_id ?? null);
}

function siblings(layers: LayerRecord[], artboardId: string, parentId: string | null) {
  return layers.filter((item) => item.artboard_id === artboardId && (item.parent_layer_id ?? null) === parentId)
    .sort((left, right) => left.order - right.order || left.layer_id.localeCompare(right.layer_id));
}

function normalizeSiblings(layers: LayerRecord[], artboardId: string, parentId: string | null) { normalizeOrders(siblings(layers, artboardId, parentId)); }
function normalizeOrders(items: Array<{ order: number }>) { items.sort((left, right) => left.order - right.order).forEach((item, index) => { item.order = index; }); }
function baseTransform(x: number, y: number, width: number, height: number) { return { x, y, width, height, rotation_degrees: 0, scale_x: 1, scale_y: 1, skew_x_degrees: 0, skew_y_degrees: 0, flip_x: false, flip_y: false }; }
function unitScale(unit: string | undefined) { return { px: 1, in: 96, mm: 96 / 25.4, pt: 96 / 72 }[unit ?? "px"] ?? 1; }
function normalAngle(value: number) { const normalized = ((value % 360) + 360) % 360; return normalized > 180 ? normalized - 360 : normalized; }

function materializeStyle(layer: LayerRecord, properties: Partial<Record<string, string | number | boolean | null>>) {
  if (typeof properties["opacity"] === "number") layer.opacity = properties["opacity"];
  if (typeof properties["blend_mode"] === "string") layer.blend_mode = properties["blend_mode"];
  const paint = layer.shape ?? layer.vector;
  if (paint) {
    if (typeof properties["fill"] === "string" || properties["fill"] === null) paint.fill = properties["fill"] as string | null;
    if (typeof properties["stroke"] === "string" || properties["stroke"] === null) paint.stroke = properties["stroke"] as string | null;
    if (typeof properties["stroke_width"] === "number") paint.stroke_width = properties["stroke_width"];
  }
}

export function replayPendingMutations(
  snapshot: EditorDocumentSnapshot,
  operations: Array<{ baseRevision: number; mutation: EditorMutation }>,
): EditorDocumentSnapshot {
  let current = structuredClone(snapshot);
  for (const operation of operations) {
    if (operation.baseRevision !== current.revision) throw new Error("Pending edits no longer share the current document revision");
    current = applyOptimisticMutation(current, operation.mutation);
  }
  return current;
}

function requireLayer(layers: LayerRecord[], id: string | null | undefined): LayerRecord {
  const layer = layers.find((item) => item.layer_id === id);
  if (!layer) throw new Error("The edited layer was not found");
  return layer;
}

function descendants(layers: LayerRecord[], root: string | null | undefined): Set<string> {
  if (!root) throw new Error("A layer is required");
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
