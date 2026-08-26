/**
 * TypeScript view of the benchmark contract.
 *
 * The types are generated from `packages/schemas/v1`, which are generated from
 * the pydantic models in `packages/contracts`. The canonicalisation and digest
 * code is hand-written, and is verified against the same vector file the Python
 * implementation is verified against - see `tests/canonical.test.ts`.
 *
 * No runtime dependencies. Everything here uses the standard library of whatever
 * host it runs in: `TextEncoder`, `crypto.subtle`, `String.prototype.normalize`.
 */

export * from "./generated/contracts.ts";
export * from "./canonical.ts";
export * from "./ids.ts";
