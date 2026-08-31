# Recovery 2C: Production Web Foundation and Intelligent Intake

**Status:** Corrective implementation verified locally; product-owner review and
temporary-directory cleanup remain open
**Branch:** `recovery/2c-production-web-intake`
**Recovery 2C foundation:** `800d7f5a9cd74a7d819e63a280e8d62ec7e5d1c8`
**Corrective audit baseline:** `1bfdaeeb17a9724b559cf88067f5ac7ba1374666`
**Authority:** The approved Recovery 2C corrective prompt dated 31 August 2026,
under the Product V2 Consolidated Implementation Authority

## Customer outcome

Recovery 2C now provides a responsive customer web foundation in which a guest
can upload an image or PDF, observe durable intake, review truthful structural
facts, authenticate, and preserve the same immutable source in Default Files.
Signed-in customers have canonical Home, Projects, Files and Jobs routes backed
by real APIs, with durable search, notifications, job timelines and zero-charge
usage.

No editor, rendering feature, OCR, AI/model integration, connector, e-sign,
payment, native application or deployment was added.

## Corrective architecture and evidence

### OIDC, BFF sessions and logout

- `services/api/src/domains/identity/oidc.provider.ts` implements provider-neutral
  discovery, authorization-code exchange, JWKS verification, issuer/audience/
  nonce checks and a deterministic provider used only by tests.
- `AuthService`, `PostgresAuthRepository` and migration `0011` persist one-time
  hashed state/nonce, issuer-plus-subject identity mappings, hashed opaque
  application sessions, expiry, rotation, revocation and identity audit events.
- `IdentityController` exposes `/v1/auth/login`, `/v1/auth/callback`,
  `/v1/auth/session` and CSRF-protected `/v1/auth/logout`.
- Production uses Secure, HttpOnly, SameSite `__Host-` cookies and fails closed
  without valid OIDC/session configuration. Customer actor headers are rejected.
  The developer identity route is impossible to select in production.
- `apps/web/src/App.tsx` invokes real session/logout APIs, clears private browser
  state, informs other tabs and returns to Guest Home. Public shell and theme
  state may remain; private caches cannot.

`services/api/tests/auth.test.ts` is deterministic OIDC evidence. It is not a
claim that a live commercial identity provider has passed compatibility checks.

### Guest handoff and cross-tab coordination

- Guest authority is an HttpOnly cookie plus server state; no bearer credential
  is stored in browser storage or the public contract.
- The callback preserves a bounded return route and handoff reference. The
  authenticated handoff verifies guest ownership, consumes authorization once,
  writes transactionally, keeps AssetOriginal/SourceVersion identity unchanged,
  creates one Default Files location and revokes guest authorization.
- `apps/web/src/boundaries/crossTab.ts` uses `BroadcastChannel` with a storage-
  event fallback. Events contain only opaque IDs. Web Locks coordinate upload
  leadership, with a lease fallback where Web Locks are unavailable.
- Refresh, duplicate tabs and tab closure recover from server-owned upload state;
  stable finalisation idempotency prevents inconsistent duplicate completion.

Evidence is in `inspection-intake.test.ts`, `crossTab.test.ts` and the Playwright
guest handoff, duplicate-tab, interrupted-transfer and logout journeys.

### Workspace authority, jobs, notifications and search

- `/w/:workspaceId` is canonical. `useWorkspace` resolves that URL through
  membership-scoped context and workspace APIs before rendering any child route.
  `/app` redirects to a permitted canonical workspace.
- The selector appears only with multiple permitted workspaces and navigates to
  the selected canonical URL. Direct URLs, hard refresh, removed membership and
  cross-tenant IDs fail closed.
- `JobsPage` supports All, Active, Completed, Failed, Cancelled and Retryable
  views. A permitted `?job=<id>` immediately fetches the job and ordered events,
  preserves the view query and reports missing/wrong-workspace jobs safely.
- Migration `0012` projects notifications inside the authoritative PostgreSQL
  transaction for upload, job, retry, handoff and expiry transitions. Stable
  source keys plus conflict handling make projection idempotent. Reads never
  fabricate notifications.
- Notification reads are actor-scoped; API/UI pagination uses opaque cursors,
  deduplicates polling and announces appended records through `aria-live`.
- Search remains workspace-, membership- and permission-scoped on the server;
  unauthorized resources cannot enter results.

Primary evidence is `postgres-experience.repository.ts`,
`0012_recovery_2c_transactional_notifications.sql`, `OperationalExperience.tsx`,
`experience.test.ts`, `postgres.integration.test.ts` and `workspace.spec.ts`.

### Truthful intake, customer language and design system

- Product contract `1.12.0` adds `verified`, `likely` and `unknown` evidence
  labels. The retained compatibility field `confidence_percent` accepts only
  `null`; migration `0013` removes old numeric values and enforces that rule in
  PostgreSQL.
- A Likely classification includes explicit structural evidence and its limit.
  Safety, structure, quality observations, intended-use requirements and
  production readiness are separate. High resolution alone cannot imply visual
  quality, print suitability or production readiness.
