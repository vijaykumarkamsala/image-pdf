import {
  Canvas,
  Ellipse,
  FabricImage,
  FabricObject,
  Group,
  Line,
  Path,
  Polygon,
  Rect,
  Shadow,
  Textbox,
  filters,
} from "fabric";
import type { EditableMaskRecord, EditorDocumentSnapshot, LayerRecord, LayerTransform, RichTextRun, SharedStyleRecord } from "ipw-contracts-ts/product";

import type { EditorRenderer, EditorRendererCallbacks, RendererResult, RendererSelectionState, RendererViewport } from "./EditorRenderer";
import { renderedToLayerTransform, snapCoordinate } from "./coordinates";

const ARTBOARD_MARGIN = 64;

export class FabricEditorRenderer implements EditorRenderer {
  private canvas: Canvas | null = null;
  private callbacks: EditorRendererCallbacks | null = null;
  private snapshot: EditorDocumentSnapshot | null = null;
  private readonly objects = new Map<string, FabricObject>();
  private readonly layerByObject = new WeakMap<FabricObject, LayerRecord>();
  private generation = 0;
  private viewport: RendererViewport = { zoom: 1, panX: 0, panY: 0 };
  private panning = false;
  private lastPointer: { x: number; y: number } | null = null;
  private readOnly = false;
  private rendering = false;
  private renderAbort: AbortController | null = null;
  private settled: Promise<RendererResult> = Promise.resolve({ generation: 0, applied: false });

  mount(element: HTMLCanvasElement, callbacks: EditorRendererCallbacks): void {
    this.callbacks = callbacks;
    this.canvas = new Canvas(element, {
      preserveObjectStacking: true,
      selection: true,
      backgroundColor: "transparent",
      controlsAboveOverlay: true,
      enableRetinaScaling: true,
    });
    this.canvas.upperCanvasEl.setAttribute("aria-label", "Interactive artboard canvas");
    this.canvas.upperCanvasEl.setAttribute("role", "application");
    this.canvas.on("selection:created", ({ selected }) => this.selection(selected?.[0] ?? null));
    this.canvas.on("selection:updated", ({ selected }) => this.selection(selected?.[0] ?? null));
    this.canvas.on("selection:cleared", () => {
      if (!this.rendering) this.callbacks?.onSelection(null);
    });
    this.canvas.on("object:moving", ({ target }) => this.snap(target));
    this.canvas.on("object:modified", ({ target }) => this.modified(target));
    this.canvas.on("mouse:wheel", ({ e }) => {
      e.preventDefault();
      e.stopPropagation();
      this.zoomAt(e.offsetX, e.offsetY, Math.pow(0.999, e.deltaY));
    });
    this.canvas.on("mouse:down", ({ e }) => {
      const pointer = e as MouseEvent;
      if (pointer.button !== 1 && !pointer.altKey) return;
      this.panning = true;
      this.lastPointer = { x: pointer.clientX, y: pointer.clientY };
      this.canvas!.selection = false;
    });
    this.canvas.on("mouse:move", ({ e }) => {
      if (!this.panning || !this.lastPointer) return;
      const pointer = e as MouseEvent;
      this.viewport.panX += pointer.clientX - this.lastPointer.x;
      this.viewport.panY += pointer.clientY - this.lastPointer.y;
      this.lastPointer = { x: pointer.clientX, y: pointer.clientY };
      this.applyViewport();
    });
    this.canvas.on("mouse:up", () => {
      this.panning = false;
      this.lastPointer = null;
      if (this.canvas) this.canvas.selection = true;
      this.callbacks?.onSnap(null);
    });
  }

  render(snapshot: EditorDocumentSnapshot, assetSource?: string | ((sharedAssetId: string) => string)): Promise<RendererResult> {
    this.renderAbort?.abort();
    const abort = new AbortController();
    this.renderAbort = abort;
    const generation = ++this.generation;
    const render = this.renderGeneration(generation, abort.signal, snapshot, assetSource);
    this.settled = render;
    return render;
  }

