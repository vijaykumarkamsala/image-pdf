# Native PDF Creation

**Release slice:** Native-PDF-001
**Status:** Implemented; canonical Linux and PostgreSQL gates required before merge

## Customer outcome

Create PDF is an active signed-in outcome. A customer can create one blank page
or arrange up to 50 accepted images, choose A4 or Letter and portrait or
landscape, name the PDF, and choose Default Files or a project. Image order is
page order, images use contain placement inside a 24-point margin, and original
bytes are never changed.

The result opens in the shared native editor with PDF-specific language and
controls. Customers can add, remove, rename and reorder pages; add accepted
images, plain IPW Standard text and square rectangles; use autosave, versions,
undo/redo and lease takeover; and store image descriptions or mark images as
decorative for future tagged output.

## Output truth

The enabled Screen PDF is sRGB, uses safe document metadata and contains visible
text rather than a flattened page image. It is **untagged** and **not PDF/A**.
The export dialog states those limits before submission and shows blocking,
warning and informational preflight findings.

An export is tied to an immutable native document version and snapshot digest.
The durable job can be cancelled or retried. A completed download is served only
after its object generation, byte count and SHA-256 are revalidated.

## Runtime and security boundary

- React owns source ordering, page editing, preflight presentation and export
  monitoring. It does not render authoritative PDF bytes.
- NestJS owns tenant authorization, input policy, immutable-version preflight,
  durable request/job creation, audit, zero-charge usage and verified delivery.
- The pinned Linux Python worker owns raster decode, ICC-to-sRGB conversion,
  rendering and independent structural validation.
- ReportLab 5.0.1 authors the PDF; pypdf 6.18.1 reopens it in strict mode. The
  worker refuses any different versions or standard-font bytes.
- Immutable raster sources are generation-bound and are rechecked against their
  recorded format, dimensions, frame count, bit depth, profile presence and
  colour model. Combined compressed input is limited to 128 MiB and output to
  256 MiB.
- The published PDF is rejected if it is encrypted, has an unexpected page
  count/size, or contains active actions, an AcroForm or embedded files.

## Deliberately deferred capabilities

This slice does not claim completion of the full FR-8 PDF workspace. It does not
include templates, scans/OCR, existing-PDF import/editing, mixed page sizes,
master pages, vectors, rounded/advanced shapes, grouped rendering, rich text
runs, non-ASCII font coverage, links, forms, bookmarks, signature fields,
tagged accessible output, PDF/A, print profiles or the custom PDF engine.

## Persistence and rollback

Migration `0021_native_pdf_creation.sql` adds PDF export requests/results,
idempotency, job targeting and append-only result enforcement. The migration is
forward-only. Operational rollback disables the Create PDF feature and worker
route while retaining native documents, queued evidence and derivatives; it
does not delete customer data or reverse the schema in place.

## Verification

Focused evidence includes contract validation, API creation/preflight/durable
request tests, PostgreSQL migration/repository integration, worker deterministic
render/ICC/strict-reopen tests, web unit/type checks, and the Playwright native
PDF journey with an accessibility scan. Byte-exact and visual authority remains
the pinned canonical Linux CI image; Windows checks behavior and compatibility.
