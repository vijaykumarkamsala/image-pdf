import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import type { ExportOutputProfile, ImageOperation, MetadataPolicy } from "ipw-contracts-ts/product";

import { DomainError, requireId, requireText } from "../../kernel/errors.js";

type ObjectValue = Record<string, unknown>;

const OPERATION_KINDS = new Set([
  "orientation_normalize", "crop", "rotate", "flip", "resize",
  "exposure_brightness", "contrast", "highlights_shadows",
  "white_balance_temperature", "tint", "saturation_vibrance", "gamma",
  "levels", "curves", "grayscale", "unsharp_mask", "noise_reduction",
  "colour_profile_conversion", "alpha_background", "resampling_scale",
]);
const EXECUTABLE_MAX_PIXELS = 16_000_000;
const EXECUTABLE_MAX_DIMENSION = 12_000;
const STANDARD_TEXT_FONT_FAMILY = "IPW Standard";
const CROP_PRESETS = new Set(["1:1", "4:3", "3:2", "16:9"]);
const BLEND_MODES = new Set(["normal", "multiply", "screen", "overlay", "darken", "lighten"]);

export function requireOperations(value: unknown): ImageOperation[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw invalid("Use no more than 64 ordered image operations");
  }
  const operations = value.map((item, index) => requireOperation(item, index));
  const ids = operations.map((item) => item.operation_id);
  const orders = operations.map((item) => item.order);
  if (new Set(ids).size !== ids.length || new Set(orders).size !== orders.length) {
    throw invalid("Operation identifiers and order values must be unique");
  }
  const ordered = operations.sort((left, right) => left.order - right.order);
  const enabled = ordered.filter((item) => item.enabled);
  const conversion = enabled.find((item) => item.kind === "colour_profile_conversion");
  if (conversion && enabled[0] !== conversion) {
    throw invalid("Colour-profile conversion must be the first enabled recipe operation");
  }
  return ordered;
}

export function requireOutputProfile(value: unknown): ExportOutputProfile {
  const item = object(value, "output profile");
  const format = oneOf(item["format"], ["jpeg", "png", "webp", "tiff"] as const, "output format");
  const alpha = oneOf(item["alpha_behavior"] ?? "preserve", ["preserve", "flatten"] as const, "alpha behavior");
  const background = optionalColour(item["background"]);
  if (format === "jpeg" && alpha !== "flatten") throw invalid("JPEG output requires a confirmed background");
  if (alpha === "flatten" && !background) throw invalid("Flattened output requires a background colour");
  if (alpha === "preserve" && background) throw invalid("A background colour is valid only when transparency is flattened");
  const bitDepth = integer(item["bit_depth"] ?? 8, 8, 16, "bit depth");
  if (bitDepth !== 8) throw capability("16-bit output is not executable in this build");
  const width = optionalInteger(item["width"], 1, EXECUTABLE_MAX_DIMENSION, "output width");
  const height = optionalInteger(item["height"], 1, EXECUTABLE_MAX_DIMENSION, "output height");
  const percentage = optionalNumber(item["percentage"], 0.01, 1_000, "output percentage");
  const physicalWidth = optionalNumber(item["physical_width"], 0.001, 100_000, "physical width");
  const physicalHeight = optionalNumber(item["physical_height"], 0.001, 100_000, "physical height");
  const sizingModes = Number(width !== null || height !== null)
    + Number(percentage !== null) + Number(physicalWidth !== null || physicalHeight !== null);
  if (sizingModes > 1) throw invalid("Select only one output sizing mode");
  const physicalUnit = optionalOneOf(item["physical_unit"], ["in", "mm", "cm"] as const, "physical unit");
  const ppi = optionalInteger(item["ppi"], 1, 9_600, "PPI");
  if ((physicalWidth !== null || physicalHeight !== null) && (!physicalUnit || !ppi)) {
    throw invalid("Physical output requires a unit and PPI");
  }
  if (format === "webp" && (physicalWidth !== null || physicalHeight !== null)) {
    throw capability("WebP physical-resolution metadata is not executable in this build");
  }
  if (physicalWidth === null && physicalHeight === null && (physicalUnit || ppi)) {
    throw invalid("Physical unit and PPI require a physical output size");
  }
  const subsampling = optionalOneOf(item["chroma_subsampling"], ["4:4:4", "4:2:2", "4:2:0"] as const, "chroma subsampling");
  if (subsampling && format !== "jpeg") throw invalid("Chroma subsampling applies only to JPEG");
  const lossless = boolean(item["lossless"] ?? false, "lossless");
  if ((format === "png" || format === "tiff") && !lossless) {
    throw invalid(`${format.toUpperCase()} is inherently lossless and must be declared lossless`);
  }
  if (format === "jpeg" && lossless) throw invalid("JPEG does not provide a lossless output mode");
  const quality = optionalInteger(item["quality"], 1, 100, "output quality");
  if ((format === "png" || format === "tiff" || (format === "webp" && lossless)) && quality !== null) {
    throw invalid("Quality applies only to JPEG and lossy WebP outputs");
  }
  const colourProfile = oneOf(item["colour_profile"] ?? "srgb", ["preserve", "srgb", "display-p3"] as const, "colour profile");
  if (colourProfile === "display-p3") throw capability("Display P3 output is not executable in this build");
  return {
    schema_version: PRODUCT_SCHEMA_VERSION,
    profile_id: requireId(item["profile_id"], "profile id"),
    preset_version: oneOf(item["preset_version"] ?? "recovery-2e-v1", ["recovery-2e-v1"] as const, "output preset version"),
    name: requireText(item["name"], "profile name", 100),
    purpose: oneOf(item["purpose"], ["archival_derivative", "web", "email", "social", "presentation", "high_resolution_digital", "custom"] as const, "output purpose"),
    format,
    width, height, percentage,
    physical_width: physicalWidth, physical_height: physicalHeight, physical_unit: physicalUnit, ppi,
    fit: oneOf(item["fit"] ?? "contain", ["contain", "cover", "stretch"] as const, "output fit"),
    quality,
    lossless,
    resampling_algorithm: oneOf(item["resampling_algorithm"] ?? "lanczos", ["nearest", "bilinear", "bicubic", "lanczos"] as const, "resampling algorithm"),
    colour_profile: colourProfile,
    bit_depth: bitDepth as 8 | 16,
    alpha_behavior: alpha,
    background,
    metadata_policy: requireMetadataPolicy(item["metadata_policy"]),
    chroma_subsampling: subsampling,
    filename_template: requireText(item["filename_template"] ?? "{document}-{artboard}-{profile}", "filename template", 200),
    collision_behavior: oneOf(item["collision_behavior"] ?? "suffix", ["suffix", "fail"] as const, "collision behavior"),
  };
}

