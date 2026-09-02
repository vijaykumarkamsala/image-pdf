# Recovery 2E: Image Enhancement and Export

**Status:** Complete locally; paused for product-owner review
**Date:** 2 September 2026
**Branch:** `recovery/2e-image-enhancement-export`
**Approved baseline:** `origin/recovery/2d-image-graphic-studio-foundation`
at `7a7b239f16361a307d7239f8ae6de32d355591f4`
**Authority:** The approved Recovery 2E prompt, the Product V2 Consolidated
Implementation Authority, Recovery 0-2D records and accepted ADRs, in that
precedence order.

## Customer outcome

Recovery 2E adds the production-shaped deterministic path from an accepted
image and native editor document through analysed recommendations,
non-destructive corrections, comparison, customer confirmation, durable
full-resolution rendering and verified derivative download.

The browser remains an interactive proxy. NestJS owns permissioned orchestration,
versioned recipes, idempotency, audit, zero-charge usage and result delivery.
PostgreSQL is authoritative for recipes, jobs, outputs and provenance. The Python
processing worker reads generation-bound immutable sources from private storage,
renders each requested output independently and registers verified derivatives.

No legacy, benchmark, POC, PDF, vector-processing or model runtime was promoted
into the production path. Originals, `AssetOriginal` identity and `SourceVersion`
identity remain unchanged.

## Delivery commits

1. `37dcdd6` - define deterministic enhancement and export contracts.
2. `d5ef4e0` - execute durable image exports.
3. `e8e1d27` - deliver the web enhancement and export workflow.
4. `eff32f6` - reconcile reviewed enhancement visual baselines.
5. `0d61db8` - preserve verified source identity and derivative delivery.
6. `a2cc72c` - prove the complete Recovery 2E real stack.
7. `bbea819` - cover deterministic processing and export safety boundaries.

The final documentation-only commit contains this completion record and is
reported outside the commit itself to avoid a self-referential hash.

## Responsibility boundaries

### Contracts and generated artifacts

`packages/contracts/src/ipw/contracts/enhancement.py` is the source of truth for
20 operation kinds, recipes, recommendations, proxy comparison, output profiles,
export requests, outputs, provenance and ZIP bundles. Product contract version
`1.18.0` is generated into JSON Schema under `packages/schemas/product-v1/` and
TypeScript in `packages/contracts-ts/src/generated/product.ts`.

The contracts make order, enabled state, parameters, recipe/version identity,
immutable source identity, output state, checksums and zero charging explicit.
They reject operation/parameter disagreement and unsupported format capability
combinations.

### NestJS control plane

`services/api/src/domains/exports/` provides one domain service to the React UI
and public authenticated API. It enforces workspace membership, role permission,
tenant scoping, recipe validation, idempotency, audit, job/outbox creation,
result lookup and authorised streaming download.

Migration `0018_recovery_2e_enhancement_exports.sql` adds versioned recipes,
recommendation sets, export requests, independent outputs, provenance and ZIP
bundle state. It extends authoritative source inspection facts without storing
source or derivative bytes in PostgreSQL.

The stable routes are:

- `GET|POST /workspaces/:workspaceId/documents/:documentId/recipes`
- `PATCH /workspaces/:workspaceId/documents/:documentId/recipes/:recipeId`
- `POST /workspaces/:workspaceId/documents/:documentId/recommendations`
- `POST /workspaces/:workspaceId/documents/:documentId/enhancement-previews`
- `POST /workspaces/:workspaceId/documents/:documentId/exports`
- `GET /workspaces/:workspaceId/exports`
- `GET /workspaces/:workspaceId/exports/:exportRequestId`
- `POST /workspaces/:workspaceId/exports/:exportRequestId/cancel`
- `POST /workspaces/:workspaceId/exports/:exportRequestId/retry`
- `POST /workspaces/:workspaceId/exports/:exportRequestId/bundles`
- `GET /workspaces/:workspaceId/export-bundles/:bundleId`
- `GET /workspaces/:workspaceId/export-outputs/:outputId/download`
- `GET /workspaces/:workspaceId/export-bundles/:bundleId/download`

### Python processing and private storage

