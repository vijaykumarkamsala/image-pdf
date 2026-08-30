# User Flows and Edge Cases — Product V2

## 1. Guest file journey

1. Guest drops a file on the home page or selects device/cloud/blank.
2. Safe header inspection begins locally where practical.
3. The system preserves a temporary original and creates a safe preview.
4. Upload Intelligence explains source, problems and likely outcomes.
5. A recommended preview is generated but not applied.
6. The guest may compare and experiment within fair-use limits.
7. Save/history/collaboration attaches the session to an account and personal workspace.

Edge cases: existing account, expired guest session, multiple tabs, interrupted upload, unsupported file, duplicate file, malicious file, huge decoded size, guest abuse and signup failure.

## 2. High-quality source

The system reports that enhancement is unnecessary, offers editing/output directly and does not create artificial AI cost or visual damage. The customer may still choose explicit creative work.

## 3. Phone-photographed document

1. Detect page boundaries, perspective, glare, shadow and colour cast.
2. Recommend Preserve mode.
3. Generate corrected preview and OCR proposal.
4. Customer approves cleanup and reviews uncertain OCR.
5. Save faithful page plus searchable layer.
6. Editable reconstruction is a separate optional derivative.

Critical cases: prescriptions, identity/financial/legal documents, handwriting, mixed languages, tables, stamps, signatures, clipped corners, severe glare and characters that cannot be read truthfully.

## 4. Low-resolution illustration for textile use

1. Detect illustration/textile regions and compression/detail loss.
2. Ask physical size/process only when it changes the recipe.
3. Protect outlines, colour boundaries, fine stems/details and any text/logo.
4. Show largest trustworthy output.
5. If larger output needs Recreate, obtain permission and produce critical-region candidates.
6. Customer selects a candidate and reviews the AI-region map.
7. Run the selected factory/production profile and generate a derivative.
8. Withhold Production-ready if critical profile failures remain.

Critical cases: screenshot artifacts, uncertain copyright, JPEG halos, moiré, gradients, repeat seams, spot-colour limits, white underbase, fabric colour, insufficient line thickness and uncalibrated colour.

## 5. Mixed-content image

Different regions receive different recipes. Protected text/logo/face regions remain visible. The customer may edit masks, exclude regions or select a safer mode. No whole-image AI operation may silently change protected content.

## 6. Recreate approval

1. Explain why faithful output cannot reach the target.
2. Show trustworthy alternative.
3. Customer explicitly enables Recreate.
4. Generate two or three critical-region candidates.
5. Customer selects and approves reconstructed regions.
6. Full render runs.
7. Production export requires final AI-region acknowledgement.

## 7. Graphic document and artboards

- Import/open creates editable layers where compatible.
- Compatibility report lists unsupported PSD/SVG/AI features.
- Shared assets may be linked or detached.
- Smart Resize creates a new artboard.
- Autosave protects the working draft; checkpoints precede AI, flattening, major resize and export.
- Save As creates an independent document; Export never replaces the project.

## 8. Batch

1. Analyse each file.
2. Group compatible recipes and show exceptions.
3. Preview representative results.
4. Require individual approval for risk/Recreate.
5. Run durable jobs with per-item state.
6. Preserve successes, retry failed/checkpointed items and package outputs independently.

Edge cases: filename collisions, one corrupt file, settings changed mid-run, cancellation, queue outage, GPU failure, tile seams, cloud disconnect, partial ZIP failure and duplicate webhook/retry.

## 9. Quick images-to-PDF

1. Import images/project assets.
2. Create one editable page per image using the selected page policy.
3. Reorder pages and optionally add cover/text/new page.
4. Review page size, crop and effective resolution.
5. Run accessibility/output preflight.
6. Export one or several PDF profiles.

## 10. Scanned searchable PDF

Each page retains its visual source and separate OCR layer. Low-confidence regions are reviewable. OCR failure on one page does not block other pages. Reconstructed editable content is a separate derivative.

## 11. Existing PDF intake

1. Open in safe mode and create capability report.
2. Validate password, permissions, signatures, fonts, forms, annotations, layers, tags and active content.
3. Choose fully editable, limited, page management, reconstruction or view-only path.
4. Preserve signed original and unsupported objects.

Edge cases: encrypted PDF, owner restrictions, subset fonts, missing fonts, XFA/dynamic forms, portfolios, attachments, JavaScript, malformed xref, huge pages, mixed sizes, optional layers, existing redactions and signed/certified documents.

## 12. Merge, split and page management

Focused home shortcuts open Manage Pages view. The customer can switch to full editing without re-uploading. Page operations preserve labels/bookmarks/forms/tags where supported and disclose changes. No remaining-page edge creates an invalid document.

## 13. PDF text/font editing

- Exact font available and editable: edit while preserving layout.
- Open-licensed font unavailable locally: resolve/download approved version.
- Customer-owned font: activate from workspace library/provider.
- Preview/print-only embedded font: preserve appearance; do not use for new content.
- Missing commercial font: upload/connect/purchase or approve substitution.
- Reflow/overflow/glyph differences trigger page review.

## 14. Redaction

1. Mark text/images/pages/pattern matches.
2. Review marks and effect.
3. Apply to a new derivative.
4. Remove underlying content.
5. Sanitize selected/all hidden content.
6. Verify forbidden strings/objects are absent.
7. Produce report without exposing redacted values.

## 15. Repair/compress/convert

- Compression preview shows size and visual changes.
- Repair reports recovered, lost and changed objects.
- PDF-to-Office conversion flags page-level uncertainty.
- Conversion/repair never replaces the original.

## 16. E-sign envelope

1. Sender selects document/version and recipients/roles.
2. System recommends assurance based on risk/jurisdiction.
3. Sender selects sequential/parallel/mixed routing, fields, expiry and reminders.
4. Recipient uses secure link without mandatory account and completes required authentication.
5. Events and consent are recorded.
6. Final tamper-evident document and audit package are produced.
7. API/webhooks expose idempotent state.

Edge cases: recipient decline, expired link, bounced email, changed recipient, OTP failure, signer substitution, document changed after send, duplicate webhook, provider outage, certificate expiry/revocation, jurisdiction/provider unavailable and legal hold.

## 17. Cloud-linked source

- Import as copy: no continued source relationship.
- Import as linked: external updates create source versions.
- Customer chooses update behaviour once and may remember it.
- Frozen/approved/archived versions never auto-update.
- Save to cloud creates a new file/provider version by default.
- Disconnect never deletes external content.

## 18. Collaboration and locks

- One active editor lease per document.
- Others view/comment and edit other documents.
- Disconnect autosaves and lease expires.
- Owner takeover is warned/audited.
- Permission origin is visible.
- Unresolved comments carry to later versions with links; resolved comments remain historical.

## 19. Retention/deletion

- Six-month inactivity applies only to an entirely inactive free workspace.
- Repeated notices precede scheduling.
- Policy/legal hold may override.
- Delete revokes access immediately and enters disclosed trash.
- Permanent purge expires active storage and backups within policy.
- External provider files are unaffected.

## 20. Failure vocabulary

All failures map to actionable categories: invalid input, unsupported feature, security restriction, resource/fair-use limit, queue delay, processor unavailable, quality failure, temporary infrastructure failure, permanent failure, cancellation or policy/permission denial.

Every error states what remains safe, whether retry is valid, whether a different route/profile is available and how to contact support using the trace ID.