export function requireExportFilename(value: unknown): string {
  const filename = requireText(value, "output filename", 240).normalize("NFC");
  const compatibilityForm = filename.normalize("NFKC");
  const stem = compatibilityForm.replace(/\.[^.]*$/, "").replace(/[ .]+$/g, "").toLowerCase();
  if (Buffer.byteLength(filename, "utf8") > 240
    || /[\\/:\0-\x1f\x7f]/.test(filename)
    || /[\u202a-\u202e\u2066-\u2069]/u.test(filename)
    || compatibilityForm.includes("/") || compatibilityForm.includes("\\") || compatibilityForm.includes(":")
    || filename === "." || filename === ".." || filename.endsWith(".") || filename.endsWith(" ")
    || new Set(["con", "prn", "aux", "nul", "clock$", ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`), ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`)]).has(stem)) {
    throw invalid("Output filenames cannot contain paths or control characters");
  }
  return filename;
}

export function requireExportOutputs(
  value: unknown,
  limit = 64,
): Array<{ artboardId: string; profile: ExportOutputProfile; filename: string }> {
  if (!Array.isArray(value) || value.length < 1 || value.length > limit) {
    throw new DomainError(400, "export-outputs-invalid", `Select between 1 and ${limit} outputs`);
  }
  const usedNames = new Set<string>();
  return value.map((raw) => {
    const item = object(raw, "export output");
    const profile = requireOutputProfile(item["profile"]);
    let filename = ensureExtension(requireExportFilename(item["filename"]), profile.format);
    if (usedNames.has(filename.toLowerCase())) {
      if (profile.collision_behavior === "fail") {
        throw new DomainError(409, "export-filename-collision", "Output filenames must be unique");
      }
      filename = availableFilename(filename, usedNames, limit);
    }
    usedNames.add(filename.toLowerCase());
    return { artboardId: requireId(item["artboard_id"], "artboard id"), profile, filename };
  });
}

