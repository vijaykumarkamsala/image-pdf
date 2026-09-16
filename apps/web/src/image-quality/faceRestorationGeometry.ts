import type { FaceDetailRegion } from "./faceDetailRestoration.ts";

export type FacePoint = readonly [number, number];
export type FaceTransform = readonly [number, number, number, number];
export interface DetectedFace { box: FaceDetailRegion; landmarks: FacePoint[]; confidence: number }
export const FACE_TEMPLATE: readonly FacePoint[] = [
  [192.98138, 239.94708], [318.90277, 240.19360], [256.63416, 314.01935],
  [201.26117, 371.41043], [313.08905, 371.15118],
];
export const DETECTOR_EDGE = 640;
export const ALIGNED_FACE_EDGE = 512;

export function faceCandidateFidelities(fidelity: number, count: 2 | 3): number[] {
  if (!Number.isFinite(fidelity) || fidelity < 0 || fidelity > 1 || (count !== 2 && count !== 3)) throw new Error("Invalid face candidate fidelity/count.");
  if (fidelity === 0) return count === 3 ? [0, 0.15, 0.3] : [0, 0.15];
  if (fidelity === 1) return count === 3 ? [0.7, 0.85, 1] : [0.85, 1];
  return count === 3 ? [Math.max(0, fidelity - 0.15), fidelity, Math.min(1, fidelity + 0.2)]
    : [Math.max(0, fidelity - 0.15), Math.min(1, fidelity + 0.15)];
}

/** Uniform scale/rotation/translation only. Never shear or stretch a face. */
export function faceSimilarityTransform(points: readonly FacePoint[], target = FACE_TEMPLATE): FaceTransform {
  if (points.length !== 5 || target.length !== 5 || [...points, ...target].some((p) => p.length !== 2 || !p.every(Number.isFinite))) throw new Error("Five finite face landmarks are required.");
  const mean = (values: readonly FacePoint[], axis: number) => values.reduce((sum, point) => sum + point[axis], 0) / 5;
  const sx = mean(points, 0), sy = mean(points, 1), tx = mean(target, 0), ty = mean(target, 1);
  let denominator = 0, real = 0, imaginary = 0;
  for (let i = 0; i < 5; i += 1) {
    const x = points[i][0] - sx, y = points[i][1] - sy, u = target[i][0] - tx, v = target[i][1] - ty;
    denominator += x * x + y * y; real += x * u + y * v; imaginary += x * v - y * u;
  }
  if (denominator < 1e-12) throw new Error("Coincident face landmarks cannot be aligned.");
  const a = real / denominator, b = imaginary / denominator;
  if (a * a + b * b < 1e-12) throw new Error("Face alignment is singular.");
  return [a, b, tx - a * sx + b * sy, ty - b * sx - a * sy];
}

export function transformFacePoint([a, b, tx, ty]: FaceTransform, x: number, y: number): FacePoint {
  return [a * x - b * y + tx, b * x + a * y + ty];
}

export function inverseFaceTransform([a, b, tx, ty]: FaceTransform): FaceTransform {
  const denominator = a * a + b * b;
  if (!Number.isFinite(denominator) || denominator < 1e-12) throw new Error("Face alignment is singular.");
  return [a / denominator, -b / denominator, (-a * tx - b * ty) / denominator, (b * tx - a * ty) / denominator];
}

function sample(pixels: Uint8ClampedArray, width: number, height: number, x: number, y: number, channel: number) {
  x = Math.max(0, Math.min(width - 1, x)); y = Math.max(0, Math.min(height - 1, y));
  const left = Math.floor(x), top = Math.floor(y), right = Math.min(width - 1, left + 1), bottom = Math.min(height - 1, top + 1);
  const dx = x - left, dy = y - top;
  const at = (xx: number, yy: number) => pixels[(yy * width + xx) * 4 + channel];
  return (at(left, top) * (1 - dx) + at(right, top) * dx) * (1 - dy)
    + (at(left, bottom) * (1 - dx) + at(right, bottom) * dx) * dy;
}

