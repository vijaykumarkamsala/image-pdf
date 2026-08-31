# Recovery 2D: Image & Graphic Studio Foundation

**Status:** Implementation and deterministic verification complete locally;
product-owner visual and product review remain open

**Branch:** `recovery/2d-image-graphic-studio-foundation`

**Exact baseline:** `origin/recovery/2c-production-web-intake` at
`1cdba82be9b67c01177d0906564d65a38ae7eedc`

**Verified implementation before this record:**
`8abf37f0ee41db37aa387935898e6932400be684`

**Authority:** The approved Recovery 2D prompt dated 31 August 2026 under the
Product V2 Consolidated Implementation Authority

## Customer outcome

Recovery 2D activates Image & Graphic Studio as the first real native editor
journey. A signed-in customer can start a blank graphic or open a verified
raster source, preserve that immutable source, create a native document, edit
artboards and layers, use non-destructive crop and visual adjustments, autosave,
undo or redo, create and restore versions, recover after refresh, and Save As to
Default Files or a permitted project.

The responsive Studio has a command bar, canvas, artboard navigator, layers,
assets, history/version and property/tool panels, All Tools search, keyboard
commands, light/dark themes and focused tablet/phone layouts. It is explicitly a
browser preview of the authoritative native document. No final export,
enhancement, AI, OCR, PDF product, connector, e-sign, billing, native app or
deployment capability is claimed.

## Architecture decision

`docs/adr/ADR-0014-native-editor-renderer-foundation.md` compares Fabric.js
7.4.0, Konva 10.3.0 and PixiJS 8.18.x using current primary sources. It records
licence/commercial standing, maintenance, React/TypeScript integration,
accessibility, supported objects, performance, serialization, mobile/browser
constraints, export limits and lock-in.

Fabric.js 7.4.0 is selected as a replaceable browser rendering and pointer-
interaction adapter. `EditorRenderer` is the application boundary; only
`FabricEditorRenderer.ts` imports Fabric. Native Product V2 contracts and
PostgreSQL snapshots are authoritative, and no Fabric serialization enters the
contract, API model or migration. Architecture guards enforce those boundaries
and prevent editor runtime imports from legacy, benchmark, POC processor, PDF or
model-weight code.

The exact package is locked with registry integrity. Fabric and the three
transitive packages whose SPDX identifiers needed explicit treatment are
recorded in `data/licences/production-editor.json`. All are permissive; the two
dual-licence expressions select an approved option. The full Node lockfile
licence gate passes.

## Contracts and native model

Product schema version is `1.13.0`. Python remains the source of truth;
generated TypeScript and all 73 JSON schemas match it. Nineteen editor schemas
are new and the existing 54 product schemas were deterministically regenerated.

The native model provides:

- workspace/project/default-files document location and stable document IDs;
- independent artboards with dimensions, units, orientation, background and
  intended-use metadata;
- raster, SVG/vector, rich-text, shape and group layer discriminators plus
  extension points for adjustments, masks, PDF objects, tables, sections,
  layouts and interactive fields;
- stable layer IDs, order, parent nesting, visibility, lock, opacity, blend-mode
  placeholder and transforms;
- linked or independent shared assets, styles and variants;
- editable crop, rotate, flip, brightness/exposure, contrast, saturation,
  temperature, tint and sharpness state;
- editable mask records and layer references;
- native operations, read models, versions, leases, compatibility reports and
  non-authoritative preview provenance.

The source AssetOriginal and SourceVersion IDs are copied only as immutable
references. Moving a WorkspaceFile or using Save As does not change those source
identities. Rendering never mutates or recompresses the original.

## Persistence and API

Migration `0014_recovery_2d_native_documents.sql` adds:

- `editor_documents`;
- append-only `document_versions`;
- append-only `document_operations`;
- bounded `document_history_entries`;
- `document_leases` with hashed tokens;
- append-only `import_compatibility_reports`;
- supporting indexes and the schema migration record.