export function assertExecutableExport(
  snapshotValue: unknown,
  operations: ImageOperation[],
  outputs: Array<{ artboardId: string; profile: ExportOutputProfile }>,
): void {
  const snapshot = object(snapshotValue, "document snapshot");
  const artboards = Array.isArray(snapshot["artboards"]) ? snapshot["artboards"] : [];
  const layers = Array.isArray(snapshot["layers"]) ? snapshot["layers"] : [];
  const masks = Array.isArray(snapshot["masks"]) ? snapshot["masks"] : [];
  const sharedAssets = Array.isArray(snapshot["shared_assets"]) ? snapshot["shared_assets"] : [];
  const artboardById = new Map<string, ObjectValue>();
  for (const value of artboards) {
    const artboard = object(value, "artboard");
    artboardById.set(requireId(artboard["artboard_id"], "artboard id"), artboard);
  }
  const selectedArtboardIds = new Set(outputs.map((item) => item.artboardId));
  const selectedLayers = layers.filter((value) => value && typeof value === "object" && !Array.isArray(value)
    && selectedArtboardIds.has(String((value as ObjectValue)["artboard_id"]))) as ObjectValue[];
  const selectedMasks = masks.filter((value) => value && typeof value === "object" && !Array.isArray(value)
    && selectedArtboardIds.has(String((value as ObjectValue)["artboard_id"]))) as ObjectValue[];
  const layerIds = new Set<string>();
  const layerById = new Map<string, ObjectValue>();
  const siblingOrders = new Set<string>();
  for (const value of selectedLayers) {
    const layer = object(value, "native layer");
    const id = requireId(layer["layer_id"], "layer id");
    if (layerIds.has(id)) throw capability("Native document contains duplicate layer identities");
    layerIds.add(id);
    layerById.set(id, layer);
    if (Array.isArray(layer["shared_style_ids"]) && layer["shared_style_ids"].length) {
      throw capability("Shared-style export is not executable in this build");
    }
    const kind = requireText(layer["layer_type"], "layer type", 64);
    if (kind === "rich_text") {
      assertStandardText(layer["rich_text"]);
    }
    if (!["group", "raster_image", "shape", "rich_text", "vector_svg"].includes(kind)) {
      throw capability(`Layer type ${kind} has no approved export renderer`);
    }
    if (!BLEND_MODES.has(String(layer["blend_mode"] ?? "normal"))) {
      throw capability("Native layer uses an unsupported blend mode");
    }
    number(layer["opacity"] ?? 1, 0, 1, "layer opacity");
    const transform = object(layer["transform"], "layer transform");
    const transformWidth = number(transform["width"], 0.001, 1_000_000, "layer width");
    const transformHeight = number(transform["height"], 0.001, 1_000_000, "layer height");
    const scaleX = number(transform["scale_x"] ?? 1, 0.001, 1_000, "horizontal layer scale");
    const scaleY = number(transform["scale_y"] ?? 1, 0.001, 1_000, "vertical layer scale");
    const rotation = number(transform["rotation_degrees"] ?? 0, -360, 360, "layer rotation");
    const skewX = number(transform["skew_x_degrees"] ?? 0, -89, 89, "horizontal layer skew");
    const skewY = number(transform["skew_y_degrees"] ?? 0, -89, 89, "vertical layer skew");
    if (skewX !== 0 || skewY !== 0) throw capability("Native skew export is not executable in this build");
    const layerArtboard = artboardById.get(String(layer["artboard_id"]));
    if (!layerArtboard) throw capability("Native layer belongs to an unknown selected artboard");
    const unitScale = artboardUnitScale(layerArtboard);
    const scaledWidth = transformWidth * scaleX * unitScale;
    const scaledHeight = transformHeight * scaleY * unitScale;
    const radians = rotation * Math.PI / 180;
    assertCapacity(
      Math.abs(scaledWidth * Math.cos(radians)) + Math.abs(scaledHeight * Math.sin(radians)),
      Math.abs(scaledWidth * Math.sin(radians)) + Math.abs(scaledHeight * Math.cos(radians)),
      "Native layer transform",
    );
    if (kind === "vector_svg") {
      const vector = object(layer["vector"], "vector layer");
      if (vector["shared_asset_id"] || vector["sanitised_svg_object_reference_id"]) {
        throw capability("External vector export requires the approved sanitised vector renderer");
      }
      const path = requireText(vector["path_data"], "vector path", 100_000);
      const residual = path.replace(/[MLHVZCQmlhvzcq]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?|[\s,]/g, "");
      if (residual) throw capability("Vector path contains an unsupported command");
      if ((path.match(/[Mm](?=\s|[-+0-9.])/g) ?? []).length > 1) {
        throw capability("Multiple vector subpaths require the future canonical renderer");
      }
    }
  }
  for (const value of selectedLayers) {
    const layer = value as ObjectValue;
    const parent = layer["parent_layer_id"];
    if (parent !== null && parent !== undefined && !layerIds.has(String(parent))) {
      throw capability("Native layer parent is outside the selected artboard");
    }
    if (parent !== null && parent !== undefined && layerById.get(String(parent))?.["layer_type"] !== "group") {
      throw capability("Native child layer parent must be a group on the same artboard");
    }
    if (parent !== null && parent !== undefined
      && layerById.get(String(parent))?.["artboard_id"] !== layer["artboard_id"]) {
      throw capability("Native child layer parent must belong to the same artboard");
    }
    const siblingKey = `${String(layer["artboard_id"])}:${String(parent ?? "root")}:${String(layer["order"] ?? 0)}`;
    if (siblingOrders.has(siblingKey)) throw capability("Native sibling layer order must be unique");
    siblingOrders.add(siblingKey);
  }
  for (const layerId of layerIds) {
    const visited = new Set<string>();
    let cursor: string | null = layerId;
    while (cursor !== null) {
      if (visited.has(cursor)) throw capability("Native document contains a cyclic layer hierarchy");
      visited.add(cursor);
      const parent: unknown = layerById.get(cursor)?.["parent_layer_id"];
      cursor = parent === null || parent === undefined ? null : String(parent);
    }
  }
  const visibleLayers = selectedLayers.filter((layer) => isEffectivelyVisible(layer, layerById));
  const maskById = new Map<string, ObjectValue>();
  for (const value of selectedMasks) {
    const mask = object(value, "editable mask");
    const maskId = requireId(mask["mask_id"], "mask id");
    if (maskById.has(maskId)) throw capability("Native document contains duplicate mask identities");
    maskById.set(maskId, mask);
    if (mask["kind"] !== "shape" || Number(mask["feather"] ?? 0) !== 0) {
      throw capability("Only unfeathered shape masks are executable in this build");
    }
    if (!/^(rect|ellipse)\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*\)$/.test(String(mask["path_data"] ?? ""))) {
      throw capability("Editable mask geometry is not executable in this build");
    }
  }
  for (const layer of selectedLayers) {
    const content = layer["raster"] ?? layer["vector"];
    if (!content || typeof content !== "object" || Array.isArray(content)) continue;
    const maskIds = Array.isArray((content as ObjectValue)["mask_ids"])
      ? (content as ObjectValue)["mask_ids"] as unknown[] : [];
    if (maskIds.length > 1) throw capability("Multiple masks on one layer are not executable in this build");
    for (const maskId of maskIds) {
      const mask = maskById.get(String(maskId));
      if (!mask || mask["artboard_id"] !== layer["artboard_id"]) {
        throw capability("Layer masks must belong to the same selected artboard");
      }
    }
  }
  const conversions = operations.filter((item) => item.enabled !== false && item.kind === "colour_profile_conversion");
  if (conversions.length > 1) throw invalid("Only one colour-profile conversion may be active");
  for (const output of outputs) {
    const artboard = artboardById.get(output.artboardId);
    if (!artboard) throw invalid("Every output must select an artboard in this document version");
    const base = artboardPixelDimensions(artboard);
    const recipeDimensions = estimateRecipeDimensions(base.width, base.height, operations);
    const dimensions = estimateOutputDimensions(recipeDimensions.width, recipeDimensions.height, output.profile);
    if (dimensions.width > EXECUTABLE_MAX_DIMENSION || dimensions.height > EXECUTABLE_MAX_DIMENSION || dimensions.width * dimensions.height > EXECUTABLE_MAX_PIXELS) {
      throw new DomainError(413, "export-capacity-exceeded", "Requested output exceeds the executable 16 megapixel processing limit");
    }
    const target = conversions[0]
      ? (conversions[0].parameters as unknown as ObjectValue)["target_profile"]
      : output.profile.colour_profile;
    if (target !== output.profile.colour_profile) {
      throw invalid("Recipe and output colour-profile targets must match");
    }
    if (output.profile.colour_profile === "preserve") {
      const selectedRasterIds = new Set(visibleLayers.filter((layer) => layer["layer_type"] === "raster_image")
        .map((layer) => String((layer["raster"] as ObjectValue | undefined)?.["shared_asset_id"] ?? "")));
      const rasterSources = sharedAssets.filter((value) => (
        value && typeof value === "object" && !Array.isArray(value)
        && (value as ObjectValue)["kind"] === "raster"
        && selectedRasterIds.has(String((value as ObjectValue)["shared_asset_id"]))
      ));
      const visibleNativeArtwork = visibleLayers.some((value) => {
        const layer = value as ObjectValue;
        return !["group", "raster_image"].includes(String(layer["layer_type"]));
      });
      if (rasterSources.length !== 1 || visibleNativeArtwork) {
        throw capability("Source profile preservation requires one raster source and no native sRGB artwork");
      }
      if ((artboard["background"] as ObjectValue | undefined)?.["kind"] !== "transparent") {
        throw capability("Source profile preservation requires a transparent artboard background");
      }
    }
  }
}

