import type { LayerTransform } from "ipw-contracts-ts/product";

export interface RenderedTransform {
  left: number;
  top: number;
  angle: number;
  scaledWidth: number;
  scaledHeight: number;
  flipX: boolean;
  flipY: boolean;
}

export function renderedToLayerTransform(current: LayerTransform, rendered: RenderedTransform): LayerTransform {
  return {
    ...current,
    x: round(rendered.left),
    y: round(rendered.top),
    rotation_degrees: normalAngle(rendered.angle),
    scale_x: positive(round(rendered.scaledWidth / current.width)),
    scale_y: positive(round(rendered.scaledHeight / current.height)),
    flip_x: rendered.flipX,
    flip_y: rendered.flipY,
  };
}

export function snapCoordinate(value: number, candidates: number[], threshold: number): number {
  let closest = value;
  let distance = threshold + 1;
  for (const candidate of candidates) {
    const next = Math.abs(value - candidate);
    if (next <= threshold && next < distance) {
      distance = next;
      closest = candidate;
    }
  }
  return closest;
}

function normalAngle(value: number): number {
  const normalized = ((value % 360) + 360) % 360;
  return round(normalized > 180 ? normalized - 360 : normalized);
}

function positive(value: number): number { return Math.max(0.0001, value); }
function round(value: number): number { return Math.round(value * 1000) / 1000; }