  whenSettled(): Promise<RendererResult> {
    return this.settled;
  }

  private async renderGeneration(
    generation: number,
    signal: AbortSignal,
    snapshot: EditorDocumentSnapshot,
    assetSource?: string | ((sharedAssetId: string) => string),
  ): Promise<RendererResult> {
    const canvas = this.requireCanvas();
    this.rendering = true;
    try {
      const shouldFit = this.viewport.zoom === 1 && this.viewport.panX === 0 && this.viewport.panY === 0;
      this.snapshot = structuredClone(snapshot);
      this.objects.clear();
      canvas.clear();
      canvas.backgroundColor = "transparent";

      for (const artboard of [...snapshot.artboards].sort((left, right) => left.order - right.order)) {
        const offset = this.artboardOffset(artboard.artboard_id);
        const scale = unitScale(artboard.unit);
        const artboardObject = new Rect({
        left: offset.x,
        top: offset.y,
        originX: "left",
        originY: "top",
        width: artboard.width * scale,
        height: artboard.height * scale,
        fill: artboard.background.kind === "transparent" ? "rgba(255,255,255,0.75)" : artboard.background.color ?? "#ffffff",
        stroke: "#9aa6b5",
        strokeWidth: 1,
        selectable: false,
        evented: false,
        excludeFromExport: true,
        shadow: new Shadow({ color: "rgba(23, 32, 51, 0.16)", blur: 16, offsetX: 0, offsetY: 5, affectStroke: false, nonScaling: true }),
        });
        canvas.add(artboardObject);
      }

      const layers = [...(snapshot.layers ?? [])]
        .filter((layer) => !layer.parent_layer_id)
        .sort((left, right) => {
          const artboardOrder = snapshot.artboards.find((item) => item.artboard_id === left.artboard_id)!.order
            - snapshot.artboards.find((item) => item.artboard_id === right.artboard_id)!.order;
          return artboardOrder || left.order - right.order || left.layer_id.localeCompare(right.layer_id);
        });
      for (const layer of layers) {
        const object = await this.objectFor(layer, snapshot, assetSource, signal);
        if (signal.aborted || generation !== this.generation) return { generation, applied: false };
        if (!object) continue;
        const offset = this.artboardOffset(layer.artboard_id);
        this.configure(object, layer, offset, unitScale(snapshot.artboards.find((item) => item.artboard_id === layer.artboard_id)?.unit), true, snapshot.shared_styles ?? []);
        this.applyClip(object, layer, snapshot, offset);
        this.objects.set(layer.layer_id, object);
        this.layerByObject.set(object, structuredClone(layer));
        canvas.add(object);
      }
      canvas.requestRenderAll();
      if (shouldFit) this.fit();
      else this.applyViewport();
      return { generation, applied: true };
    } catch (error) {
      if (signal.aborted || generation !== this.generation) return { generation, applied: false };
      throw error;
    } finally {
      if (generation === this.generation) this.rendering = false;
    }
  }

  resize(width: number, height: number): void {
    const canvas = this.requireCanvas();
    canvas.setDimensions({ width: Math.max(1, Math.floor(width)), height: Math.max(1, Math.floor(height)) });
    if (this.snapshot) this.fit();
    else canvas.requestRenderAll();
  }

  select(layerId: string | null): RendererSelectionState {
    const canvas = this.requireCanvas();
    const object = layerId ? this.objects.get(layerId) : undefined;
    if (object) canvas.setActiveObject(object);
    else canvas.discardActiveObject();
    canvas.requestRenderAll();
    return this.selectionState();
  }

