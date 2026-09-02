# Recovery 2D: Image & Graphic Studio Foundation

**Status:** Final bounded acceptance corrections implemented and deterministically
verified locally; product-owner approval remains open

**Branch:** `recovery/2d-image-graphic-studio-foundation`

**Exact baseline:** `origin/recovery/2c-production-web-intake` at
`1cdba82be9b67c01177d0906564d65a38ae7eedc`

**Original Recovery 2D record:** `c2c75160b5e68069e6eec00f7d0af36313827081`

**Prior corrected record:**
`277f678` (`docs: correct Recovery 2D completion record`)

**Final acceptance implementation before this amended record:** `ff53653`,
`dfa9277`, `63b5523` and `851dc37`

**Authority:** The approved Recovery 2D prompt, the Product V2 Consolidated
Implementation Authority, the accepted independent-audit corrective prompt
dated 1 September 2026 and the final bounded acceptance-correction prompt dated
2 September 2026

## Correction history and verdict

The independent audit classified Recovery 2D at `c2c7516` as materially
incomplete. The original record accurately described the initial foundation,
but overstated customer usability for durable autosave, tenant-safe takeover,
document discovery, large-source previews, native layer semantics, actual panel
behavior and visual/integration evidence.

Ten corrective commits resolve those findings before this amended record:

1. `a99a115` - secure tenant-scoped leases, transactions and migration locking.
2. `5f01012` - durable IndexedDB autosave, tab coordination and takeover UX.
3. `88c3089` - native-document discovery, location and reopen journeys.
4. `af39b15` - bounded durable preview jobs, derivatives and provenance.
5. `aef9653` - complete supported native semantic behavior.
6. `568a6fe` - complete actual Studio panel and input behavior.
7. `f9e797b` - prove the real stack and reviewed light/dark visual states.
8. `f7e1628` - segregate intake/preview storage capabilities and restore strict
   worker typing.
9. `73e2d4d` - restore complete Python formatting and lint gates.
10. `0fd14fd` - fix native-document empty-list semantics and reconcile reviewed
    responsive visual evidence.

The next acceptance audit identified five narrower gaps: real-repository lease
security evidence, durable cross-tab journal ordering, authoritative source
facts for preview eligibility, asynchronous renderer races and save-drain/lease
release coordination. Four additional implementation commits resolve those
findings:

1. `ff53653` - bind previews to immutable inspection facts and prove lease
   isolation against PostgreSQL.
2. `dfa9277` - allocate durable journal sequence numbers and coordinate one
   authoritative save drain.
3. `63b5523` - settle only the latest renderer generation and correct the
   multiple-artboard visual proof.
4. `851dc37` - expose queued editor saves synchronously and stabilize the full
   ordered browser gate without weakening assertions.

Final local verdict: the bounded Recovery 2D scope and these five acceptance
corrections are implemented and verified. This is not approval for production
release, final export, advanced professional-format import, live providers or a
later recovery sequence.

## Customer outcome

A signed-in customer can create a blank graphic or create from an accepted,
Studio-compatible immutable raster source; edit a native document; recover
pending edits after refresh or reconnect; use bounded undo/redo and named
versions; restore by creating a new forward version; save an independent copy;
and find or reopen native documents from Home, Files, Projects and Search.

The responsive Studio provides real dock/float/move/resize/collapse/pin,
close/reopen and reset behavior on desktop, adapted docks/drawers on tablet and
a simplified phone review/light-correction surface. The rendered canvas is a
non-authoritative browser preview. No final export, enhancement, AI, OCR, PDF
product, connector, e-sign, billing, native app or deployment is claimed.

## Capability classification

### Fully customer-usable in the deterministic Recovery 2D environment

- Blank native documents in Default Files or a permitted project.
- JPEG, PNG and WebP source-based documents after the existing accepted,
  malware-clean intake journey.
- Multiple artboards with selected-artboard targeting, independent dimensions,
  units, orientation and backgrounds.
- Rectangle, ellipse, line, polygon, safe internal vector path, approved-font
  rich text, raster and group layers.
- Deterministic ordering, same-artboard hierarchy, visibility, locking,
  opacity, supported blend modes and native transforms.
- Multiple authorized raster assets, linked/independent instances,
  non-destructive crop and supported visual adjustments.
