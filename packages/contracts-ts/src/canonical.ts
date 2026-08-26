/**
 * Canonical JSON serialisation - the TypeScript half of the contract.
 *
 * This must produce byte-identical output to
 * `services/benchmark-runner/src/ipw/benchmark_runner/canonical.py`. If the two
 * ever disagree, a digest computed in the browser will not match one computed by
 * the runner, and results that are actually the same will look different.
 *
 * Two POC-001 decisions exist specifically to make that agreement achievable, and
 * this file is where they pay off:
 *
 * - **No floats.** JavaScript has one number type, so `1.0` and `1` are the same
 *   value and serialise identically. Python distinguishes them and rejects the
 *   float. The rule is enforced on both sides as "integers only", which lands on
 *   the same bytes either way.
 * - **ASCII-only object keys.** Python sorts strings by code point;
 *   `Array.prototype.sort` sorts by UTF-16 code unit. Those orders differ above
 *   U+FFFF. Restricting keys to ASCII makes them identical by construction, so
 *   neither side needs a custom comparator.
 */

/** JavaScript's `Number` is exact only to 2^53-1; Python's ints are not. */
export const SAFE_INT_MAX = Number.MAX_SAFE_INTEGER;
export const SAFE_INT_MIN = Number.MIN_SAFE_INTEGER;

/** A value that can appear in a canonical document. */
export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

export class CanonicalisationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path || "<root>"}: ${message}`);
    this.name = "CanonicalisationError";
    this.path = path;
  }
}

const ASCII = /^[\x20-\x7e]+$/;

/**
 * Validate and normalise a value into canonical-safe form.
 *
 * Rejects rather than coerces. A silent coercion here would produce a digest
 * that looks valid and matches nothing.
 */
export function normalise(value: unknown, path = ""): CanonicalValue {
  if (value === null) return null;

  const kind = typeof value;

  if (kind === "boolean") return value as boolean;

  if (kind === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new CanonicalisationError(path, "NaN and Infinity are not representable in JSON");
    }
    if (!Number.isInteger(n)) {
      throw new CanonicalisationError(
        path,
        "non-integer numbers are forbidden in canonical documents; use an integer " +
          "(nanoseconds, bytes, percent) or a decimal string",
      );
    }
    if (n < SAFE_INT_MIN || n > SAFE_INT_MAX) {
      throw new CanonicalisationError(path, `integer ${n} is outside the exactly-representable range`);
    }
    return n;
  }

  if (kind === "string") {
    const s = value as string;
    // A lone surrogate has no valid UTF-8 encoding, so the two languages could
    // not agree on its bytes even in principle.
    if (typeof (s as { isWellFormed?: () => boolean }).isWellFormed === "function" && !s.isWellFormed()) {
      throw new CanonicalisationError(path, "string contains an unpaired surrogate");
    }
    return s.normalize("NFC");
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => normalise(item, `${path}/${index}`));
  }

  if (kind === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, CanonicalValue> = {};
    for (const key of Object.keys(source)) {
      if (key.length === 0) {
        throw new CanonicalisationError(path, "object keys must be non-empty");
      }
      if (!ASCII.test(key)) {
        throw new CanonicalisationError(
          path,
          `object key ${JSON.stringify(key)} must be ASCII so that key ordering is ` +
            "identical in Python and JavaScript",
        );
      }
      out[key] = normalise(source[key], `${path}/${key}`);
    }
    return out;
  }

  throw new CanonicalisationError(path, `unsupported type ${kind}`);
}

/**
 * Serialise a normalised value with sorted keys and no whitespace.
 *
 * Written by hand rather than via `JSON.stringify(value, Object.keys(...).sort())`
 * because the replacer form does not sort nested objects reliably, and key order
 * is the whole point.
 */
function serialise(value: CanonicalValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serialise).join(",")}]`;

  const keys = Object.keys(value).sort();
  const members = keys.map((key) => `${JSON.stringify(key)}:${serialise(value[key] as CanonicalValue)}`);
  return `{${members.join(",")}}`;
}

/** Canonical JSON text. Compact, sorted, NFC, no trailing newline. */
export function canonicalText(value: unknown): string {
  return serialise(normalise(value));
}

/** Canonical UTF-8 bytes. These are what get hashed. */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalText(value));
}
