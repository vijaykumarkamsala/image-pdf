import assert from "node:assert/strict";
import test from "node:test";

import { applyColorToRgba, createNeutralColorRecipe } from "../src/image-quality/imageColor.ts";
import {
  cubeLutRecipe,
  definitionMatchesCubeLutRecipe,
  interpolateCubeLut,
  MAX_CUBE_LUT_BYTES,
  parseCubeLut,
} from "../src/image-quality/imageCubeLut.ts";

const encoder = new TextEncoder();

const identityCube = `# Rights-cleared synthetic identity LUT
TITLE "Synthetic identity"
DOMAIN_MIN 0.0 0.0 0.0
DOMAIN_MAX 1.0 1.0 1.0
LUT_3D_SIZE 2
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`;

const swapRedBlueCube = `TITLE "Synthetic red blue swap"
LUT_3D_SIZE 2
0 0 0
0 0 1
0 1 0
0 1 1
1 0 0
1 0 1
1 1 0
1 1 1
`;

test("strict 3D .cube parsing records identity, red-fastest order and custom domain", () => {
  const imported = parseCubeLut(encoder.encode(identityCube), "identity.cube");
  assert.equal(imported.fileName, "identity.cube");
  assert.equal(imported.definition.title, "Synthetic identity");
  assert.equal(imported.definition.size, 2);
  assert.deepEqual(imported.definition.domainMin, [0, 0, 0]);
  assert.deepEqual(imported.definition.domainMax, [1, 1, 1]);
  assert.match(imported.definition.sha256, /^[a-f0-9]{64}$/);
  assert.equal(imported.definition.values.length, 24);

  const interpolated = interpolateCubeLut(imported.definition, 0.25, 0.5, 0.75);
  assert.ok(Math.abs(interpolated.red - 0.25) < 1e-6);
  assert.ok(Math.abs(interpolated.green - 0.5) < 1e-6);
  assert.ok(Math.abs(interpolated.blue - 0.75) < 1e-6);

  const custom = parseCubeLut(encoder.encode(identityCube
    .replace("DOMAIN_MIN 0.0 0.0 0.0", "DOMAIN_MIN -1 -1 -1")
    .replace("DOMAIN_MAX 1.0 1.0 1.0", "DOMAIN_MAX 1 1 1")), "custom.cube");
  const midpoint = interpolateCubeLut(custom.definition, 0, 0, 0);
  assert.ok(Math.abs(midpoint.red - 0.5) < 1e-6);
  assert.ok(Math.abs(midpoint.green - 0.5) < 1e-6);
  assert.ok(Math.abs(midpoint.blue - 0.5) < 1e-6);
});

test("tetrahedral LUT intensity is deterministic, progressive and preserves alpha and hidden RGB", () => {
  const definition = parseCubeLut(encoder.encode(swapRedBlueCube), "swap.cube").definition;
  const original = new Uint8ClampedArray([
    64, 128, 192, 255,
    14, 28, 42, 0,
  ]);
  const outputs: Uint8ClampedArray[] = [];
  for (const intensity of [25, 50, 100]) {
    const recipe = createNeutralColorRecipe();
    recipe.cubeLut = { ...cubeLutRecipe(definition), intensity };
    assert.equal(definitionMatchesCubeLutRecipe(definition, recipe.cubeLut), true);
    const pixels = original.slice();
    const repeated = original.slice();
    const statistics = applyColorToRgba(pixels, recipe, definition);
    assert.deepEqual(applyColorToRgba(repeated, recipe, definition), statistics);
    assert.deepEqual(repeated, pixels);
    assert.equal(statistics.processedPixels, 1);
    assert.equal(statistics.changedPixels, 1);
    assert.deepEqual(Array.from(pixels.slice(4)), [14, 28, 42, 0]);
    outputs.push(pixels);
  }
  assert.deepEqual(Array.from(outputs[0].slice(0, 4)), [96, 128, 160, 255]);
  assert.deepEqual(Array.from(outputs[1].slice(0, 4)), [128, 128, 128, 255]);
  assert.deepEqual(Array.from(outputs[2].slice(0, 4)), [192, 128, 64, 255]);
});

