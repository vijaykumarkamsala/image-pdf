# Image Quality Editor evidence gates

This file applies only to the isolated `/image-quality` editor. It does not
change Studio, PDF, Recovery, schema, contract or deployment authority.

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
The actual face detector/model adapter, candidate comparison UI, approved region
export/provenance integration and exact-photograph acceptance are still unfinished.
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