- Shared-style link, propagation and detach semantics.
- Shape masks with enable, invert and rectangle/ellipse editing.
- Autosave recovery, explicit conflict choices, undo/redo, named versions,
  forward-only restore and Save As.
- Tenant-scoped renewable leases, enforced read-only state, request/deny,
  controlled acquisition after release and owner/admin force takeover.
- Home, Default Files, Project and Search discovery/reopen.
- Durable large-source preview preparation, progress, retry, cancellation and
  failure states through PostgreSQL jobs/outbox and the Python worker.

### Supported but intentionally bounded

- Rich text supports deterministic approved fonts, editable content, size and
  bounded formatting runs. It is not a complete typography/layout engine.
- Internal vector paths use a validated safe command subset. External SVG is
  fail-closed and produces compatibility information.
- Masks are rendered and editable through initial shape operations; freehand
  painting and advanced mask workflows are outside Recovery 2D.
- Groups act as one transform/visibility/lock/opacity/order unit and ungroup
  preserves placement; advanced component/symbol semantics are not claimed.
- Browser rendering supports the documented initial blend modes and adjustment
  preview. Unsupported values fail validation instead of degrading silently.
- Phone is a review and lightweight-correction experience, not the desktop
  floating-panel workspace compressed into a small viewport.

### Model-only extension points

- Variants and future brand discriminators.
- Tables, sections, layouts, PDF objects, interactive fields and other future
  layer discriminators not presented as usable controls.
- PSD and AI-compatible source kinds for future compatibility reporting only.

### Deferred

- Final export/render approval, Image enhancement, Recreate, generative fill,
  OCR, Create PDF, Edit PDF and custom PDF-engine promotion.
- Editable external SVG, PSD or AI import.
- Advanced typography/font pipeline, mask painting and professional guides.
- Region/version comments, approvals, sharing, presence and real-time
  multi-user canvas editing.
- Cloud connectors, e-sign, payments, native mobile applications and
  deployment.

### Unverified live-provider behavior

- Live OIDC, GCS, Cloud Tasks and ClamAV compatibility remains a release gate.
- The deterministic acceptance uses private local object storage, a
  PostgreSQL-backed outbox bridge and local Python workers. It does not claim
  live-provider approval.

## Architecture and native authority

ADR-0014 selects Fabric.js 7.4.0 as a replaceable browser rendering and pointer
adapter after comparing Fabric, Konva and PixiJS. `EditorRenderer` is the
application boundary; only `FabricEditorRenderer.ts` imports Fabric. Python
contracts and PostgreSQL native snapshots remain authoritative. Fabric JSON is
never persisted or accepted through the API. Architecture tests prevent
production imports from legacy, benchmark, POC processor, PDF and model-weight
code.

Product schema version is `1.17.0`. Python is the source of truth; all 75 JSON
schemas and generated TypeScript match it. The model validates finite
transforms, unique deterministic sibling order, same-artboard hierarchy,
cycles, assets, styles, masks, supported blends/fonts and safe internal paths.
Atomic group/ungroup, asset add and style upsert/detach operations are part of
the native mutation contract.

The immutable `AssetOriginal` and `SourceVersion` identities are referenced,
never rewritten. Canonical WorkspaceFile location remains separate from
reusable document/project references. Crop, adjustments, masks, restoration,
Save As and preview generation do not mutate or recompress the source.

## Persistence, transactions and API

Recovery 2D uses four additive migrations:

- `0014_recovery_2d_native_documents.sql` creates documents, append-only
  versions/operations, bounded history, leases and compatibility reports.
- `0015_recovery_2d_corrective_foundation.sql` adds durable lease events,
  takeover state and corrective constraints compatible with existing data.
- `0016_recovery_2d_preview_jobs.sql` adds preview job targets, append-only
  preview provenance and derivative references.
- `0017_recovery_2d_acceptance_integrity.sql` preserves immutable provider
  generation, stores append-only inspected source facts and binds preview
  provenance to authoritative inspected dimensions and storage generation.

Migration runners take a PostgreSQL advisory lock. Repository commands use
transactions and per-idempotency advisory locks. Document mutation, operation,
audit, zero-charge usage and idempotency records commit atomically. Retry cannot
leave a document edit without its required audit/usage evidence.