  selectionState(): RendererSelectionState {
    const active = this.canvas?.getActiveObject();
    const layer = active ? this.layerByObject.get(active) : undefined;
    const artboard = this.snapshot?.artboards.find((item) => item.artboard_id === layer?.artboard_id);
    if (!active || !layer || !artboard) return { layerId: null, artboardId: null, visible: false, controlsVisible: false };
    const offset = this.artboardOffset(artboard.artboard_id);
    const unit = unitScale(artboard.unit);
    const bounds = active.getBoundingRect();
    const insideArtboard = bounds.left >= offset.x
      && bounds.top >= offset.y
      && bounds.left + bounds.width <= offset.x + artboard.width * unit
      && bounds.top + bounds.height <= offset.y + artboard.height * unit;
    const visible = layer.visible !== false && active.visible !== false && insideArtboard && active.isOnScreen();
    return {
      layerId: layer.layer_id,
      artboardId: layer.artboard_id,
      visible,
      controlsVisible: visible && active.selectable && active.hasBorders && active.hasControls,
    };
  }

  setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly;
    for (const object of this.objects.values()) {
      const layer = this.layerByObject.get(object);
      if (layer) this.applyInteractivity(object, layer);
    }
    this.canvas?.requestRenderAll();
  }

  zoomBy(factor: number): void {
    const canvas = this.requireCanvas();
    this.zoomAt(canvas.width / 2, canvas.height / 2, factor);
  }

  fit(): void {
    this.fitBounds(this.documentBounds());
  }

  fitArtboard(artboardId: string): boolean {
    const artboard = this.snapshot?.artboards.find((item) => item.artboard_id === artboardId);
    if (!artboard) return false;
    const offset = this.artboardOffset(artboardId);
    this.fitBounds({
      left: offset.x - 32,
      top: offset.y - 32,
      width: artboard.width * unitScale(artboard.unit) + 64,
      height: artboard.height * unitScale(artboard.unit) + 64,
    });
    return true;
  }

  private fitBounds(bounds: { left: number; top: number; width: number; height: number }): void {
    const canvas = this.requireCanvas();
    const zoom = Math.min(2, Math.max(0.05, Math.min((canvas.width - 64) / bounds.width, (canvas.height - 64) / bounds.height)));
    this.viewport = {
      zoom,
      panX: (canvas.width - bounds.width * zoom) / 2 - bounds.left * zoom,
      panY: (canvas.height - bounds.height * zoom) / 2 - bounds.top * zoom,
    };
    this.applyViewport();
  }

  dispose(): void {
    this.renderAbort?.abort();
    this.renderAbort = null;
    this.generation += 1;
    this.rendering = false;
    this.canvas?.dispose();
    this.canvas = null;
    this.objects.clear();
  }

  private async objectFor(
    layer: LayerRecord,
    snapshot: EditorDocumentSnapshot,
    assetSource?: string | ((sharedAssetId: string) => string),
    signal?: AbortSignal,
  ): Promise<FabricObject | null> {
    const style = effectiveStyle(layer, snapshot.shared_styles ?? []);
    if (layer.layer_type === "shape" && layer.shape) {
      const common = {
        fill: paintValue(style["fill"], layer.shape.fill) ?? "transparent",
        stroke: paintValue(style["stroke"], layer.shape.stroke) ?? undefined,
        strokeWidth: numericValue(style["stroke_width"], layer.shape.stroke_width ?? 0),
      };
      if (layer.shape.shape === "ellipse") return new Ellipse({ ...common, rx: layer.transform.width / 2, ry: layer.transform.height / 2 });
      if (layer.shape.shape === "line") {
        const points = layer.shape.points ?? [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }];
        return new Line([
          points[0]!.x * layer.transform.width,
          points[0]!.y * layer.transform.height,
          points[1]!.x * layer.transform.width,
          points[1]!.y * layer.transform.height,
        ], { ...common, fill: undefined, stroke: common.stroke ?? common.fill ?? "#3559e0", strokeWidth: Math.max(1, common.strokeWidth) });
      }
      if (layer.shape.shape === "polygon") {
        const points = (layer.shape.points ?? []).map((point) => ({ x: point.x * layer.transform.width, y: point.y * layer.transform.height }));
        return new Polygon(points, common);
      }
      return new Rect({ ...common, width: layer.transform.width, height: layer.transform.height, rx: layer.shape.corner_radius ?? 0, ry: layer.shape.corner_radius ?? 0 });
    }
    if (layer.layer_type === "rich_text" && layer.rich_text) {
      const font = approvedFont(stringValue(style["font_family"], layer.rich_text.font_family));
      const text = new Textbox(layer.rich_text.text, {
        width: layer.transform.width,
        fontFamily: font.family,
        fontSize: numericValue(style["font_size"], layer.rich_text.font_size),
        fill: paintValue(style["color"], layer.rich_text.color) ?? "#162033",
        textAlign: textAlignValue(style["text_align"], layer.rich_text.text_align),
      });
      text.set("styles", richTextStyles(layer.rich_text.text, layer.rich_text.runs ?? []));
      return text;
    }
    if (layer.layer_type === "vector_svg" && layer.vector?.path_data) {
      return new Path(layer.vector.path_data, {
        fill: paintValue(style["fill"], layer.vector.fill) ?? "transparent",
        stroke: paintValue(style["stroke"], layer.vector.stroke) ?? undefined,
        strokeWidth: numericValue(style["stroke_width"], layer.vector.stroke_width ?? 0),
      });
    }
    if (layer.layer_type === "raster_image" && layer.raster && assetSource) {
      const sourceUrl = typeof assetSource === "function" ? assetSource(layer.raster.shared_asset_id) : assetSource;
      const response = await fetch(sourceUrl, { credentials: "same-origin", cache: "no-store", signal });
      if (!response.ok) throw new Error("The source preview could not be loaded");
      const blobUrl = URL.createObjectURL(await response.blob());
      try {
        const image = await FabricImage.fromURL(blobUrl);
        const crop = layer.raster?.crop;
        const width = image.width || layer.transform.width;
        const height = image.height || layer.transform.height;
        const left = crop?.left ?? 0;
        const top = crop?.top ?? 0;
        const right = crop?.right ?? 1;
        const bottom = crop?.bottom ?? 1;
        image.set({ cropX: width * left, cropY: height * top, width: width * (right - left), height: height * (bottom - top) });
        this.applyFilters(image, layer);
        return image;
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    }
    if (layer.layer_type === "group" && layer.group) {
      const children: FabricObject[] = [];
      const childLayers = (snapshot.layers ?? [])
        .filter((item) => item.parent_layer_id === layer.layer_id)
        .sort((left, right) => left.order - right.order || left.layer_id.localeCompare(right.layer_id));
      for (const childLayer of childLayers) {
        const child = await this.objectFor(childLayer, snapshot, assetSource, signal);
        if (signal?.aborted) return null;
        if (!child) continue;
        this.configure(child, childLayer, { x: 0, y: 0 }, unitScale(snapshot.artboards.find((item) => item.artboard_id === layer.artboard_id)?.unit), false, snapshot.shared_styles ?? []);
        const maskId = childLayer.raster?.mask_ids?.[0] ?? childLayer.vector?.mask_ids?.[0];
        const mask = maskId ? snapshot.masks?.find((item) => item.mask_id === maskId && item.enabled) : undefined;
        if (mask) child.clipPath = this.maskClip(mask, child) ?? undefined;
        child.set({ selectable: false, evented: false });
        children.push(child);
      }
      return children.length ? new Group(children, { subTargetCheck: false, interactive: false }) : null;
    }
    return null;
  }

  private configure(object: FabricObject, layer: LayerRecord, offset: { x: number; y: number }, unit = 1, interactive = true, styles: SharedStyleRecord[] = []) {
    const intrinsicWidth = object.width || layer.transform.width;
    const intrinsicHeight = object.height || layer.transform.height;
    const style = effectiveStyle(layer, styles);
    object.set({
      left: offset.x + layer.transform.x * unit,
      top: offset.y + layer.transform.y * unit,
      originX: "left",
      originY: "top",
      angle: layer.transform.rotation_degrees,
      scaleX: (layer.transform.width * unit / intrinsicWidth) * (layer.transform.scale_x ?? 1),
      scaleY: (layer.transform.height * unit / intrinsicHeight) * (layer.transform.scale_y ?? 1),
      flipX: layer.transform.flip_x,
      flipY: layer.transform.flip_y,
      opacity: numericValue(style["opacity"], layer.opacity ?? 1),
      visible: layer.visible,
      globalCompositeOperation: blendMode(style["blend_mode"], layer.blend_mode),
      objectCaching: true,
      cornerColor: "#3559e0",
      borderColor: "#3559e0",
      cornerStyle: "circle",
      transparentCorners: false,
    });
    if (interactive) this.applyInteractivity(object, layer);
    object.setCoords();
  }

  private applyClip(object: FabricObject, layer: LayerRecord, snapshot: EditorDocumentSnapshot, offset: { x: number; y: number }) {
    const artboard = snapshot.artboards.find((item) => item.artboard_id === layer.artboard_id);
    if (!artboard) return;
    const unit = unitScale(artboard.unit);
    const artboardClip = new Rect({
      left: offset.x,
      top: offset.y,
      width: artboard.width * unit,
      height: artboard.height * unit,
      originX: "left",
      originY: "top",
      absolutePositioned: true,
    });
    const maskId = layer.raster?.mask_ids?.[0] ?? layer.vector?.mask_ids?.[0];
    const mask = maskId ? snapshot.masks?.find((item) => item.mask_id === maskId && item.enabled) : undefined;
    const layerMask = mask ? this.maskClip(mask, object) : null;
    if (layerMask) {
      layerMask.clipPath = artboardClip;
      object.clipPath = layerMask;
    } else {
      object.clipPath = artboardClip;
    }
  }

  private maskClip(mask: EditableMaskRecord, object: FabricObject): FabricObject | null {
    if (mask.kind !== "shape" || !mask.path_data) return null;
    const match = /^(rect|ellipse)\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/.exec(mask.path_data);
    if (!match) return null;
    const [, kind, x, y, width, height] = match;
    const bounds = {
      left: Number(x) * (object.width ?? 1),
      top: Number(y) * (object.height ?? 1),
      originX: "left" as const,
      originY: "top" as const,
      inverted: mask.inverted,
    };
    return kind === "ellipse"
      ? new Ellipse({ ...bounds, rx: Number(width) * (object.width ?? 1) / 2, ry: Number(height) * (object.height ?? 1) / 2 })
      : new Rect({ ...bounds, width: Number(width) * (object.width ?? 1), height: Number(height) * (object.height ?? 1) });
  }

  private applyInteractivity(object: FabricObject, layer: LayerRecord) {
    const mutable = !this.readOnly && !layer.locked;
    object.set({
      selectable: true,
      evented: true,
      hasControls: mutable,
      lockMovementX: !mutable,
      lockMovementY: !mutable,
      lockScalingX: !mutable,
      lockScalingY: !mutable,
      lockRotation: !mutable,
    });
  }

  private applyFilters(image: FabricImage, layer: LayerRecord) {
    const value = layer.raster?.adjustments;
    if (!value) return;
    const imageFilters = [];
    const brightness = ((value.brightness ?? 0) + (value.exposure ?? 0)) / 200;
    if (brightness) imageFilters.push(new filters.Brightness({ brightness: clamp(brightness, -1, 1) }));
    if (value.contrast) imageFilters.push(new filters.Contrast({ contrast: value.contrast / 100 }));
    if (value.saturation) imageFilters.push(new filters.Saturation({ saturation: value.saturation / 100 }));
    if (value.temperature) imageFilters.push(new filters.BlendColor({ color: value.temperature > 0 ? "#ff9d55" : "#5d8dff", mode: "tint", alpha: Math.abs(value.temperature) / 300 }));
    if (value.tint) imageFilters.push(new filters.BlendColor({ color: value.tint > 0 ? "#d85cff" : "#52d8a6", mode: "tint", alpha: Math.abs(value.tint) / 300 }));
    if (value.sharpness) {
      const amount = value.sharpness / 100;
      imageFilters.push(new filters.Convolute({ opaque: false, matrix: [0, -amount, 0, -amount, 1 + amount * 4, -amount, 0, -amount, 0] }));
    }
    image.filters = imageFilters;
    image.applyFilters();
  }

  private modified(target: FabricObject | undefined) {
    this.callbacks?.onSnap(null);
    if (!target || this.readOnly) return;
    const layer = this.layerByObject.get(target);
    if (!layer) return;
    const offset = this.artboardOffset(layer.artboard_id);
    const unit = unitScale(this.snapshot?.artboards.find((item) => item.artboard_id === layer.artboard_id)?.unit);
    const transform = renderedToLayerTransform(layer.transform, {
      left: ((target.left ?? 0) - offset.x) / unit,
      top: ((target.top ?? 0) - offset.y) / unit,
      angle: target.angle ?? 0,
      scaledWidth: target.getScaledWidth() / unit,
      scaledHeight: target.getScaledHeight() / unit,
      flipX: target.flipX ?? false,
      flipY: target.flipY ?? false,
    });
    this.callbacks?.onTransform(layer.layer_id, transform);
  }

  private snap(target: FabricObject | undefined) {
    if (!target || !this.snapshot || this.readOnly) return;
    const layer = this.layerByObject.get(target);
    const artboard = this.snapshot.artboards.find((item) => item.artboard_id === layer?.artboard_id);
    if (!layer || !artboard) return;
    const offset = this.artboardOffset(layer.artboard_id);
    const unit = unitScale(artboard.unit);
    const threshold = 6 / this.viewport.zoom;
    const sourceX = (target.left ?? offset.x) - offset.x;
    const sourceY = (target.top ?? offset.y) - offset.y;
    const snappedX = snapCoordinate(sourceX, [0, artboard.width * unit / 2, artboard.width * unit], threshold);
    const snappedY = snapCoordinate(sourceY, [0, artboard.height * unit / 2, artboard.height * unit], threshold);
    target.set({
      left: offset.x + snappedX,
      top: offset.y + snappedY,
    });
    this.callbacks?.onSnap(snappedX !== sourceX || snappedY !== sourceY ? {
      x: snappedX !== sourceX ? offset.x + snappedX : null,
      y: snappedY !== sourceY ? offset.y + snappedY : null,
    } : null);
  }

  private selection(target: FabricObject | null) {
    this.callbacks?.onSelection(target ? this.layerByObject.get(target)?.layer_id ?? null : null);
  }

  private zoomAt(x: number, y: number, factor: number) {
    const next = clamp(this.viewport.zoom * factor, 0.05, 8);
    const ratio = next / this.viewport.zoom;
    this.viewport.panX = x - (x - this.viewport.panX) * ratio;
    this.viewport.panY = y - (y - this.viewport.panY) * ratio;
    this.viewport.zoom = next;
    this.applyViewport();
  }

  private applyViewport() {
    const canvas = this.requireCanvas();
    canvas.setViewportTransform([this.viewport.zoom, 0, 0, this.viewport.zoom, this.viewport.panX, this.viewport.panY]);
    const [zoomX, , , zoomY, panX, panY] = canvas.viewportTransform;
    this.callbacks?.onViewport({
      zoom: (zoomX + zoomY) / 2,
      panX,
      panY,
    });
  }

  private artboardOffset(artboardId: string) {
    if (!this.snapshot) return { x: ARTBOARD_MARGIN, y: ARTBOARD_MARGIN };
    let x = ARTBOARD_MARGIN;
    for (const artboard of [...this.snapshot.artboards].sort((left, right) => left.order - right.order)) {
      if (artboard.artboard_id === artboardId) return { x, y: ARTBOARD_MARGIN };
      x += artboard.width * unitScale(artboard.unit) + ARTBOARD_MARGIN;
    }
    return { x: ARTBOARD_MARGIN, y: ARTBOARD_MARGIN };
  }

  private documentBounds() {
    const artboards = this.snapshot?.artboards ?? [];
    return {
      left: 0,
      top: 0,
      width: Math.max(1, artboards.reduce((total, item) => total + item.width * unitScale(item.unit) + ARTBOARD_MARGIN, ARTBOARD_MARGIN)),
      height: Math.max(1, ...artboards.map((item) => item.height * unitScale(item.unit) + ARTBOARD_MARGIN * 2)),
    };
  }

  private requireCanvas(): Canvas {
    if (!this.canvas) throw new Error("Editor renderer is not mounted");
    return this.canvas;
  }
}

