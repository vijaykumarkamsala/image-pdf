# Recovery 2A: Product Kernel and Real Workspace Foundation

**Status:** Implemented locally; verification recorded below
**Branch:** `recovery/2a-product-kernel-workspace`
**Authority:** `docs/product-v2/PRODUCT_V2_CONSOLIDATED_IMPLEMENTATION_AUTHORITY.md`, section 21

## Outcome

A locally authenticated actor can idempotently resolve one personal workspace
and Default Files location, inspect effective permission origins, create and
view projects, view workspace files, register immutable original/source metadata,
move a file's canonical location without changing identity or references, and
observe audit and zero-charge usage records through the NestJS `/v1` API. The
responsive React application uses that API for onboarding, workspace Home,
Projects and Files.

## Contracts and persistence

- Production contract version: `1.7.0`; schema directory: `product-v1`.
- Benchmark schema `v1` and Recovery 1 contracts remain unchanged.
- PostgreSQL target major: 17, matching the approved Cloud SQL major.
- Migration: `services/api/migrations/0001_recovery_2a_product_kernel.sql`.
- Immutable: `asset_originals`, `source_versions`, `audit_events`, `usage_events`.
- Mutable canonical placement: `workspace_files` only.
- Reusable project/document links: `reusable_file_references`, independent of
  canonical placement.
- Customer bytes are not accepted or stored. Object references contain only
  key, digest, media type and size metadata.

## Security and policy evidence

- Every workspace query is membership-scoped; cross-tenant access returns 403.
- Mutations require `Idempotency-Key`; reuse with another payload returns 409.
- Audit and usage writes share the mutation transaction.
- Usage database checks and contracts fix customer amount to `0.00`, credit
  debit to `0`, and currency to `USD`.
- Admin usage dimensions are stored separately and omitted from customer APIs.
- Error envelopes hide unexpected exception text and return the request trace.
- Production startup fails closed without a PostgreSQL connection string.
- Local identity headers and the deterministic repository are development/test
  adapters, not production authentication.

New dependency licences were checked from the npm registry at their locked
versions: `pg` and `react-router-dom` are MIT, `lucide-react` is ISC,
`@playwright/test` is Apache-2.0 and `@axe-core/playwright` is MPL-2.0. They add
no model, font, media-codec or paid-provider rights dependency. `npm install`
reported zero known vulnerabilities.

## Verification evidence

The completed delivery ran:

```text
python tools/generate_product_contracts.py --check
npm run typecheck
npm run test
npm run build
npm run test:e2e --workspace ipw-web
npm run test:postgres --workspace ipw-api
python tools/check.py
git diff --check
```

The PostgreSQL integration gate used a fresh isolated PostgreSQL `17.11`
cluster, ran the migration twice, executed the repository journey, asserted
tenant isolation, immutable-row triggers, reusable-reference survival and
zero-charge constraints, then stopped the cluster. The gate does not use
`pg-mem` as compatibility evidence.

Playwright compares reviewed baselines at `1440x900`, `768x1024` and `390x844`
in light and dark themes with zero allowed changed pixels. The same suite checks
the real API journey, loading/error/access-denied/empty states, phone navigation
and axe accessibility scans.

The product-owner visual correction refreshes the six Home baselines only for
the non-monetary testing summary, customer-facing product-area descriptions,
quiet development-only inactive indicators and the resulting card height. Four
reviewed journey baselines were added for tablet Projects, phone navigation,
phone Default Files and desktop Projects with one created project. A second
zero-tolerance comparison passed for all ten baselines. Focus pixels are covered
separately by computed-style assertions: the visible brand focus token is not
the warning/error token in either theme. Collapsed tablet navigation also
retains explicit accessible names.

## Explicitly deferred

Image/PDF editing, processing, AI/models, fonts, cloud connectors, e-sign,
payments, production queues, native mobile applications and deployment are not
implemented. No legacy, benchmark, processor, PDF, vector, model or customer
upload evidence was modified or read.

## Known limitations

- Production OIDC/session validation is not connected; production remains
  fail-closed and local headers are for development/tests only.
- Object references are metadata only; no byte upload or object provider exists.
- Collection creation and permission-grant administration are contract/database
  foundations without customer UI in this increment.
- Retention execution, notifications and durable jobs remain later increments.
- The PostgreSQL gate proves major-version and SQL compatibility locally; it is
  not a deployment or Cloud SQL operational test.

## Rollback

1. Stop the local API/web processes.
2. Revert the logical Recovery 2A commits in reverse order on this branch.
3. For an isolated Recovery 2A database, drop the database. The migration is
   additive, but table-by-table down migration is intentionally not supplied
   because immutable production records must never be destroyed casually.
4. Return to Recovery 1 commit `04380e38acfd771e896899dd8ea858d93303e93b`.
5. Rerun `python tools/check.py` and verify the worktree state.

## Acceptance mapping

| Section 21.4 criterion | Evidence |
| --- | --- |
| Real NestJS metadata path | Playwright real-API journey and API integration tests |
| Effective permission origin | `WorkspaceContext.effective_permissions`; API assertion |
| One personal workspace and Default Files | unique constraints plus idempotent bootstrap tests |
| Immutable original/new source version | contract, trigger and repository tests |
| Security-relevant audit events | transaction and API/SQL assertions |
| Zero customer amount and credit debit | contract literals, SQL checks and API assertions |
| React typed loading/empty/error/denied states | generated imports and Playwright coverage |
| Production/POC separation | architecture tests and workspace manifest |
| Existing/new gates pass | command evidence above |
| No Critical/High journey defect | unit, integration, visual and accessibility gates pass |
| Clean committed diff | checked after final logical commits |

## Recommended next increment

After product-owner approval, begin only the bounded Recovery 2B specification
defined by the current authority. Recovery 2A does not authorize that work.
