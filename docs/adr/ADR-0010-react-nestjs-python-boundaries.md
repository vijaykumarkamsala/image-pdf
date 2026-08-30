# ADR-0010 - React, NestJS and Python runtime boundaries

**Status:** Accepted for Recovery 1
**Date:** 30 August 2026
**Task:** RECOVERY-1
**Decision recorded:** Product V2 production foundation

## Context

Product V2 supersedes the earlier customer-looking POC application. Recovery 0
froze the legacy UI as evidence and approved a new production topology:

- React + TypeScript for the customer application
- NestJS for the control plane and public API surface
- Python workers for processing behind durable job and storage boundaries
- Benchmark-runner retained as development-only

Recovery 1 creates skeletons only. It does not implement customer journeys,
editors, storage providers, queues, billing, deployment or processor promotion.

## Decision

The production runtime boundary is:

```text
apps/web                 React customer shell
services/api             NestJS control-plane shell
services/processing-worker Python processing-worker boundary
packages/storage         storage protocols only
packages/jobs            durable-job protocols only
packages/licence-registry production-safe licence gate logic
```

The POC and evidence boundary is:

```text
apps/workspace-legacy
apps/browser-lab
services/workspace-api
services/benchmark-runner
packages/processors
packages/pdf
packages/vector
packages/metrics
infra/docker
```

Production workspaces may depend on `shared` workspaces and approved production
packages. They may not import from POC workspaces. This is enforced in
`tests/test_workspaces.py` and `tests/test_architecture_boundaries.py`.

The benchmark runner may depend on `packages/licence-registry` for compatibility
while the production-safe licence logic is extracted, but production code may
not depend on `services/benchmark-runner`.

## Consequences

- `apps/workspace-legacy` preserves the verified legacy UI history and remains
  non-production evidence.
- `apps/web` has an explicit V2 information-architecture shell and no editor
  feature implementation.
- `services/api` exposes health/readiness endpoints with trace propagation and
  placeholder domain modules only.
- `services/processing-worker` can run a deterministic fake processor through
  versioned contracts, cancellation and checkpoint boundaries.
- Storage, jobs and licence packages are interfaces/foundations only. No cloud
  services are called and no provider implementation is approved.

## Deferred

- React product features and visual-production workflows are Recovery 3+.
- Identity, workspaces, storage, jobs and shadow usage ledger are Recovery 2.
- Model, processor, PDF and font promotion require later licence, quality,
  compatibility and security gates.
- Production deployment and infrastructure wiring are not part of Recovery 1.