function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }

function unitScale(unit: string | undefined): number {
  return { px: 1, in: 96, mm: 96 / 25.4, pt: 96 / 72 }[unit ?? "px"] ?? 1;
}

function effectiveStyle(layer: LayerRecord, styles: SharedStyleRecord[]) {
  const result: Record<string, string | number | boolean | null> = {};
  for (const styleId of layer.shared_style_ids ?? []) {
    const style = styles.find((item) => item.shared_style_id === styleId);
    if (style) Object.assign(result, style.properties ?? {});
  }
  return result;
}

function approvedFont(value: string | undefined): { family: string; compatible: boolean } {
  const fonts = new Map([
    ["system-ui", "system-ui"],
    ["arial", "Arial"],
    ["times new roman", "Times New Roman"],
    ["courier new", "Courier New"],
  ]);
  const family = fonts.get((value ?? "system-ui").toLowerCase());
  return family ? { family, compatible: true } : { family: "Arial", compatible: false };
}

function richTextStyles(text: string, runs: RichTextRun[]) {
  const styles: Record<number, Record<number, Record<string, string | number | boolean>>> = {};
  for (const run of runs) {
    for (let index = run.start; index < run.end; index += 1) {
      const before = text.slice(0, index);
      const line = before.split("\n").length - 1;
      const character = index - (before.lastIndexOf("\n") + 1);
      const source = run.style ?? {};
      const target: Record<string, string | number | boolean> = {};
      const font = typeof source["font_family"] === "string" ? approvedFont(source["font_family"]) : null;
      if (font) target["fontFamily"] = font.family;
      if (typeof source["font_size"] === "number") target["fontSize"] = source["font_size"];
      if (typeof source["color"] === "string") target["fill"] = source["color"];
      if (typeof source["font_weight"] === "string" || typeof source["font_weight"] === "number") target["fontWeight"] = source["font_weight"];
      if (source["font_style"] === "italic" || source["font_style"] === "normal") target["fontStyle"] = source["font_style"];
      if (typeof source["underline"] === "boolean") target["underline"] = source["underline"];
      (styles[line] ??= {})[character] = target;
    }
  }
  return styles;
}

function stringValue(style: string | number | boolean | null | undefined, fallback: string | undefined) {
  return typeof style === "string" ? style : fallback;
}

function numericValue(style: string | number | boolean | null | undefined, fallback: number | undefined) {
  return typeof style === "number" ? style : fallback ?? 0;
}

function paintValue(style: string | number | boolean | null | undefined, fallback: string | null | undefined) {
  return typeof style === "string" || style === null ? style : fallback;
}

function textAlignValue(style: string | number | boolean | null | undefined, fallback: "left" | "center" | "right" | "justify" | undefined) {
  return style === "left" || style === "center" || style === "right" || style === "justify" ? style : fallback ?? "left";
}

function blendMode(style: string | number | boolean | null | undefined, fallback: string | undefined) {
  const value = typeof style === "string" ? style : fallback ?? "normal";
  return value === "normal" ? "source-over" : value;
}