The NestJS boundary under `/v1/workspaces/:workspaceId/documents` exposes:

- `GET /`, `POST /`, `GET /studio-sources`, `GET /:documentId` and
  `PATCH /:documentId`;
- `POST /:documentId/assets` and
  `GET /:documentId/assets/:sharedAssetId/source`;
- `POST /:documentId/lease`, `/lease/heartbeat`, `/lease/release`,
  `/lease/takeover`, `/lease/takeover/deny` and
  `/lease/takeover/force`, plus `GET /:documentId/lease`;
- `POST /:documentId/undo`, `/redo`, `/versions`,
  `/versions/:versionId/restore` and `/save-as`;
- `PATCH /:documentId/location`;
- `GET /:documentId/compatibility-reports` and `/source`.

Every lease transition first resolves the document through the authenticated
workspace and uses a tenant-authoritative join with transactional row locking.
Guessed cross-tenant IDs return no lease identity or metadata. Request and force
takeover are separate; force requires the approved owner/admin permission.
Request, denial, expiry, release and force transitions are durable and audited.

## Durable autosave and collaboration behavior

The browser stores an ordered pending-operation journal in IndexedDB, scoped by
actor, workspace and document. A per-scope sequence is allocated atomically in
the same IndexedDB transaction as each entry, so equal timestamps and competing
tabs cannot reorder operations. Entries contain native operations, base version
and revision, operation ID, idempotency key and trace context. Legacy entries
are upgraded deterministically only when base continuity is unambiguous;
ambiguous or divergent histories fail safe for explicit recovery. Journal data
never contains credentials, signed URLs or source bytes. Failed saves retry with
bounded exponential backoff and explicit Retry, reload current, Save As
recovered copy and review/reapply choices.

Pending operations replay by durable sequence and base continuity after
refresh/reconnect only after actor/workspace validation. They are not silently
discarded. All callers share one in-flight drain promise. Normal close waits for
acknowledged saves before releasing the lease where browser lifetime permits;
failed drains preserve recoverable entries and rely on safe lease expiry rather
than releasing unsent work. Release is issued at most once. Heartbeat is
independent of edits and continues during a drain. BroadcastChannel plus a
storage-event fallback coordinates tabs, and same-actor tabs cannot silently
reuse or replace each other's token. Logout and
retention cleanup clear private journals and the cross-tab logout regression is
covered.

When another editor holds the lease, all mutations, pointer transforms,
keyboard changes, undo/redo and restoration are disabled. Viewing, navigation,
zoom, version inspection and explicitly independent Save As remain. A takeover
request is durably visible to the active editor, who may deny or save and
release. The requester polls for controlled acquisition without a page refresh.

## Large-source and derivative architecture

The centralized Studio policy advertises only JPEG, PNG and WebP as editable.
Other intake-supported files remain safely stored and receive a truthful
compatibility result; TIFF, HEIF/HEIC, AVIF, SVG, PSD and AI are not advertised
as editable Studio inputs.

The measured synchronous browser policy is all of:

- compressed source no larger than 12 MiB;
- decoded raster no larger than 24,000,000 pixels;
- largest dimension no larger than 8,192 pixels;
- browser texture edge no larger than 8,192 pixels.

Exceeding any synchronous criterion creates a durable `preview_generation` job,
job event and transactional outbox record. The editor shows Preparing,
progress, retry, cancellation and failure states and can be left/reopened while
work continues. It does not request or decode the full source before a safe
preview is ready.

The Python processor requires an append-only inspection record bound to the
exact workspace, `AssetOriginal`, `SourceVersion`, object reference, SHA-256 and
provider storage generation. It rejects missing, mismatched, unverified or
dimensionless facts; document/artboard dimensions never determine source
eligibility. The processor then verifies immutable byte count and SHA-256 before
decode, supports at most 100 MiB compressed, 100,000,000 decoded pixels and a
50,000 px dimension, and applies Pillow's decompression-bomb boundary. It emits PNG
workspace (maximum edge 2,048) and thumbnail (maximum edge 512) derivatives
through the object-storage abstraction. Each append-only provenance record
links source/document versions, processor/version, authoritative inspected
source dimensions and generation, output dimensions, color and
metadata decisions, checksums, object reference, job/trace IDs and creation
time, and is explicitly non-authoritative.

