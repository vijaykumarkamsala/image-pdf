# Recovery 1 - Production Foundation

**Status:** Implemented on Recovery 1 branch
**Date:** 30 August 2026
**Branch:** `recovery/1-production-foundation`
**Base:** Recovery 0 commit `b2058b9`
**Scope:** Contracts, shells, package boundaries, architecture gates and records only

## 1. Objective

Recovery 1 establishes the first production-shaped foundation for Product V2
without implementing product features. It creates shared contracts, customer/API
shells, worker boundaries and tests that prevent benchmark or legacy code from
leaking into customer runtime.

## 2. Baseline and Legacy Preservation

The verified technical baseline remains:

```text
commit: bb49941678df8aa191e7882b2d07e125cae25994
tag:    verified-baseline-2026-08-30-phase-1b
```

Recovery 0 was published on `recovery/0-preserve-reconcile`. Recovery 1 starts
from the Recovery 0 commit and does not rewrite that baseline.

The legacy UI was moved with Git history from:

```text
apps/workspace
```

to:

```text
apps/workspace-legacy
```

Its workspace name is now `ipw-workspace-legacy`. It remains frozen POC evidence
and is not the production customer experience.

## 3. Contract Catalogue

`packages/contracts` is the Python source of truth. Product V2 foundation
contracts added in Recovery 1:

| Contract | Purpose |
| --- | --- |
| `TraceContext` | Trace, request and idempotency propagation. |
| `WorkspaceReference` | Workspace reference without deciding account model. |
| `Project` | Project, collection and subproject metadata. |
| `StorageObjectRef` | Immutable object-storage byte reference. |
| `AssetOriginal` | Original uploaded or source asset. |
| `SourceVersion` | Frozen or linked source version. |
| `DocumentVersion` | Editable native document/package version. |
| `ProvenanceRecord` | Derivative/export lineage. |
| `ProductError` | Customer-safe structured error envelope. |
| `JobCheckpoint` | Durable retry/checkpoint state boundary. |
| `ProcessingJob` | Queue message for processing/export work. |
| `ProcessorFacts` | Worker-reported routing and provenance facts. |
| `LicenceReleaseGate` | Purpose-based component release eligibility. |
| `ExportRequest` | Render/export request. |
| `ExportResult` | Render/export outcome. |

Generated artifacts are updated in `packages/schemas`,
`packages/contracts-ts/src/generated/contracts.ts` and
`data/contract-vectors/canonical-vectors.json`.

## 4. Production Monorepo Shape

Recovery 1 declares this production foundation:

```text
apps/
  web/                       React + TypeScript customer shell
  workspace-legacy/          frozen legacy UI evidence
  browser-lab/               POC device/benchmark lab
services/
  api/                       NestJS control-plane shell
  processing-worker/         Python worker boundary with fake processor
  benchmark-runner/          benchmark/development only
  workspace-api/             POC local API, legacy only
packages/
  contracts/                 shared Python contract source of truth
  schemas/                   generated shared JSON Schema
  contracts-ts/              shared generated TypeScript contracts
  storage/                   production storage protocols only
  jobs/                      production durable-job protocols only
  licence-registry/          production-safe licence gate logic
  processors/                POC processor adapters
  pdf/                       quarantined POC PDF engine
  vector/                    POC vector candidate
  metrics/                   benchmark/QA metrics
```

`packages/contracts` and `packages/contracts-ts` are now `shared` workspaces.
Production workspaces may depend on them. Production workspaces may not depend
on POC workspaces.

## 5. Application and Package Shells

`apps/web` is a Vite React shell. It exposes the approved top-level V2 product
areas without implementing editors or workflows:

- Image & Graphic Studio
- Create PDF
- Edit & Manage PDF
- Print & Production

`services/api` is a NestJS shell. It includes health/readiness endpoints, trace
middleware, customer-safe error filtering and placeholder modules for identity,
workspaces, projects, assets, jobs, exports, sharing, e-sign and connectors.

`services/processing-worker` is a Python worker boundary. It supports
cancellation, checkpoints, processor facts, provenance and deterministic fake
processing only.

`packages/storage` and `packages/jobs` define protocols only.
`packages/licence-registry` owns production-safe licence/release gate evaluation
extracted from benchmark-runner ownership.

## 6. Dependency and Runtime Boundaries

Customer/runtime boundary:

- `ipw-web` depends on `ipw-contracts-ts`.
- `ipw-api` depends on `ipw-contracts-ts`.
- `ipw-processing-worker` depends on `ipw-contracts`, `ipw-jobs`,
  `ipw-storage` and `ipw-licence-registry`.
- `ipw-storage`, `ipw-jobs` and `ipw-licence-registry` depend on
  `ipw-contracts`.

POC/development boundary:

- `ipw-benchmark-runner` remains `poc`.
- `ipw-workspace-api` remains `poc` and still depends on benchmark-runner for
  legacy behavior.
- Production workspaces do not depend on `ipw-benchmark-runner`.

Benchmark-runner dependency removal from customer runtime is complete for the
new production shell. The remaining benchmark-runner dependency in
`services/workspace-api` is legacy-only and intentionally deferred until that
POC surface is retired or explicitly repaired.

## 7. Reuse Matrix

