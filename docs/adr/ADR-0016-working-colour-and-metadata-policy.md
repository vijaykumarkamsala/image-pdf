# ADR-0016: Working Colour and Metadata Policy

**Status:** Accepted for Recovery 2E
**Date:** 2 September 2026
**Task:** RECOVERY-2E

## Context

Image enhancement and export must handle ICC profiles, EXIF orientation, alpha,
bit depth and private metadata truthfully. The product cannot infer an unknown
source profile with certainty, copy embedded thumbnails accidentally or promise
print-production approval from a digital export.

## Decision

1. Embedded ICC profiles are respected. The bounded worker converts supported
   tagged sources to the selected output profile through LittleCMS as exposed by
   Pillow ImageCms and fails closed on an uninterpretable profile.
2. Untagged RGB sources are described as untagged. The interactive proxy treats
   their channel values as sRGB for display but records that assumption; it does
   not claim the source was authored in sRGB.
3. Recovery 2E working output is sRGB unless the customer explicitly selects
   profile preservation or an executable supported profile. Display P3 is a
   contract capability only when the worker can create or preserve a verified
   profile; unsupported requests fail rather than inventing a tag.
4. EXIF orientation is applied exactly once during worker decode. Final output
   orientation is normalised and preview/export double rotation is tested.
5. Alpha is preserved for PNG, WebP and TIFF where the chosen bit-depth/codec
   supports it. JPEG requires an explicit flatten background and a visible lossy
   conversion warning.
6. Eight-bit JPEG, PNG, WebP and TIFF are supported. Sixteen-bit output is
   capability-gated to PNG/TIFF and must fail if the active engine cannot
   preserve the source precision. No silent 16-to-8 conversion is permitted.
7. Exported derivatives remove GPS, device data, maker notes, user comments,
   embedded thumbnails and unknown private blocks by default. Customers may
   explicitly retain approved copyright, description, capture-time or camera
   categories. GPS remains removed in Recovery 2E.
8. Metadata removal is verified by reopening completed output bytes and
   inspecting metadata categories. The decision and verification result are
   recorded in provenance. Originals remain unchanged.

## Consequences

Digital exports are truthful and privacy-preserving but are not declared
print-production approved. CMYK, spot colour, machine/material profiles and
print preflight remain outside Recovery 2E. Unsupported ICC or bit-depth paths
are visible release/capability failures, not automatic substitutions.