Memory and PostgreSQL repositories implement the same document boundary.
PostgreSQL owns authoritative metadata, snapshots, operations, versions,
history and leases. History is capped at 100 entries and remains positions
1-100 after further edits or forward restoration. Automatic checkpoints occur
every ten revisions. Restoring creates a new forward version; no prior version
is rewritten or deleted.

NestJS exposes under `/v1/workspaces/:workspaceId/documents`:

- `GET /` and `POST /`;
- `GET /:documentId` and `PATCH /:documentId`;
- `POST /:documentId/lease`, `/lease/heartbeat`, `/lease/release` and
  `/lease/takeover`;
- `POST /:documentId/undo` and `/redo`;
- `POST /:documentId/versions` and
  `/:documentId/versions/:versionId/restore`;
- `POST /:documentId/save-as`;
- `GET /:documentId/compatibility-reports` and `/source`.

Create, mutate, version, restore, lease/takeover and Save As use existing
membership/permission, idempotency, trace and audit services. Mutations require
the current revision and a valid active lease; conflicts fail with 409. Raw
lease tokens are returned only to the client and only their SHA-256 hashes are
stored. Leases last 30 seconds, heartbeat every 10 seconds in the client and
have a 15-second disconnect grace period. Force takeover is owner/admin-only
and audited. All recorded customer usage remains zero-charge and customer
responses contain no price, currency or credit fields.

The private source endpoint is permission-scoped, covered by the API-wide
`no-store` policy, and capped at 50 MiB. It reads the existing private object
adapter only for a document's verified immutable raster source.

## Import and rendering boundaries

Verified, ready, malware-clean AVIF, BMP, GIF, JPEG, PNG, TIFF and WebP sources
can create a linked raster document. A compatibility report preserves verified
type and source identity. SVG has a contract and compatibility-report boundary
but fails closed until an approved sanitizer exists. PSD and AI-compatible
source kinds are defined for future reporting only; no editable-import claim is
made and no professional source is silently flattened.

The renderer supports deterministic initial artboards, raster previews, text,
shapes and bounded vector paths; selection, move, resize, rotate, wheel zoom,
space-drag pan, fit-all, fit-artboard, visual ruler foundations and snapping to
artboard edges/centres. Native top-left transforms are derived from rendered
coordinates across zoom and device-pixel ratio. The canvas is re-derived from
the current native snapshot after every server mutation.

The current browser source limit is a fail-closed safety boundary, not a proven
synchronous-performance threshold. Sources above 50 MiB return 413; a measured
server preview threshold, object-stored derivative and durable Python preview
job remain release work. No final rendered output is stored or presented as an
export in Recovery 2D.

## Responsive and accessible experience

Desktop uses the existing dockable, floating, movable, resizable, collapsible
and resettable panel framework. Tablet reflows the editor into stable docks.
Phone presents Canvas, Document and Tools views with light corrections and
version access instead of compressing the full desktop workspace; existing
global Jobs navigation remains available.

Buttons and tabs on phone pass the 44 by 44 px scan, the page has no horizontal
overflow at 768, 638 or 390 px, focus remains visible, controls have accessible
names, reduced motion is respected and Axe reports no scoped violations.
Keyboard support includes save-state recovery, undo/redo, delete, zoom, fit and
Save As commands.

Region/version comments are not mocked. The authority assigns their real domain
journey to Sequence J, and section 19.2 prohibits disconnected mobile mock
screens before that domain exists.

## Exact changed-file inventory

### Contracts, schemas and licence evidence

- `packages/contracts/src/ipw/contracts/editor.py`, `__init__.py`,
  `product_kernel.py`, `version.py` and
  `packages/contracts/tests/test_editor_contract.py`.
- `packages/contracts-ts/src/generated/product.ts`.
- Every JSON document under `packages/schemas/product-v1/`: 19 new editor
  schemas and all 54 pre-existing schemas regenerated, 73 of 73 total.
- `apps/web/package.json`, root `package-lock.json`,
  `data/licences/production-editor.json`,
  `tests/test_recovery_2d_editor_licence.py` and the existing Node provider
  licence gate.

