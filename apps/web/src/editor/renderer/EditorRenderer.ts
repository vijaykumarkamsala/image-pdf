import type { EditorDocumentSnapshot, LayerTransform } from "ipw-contracts-ts/product";

export interface RendererViewport {
  zoom: number;
  panX: number;
  panY: number;
}

export interface EditorRendererCallbacks {
  onSelection(layerId: string | null): void;
  onTransform(layerId: string, transform: LayerTransform): void;
  onViewport(viewport: RendererViewport): void;
  onSnap(guides: { x: number | null; y: number | null } | null): void;
}

export interface EditorRenderer {
  mount(element: HTMLCanvasElement, callbacks: EditorRendererCallbacks): void;
  render(snapshot: EditorDocumentSnapshot, assetSource?: string | ((sharedAssetId: string) => string)): Promise<void>;
  resize(width: number, height: number): void;
  select(layerId: string | null): void;
  setReadOnly(readOnly: boolean): void;
  zoomBy(factor: number): void;
  fit(): void;
  fitArtboard(artboardId: string): void;
  dispose(): void;
}
