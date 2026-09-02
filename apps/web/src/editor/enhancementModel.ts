import type { DocumentReadModel, ImageOperation, ImageOperationKind } from "ipw-contracts-ts/product";

export function defaultOperation(kind: ImageOperationKind, order: number): ImageOperation {
  const parameters: Record<ImageOperationKind, Record<string, unknown>> = {
    orientation_normalize: { source_orientation: 2, apply_exactly_once: true },
    crop: { left: 0, top: 0, right: 1, bottom: 1, aspect_preset: null },
    rotate: { degrees: 0, expand_canvas: true },
    flip: { horizontal: true, vertical: false },
    resize: { mode: "pixels", width: 1920, height: 1080, physical_unit: null, ppi: null, aspect_locked: true, aspect_preset: "16:9", fit: "contain", algorithm: "lanczos" },
    exposure_brightness: { exposure_ev: 0, brightness: 0 },
    contrast: { amount: 0 },
    highlights_shadows: { highlights: 0, shadows: 0 },
    white_balance_temperature: { temperature_kelvin: 6500 },
    tint: { amount: 0 },
    saturation_vibrance: { saturation: 0, vibrance: 0 },
    gamma: { gamma: 1 },
    levels: { black: 0, white: 255, midpoint: 1 },
    curves: { channel: "rgb", points: [{ input: 0, output: 0 }, { input: 0.5, output: 0.5 }, { input: 1, output: 1 }] },
    grayscale: { method: "luminance" },
    unsharp_mask: { radius: 1, amount: 100, threshold: 3 },
    noise_reduction: { strength: 20, preserve_edges: 70 },
    colour_profile_conversion: { target_profile: "srgb", rendering_intent: "perceptual", black_point_compensation: true },
    alpha_background: { behavior: "preserve", background: null },
    resampling_scale: { scale: 2, algorithm: "lanczos", label: "Standard resampling (not AI reconstruction)" },
  };
  return {
    operation_id: `operation-${crypto.randomUUID()}`,
    kind,
    order,
    enabled: true,
    parameters: parameters[kind] as ImageOperation["parameters"],
  };
}

export function normalizeOrder(operations: ImageOperation[]): ImageOperation[] {
  return operations.map((operation, order) => ({ ...operation, order }));
}

export function moveOperation(operations: ImageOperation[], from: number, to: number): ImageOperation[] {
  if (to < 0 || to >= operations.length || from === to) return operations;
  const next = [...operations];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return normalizeOrder(next);
}

export function withFreshIdentity(operation: ImageOperation, order: number): ImageOperation {
  return { ...structuredClone(operation), operation_id: `operation-${crypto.randomUUID()}`, order, enabled: true };
}

export function scaleRecommendedOperation(operation: ImageOperation, strength: number): ImageOperation {
  const scale = strength / 100;
  const parameters = operation.parameters as unknown as Record<string, unknown>;
  const adjustable: Partial<Record<ImageOperationKind, string[]>> = {
    exposure_brightness: ["exposure_ev", "brightness"],
    contrast: ["amount"],
    highlights_shadows: ["highlights", "shadows"],
    tint: ["amount"],
    saturation_vibrance: ["saturation", "vibrance"],
    unsharp_mask: ["amount"],
    noise_reduction: ["strength"],
  };
  const names = adjustable[operation.kind] ?? [];
  if (!names.length) return operation;
  const next = { ...parameters };
  for (const name of names) if (typeof next[name] === "number") next[name] = Number(next[name]) * scale;
  return { ...operation, parameters: next as ImageOperation["parameters"] };
}

export function estimateDimensions(editor: DocumentReadModel, operations: ImageOperation[]) {
  const artboard = editor.snapshot.artboards[0];
  let width = Math.round(artboard?.width ?? 1);
  let height = Math.round(artboard?.height ?? 1);
  for (const operation of operations) {
    if (operation.enabled === false) continue;
    const parameters = operation.parameters as unknown as Record<string, unknown>;
    if (operation.kind === "crop") {
      width = Math.max(1, Math.round(width * (Number(parameters["right"]) - Number(parameters["left"]))));
      height = Math.max(1, Math.round(height * (Number(parameters["bottom"]) - Number(parameters["top"]))));
    }
    if (operation.kind === "resize") {
      const mode = parameters["mode"];
      if (mode === "pixels") { width = Math.round(Number(parameters["width"])); height = Math.round(Number(parameters["height"])); }
      if (mode === "percent") { width = Math.round(width * Number(parameters["width"]) / 100); height = Math.round(height * Number(parameters["height"]) / 100); }
      if (mode === "physical") { width = physicalPixels(Number(parameters["width"]), String(parameters["physical_unit"]), Number(parameters["ppi"])); height = physicalPixels(Number(parameters["height"]), String(parameters["physical_unit"]), Number(parameters["ppi"])); }
    }
    if (operation.kind === "resampling_scale") { width *= Number(parameters["scale"]); height *= Number(parameters["scale"]); }
    if (operation.kind === "rotate" && Math.abs(Number(parameters["degrees"])) % 180 === 90) [width, height] = [height, width];
  }
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

export function summariseOperation(operation: ImageOperation): string {
  if (operation.enabled === false) return "Disabled";
  const parameters = operation.parameters as unknown as Record<string, unknown>;
  if (operation.kind === "resize") return `${parameters["width"]} x ${parameters["height"]} ${parameters["mode"]}`;
  if (operation.kind === "resampling_scale") return `${parameters["scale"]}x standard resampling`;
  if (operation.kind === "rotate") return `${parameters["degrees"]} degrees`;
  if (operation.kind === "crop") return parameters["aspect_preset"] ? String(parameters["aspect_preset"]) : "Free crop";
  return "Editable correction";
}

function physicalPixels(value: number, unit: string, ppi: number) {
  const inches = unit === "mm" ? value / 25.4 : unit === "cm" ? value / 2.54 : value;
  return Math.max(1, Math.round(inches * ppi));
}
