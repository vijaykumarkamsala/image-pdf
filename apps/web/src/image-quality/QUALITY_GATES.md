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
