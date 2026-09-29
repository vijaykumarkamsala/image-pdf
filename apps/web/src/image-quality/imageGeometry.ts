export interface ImageCropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ImageQuarterTurns = 0 | 1 | 2 | 3;
export type ImageCropAspect = "free" | "original" | "1:1" | "4:5" | "16:9";

export interface ImageResizeTarget {
  width: number;
  height: number;
}

export interface ImagePerspectivePoint {
  /** Normalized post-crop coordinate in the inclusive 0..1 range. */
  x: number;
  y: number;
}

export interface ImagePerspectiveQuad {
  topLeft: ImagePerspectivePoint;
  topRight: ImagePerspectivePoint;
  bottomRight: ImagePerspectivePoint;
  bottomLeft: ImagePerspectivePoint;
}

export interface PerspectiveTransform {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  g: number;
  h: number;
}

export interface ImageGeometryRecipe {
  /** Crop coordinates are integer pixels in the immutable original. */
  crop: ImageCropRect;
  /** Clockwise 90-degree turns applied after crop. */
  quarterTurns: ImageQuarterTurns;
  /** Bounded fine rotation, in degrees, applied after the quarter turn. */
  straighten: number;
  /** Source-coordinate flips applied after crop and before rotation. */
  flipHorizontal: boolean;
  flipVertical: boolean;
  /** Four-corner source sampling quad, normalized inside the crop. */
  perspective: ImagePerspectiveQuad | null;
  /** Absolute final PNG dimensions. Null preserves the post-crop natural size. */
  resize: ImageResizeTarget | null;
}

export const MAX_STRAIGHTEN_DEGREES = 15;
export const MAX_BROWSER_PERSPECTIVE_PIXELS = 16_777_216;

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

export function assertBrowserPerspectiveBudget(width: number, height: number): number {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error("Perspective correction requires positive integer working dimensions.");
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > MAX_BROWSER_PERSPECTIVE_PIXELS) {
    throw new Error(
      `Perspective correction requires ${pixels.toLocaleString("en-US")} working pixels, beyond this browser's ${MAX_BROWSER_PERSPECTIVE_PIXELS.toLocaleString("en-US")}-pixel safety budget. No uncorrected substitute was created.`,
    );
  }
  return pixels;
}

export function createIdentityGeometry(width: number, height: number): ImageGeometryRecipe {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error("Image geometry requires positive integer source dimensions.");
  }
  return {
    crop: { x: 0, y: 0, width, height },
    quarterTurns: 0,
    straighten: 0,
    flipHorizontal: false,
    flipVertical: false,
    perspective: null,
    resize: null,
  };
}

export function createIdentityPerspective(): ImagePerspectiveQuad {
  return {
    topLeft: { x: 0, y: 0 },
    topRight: { x: 1, y: 0 },
    bottomRight: { x: 1, y: 1 },
    bottomLeft: { x: 0, y: 1 },
  };
}

const perspectiveBounds: Record<keyof ImagePerspectiveQuad, { minX: number; maxX: number; minY: number; maxY: number }> = {
  topLeft: { minX: 0, maxX: 0.3, minY: 0, maxY: 0.3 },
  topRight: { minX: 0.7, maxX: 1, minY: 0, maxY: 0.3 },
  bottomRight: { minX: 0.7, maxX: 1, minY: 0.7, maxY: 1 },
  bottomLeft: { minX: 0, maxX: 0.3, minY: 0.7, maxY: 1 },
};

export function sanitizePerspectiveQuad(quad: ImagePerspectiveQuad): ImagePerspectiveQuad {
  const identity = createIdentityPerspective();
  const sanitizePoint = (corner: keyof ImagePerspectiveQuad): ImagePerspectivePoint => {
    const point = quad[corner] ?? identity[corner];
    const bounds = perspectiveBounds[corner];
    return {
      x: clamp(Number.isFinite(point.x) ? point.x : identity[corner].x, bounds.minX, bounds.maxX),
      y: clamp(Number.isFinite(point.y) ? point.y : identity[corner].y, bounds.minY, bounds.maxY),
    };
  };
  return {
    topLeft: sanitizePoint("topLeft"),
    topRight: sanitizePoint("topRight"),
    bottomRight: sanitizePoint("bottomRight"),
    bottomLeft: sanitizePoint("bottomLeft"),
  };
}

export function perspectiveIsIdentity(quad: ImagePerspectiveQuad | null, epsilon = 0.000001): boolean {
  if (!quad) return true;
  const safe = sanitizePerspectiveQuad(quad);
  const identity = createIdentityPerspective();
  return (Object.keys(identity) as Array<keyof ImagePerspectiveQuad>).every((corner) => (
    Math.abs(safe[corner].x - identity[corner].x) <= epsilon
    && Math.abs(safe[corner].y - identity[corner].y) <= epsilon
  ));
}

