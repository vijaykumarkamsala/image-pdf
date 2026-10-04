import { sha256Bytes } from "./sha256.ts";

export const MAX_CUBE_LUT_BYTES = 16 * 1024 * 1024;
export const MAX_CUBE_LUT_SIZE = 65;

export type ImageCubeLutDomain = [number, number, number];

export interface ImageCubeLutRecipe {
  enabled: boolean;
  intensity: number;
  sha256: string;
  title: string | null;
  size: number;
  domainMin: ImageCubeLutDomain;
  domainMax: ImageCubeLutDomain;
  interpolation: "tetrahedral";
}

export interface ImageCubeLutDefinition {
  sha256: string;
  title: string | null;
  size: number;
  domainMin: ImageCubeLutDomain;
  domainMax: ImageCubeLutDomain;
  interpolation: "tetrahedral";
  /** RGB triples in the IRIDAS red-fastest order. */
  values: Float32Array;
}

export interface ImportedImageCubeLut {
  fileName: string;
  definition: ImageCubeLutDefinition;
}

const SHA256 = /^[a-f0-9]{64}$/;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const INTEGER = /^\d+$/;
const DOMAIN_LIMIT = 65_536;
const SAMPLE_LIMIT = 64;
const MAX_LINE_LENGTH = 4_096;
const MAX_TITLE_LENGTH = 160;

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

function parseNumber(token: string, label: string, line: number, limit: number): number {
  if (token.length > 64 || !NUMBER.test(token)) {
    throw new Error(`The .cube ${label} at line ${line} is not a finite decimal number.`);
  }
  const value = Number(token);
  if (!Number.isFinite(value) || Math.abs(value) > limit) {
    throw new Error(`The .cube ${label} at line ${line} is outside the supported range.`);
  }
  return value;
}

function parseDomain(tokens: string[], label: string, line: number): ImageCubeLutDomain {
  if (tokens.length !== 4) throw new Error(`The .cube ${label} directive at line ${line} requires exactly three values.`);
  return [
    parseNumber(tokens[1], label, line, DOMAIN_LIMIT),
    parseNumber(tokens[2], label, line, DOMAIN_LIMIT),
    parseNumber(tokens[3], label, line, DOMAIN_LIMIT),
  ];
}

function safeTitle(line: string, lineNumber: number): string {
  const match = /^TITLE\s+"([^"]*)"\s*$/i.exec(line);
  if (!match) throw new Error(`The .cube TITLE directive at line ${lineNumber} must contain one quoted title.`);
  const title = match[1].trim();
  if (!title || title.length > MAX_TITLE_LENGTH || /[\u0000-\u001f\u007f]/.test(title)) {
    throw new Error(`The .cube TITLE at line ${lineNumber} must contain 1-${MAX_TITLE_LENGTH} characters.`);
  }
  return title;
}

function sameDomain(left: ImageCubeLutDomain, right: ImageCubeLutDomain) {
  return left.every((value, index) => value === right[index]);
}

function sanitizeTitle(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") return null;
  const title = value.trim();
  if (!title || title.length > MAX_TITLE_LENGTH || /[\u0000-\u001f\u007f]/.test(title)) return null;
  return title;
}

function sanitizeDomain(value: unknown, fallback: ImageCubeLutDomain): ImageCubeLutDomain {
  if (!Array.isArray(value) || value.length !== 3) return [...fallback];
  return value.map((item, index) => (
    Number.isFinite(item) && Math.abs(item as number) <= DOMAIN_LIMIT ? item as number : fallback[index]
  )) as ImageCubeLutDomain;
}

export function sanitizeCubeLutRecipe(recipe: ImageCubeLutRecipe | null | undefined): ImageCubeLutRecipe | null {
  if (!recipe || !SHA256.test(recipe.sha256 ?? "")) return null;
  const size = Number.isSafeInteger(recipe.size) ? clamp(recipe.size, 2, MAX_CUBE_LUT_SIZE) : 2;
  const domainMin = sanitizeDomain(recipe.domainMin, [0, 0, 0]);
  const domainMax = sanitizeDomain(recipe.domainMax, [1, 1, 1]);
  if (domainMax.some((value, index) => value <= domainMin[index])) return null;
  return {
    enabled: recipe.enabled === true,
    intensity: Math.round(clamp(Number.isFinite(recipe.intensity) ? recipe.intensity : 100, 0, 100)),
    sha256: recipe.sha256,
    title: sanitizeTitle(recipe.title),
    size,
    domainMin,
    domainMax,
    interpolation: "tetrahedral",
  };
}

export function sameCubeLutRecipe(left: ImageCubeLutRecipe | null, right: ImageCubeLutRecipe | null): boolean {
  if (!left || !right) return left === right;
  return left.enabled === right.enabled
    && left.intensity === right.intensity
    && left.sha256 === right.sha256
    && left.title === right.title
    && left.size === right.size
    && left.interpolation === right.interpolation
    && sameDomain(left.domainMin, right.domainMin)
    && sameDomain(left.domainMax, right.domainMax);
}

