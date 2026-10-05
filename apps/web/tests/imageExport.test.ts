import assert from "node:assert/strict";
import test from "node:test";

import {
  assertImageExportInspection,
  imageExportFilename,
  sanitizeImageExportSettings,
  type ImageExportFormat,
} from "../src/image-quality/imageExport.ts";
import type { ImageFileInspection, InspectedMediaType } from "../src/image-quality/imageFileInspection.ts";

function inspection(mediaType: InspectedMediaType, width = 2_636, height = 2_840): ImageFileInspection {
  return {
    mediaType,
    width,
    height,
    bitDepth: 8,
    colourModel: "rgb",
    hasAlpha: mediaType !== "image/jpeg",
    hasIccProfile: false,
    hasExif: false,
    mayContainGps: false,
    orientation: null,
    frameCount: 1,
    animated: false,
    physicalPixelDensity: null,
    warnings: [],
  };
}

test("export settings bound lossy quality without changing the requested format or transparency policy", () => {
  assert.deepEqual(
    sanitizeImageExportSettings({ format: "jpeg", quality: 109.7, jpegMatte: "white" }),
    { format: "jpeg", quality: 100, jpegMatte: "white" },
  );
  assert.deepEqual(
    sanitizeImageExportSettings({ format: "webp", quality: 12, jpegMatte: "reject" }),
    { format: "webp", quality: 40, jpegMatte: "reject" },
  );
});

test("export filenames disclose exact dimensions, lossy quality and the actual extension", () => {
  assert.equal(
    imageExportFilename("Customer portrait.final.png", 2_636, 2_840, { format: "jpeg", quality: 92, jpegMatte: "reject" }),
    "Customer-portrait.final-export-2636x2840-q92.jpg",
  );
  assert.equal(
    imageExportFilename("logo.png", 8_192, 8_192, { format: "png", quality: 92, jpegMatte: "reject" }),
    "logo-export-8192x8192.png",
  );
});

test("final export inspection accepts only the requested format and exact dimensions", () => {
  const cases: Array<[ImageExportFormat, InspectedMediaType]> = [
    ["png", "image/png"],
    ["jpeg", "image/jpeg"],
    ["webp", "image/webp"],
  ];
  for (const [format, mediaType] of cases) {
    assert.doesNotThrow(() => assertImageExportInspection(inspection(mediaType), format, 2_636, 2_840));
  }
  assert.throws(
    () => assertImageExportInspection(inspection("image/png"), "webp", 2_636, 2_840),
    /encoded image\/png instead of the requested image\/webp/i,
  );
  assert.throws(
    () => assertImageExportInspection(inspection("image/jpeg", 1_900, 2_048), "jpeg", 2_636, 2_840),
    /1900 × 2048 px instead of the required 2636 × 2840 px/i,
  );
});

test("animated encoder output is rejected at the export boundary", () => {
  const animated = { ...inspection("image/webp"), animated: true, frameCount: 2 };
  assert.throws(
    () => assertImageExportInspection(animated, "webp", 2_636, 2_840),
    /unexpectedly produced an animated image/i,
  );
});