## Renderer and professional workspace

Fabric readiness is awaited before state capture. Each render receives a
generation and abort token. Superseded asset work is cancelled or ignored, and
only the latest snapshot, active artboard and selection may update the canvas.
Disposed renderers cannot publish state, and a deterministic settled signal is
used by interactions and screenshot capture. The adapter renders approved
raster adjustments/crop, rich-text runs and font fallback, rectangle/ellipse/
line/polygon, internal paths, masks, clipping and group hierarchy. Artboards
clip their content and new content targets the active artboard. Source delivery
uses same-origin authorized endpoints, and browser acceptance reads canvas
pixels successfully; a tainted canvas fails the test.

The actual Studio implements dock, float, pointer move/resize, collapse,
close/reopen, pin and reset. Layout is scoped by actor, workspace and editor
profile and clamped when the viewport changes. Pointer selection, move, visible
resize handles, rotation, keyboard nudging, zoom, pan, fit and snapping with
visible feedback are exercised. Rulers remain foundations; misleading guide
controls are not presented as complete guide support.

## Discovery and reopen

Native documents are distinct from Source and Derivative customer objects.
Home recent work, Default Files, project contents and workspace Search display
document name, type, updated time, location and a bounded thumbnail state.
Customers can leave and reopen without retaining a URL, find Save As copies and
move canonical document location without changing source or reusable reference
identity. Loading and empty states are explicit.

## Corrective audit resolution matrix

| Audit finding | Resolution | Evidence |
| --- | --- | --- |
| Tenant-unsafe lease reads/writes and takeover races | Resolved | `a99a115`; tenant joins, row locks, replay and real PostgreSQL guessed-ID/simultaneous takeover tests |
| Autosave was memory-only and cross-tab behavior incomplete | Resolved | `5f01012`; journal, tab coordinator, durable session and refresh/offline/conflict/logout tests |
| Read-only/takeover controls were not globally enforced | Resolved | `5f01012`; disabled controls/keyboard/pointer/history plus durable takeover flows |
| Native documents were not discoverable | Resolved | `88c3089`; Home/Files/Project/Search repository, API and browser journey |
| Large sources lacked durable preview derivatives | Resolved within bounded limits | `af39b15`; migration 0016, Python preview worker, provenance and real-stack test |
| Layer discriminators exceeded executable semantics | Resolved for supported initial semantics | `aef9653`; native validators, atomic operations, renderer and API/browser tests |
| Studio panels/interactions existed mainly in a harness | Resolved | `568a6fe`; actual Studio panel and real pointer/keyboard/snap tests |
| Audit/usage/idempotency were not atomic for every mutation | Resolved | `a99a115`; transactional repository and rollback/replay PostgreSQL tests |
| Intake and Studio format claims drifted | Resolved | centralized JPEG/PNG/WebP policy and fail-closed compatibility reporting |
| Renderer timing, blank baselines and programmatic pointer proof | Resolved | `aef9653`, `568a6fe`, `f9e797b`; visible-control pointer and canvas-pixel tests |
| No real React to NestJS to PostgreSQL acceptance journey | Resolved | `recovery2d.real.spec.ts` on fresh PostgreSQL 17.11 and deterministic providers |
| Eight generic baselines did not cover required states | Resolved | 44 reviewed state baselines plus 8 inherited responsive baselines |

## Final acceptance resolution matrix

| Final finding | Resolution | Evidence |
| --- | --- | --- |
| Lease takeover isolation lacked service/repository proof | Resolved | `ff53653`; parameterized `DocumentsService` tests use the PostgreSQL repository and cover cross-workspace known IDs, captured/stale tokens, unauthorized force, replay and simultaneous takeover without metadata disclosure |
| Journal ordering depended on wall-clock time | Resolved | `dfa9277`; atomic per-scope IndexedDB sequence allocation, deterministic legacy handling and browser tests for equal timestamps, tabs, refresh, reconnect, conflict, divergent redo and logout |
| Preview eligibility trusted document dimensions | Resolved | `ff53653`; migration 0017, immutable inspection facts, worker fail-closed joins and PostgreSQL tests for forged artboards plus missing/mismatched facts |
| Asynchronous Fabric work could publish stale state | Resolved | `63b5523`; generation/abort handling, latest-only publication, disposal guard, settled signal and repeated dark/pending-render browser tests |
| Cleanup could race an existing save drain | Resolved | `dfa9277`, `851dc37`; shared drain promise, synchronous queued state, acknowledged-save-before-release, failed-journal preservation and single-release browser tests |

