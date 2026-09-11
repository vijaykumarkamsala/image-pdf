# Recovery 2E: Image Enhancement and Export

**Status:** Corrective implementation and verification complete locally
**Date:** 11 September 2026
**Branch:** `recovery/2e-image-enhancement-export-final`
**Corrective safety checkpoint:** `recovery/2e-corrective-safety-20260910`
at `83cf872b18e09b9a264aabc3029d8a960aa15d9b`
**Approved Recovery 2D baseline:** `origin/recovery/2d-image-graphic-studio-foundation`
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

The production-correctness pass replaces CSS comparison approximations with
registered worker previews; enforces one native geometry interpretation; makes
unsupported controls unavailable before submission; executes ICC-aware sRGB and
validated CMYK input conversion; verifies completed metadata bytes; fences worker
completion by lease token; and hardens private downloads and deterministic ZIPs.

No legacy, benchmark, POC, PDF, vector-processing or model runtime was promoted
into the production path. Originals, `AssetOriginal` identity and `SourceVersion`
identity remain unchanged.

## Delivery commits

The original Recovery 2E evidence chain is preserved:

1. `37dcdd6` - define deterministic enhancement and export contracts.
2. `d5ef4e0` - execute durable image exports.
3. `e8e1d27` - deliver the web enhancement and export workflow.
4. `eff32f6` - reconcile reviewed enhancement visual baselines.
5. `0d61db8` - preserve verified source identity and derivative delivery.
6. `a2cc72c` - prove the complete Recovery 2E real stack.
7. `bbea819` - cover deterministic processing and export safety boundaries.

The final corrective completion is exactly four local commits:

1. `865d4c1` - Database and contract integrity.
2. `36ae034` - Export budget and native text rendering.
3. `e99cc96` - Responsive UI correction.
4. `Verification and truthful completion record` - this record, the
   demonstrated real-stack SQL repair and final verification evidence. Its hash
   is reported in the handoff because a commit cannot contain its own hash.

The corrective safety branch remains at `83cf872`; no history was amended,
rebased, pushed or merged.

## Responsibility boundaries

### Contracts and generated artifacts

`packages/contracts/src/ipw/contracts/enhancement.py` is the source of truth for
20 operation kinds, recipes, recommendations and durable decisions, registered
comparison previews, output profiles, metadata evidence, export requests,
outputs, provenance and ZIP bundles. Product contract version `1.19.0` is
generated into 94 JSON Schemas under
`packages/schemas/product-v1/` and TypeScript in
`packages/contracts-ts/src/generated/product.ts`.

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
bundle state. Corrective migration
`0019_recovery_2e_production_correctness.sql` adds source frame/colour evidence,
logical recommendation idempotency, append-only recommendation decisions,
preview request identity and completed-byte metadata evidence. It also adds
tenant-scoped relationship keys across documents, versions, recipes,
recommendations, jobs, preview requests, export requests, outputs, provenance,
bundles and object references. Historical successful rows are retained without
inventing replacement evidence; delivery and ZIP selection fail closed unless
the output and matching provenance both contain verified metadata evidence.
Fresh PostgreSQL has 19 migrations, through `0019`.

The stable routes are:

- `GET|POST /workspaces/:workspaceId/documents/:documentId/recipes`
- `PATCH /workspaces/:workspaceId/documents/:documentId/recipes/:recipeId`
- `POST /workspaces/:workspaceId/documents/:documentId/recommendations`
- `PATCH /workspaces/:workspaceId/recommendation-sets/:recommendationSetId/decisions`
- `POST /workspaces/:workspaceId/documents/:documentId/enhancement-previews`
- `GET /workspaces/:workspaceId/enhancement-previews/:previewId`
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
status. Full enhancement source decode, artboards, intermediates and outputs stay
at the 16-million-pixel/12,000-edge boundary. One cooperative 60-second/768-MiB
process-RSS budget starts before source reads and is shared across all outputs in
the job. Durable preparation preview separately admits at most 100 million source
pixels only to create bounded 2,048/512-pixel proxies. ADR-0015 records the
cooperative/process-local architecture and keeps 8K+/libvips streaming or tiled
execution as a future production capability gate.