### API and PostgreSQL

- `services/api/migrations/0014_recovery_2d_native_documents.sql`.
- `services/api/src/domains/documents/`: `document-model.ts`,
  `documents.controller.ts`, `documents.module.ts`, `documents.service.ts`,
  `documents.types.ts`, `memory-document.repository.ts` and
  `postgres-document.repository.ts`.
- `services/api/src/app.module.ts`, `kernel/migrations.ts`,
  `kernel/permissions.ts` and `domains/experience/experience.service.ts`.
- `services/api/tests/document-model.test.ts`, `documents.test.ts`,
  `experience.test.ts` and `postgres.integration.test.ts`.

### React editor and rendering

- `apps/web/src/editor/ImageGraphicStudio.tsx`.
- `apps/web/src/editor/renderer/EditorRenderer.ts`,
  `FabricEditorRenderer.ts` and `coordinates.ts`.
- `apps/web/src/App.tsx`, `boundaries/apiClient.ts`,
  `components/OperationalExperience.tsx`, `components/OutcomeGrid.tsx`,
  `panels/PanelFramework.tsx` and `styles.css`.
- `apps/web/tests/editorRenderer.test.ts` and
  `apps/web/tests/e2e/workspace.spec.ts`.
- `tests/test_recovery_2d_editor_boundary.py`.

### Decision and visual evidence

- `docs/adr/ADR-0014-native-editor-renderer-foundation.md` and this record.
- Eight new files under `apps/web/tests/__screenshots__/` named
  `studio-{1440x900,768x1024,638x768,390x844}-{light,dark}.png`.

No worker, storage implementation, infrastructure, deployment, legacy UI,
benchmark runtime, PDF engine, model file or font was changed.

## Verification record

Executed locally on 31 August 2026 without `.env`, credentials, customer files,
model/font downloads, cloud calls or live providers:

- `.venv\Scripts\python.exe tools/check.py`: all 18 gates passed in one
  uninterrupted final run.
- Python gate: 1,779 passed, 3 expected environment skips, required coverage
  passed (the diagnostic run measured 90.49%).
- Strict Python typing: 193 source files, no issues.
- TypeScript typecheck and all npm workspace tests: passed.
- Product contract drift: all 73 schemas and generated TypeScript match Python.
- Playwright production-preview gate: passed in comparison mode with no
  snapshot update. It includes pointer selection/move/resize/rotate persisted as
  native transforms, refresh recovery, keyboard history, multi-artboard
  navigation, Save As, raster crop/adjustment state, canvas pixel/aspect checks,
  responsive target/overflow scans, Axe and eight exact Studio visuals.
- Real PostgreSQL: `npm run test:postgres --workspace services/api` passed 2 of
  2 tests, 0 skipped, against a fresh local PostgreSQL 17.11 instance. All 14
  migrations ran. Direct verification returned server 17.11, migration count
  14, history positions `1:100:100` and cursor `100`. pg-mem was not used as
  PostgreSQL evidence. The synthetic database was stopped.
- `git diff --check`: passed before each Recovery 2D commit and is repeated for
  this record.
- `npm audit --omit=dev` and `npm audit`: two Moderate transitive advisories in
  `uuid <11.1.1` through `gaxios 6.4.0-6.7.1` (`GHSA-w5hq-g745-h8pq`). No unsafe
  audit fix or dependency override was applied.

## Visual baseline inventory

All eight Studio states are new, intentional, reviewed-in-branch baselines and
compare at `maxDiffPixelRatio: 0`:

- desktop 1440x900, light and dark;
- tablet 768x1024, light and dark;
- intermediate 638x768, light and dark;
- phone 390x844, light and dark.

The accepted pixels add only the activated Studio journey: responsive command
bar, artboard canvas, native-preview label, artboard/layer/assets/history tabs,
properties and All Tools surfaces, and theme-correct canvas chrome. Existing
Recovery 2C reviewed baselines were not intentionally changed.

## Requirement self-audit