function assertStandardText(value: unknown): void {
  const text = object(value, "rich-text layer");
  const allowed = new Set(["schema_version", "text", "runs", "font_family", "font_size", "color", "text_align"]);
  const unsupported = Object.keys(text).find((field) => !allowed.has(field));
  if (unsupported) throw capability(`Advanced text field ${unsupported} is not executable in this build`);
  const content = text["text"];
  if (typeof content !== "string" || content.length > 10_000) {
    throw invalid("Native text content exceeds the supported range");
  }
  if (/[^\x20-\x7e\n]/u.test(content)) {
    throw capability("Native text contains glyphs outside the bundled standard subset");
  }
  if (text["font_family"] !== STANDARD_TEXT_FONT_FAMILY) {
    throw capability("Native text requires the bundled IPW Standard font");
  }
  const runs = text["runs"];
  if (runs !== undefined && (!Array.isArray(runs) || runs.length > 0)) {
    throw capability("Rich-text runs are not executable in this build");
  }
  number(text["font_size"] ?? 32, 0.001, 2_000, "text size");
  const colour = text["color"] ?? "#162033";
  if (typeof colour !== "string" || !/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(colour)) {
    throw invalid("Native text colour must be hexadecimal");
  }
  oneOf(text["text_align"] ?? "left", ["left", "center", "right"] as const, "text alignment");
}

