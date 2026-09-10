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

1. Embedded ICC profiles are validated and respected. The bounded worker
   converts supported tagged sources through LittleCMS as exposed by
   Pillow ImageCms and fails closed on an uninterpretable profile.
2. Untagged RGB sources are described as untagged. An sRGB export records that
   its channel values were assumed to be sRGB before the canonical profile was
   attached; it does not claim the source contained an sRGB tag.
3. Recovery 2E working output is sRGB unless profile preservation is selected.
   Preserve is executable only for exactly one validated ICC-tagged RGB source
   and a supporting output format. It retains that profile exactly; untagged,
   CMYK and mixed-profile preservation fail closed.
4. ICC-tagged CMYK input is explicitly transformed to RGB through LittleCMS.
   Untagged CMYK input, CMYK output, Display P3, spot colour and print-device
   profiles remain unavailable.
5. Perceptual and relative-colorimetric intent plus black-point compensation are
   implemented in the API/worker path. React does not expose profile conversion
   as a free-standing recipe operation in this recovery.
6. EXIF orientation is applied exactly once during worker decode. Final output
   orientation is normalised and preview/export double rotation is tested.
7. Alpha is preserved for PNG, WebP and TIFF where the chosen codec
   supports it. JPEG requires an explicit flatten background and a visible lossy
   conversion warning.
8. Eight-bit JPEG, PNG, WebP and TIFF are supported. Sixteen-bit source and
   output paths fail closed because the active engine cannot preserve precision
   end to end. No silent 16-to-8 conversion is permitted.
9. Exported derivatives remove GPS, device data, maker notes, user comments,
   embedded thumbnails and unknown private blocks by default. Customers may
   explicitly retain approved copyright, description, capture-time or camera
   categories. GPS remains removed in Recovery 2E.
10. Metadata disposition is verified by reopening completed output bytes and
    inspecting each category. Evidence is persisted on the output and in
    provenance; `metadata_verified=true` is written only after verification.
    Originals remain unchanged.

## Consequences

Digital exports are truthful and privacy-preserving but are not declared
print-production approved. ICC-tagged CMYK input conversion is an image-export
capability; CMYK delivery, spot colour, machine/material profiles and print
preflight remain later product work. Unsupported ICC or bit-depth paths are
visible capability failures, not automatic substitutions.
