# ADR-0003 — Header-first input inspection, without an imaging library

**Status:** Accepted
**Date:** 24 August 2026
**Task:** POC-003 (`docs/POC_TASKS.md`)
**Contract version:** 1.0.0 → 1.1.0 (additive)

---

## Context

POC-003 must "safely inspect images before processing and assign
standard/professional/blocked handling", and its acceptance criteria include:

> Excessive decoded dimensions are caught **before unsafe allocation** where
> possible.

The obvious implementation is to add Pillow or pyvips and ask it for the image
size. That reading fails the criterion on its own terms. A library that decodes
first and reports dimensions afterwards has already committed the memory by the
time the check runs — for the committed bomb fixture, roughly 10 GB before any
code of ours executes. Some libraries offer a lazy `open()` that reads only the
header, but the safety property then depends on a library-internal behaviour that
a version bump can change silently.

## Decision

**Parse headers directly. Decode nothing.**

PNG's `IHDR` is mandatory and first, so 33 bytes settle width, height, bit depth,
colour type and interlacing. JPEG's `SOF` segment is reachable by walking segment
lengths without touching entropy-coded data, and gives precision, dimensions and
component count. EXIF orientation comes from the `APP1` segment.

That is everything the safety decision needs, from a few hundred bytes, with no
pixel buffer in existence.

### Consequences

**No decode-bomb surface exists in POC-003.** A file declaring 3.6 gigapixels is
refused after reading 84 bytes. The rejection path is not "we caught it in time";
it is "there was never anything to catch".

**The runtime licence register stays at one entry.** No imaging library enters the
repository. Pillow or pyvips arrives with POC-004, which genuinely needs pixels,
and enters through the POC-002 gates with a real disposition record and a pinned
version (D-039).

**The parsers are ours to get right.** Roughly 300 lines handling untrusted input.
Mitigated deliberately: every length is bounds-checked against the buffer before
it is used to advance, a corrupt EXIF block yields no orientation rather than an
exception, and `test_inspection_defensive.py` exercises the malformed and hostile
branches specifically — corrupt chunk lengths, implausible IFD entry counts,
wrong-typed tags, fill bytes, standalone markers, truncated segments.

**Fewer formats are supported.** Only PNG and JPEG have parsers. That matches the
approved initial format set (PRODUCT_REQUIREMENTS.md §15) and open decision O-007.
Other signatures are *detected* — GIF, BMP, TIFF, WebP, HEIF, PDF, ZIP — and
refused with an accurate reason rather than a generic failure.

## Interpretation recorded: "normalize orientation metadata"

POC-003 asks to "normalize orientation metadata **without mutating the original**".
Rotating pixels would require both decoding and writing, and writing is exactly
what D-006 forbids.

The implementation therefore normalises the *metadata*: it reads the EXIF tag,
maps it to a transform (rotation, mirroring, whether the axes swap) and derives
the true **display** dimensions, which for the committed 16×8 fixture with
orientation 6 come out as 8×16. The transform is recorded for a later stage to
apply. Applying it to pixels is POC-004 work.

This also covers the `USER_FLOWS_AND_EDGE_CASES.md` §5 case: "orientation metadata
conflicts with pixels: normalize preview without mutating original."

## Classification

Four classes, from `SafetyPolicy` thresholds only — never a literal at a call
site, because the acceptance criterion requires the 25 MB / 100 MB policies to be
configurable rather than hard-coded throughout the codebase.

| Class | Meaning |
| --- | --- |
| `standard` | Within the 25 MB / 50 MP standard tier (D-021) |
| `professional` | Within 100 MB / 200 MP |
| `extreme_custom` | Beyond professional but below the hard ceilings — an actionable custom path, **not** a refusal (D-022) |
| `invalid` | Signature mismatch, unsupported format, malformed header, bomb, or a hard ceiling exceeded |

`extreme_custom` being *accepted* is the point of D-022: "Avoid a
customer-hostile simple rejection when an alternative path is possible." Hard
ceilings still exist above it.

## Decompression-bomb detection

Flagged when estimated decoded bytes exceed compressed bytes by a configurable
factor (default 1000×) **and** the pixel count is above a floor (default 8 MP).
The floor matters: a small flat PNG legitimately compresses at a huge ratio, and
flagging those would make the rule noise.

The bomb fixture triggers at 128,571,428×.

## Contract change: 1.0.0 → 1.1.0

Additive, backwards compatible. Older documents remain readable.

* `SafetyPolicy` — every inspection threshold in one configurable object.
* `Orientation` — EXIF tag, transform and whether the axes swap.
* `InspectionResult` — detected encoding, display dimensions, expansion ratio,
  `header_bytes_read`, and `pixels_decoded` (always `False` in POC-003).
* Failure codes `SAFETY.DECOMPRESSION_BOMB` and `SAFETY.BYTES_EXCEEDED`,
  previously conflated with `SAFETY.PIXELS_EXCEEDED`.

The bump changes every derived identifier. That is intended: results produced
under different contract versions must not silently compare equal.

## Closing the loop with POC-001

POC-001 validated *declared* manifest metadata; POC-003 reads the *actual* bytes.
Passing a manifest entry to `inspect_input` cross-checks the two, so a manifest
that misstates its own corpus is now detectable — a mismatch in media type,
dimensions, channels or bit depth refuses the asset. The check is policy-gated
(`verify_declared_metadata`) for corpora where declared metadata is known to be
approximate.

## Alternatives rejected

| Alternative | Why not |
| --- | --- |
| Pillow / pyvips for inspection | Fails "before unsafe allocation" unless you rely on lazy-open internals; adds a licence-register entry a task earlier than needed. |
| `imghdr` (stdlib) | Removed in Python 3.13, and it reported only the format, never dimensions or depth. |
| Decode into a bounded sandbox | Far more machinery than header parsing, and still allocates. |
| Trust manifest-declared dimensions | POC-001 already does that. The whole point of POC-003 is that a manifest can be wrong or hostile. |

## Related

- `docs/adr/ADR-0001-poc-001-foundation.md` — determinism and contract baseline
- `docs/adr/ADR-0002-monorepo-and-licence-gates.md` — D-039 supply-chain gate that Pillow will pass through at POC-004
- `docs/PRODUCT_DECISION_LOG.md` — D-006, D-021, D-022
- `docs/USER_FLOWS_AND_EDGE_CASES.md` §10, §17 — large-image and abuse edge cases