export function effectiveVisibleRasterAssetIds(snapshotValue: unknown, artboardIds: Iterable<string>): Set<string> {
  const snapshot = object(snapshotValue, "document snapshot");
  const selectedArtboards = new Set(artboardIds);
  const layers = (Array.isArray(snapshot["layers"]) ? snapshot["layers"] : [])
    .filter((value): value is ObjectValue => Boolean(value) && typeof value === "object" && !Array.isArray(value)
      && selectedArtboards.has(String((value as ObjectValue)["artboard_id"])));
  const layerById = new Map(layers.map((layer) => [String(layer["layer_id"]), layer]));
  return new Set(layers
    .filter((layer) => layer["layer_type"] === "raster_image" && isEffectivelyVisible(layer, layerById))
    .map((layer) => String((layer["raster"] as ObjectValue | undefined)?.["shared_asset_id"] ?? ""))
    .filter(Boolean));
}

function isEffectivelyVisible(layer: ObjectValue, layerById: Map<string, ObjectValue>): boolean {
  const visited = new Set<string>();
  let current: ObjectValue | undefined = layer;
  while (current) {
    if (current["visible"] === false) return false;
    const id = String(current["layer_id"] ?? "");
    if (!id || visited.has(id)) return false;
    visited.add(id);
    const parent = current["parent_layer_id"];
    if (parent === null || parent === undefined) return true;
    current = layerById.get(String(parent));
  }
  return false;
}

function artboardPixelDimensions(artboard: ObjectValue): { width: number; height: number } {
  const scale = artboardUnitScale(artboard);
  const width = Math.max(1, Math.round(number(artboard["width"], 0.001, 100_000, "artboard width") * scale));
  const height = Math.max(1, Math.round(number(artboard["height"], 0.001, 100_000, "artboard height") * scale));
  assertCapacity(width, height, "Artboard");
  return { width, height };
}

function artboardUnitScale(artboard: ObjectValue): number {
  const unit = oneOf(artboard["unit"] ?? "px", ["px", "in", "mm", "pt"] as const, "artboard unit");
  return unit === "px" ? 1 : unit === "in" ? 96 : unit === "mm" ? 96 / 25.4 : 96 / 72;
}

function estimateRecipeDimensions(width: number, height: number, operations: ImageOperation[]) {
  let current = { width, height };
  for (const operation of operations.filter((item) => item.enabled).sort((left, right) => left.order - right.order)) {
    const parameters = operation.parameters as unknown as ObjectValue;
    if (operation.kind === "crop") {
      current = {
        width: Math.max(1, Math.round(current.width * (Number(parameters["right"]) - Number(parameters["left"])))),
        height: Math.max(1, Math.round(current.height * (Number(parameters["bottom"]) - Number(parameters["top"])))),
      };
      const preset = parameters["aspect_preset"];
      if (typeof preset === "string" && preset) current = fitAspectInside(current, preset);
    } else if (operation.kind === "rotate" && parameters["expand_canvas"] === true) {
      const radians = Number(parameters["degrees"]) * Math.PI / 180;
      current = {
        width: Math.max(1, Math.ceil(Math.abs(current.width * Math.cos(radians)) + Math.abs(current.height * Math.sin(radians)))),
        height: Math.max(1, Math.ceil(Math.abs(current.width * Math.sin(radians)) + Math.abs(current.height * Math.cos(radians)))),
      };
    } else if (operation.kind === "resize") {
      const mode = String(parameters["mode"]);
      if (mode === "percent") {
        current = {
          width: Math.max(1, Math.round(current.width * Number(parameters["width"]) / 100)),
          height: Math.max(1, Math.round(current.height * Number(parameters["height"]) / 100)),
        };
      } else if (mode === "physical") {
        const factor = parameters["physical_unit"] === "in" ? 1 : parameters["physical_unit"] === "cm" ? 1 / 2.54 : 1 / 25.4;
        current = {
          width: Math.max(1, Math.round(Number(parameters["width"]) * factor * Number(parameters["ppi"]))),
          height: Math.max(1, Math.round(Number(parameters["height"]) * factor * Number(parameters["ppi"]))),
        };
      } else {
        current = { width: Math.max(1, Math.round(Number(parameters["width"]))), height: Math.max(1, Math.round(Number(parameters["height"]))) };
      }
      const preset = parameters["aspect_preset"];
      if (typeof preset === "string" && preset) {
        const [horizontal, vertical] = preset.split(":").map(Number);
        current.height = Math.max(1, Math.round(current.width * vertical! / horizontal!));
      }
    } else if (operation.kind === "resampling_scale") {
      const scale = Number(parameters["scale"]);
      current = { width: current.width * scale, height: current.height * scale };
    }
    assertCapacity(current.width, current.height, `Operation ${operation.kind}`);
  }
  return current;
}

