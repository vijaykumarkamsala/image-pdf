/**
 * Content-addressed identifiers - the TypeScript half.
 *
 * Mirrors `services/benchmark-runner/src/ipw/benchmark_runner/ids.py` exactly:
 * domain-separated identity document, canonical JSON, SHA-256, base32 lowercase
 * unpadded, truncated to 32 characters (160 bits), prefixed by kind.
 *
 * The point of implementing this twice is that a result measured in the browser
 * and a result measured by the runner must carry the *same* identifier when they
 * describe the same work. If they did not, the two halves of the hybrid
 * local/cloud story (D-015, D-016) could never be compared.
 *
 * Hashing is async because `crypto.subtle` is async in every environment that has
 * it - browsers and Node alike. That is the one shape difference from the Python
 * side, and it is unavoidable rather than a design choice.
 */

import { canonicalBytes } from "./canonical.ts";
import { SCHEMA_VERSION } from "./generated/contracts.ts";

/** Base32 characters after the prefix: 32 x 5 bits = 160 bits of digest. */
export const ID_BODY_LENGTH = 32;

export type IdKind = "run" | "result" | "report" | "manifest" | "policy" | "runtime" | "asset";

const PREFIX: Record<IdKind, string> = {
  run: "run",
  result: "res",
  report: "rep",
  manifest: "mfst",
  policy: "pol",
  runtime: "rt",
  asset: "ast",
};

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lowercase, unpadded. */
export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(buffer >> bits) & 31];
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Wrap a payload with domain-separation fields.
 *
 * Without these, a run identity and a result identity that happened to carry the
 * same field values would collide.
 */
export function identityDocument(
  kind: IdKind,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (!(kind in PREFIX)) {
    throw new Error(`unknown identity kind ${kind}`);
  }
  if ("_id_kind" in payload || "_schema_version" in payload) {
    throw new Error("payload must not define reserved keys '_id_kind' or '_schema_version'");
  }
  return { _id_kind: kind, _schema_version: SCHEMA_VERSION, ...payload };
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "Web Crypto is unavailable. Browsers expose crypto.subtle only in a secure " +
        "context: serve the lab over http://localhost or https, not file://.",
    );
  }
  const buffer = await subtle.digest("SHA-256", bytes as BufferSource);
  return new Uint8Array(buffer);
}

/** Full 64-character SHA-256 hex digest of a domain-separated identity. */
export async function digestHex(kind: IdKind, payload: Record<string, unknown>): Promise<string> {
  return toHex(await sha256(canonicalBytes(identityDocument(kind, payload))));
}

/** The prefixed, truncated, base32 identifier. */
export async function digestId(kind: IdKind, payload: Record<string, unknown>): Promise<string> {
  const raw = await sha256(canonicalBytes(identityDocument(kind, payload)));
  return `${PREFIX[kind]}_${base32Encode(raw).slice(0, ID_BODY_LENGTH)}`;
}

export const runIdOf = (identity: Record<string, unknown>): Promise<string> =>
  digestId("run", { identity });

export const resultIdOf = (identity: Record<string, unknown>): Promise<string> =>
  digestId("result", { identity });

export const reportIdOf = (identity: Record<string, unknown>): Promise<string> =>
  digestId("report", { identity });

export const manifestIdOf = (manifest: Record<string, unknown>): Promise<string> =>
  digestId("manifest", { manifest });
