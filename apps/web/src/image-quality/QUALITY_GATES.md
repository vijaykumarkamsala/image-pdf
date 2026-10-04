# Image Quality Editor evidence gates

This file applies only to the isolated `/image-quality` editor. It does not
change Studio, PDF, Recovery or deployment authority. The owner approved additive
new-editor face API/job contracts and the additive durable-face database migration
on 16 September 2026. The existing product-contract version is unchanged. Migration
0025 and its guarded rollback are isolated to native face work; older job targets
and their existing upload uniqueness policy are preserved.

## Runtime gates

- Verify JPEG, PNG or WebP bytes and dimensions before decode; do not trust the
  filename or supplied MIME label.
- Do not flatten animated input. Do not copy EXIF/GPS to derivatives.
- Hash the immutable source and downloaded PNG. Embed source-bound, versioned
  provenance plus an explicit sRGB declaration in the PNG.
- Treat flat graphics, illustrations and photographs separately. Protect
  uniform fields, alpha and source chroma, and reject a candidate whose sampled
  output repaints those regions.
- Keep every output within measured browser/canvas memory. A smaller scale is a
  truthful processing decision, not a silent failure.
- The current Real-ESRGAN derivative and resvg renderer are local-research only.
  Production builds use the deterministic browser route until their governing
  licences are approved or an approved replacement is registered.

## Evidence set

Each release candidate needs rights-cleared assets across all categories in
`IMAGE_QUALITY_EVIDENCE_CATEGORIES`. Git records opaque ids, SHA-256 values,
permission facts and measurements—not private pixels or local file paths.

Paired ground-truth assets record PSNR, structural similarity, edge retention
and RGB error. Unpaired real-world assets receive at least three blinded reviews
covering detail, naturalness, colour, halos, invented content and identity/text
changes. Any invented content or identity/text change is a hard failure.

The two product-owner accepted examples (flat logo and soft animal
illustration) become protected evidence only after their owner, licence,
benchmark-use and public-display permissions are explicitly recorded. Until
then their private files remain local and uncommitted.

## Browser evidence

Automated focused journeys cover the normal WebGPU route, deterministic route,
real JPEG/WebP intake, malformed input, cancellation, stale settings, alpha,
download-byte identity, responsive layout and accessibility. Release evidence
still requires physical Safari/iOS and representative low-memory device runs;
Chromium emulation is not a substitute for those devices.

## Local 3D LUT evidence

The colour stage accepts reviewed 3D IRIDAS `.cube` files only. Parsing is local,
strict UTF-8 and bounded to 16 MiB, a 2³–65³ grid, finite numeric tokens, one
complete declared grid and a valid increasing input domain. One-dimensional,
combined shaper, unsupported directive, malformed, incomplete and excess data
fail visibly. The exact file bytes are SHA-256 bound to the reviewed title, grid,
domain and tetrahedral interpolation recipe; a missing or mismatched definition
cannot process.

The LUT is the final display-referred sRGB colour operation. Intensity is explicit
and bounded, dimensions and alpha are invariant, fully transparent hidden RGB is
not rewritten, and clipped output is counted in colour statistics. A changed LUT
or intensity invalidates the prior derivative. The v8 PNG provenance records the
ordered operation and reviewed LUT identity, and the browser journey requires the
preview blob and downloaded PNG to be byte-identical. This local feature does not
claim camera-log input interpretation, HDR/wide-gamut colour management, LUT
licence approval, colour matching or protected brand/product/skin colour.

## Explicit face-detail follow-up (not released)

The owner approved a separate, opt-in face reconstruction workflow. It must not
change the accepted ordinary logo/illustration routes. The disclosure panel is
collapsed by default. Consent clears when it closes, on Reset and on replacement
image selection; it is not stored as permission for other images.

No face adapter is registered. Generation remains unavailable: exact model
weights, executed dependency pins, commercial execution/distribution evidence
and accepted face-quality review are all required. A permissive code licence
alone does not clear weights or their dependencies. Pending reviews are blockers,
not a declaration that training-data licences automatically prohibit inference.
Do not enable an adapter using a development environment flag alone.