function fitAspectInside(size: { width: number; height: number }, preset: string) {
  const [horizontal, vertical] = preset.split(":").map(Number);
  const ratio = horizontal! / vertical!;
  return size.width / size.height > ratio
    ? { width: Math.max(1, Math.round(size.height * ratio)), height: size.height }
    : { width: size.width, height: Math.max(1, Math.round(size.width / ratio)) };
}

function assertCapacity(width: number, height: number, label: string): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1
    || width > EXECUTABLE_MAX_DIMENSION || height > EXECUTABLE_MAX_DIMENSION
    || width * height > EXECUTABLE_MAX_PIXELS) {
    throw new DomainError(413, "export-capacity-exceeded", `${label} exceeds the executable 16 megapixel processing limit`);
  }
}

function estimateOutputDimensions(width: number, height: number, profile: ExportOutputProfile) {
  if (profile.percentage != null) return { width: Math.max(1, Math.round(width * profile.percentage / 100)), height: Math.max(1, Math.round(height * profile.percentage / 100)) };
  if ((profile.physical_width != null || profile.physical_height != null) && profile.ppi && profile.physical_unit) {
    const factor = profile.physical_unit === "in" ? 1 : profile.physical_unit === "cm" ? 1 / 2.54 : 1 / 25.4;
    const requestedWidth = profile.physical_width == null ? null : Math.round(profile.physical_width * factor * profile.ppi);
    const requestedHeight = profile.physical_height == null ? null : Math.round(profile.physical_height * factor * profile.ppi);
    return {
      width: requestedWidth ?? Math.round(width * Number(requestedHeight) / height),
      height: requestedHeight ?? Math.round(height * Number(requestedWidth) / width),
    };
  }
  if (profile.width != null || profile.height != null) {
    return {
      width: profile.width ?? Math.round(width * Number(profile.height) / height),
      height: profile.height ?? Math.round(height * Number(profile.width) / width),
    };
  }
  return { width: Math.round(width), height: Math.round(height) };
}

function requireOperation(value: unknown, index: number): ImageOperation {
  const item = object(value, `operation ${index + 1}`);
  const kind = requireText(item["kind"], "operation kind", 64);
  if (!OPERATION_KINDS.has(kind)) throw invalid(`Unsupported operation: ${kind}`);
  const parameters = object(item["parameters"], `${kind} parameters`);
  const normalized = normalizeParameters(kind, parameters);
  return {
    schema_version: PRODUCT_SCHEMA_VERSION,
    operation_id: requireId(item["operation_id"], "operation id"),
    kind,
    order: integer(item["order"] ?? index, 0, 63, "operation order"),
    enabled: boolean(item["enabled"] ?? true, "operation enabled state"),
    parameters: { schema_version: PRODUCT_SCHEMA_VERSION, ...normalized },
  } as ImageOperation;
}