test("active LUT processing rejects absent or mismatched reviewed sample data", () => {
  const definition = parseCubeLut(encoder.encode(swapRedBlueCube), "swap.cube").definition;
  const recipe = createNeutralColorRecipe();
  recipe.cubeLut = cubeLutRecipe(definition);
  assert.throws(
    () => applyColorToRgba(new Uint8ClampedArray([64, 128, 192, 255]), recipe),
    /does not match its reviewed SHA-256 metadata/,
  );
  assert.throws(
    () => applyColorToRgba(new Uint8ClampedArray([64, 128, 192, 255]), recipe, {
      ...definition,
      sha256: "f".repeat(64),
    }),
    /does not match its reviewed SHA-256 metadata/,
  );
});

test("LUT clipping statistics describe the final intensity blend", () => {
  const overshoot = `TITLE "Synthetic overshoot"
LUT_3D_SIZE 2
2 0.5 0.5
2 0.5 0.5
2 0.5 0.5
2 0.5 0.5
2 0.5 0.5
2 0.5 0.5
2 0.5 0.5
2 0.5 0.5
`;
  const definition = parseCubeLut(encoder.encode(overshoot), "overshoot.cube").definition;
  const boundedRecipe = createNeutralColorRecipe();
  boundedRecipe.cubeLut = { ...cubeLutRecipe(definition), intensity: 25 };
  assert.equal(
    applyColorToRgba(new Uint8ClampedArray([128, 128, 128, 255]), boundedRecipe, definition).gamutClippedPixels,
    0,
  );
  const clippedRecipe = createNeutralColorRecipe();
  clippedRecipe.cubeLut = cubeLutRecipe(definition);
  assert.equal(
    applyColorToRgba(new Uint8ClampedArray([128, 128, 128, 255]), clippedRecipe, definition).gamutClippedPixels,
    1,
  );
});

test(".cube parser rejects unsupported, ambiguous and resource-unsafe input", () => {
  const parse = (value: string, name = "bad.cube") => parseCubeLut(encoder.encode(value), name);
  assert.throws(() => parseCubeLut(new Uint8Array(MAX_CUBE_LUT_BYTES + 1), "too-large.cube"), /local safety limit/);
  assert.throws(() => parse("LUT_1D_SIZE 2\n0 0 0\n1 1 1\n"), /3D \.cube LUTs only/);
  assert.throws(() => parse("LUT_3D_SIZE 66\n"), /between 2 and 65/);
  assert.throws(() => parse("LUT_3D_SIZE 2\n0 0 0\n"), /requires exactly 8/);
  assert.throws(() => parse(`${identityCube}1 1 1\n`), /more than the declared 8 RGB rows/);
  assert.throws(() => parse(identityCube.replace("LUT_3D_SIZE 2", "LUT_3D_SIZE 2\nLUT_3D_SIZE 2")), /repeats LUT_3D_SIZE/);
  assert.throws(() => parse(identityCube.replace("DOMAIN_MAX 1.0 1.0 1.0", "DOMAIN_MAX 0 1 1")), /greater than DOMAIN_MIN/);
  assert.throws(() => parse(identityCube.replace("1 1 1", "NaN 1 1")), /not a finite decimal number/);
  assert.throws(() => parse(identityCube.replace("Synthetic identity", "Synthetic\tidentity")), /must contain 1-160 characters/);
  assert.throws(() => parse(identityCube.replace("TITLE \"Synthetic identity\"", "UNKNOWN 1")), /directive 'UNKNOWN'.*not supported/);
  assert.throws(() => parse(identityCube, "identity.txt"), /\.cube extension/);
});