| Requirement | Result | Evidence or bounded gap |
| --- | --- | --- |
| A. Native document model | Delivered | Contract 1.13.0, 19 new schemas, native model and migration 0014 |
| B. Non-destructive editing | Delivered foundation | Immutable source references, native crop/transform/adjustment/mask state; no export/recompression |
| C. History, versions, autosave | Delivered | optimistic mutations, 100-entry history, checkpoints, named/forward restore and refresh tests |
| D. Concurrency boundary | Delivered | hashed renewable lease, grace, request/force takeover, permissions and audit; no real-time co-editing |
| E. Editor experience | Delivered for 2D | desktop/tablet/phone Studio, panels, All Tools, versions and global Jobs; comments remain Sequence J |
| F. Canvas and renderer | Delivered foundation | ADR-0014, adapter boundary, transforms, pointer/zoom/pan/fit/rulers/snap and pixel tests |
| G. API, persistence and jobs | Partially delivered | NestJS/PostgreSQL/security/usage delivered; measured async preview threshold and derivative job remain open |
| H. Import compatibility | Partially delivered by design | verified raster works; SVG fails closed pending sanitizer; PSD/AI only truthful future report kinds |
| I. Feature/release exclusions | Delivered | architecture guard and diff prove no prohibited product area was added |
| Research decision | Delivered | primary-source, licence-aware three-candidate ADR and exact dependency evidence |
| Required deterministic tests | Delivered | 18 gates, PostgreSQL 17.11, Playwright/Axe/pointer/visual and architecture evidence |

## Known limitations and release gates

- Benchmark and approve an asynchronous server-preview threshold, durable
  preview job, object-stored derivative and provenance before supporting sources
  above the current 50 MiB browser-preview limit.
- Select and security-review an SVG sanitizer before enabling SVG import.
- Do not claim editable PSD or AI-compatible import until independent parser and
  compatibility work preserves unsupported structures truthfully.
- Rich text is a native extensible model with a basic browser text surface, not
  a complete typography/font pipeline. Advanced groups, editable guides and
  mask painting remain future editor depth.
- Region/version comments, approvals, sharing and presence remain Sequence J.
- Run live-provider compatibility checks in the release environment. Local
  deterministic adapters are not live GCS, Cloud Tasks, ClamAV or OIDC proof.
- Resolve or formally accept the two Moderate transitive advisories without an
  unsafe override.
- PWA platform presentation, the complete custom-PDF benchmark and model
  licence/quality approval remain existing release gates.
- Fabric upgrades require native-model, coordinate, pointer, accessibility and
  visual compatibility regression; Fabric serialization must remain excluded.

## Rollback

1. Create a dedicated rollback branch and stop local API/web/PostgreSQL
   processes.
2. Revert Recovery 2D commits in reverse order, beginning with the commit
   containing this record, then `8abf37f`, `66d616a`, `bb37647`, `021110e`,
   `eb704af`, `001a440` and `7ee9a44`. Do not rewrite approved Recovery 2C
   history.
3. Roll application code back before any separately approved data action.
   Migration 0014 is additive and contains document/version/audit evidence; do
   not drop its tables until retention and rollback impact are approved.
4. Rebuild generated contracts from the restored Python authority, clear only
   the Recovery 2D public shell/build caches and rerun the Recovery 2C
   PostgreSQL, contract and full repository gates.

## Commit sequence

1. `7ee9a44` - define the native editor document model and renderer ADR.
2. `001a440` - persist native editor documents in NestJS and PostgreSQL.
3. `eb704af` - harden native editor operations and identity behavior.
4. `021110e` - build the responsive native Image and Graphic Studio.
5. `bb37647` - keep restored PostgreSQL history within its durable bound.
6. `66d616a` - complete pointer, viewport, keyboard and responsive interactions.
7. `8abf37f` - enforce renderer/runtime and full dependency-licence boundaries.
8. The commit containing this verification record.

Recovery 2D remains local and paused for product-owner review. Nothing was
pushed, merged or deployed, and no later recovery sequence was started.