function normalizeParameters(kind: string, value: ObjectValue): ObjectValue {
  switch (kind) {
    case "orientation_normalize":
      throw capability("EXIF orientation is normalized once at verified source decode, not as a recipe operation");
    case "crop": {
      const left = number(value["left"], 0, 1, "crop left");
      const top = number(value["top"], 0, 1, "crop top");
      const right = number(value["right"], 0, 1, "crop right");
      const bottom = number(value["bottom"], 0, 1, "crop bottom");
      if (right <= left || bottom <= top) throw invalid("Crop must have positive area");
      const preset = optionalText(value["aspect_preset"], "aspect preset", 50);
      if (preset && !CROP_PRESETS.has(preset)) throw invalid("Crop aspect preset is not executable");
      return { left, top, right, bottom, aspect_preset: preset };
    }
    case "rotate": return { degrees: number(value["degrees"], -360, 360, "rotation"), expand_canvas: boolean(value["expand_canvas"] ?? true, "expand canvas") };
    case "flip": {
      const horizontal = boolean(value["horizontal"] ?? false, "horizontal flip");
      const vertical = boolean(value["vertical"] ?? false, "vertical flip");
      if (!horizontal && !vertical) throw invalid("Flip must select at least one axis");
      return { horizontal, vertical };
    }
    case "resize": {
      const mode = oneOf(value["mode"], ["pixels", "percent", "physical"] as const, "resize mode");
      const unit = optionalOneOf(value["physical_unit"], ["in", "mm", "cm"] as const, "physical unit");
      const ppi = optionalInteger(value["ppi"], 1, 9_600, "PPI");
      if (mode === "physical" && (!unit || !ppi)) throw invalid("Physical resize requires a unit and PPI");
      if (mode !== "physical" && unit) throw invalid("Physical unit is valid only for physical resize");
      const aspectLocked = boolean(value["aspect_locked"] ?? true, "aspect lock");
      if (!aspectLocked) throw capability("Unlocked resize is not executable in this build");
      const preset = optionalText(value["aspect_preset"], "aspect preset", 50);
      if (preset && !CROP_PRESETS.has(preset)) throw invalid("Resize aspect preset is not executable");
      return { mode, width: number(value["width"], 0.001, EXECUTABLE_MAX_DIMENSION, "resize width"), height: number(value["height"], 0.001, EXECUTABLE_MAX_DIMENSION, "resize height"), physical_unit: unit, ppi, aspect_locked: true, aspect_preset: preset, fit: oneOf(value["fit"] ?? "contain", ["contain", "cover"] as const, "resize fit"), algorithm: resampler(value["algorithm"]) };
    }
    case "exposure_brightness": return { exposure_ev: number(value["exposure_ev"] ?? 0, -5, 5, "exposure"), brightness: number(value["brightness"] ?? 0, -100, 100, "brightness") };
    case "contrast": return { amount: number(value["amount"] ?? 0, -100, 100, "contrast") };
    case "highlights_shadows": return { highlights: number(value["highlights"] ?? 0, -100, 100, "highlights"), shadows: number(value["shadows"] ?? 0, -100, 100, "shadows") };
    case "white_balance_temperature": return { temperature_kelvin: integer(value["temperature_kelvin"] ?? 6500, 2_000, 12_000, "temperature") };
    case "tint": return { amount: number(value["amount"] ?? 0, -100, 100, "tint") };
    case "saturation_vibrance": return { saturation: number(value["saturation"] ?? 0, -100, 100, "saturation"), vibrance: number(value["vibrance"] ?? 0, -100, 100, "vibrance") };
    case "gamma": return { gamma: number(value["gamma"] ?? 1, 0.1, 5, "gamma") };
    case "levels": {
      const black = integer(value["black"] ?? 0, 0, 254, "black level");
      const white = integer(value["white"] ?? 255, 1, 255, "white level");
      if (white <= black) throw invalid("White level must exceed black level");
      return { black, white, midpoint: number(value["midpoint"] ?? 1, 0.1, 5, "level midpoint") };
    }
    case "curves": {
      if (!Array.isArray(value["points"]) || value["points"].length < 2 || value["points"].length > 32) throw invalid("Curves require 2 to 32 points");
      const points = value["points"].map((point, index) => {
        const item = object(point, `curve point ${index + 1}`);
        return { schema_version: PRODUCT_SCHEMA_VERSION, input: number(item["input"], 0, 1, "curve input"), output: number(item["output"], 0, 1, "curve output") };
      });
      const inputs = points.map((point) => point.input);
      if (inputs[0] !== 0 || inputs.at(-1) !== 1 || inputs.some((item, index) => index > 0 && item <= inputs[index - 1]!)) throw invalid("Curve inputs must increase from 0 to 1");
      return { channel: oneOf(value["channel"] ?? "rgb", ["rgb", "red", "green", "blue"] as const, "curve channel"), points };
    }
    case "grayscale": return { method: oneOf(value["method"] ?? "luminance", ["luminance", "average"] as const, "grayscale method") };
    case "unsharp_mask": return { radius: number(value["radius"] ?? 1, 0.1, 50, "unsharp radius"), amount: number(value["amount"] ?? 100, 0, 500, "unsharp amount"), threshold: integer(value["threshold"] ?? 3, 0, 255, "unsharp threshold") };
    case "noise_reduction": return { strength: integer(value["strength"] ?? 20, 0, 100, "noise reduction"), preserve_edges: integer(value["preserve_edges"] ?? 70, 0, 100, "edge preservation") };
    case "colour_profile_conversion": {
      const target = oneOf(value["target_profile"] ?? "srgb", ["preserve", "srgb", "display-p3"] as const, "target profile");
      if (target === "display-p3") throw capability("Display P3 conversion is not executable in this build");
      return { target_profile: target, rendering_intent: oneOf(value["rendering_intent"] ?? "perceptual", ["perceptual", "relative_colorimetric"] as const, "rendering intent"), black_point_compensation: boolean(value["black_point_compensation"] ?? true, "black point compensation") };
    }
    case "alpha_background": {
      const behavior = oneOf(value["behavior"] ?? "preserve", ["preserve", "flatten"] as const, "alpha behavior");
      const background = optionalColour(value["background"]);
      if (behavior === "flatten" && !background) throw invalid("Flattening alpha requires a background colour");
      if (behavior === "preserve" && background) throw invalid("Preserved alpha cannot carry a background colour");
      return { behavior, background };
    }
    case "resampling_scale": return { scale: oneOf(value["scale"], [2, 4] as const, "resampling scale"), algorithm: resampler(value["algorithm"]), label: "Standard resampling (not AI reconstruction)" };
    default: throw invalid("Unsupported image operation");
  }
}

