# ADR-0018: Native Screen PDF Renderer

**Status:** Accepted
**Date:** 12 September 2026
**Task:** Native-PDF-001

## Context

The first customer-facing Create PDF journey needs a production renderer without
promoting the quarantined custom PDF engine. The editable native snapshot must
remain authoritative, originals must remain immutable, and an exported file
must not claim accessibility or archival conformance that the active renderer
does not provide.

The production processing worker runs in the pinned Linux Cloud Run image. PDF
bytes can vary across renderers and dependency versions, so output evidence must
be produced by that canonical image rather than by a developer workstation.

## Decision

1. The first release supports a native blank PDF or an ordered selection of up
   to 50 verified JPEG, PNG, WebP or single-page TIFF sources. Pages are A4 or
   Letter, portrait or landscape, with contain placement and no automatic crop.
2. The native editor snapshot remains the editable master. PDF pages are mapped
   one-to-one to ordered point-based artboards and use the existing lease,
   autosave, immutable-version, history and tenant-authorization boundaries.
3. ReportLab Open Source 5.0.1 is the authoring adapter. pypdf 6.18.1 is an
   independent strict structural validator after rendering. Pillow 12.3.0
   performs verified raster decode, orientation and ICC-to-sRGB conversion.
   Exact dependency and font identities are startup gates.
4. The only enabled output is Screen PDF profile 1.0.0. It is explicitly
   untagged and not PDF/A. The profile preserves visible plain IPW Standard text,
   verified raster images, solid backgrounds and square rectangle shapes.
5. Preflight and the worker both fail closed for unsupported page/layer state,
   stale version evidence, groups, advanced typography, unsupported shapes,
   masks, raster adjustments, blend/opacity/skew or incomplete source facts.
6. The worker reopens immutable generation-bound source bytes, verifies their
   digest and decoded facts, renders deterministically, then uses pypdf to check
   page count and dimensions and reject encryption, active actions, forms or
   embedded files before publishing a derivative.
7. Export requests, jobs, results, audit records and zero-charge usage evidence
   are durable and tenant scoped. Results are append-only and downloads recheck
   generation, byte count and SHA-256.
8. The custom engine under `packages/pdf` remains unconnected to production.
   It may only be reconsidered after the existing fidelity, compatibility,
   security and licence gates are met.

## Consequences

Customers receive a bounded, truthful first PDF-creation path while native
project data remains ready for richer profiles. Tagged accessible PDF, PDF/A,
mixed page sizes, templates, imported-PDF editing, OCR, forms, links, bookmarks,
advanced typography and print profiles remain separate product increments.

ReportLab and pypdf are retained under their reviewed BSD-3-Clause terms; the
embedded IPW Standard font remains the existing exact CC0-1.0 subset. Canonical
byte and visual baselines belong to the pinned Linux image. Windows remains a
behavioral compatibility environment and is not a byte-authority environment.

## References

- [ReportLab 5.0.1 package](https://pypi.org/project/reportlab/)
- [ReportLab open-source licence](https://github.com/MrBitBucket/reportlab-mirror/blob/master/LICENSE)
- [pypdf 6.18.1 package](https://pypi.org/project/pypdf/)
- [pypdf licence](https://github.com/py-pdf/pypdf/blob/main/LICENSE)
- `docs/features/NATIVE_PDF_CREATION.md`