Standard native text now renders with `IPW Standard`, the exact CC0 Aileron
0.102 limited-character Regular subset embedded in pinned Pillow 12.3.0 and
materialised for the browser at SHA-256
`69853909b940023570964e29cffe30da95aea8de3627736b5cd15ab30143143169f`.
Browser and worker validate the same font identity. Position, size, hexadecimal
colour, opacity, rotation, artboard ownership and layer order use the native
composition path. External fonts, non-empty text runs, unsupported glyphs,
justification, advanced typography fields, shared text styles and unsupported
vector constructs fail before enqueue or at the matching worker boundary; no
font substitution is performed.

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
overflow. At 768 x 1024, a tablet-only sticky export action is fully visible,
keyboard-reachable immediately after the Configure step and retains the existing
44-pixel minimum target. Smaller and desktop layouts are unchanged.

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
- Advanced typography, external fonts, complex runs and unsupported vector
  constructs remain unavailable and fail closed.

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
- One cooperative export-job budget includes immutable source reads and every
  output; output count cannot reset the elapsed-time or process-RSS budget.
- The separate 100-million-pixel preparation-preview admission ceiling only
  produces bounded proxies and does not increase the 16-million-pixel full
  enhancement limit.
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

The final corrective real-stack run then exposed an ambiguous unqualified
`output_id` in the hardened output/provenance ZIP-selection join. The fourth
corrective commit qualifies every selected output column and adds direct
PostgreSQL coverage for creating a bundle only from a successful output with
matching verified provenance. The focused regression and complete real-stack
journey pass with that query.

## Test and integration evidence

Focused contract, API, worker, web and visual tests cover operation/parameter
validation, order/enable state, immutable source identity, deterministic format
encoding, orientation, dimensions, alpha/ICC/bit-depth gates, metadata removal,
partial failure, retry/cancel, ZIP determinism/security, idempotency, permissions,
tenant isolation, audit, provenance, zero charging and refresh-safe monitoring.

Final verification used no `.env`, credentials, customer data, live providers,
model downloads or network-fetched fonts. The standard font is materialised from
the installed, pinned Pillow artifact and checked by digest.

- Fresh database `ipw_2e_final_evidence` used PostgreSQL `17.11`, began with zero
  relations and applied all 19 migrations through `0019`. Both metadata
  completion constraints and all inspected composite tenant/relationship
  constraints are validated. NestJS PostgreSQL integration passed 5/5 and the
  Python intake/preview/worker PostgreSQL integration passed 7/7, with zero
  skips. A separate upgrade fixture proved an existing successful output remains
  successful without fabricated evidence while new invalid writes fail closed.
- Focused processor, native composition, preview-limit, contract and font
  licence tests passed 58/58. They cover one budget before reads and across all
  outputs, the exact 16-million-pixel edge, the distinct durable proxy ceiling,
  supported text plus raster/shape/group/mask/artboard composition, and
  fail-closed external/advanced text.
- The complete NestJS test invocation passed 54 tests and reported five expected
  PostgreSQL-environment skips; the same five PostgreSQL cases passed separately
  with no skips. Web component tests passed 40/40. API and web TypeScript checks,
  targeted Ruff, product/TypeScript contract drift, font drift and `git diff
  --check` passed.
- The complete Python affected gate passed 1,871 tests with eight expected
  environment-conditional skips and 90.04% branch-aware coverage. The corrective
  contract/native-export boundary tests raise coverage without lowering the 90%
  policy or excluding production code; product-kernel processing-job targets are
  fully covered and the deterministic enhancement engine reaches 93%.
- The responsive zero-tolerance Playwright test passed 1/1 across desktop,
  768 x 1024 tablet, 638 x 768 intermediate and 390 x 844 phone states. Its
  tablet assertions prove full viewport containment, a minimum 44 x 44 target
  and direct Tab-key reachability. Only
  `export-center-tablet-768x1024-dark.png` changed.