`DeterministicImageEngine` in
`services/processing-worker/src/ipw/processing_worker/enhancement_engine.py`
applies EXIF orientation once, composites the selected native artboard, executes
the enabled ordered recipe and encodes verified output bytes. The bounded engine
records Pillow and LittleCMS behavior, exact version, parameters and deterministic
status. ADR-0015 explains why bounded Pillow is used for Recovery 2E and keeps
libvips streaming/tiled execution as a production scale gate.

`DurableImageExportProcessor` and `DurableExportBundleProcessor` claim PostgreSQL
leases, heartbeat, checkpoint, observe cancellation, isolate per-output failure,
write generation-bound derivatives and finish authoritative state. ZIP output has
fixed timestamps and ordering, sanitised names, count/size limits, a readable
manifest and only completed authorised outputs.

`packages/storage` now accepts an explicit bounded derivative-write limit. Local
deterministic storage remains test/review-only; production provider selection
still fails closed under the existing provider policy.

### React experience

`EnhancementWorkspace` exposes initial outcome, recommendation, strength, output
size and format controls, with exact values in a dockable advanced panel.
`ComparisonWorkspace` provides Original, Current, Recommended, split and
side-by-side states with synchronized zoom/pan, hold-original, histogram,
clipping, alpha checkerboard, output dimensions and proxy disclosure.
`ExportCenter` provides purpose presets, one or more output profiles and
artboards, format/size/quality/profile/alpha/metadata/filename choices, honest
size ranges, durable status, partial retry, individual download, ZIP and repeat
last successful export.

Desktop keeps the native Studio canvas and dock framework. Tablet, intermediate
and phone layouts reduce the professional surface to review, lightweight
correction, preset selection, monitoring and download without horizontal
overflow.

## Customer-usable enhancement matrix

| Operation | Customer behavior | Worker behavior |
| --- | --- | --- |
| Orientation normalize | Measured recommendation where needed | Applied exactly once from source facts |
| Crop | Normalized bounds and common aspect preset | Positive-area bounded crop |
| Rotate | Exact degrees and canvas expansion | Deterministic bicubic transform |
| Flip | Horizontal and/or vertical | Deterministic transpose |
| Resize | Pixels, percentage or physical size; aspect, fit and presets | Nearest, bilinear, bicubic or Lanczos |
| Exposure/brightness | Exact EV and brightness | Deterministic channel transform |
| Contrast | Exact signed amount | Deterministic contrast transform |
| Highlights/shadows | Independent exact values | Bounded luminance transform |
| White balance/temperature | 2,000-12,000 K | Deterministic channel balance |
| Tint | Exact signed amount | Deterministic green/magenta balance |
| Saturation/vibrance | Independent exact values | Bounded colour transform |
| Gamma | 0.1-5.0 | Fixed lookup transform |
| Levels | Black, white and midpoint | Ordered fixed lookup transform |
| Curves | Editable 2-32 point RGB/channel model | Piecewise lookup transform |
| Grayscale | Luminance or average | Deterministic grayscale conversion |
| Unsharp mask | Radius, amount and threshold | Bounded unsharp mask |
| Noise reduction | Strength and edge preservation | Deterministic bounded denoise |
| Colour profile | Preserve or sRGB; gated Display P3 | LittleCMS conversion or explicit failure |
| Alpha/background | Preserve or explicit flatten colour | Format-aware alpha handling |
| Standard scale | Clearly labelled 2x/4x standard resampling | Conventional resampling, never AI |

Every operation is editable, enabled/disabled, resettable and reorderable through
the shared recipe model. Exports always re-render from immutable source bytes plus
the chosen document and recipe versions, so corrections do not accumulate lossy
recompression.

## Recommendations and comparison

Recommendation evidence is labelled `measured` or `heuristic`; no confidence
percentage is fabricated. Orientation, conservative tonal correction, colour
cast, output-size risk, alpha/background compatibility and privacy metadata are
recommended only from authoritative inspected facts or clearly disclosed
heuristics. Intended outcome is requested only when it materially affects the
choice. Nothing is applied until the customer confirms it, and accepted
recommendations become ordinary editable recipe operations or metadata policy.

