# `ipw-contracts-ts`

The TypeScript view of the benchmark contract.

```text
packages/contracts        Python, hand-written    <- the single source of truth
        |  bench schema export
        v
packages/schemas/v1       JSON Schema, generated  <- language-neutral
        |  python tools/generate_ts_contracts.py
        v
packages/contracts-ts     TypeScript, generated
```

`src/generated/contracts.ts` is **generated and committed**: 53 interfaces and 19
type aliases, plus runtime arrays for each enum so a value received at runtime can
be validated. Editing it by hand creates exactly the drift the generation step
exists to prevent, and `tools/generate_ts_contracts.py --check` fails the build if
it is stale.

The codegen is written in Python rather than Node so it lives beside the source of
truth — and so this workspace needs no codegen dependency at all.

## The hand-written half

Two modules are not generated, because they encode *behaviour* rather than shape:

- [`src/canonical.ts`](src/canonical.ts) — canonical JSON, byte-identical to
  `canonical.py`
- [`src/ids.ts`](src/ids.ts) — content-addressed identifiers, identical to `ids.py`

## Why that agreement is provable, not hopeful

Both implementations are verified against the **same** committed vector file,
[`data/contract-vectors/canonical-vectors.json`](../../data/contract-vectors/canonical-vectors.json):
14 valid cases, 7 that must be rejected, and 4 identity digests.

The vectors deliberately cover where the two languages could plausibly diverge —
non-ASCII values, NFC normalisation, control-character escapes, key ordering,
integers at the edge of exact representation — and where both must refuse:
non-integer numbers, non-ASCII keys, out-of-range integers.

Two POC-001 decisions exist specifically to make agreement achievable, and this is
where they pay off:

- **No floats in identity documents.** JavaScript has one number type; Python
  distinguishes int from float. Enforced on both sides as "integers only", the two
  land on identical bytes.
- **ASCII-only object keys.** Python sorts by code point, `Array.prototype.sort`
  by UTF-16 code unit — orders that differ above U+FFFF. Restricting keys to ASCII
  makes them identical by construction, so neither side needs a custom comparator.

Verified by deliberately breaking it: removing `.sort()` from the TypeScript
serialiser fails 2 of the 53 tests immediately.

## Running

```powershell
npm run typecheck --workspace ipw-contracts-ts   # tsc --noEmit, strict
npm run test --workspace ipw-contracts-ts        # node --test, no test framework
```

Node 24 runs TypeScript natively via type stripping, and `node:test` is built in —
so there is no test-runner dependency and no bundler. `typescript` is needed only
for type-checking and for the browser build.

## No runtime dependencies

Everything here uses the standard library of whatever host it runs in:
`TextEncoder`, `crypto.subtle`, `String.prototype.normalize`. The same code runs
in Node and in a browser without a shim.
