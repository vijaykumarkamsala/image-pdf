/**
 * Cross-language canonicalisation agreement.
 *
 * The most important test in the TypeScript workspace. It verifies this
 * implementation against the *same* vector file the Python implementation is
 * verified against, so agreement between the browser lab and the benchmark
 * runner is proved rather than assumed.
 *
 * If this fails, one of the two implementations has drifted and a digest computed
 * in the browser will no longer match one computed by the runner. That would make
 * local and cloud results incomparable, which is the whole point of measuring
 * both (D-015, D-016).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  CanonicalisationError,
  canonicalBytes,
  canonicalText,
} from "../src/canonical.ts";
import { digestId, identityDocument, toHex } from "../src/ids.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const vectorsPath = join(repoRoot, "data", "contract-vectors", "canonical-vectors.json");

interface ValidVector {
  name: string;
  why: string;
  input: unknown;
  canonical_text: string;
  canonical_bytes_sha256: string;
  canonical_byte_length: number;
}

interface RejectVector {
  name: string;
  why: string;
  input: unknown;
}

interface IdentityVector {
  kind: string;
  payload: Record<string, unknown>;
  identity_document: Record<string, unknown>;
  id: string;
}

const vectors = JSON.parse(readFileSync(vectorsPath, "utf-8")) as {
  valid: ValidVector[];
  reject: RejectVector[];
  identities: IdentityVector[];
};

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return toHex(new Uint8Array(digest));
}

test("the vector file is present and populated", () => {
  assert.ok(vectors.valid.length >= 10, "expected a meaningful number of vectors");
  assert.ok(vectors.reject.length >= 5);
  assert.ok(vectors.identities.length >= 4);
});

for (const vector of vectors.valid) {
  test(`canonical text matches Python: ${vector.name} (${vector.why})`, () => {
    assert.equal(
      canonicalText(vector.input),
      vector.canonical_text,
      `TypeScript and Python disagree on the canonical form of "${vector.name}"`,
    );
  });

  test(`canonical bytes match Python: ${vector.name}`, async () => {
    const bytes = canonicalBytes(vector.input);
    assert.equal(bytes.length, vector.canonical_byte_length, "UTF-8 byte length differs");
    assert.equal(await sha256Hex(bytes), vector.canonical_bytes_sha256, "digest of the bytes differs");
  });
}

for (const vector of vectors.reject) {
  test(`rejected by both implementations: ${vector.name} (${vector.why})`, () => {
    assert.throws(
      () => canonicalText(vector.input),
      CanonicalisationError,
      `"${vector.name}" must be refused, not coerced`,
    );
  });
}

for (const vector of vectors.identities) {
  test(`identifier matches Python: ${vector.kind}`, async () => {
    const computed = await digestId(vector.kind as never, vector.payload);
    assert.equal(computed, vector.id, `${vector.kind} identifier differs from the Python value`);
  });

  test(`identity document matches Python: ${vector.kind}`, () => {
    assert.deepEqual(identityDocument(vector.kind as never, vector.payload), vector.identity_document);
  });
}

test("domain separation gives distinct ids for identical content", () => {
  const ids = new Set(vectors.identities.map((v) => v.id));
  assert.equal(ids.size, vectors.identities.length, "different kinds produced the same identifier");
});

test("key order does not affect the canonical form", () => {
  assert.equal(canonicalText({ b: 1, a: 2 }), canonicalText({ a: 2, b: 1 }));
});

test("nesting sorts at every level", () => {
  assert.equal(canonicalText({ z: { d: 1, c: 2 }, a: 3 }), '{"a":3,"z":{"c":2,"d":1}}');
});

test("arrays keep their order", () => {
  assert.equal(canonicalText([3, 1, 2]), "[3,1,2]");
});

test("booleans are not numbers", () => {
  assert.equal(canonicalText({ a: true }), '{"a":true}');
  assert.equal(canonicalText({ a: 1 }), '{"a":1}');
});

test("a decomposed string normalises to the composed form", () => {
  assert.equal(canonicalText({ a: "e\u0301" }), canonicalText({ a: "\u00e9" }));
});

test("NaN and Infinity are refused", () => {
  assert.throws(() => canonicalText({ n: Number.NaN }), CanonicalisationError);
  assert.throws(() => canonicalText({ n: Number.POSITIVE_INFINITY }), CanonicalisationError);
});

test("undefined is refused rather than silently dropped", () => {
  assert.throws(() => canonicalText({ a: undefined }), CanonicalisationError);
});

test("the error names the offending path", () => {
  assert.throws(
    () => canonicalText({ outer: { inner: 1.5 } }),
    (error: unknown) => error instanceof CanonicalisationError && error.path === "/outer/inner",
  );
});
