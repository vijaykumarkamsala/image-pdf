# ADR-0019: Imported PDF Safe Capability Boundary

**Status:** Accepted
**Date:** 13 September 2026
**Task:** Imported-PDF-001

## Context

Edit & Manage PDF needs a safe first customer path before any imported-PDF
mutation is released. Product V2 requires the system to inspect encryption,
permissions, signatures, fonts, text, images, vectors, forms, annotations,
optional-content layers, tags, attachments, active content and page-size
variation before editing. It also requires active content to open disabled in a
safe mode and signed originals to remain protected.

An earlier intake policy rejected PDFs containing active-content markers. That
policy cannot satisfy the higher-authority V2 safe-mode requirement because it
prevents a customer from seeing a protected capability report. The custom PDF
engine remains quarantined pending its separate compatibility, security,
fidelity and licence benchmark.

## Decision

1. A clean-malware PDF that passes bounded generic intake is preserved as an
   immutable original even when generic inspection finds active-content or
   encryption markers. Markers remain visible as source facts; they are never
   executed.
2. Before acceptance completes, the canonical Linux Python worker runs pypdf
   6.18.1 in strict mode against bytes revalidated by SHA-256. A different
   library version is a startup/runtime error, not alternate authority.
3. The strict inspector traverses at most 20,000 structural objects. It does not
   render pages, decode content streams, invoke actions, open attachments,
   decrypt a document, substitute fonts or rewrite PDF bytes.
4. The report records every required feature exactly once as present, absent,
   unknown or restricted. Unknown is used when bounded inspection cannot make
   a truthful claim, including editable text and vector content.
5. Encryption forces credential-required view-only handling. Active content,
   attachments, dynamic XFA, signatures and unreadable structures force a
   restricted view-only boundary. A signed source can only be edited in a
   future, clearly labelled unsigned derivative workflow.
6. Only capability-report viewing is available in this slice. Download,
   unlock, page mutation, content editing, sanitisation and reconstruction are
   explicitly blocked or not released. No unavailable operation is represented
   as an active control.
7. Capability evidence is committed atomically with acceptance and bound to the
   source version, source SHA-256 and immutable storage generation. Database
   checks require PDF media type, matching digest and original protection.
8. NestJS authorizes report access through the owning workspace file and returns
   no cross-tenant evidence. React presents a non-rendering document map,
   restrictions, findings, operation boundary and advanced provenance.
9. The TypeScript local-development inspector is intentionally conservative:
   it may restrict more than the production inspector but can never enable an
   imported-PDF mutation. Only the pinned Linux worker produces authoritative
   production evidence.

## Consequences

Customers can safely understand why an imported PDF is restricted without
losing the original or implying unsupported editability. Malformed structures
that reach strict inspection can be retained with an unreadable, view-only
report; malware, spoofing, truncation and configured resource-limit failures
remain intake rejections.

This decision does not select a production PDF editing engine and does not
release page editing, object editing, password unlock, preview rendering,
redaction, repair, sanitisation, reconstruction or conversion. Those remain
separate increments with derivative provenance and review requirements.

## References

- `docs/features/IMPORTED_PDF_SAFE_INTAKE.md`
- `docs/product-v2/FUNCTIONAL_REQUIREMENTS.md` (FR-10)
- `docs/product-v2/PRODUCT_DECISION_REGISTER.md` (D2-057 through D2-067)
- `docs/adr/ADR-0018-native-screen-pdf-renderer.md`