- Customer correction changes classification only. It cannot mutate verified
  source facts, AssetOriginal or SourceVersion identity.
- Customer pages contain no delivery-recovery terminology, prices, credits or
  currency. The account menu reports the real session/workspace/role and signs
  out. Inactive outcome cards have no dead controls; only non-production builds
  may show `Not active in this build`.
- Shared buttons/dropzones are the sizing source. Phone interaction targets are
  at least 44 by 44 px. Shared modal semantics use a body portal, focus trap,
  Escape, focus return and viewport-bounded geometry. The panel harness retains
  pointer plus keyboard drag/resize coverage.
- One configurable provisional product-name source drives React, document
  metadata, accessible naming, manifest and offline output.

The source of truth remains Python contracts; 54 JSON schemas and generated
TypeScript match it. Contract, API, high-resolution, design-system, accessibility
and browser tests cover these behaviors.

### PWA, cache and CSP

- `PRODUCTION_CONTENT_SECURITY_POLICY` allows required first-party assets and
  the approved GCS upload origin without `unsafe-inline` or `unsafe-eval`.
  Vite built preview serves the CSP plus permissions, referrer, MIME and frame
  headers. Development HMR does not pretend to be the production CSP surface.
- `PrivateCacheMiddleware` applies `Cache-Control: no-store, max-age=0`,
  `Pragma: no-cache` and cookie/authorization variation across API responses.
- Worker cache `ipw-shell-2c-v2` contains public shell assets only. API, upload,
  authorization and signed-query traffic is bypassed. Activation deletes stale
  shell and private namespaces; logout removes private caches while retaining the
  public shell.
- The generated offline document has external CSS and no inline script/style.
  Offline/reconnection copy distinguishes interrupted local transfer from work
  already accepted by the server.
- Playwright builds React and runs `vite preview`. Manifest, start URL, scope,
  display mode, regular/maskable icons, worker control, update, stale-shell
  removal, offline fallback and deep-route refresh are executable checks.

## Contracts, migrations and routes

Product schema version: `1.12.0`. Generated product schema count: 54.

| Migration | Corrective purpose |
| --- | --- |
| `0008` | Intake classifications and customer correction history |
| `0009` | Durable experience records, notifications and indexes |
| `0010` | Guarded retry of the same preserved source |
| `0011` | OIDC transactions, identities, application sessions and identity audit |
| `0012` | Transactional, idempotent notification projection and backfill |
| `0013` | Evidence labels and database rejection of numeric confidence |

Customer API surfaces added or reconciled by Recovery 2C include identity,
workspace listing/context, guest and authenticated upload sessions, resumable
status/finalisation/handoff, intake presentation/correction, Home, Jobs/events/
cancel/retry, notifications/read state, search and feature-state routes. Their
controller decorators are the route source of truth; all state-changing browser
requests require CSRF and applicable idempotency/permission checks.

## Visual and accessibility evidence

All screenshots compare at `maxDiffPixelRatio: 0` against reviewed baselines.
The inventory now contains 33 states:

- Home and selected-upload at 1440x900, 768x1024, 638x768 and 390x844 in light
  and dark.
- Guest Home, Guest intake result, populated signed-in Home, mixed-state Jobs,
  open Search, paginated Notifications, offline state, account menu and the
  multiple-workspace selector.
- Projects at tablet and 638x768, phone Home/navigation, phone Default Files,
  a created project, verified intake, completed Jobs and notification center.

Accepted existing-baseline changes are explained by production-preview feature
state (development-only inactive indicators disappear), truthful intake labels
and sections, consolidated upload controls, the All Jobs view and viewport-
correct modal placement. The nine explicitly missing states are new baselines.
No accepted image contains internal terminology or horizontal overflow.

Axe runs on Search, notifications/pagination, account/logout, workspace
selection, guest intake, offline state and core routes. All passed. The separate
development-only panel harness passed pointer, keyboard, focus, persistence,
clamping and reduced-motion checks; it is not exposed by a production build.

## Verification record

Executed on 31 August 2026 without live provider calls:

- `.venv\Scripts\python.exe tools/check.py`: all 18 gates passed.
- Python gate: full suite passed at the repository's required 90% coverage.
- TypeScript typecheck/tests: passed for all npm workspaces.
- Production-preview Playwright: 60 passed, including 33 zero-tolerance visual
  comparisons. Development-only panel Playwright: 1 passed.
- PostgreSQL integration: 37 passed, 0 skipped against a fresh local PostgreSQL
  `17.11` database. Migrations `0001` through `0013` were listed after execution;
  migrations and repository journey were run twice where idempotency is required.
  pg-mem was not used as PostgreSQL evidence.
- Product contract generator: 54 schemas and generated TypeScript match.
- `git diff --check`: passed before this record; it is repeated before commit.
- `npm audit --omit=dev`: exits nonzero with two Moderate transitive advisories.
  `gaxios 6.4.0-6.7.1` depends on `uuid <11.1.1`
  (`GHSA-w5hq-g745-h8pq`). No forced override or audit fix was applied.