function requireMetadataPolicy(value: unknown): MetadataPolicy {
  const item = value === undefined ? {} : object(value, "metadata policy");
  if (item["preserve_location"] === true || item["remove_embedded_thumbnails"] === false) {
    throw invalid("Location and embedded thumbnails are removed by the privacy-safe policy");
  }
  return {
    schema_version: PRODUCT_SCHEMA_VERSION,
    preserve_copyright: boolean(item["preserve_copyright"] ?? true, "preserve copyright"),
    preserve_description: boolean(item["preserve_description"] ?? false, "preserve description"),
    preserve_capture_time: boolean(item["preserve_capture_time"] ?? false, "preserve capture time"),
    preserve_camera: boolean(item["preserve_camera"] ?? false, "preserve camera metadata"),
    preserve_location: false,
    remove_embedded_thumbnails: true,
  };
}

function object(value: unknown, field: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`${field} must be an object`);
  return value as ObjectValue;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw invalid(`${field} must be true or false`);
  return value;
}

function number(value: unknown, minimum: number, maximum: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw invalid(`${field} is outside the supported range`);
  return value;
}

function integer(value: unknown, minimum: number, maximum: number, field: string): number {
  const result = number(value, minimum, maximum, field);
  if (!Number.isInteger(result)) throw invalid(`${field} must be a whole number`);
  return result;
}

function optionalNumber(value: unknown, minimum: number, maximum: number, field: string): number | null {
  return value === undefined || value === null ? null : number(value, minimum, maximum, field);
}

function optionalInteger(value: unknown, minimum: number, maximum: number, field: string): number | null {
  return value === undefined || value === null ? null : integer(value, minimum, maximum, field);
}

function oneOf<T extends readonly (string | number)[]>(value: unknown, choices: T, field: string): T[number] {
  if (!choices.includes(value as never)) throw invalid(`${field} is not supported`);
  return value as T[number];
}

function optionalOneOf<T extends readonly string[]>(value: unknown, choices: T, field: string): T[number] | null {
  return value === undefined || value === null ? null : oneOf(value, choices, field);
}

function optionalText(value: unknown, field: string, max: number): string | null {
  return value === undefined || value === null ? null : requireText(value, field, max);
}

function optionalColour(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const colour = requireText(value, "background colour", 32);
  if (!/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(colour)) throw invalid("Background must be a hexadecimal colour");
  return colour.toUpperCase();
}

function resampler(value: unknown) {
  return oneOf(value ?? "lanczos", ["nearest", "bilinear", "bicubic", "lanczos"] as const, "resampling algorithm");
}

function ensureExtension(filename: string, format: "jpeg" | "png" | "webp" | "tiff"): string {
  const allowed = format === "jpeg" ? [".jpg", ".jpeg"] : format === "tiff" ? [".tif", ".tiff"] : [`.${format}`];
  if (allowed.some((extension) => filename.toLowerCase().endsWith(extension))) return filename;
  if (/\.[a-z0-9]{1,8}$/i.test(filename)) {
    throw new DomainError(400, "export-extension-mismatch", `Filename extension does not match ${format.toUpperCase()}`);
  }
  return `${filename}${allowed[0]}`;
}

function availableFilename(filename: string, used: Set<string>, limit: number): string {
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : "";
  for (let suffix = 2; suffix <= limit; suffix += 1) {
    const candidate = `${stem}-${suffix}${extension}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  throw new DomainError(409, "export-filename-collision", "Output filenames could not be made unique");
}

function invalid(message: string): DomainError {
  return new DomainError(400, "enhancement-input-invalid", message);
}

function capability(message: string): DomainError {
  return new DomainError(422, "export-capability-unavailable", message);
}