- The corrected final real-stack test passed 1/1 in 3.3 minutes against fresh
  database `ipw_2e_realstack_final`: React production preview -> NestJS ->
  PostgreSQL -> transactional outbox -> deterministic private storage -> Python
  intake/image-export/ZIP workers -> authorised derivative and ZIP downloads.
  Refresh reloaded authoritative completed state, and the wider matrix exercised
  multi-artboard/output isolation, cancellation and retry.
- Its primary output is a 128 x 96 WebP, 1,718 bytes, SHA-256
  `b8fe12cc7e17158287745251f1a8e259e994d7d6f67c333b9ddd39fb6a187a6b`.
  Provenance records processor `ipw-deterministic-pillow-image-export` version
  `1.1.0`, deterministic true, metadata verified true and matching immutable
  source identity. Outbox delivery attempts are one; all recorded usage has
  customer amount and credit debit zero.
- Its asynchronous ZIP is 2,132 bytes, SHA-256
  `0d262bb30df3890ed59e7a04a33c62ae744e95c16f8ef6be551ced47ec5c47a4`,
  with succeeded state.
- The first canonical `python tools/check.py` run exposed formatting, type,
  fixture-directory hashing, Playwright port isolation and a transient golden
  subprocess failure. Each demonstrated failure was repaired and its affected
  gate passed before the permitted final canonical run.
- The final canonical invocation completed all 20 gates: 18 passed in that
  invocation. Its Python test body passed 1,862 tests with eight skips but the
  coverage gate remained below the unchanged 90% floor; its Playwright gate
  failed while starting the web server before running a browser test. A fresh
  affected Python run reproduced 88.45%, after which focused contract and
  native-export boundary tests raised the clean full result to 90.04% with
  1,871 passes and eight skips. The affected Playwright gate then passed all
  98 tests, including zero-tolerance visuals, on isolated port 4174. No third
  canonical run was made, preserving the prompt's canonical-run limit. Taken
  together, the 18 green final-canonical gates and the two green affected-gate
  reruns cover every canonical gate without concealing the run chronology.

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

The final corrective branch changes 25 reviewed baselines. The responsive
correction changes only `export-center-tablet-768x1024-dark.png`; its accepted
pixels show the complete tablet action. Deterministic font delivery independently
changes eight Studio viewport/theme baselines and sixteen text-bearing
Studio-state baselines because those tests create the now-supported `IPW
Standard` layer. Blank Studio frames and unrelated Home, Projects, Files, Jobs,
intake and guest baselines remain byte-identical. Comparison remains at zero
pixel tolerance, and every changed baseline was inspected after generation.

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
| M. Testing/evidence | Delivered | 18 final-canonical gates plus green affected reruns: Python 1,871/90.04%, Playwright 98/98, PostgreSQL and real-stack evidence |
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
  approval. No model was downloaded. The only enabled standard font is the
  locally materialised, digest-pinned CC0 Aileron subset; no external font was
  downloaded or accepted.
- Advanced typography, external fonts, non-empty rich-text runs, unsupported
  glyphs and unsupported vector constructs remain fail-closed.
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
3. Revert the four final corrective commits in reverse order, then revert the
   preserved original Recovery 2E commits only if the entire feature is being
   rolled back. Do not rewrite the safety checkpoint.
4. Roll a Recovery 2E database back by restoring the pre-2E PostgreSQL backup or
   provisioning a fresh database at migration 0017. Migrations 0018 and 0019 are
   forward-only; no destructive down migration is supplied.
5. Remove only uncommitted local Recovery 2E generated build/test objects through
   their owning tools. Do not delete immutable sources or approved screenshot
   baselines from Recovery 2D.
6. Rebuild generated contracts from the restored source, run `python tools/check.py`,
   and rerun the Recovery 2D PostgreSQL and real-stack gates.

Recovery 2E remains local and paused after verification. Nothing is pushed,
merged or deployed without separate product-owner approval.
