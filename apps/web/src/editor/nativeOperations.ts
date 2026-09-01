import type { EditorDocumentSnapshot, EditorMutation, LayerRecord } from "ipw-contracts-ts/product";

export function applyOptimisticMutation(snapshot: EditorDocumentSnapshot, mutation: EditorMutation): EditorDocumentSnapshot {
  const next = structuredClone(snapshot);
  next.layers ??= [];
  next.masks ??= [];
  switch (mutation.kind) {
    case "layer.add":
      if (!mutation.layer) throw new Error("A layer is required");
      next.layers.push(structuredClone(mutation.layer));
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
      const ids = descendants(next.layers, mutation.target_id);
      next.layers = next.layers.filter((layer) => !ids.has(layer.layer_id));
      break;
    }
    case "layer.reorder":
      Object.assign(requireLayer(next.layers, mutation.target_id), mutation.properties ?? {});
      break;
    case "artboard.add":
      if (!mutation.artboard) throw new Error("An artboard is required");
      next.artboards.push(structuredClone(mutation.artboard));
      break;
    case "artboard.update": {
      const artboard = next.artboards.find((item) => item.artboard_id === mutation.target_id);
      if (!artboard || !mutation.artboard) throw new Error("The artboard was not found");
      Object.assign(artboard, structuredClone(mutation.artboard));
      break;
    }
    case "artboard.remove":
      next.artboards = next.artboards.filter((item) => item.artboard_id !== mutation.target_id);
      next.layers = next.layers.filter((item) => item.artboard_id !== mutation.target_id);
      next.masks = next.masks.filter((item) => item.artboard_id !== mutation.target_id);
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
    case "document.rename":
      break;
  }
  next.revision = snapshot.revision + 1;
  return next;
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
