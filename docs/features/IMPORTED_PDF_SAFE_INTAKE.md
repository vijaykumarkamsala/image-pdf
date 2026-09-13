# Imported PDF Safe Intake

**Release slice:** Imported-PDF-001
**Status:** Implemented and merged; canonical Linux and PostgreSQL gates passed

## Customer outcome

Edit & Manage PDF is an active signed-in outcome for PDFs that completed secure
intake. A customer can see each inspected PDF, its page count when available and
its classification, then open a safe capability workspace. The workspace shows
the immutable-original guarantee, opening mode, required structural findings,
currently available operations, compatibility notes and advanced source
provenance.

The page map is deliberately non-rendering. It communicates document structure
without parsing page content in the browser or implying that imported PDF
editing is already available.

## Inspection and safety truth

- Generic intake still verifies declared type, actual type, byte/page limits,
  completion and malware state before an original can be accepted.
- Active-content and encryption markers become source facts instead of causing
  automatic loss of an otherwise clean original.
- The pinned Linux Python worker rechecks SHA-256 and uses pypdf 6.18.1 strict
  structural parsing with a 20,000-object traversal budget.
- The inspector records encryption, permissions, signatures, fonts, text,
  images, vectors, forms, annotations, optional-content layers, tags,
  attachments, active content and mixed page sizes exactly once.
- No action, attachment, script or dynamic form is executed. No password is
  requested or tested. No content stream is decoded, page rendered, font
  substituted, PDF flattened or byte rewritten.
- Encrypted, active, embedded, dynamic, signed and unreadable cases fail closed
  into credential-required or restricted view-only modes. Unknown evidence is
  disclosed rather than converted into an editability claim.

## Runtime ownership

- Python owns authoritative production inspection in the pinned Linux worker.
- NestJS owns durable acceptance, source-version binding, tenant authorization
  and report APIs.
- React owns responsive capability presentation and exposes no mutation control.
- The local TypeScript adapter exists only for deterministic development. It is
  always conservative and never production authority.
- The quarantined custom PDF engine is not imported or executed.

## Deliberately deferred capabilities

Page reordering, splitting, merging, object editing, rendering, valid-credential
unlock, download, repair, redaction, sanitised copies, reconstructed copies and
fidelity reports are not released by this slice. Fully editable, limited and
reconstructable classifications remain contract vocabulary for later approved
engine-backed workflows; this implementation does not issue those claims.

## Persistence and rollback

Migration `0022_imported_pdf_capability.sql` adds JSON capability evidence to
upload sessions and immutable source inspection facts. Checks bind non-null
evidence to PDF media type, the verified source SHA-256 and
`original_protected=true`. The migration is forward-only.

Operational rollback disables the Edit & Manage PDF entry and report routes
while retaining immutable originals, source facts and reports. It does not
delete customer data or reverse the schema in place.

## Verification

Focused evidence covers contract invariants, strict plain/active/encrypted/
signed/unreadable worker inspection, generic intake behavior, checkpoint replay,
API tenant isolation, migration idempotency, real PostgreSQL atomic persistence,
web type/unit checks, responsive Playwright journeys, accessibility scanning and
canonical Linux visual baselines. Windows remains behavioral compatibility
evidence; Linux is production and visual authority.