Sanitized PostgreSQL procedure:

1. Resolve `.tmp/postgres-2c-final` beneath the repository and verify port 55434
   is unused.
2. Initialize with installed PostgreSQL 17 binaries and trust auth on loopback.
3. Create synthetic database `ipw_recovery2c_final`.
4. Set `IPW_TEST_DATABASE_URL` for only the test process and run the API suite.
5. Query server version and `schema_migrations`; stop with `pg_ctl -D` against the
   exact data directory.

No credentials, `.env`, customer uploads or personal files were read.

## Temporary database cleanup

The exact authorized `.tmp/postgres-2c` target, and corrective/final synthetic
clusters created for this task, were resolved beneath the repository `.tmp`
directory. Each contains `PG_VERSION=17`, is neither repository nor `.tmp` root,
has only synthetic test provenance and was confirmed stopped with `pg_ctl`.

Two exact native PowerShell `Remove-Item -LiteralPath ... -Recurse -Force`
attempts were rejected by the execution environment before process creation.
No alternate shell or deletion bypass was used. Therefore these stopped ignored
directories remain:

- `.tmp/postgres-2c`
- `.tmp/postgres-2c-corrective`
- `.tmp/postgres-2c-final`

This is an explicit incomplete operational cleanup item, not a hidden production
runtime or customer-data gap.

## Remaining release gates

- Run compatibility checks against configured live OIDC, GCS, Cloud Tasks and
  ClamAV providers in the release environment. Deterministic official-client
  tests are not live-provider evidence.
- Resolve or formally accept the two Moderate transitive advisories without an
  unsafe dependency override.
- Confirm PWA icon/install presentation on target browser/platform combinations.
- Keep the custom PDF engine quarantined until its full compatibility,
  differential, security and performance benchmark passes.
- Keep installed model weights commercially blocked until licence and quality
  approval. No model was downloaded or integrated here.
- Complete the exact stopped test-directory removal in an environment that
  permits the already validated native PowerShell operation.

No Critical or High approved-scope product/runtime gap remains in deterministic
verification. Recovery 2C is not pushed, merged or deployed.

## Requirement-by-requirement self-audit

| Corrective requirement | Executable evidence | Result |
| --- | --- | --- |
| 1. Remove spoofable identity | OIDC provider/auth service/repository, `0011`, auth tests | Delivered; live OIDC is a release gate |
| 2. Real guest handoff | callback state, handoff repository/service, API and browser journeys | Delivered |
| 3. Logout/private state | revoked session, CSRF, cross-tab event, cache/browser clearing test | Delivered |
| 4. Cross-tab coordination | secure guest cookie, BroadcastChannel fallback, Web Locks/lease tests | Delivered |
| 5. Transactional notifications | `0012`, PostgreSQL triggers, stable keys, pagination/read tests | Delivered |
| 6. Canonical workspace | URL membership resolution, real selector, direct/refresh/tenant tests | Delivered |
| 7. Job deep links | immediate job/events fetch, workspace check, route-refresh tests | Delivered |
| 8. Truthful intake | contract `1.12.0`, `0013`, high-resolution and UI tests | Delivered |
| 9. Customer language/controls | account/workspace controls and customer-copy test | Delivered |
| 10. Design system | shared controls, 44 px scan, portal/focus and pointer tests | Delivered |
| 11. Brand configuration | one product config across runtime/build/offline/manifest | Delivered |
| 12. PWA/cache/CSP | preview headers, no-store middleware, worker lifecycle/install checks | Delivered |
| 13. Visual/accessibility | 33 reviewed baselines and required Axe states | Delivered |
| 14. Verification accuracy | production preview, deterministic OIDC, PostgreSQL 17.11, 18 gates | Delivered |
| 15. Safe temp cleanup | validation and stop passed; deletion blocked before execution | Partially delivered |
| 16. Documentation correction | This evidence-linked record | Delivered in final corrective commit |

## Rollback

1. Create a dedicated rollback branch and stop local API/web/PostgreSQL processes.
2. Revert the six corrective commits in reverse order, beginning with the commit
   containing this record, then `44dfe28`, `298f1ce`, `d9b27e3`, `ea2b2ff` and
   `ad3a688`. Do not rewrite published history.
3. Roll application code back before any separately approved data rollback.
   Migrations `0011`-`0013` are additive/evidence-bearing and should remain until
   retention and identity-audit impact is reviewed.
4. Clear `ipw-shell-2c-v2` when validating the rolled-back web build.
5. Re-run Recovery 2B gates, full repository verification and PostgreSQL
   migrations before preserving a rollback branch.

## Corrective commit sequence

1. `ad3a688` - secure Recovery 2C identity and guest handoff.
2. `ea2b2ff` - coordinate workspace recovery across tabs.
3. `d9b27e3` - project durable workspace notifications.
4. `298f1ce` - make intake evidence and customer UI truthful.
5. `44dfe28` - harden production web delivery and visual evidence.
6. The commit containing this final verification record.

Remain paused after Recovery 2C. Do not push, merge, deploy or begin Recovery 2D
without explicit product-owner approval.
