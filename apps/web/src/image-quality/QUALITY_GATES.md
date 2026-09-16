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
audit or whole-product completion. **Three blocks are implemented; three remain.**

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
4. **Remaining:** native detector/alignment/inverse-alignment and the approved
   real face-model adapter producing proposals in the base's native colour and
   precision. The renderer rejects an 8-bit patch for a 16-bit base; it does not
   manufacture professional precision by scaling eight-bit channels.
5. **Remaining:** temporal proposals, review and composition for animated input.
   The new renderer explicitly refuses APNG instead of flattening it.
6. **Remaining:** customer-page native routing, candidate review/progress recovery
   and streamed downloads for remote-only/high-precision/oversized face results,
   including expired/failed private-artifact lifecycle cleanup.
   The existing browser face path remains unregistered and unchanged.

The native still core currently accepts non-interlaced, full-channel 8/16-bit
RGB/RGBA PNG bases and matching-precision straight-RGBA proposals. Palette,
grayscale, keyed-transparency and interlaced bases require a separate adapter.
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

A private object written before lease loss, cancellation or revocation can remain
unreferenced and unavailable to customer delivery. The worker never deletes shared
content-addressed objects to "clean up" a stale invocation. Retention/garbage
collection must be completed with the native customer/lifecycle integration before
enabling a production model. No deployment or application migration was performed.

Release remains blocked on exact commercial face-model/dependency clearance,
real-photo quality/identity acceptance and the three integration blocks above.
Linux-container, real Cloud Run/GCS large-file, calibrated HDR/P3 and physical
Safari/iOS/low-memory-device validations remain outstanding, not cleared by this
native mechanics increment. PDF, old Studio, deployment and merge remain out of scope.