The replaceable `FaceRestorationEngine` contract receives immutable decoded
source pixels and requires worker-side detection, alignment, candidate inference
and inverse alignment. The boundary rejects unapproved adapters before invocation,
cancelled/stale results, wrong models and incomplete candidate sets. Two or three
source-bound proposals must be reviewed before any composition. No ordinary
enhancement fallback is allowed to masquerade as face restoration.

The tested local RestoreFormer++ candidate changed facial features and was
rejected; private source/candidate images and model weights remain uncommitted.
The automatic browser face adapter and candidate comparison/region-export
mechanics are implemented below. Exact-photograph acceptance and approved real
model integration remain unfinished; no face engine is registered or released.
The disclosure panel and synthetic tests are not evidence of improved face quality.

A private, manually aligned study now compares CodeFormer at fidelity 0.5, 0.8
and 1.0 with GFPGAN 1.4 on the difficult owner-supplied portrait. All four
inferences completed on CPU with the original SHA-256 unchanged. The aligned
CodeFormer candidates visibly reconstruct finer hair and skin texture, but also
propose new eye, tooth and other facial detail. This is promising Recreate
evidence, not an ordinary-enhancement acceptance or an identity guarantee.
GFPGAN is retained for comparison, not declared equivalent to the real face.

`apps/web/tools/face_detail_study.py` is an offline research tool, not a browser
adapter. It requires explicit private-input approval, uses the shared
`local_research` gate, verifies exact model SHA-256/size and the conversion
publisher's CRC32, checks installed dependency pins and rejects custom/external
ONNX graph content. Python sockets are denied during inference; this is not
claimed to be an OS-level network sandbox. Model weights and generated private
comparisons remain ignored. Their private manifest records model/runtime pins,
alignment, matching source-coordinate framing, timings and output hashes.

