# Recovery 0 - Preserve and Reconcile

**Status:** Approved local recovery baseline
**Date:** 30 August 2026
**Branch:** `recovery/0-preserve-reconcile`
**Scope:** Documentation authority, baseline preservation and planning record only

## 1. Verified Baseline

The accepted technical baseline is:

```text
commit: bb49941678df8aa191e7882b2d07e125cae25994
tag:    verified-baseline-2026-08-30-phase-1b
```

The tag is an annotated local tag with this message:

```text
Accepted Phase 1B verified technical baseline before V2 Recovery 0
```

This baseline preserves the previously verified state as evidence. Recovery work
must proceed on a branch and must not rewrite the baseline commit or history.

## 2. V2 Authority and Precedence

The authoritative V2 product baseline lives under `docs/product-v2/`.

Document precedence is:

1. Current explicit product-owner instruction
2. `docs/product-v2/PRODUCT_CONSTITUTION.md`
3. `docs/product-v2/FUNCTIONAL_REQUIREMENTS.md`
4. `docs/product-v2/USER_FLOWS_AND_EDGE_CASES.md`
5. `docs/product-v2/PRODUCT_DECISION_REGISTER.md`
6. `docs/product-v2/RECOVERY_ARCHITECTURE_AND_DELIVERY_PLAN.md`
7. `docs/product-v2/QUALITY_AND_RELEASE_PLAN.md`
8. `docs/product-v2/RESEARCH_EVIDENCE.md`
9. Earlier POC and discovery documents, only where they do not conflict with V2

The root `AGENTS.md` is aligned with
`docs/product-v2/AGENTS_V2.md` during Recovery 0.

Earlier product and POC documents remain historical evidence. They do not define
the customer product, release boundary, interface, billing behavior or recovery
architecture where they conflict with V2.

## 3. V2 Product and Release Boundary

The V2 product is an independent Intelligent Visual Production Workspace. It is
not an image-to-PDF converter, a scan-cleanup-only product or a collection of
disconnected one-operation tools.

Before external tester release, approved scope includes:

- Image & Graphic Studio
- Create PDF
- Edit & Manage PDF
- Print and physical-production profiles
- Digital-output profiles
- Projects, collections and subprojects
- Collaboration, sharing, comments and optional approvals
- Google Drive, SharePoint/OneDrive and Dropbox connectivity
- Native e-sign UI and public API
- Public API for stable core product capabilities
- Privacy, retention, diagnostics, administration and testing foundations
- Shadow pricing and metering with customer charge fixed at zero during testing

Excluded before explicit later approval:

- Video editing
- Live customer charging
- Unlicensed fonts, models or proprietary content
- Tight coupling to YearShift
- Production implementation work during Recovery 0

The product is independent from YearShift. It may later be made available under a
YearShift umbrella only through stable APIs, shared identity or shared billing.
The initial product must not depend on YearShift authentication, database,
billing or internal services.

## 4. Legacy UI Freeze Decision

The current customer-looking UI in `apps/workspace/` is frozen as legacy
evidence. Recovery 0 does not move or rename it.

The approved future frozen location is:

```text
apps/workspace-legacy/
```

The approved future workspace name is:

```text
ipw-workspace-legacy
```

The legacy UI must not be incrementally converted into the new React
application. The production customer experience will be built alongside it after
a separately approved implementation task.

## 5. Folder and Package Classification

| Path | Classification | Recovery 0 interpretation |
|---|---|---|
| `docs/product-v2/` | Keep | Authoritative V2 product baseline. |
| `docs/recovery/` | Keep | Recovery-stage planning and audit records. |
| `AGENTS.md` | Repair | Aligned to approved V2 agent instructions. |
| `apps/workspace/` | Archive | Frozen legacy UI evidence; not moved in Recovery 0. |
| `apps/browser-lab/` | Keep | Benchmark/device lab only. |
| `services/workspace-api/` | Refactor/Replace | POC Python HTTP surface; not the V2 NestJS control plane. |
| `services/benchmark-runner/` | Keep | Benchmark and development only; not customer runtime. |
| `packages/contracts/` | Refactor | Reuse contract discipline; reshape for V2 product contracts later. |
| `packages/schemas/` | Keep/Refactor | Generated schema evidence; source-of-truth policy must be defined later. |
| `packages/contracts-ts/` | Keep/Refactor | Reuse generated TypeScript pattern; production app must consume typed contracts. |
| `packages/processors/` | Refactor | Reuse inspection and standard processing after gates; split AI/runtime concerns later. |
| `packages/pdf/` | Repair/Quarantine | Useful primitives, but not production-approved. |
| `packages/vector/` | Keep/Repair | Reuse candidate after quality/profile validation. |
| `packages/metrics/` | Keep | Benchmark and quality-gate support, not customer runtime. |
| `data/` | Keep | Rights-cleared fixtures, goldens, manifests, licence evidence. |
| `infra/docker/` | Repair | POC runtime evidence; production infrastructure is later work. |
| `tools/` | Keep/Repair | Existing validation remains useful; V2 architecture gates come later. |
| `.venv/`, `.tools/`, `node_modules/`, caches | Ignore | Local environment artifacts; not Recovery 0 product material. |