## Exact changed-file inventory

The original eight Recovery 2D commits changed the paths recorded by
`git diff --name-status 1cdba82..c2c7516`. The first-audit correction commits
and prior amended record changed the responsibility scopes below. The final
acceptance corrections add the exact paths recorded by
`git diff --name-status 277f678..851dc37`.

### Contracts and generated artifacts

- `packages/contracts/src/ipw/contracts/{__init__,editor,product_kernel,version}.py`
- `packages/contracts/tests/test_editor_contract.py`
- `packages/contracts-ts/src/generated/product.ts`
- all 75 files under `packages/schemas/product-v1/`

### API, persistence and migrations

- `services/api/migrations/0015_recovery_2d_corrective_foundation.sql`
- `services/api/migrations/0016_recovery_2d_preview_jobs.sql`
- `services/api/migrations/0017_recovery_2d_acceptance_integrity.sql`
- `services/api/src/domains/documents/` controller, service, types,
  memory/PostgreSQL repositories, model and format policy
- affected experience/job/intake/storage composition under
  `services/api/src/domains/`
- `services/api/src/kernel/migrations.ts`
- document, experience and PostgreSQL tests under `services/api/tests/`

### Browser editor

- `apps/web/src/editor/` durable session, atomic journal, shared single-flight
  drain, tab coordinator, native operations, renderer boundary and Fabric
  adapter
- affected `apps/web/src/App.tsx`, API client, operational experience,
  panel framework/layout and `styles.css`
- web unit tests and `apps/web/tests/e2e/workspace.spec.ts`

### Worker and storage

- `services/processing-worker/src/ipw/processing_worker/{preview,repository,task_server}.py`
- preview and PostgreSQL worker tests under `services/processing-worker/tests/`
- `packages/storage/src/ipw/storage/{boundary,private}.py` and storage tests

Final acceptance also changes intake/object-generation persistence and
inspection-fact propagation in the API and Python worker, plus their focused
PostgreSQL and storage tests. It does not alter customer source identity or use
artboard dimensions as source facts.

### Real-stack and visual evidence

- `apps/web/playwright.recovery2d.config.ts`, normal Playwright exclusion,
  configurable Vite API proxy and the `test:recovery2d` package script
- `apps/web/tests/e2e/{recovery2d.real,studioVisualStates}.spec.ts`
- 44 `apps/web/tests/__screenshots__/studio-state-*.png` baselines
- `tools/{run_local_processing_job,recovery_2d_acceptance_probe}.py`

### Records and decisions

- corrected `docs/adr/ADR-0014-native-editor-renderer-foundation.md`
- this amended Recovery 2D record

No legacy UI, benchmark runtime, PDF engine, model file, font, infrastructure or
deployment file was moved, promoted or integrated.

## Verification record

Executed on final implementation commit `851dc37` without `.env`, credentials,
customer files, cloud calls, model/font downloads or live providers:

- `python tools/check.py`: all 18 canonical gates passed. Gate durations were
  format 0.4s, lint 0.4s, types 3.5s, tests 303.4s, fixture integrity 1.2s,
  fixture reproducibility 0.4s, inspection 0.3s, TypeScript contract 1.1s,
  product contract 1.6s, canonical artifacts 0.9s, TypeScript typecheck/build
  28.0s, TypeScript tests 27.7s, web Playwright 433.7s, goldens 3.0s, schema
  drift 2.0s, licence 1.6s, model weights 2.0s and workspace manifest 1.2s.
- The canonical web gate passed all 96 Playwright tests in full-suite order.
  Web unit tests passed 35/35. Accessibility, keyboard, pointer, horizontal
  overflow, 44 px targets and zero-tolerance visual comparisons remained in
  the full gate.
- Fresh PostgreSQL database `ipw_2d_final_20260902` ran all 17 migrations on
  PostgreSQL 17.11. API PostgreSQL integration passed 4/4 with zero skips,
  including the real repository/service lease matrix. Python intake/preview
  integration passed 7/7 with zero skips.