Comparison state is refresh-safe within the document journey. Histogram and
clipping indicators are derived from sampled rendered preview pixels and fail
closed to an empty result when pixels are unavailable. The proxy label states
that final output is rendered by a durable worker and never claims recreated
detail, repair or AI.

## Export and capability policy

Executable 8-bit worker formats are JPEG, PNG, WebP and TIFF. Presets include
archival derivative, web, email, social/custom dimensions, presentation/document
use, high-resolution digital and custom. Controls cover pixel, percentage and
physical/PPI sizing; fit; lossy/lossless behavior; JPEG chroma subsampling;
resampling; colour profile; bit depth; alpha/background; metadata; filename and
collision behavior.

The following are explicit capability gates:

- AVIF is absent because no approved executable encoder/licence gate exists.
- 16-bit PNG/TIFF is contract-visible but the bounded engine fails closed until
  it can preserve source precision end to end.
- Display P3 fails closed unless an executable verified profile conversion or
  preservation path is available.
- CMYK, spot colour, machine/material profiles and print preflight remain outside
  Recovery 2E.
- libvips streaming/tiled scale evidence remains required before approving large
  production images beyond the bounded Pillow route.

Size estimates are deliberately ranges and include customer-readable
explanations; they do not claim byte precision before encoding.

## Colour, metadata and privacy

ADR-0016 establishes sRGB as the Recovery 2E working output unless the customer
selects supported profile preservation/conversion. Embedded ICC profiles are
respected; untagged sources remain described as untagged rather than being
mislabelled. EXIF orientation is normalized once. Alpha is preserved for
supporting formats, while JPEG requires a chosen flatten background and warning.

Derivatives remove GPS, device data, maker notes, user comments, embedded
thumbnails and unknown private blocks by default. Customers may explicitly keep
copyright, description, capture time or camera categories. Location remains
removed. The worker reopens completed bytes and records metadata verification in
provenance. Original bytes and metadata are untouched.

## Durable results and integrity

An accepted export creates a PostgreSQL job and transactional outbox record. The
queue carries only the opaque job reference; PostgreSQL remains authoritative
after restart or redelivery. The worker records independent output state,
checksum, generation-bound object reference, byte size, dimensions, media type,
recipe/document/source identity, trace/job IDs, processor/version, parameter
hash, metadata decision and deterministic status.

Submission is idempotent. Redelivery of terminal work is a no-op. Cancellation
does not delete already completed valid outputs. Retry selects failed outputs
without redoing successful outputs. Every usage event is zero-charge. Downloads
are permission checked and streamed from the private object boundary; a guessed
cross-tenant output or bundle ID is not disclosed.

## Safety boundaries

- Authoritative inspected facts and immutable checksums are revalidated before
  rendering.
- Compressed bytes, decoded pixels, dimensions, memory estimate, elapsed time,
  output bytes, output count and ZIP size are bounded.
- NestJS and the browser never load authoritative full-resolution source bytes.
- Corrupt images, decompression bombs, malformed recipes, unsafe metadata,
  unsupported profiles and resource exhaustion fail explicitly.
- A failed output cannot fail or remove another completed output.
- Production startup continues to fail closed without approved PostgreSQL,
  private storage, durable queue and processor capabilities.

## Real-stack corrections

The first automated real-stack pass found that the export worker required a
private `object_reference_id` in the browser-safe native snapshot. That field is
intentionally null. Commit `0d61db8` now resolves the private object through the
tenant-scoped `SourceVersion` plus `AssetOriginal`, then verifies the optional
snapshot reference, object reference, inspection facts, generation, checksum,
media type, byte size, malware result and dimensions as one identity chain.

The next pass completed the derivative but found that the customer filename had
been used as a private object-key segment. Valid display filenames containing
spaces or uppercase characters correctly failed the storage-key policy during
download. Private derivative keys are now opaque lowercase format paths;
customer filenames remain in PostgreSQL and authorised `Content-Disposition`.
The accepted final run proved both corrections without relaxing either boundary.

## Test and integration evidence

Focused contract, API, worker, web and visual tests cover operation/parameter
validation, order/enable state, immutable source identity, deterministic format
encoding, orientation, dimensions, alpha/ICC/bit-depth gates, metadata removal,
partial failure, retry/cancel, ZIP determinism/security, idempotency, permissions,
tenant isolation, audit, provenance, zero charging and refresh-safe monitoring.