## 6. Dependency Boundary Findings

V2 decision D2-103 requires benchmark/POC code not to be a production runtime
dependency.

Current findings:

- `services/workspace-api/pyproject.toml` depends on `ipw-benchmark-runner`.
- `workspaces.toml` records `ipw-workspace-api` depending on
  `ipw-benchmark-runner`.
- Runtime modules in `services/workspace-api` import
  `ipw.benchmark_runner.licence_register` and
  `ipw.benchmark_runner.workspace`.
- Current tests also allow this edge.

Recovery 0 records the violation but does not remove or refactor dependencies.
That work is deferred to a later explicitly approved implementation task.

Approved future package names for extracting production-safe boundaries:

```text
packages/storage
packages/jobs
packages/licence-registry
```

## 7. Reuse Matrix

| Area | Recovery 0 status | Reuse condition |
|---|---|---|
| Contracts | Reuse by refactor | Must become V2 product/domain contracts with documented source of truth. |
| Inspection | Reuse candidate | Must satisfy V2 intake, privacy and production error requirements. |
| Standard processors | Reuse candidate | Must pass visual, print/profile and production quality gates. |
| AI processors | Quarantine | Require model, weight, dependency, licence, quality and infrastructure approval. |
| PDF | Quarantine | Requires compatibility, differential, security and performance benchmark. |
| Vector | Reuse candidate | Requires output quality, profile and editor-capability validation. |
| Metrics | Keep | Use for benchmark/QA gates; do not make customer runtime depend on benchmark code. |
| Storage | Repair/extract later | Move production-safe storage policy into approved package/service boundary. |
| Jobs | Repair/extract later | Durable jobs must be integrated through approved architecture. |
| Licence guards | Reuse by extraction | Move production-safe checks out of `benchmark-runner`. |

## 8. Custom PDF Quarantine

The custom PDF engine is not production-approved.

Risks include:

- malformed xref recovery
- object streams and hybrid xref behavior
- incremental updates and linearized PDFs
- encrypted or password-protected PDFs
- signed and certified PDF behavior
- form, annotation, layer, tag and attachment preservation
- active content and JavaScript
- font embedding rights, subset fonts and substitution behavior
- redaction and hidden-data sanitisation
- large-document memory and performance behavior
- compatibility across common viewers, printers and preflight tools

Required approval benchmark:

- rights-cleared real-world PDF corpus
- differential behavior against established tools
- malformed/fuzz/security tests
- resource-limit and large-file tests
- signed-PDF protection and derivative labeling tests
- form/layer/font/tag preservation tests
- redaction byte-removal and sanitisation proof
- render comparisons across common viewers
- PDF/A, PDF/X, accessibility and print-preflight checks where claimed

## 9. Approved Target Architecture

Approved architecture direction:

- React + TypeScript owns the customer experience and browser-local work.
- NestJS owns identity, workspaces, projects, permissions, jobs, public API,
  e-sign orchestration, cloud connectors, audit and shadow pricing.
- Python owns image, AI, OCR and heavy processing workers behind versioned
  contracts and durable queues.
- PostgreSQL stores metadata and workflow state.
- Object storage stores originals, derivatives, previews, project packages,
  exports and evidence.
- Durable queues support continuation, retry, checkpointing and dead-letter
  handling.

Logical target shape:

```text
apps/
  web/
  workspace-legacy/
  browser-lab/
services/
  api/
  processing-worker/
  benchmark-runner/
packages/
  contracts/
  contracts-ts/
  processors/
  pdf/
  vector/
  metrics/
  storage/
  jobs/
  licence-registry/
docs/
  product-v2/
  recovery/
infra/
```

Recovery 0 does not create production placeholders or move folders.

## 10. Explicitly Deferred Work

Recovery 0 does not:

- move or rename `apps/workspace`
- edit `workspaces.toml`
- create React, NestJS or worker applications
- create empty production package placeholders
- remove or refactor runtime dependencies
- modify code, tests, processors, PDF logic, model files, infrastructure or
  runtime configuration
- install packages, download models/fonts, read `.env`, access private uploads
  or call cloud services
- start Recovery 1 or later

## 11. Rollback Procedure

Recovery 0 work is local until separate approval to push.

Rollback options:

1. If the commit has not been made, restore the permitted documentation files and
   remove untracked recovery files.
2. If the commit has been made but not pushed, revert the local Recovery 0
   commit or reset the recovery branch to the baseline commit after preserving
   any wanted files elsewhere.
3. If the annotated tag is wrong and has not been pushed, delete and recreate the
   local tag at the approved commit.
4. Do not rewrite remote history or delete remote tags without explicit product
   owner approval.

The verified baseline tag should remain the anchor for recovery comparison.

## 12. Recommended First Recovery 1 Task

Recommended first Recovery 1 task:

Create the production contract and architecture skeleton plan before application
implementation. The task should define versioned V2 contracts for projects,
assets, versions, jobs, exports, errors, provenance, storage references and
licence/release gates, plus architecture tests that prevent production code from
importing benchmark/POC runtime packages.

This task should not build customer features. It should create only the minimal
reviewable skeleton and tests approved for Recovery 1.