- The lease matrix covered cross-workspace known document ID, captured token,
  stale cross-workspace token, same-workspace stale token, unauthorized force,
  no metadata disclosure, replay and simultaneous takeover. PostgreSQL row
  locks and persisted lease state remained authoritative.
- The real production-preview journey passed 1/1 against fresh database
  `ipw_2d_realstack_20260902`: React -> NestJS -> PostgreSQL -> transactional
  outbox -> deterministic Python intake/preview workers. PostgreSQL remained
  authoritative after dispatch; no database acceptance test was skipped.
- Focused journal, drain and renderer race tests passed both independently and
  in full-suite order. The prior desktop-dark semantic case passed three
  consecutive repetitions. The pending-render interaction and renderer
  disposal cases passed without sleeps or relaxed pixel thresholds.
- One environment-conditional Python skip remains in the canonical aggregate:
  the libvips-unavailable branch cannot execute when libvips is installed on
  this host. Fresh PostgreSQL and real-stack acceptance had no skips.
- `npm audit` and `npm audit --omit=dev` each reported the same two Moderate
  transitive `uuid <11.1.1` findings through the approved Google provider
  dependency chain. No forced override or audit fix was applied.

## Visual baseline inventory and accepted pixels

The visual inventory contains 87 reviewed baselines: 44 corrective Studio-state
images, eight responsive Studio images and 35 workspace/guest images.

Six of the original eight `studio-{viewport}-{theme}.png` baselines were
intentionally refreshed at 1440x900, 768x1024 and 638x768 in light and dark.
They now show real dock controls, selection affordances and panel content. The
390x844 light/dark Studio baselines remained unchanged.

The corrective delivery adds 44 reviewed `studio-state-*.png` baselines, light
and dark for every state:

- blank, selected text, selected vector, multiple artboards, Layers panel,
  group transform, History/named Versions and floating/moved/resized panel;
- imported raster, raster adjustments and rendered mask;
- read-only lease, takeover request, saving, failed save and offline pending;
- preview preparing, progress and failure;
- tablet 768x1024, intermediate 638x768 and phone review 390x844.

All 44 Studio-state images are new evidence. Nineteen existing workspace images
were intentionally refreshed because native documents are now visible in Home,
Projects, Search or navigation context, or because their overlays expose that
changed background. Together with the six Studio images, exactly 25 existing
baselines changed. Unaffected guest, intake, Jobs, Files, Projects and phone
Studio images remained byte-for-byte unchanged.

Accepted pixels show only the named customer state and theme. The review process
detected and removed one nondeterministic source-title race before commit by
entering a fixed document name. A later no-update run passed all 49 visual tests.
Original-resolution inspection confirmed nonblank dark/phone canvases, bounded
panels, visible state messaging, no horizontal overflow and no incoherent
overlap.

The final acceptance pass intentionally updated only these two existing files:

- `studio-state-multiple-artboards-1440x900-light.png` - 7,892 pixels differ.
- `studio-state-multiple-artboards-1440x900-dark.png` - 7,891 pixels differ.

Both changes show Artboard 2 as active and place the edited rectangle on
Artboard 2. The former stale Artboard 1 selection handles are gone while the
Properties panel still identifies the rectangle. All other reviewed baselines
remain unchanged, and comparison continues at zero pixel tolerance.

## Requirement matrix

| Requirement | Corrected result | Evidence or boundary |
| --- | --- | --- |
| A. Native document model | Delivered for supported initial types | Contract 1.17.0, 75 schemas, migrations 0014-0017 and semantic validators |
| B. Non-destructive editing | Delivered | Immutable source/hash proof, native crop/adjustment/mask/style data and derivative provenance |
| C. History, versions and autosave | Delivered | IndexedDB journal, bounded history, named versions, forward restore, conflict/replay tests |
| D. Concurrency boundary | Delivered | Tenant-safe leases, heartbeat/grace, read-only, request/deny/release/force and audit |
| E. Editor experience | Delivered within 2D bounds | Actual professional panel behavior and responsive phone/tablet experience |
| F. Canvas and renderer | Delivered within documented subset | Replaceable Fabric adapter, pointer controls, DPR/zoom, mask/group/vector pixels and nonblank visuals |
| G. API, persistence and jobs | Delivered with live providers unverified | NestJS/PostgreSQL/outbox/Python worker/local storage real-stack evidence |
| H. Import compatibility | Delivered truthfully | JPEG/PNG/WebP editable; unsupported formats preserved and fail closed |
| I. Feature/release exclusions | Delivered | Architecture guards and diff show no prohibited later product area |
| Research decision | Delivered | ADR-0014 and exact dependency/licence evidence |
| Required deterministic tests | Delivered locally | Real PG17, browser journey, accessibility, input, overflow, visual and repository gates |

