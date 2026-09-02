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
  return operations.sort((left, right) => left.order - right.order);
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
  if (![8, 16].includes(bitDepth) || (bitDepth === 16 && !["png", "tiff"].includes(format))) {
    throw invalid("16-bit output is available only for PNG and TIFF");
  }
  const width = optionalInteger(item["width"], 1, 100_000, "output width");
  const height = optionalInteger(item["height"], 1, 100_000, "output height");
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
  if (physicalWidth === null && physicalHeight === null && (physicalUnit || ppi)) {
    throw invalid("Physical unit and PPI require a physical output size");
  }
  const subsampling = optionalOneOf(item["chroma_subsampling"], ["4:4:4", "4:2:2", "4:2:0"] as const, "chroma subsampling");
  if (subsampling && format !== "jpeg") throw invalid("Chroma subsampling applies only to JPEG");
  return {
    schema_version: PRODUCT_SCHEMA_VERSION,
    profile_id: requireId(item["profile_id"], "profile id"),
    name: requireText(item["name"], "profile name", 100),
    purpose: oneOf(item["purpose"], ["archival_derivative", "web", "email", "social", "presentation", "high_resolution_digital", "custom"] as const, "output purpose"),
    format,
    width, height, percentage,
    physical_width: physicalWidth, physical_height: physicalHeight, physical_unit: physicalUnit, ppi,
    fit: oneOf(item["fit"] ?? "contain", ["contain", "cover", "stretch"] as const, "output fit"),
    quality: optionalInteger(item["quality"], 1, 100, "output quality"),
    lossless: boolean(item["lossless"] ?? false, "lossless"),
    resampling_algorithm: oneOf(item["resampling_algorithm"] ?? "lanczos", ["nearest", "bilinear", "bicubic", "lanczos"] as const, "resampling algorithm"),
    colour_profile: oneOf(item["colour_profile"] ?? "srgb", ["preserve", "srgb", "display-p3"] as const, "colour profile"),
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
  const filename = requireText(value, "output filename", 240);
  if (/[\\/\0-\x1f\x7f]/.test(filename) || filename === "." || filename === "..") {
    throw invalid("Output filenames cannot contain paths or control characters");
  }
  return filename;
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
      return { source_orientation: integer(value["source_orientation"], 2, 8, "source orientation"), apply_exactly_once: value["apply_exactly_once"] === undefined ? true : literalTrue(value["apply_exactly_once"], "apply exactly once") };
    case "crop": {
      const left = number(value["left"], 0, 1, "crop left");
      const top = number(value["top"], 0, 1, "crop top");
      const right = number(value["right"], 0, 1, "crop right");
      const bottom = number(value["bottom"], 0, 1, "crop bottom");
      if (right <= left || bottom <= top) throw invalid("Crop must have positive area");
      return { left, top, right, bottom, aspect_preset: optionalText(value["aspect_preset"], "aspect preset", 50) };
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
      return { mode, width: number(value["width"], 0.001, 100_000, "resize width"), height: number(value["height"], 0.001, 100_000, "resize height"), physical_unit: unit, ppi, aspect_locked: boolean(value["aspect_locked"] ?? true, "aspect lock"), aspect_preset: optionalText(value["aspect_preset"], "aspect preset", 50), fit: oneOf(value["fit"] ?? "contain", ["contain", "cover", "stretch"] as const, "resize fit"), algorithm: resampler(value["algorithm"]) };
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
    case "colour_profile_conversion": return { target_profile: oneOf(value["target_profile"] ?? "srgb", ["preserve", "srgb", "display-p3"] as const, "target profile"), rendering_intent: oneOf(value["rendering_intent"] ?? "perceptual", ["perceptual", "relative_colorimetric"] as const, "rendering intent"), black_point_compensation: boolean(value["black_point_compensation"] ?? true, "black point compensation") };
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

function literalTrue(value: unknown, field: string): true {
  if (value !== true) throw invalid(`${field} must be true`);
  return true;
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

function invalid(message: string): DomainError {
  return new DomainError(400, "enhancement-input-invalid", message);
}