Final verification was executed without `.env`, credentials, customer uploads,
cloud calls, model/font downloads or live providers:

- `python tools/check.py`: all 18 canonical gates passed. Durations were format
  0.4s, lint 0.4s, types 2.3s, tests 218.4s, fixture integrity 1.4s, fixture
  reproducibility 0.4s, inspection fixtures 0.3s, TypeScript contract drift
  1.3s, product contract drift 2.5s, canonical vectors 1.3s, TypeScript
  typecheck 26.8s, TypeScript tests 28.4s, web Playwright 430.4s, goldens 3.3s,
  schema drift 2.4s, licence register 1.5s, model weights 2.2s and example
  manifest 1.6s.
- Python passed 1,828 tests at 90.07% branch-aware coverage. The deterministic
  enhancement engine reached 96% and durable export processor 95%.
- The canonical Python run reported eight environment-conditional skips: one
  installed-libvips unavailable-path case and seven tests requiring an explicit
  PostgreSQL URL. Those seven tests were separately executed against PostgreSQL
  and all passed with zero skips.
- Web component tests passed 39/39. The normal production-preview Playwright
  suite passed all 98 cases in full-suite order, including accessibility,
  keyboard, pointer, 44 px target, reduced-motion, horizontal-overflow and
  zero-tolerance visual comparisons. No snapshot-update mode was used for the
  accepted run.
- Fresh database `ipw_2e_final_20260902` used PostgreSQL `17.11` and all 18
  migrations. NestJS PostgreSQL integration passed 5/5 with zero skips. Python
  intake/preview PostgreSQL integration passed 7/7 with zero skips; pg-mem was
  not used as compatibility evidence.
- The final real-stack test passed 1/1 in 2.0 minutes against fresh database
  `ipw_2e_realstack_accepted_20260902`: React production preview -> NestJS ->
  PostgreSQL -> transactional outbox -> deterministic private storage -> Python
  intake/image-export/ZIP workers -> authorised derivative and ZIP downloads.
  Refresh reloaded the completed PostgreSQL state.
- Real-stack output was a 128 x 128 WebP, 1,086 bytes, SHA-256
  `41344aa4d8477727de1e454515098abe5108774695de9cebb40239483018d9a5`.
  Provenance recorded processor `ipw-deterministic-pillow-image-export` version
  `1.0.0`, deterministic true, metadata verified true and matching immutable
  source identity. Outbox delivery count was one; both recorded usage events had
  customer amount and credit debit zero.
- The asynchronous ZIP completed at 1,463 bytes with SHA-256
  `1b598137782b572f79bda094d8493507c938b426d546777d483c1b6e3801ca53`.
- The separately named workspace boundary gate passed 14/14. `git diff --check`
  and seven referenced-document path checks passed.
- `npm audit` and `npm audit --omit=dev` each reported the same two Moderate
  transitive `uuid <11.1.1` findings through `gaxios`; both commands passed the
  high-severity gate and no forced audit fix was applied.

## Visual baseline inventory

Recovery 2E adds these 16 reviewed baselines under
`apps/web/tests/__screenshots__/`:

- `enhancement-recommendations-1440x900-light.png`
- `enhancement-recommendations-1440x900-dark.png`
- `enhancement-advanced-controls-1440x900-light.png`
- `enhancement-comparison-split-1440x900-light.png`
- `enhancement-comparison-side-by-side-1440x900-light.png`
- `enhancement-review-tablet-768x1024-dark.png`
- `enhancement-review-intermediate-638x768-dark.png`
- `enhancement-review-phone-390x844-dark.png`
- `export-center-1440x900-dark.png`
- `export-center-multi-output-metadata-1440x900-light.png`
- `export-active-1440x900-light.png`
- `export-partial-failure-retry-1440x900-light.png`
- `export-completed-results-1440x900-light.png`
- `export-center-tablet-768x1024-dark.png`
- `export-center-intermediate-638x768-dark.png`
- `export-center-phone-390x844-dark.png`

