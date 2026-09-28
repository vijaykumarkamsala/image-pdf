export interface ImageCropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ImageQuarterTurns = 0 | 1 | 2 | 3;
export type ImageCropAspect = "free" | "original" | "1:1" | "4:5" | "16:9";

export interface ImageGeometryRecipe {
  /** Crop coordinates are integer pixels in the immutable original. */
  crop: ImageCropRect;
  /** Clockwise 90-degree turns applied after crop. */
  quarterTurns: ImageQuarterTurns;
  /** Bounded fine rotation, in degrees, applied after the quarter turn. */
  straighten: number;
}

export const MAX_STRAIGHTEN_DEGREES = 15;

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

export function createIdentityGeometry(width: number, height: number): ImageGeometryRecipe {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error("Image geometry requires positive integer source dimensions.");
  }
  return { crop: { x: 0, y: 0, width, height }, quarterTurns: 0, straighten: 0 };
}

export function sanitizeCropRect(
  crop: ImageCropRect,
  sourceWidth: number,
  sourceHeight: number,
  minimumSize = 1,
): ImageCropRect {
  if (!Number.isSafeInteger(sourceWidth) || !Number.isSafeInteger(sourceHeight) || sourceWidth < 1 || sourceHeight < 1) {
    throw new Error("Image geometry requires positive integer source dimensions.");
  }
  const minWidth = Math.min(sourceWidth, Math.max(1, Math.round(minimumSize)));
  const minHeight = Math.min(sourceHeight, Math.max(1, Math.round(minimumSize)));
  const x = clamp(Math.round(Number.isFinite(crop.x) ? crop.x : 0), 0, sourceWidth - minWidth);
  const y = clamp(Math.round(Number.isFinite(crop.y) ? crop.y : 0), 0, sourceHeight - minHeight);
  const width = clamp(Math.round(Number.isFinite(crop.width) ? crop.width : sourceWidth), minWidth, sourceWidth - x);
  const height = clamp(Math.round(Number.isFinite(crop.height) ? crop.height : sourceHeight), minHeight, sourceHeight - y);
  return { x, y, width, height };
}

export function sanitizeGeometryRecipe(
  recipe: ImageGeometryRecipe,
  sourceWidth: number,
  sourceHeight: number,
  minimumCropSize = 1,
): ImageGeometryRecipe {
  const turns = ((Math.round(recipe.quarterTurns) % 4) + 4) % 4 as ImageQuarterTurns;
  return {
    crop: sanitizeCropRect(recipe.crop, sourceWidth, sourceHeight, minimumCropSize),
    quarterTurns: turns,
    straighten: clamp(
      Number.isFinite(recipe.straighten) ? recipe.straighten : 0,
      -MAX_STRAIGHTEN_DEGREES,
      MAX_STRAIGHTEN_DEGREES,
    ),
  };
}

export function rotateGeometry(recipe: ImageGeometryRecipe, direction: -1 | 1): ImageGeometryRecipe {
  return {
    ...recipe,
    quarterTurns: ((recipe.quarterTurns + direction + 4) % 4) as ImageQuarterTurns,
  };
}

export function cropAspectRatio(aspect: ImageCropAspect, sourceWidth: number, sourceHeight: number): number | null {
  if (aspect === "free") return null;
  if (aspect === "original") return sourceWidth / sourceHeight;
  if (aspect === "1:1") return 1;
  if (aspect === "4:5") return 4 / 5;
  return 16 / 9;
}

/** Fits the requested ratio inside the current crop while preserving its centre. */
export function cropToAspect(
  crop: ImageCropRect,
  aspect: ImageCropAspect,
  sourceWidth: number,
  sourceHeight: number,
): ImageCropRect {
  const current = sanitizeCropRect(crop, sourceWidth, sourceHeight);
  const ratio = cropAspectRatio(aspect, sourceWidth, sourceHeight);
  if (ratio === null) return current;
  let width = current.width;
  let height = Math.round(width / ratio);
  if (height > current.height) {
    height = current.height;
    width = Math.round(height * ratio);
  }
  width = clamp(width, 1, sourceWidth);
  height = clamp(height, 1, sourceHeight);
  const centreX = current.x + current.width / 2;
  const centreY = current.y + current.height / 2;
  return sanitizeCropRect({
    x: Math.round(centreX - width / 2),
    y: Math.round(centreY - height / 2),
    width,
    height,
  }, sourceWidth, sourceHeight);
}

export function scaledCropRect(crop: ImageCropRect, scale: number): ImageCropRect {
  if (!Number.isSafeInteger(scale) || scale < 1) throw new Error("Geometry scale must be a positive integer.");
  return {
    x: crop.x * scale,
    y: crop.y * scale,
    width: crop.width * scale,
    height: crop.height * scale,
  };
}

export function geometryOutputDimensions(
  recipe: ImageGeometryRecipe,
  scale = 1,
): { width: number; height: number } {
  const crop = scaledCropRect(recipe.crop, scale);
  return recipe.quarterTurns % 2 === 0
    ? { width: crop.width, height: crop.height }
    : { width: crop.height, height: crop.width };
}

/** Scale required to rotate without exposing empty corners in the fixed output frame. */
export function straightenCoverScale(width: number, height: number, degrees: number): number {
  const radians = Math.abs(degrees) * Math.PI / 180;
  const cosine = Math.abs(Math.cos(radians));
  const sine = Math.abs(Math.sin(radians));
  return Math.max(
    (width * cosine + height * sine) / width,
    (width * sine + height * cosine) / height,
  );
}

export function isIdentityGeometry(recipe: ImageGeometryRecipe, sourceWidth: number, sourceHeight: number): boolean {
  const safe = sanitizeGeometryRecipe(recipe, sourceWidth, sourceHeight);
  return safe.crop.x === 0 && safe.crop.y === 0
    && safe.crop.width === sourceWidth && safe.crop.height === sourceHeight
    && safe.quarterTurns === 0 && Math.abs(safe.straighten) < 0.0001;
}

export function sameGeometry(left: ImageGeometryRecipe | null, right: ImageGeometryRecipe): boolean {
  return Boolean(left
    && left.crop.x === right.crop.x && left.crop.y === right.crop.y
    && left.crop.width === right.crop.width && left.crop.height === right.crop.height
    && left.quarterTurns === right.quarterTurns
    && Math.abs(left.straighten - right.straighten) < 0.0001);
}
