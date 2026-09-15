export interface ViewerGeometry {
  frameWidth: number;
  frameHeight: number;
  imageWidth: number;
  imageHeight: number;
  scale: number;
}

export function clampViewerPan(
  geometry: ViewerGeometry,
  pan: { x: number; y: number },
): { x: number; y: number } {
  const horizontal = Math.max(0, (geometry.imageWidth * geometry.scale - geometry.frameWidth) / 2);
  const vertical = Math.max(0, (geometry.imageHeight * geometry.scale - geometry.frameHeight) / 2);
  return {
    x: horizontal === 0 ? 0 : Math.max(-horizontal, Math.min(horizontal, pan.x)),
    y: vertical === 0 ? 0 : Math.max(-vertical, Math.min(vertical, pan.y)),
  };
}