export function isSanitizedCubeLutRecipe(recipe: ImageCubeLutRecipe | null): boolean {
  if (recipe === null) return true;
  const safe = sanitizeCubeLutRecipe(recipe);
  return Boolean(safe && sameCubeLutRecipe(recipe, safe));
}

export function cubeLutRecipe(definition: ImageCubeLutDefinition): ImageCubeLutRecipe {
  return {
    enabled: true,
    intensity: 100,
    sha256: definition.sha256,
    title: definition.title,
    size: definition.size,
    domainMin: [...definition.domainMin],
    domainMax: [...definition.domainMax],
    interpolation: "tetrahedral",
  };
}

export function definitionMatchesCubeLutRecipe(
  definition: ImageCubeLutDefinition | null | undefined,
  recipe: ImageCubeLutRecipe | null | undefined,
): boolean {
  if (!definition || !recipe) return false;
  return definition.sha256 === recipe.sha256
    && definition.title === recipe.title
    && definition.size === recipe.size
    && definition.interpolation === recipe.interpolation
    && sameDomain(definition.domainMin, recipe.domainMin)
    && sameDomain(definition.domainMax, recipe.domainMax)
    && definition.values.length === recipe.size ** 3 * 3;
}

/**
 * Parses a bounded, display-referred IRIDAS 3D .cube file. One-dimensional and
 * combined shaper LUTs are rejected rather than guessed in the browser pipeline.
 */
export function parseCubeLut(bytes: Uint8Array, fileName: string): ImportedImageCubeLut {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new Error("The .cube file is empty.");
  if (bytes.byteLength > MAX_CUBE_LUT_BYTES) {
    throw new Error(`The .cube file is ${bytes.byteLength.toLocaleString("en-US")} bytes, beyond the ${MAX_CUBE_LUT_BYTES.toLocaleString("en-US")}-byte local safety limit.`);
  }
  if (!/\.cube$/i.test(fileName)) throw new Error("Choose a file with the .cube extension.");

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    throw new Error("The .cube file must be valid UTF-8 text.");
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new Error("The .cube file contains unsupported control characters.");
  }

  let title: string | null = null;
  let size: number | null = null;
  let domainMin: ImageCubeLutDomain = [0, 0, 0];
  let domainMax: ImageCubeLutDomain = [1, 1, 1];
  let sawDomainMin = false;
  let sawDomainMax = false;
  let entriesStarted = false;
  const samples: number[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const rawLine = lines[index];
    if (rawLine.length > MAX_LINE_LENGTH) throw new Error(`The .cube line ${lineNumber} exceeds the ${MAX_LINE_LENGTH}-character safety limit.`);
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const tokens = line.split(/\s+/);
    const directive = tokens[0].toUpperCase();

    if (!entriesStarted && directive === "TITLE") {
      if (title !== null) throw new Error(`The .cube file repeats TITLE at line ${lineNumber}.`);
      title = safeTitle(line, lineNumber);
      continue;
    }
    if (!entriesStarted && directive === "LUT_1D_SIZE") {
      throw new Error("This editor supports bounded 3D .cube LUTs only. One-dimensional and shaper LUTs are not silently interpreted.");
    }
    if (!entriesStarted && directive === "LUT_2D_SIZE") {
      throw new Error("This editor does not support two-dimensional LUT data.");
    }
    if (!entriesStarted && directive === "LUT_3D_SIZE") {
      if (size !== null) throw new Error(`The .cube file repeats LUT_3D_SIZE at line ${lineNumber}.`);
      if (tokens.length !== 2 || !INTEGER.test(tokens[1])) throw new Error(`The .cube LUT_3D_SIZE at line ${lineNumber} must be one integer.`);
      size = Number(tokens[1]);
      if (!Number.isSafeInteger(size) || size < 2 || size > MAX_CUBE_LUT_SIZE) {
        throw new Error(`The .cube grid size must be between 2 and ${MAX_CUBE_LUT_SIZE}.`);
      }
      continue;
    }
    if (!entriesStarted && directive === "DOMAIN_MIN") {
      if (sawDomainMin) throw new Error(`The .cube file repeats DOMAIN_MIN at line ${lineNumber}.`);
      domainMin = parseDomain(tokens, "DOMAIN_MIN", lineNumber);
      sawDomainMin = true;
      continue;
    }
    if (!entriesStarted && directive === "DOMAIN_MAX") {
      if (sawDomainMax) throw new Error(`The .cube file repeats DOMAIN_MAX at line ${lineNumber}.`);
      domainMax = parseDomain(tokens, "DOMAIN_MAX", lineNumber);
      sawDomainMax = true;
      continue;
    }
    if (!entriesStarted && /^[A-Z_]+$/.test(directive)) {
      throw new Error(`The .cube directive '${tokens[0]}' at line ${lineNumber} is not supported.`);
    }
    if (size === null) throw new Error(`The .cube data starts at line ${lineNumber} before LUT_3D_SIZE.`);
    entriesStarted = true;
    if (tokens.length !== 3) throw new Error(`The .cube data row at line ${lineNumber} requires exactly three RGB values.`);
    samples.push(
      parseNumber(tokens[0], "red sample", lineNumber, SAMPLE_LIMIT),
      parseNumber(tokens[1], "green sample", lineNumber, SAMPLE_LIMIT),
      parseNumber(tokens[2], "blue sample", lineNumber, SAMPLE_LIMIT),
    );
    if (samples.length > size ** 3 * 3) throw new Error(`The .cube file contains more than the declared ${size ** 3} RGB rows.`);
  }

  if (size === null) throw new Error("The .cube file does not declare LUT_3D_SIZE.");
  if (domainMax.some((value, index) => value <= domainMin[index])) {
    throw new Error("Each .cube DOMAIN_MAX channel must be greater than DOMAIN_MIN.");
  }
  const expectedValues = size ** 3 * 3;
  if (samples.length !== expectedValues) {
    throw new Error(`The .cube file contains ${samples.length / 3} RGB rows; LUT_3D_SIZE ${size} requires exactly ${size ** 3}.`);
  }

  return {
    fileName,
    definition: {
      sha256: sha256Bytes(bytes),
      title,
      size,
      domainMin,
      domainMax,
      interpolation: "tetrahedral",
      values: new Float32Array(samples),
    },
  };
}