Eight existing Studio viewport baselines and the related Studio-state baselines
were intentionally refreshed because the command bar now contains the primary
Enhance and Export actions. Unrelated Home, Projects, Files, Jobs, intake and
guest baselines were restored byte-for-byte after review. Comparison remains at
zero pixel tolerance.

## Requirement mapping

| Prompt section | Result | Primary evidence |
| --- | --- | --- |
| A. Processing architecture | Delivered, with live-provider and libvips release gates | ADR-0015, NestJS exports domain, PostgreSQL migration, Python processors |
| B. Deterministic enhancement | Delivered for all 20 listed operation kinds | enhancement contract, engine, operation and golden tests |
| C. Safe recommendations | Delivered | recommendation contracts/repository and React confirmation journey |
| D. Preview/comparison | Delivered as labelled interactive proxy | `ComparisonWorkspace`, model tests and reviewed visuals |
| E. Professional disclosure | Delivered responsively | docked advanced controls and desktop/tablet/phone E2E |
| F. Image Export Center | Delivered for executable JPEG/PNG/WebP/TIFF boundaries | `ExportCenter`, engine codec tests and capability gates |
| G. Multiple outputs | Delivered per native document/artboard | output repository, partial failure/retry and ZIP tests |
| H. Privacy/metadata | Delivered with byte-level verification | ADR-0016, engine metadata inspection and provenance |
| I. Colour/quality | Delivered for bounded 8-bit sRGB/preserve paths | ADR-0016, ICC/alpha/orientation tests; gated P3/16-bit |
| J. Integrity/delivery | Delivered | tenant-scoped API, checksums, idempotency, zero charge and downloads |
| K. Performance/safety | Delivered within explicit Pillow bounds | engine limits, private storage bounds and rejection tests |
| L. Public API | Delivered | authenticated routes listed above use the same domain service as React |
| M. Testing/evidence | Delivered | unit, PostgreSQL, real-stack, Playwright, visual and all 18 canonical gates |
| N. Explicit boundaries | Preserved | no AI/PDF/print/cloud connector/billing/native/deployment delivery |

## Known limitations and release gates

- Live GCS, Cloud Tasks, ClamAV and OIDC compatibility checks remain documented
  release gates; Recovery 2E did not access providers or credentials.
- A packaged native libvips runtime, differential goldens and scale/resource
  benchmarks remain required before the large streaming production route is
  approved.
- 16-bit preservation, Display P3 and AVIF remain disabled fail-closed.
- The two previously documented Moderate transitive `uuid <11.1.1` advisories in
  the approved Google provider dependency chain remain release gates; no forced
  dependency override is applied.
- Final print-production approval, machine/material profiles and the quarantined
  custom PDF benchmark remain outside this delivery.
- AI/model work remains blocked on separate licence, quality, security and model
  approval. No model or font was downloaded.
- Batch orchestration across independent customer files remains deferred; the
  reusable recipe/export contracts support that later bounded delivery.

## Explicitly deferred work

Recovery 2E does not implement AI scaling/reconstruction, Recreate, face or
damage restoration, generative fill/background, OCR, PDF creation/edit/export,
print production, cloud connectors, e-sign, billing/non-zero credits, native
mobile applications, cross-file batch processing, deployment or live-provider
access.

## Rollback

1. Stop local web, API, worker and PostgreSQL review processes.
2. Create a dedicated rollback branch from this Recovery 2E HEAD; do not rewrite
   the approved Recovery 2D history.
3. Revert the Recovery 2E commits in reverse order, including this record, then
   `eff32f6`, `e8e1d27`, `d5ef4e0` and `37dcdd6`.
4. Roll a Recovery 2E database back by restoring the pre-2E PostgreSQL backup or
   provisioning a fresh database at migration 0017. Migration 0018 is additive,
   but no destructive down migration is supplied.
5. Remove only uncommitted local Recovery 2E generated build/test objects through
   their owning tools. Do not delete immutable sources or approved screenshot
   baselines from Recovery 2D.
6. Rebuild generated contracts from the restored source, run `python tools/check.py`,
   and rerun the Recovery 2D PostgreSQL and real-stack gates.

Recovery 2E remains local and paused after verification. Nothing is pushed,
merged or deployed without separate product-owner approval.
