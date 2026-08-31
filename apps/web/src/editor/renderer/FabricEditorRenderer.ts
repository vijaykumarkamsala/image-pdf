import {
  Canvas,
  Ellipse,
  FabricImage,
  FabricObject,
  Rect,
  Shadow,
  Textbox,
  filters,
} from "fabric";
import type { EditorDocumentSnapshot, LayerRecord, LayerTransform } from "ipw-contracts-ts/product";

import type { EditorRenderer, EditorRendererCallbacks, RendererViewport } from "./EditorRenderer";
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
    this.canvas.on("selection:cleared", () => this.callbacks?.onSelection(null));
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
    });
  }

  async render(snapshot: EditorDocumentSnapshot, sourceUrl?: string): Promise<void> {
    const canvas = this.requireCanvas();
    const generation = ++this.generation;
    const shouldFit = this.viewport.zoom === 1 && this.viewport.panX === 0 && this.viewport.panY === 0;
    this.snapshot = structuredClone(snapshot);
    this.objects.clear();
    canvas.clear();
    canvas.backgroundColor = "transparent";

    for (const artboard of [...snapshot.artboards].sort((left, right) => left.order - right.order)) {
      const offset = this.artboardOffset(artboard.artboard_id);
      const artboardObject = new Rect({
        left: offset.x,
        top: offset.y,
        originX: "left",
        originY: "top",
        width: artboard.width,
        height: artboard.height,
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

    const layers = [...(snapshot.layers ?? [])].sort((left, right) => left.order - right.order);
    for (const layer of layers) {
      const object = await this.objectFor(layer, sourceUrl);
      if (generation !== this.generation) return;
      if (!object) continue;
      const offset = this.artboardOffset(layer.artboard_id);
      this.configure(object, layer, offset);
      this.objects.set(layer.layer_id, object);
      this.layerByObject.set(object, structuredClone(layer));
      canvas.add(object);
    }
    canvas.requestRenderAll();
    if (shouldFit) this.fit();
    else this.applyViewport();
  }

  resize(width: number, height: number): void {
    const canvas = this.requireCanvas();
    canvas.setDimensions({ width: Math.max(1, Math.floor(width)), height: Math.max(1, Math.floor(height)) });
    if (this.snapshot) this.fit();
    else canvas.requestRenderAll();
  }

  select(layerId: string | null): void {
    const canvas = this.requireCanvas();
    if (!layerId) canvas.discardActiveObject();
    else {
      const object = this.objects.get(layerId);
      if (object) canvas.setActiveObject(object);
    }
    canvas.requestRenderAll();
  }

  zoomBy(factor: number): void {
    const canvas = this.requireCanvas();
    this.zoomAt(canvas.width / 2, canvas.height / 2, factor);
  }

  fit(): void {
    const canvas = this.requireCanvas();
    const bounds = this.documentBounds();
    const zoom = Math.min(2, Math.max(0.05, Math.min((canvas.width - 64) / bounds.width, (canvas.height - 64) / bounds.height)));
    this.viewport = {
      zoom,
      panX: (canvas.width - bounds.width * zoom) / 2 - bounds.left * zoom,
      panY: (canvas.height - bounds.height * zoom) / 2 - bounds.top * zoom,
    };
    this.applyViewport();
  }

  dispose(): void {
    this.generation += 1;
    this.canvas?.dispose();
    this.canvas = null;
    this.objects.clear();
  }

  private async objectFor(layer: LayerRecord, sourceUrl?: string): Promise<FabricObject | null> {
    if (layer.layer_type === "shape" && layer.shape) {
      const common = { width: layer.transform.width, height: layer.transform.height, fill: layer.shape.fill ?? "transparent", stroke: layer.shape.stroke ?? undefined, strokeWidth: layer.shape.stroke_width ?? 0 };
      return layer.shape.shape === "ellipse"
        ? new Ellipse({ ...common, rx: layer.transform.width / 2, ry: layer.transform.height / 2 })
        : new Rect({ ...common, rx: layer.shape.corner_radius ?? 0, ry: layer.shape.corner_radius ?? 0 });
    }
    if (layer.layer_type === "rich_text" && layer.rich_text) {
      return new Textbox(layer.rich_text.text, {
        width: layer.transform.width,
        fontFamily: layer.rich_text.font_family,
        fontSize: layer.rich_text.font_size,
        fill: layer.rich_text.color,
        textAlign: layer.rich_text.text_align,
      });
    }
    if (layer.layer_type === "vector_svg" && layer.vector?.path_data) {
      return new Rect({ width: layer.transform.width, height: layer.transform.height, fill: layer.vector.fill ?? "transparent", stroke: layer.vector.stroke ?? undefined, strokeWidth: layer.vector.stroke_width ?? 0 });
    }
    if (layer.layer_type === "raster_image" && sourceUrl) {
      const response = await fetch(sourceUrl, { credentials: "same-origin", cache: "no-store" });
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
    return null;
  }

  private configure(object: FabricObject, layer: LayerRecord, offset: { x: number; y: number }) {
    const intrinsicWidth = object.width || layer.transform.width;
    const intrinsicHeight = object.height || layer.transform.height;
    object.set({
      left: offset.x + layer.transform.x,
      top: offset.y + layer.transform.y,
      originX: "left",
      originY: "top",
      angle: layer.transform.rotation_degrees,
      scaleX: (layer.transform.width / intrinsicWidth) * (layer.transform.scale_x ?? 1),
      scaleY: (layer.transform.height / intrinsicHeight) * (layer.transform.scale_y ?? 1),
      flipX: layer.transform.flip_x,
      flipY: layer.transform.flip_y,
      opacity: layer.opacity,
      visible: layer.visible,
      selectable: !layer.locked,
      evented: !layer.locked,
      objectCaching: true,
      cornerColor: "#3559e0",
      borderColor: "#3559e0",
      cornerStyle: "circle",
      transparentCorners: false,
    });
    object.setCoords();
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
    if (!target) return;
    const layer = this.layerByObject.get(target);
    if (!layer) return;
    const offset = this.artboardOffset(layer.artboard_id);
    const transform = renderedToLayerTransform(layer.transform, {
      left: (target.left ?? 0) - offset.x,
      top: (target.top ?? 0) - offset.y,
      angle: target.angle ?? 0,
      scaledWidth: target.getScaledWidth(),
      scaledHeight: target.getScaledHeight(),
      flipX: target.flipX ?? false,
      flipY: target.flipY ?? false,
    });
    this.callbacks?.onTransform(layer.layer_id, transform);
  }

  private snap(target: FabricObject | undefined) {
    if (!target || !this.snapshot) return;
    const layer = this.layerByObject.get(target);
    const artboard = this.snapshot.artboards.find((item) => item.artboard_id === layer?.artboard_id);
    if (!layer || !artboard) return;
    const offset = this.artboardOffset(layer.artboard_id);
    const threshold = 6 / this.viewport.zoom;
    target.set({
      left: offset.x + snapCoordinate((target.left ?? offset.x) - offset.x, [0, artboard.width / 2, artboard.width], threshold),
      top: offset.y + snapCoordinate((target.top ?? offset.y) - offset.y, [0, artboard.height / 2, artboard.height], threshold),
    });
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
      x += artboard.width + ARTBOARD_MARGIN;
    }
    return { x: ARTBOARD_MARGIN, y: ARTBOARD_MARGIN };
  }

  private documentBounds() {
    const artboards = this.snapshot?.artboards ?? [];
    return {
      left: 0,
      top: 0,
      width: Math.max(1, artboards.reduce((total, item) => total + item.width + ARTBOARD_MARGIN, ARTBOARD_MARGIN)),
      height: Math.max(1, ...artboards.map((item) => item.height + ARTBOARD_MARGIN * 2)),
    };
  }

  private requireCanvas(): Canvas {
    if (!this.canvas) throw new Error("Editor renderer is not mounted");
    return this.canvas;
  }
}

function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
