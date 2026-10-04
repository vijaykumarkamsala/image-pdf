export const IMAGE_PROTECTED_COLOR_KINDS = ["brand", "product", "skin-critical"] as const;

export type ImageProtectedColorKind = typeof IMAGE_PROTECTED_COLOR_KINDS[number];

export interface ImageProtectedColorAnchor {
  enabled: boolean;
  kind: ImageProtectedColorKind;
  sourceX: number;
  sourceY: number;
  radius: number;
  visiblePixels: number;
  red: number;
  green: number;
  blue: number;
  hue: number;
  saturation: number;
  lightness: number;
  /** Full-protection circular hue distance in degrees. */
  tolerance: number;
  /** Additional smooth hue-transition width in degrees. */
  feather: number;
  /** Maximum blend-back to the immutable pre-colour pixel. */
  strength: number;
  /** Exact verified pre-colour derivative from which this anchor was sampled. */
  sourceBaseSha256: string;
}

export interface ProtectedColorSampleInput {
  sourceX: number;
  sourceY: number;
  radius: number;
  visiblePixels: number;
  red: number;
  green: number;
  blue: number;
  hue: number;
  saturation: number;
  lightness: number;
}

export const MAX_PROTECTED_COLOR_ANCHORS = 3;

const hash = /^[a-f0-9]{64}$/;
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const boundedInteger = (value: unknown, minimum: number, maximum: number, fallback: number) => {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.round(clamp(numeric, minimum, maximum));
};

function isKind(value: unknown): value is ImageProtectedColorKind {
  return typeof value === "string" && IMAGE_PROTECTED_COLOR_KINDS.includes(value as ImageProtectedColorKind);
}

function sanitizeAnchor(value: unknown): ImageProtectedColorAnchor | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ImageProtectedColorAnchor>;
  if (!hash.test(candidate.sourceBaseSha256 ?? "")) return null;
  const radius = boundedInteger(candidate.radius, 1, 8, 1);
  return {
    enabled: candidate.enabled === true,
    kind: isKind(candidate.kind) ? candidate.kind : "brand",
    sourceX: boundedInteger(candidate.sourceX, 0, Number.MAX_SAFE_INTEGER, 0),
    sourceY: boundedInteger(candidate.sourceY, 0, Number.MAX_SAFE_INTEGER, 0),
    radius,
    visiblePixels: boundedInteger(candidate.visiblePixels, 1, (radius * 2 + 1) ** 2, 1),
    red: boundedInteger(candidate.red, 0, 255, 0),
    green: boundedInteger(candidate.green, 0, 255, 0),
    blue: boundedInteger(candidate.blue, 0, 255, 0),
    hue: boundedInteger(candidate.hue, 0, 359, 0),
    saturation: boundedInteger(candidate.saturation, 0, 100, 0),
    lightness: boundedInteger(candidate.lightness, 0, 100, 0),
    tolerance: boundedInteger(candidate.tolerance, 5, 60, 12),
    feather: boundedInteger(candidate.feather, 1, 60, 18),
    strength: boundedInteger(candidate.strength, 0, 100, 100),
    sourceBaseSha256: candidate.sourceBaseSha256!,
  };
}

export function sanitizeProtectedColors(value: unknown): ImageProtectedColorAnchor[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_PROTECTED_COLOR_ANCHORS)
    .map(sanitizeAnchor)
    .filter((anchor): anchor is ImageProtectedColorAnchor => anchor !== null);
}

export function createProtectedColorAnchor(
  sample: ProtectedColorSampleInput,
  kind: ImageProtectedColorKind,
  sourceBaseSha256: string,
): ImageProtectedColorAnchor {
  const [anchor] = sanitizeProtectedColors([{
    ...sample,
    enabled: true,
    kind,
    tolerance: 12,
    feather: 18,
    strength: 100,
    sourceBaseSha256,
  }]);
  if (!anchor) throw new Error("Protected colour requires a valid source-bound sample.");
  return anchor;
}

export function sameProtectedColors(left: unknown, right: unknown): boolean {
  return JSON.stringify(sanitizeProtectedColors(left)) === JSON.stringify(sanitizeProtectedColors(right));
}

export function areProtectedColorsSanitized(value: unknown): value is ImageProtectedColorAnchor[] {
  return Array.isArray(value)
    && value.length <= MAX_PROTECTED_COLOR_ANCHORS
    && JSON.stringify(value) === JSON.stringify(sanitizeProtectedColors(value));
}

function smoothstep(edge0: number, edge1: number, value: number) {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const position = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return position * position * (3 - 2 * position);
}

function circularHueDistance(left: number, right: number) {
  const distance = Math.abs(left - right) % 360;
  return Math.min(distance, 360 - distance);
}

function rgbToHsl(red: number, green: number, blue: number) {
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const chroma = maximum - minimum;
  const lightness = (maximum + minimum) / 2;
  if (chroma === 0) return { hue: 0, saturation: 0, lightness };
  const saturation = chroma / (1 - Math.abs(2 * lightness - 1));
  const segment = maximum === red
    ? ((green - blue) / chroma) % 6
    : maximum === green
      ? (blue - red) / chroma + 2
      : (red - green) / chroma + 4;
  return { hue: (segment * 60 + 360) % 360, saturation, lightness };
}

/**
 * Returns a bounded union mask for reviewed source colours. Hue is primary;
 * saturation and lightness similarity stop one sample from protecting every
 * object in the same broad hue family. Multiple anchors use max/union rather
 * than additive strength, so overlap can never exceed 100%.
 */
export function protectedColorWeight(
  red: number,
  green: number,
  blue: number,
  anchors: ImageProtectedColorAnchor[],
): number {
  const hsl = rgbToHsl(red / 255, green / 255, blue / 255);
  const hueConfidence = clamp((hsl.saturation - 0.02) / 0.08, 0, 1);
  if (hueConfidence === 0) return 0;
  let union = 0;
  for (const anchor of anchors) {
    if (!anchor.enabled || anchor.strength === 0) continue;
    const hueDistance = circularHueDistance(hsl.hue, anchor.hue);
    const hueWeight = 1 - smoothstep(anchor.tolerance, anchor.tolerance + anchor.feather, hueDistance);
    const saturationDistance = Math.abs(hsl.saturation - anchor.saturation / 100);
    const saturationWeight = 1 - smoothstep(0.1, 0.35, saturationDistance);
    const lightnessDistance = Math.abs(hsl.lightness - anchor.lightness / 100);
    const lightnessWeight = 1 - smoothstep(0.1, 0.3, lightnessDistance);
    union = Math.max(
      union,
      hueConfidence * hueWeight * saturationWeight * lightnessWeight * (anchor.strength / 100),
    );
  }
  return clamp(union, 0, 1);
}
