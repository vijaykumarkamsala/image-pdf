# Recovery 2C: Production Web Foundation and Intelligent Intake

**Status:** Implemented locally; verification recorded below
**Branch:** `recovery/2c-production-web-intake`
**Baseline:** `800d7f5a9cd74a7d819e63a280e8d62ec7e5d1c8`
**Authority:** Sequence C of `docs/product-v2/PRODUCT_V2_CONSOLIDATED_IMPLEMENTATION_AUTHORITY.md` and the approved Recovery 2C task dated 31 August 2026

## Customer outcome

Guests now land on the real public product home, can upload images or PDFs,
observe the durable intake job and verified source facts, and sign in to preserve
the same immutable accepted source in Default Files. Signed-in customers receive
a responsive Home built from real projects, accepted files, attention states,
jobs, notifications and zero-charge usage. The only signed-in destinations are
Home, Projects, Files and Jobs.

No image/PDF editor, rendering operation, OCR, AI/model integration, connector,
collaboration, e-sign, charging, native application or deployment was added.

## Authority and reconciliation

- Product V2 authority and the approved Recovery 2C prompt supersede older POC
  and legacy UI behavior.
- The V2 visual references remain documentation evidence only. Production React
  does not import or copy their HTML.
- Product contract `1.10.0` remains additive under the `product-v1` compatibility
  line. Benchmark contracts and benchmark/legacy evidence remain untouched.
- ADR-0013 is corrected to reflect the delivered narrow migrations rather than
  describing them as one migration.

## Delivered foundation

### Design and responsive shell

- Semantic light/dark/system tokens, visible brand focus, typography, spacing,
  controls, overlays, status surfaces and truthful loading/error/offline states.
- Configurable provisional product naming through `VITE_PRODUCT_NAME`.
- Desktop sidebar, tablet rail, phone header/sheet and four-item bottom navigation
  with no horizontal overflow at 1440x900, 768x1024, 638x768 or 390x844.
- Four equal parent outcomes are server-authoritative and inactive. No editor is
  presented as available.

### Intelligent intake

- Server-derived source identity, dimensions/pages, media facts, risk dimensions,
  explainable classification and recommendation presentation.
- Customer correction changes classification only, is idempotent and audited,
  and never mutates verified facts or immutable source identity.
- Preview is safety-gated. PDFs use a generic representation because production
  PDF rendering remains quarantined.

### Home, Jobs, notifications and search

- Home aggregates real recent work, attention, active/recent jobs, notifications
  and zero-charge usage.
- Jobs supports active, completed, failed, cancelled and retryable views, opaque
  keyset pagination, ordered timelines, reconnect polling, cancellation and
  guarded manual retry of the same preserved source.
- Notifications are durably materialized from upload, job, retry, guest-handoff
  and expiry facts. Read state is actor scoped, idempotent and audited.
- Debounced app-wide search covers only projects, files and jobs permitted in the
  requested workspace. Results are server-filtered and keyset paginated.

## Contracts, schema and APIs

Product contracts add JobList, NotificationRecord/List, WorkspaceSearchResult/
Page, RecentWorkItem, AttentionItem, WorkspaceHome and FeatureStateRecord/List,
plus explicit job-retry, notification and search permissions. Fifty-three JSON
schemas and the generated TypeScript view match the Python source of truth.

| Migration | Purpose |
| --- | --- |
| `0008_recovery_2c_intake_classification.sql` | Persist immutable-fact-linked classification and correction history |
| `0009_recovery_2c_experience.sql` | Durable notifications/read state, experience idempotency and projection indexes |
| `0010_recovery_2c_manual_retry.sql` | Narrow rejected-to-finalising retry transition with immutable-field defense |

| Method and route | Behavior |
| --- | --- |
| `GET /v1/workspaces/:workspaceId/home` | Permission-scoped real Home aggregation |
| `GET /v1/workspaces/:workspaceId/jobs` | Filtered, keyset-paginated workspace jobs |
| `GET /v1/jobs/:jobId/events` | Ordered, permission-scoped timeline |
| `POST /v1/jobs/:jobId/retry` | Idempotent same-job/same-source guarded retry |
| `GET /v1/workspaces/:workspaceId/notifications` | Ordered actor-aware notifications |
| `POST .../notifications/:id/read` | Idempotent audited read mutation |
| `POST .../notifications/read-all` | Idempotent audited bulk read mutation |
| `GET /v1/workspaces/:workspaceId/search` | Tenant- and permission-filtered search |
| `GET /v1/workspaces/:workspaceId/features` | Server-authoritative visible feature state |
| `GET /v1/upload-sessions/:id/intake-presentation` | Verified facts and current classification |
| `PUT /v1/upload-sessions/:id/classification` | Idempotent correction without source mutation |

PostgreSQL remains authoritative for production. Memory repositories remain
deterministic local/test adapters and production composition fails closed when
the PostgreSQL boundary is absent. Workspace job access checks membership and
permission before returning data; mutation still targets the original job owner
while audit records the acting member.

## Panel framework and PWA

The panel framework is available only at the non-production internal harness
`/internal/panels`. It supports left/right/bottom docking, floating detach,
pointer and keyboard movement/resizing, pin, collapse, permitted close, focus
return, reset, versioned local persistence, corruption recovery and viewport
clamping. Tablet uses overlay/sheet geometry and phone uses one full-screen
focused panel. Reserved contract slots exist for future tools and conversation;
no editor controls or document model exist.

