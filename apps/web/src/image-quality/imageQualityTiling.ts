export interface ImageQualityTile {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function planImageQualityTiles(width: number, height: number, coreSize: number): ImageQualityTile[] {
  if (![width, height, coreSize].every((value) => Number.isInteger(value) && value > 0)) {
    throw new Error("Tile dimensions must be positive integers.");
  }
  const tiles: ImageQualityTile[] = [];
  for (let top = 0; top < height; top += coreSize) {
    for (let left = 0; left < width; left += coreSize) {
      tiles.push({
        left,
        top,
        width: Math.min(coreSize, width - left),
        height: Math.min(coreSize, height - top),
      });
    }
  }
  return tiles;
}