/** Projective mapping from the unit output rectangle into the selected source quadrilateral. */
export function perspectiveTransform(quad: ImagePerspectiveQuad): PerspectiveTransform {
  const safe = sanitizePerspectiveQuad(quad);
  const p0 = safe.topLeft;
  const p1 = safe.topRight;
  const p2 = safe.bottomRight;
  const p3 = safe.bottomLeft;
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const dy3 = p0.y - p1.y + p2.y - p3.y;
  const denominator = dx1 * dy2 - dx2 * dy1;
  const g = Math.abs(dx3) < 1e-12 && Math.abs(dy3) < 1e-12
    ? 0
    : (dx3 * dy2 - dx2 * dy3) / denominator;
  const h = Math.abs(dx3) < 1e-12 && Math.abs(dy3) < 1e-12
    ? 0
    : (dx1 * dy3 - dx3 * dy1) / denominator;
  const denominators = [1, 1 + g, 1 + h, 1 + g + h];
  if (![g, h].every(Number.isFinite) || denominators.some((value) => !Number.isFinite(value) || value <= 0.1)) {
    throw new Error("Perspective corners do not form a stable quadrilateral.");
  }
  return {
    a: p1.x - p0.x + g * p1.x,
    b: p3.x - p0.x + h * p3.x,
    c: p0.x,
    d: p1.y - p0.y + g * p1.y,
    e: p3.y - p0.y + h * p3.y,
    f: p0.y,
    g,
    h,
  };
}

export function mapPerspectivePoint(transform: PerspectiveTransform, x: number, y: number): ImagePerspectivePoint {
  const denominator = transform.g * x + transform.h * y + 1;
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-12) {
    throw new Error("Perspective mapping became numerically unstable.");
  }
  return {
    x: (transform.a * x + transform.b * y + transform.c) / denominator,
    y: (transform.d * x + transform.e * y + transform.f) / denominator,
  };
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
  const resize = recipe.resize === null || recipe.resize === undefined
    ? null
    : {
      width: Math.max(1, Math.round(Number.isFinite(recipe.resize.width) ? recipe.resize.width : 1)),
      height: Math.max(1, Math.round(Number.isFinite(recipe.resize.height) ? recipe.resize.height : 1)),
    };
  return {
    crop: sanitizeCropRect(recipe.crop, sourceWidth, sourceHeight, minimumCropSize),
    quarterTurns: turns,
    straighten: clamp(
      Number.isFinite(recipe.straighten) ? recipe.straighten : 0,
      -MAX_STRAIGHTEN_DEGREES,
      MAX_STRAIGHTEN_DEGREES,
    ),
    flipHorizontal: recipe.flipHorizontal === true,
    flipVertical: recipe.flipVertical === true,
    perspective: recipe.perspective ? sanitizePerspectiveQuad(recipe.perspective) : null,
    resize,
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

export function geometryNaturalDimensions(
  recipe: ImageGeometryRecipe,
  scale = 1,
): { width: number; height: number } {
  const crop = scaledCropRect(recipe.crop, scale);
  return recipe.quarterTurns % 2 === 0
    ? { width: crop.width, height: crop.height }
    : { width: crop.height, height: crop.width };
}

export function geometryOutputDimensions(
  recipe: ImageGeometryRecipe,
  scale = 1,
): { width: number; height: number } {
  if (recipe.resize) return { width: recipe.resize.width, height: recipe.resize.height };
  return geometryNaturalDimensions(recipe, scale);
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
    && safe.quarterTurns === 0 && Math.abs(safe.straighten) < 0.0001
    && !safe.flipHorizontal && !safe.flipVertical
    && perspectiveIsIdentity(safe.perspective)
    && (!safe.resize || (safe.resize.width === sourceWidth && safe.resize.height === sourceHeight));
}

export function sameGeometry(left: ImageGeometryRecipe | null, right: ImageGeometryRecipe): boolean {
  return Boolean(left
    && left.crop.x === right.crop.x && left.crop.y === right.crop.y
    && left.crop.width === right.crop.width && left.crop.height === right.crop.height
    && left.quarterTurns === right.quarterTurns
    && Math.abs(left.straighten - right.straighten) < 0.0001
    && left.flipHorizontal === right.flipHorizontal
    && left.flipVertical === right.flipVertical
    && ((!left.perspective && !right.perspective)
      || Boolean(left.perspective && right.perspective
        && (Object.keys(left.perspective) as Array<keyof ImagePerspectiveQuad>).every((corner) => (
          Math.abs(left.perspective![corner].x - right.perspective![corner].x) < 0.000001
          && Math.abs(left.perspective![corner].y - right.perspective![corner].y) < 0.000001
        ))))
    && ((!left.resize && !right.resize)
      || Boolean(left.resize && right.resize
        && left.resize.width === right.resize.width
        && left.resize.height === right.resize.height)));
}