## Known limitations and release gates

- External SVG, PSD and AI-compatible editable import are unavailable. Sources
  remain preserved and receive compatibility information.
- Final production export/render fidelity and approval are outside Recovery 2D.
- Rich typography, advanced masks, professional guides, comments/approvals,
  sharing/presence and real-time co-editing remain deferred.
- Live OIDC, GCS, Cloud Tasks and ClamAV compatibility checks remain release
  gates; local deterministic evidence is not a substitute.
- Two Moderate transitive `uuid <11.1.1` advisories through the approved Google
  provider dependency chain remain documented. No unsafe override is allowed.
- PWA platform presentation, complete custom-PDF compatibility/security/
  performance benchmark, and model licence/quality approval remain release
  gates.
- Fabric upgrades require native-model, renderer, coordinate, pointer,
  accessibility and visual regression. Fabric serialization must remain
  excluded from authoritative state.

## Rollback

1. Create a dedicated rollback branch and stop local API, web, worker and
   PostgreSQL processes.
2. Revert this amended record, then final acceptance commits in reverse order:
   `851dc37`, `63b5523`, `dfa9277` and `ff53653`. If reverting all audit
   corrections, continue with `277f678`, `0fd14fd`, `73e2d4d`, `f7e1628`,
   `f9e797b`, `568a6fe`, `aef9653`, `af39b15`, `88c3089`, `5f01012` and
   `a99a115`.
3. If the entire Recovery 2D scope must be removed, continue reverting the
   original Recovery 2D commits through `7ee9a44`. Do not rewrite approved
   Recovery 2C history.
4. Roll application code back before any separately approved data action.
   Migrations 0014-0017 contain additive document/version/audit/provenance and
   immutable source-inspection evidence; do not drop data without retention and
   rollback approval.
5. Rebuild generated contracts from the restored Python authority, clear only
   Recovery 2D public build/test artifacts and rerun the Recovery 2C contract,
   PostgreSQL and complete repository gates.

## Complete commit sequence

Original Recovery 2D commits:

1. `7ee9a44` - define the native editor document model and renderer ADR.
2. `001a440` - persist native editor documents in NestJS and PostgreSQL.
3. `eb704af` - harden native editor operations and identity behavior.
4. `021110e` - build the responsive native Image and Graphic Studio.
5. `bb37647` - keep restored PostgreSQL history within its durable bound.
6. `66d616a` - complete pointer, viewport, keyboard and responsive interactions.
7. `8abf37f` - enforce renderer/runtime and dependency-licence boundaries.
8. `c2c7516` - record the original completion claim later rejected by audit.

First-audit corrective commits:

9. `a99a115` - secure native document transactions.
10. `5f01012` - make autosave and leases durable.
11. `88c3089` - make native documents discoverable.
12. `af39b15` - add durable safe preview jobs.
13. `aef9653` - complete native semantic correctness.
14. `568a6fe` - complete professional Studio workspace behavior.
15. `f9e797b` - prove real integration and visual acceptance.
16. `f7e1628` - satisfy strict processing-worker capability boundaries.
17. `73e2d4d` - restore complete Python quality gates.
18. `0fd14fd` - align Studio accessibility and visual evidence.
19. `277f678` - correct the first-audit Recovery 2D completion record.

Final acceptance commits:

20. `ff53653` - bind preview facts and prove lease isolation.
21. `dfa9277` - sequence recovery and drain editor saves.
22. `63b5523` - settle only the latest Studio render.
23. `851dc37` - expose queued editor saves deterministically.
24. The commit containing this final amended completion record.

Recovery 2D remains local and paused for product-owner review. Nothing was
pushed, merged or deployed, and no later recovery sequence was started.