No global licence approvals were changed. CodeFormer uses the non-commercial
[S-Lab licence](https://github.com/sczhou/CodeFormer/blob/master/LICENSE).
[GFPGAN's licence](https://github.com/TencentARC/GFPGAN/blob/master/LICENSE)
contains third-party exceptions; its code's Apache header is not a completed
commercial weight/dependency review. The existing registry permits marked local
research while those reviews are pending, but public-demo, staging and production
remain blocked. Quality/identity review and exact commercial rights are required
before connecting either candidate to the customer page.

The tested composition boundary binds review to exact patch/mask bytes, model,
source/base hashes, geometry and fidelity. It preserves base/source buffers,
every pixel outside the selected region, zero-mask pixels and alpha exactly.
Region evidence maps output pixels to source coordinates without resizing.
Any identity or text change remains a failure for ordinary enhancement. Explicit
face Recreate must disclose identity risk, show reconstructed regions and require
candidate-specific acknowledgement; acknowledgement does not prove identity accuracy.

## Face review implementation progress

- The private refinement tool reuses hash-verified CodeFormer study pixels.
  Bounded shadow lift, local/fine luminance separation and source-chroma anchoring
  make a restrained tonal adjustment without another inference or larger output.
  RGB headroom prevents introducing clipped channels; synthetic tests check
  immutable inputs, exact zero strength, neutral colour and monotonic tonal ramps.
  It is not proof of recovered extra detail or accepted identity.
- `FaceDetailPanel` supports an approved adapter's three proposals, original/base/
  proposed region comparison, synchronized source-coordinate pan/zoom and a
  candidate-specific reconstruction map. Nothing is selected automatically.
  Changing selection clears acknowledgement and the previous reviewed download.
- `WorkerFaceReviewRenderer` verifies encoded original/base hashes before decoding,
  keeps source/base pixels in an isolated worker, renders only comparison regions
  before selection and fully encodes only the explicitly reviewed candidate.
  The PNG embeds `explicit-face-recreate` usage and exact region/review/model
  evidence. Ordinary enhancement cannot be tagged with undisclosed face evidence.
  The face derivative has a separate view/download; ordinary output remains intact.
- Closing the panel, withdrawing permission, source/base replacement, stale
  strength, ordinary processing and release changes cancel work and invalidate
  candidates/approval/URLs. Zoom/pan does not decode, infer or encode again. The
  page reuses its result Blob, rather than copying full output bytes during zoom.
- The focused browser journey uses a **test-only synthetic adapter** with the real
  decode/composition worker to verify selection, acknowledgement invalidation,
  aligned viewing, PNG evidence, downloaded pixel/byte identity, errors,
  cancellation, source/base changes and release revocation. This adapter is not a
  customer route or production dependency and does not measure real face quality.

Current browser face rendering is bounded to opaque 8-bit still PNG base results
within the device/canvas budget. Transparent bases are refused because browser
premultiplication could change decoded pixels outside the approved patch. Animated,
high-bit-depth and oversized bases require a future native face renderer; no
flattening, bit-depth reduction or smaller replacement is performed silently.
This limitation is face-specific, not a removal of the ordinary native worker's
existing image capabilities. Remote-only results do not enable this browser path.

Still required before release: exact commercial model/dependency clearance,
approved real model integration/validation, real-photograph quality/identity
acceptance and native face rendering/integration for the unsupported base types.
The earlier Linux/cloud/large-file/colour/device validations are not cleared by
these focused mechanics tests. No Photoshop-style manual controls or larger-scale
buttons were added in this increment.

## Automatic browser face adapter (implemented, unregistered)

`WorkerFaceRestorationEngine` now implements source-pixel detection, five-point
similarity alignment, two/three actual fidelity inferences and inverse alignment.
It accepts a reviewed bundle, not a model URL or environment-based approval.
The worker verifies model sizes/hashes, pinned ONNX Runtime 1.29.0 and a canonical
model/runtime/I/O/recipe bundle digest before constructing sessions. This digest
binds processing configuration; it is not a substitute for the required complete
commercial dependency/distribution review and executed-artifact evidence.

The supported detector is the fixed 640-pixel YuNet 2023mar artifact with upstream
[Git LFS SHA-256 and size](https://github.com/opencv/opencv_zoo/blob/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx).
The upstream [model directory](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet)
explicitly puts its files under [MIT](https://github.com/opencv/opencv_zoo/blob/main/models/face_detection_yunet/LICENSE).
Prediction-head decoding follows the published OpenCV 4.12 convention. Detector
licensing does not clear any restoration model or the complete face pipeline.
No detector or restoration model bytes are committed in this increment.

An overview plus overlapping native-scale tiles avoids relying solely on a
downsampled tiny face. Scans exceeding 32 windows fail before inference; no
partial scan or smaller replacement is presented as success. Zero confident
faces, multiple possible people and uncertain/too-small landmarks fail clearly.
The adapter does not silently choose the largest face. Inference is single-thread
WASM inside its own terminable worker. Low-memory/server routing still requires
the future native face integration.

The bounded restorer contract is normalized RGB FLOAT `[1,3,512,512]`, one scalar
fidelity input (FLOAT/DOUBLE) and one matching output. Arbitrary restorers, a
semantic face parser and general multi-face selection are not implemented.
Inverse-aligned masks are conservative geometric ellipses, not semantic region
or identity proof. Candidate hashes and PNG evidence bind detector hash/confidence,
native source landmarks, similarity transform and bundle digest. Outside pixels
remain governed by the existing reviewed-composition boundary.

The focused local browser journey uses the owner-authorized private portrait,
the exact YuNet artifact and an owned tiny synthetic ONNX restorer to exercise
the real inference worker, review/encoding integration and failure cases. The
restorer only adds a bounded pixel bias: this is **mechanics evidence, not improved
face quality**. Private evidence and weights stay ignored. When optional private
inputs are absent, the journey explicitly annotates that evidence as not run;
ordinary/synthetic regression checks still run, and no real-face acceptance is
inferred. Real restoration-model compatibility, quality, identity and performance
remain to be validated after commercial clearance.

## Native face follow-up — implementation ledger

This ledger counts six native follow-up coding blocks, not the earlier P0/P1/P2
audit or whole-product completion. **All six mechanics blocks are implemented;
block four's real-model release is still pending.**

1. **Implemented:** additive `image-quality-face-v1` intent/composition/release/
   capability records, generated JSON Schema/TypeScript and an owner-scoped API
   boundary. It rejects stale source/base hashes, foreign bases, nonliteral
   permission, extra client pixels and client-supplied model approvals. A valid
   request returns `face-quality-unavailable` (503) while the model adapter and
   release gates remain open. No inert job or fake success is recorded.
2. **Implemented:** `NativeFaceRenderer` consumes a server-held reviewed patch,
   verifies source/base/patch/mask/model/dependency digests, and composes into
   private disk-backed pixels. It writes a separate PNG in bounded row/column
   buffers with explicit face-Recreate provenance. Native RGB/RGBA precision,
   every base alpha sample, hidden RGB at transparent pixels, zero-mask pixels
   and every outside-region pixel remain exact. ICC/transfer/primaries/HDR chunks
   retain their original bytes; sensitive text/EXIF metadata is not copied.
3. **Implemented:** separate durable native candidate/composition records reuse
   the existing transactional queue/outbox. Owner-scoped idempotency, exact
   source/base/model/review binding, private generation-bound proposal/mask storage,
   lease fencing, heartbeats, retained candidate checkpoints, bounded retry,
   cancellation and private result delivery are implemented. Composition retries
   reuse the selected raw patch instead of running inference again. Release
   revocation closes inference, composition and download, but never cancellation.
   Existing ordinary Restore requests and their outputs are not reopened or changed.
4. **Mechanics implemented; real-model release pending:** `NativeOnnxFaceEngine`
   implements native source-pixel detection, five-point similarity alignment,
   distinct fidelity inferences and inverse-aligned native-colour proposals.
   Registration and exact commercial/real-photo acceptance remain unfinished.
   No trained restorer is registered. The renderer rejects an 8-bit patch for a
   16-bit base; neither adapter nor renderer manufactures precision by scaling
   eight-bit channels.
5. **Implemented:** temporal proposals bind one native alignment, patch and mask
   per logical frame under one reviewed candidate digest. The durable worker
   decodes the immutable source/base frame-by-frame, clears detector/model scratch
   between frames, checkpoints the complete candidate stack and composes only the
   exact acknowledged stack. The APNG renderer preserves frame count, default-image
   semantics, loop count, frame delays, base alpha, colour authority and every
   decoded pixel outside the reviewed region. It does not repeat one still patch,
   flatten, drop frames or substitute a smaller result. This first native temporal
   adapter is deliberately limited to 8-bit full-canvas source-blend APNG bases;
   16-bit animation and other APNG disposal/blend layouts require separately
   qualified native adapters.
6. **Customer and private-artifact lifecycle mechanics implemented:** a native client
   receives only the server-issued upload/base
   identifiers emitted by `ProductionImageQualityEngine`. It preflights server
   capabilities for the exact owner/source/base, creates source-bound candidate or
   reviewed-composition commands, polls durable progress, resumes unexpired jobs,
   preserves interrupted work, clears stale/failed/cancelled jobs and exposes a
   private download only for an exact succeeded composition. Idempotency keys are
   derived from the complete intent; browser recovery contains identifiers/hashes,
   never pixels, credentials, model paths or client approval. Guest sign-out clears
   this state. Composition recovery is checked before candidate recovery so an
   interrupted reviewed result is not erased by probing the other operation.
   The customer panel displays the server blockers but cannot use them as a model-
   release bypass. When a release is eventually approved, consent is per-open
   review session; candidate patches and masks are owner-scoped, release-bound and
   verified byte-for-byte in both API and browser before an off-main-thread 8/16-
   bit preview. Original, ordinary enhanced and proposed output share one geometry,
   synchronized pan/zoom and a visible reconstruction map. Selection changes clear
   acknowledgement; only an acknowledged exact candidate can create a separate
   durable composition and private download. Closing stops local polling without
   destroying resumable server work. Withdrawing consent clears local candidate
   state. Exceptionally large candidate regions receive a worker-generated,
   at-most-2048-pixel-side, non-generative review proxy; both proxy byte streams are
   owner/release/generation/hash bound and the UI labels the proxy explicitly. Exact
   native candidate bytes, not the proxy, remain the only composition input. The API
   never buffers the oversized native region merely to display it. Attempt-and-lease-
   unique object keys prevent a stale worker from deleting another attempt. Objects
   written before checkpoint/publication are deleted immediately on failure,
   cancellation, lease loss or release revocation. A durable scheduled cleanup lease
   deletes expired referenced candidates, masks, bounded proxies and reviewed outputs
   by exact provider generation; retries are idempotent and a nonterminal child
   composition protects its parent candidates. Migration rollback refuses to discard
   this lifecycle state while face jobs exist. The existing browser face path stays
   unregistered and unchanged.

The native still core currently accepts non-interlaced, full-channel 8/16-bit
RGB/RGBA PNG bases and matching-precision straight-RGBA proposals. The temporal
core accepts verified 8-bit full-canvas source-blend APNG bases and one reviewed
RGBA proposal/mask per logical frame. Palette, grayscale, keyed-transparency,
interlaced bases and other APNG layouts require a separate adapter.
Scratch-storage checks are technical safety limits, not billing limits or a
claim that arbitrary GB files have been validated. Cancellation is checked around
native decode and during composition/encoding. Cancellation is cooperative; an
in-progress native decoder is not forcibly interrupted. Candidate checkpoints are
durable, but composition restarts from verified inputs, not a saved encoded row.
An invocation that exceeds its budget without committing a new checkpoint consumes
bounded retries instead of creating endless refunded jobs. Arbitrary multi-GB
decode/encode and deployed cloud recovery are not validated by these mechanics.

Focused synthetic evidence checks actual 8/16-bit PNG derivatives, exact outside/
alpha/zero-mask pixels, wide rows crossing encoding buffers, metadata transport,
digests, stale review, cancellation cleanup, storage exhaustion, no-op rejection
and exclusive publication when another file appears. These tests do not run a
trained face model, validate identity or prove multi-GB performance. No private
photographs, trained weights or generated private outputs are committed.

Focused Windows checks on 16 September 2026 passed: 50 Python contract/renderer/
durable-worker tests, 11 new-editor API/delivery/PostgreSQL tests, 68 editor unit/
component tests and one focused browser journey. The durable tests use owned
synthetic patches, not an approved face model. Real PostgreSQL 17 in an isolated
loopback test cluster verifies idempotent migration, exact constraint/index
rollback, rollback refusal when face work exists, tenant privacy and concurrent
idempotency. No application database is used. Repeating the migration/rollback
test requires a fresh isolated `ipw_face_test` database supplied through
`IPW_TEST_FACE_DATABASE_URL`; these tests never silently skip missing database
validation. Scoped Ruff/Mypy, web/API TypeScript checks and generated contract
drift checks also passed. These results do not clear Linux or real-model quality gates.

A provider outage during the worker's best-effort deletion can still leave an
unreferenced attempt object that was never checkpointed into PostgreSQL. Attempt-
unique prefixes make that object unreachable and safe to reap with the production
bucket's inventory/lifecycle policy; enabling and validating that provider policy is
deployment work, not a reason to delete shared content-addressed objects from an
unfenced worker. No deployment or application database migration was performed.

Release remains blocked on exact commercial face-model/dependency clearance and
real-photo quality/identity acceptance.
Linux-container, real Cloud Run/GCS large-file, calibrated HDR/P3 and physical
Safari/iOS/low-memory-device validations remain outstanding, not cleared by this
native mechanics increment. PDF, old Studio, deployment and merge remain out of scope.

## Native face adapter mechanics (implemented, unregistered)

The new adapter consumes server-held artifact paths and a release provider, not
customer URLs or approval flags. Exact artifact SHA-256/size and a canonical
bundle digest bind the model I/O, recipe, detector, Python/platform/architecture,
ONNX Runtime 1.30.0, ONNX 1.22.0, NumPy 2.5.2, pyvips 3.1.1 and libvips 8.18.5.
This configuration digest is not complete commercial dependency or binary-build
evidence. Those reviews, including the executed native colour libraries, remain
required. Windows mechanics evidence is not Linux production authority.

Graphs are parsed from verified bytes without resolving external files. Nested
dense/sparse/external tensors, custom domains and unsupported model functions are
refused before session construction. CPU-only, sequential, single-thread sessions
use the documented [ONNX Runtime controls](https://onnxruntime.ai/docs/performance/tune-performance/threading.html).
The bounded restorer contract remains RGB FLOAT `[1,3,512,512]`, a scalar
FLOAT/DOUBLE fidelity input and one matching finite output. Other model I/O and
HDR restorers need separate qualification, not an automatic fallback.

Source/base native samples are decoded once into private disk-backed scratch.
The source hash, actual framing, PNG colour authority and precision are verified;
identities are rechecked after decode and before publishing a proposal. One
complete overview/native-tile scan is planned before decoding scratch or running
the detector. More than 128 windows fails clearly; partial scanning is not success.
Zero/multiple confident faces and unreliable landmarks are refused. Prepared
alignment/source samples are reused for each fidelity inference and cleared on
success, failure, cancellation and release rejection. CPU inference/decode remain
cooperatively cancelled between native calls, not forcibly interrupted mid-call.

Alignment provenance stores source landmarks in integer micropixels, similarity
coefficients in integer nanounits, detector SHA/confidence and reprojection error.
It is bound into candidate review identity. Absent optional alignment preserves
the previous v1 candidate digest; no main contract version or migration changed.
Comparison and inverse sampling use the same source-pixel-centre coordinates at
native and larger base dimensions. Geometric masks are not semantic identity proof.

Processing retains continuous float neural detail and native uint8/uint16 base
precision; an eight-bit intermediate is not used for 16-bit proposals. Native
ICC SDR input is converted through floating XYZ using
[libvips ICC import](https://www.libvips.org/API/8.17/method.Image.icc_import.html)
and [native-depth ICC export](https://www.libvips.org/API/8.17/method.Image.icc_export.html).
Only a bounded model/reference luminance difference informs the proposal; native
base chromaticity, zero-delta samples, alpha and hidden transparent RGB remain
anchored. Native conversion/detail correction uses bounded tiles, not full-output
model tensors. No new clipped channels are accepted. Neural observations still
use an sRGB proxy, not an HDR/wide-gamut neural model. ICC/P3 colour accuracy still
needs qualified profiles and calibrated hardware review. PQ/HLG/unknown transfer,
conflicting colour authority, CMYK, unsupported PNG/APNG layouts, 16-bit animation
and transparent face-source inference fail clearly instead of being silently converted.

Focused owned synthetic ONNX graphs exercise actual CPU sessions, distinct
fidelities, sub-eight-bit native corrections, exact zero-delta colour, native ICC
transport, matching framing, reviewed PNG composition, digest preservation,
malformed/nonfinite outputs, revocation, source changes and private scratch cleanup.
The real pinned YuNet graph was also size/digest/self-containment checked locally;
no trained restoration model was loaded by this increment. These are mechanics
checks, not improved real-face quality, identity acceptance, unlimited image-size
support, Linux validation or a licence approval. The accepted ordinary logo,
illustration and photograph routes and the customer face release gate are unchanged.

Focused Windows checks for this adapter increment passed on 16 September 2026:
94 Python contract/native-renderer/native-adapter/durable-worker tests, 68 editor
unit/component tests, 9 isolated-editor API/delivery tests, scoped Ruff/Mypy,
web/API TypeScript and generated-contract drift checks. One ordinary customer
browser journey passed cleanly in the already-installed bundled Chromium revision
1234: upload, actual processed pixels, aligned comparison, nonprocessing zoom,
exact Reset and processed-PNG download. No production model was registered.

Installed-Chrome browser runs did not finish cleanly. The face harness first
timed out during capture; its retry wrote final private mechanics evidence but
did not exit cleanly and was stopped. The ordinary journey passed its assertions
but the worker was force-killed after a 300-second shutdown deadline (exit 1).
These are not counted as successful Chrome runner validation. The focused test
configuration now permits explicit `IPW_PLAYWRIGHT_IMAGE_QUALITY_CHANNEL=chromium`
selection and rejects unknown channels; its default remains `chrome`. No timeout,
assertion, tolerance or canonical Linux authority changed. Installed-Chrome
shutdown, Linux and real face-model release validation remain outstanding. The
owned synthetic PostgreSQL cluster was stopped; no application database was used.

On 22 September 2026, the completed block-six customer-mechanics increment passed
all 117 isolated web unit/component tests, including nine focused native routing,
recovery, raw-byte verification and 8/16-bit preview cases; web and API TypeScript
checks; the API build; and four focused owner-scoped face delivery/cancellation/
candidate-artifact tests. The API returns an explicit not-found error if an expired
cancellation loses its view instead of returning a nullable success. No model was
registered, no candidate job was created by capability preflight, no application
migration was run and no deployment occurred. The ordinary upload, real-pixel
enhancement, aligned comparison, reset and processed-download browser journey
passed by itself in bundled Chromium (1/1, 3.9 minutes on the final rerun). The earlier broader run
remains uncounted because its synthetic face-review harness timed out; no timeout,
assertion or tolerance was changed to hide that runner issue. These checks do not
validate an approved real model or restoration quality.

On 23 September 2026, the block-six lifecycle increment passed 19 focused Python
contract/storage/bounded-preview checks, 12 focused API delivery/storage/migration-
registry tests, all 117 isolated web tests, web/API TypeScript checks and the API
build. The focused real-pixel upload/enhance/compare/reset/download browser journey
also passed by itself (1/1); its download stream and page are explicitly closed so
the Windows Playwright worker exits cleanly. A pinned PostgreSQL 17.11 container on loopback verified the two focused
migration/repository journeys, including idempotent migration, guarded rollback,
cleanup-row seeding, exclusive leases and retry accounting. The 26-case durable
worker run passed 24 cases and exposed two new assertions: a real post-write release-
revocation tracking race and an incorrect zero-based-attempt assumption. The race
was fixed by registering the exact generation immediately after storage write; both
targeted cases then passed (2/2). No coverage threshold was changed, no broad suite
was claimed, the temporary database container was removed, and no application
database, release registration, deployment, PDF or Studio path was touched.

On 23 September 2026, the block-five temporal increment passed 75 focused Python
contract/native-renderer/native-adapter checks and all 28 durable face-worker checks.
The latter ran against an isolated PostgreSQL 17.11 loopback container and include
an actual two-frame durable candidate/composition journey. The output retained both
frames, the 80/120 ms delays and loop count; the temporary container was removed.
The focused API capability/delivery set passed 13/13, real PostgreSQL API checks
passed 2/2, all 117 isolated web tests passed, scoped Ruff/Mypy and web/API/
contract TypeScript checks passed, and generated schemas had no drift. These are
owned synthetic mechanics checks. The ordinary upload/process/compare/reset/download
browser journey also passed by itself in bundled Chromium (1/1): no model was
registered, no private photograph or research weight was committed, and no
application database, deployment, PDF or Studio path was touched.

On 24 September 2026, the focused image-quality gates were exercised in the
pinned Linux `canonical-ci` container on Docker Desktop's Linux x86_64 engine.
The environment verifier confirmed Python 3.14.5, Node 24.10.0, Playwright
1.62.1, Chromium 151.0.7922.34, Torch 2.13.0 CPU with one thread, Pillow
12.3.0, NumPy 2.5.2, ONNX Runtime 1.30.0, libvips 8.18.5 and the pinned font
digest. The focused Python contract/native-renderer/native-engine set passed
75/75, the durable face-worker set passed 28/28, isolated API delivery checks
passed 13/13 plus 2/2 against disposable PostgreSQL 17.11, and the isolated web
set passed 117/117. After a test-only canonical-route correction and clean image
rebuild, web TypeScript and all 117 web tests passed again in that container.

The ordinary upload/process/compare/reset/download journey then passed 1/1 in
7.1 seconds using the pinned bundled Chromium and production-safe browser
worker. It retained every decoded-pixel, no-CSS, aligned comparison,
nonprocessing zoom, exact reset, provenance and downloaded-byte assertion, and
additionally proved that canonical production evidence requested no quarantined
research model. A separate diagnostic confirmed WebGPU and worker adapters and
the exact locally held research-model digests, but one 64-pixel research tile
took about 174 seconds on software WebGPU. That research-only path is therefore
kept as local hardware-browser evidence; it is not distributed, deployed or
misrepresented as the authoritative Linux production route. No product
processing code, assertion threshold, visual tolerance, database migration,
PDF/Studio path, deployment or application data changed.

## Standalone dev web runtime evidence

On 24 September 2026 the isolated editor was also compiled through the pinned
`apps/web/Dockerfile` Linux image and exercised through that container rather
than Vite's development server. The runtime contains no PDF, Studio or batch
editor chunks, no source maps, and no `.onnx`/`.pth` research weights. Its root
redirect, deep-link fallback, health response and production security headers
were checked before the focused real browser journey passed upload, worker
processing, aligned comparison, reset and processed-PNG download (1/1, 2.0
minutes cold, then 1/1 in 13.9 seconds from the final rebuilt image). All 119
focused web unit tests and TypeScript also passed. This proves the deployable
browser surface; it does not claim the separate private Cloud Run/GCS
durable-worker validation.