| Area | Recovery 1 status | Production approval state |
| --- | --- | --- |
| Contracts | Reused and expanded | Shared source of truth approved for foundation. |
| Inspection | Not promoted | Reuse candidate pending Recovery 2/3 intake gates. |
| Standard processors | Not promoted | Candidate pending visual, print and production quality gates. |
| AI processors | Quarantined | Blocked pending licence, model, quality and infra approval. |
| PDF | Quarantined | Blocked pending compatibility, differential, security and performance benchmark. |
| Vector | Not promoted | Candidate pending editor/profile validation. |
| Metrics | Kept in POC | QA/benchmark support, not customer runtime. |
| Storage | Boundary created | Protocols only; provider implementations deferred. |
| Jobs | Boundary created | Protocols only; queue provider deferred. |
| Licence guards | Extracted | Production-safe gate logic created; final release use still needs product policy. |

## 8. Custom PDF Quarantine

The custom PDF engine remains outside production runtime. Production approval
requires the benchmark described in Recovery 0: differential behavior against an
established engine, malformed/fuzz/security tests, signed-PDF protection, form
and layer preservation, font/tag behavior, redaction byte-removal proof,
large-file limits, viewer/printer compatibility and PDF/A/PDF/X/preflight checks
where claimed.

## 9. Architecture Gates

Recovery 1 adds tests that verify:

- production Python imports do not cross into POC workspaces
- production workspaces are tied to approved `RECOVERY-*` tasks
- React app source does not import legacy, browser-lab, benchmark or POC
  processor/PDF/vector/metrics code
- NestJS source does not import benchmark, legacy UI, browser lab, worker
  implementation or POC processors
- the worker does not own customer billing or entitlement policy
- benchmark-runner remains development-only
- generated TypeScript contracts are clearly marked as generated
- legacy UI is isolated from production workspace dependencies

## 10. Developer Commands

Install from lockfiles where practical:

```text
npm ci
.venv\Scripts\python.exe -m pip install -e packages/contracts -e packages/processors -e packages/metrics -e packages/pdf -e packages/vector -e packages/licence-registry -e packages/storage -e packages/jobs -e services/benchmark-runner -e services/workspace-api -e services/processing-worker
```

Run the full verification suite:

```text
.venv\Scripts\python.exe tools\check.py
```

Run contract drift checks:

```text
.venv\Scripts\python.exe -m ipw.benchmark_runner schema export --check
.venv\Scripts\python.exe tools\generate_ts_contracts.py --check
.venv\Scripts\python.exe tools\make_canonical_vectors.py --check
```

Run the new apps/packages directly:

```text
npm run typecheck --workspace ipw-web
npm run test --workspace ipw-web
npm run build --workspace ipw-web
npm run typecheck --workspace ipw-api
npm run test --workspace ipw-api
npm run build --workspace ipw-api
.venv\Scripts\python.exe -m pytest packages\storage\tests packages\jobs\tests packages\licence-registry\tests services\processing-worker\tests -q --no-cov
.venv\Scripts\python.exe -m pytest tests\test_workspaces.py tests\test_architecture_boundaries.py -q --no-cov
```

Start local development servers:

```text
npm run dev --workspace ipw-web
npm run start --workspace ipw-api
```

`services/processing-worker` has no long-running server in Recovery 1.

## 11. Mapping to Delivery Plan

Recovery 1 satisfies the `Recovery 1 - Production contracts and skeleton`
milestone in `docs/product-v2/RECOVERY_ARCHITECTURE_AND_DELIVERY_PLAN.md`:

- versioned project, asset, job, export, error, provenance and storage-reference
  contracts
- React shell
- NestJS control-plane shell
- internal worker contract and fake processor
- CI/architecture boundary tests

It does not start Recovery 2 or later.

## 12. Explicitly Deferred Work

Recovery 1 does not implement:

- identity, account model, workspaces or permissions
- PostgreSQL schema or persistence
- GCS/object-storage provider wiring
- durable queue provider wiring
- upload intake, cloud connectors or customer imports
- editor canvas, PDF editing or image studio behavior
- shadow usage ledger or customer billing
- model/font downloads, model execution or AI inference
- custom PDF production approval
- deployment, secrets, CI remote configuration or cloud calls

## 13. Rollback Procedure

Recovery 1 rollback is branch-local unless pushed and approved otherwise.

1. Keep the verified baseline tag intact.
2. Revert the Recovery 1 commits in reverse order, or reset the local recovery
   branch to Recovery 0 if no later user work must be preserved.
3. If the branch was pushed, use normal revert commits rather than rewriting
   remote history unless the product owner explicitly approves a destructive
   Git operation.
4. Do not delete or move the baseline tag without product-owner approval.

## 14. Recommended First Recovery 2 Task

Recommended Recovery 2 starting task:

Build the identity/workspace/project metadata foundation behind `services/api`
using contract-first DTOs, local provider interfaces for PostgreSQL/object
storage/queue integration, idempotency keys, trace propagation and an effective
zero-charge shadow usage ledger. Keep providers fake or local until product
owner approval names real infrastructure credentials and vendors.

## 15. Decisions Requiring Product-Owner Approval

- Final product name and public terminology.
- Account model and whether YearShift ever becomes shared identity or only a
  later billing umbrella.
- Recovery 2 storage, database and queue provider choices.
- Shadow pricing dimensions and ledger fields.
- Which POC inspection/processing/PDF/vector components may be promoted first.
- PDF compatibility benchmark corpus and baseline engine.
- Model/font/provider licence review outcomes.
- Whether to retire `services/workspace-api` after the legacy UI freeze or keep
  it for internal comparison only.