function sample(definition: ImageCubeLutDefinition, red: number, green: number, blue: number) {
  const index = ((blue * definition.size + green) * definition.size + red) * 3;
  return [definition.values[index], definition.values[index + 1], definition.values[index + 2]] as const;
}

function addScaled(
  output: [number, number, number],
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  amount: number,
) {
  output[0] += (to[0] - from[0]) * amount;
  output[1] += (to[1] - from[1]) * amount;
  output[2] += (to[2] - from[2]) * amount;
}

/** Applies red-fastest tetrahedral interpolation in the LUT's declared input domain. */
export function interpolateCubeLut(
  definition: ImageCubeLutDefinition,
  red: number,
  green: number,
  blue: number,
): { red: number; green: number; blue: number } {
  const channels = [red, green, blue].map((value, index) => (
    clamp((value - definition.domainMin[index]) / (definition.domainMax[index] - definition.domainMin[index]), 0, 1)
      * (definition.size - 1)
  ));
  const lower = channels.map((value) => Math.floor(value));
  const upper = channels.map((value, index) => Math.min(definition.size - 1, lower[index] + 1));
  const fraction = channels.map((value, index) => value - lower[index]);
  const [r0, g0, b0] = lower;
  const [r1, g1, b1] = upper;
  const [fr, fg, fb] = fraction;
  const c000 = sample(definition, r0, g0, b0);
  const output: [number, number, number] = [...c000];

  if (fr >= fg) {
    if (fg >= fb) {
      const c100 = sample(definition, r1, g0, b0);
      const c110 = sample(definition, r1, g1, b0);
      addScaled(output, c000, c100, fr);
      addScaled(output, c100, c110, fg);
      addScaled(output, c110, sample(definition, r1, g1, b1), fb);
    } else if (fr >= fb) {
      const c100 = sample(definition, r1, g0, b0);
      const c101 = sample(definition, r1, g0, b1);
      addScaled(output, c000, c100, fr);
      addScaled(output, c100, c101, fb);
      addScaled(output, c101, sample(definition, r1, g1, b1), fg);
    } else {
      const c001 = sample(definition, r0, g0, b1);
      const c101 = sample(definition, r1, g0, b1);
      addScaled(output, c000, c001, fb);
      addScaled(output, c001, c101, fr);
      addScaled(output, c101, sample(definition, r1, g1, b1), fg);
    }
  } else if (fr >= fb) {
    const c010 = sample(definition, r0, g1, b0);
    const c110 = sample(definition, r1, g1, b0);
    addScaled(output, c000, c010, fg);
    addScaled(output, c010, c110, fr);
    addScaled(output, c110, sample(definition, r1, g1, b1), fb);
  } else if (fg >= fb) {
    const c010 = sample(definition, r0, g1, b0);
    const c011 = sample(definition, r0, g1, b1);
    addScaled(output, c000, c010, fg);
    addScaled(output, c010, c011, fb);
    addScaled(output, c011, sample(definition, r1, g1, b1), fr);
  } else {
    const c001 = sample(definition, r0, g0, b1);
    const c011 = sample(definition, r0, g1, b1);
    addScaled(output, c000, c001, fb);
    addScaled(output, c001, c011, fg);
    addScaled(output, c011, sample(definition, r1, g1, b1), fr);
  }
  return { red: output[0], green: output[1], blue: output[2] };
}
