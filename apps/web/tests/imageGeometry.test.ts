import assert from "node:assert/strict";
import test from "node:test";

import {
  createIdentityGeometry,
  cropToAspect,
  geometryNaturalDimensions,
  geometryOutputDimensions,
  isIdentityGeometry,
  rotateGeometry,
  sameGeometry,
  sanitizeCropRect,
  sanitizeGeometryRecipe,
  scaledCropRect,
  straightenCoverScale,
} from "../src/image-quality/imageGeometry.ts";
import { inspectPngDimensions, tagGeometryPng } from "../src/image-quality/pngMetadata.ts";

function framedPng(width: number, height: number) {
  const bytes = new Uint8Array(45);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13, false);
  bytes.set([73, 72, 68, 82], 12);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  bytes[24] = 8;
  bytes[25] = 6;
  view.setUint32(33, 0, false);
  bytes.set([73, 69, 78, 68], 37);
  return bytes;
}

test("geometry recipe remains source-bound and produces exact scaled dimensions", () => {
  const source = createIdentityGeometry(659, 710);
  assert.equal(isIdentityGeometry(source, 659, 710), true);

  const crop = sanitizeGeometryRecipe({
    crop: { x: 31, y: 45, width: 600, height: 640 },
    quarterTurns: 0,
    straighten: 4.5,
    flipHorizontal: false,
    flipVertical: false,
    resize: null,
  }, 659, 710);
  assert.deepEqual(geometryOutputDimensions(crop), { width: 600, height: 640 });
  assert.deepEqual(geometryOutputDimensions(crop, 4), { width: 2400, height: 2560 });
  assert.deepEqual(scaledCropRect(crop.crop, 4), { x: 124, y: 180, width: 2400, height: 2560 });

  const rotated = rotateGeometry(crop, 1);
  assert.deepEqual(geometryOutputDimensions(rotated, 4), { width: 2560, height: 2400 });
  assert.equal(sameGeometry(crop, rotated), false);
  assert.deepEqual(crop, sanitizeGeometryRecipe(crop, 659, 710), "sanitising a valid recipe must be deterministic");
});

test("flip state and exact resize are deterministic and resize is independent of base scale", () => {
  const recipe = sanitizeGeometryRecipe({
    ...createIdentityGeometry(659, 710),
    flipHorizontal: true,
    resize: { width: 2636, height: 2840 },
  }, 659, 710);
  assert.deepEqual(geometryNaturalDimensions(recipe), { width: 659, height: 710 });
  assert.deepEqual(geometryNaturalDimensions(recipe, 4), { width: 2636, height: 2840 });
  assert.deepEqual(geometryOutputDimensions(recipe), { width: 2636, height: 2840 });
  assert.deepEqual(geometryOutputDimensions(recipe, 4), { width: 2636, height: 2840 });
  assert.equal(isIdentityGeometry(recipe, 659, 710), false);
  assert.equal(sameGeometry(recipe, { ...recipe, flipHorizontal: false }), false);
  assert.deepEqual(recipe, sanitizeGeometryRecipe(recipe, 659, 710));
});

test("crop constraints and aspect presets stay inside the immutable source", () => {
  assert.deepEqual(
    sanitizeCropRect({ x: -90, y: 690, width: 900, height: 2 }, 659, 710, 32),
    { x: 0, y: 678, width: 659, height: 32 },
  );
  const square = cropToAspect({ x: 20, y: 30, width: 600, height: 640 }, "1:1", 659, 710);
  assert.equal(square.width, square.height);
  assert.ok(square.x >= 0 && square.y >= 0);
  assert.ok(square.x + square.width <= 659 && square.y + square.height <= 710);
  const portrait = cropToAspect(square, "4:5", 659, 710);
  assert.ok(Math.abs(portrait.width / portrait.height - 4 / 5) < 0.01);
});

test("straighten cover scale is neutral at zero and prevents uncovered corners", () => {
  assert.equal(straightenCoverScale(1200, 800, 0), 1);
  const cover = straightenCoverScale(1200, 800, 15);
  assert.ok(cover > 1 && cover < 1.5);
  assert.equal(cover, straightenCoverScale(1200, 800, -15));
});

test("geometry PNG tagging preserves exact bytes dimensions and records the source-bound recipe", () => {
  const sourceHash = "a".repeat(64);
  const baseHash = "b".repeat(64);
  const tagged = tagGeometryPng(framedPng(2400, 2560), {
    sourceSha256: sourceHash,
    baseOutputSha256: baseHash,
    baseKind: "enhanced",
    baseRoute: "photograph-production-x4",
    baseStrength: 50,
    baseScale: 4,
    crop: { x: 31, y: 45, width: 600, height: 640 },
    quarterTurns: 0,
    straighten: 4.5,
    flipHorizontal: true,
    flipVertical: false,
    resize: { width: 2400, height: 2560 },
    outputWidth: 2400,
    outputHeight: 2560,
  });
  assert.deepEqual(inspectPngDimensions(tagged), { width: 2400, height: 2560 });
  const text = new TextDecoder().decode(tagged);
  assert.match(text, /ipw\.image-edit\.geometry\.provenance\.v1/);
  assert.match(text, /"operation_order":\["crop","flip","quarter_turn","straighten","resize"\]/);
  assert.match(text, /"flip_horizontal":true/);
  assert.match(text, /"resize":\{"width":2400,"height":2560\}/);
  assert.match(text, new RegExp(sourceHash));
  assert.throws(() => tagGeometryPng(framedPng(1200, 1280), {
    sourceSha256: sourceHash,
    baseOutputSha256: baseHash,
    baseKind: "original",
    baseRoute: "immutable-original",
    baseStrength: null,
    baseScale: 1,
    crop: { x: 0, y: 0, width: 1200, height: 1280 },
    quarterTurns: 0,
    straighten: 0,
    flipHorizontal: false,
    flipVertical: false,
    resize: null,
    outputWidth: 2400,
    outputHeight: 2560,
  }), /instead of the required/);
});