The web build emits a configurable manifest, regular/maskable icons, a versioned
service worker and an offline document. The worker caches only public shell
assets, uses controlled activation and stale-shell eviction, and bypasses API,
authorization, upload, signed-query and customer-file traffic. Logout cache
clearing is an explicit exported boundary. Offline copy distinguishes resumable
local transfer state from work already accepted by the server.

## Security, privacy and charging

- Existing immutable-original, malware, checksum, byte-count, retention and
  quarantine gates remain unchanged.
- New reads are workspace and permission scoped. Mutations require independent
  permissions, idempotency keys and trace IDs and create audit records.
- Cursors contain only ordering keys. Advanced UI details expose opaque IDs and
  sanitized trace references, never tokens, signed URLs or storage paths.
- No private API response or customer bytes enter the service-worker cache.
- Customer usage remains zero-charge and non-monetary. The UI exposes no prices,
  credits or currency.

## Visual review

Reviewed zero-tolerance baselines cover Home and selected upload at all four
approved viewports in light and dark themes. Additional baselines cover verified
intake, completed Jobs, phone notifications, Projects, Default Files and phone
navigation.

Accepted pixel changes are limited to:

- Search and notification controls in the header.
- Jobs as the fourth desktop/tablet/phone navigation destination.
- Real Home attention, Jobs and notification sections below the outcome area.
- Data-backed file/job counts in the testing summary.
- The intentionally added intake, Jobs and notification state baselines.
- A phone notification anchor correction that constrains the popover to 8 px
  viewport insets.

No baseline tolerance is used: `maxDiffPixelRatio` remains `0`.

## Verification evidence

- Product contract drift: 53 schemas match generated TypeScript.
- Focused Product contracts: 13 passed.
- React unit tests: 17 passed.
- NestJS deterministic tests: 29 passed, 1 PostgreSQL test separately gated.
- Playwright nonvisual journeys: 21 passed with axe zero violations.
- Playwright visual comparisons: 24 passed with zero pixel tolerance.
- PostgreSQL 17: all migrations and the Recovery 2C repository journey passed
  against a fresh local PostgreSQL 17 database; pg-mem was not used as evidence.
- Production React build emits the app, manifest, service worker, offline page
  and icons successfully.
- Built-preview browser smoke: `/`, `/guest/upload` and `/app` returned 200,
  survived hard refresh and rendered expected customer headings; `/app` resolved
  through the local API bootstrap to its generated workspace route.
- `git diff --check`: passed.
- Complete `tools/check.py`: all 18 gates passed, including Python coverage,
  TypeScript checks, deterministic Playwright comparisons and repository guards.

`npm audit --omit=dev` reports the two accepted moderate transitive advisories:
`gaxios` depends on an affected `uuid <11.1.1`. The command exits nonzero. No
unsafe dependency override or forced audit fix was applied.

## Known limitations and release gates

- Live GCS, Cloud Tasks and ClamAV provider compatibility checks remain required
  before release; no cloud service was called in Recovery 2C.
- The two moderate `gaxios`/`uuid` advisories remain a documented release gate.
- Jobs and notifications use ordered polling; provider-independent event
  contracts allow a later transport without changing domain truth.
- The hidden panel framework has no editor content. The custom PDF engine and all
  model weights remain quarantined under their existing approval gates.
- PWA install prompts and SVG icon presentation depend on browser/platform
  support. No native-mobile package was created.

## Rollback

1. Stop local web/API processes and any local PostgreSQL test instance.
2. Revert the six Recovery 2C commits in reverse order on a new rollback branch.
3. Roll application code back before removing database objects. Migrations are
   additive; leave `0008`-`0010` data in place unless a separately reviewed data
   rollback explicitly confirms no retained notification/classification evidence
   is required.
4. Clear the `ipw-shell-2c-v1` service-worker cache or unregister the worker when
   validating the rolled-back web build.
5. Re-run Recovery 2B verification and PostgreSQL migration checks.

## Acceptance mapping

| Approved Recovery 2C requirement | Evidence | Result |
| --- | --- | --- |
| Production design system | Semantic tokens/components, theme/focus/axe tests | Delivered |
| Public guest Home and handoff | `/`, real upload/job/facts/sign-in-save Playwright journey | Delivered |
| Signed-in shell and real Home | `/w/:workspaceId`, Home API and aggregation tests | Delivered |
| Intelligent intake presentation | `IntakeFacts`, `0008`, correction API/tests | Delivered |
| Jobs and notifications | Durable APIs, `0009`-`0010`, UI and retry/read tests | Delivered |
| Permission-aware search | Typed search API/UI, debounce/keyset and isolation tests | Delivered |
| Editor panel framework only | Hidden internal harness and layout tests | Delivered |
| PWA and offline truthfulness | Manifest/SW/offline/cache lifecycle tests | Delivered |
| API/data support only as required | No speculative editor/collaboration/billing tables | Delivered |
| Responsive web, no native workspace | Four viewport baselines and overflow tests | Delivered |
| Security, audit, idempotency, zero charge | API/PostgreSQL tests and cache allowlist | Delivered |
| Excluded Recovery 2D+ work | No editor, AI, connector, e-sign, payment or deployment | Preserved |

## Commit sequence

1. `d6be9af` - establish Recovery 2C web design system.
2. `17b6a52` - build guest and signed-in workspace shells.
3. `cfd8421` - present verified intelligent intake facts.
4. `18e8e46` - add durable workspace operations.
5. `57bfc09` - add panel framework and safe PWA shell.
6. Final verification commit - baselines, evidence and this recovery record.

Remain paused after Recovery 2C. Do not begin Recovery 2D, merge, push or deploy
without explicit product-owner approval.
