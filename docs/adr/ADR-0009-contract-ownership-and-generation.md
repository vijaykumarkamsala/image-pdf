# ADR-0009 - Product V2 contract ownership and generation

**Status:** Accepted for Recovery 1
**Date:** 30 August 2026
**Task:** RECOVERY-1
**Decision recorded:** Product V2 production foundation

## Context

Recovery 1 starts the production foundation without building customer features.
The React app, NestJS API and Python worker need a shared vocabulary for durable
product objects, job envelopes, provenance, storage references, export requests
and customer-safe errors. The existing POC contract discipline is useful, but the
customer runtime must not depend on benchmark-runner implementation code.

## Decision

`packages/contracts` remains the Python source of truth for versioned contract
models and is now classified as `shared` in `workspaces.toml`.

`packages/schemas` remains generated JSON Schema.

`packages/contracts-ts` remains the generated TypeScript view plus the existing
hand-written canonicalisation and digest helpers, and is now classified as
`shared`.

Recovery 1 adds Product V2 contract roots for:

- `TraceContext`
- `WorkspaceReference`
- `Project`
- `StorageObjectRef`
- `AssetOriginal`
- `SourceVersion`
- `DocumentVersion`
- `ProvenanceRecord`
- `ProductError`
- `JobCheckpoint`
- `ProcessingJob`
- `ProcessorFacts`
- `LicenceReleaseGate`
- `ExportRequest`
- `ExportResult`

The generation chain remains:

```text
packages/contracts -> packages/schemas -> packages/contracts-ts -> canonical vectors
```

Generated artifacts must be checked with:

```text
.venv\Scripts\python.exe -m ipw.benchmark_runner schema export --check
.venv\Scripts\python.exe tools\generate_ts_contracts.py --check
.venv\Scripts\python.exe tools\make_canonical_vectors.py --check
```

## Consequences

- Production TypeScript and Python shells can depend on shared contracts without
  importing POC processors or benchmark-runner code.
- Contract drift is reviewable in generated schema, generated TypeScript and
  canonical vectors.
- Product V2 contract models are still foundation contracts. They do not approve
  storage providers, queue providers, billing behavior, production processors or
  PDF/model/font use.
- Future contract additions must preserve the same source-of-truth and
  generation path unless a later ADR supersedes this decision.

## Deferred

- API route schemas and persistence mapping are Recovery 2+ work.
- Public API stability rules are Recovery 10+ work.
- Final product naming, pricing and tenant/account policy are product-owner
  decisions outside this ADR.