/** Full overview + overlapping native-scale tiles: no manual crop or landmarks. */
export function faceDetectionWindows(width: number, height: number): FaceDetailRegion[] {
  if (![width, height].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error("Invalid detector dimensions.");
  const overview = { x: 0, y: 0, width, height };
  if (Math.max(width, height) <= DETECTOR_EDGE) return [overview];
  const steps = (size: number) => Math.ceil(Math.max(0, size - DETECTOR_EDGE) / 512) + 1;
  if (steps(width) * steps(height) + 1 > 32) throw new Error("This image needs the future server-side face detector. No partial face scan or resize was substituted.");
  const positions = (size: number) => {
    if (size <= DETECTOR_EDGE) return [0];
    const points = [0];
    while (points.at(-1)! + DETECTOR_EDGE < size) points.push(Math.min(size - DETECTOR_EDGE, points.at(-1)! + 512));
    return points;
  };
  const xs = positions(width), ys = positions(height);
  if (xs.length * ys.length + 1 > 32) throw new Error("This image needs the future server-side face detector. No partial face scan or resize was substituted.");
  return [overview, ...ys.flatMap((y) => xs.map((x) => ({ x, y, width: Math.min(width, DETECTOR_EDGE), height: Math.min(height, DETECTOR_EDGE) })))];
}

/** Detector preprocessing only. Source pixels stay immutable and restoration uses native pixels. */
export function faceDetectorTensor(pixels: Uint8ClampedArray, width: number, height: number, window: FaceDetailRegion) {
  if (!(pixels instanceof Uint8ClampedArray) || pixels.length !== width * height * 4
    || ![window.x, window.y, window.width, window.height].every(Number.isSafeInteger) || window.width <= 0 || window.height <= 0
    || window.x < 0 || window.y < 0 || window.x + window.width > width || window.y + window.height > height) throw new Error("Detector window must fit decoded source pixels.");
  const scale = Math.min(DETECTOR_EDGE / window.width, DETECTOR_EDGE / window.height);
  const plane = DETECTOR_EDGE * DETECTOR_EDGE, data = new Float32Array(plane * 3);
  for (let y = 0; y < DETECTOR_EDGE; y += 1) for (let x = 0; x < DETECTOR_EDGE; x += 1) {
    if (x + 0.5 > window.width * scale || y + 0.5 > window.height * scale) continue;
    const sx = window.x + (x + 0.5) / scale - 0.5, sy = window.y + (y + 0.5) / scale - 0.5;
    for (let channel = 0; channel < 3; channel += 1) data[channel * plane + y * DETECTOR_EDGE + x] = sample(pixels, width, height, sx, sy, 2 - channel);
  }
  return { data, scale };
}

/** YuNet 2023mar heads, following OpenCV 4.12's published decoding convention. */
export function decodeYuNet(outputs: Record<string, Float32Array>, window: FaceDetailRegion, threshold = 0.85): DetectedFace[] {
  const scale = Math.min(DETECTOR_EDGE / window.width, DETECTOR_EDGE / window.height), faces: DetectedFace[] = [];
  for (const stride of [8, 16, 32]) {
    const columns = DETECTOR_EDGE / stride, count = columns * columns;
    const cls = outputs[`cls_${stride}`], obj = outputs[`obj_${stride}`], bbox = outputs[`bbox_${stride}`], kps = outputs[`kps_${stride}`];
    for (const [head, channels] of [[cls, 1], [obj, 1], [bbox, 4], [kps, 10]] as const) {
      if (!(head instanceof Float32Array) || head.length !== count * channels || !head.every(Number.isFinite)) throw new Error("Face detector returned an invalid prediction head.");
    }
    for (let i = 0; i < count; i += 1) {
      const confidence = Math.sqrt(Math.max(0, Math.min(1, cls[i])) * Math.max(0, Math.min(1, obj[i])));
      if (confidence < threshold) continue;
      const column = i % columns, row = Math.floor(i / columns);
      const w = Math.exp(bbox[i * 4 + 2]) * stride / scale, h = Math.exp(bbox[i * 4 + 3]) * stride / scale;
      const cx = window.x + (column + bbox[i * 4]) * stride / scale, cy = window.y + (row + bbox[i * 4 + 1]) * stride / scale;
      const landmarks = Array.from({ length: 5 }, (_, n): FacePoint => [
        window.x + (column + kps[i * 10 + n * 2]) * stride / scale,
        window.y + (row + kps[i * 10 + n * 2 + 1]) * stride / scale,
      ]);
      if (![w, h, cx, cy].every(Number.isFinite) || w < 24 || h < 24 || w > window.width * 2 || h > window.height * 2
        || landmarks.some(([x, y]) => x < window.x || y < window.y || x >= window.x + window.width || y >= window.y + window.height)) continue;
      faces.push({ box: { x: cx - w / 2, y: cy - h / 2, width: w, height: h }, landmarks, confidence });
    }
  }
  return faces;
}

export function suppressDuplicateFaces(faces: DetectedFace[]): DetectedFace[] {
  const kept: DetectedFace[] = [];
  for (const face of faces.slice().sort((a, b) => b.confidence - a.confidence)) {
    if (kept.some((other) => {
      const a = face.box, b = other.box;
      const intersection = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
        * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
      return intersection / (a.width * a.height + b.width * b.height - intersection) > 0.3;
    })) continue;
    kept.push(face);
  }
  return kept;
}

export function validatedFaceAlignment(face: DetectedFace): FaceTransform {
  const transform = faceSimilarityTransform(face.landmarks);
  if (Math.hypot(face.landmarks[1][0] - face.landmarks[0][0], face.landmarks[1][1] - face.landmarks[0][1]) < 8) throw new Error("This face is too small for trustworthy automatic alignment.");
  const error = Math.sqrt(face.landmarks.reduce((sum, [x, y], i) => {
    const [u, v] = transformFacePoint(transform, x, y);
    return sum + (u - FACE_TEMPLATE[i][0]) ** 2 + (v - FACE_TEMPLATE[i][1]) ** 2;
  }, 0) / 5);
  if (error > 24) throw new Error("Face landmarks are uncertain. No restoration candidate was generated.");
  return transform;
}

export function alignedFacePixels(pixels: Uint8ClampedArray, width: number, height: number, transform: FaceTransform) {
  const inverse = inverseFaceTransform(transform), edge = ALIGNED_FACE_EDGE, output = new Uint8ClampedArray(edge * edge * 4);
  for (let y = 0; y < edge; y += 1) for (let x = 0; x < edge; x += 1) {
    const [sx, sy] = transformFacePoint(inverse, x, y);
    for (let channel = 0; channel < 3; channel += 1) output[(y * edge + x) * 4 + channel] = sample(pixels, width, height, sx, sy, channel);
    output[(y * edge + x) * 4 + 3] = 255;
  }
  return output;
}

/** Conservative geometric support, not a semantic parser or identity proof. */
export function inverseAlignedFacePatch(aligned: Uint8ClampedArray, transform: FaceTransform, outputWidth: number, outputHeight: number, scale: number) {
  if (aligned.length !== ALIGNED_FACE_EDGE ** 2 * 4 || !Number.isFinite(scale) || scale <= 0) throw new Error("Invalid aligned face pixels or source/output scale.");
  const inverse = inverseFaceTransform(transform), [cx, cy] = transformFacePoint(inverse, 256, 309);
  const radiusX = Math.hypot(inverse[0] * 148, inverse[1] * 168), radiusY = Math.hypot(inverse[1] * 148, inverse[0] * 168);
  const x = Math.max(0, Math.floor((cx - radiusX + 0.5) * scale - 0.5));
  const y = Math.max(0, Math.floor((cy - radiusY + 0.5) * scale - 0.5));
  const right = Math.min(outputWidth, Math.ceil((cx + radiusX + 0.5) * scale - 0.5) + 1);
  const bottom = Math.min(outputHeight, Math.ceil((cy + radiusY + 0.5) * scale - 0.5) + 1);
  const region = { x, y, width: right - x, height: bottom - y };
  if (region.width <= 0 || region.height <= 0 || region.width * region.height > 4_000_000) throw new Error("This face patch needs the future native face renderer.");
  const pixels = new Uint8ClampedArray(region.width * region.height * 4), mask = new Uint8Array(region.width * region.height);
  for (let row = 0; row < region.height; row += 1) for (let column = 0; column < region.width; column += 1) {
    const [u, v] = transformFacePoint(transform, (x + column + 0.5) / scale - 0.5, (y + row + 0.5) / scale - 0.5);
    const radius = Math.hypot((u - 256) / 148, (v - 309) / 168), index = row * region.width + column;
    if (radius >= 1 || u < 0 || v < 0 || u >= 512 || v >= 512) continue;
    const weight = Math.min(1, (1 - radius) / 0.08);
    mask[index] = Math.round(255 * weight * weight * (3 - 2 * weight));
    for (let channel = 0; channel < 3; channel += 1) pixels[index * 4 + channel] = sample(aligned, 512, 512, u, v, channel);
    pixels[index * 4 + 3] = 255;
  }
  return { region, pixels, mask };
}
