# User Flows & Edge Cases — Image & PDF Workspace

**Version:** 0.1  
**Date:** 24 August 2026  
**Purpose:** Preserve combinations, alternate paths, validations and recoverable failure behavior that are easily lost when only happy-path requirements are documented.

## 1. Universal rules

- Never mutate an original.
- A customer may skip enhancement entirely.
- Standard Enhance never silently invokes AI.
- AI actions remain explicit.
- Automatic local/cloud routing is default; Advanced override appears only when both routes are safe.
- Paid/usage events occur idempotently and cannot duplicate on retry.
- One item’s failure does not invalidate unrelated batch items/pages.
- Every customer-facing failure offers a next action when possible.

## 2. Guest image evaluation

### Happy path

1. Guest opens Enhance Images.
2. Guest uploads one eligible image.
3. System inspects file and creates a short-lived preview session.
4. Guest tries Standard or AI preview within free guest rules.
5. Guest compares original/result.
6. Download triggers signup.
7. After signup, eligible session/project is attached to the new workspace.

### Edge cases

- Email/account already exists: authenticate and attach safely.
- Guest session expires during signup: preserve metadata long enough to resume or explain re-upload.
- Multiple tabs attempt attachment: make operation idempotent.
- Guest exceeds rate/file limits: show reset/plan/signup path.
- Browser cleared: explain temporary project loss.
- Unsupported file: preserve no partial private artifact beyond cleanup window.

## 3. High-quality images to PDF without enhancement

1. Customer selects Create PDF.
2. Uploads many high-quality images.
3. System does not force enhancement or create unnecessary AI cost.
4. Customer orders images/pages and selects layout.
5. Professional export checks effective DPI/source suitability.
6. Customer downloads one PDF.

Edge cases:

- Mixed orientations
- Images with transparency
- Duplicate uploads
- Insufficient resolution for requested print size
- Extremely different aspect ratios
- Page size change after layout
- One missing/corrupt source before final render
- Customer wants only selected pages

## 4. Mixed-quality project

1. Customer uploads high- and low-quality images together.
2. System may recommend enhancement per item but does not auto-apply AI.
3. Customer leaves good images untouched.
4. Applies Standard Enhance to some and AI to selected others.
5. Selects preferred versions independently.
6. Uses the chosen original/derivative on PDF pages.

Edge cases:

- Enhancement finishes after asset was placed on canvas: do not replace automatically; ask/select version.
- Derivative deleted while used by a page: prevent deletion or offer replacement.
- AI result worse than original: retain all versions and allow original selection.
- Same asset appears on several pages with different crops: preserve non-destructive placement settings.

## 5. Standard Enhance flow

1. Inspect image.
2. Recommend safe standard settings.
3. Produce fast preview, usually locally.
4. Customer adjusts controls.
5. System selects local or cloud final processing.
6. Download/save result with recipe.

Edge cases:

- Browser and server implementations produce small differences: label preview and render authoritative final.
- Customer requests impossible detail recovery: explain limitation and offer optional AI.
- Orientation metadata conflicts with pixels: normalize preview without mutating original.
- Unsupported colour profile/bit depth: preserve where supported or disclose conversion.
- Transparent PNG exported as JPG: require background selection or warn about transparency loss.

## 6. Enhance with AI flow

1. Customer intentionally chooses Enhance with AI.
2. UI shows short statement that missing details may be reconstructed.
3. Natural is recommended; stronger/task-specific modes remain explicit.
4. Cloud job starts.
5. Customer can leave and return.
6. Result is compared with original/Standard version.
7. Customer selects/downloads preferred version.

Edge cases:

- No face detected when Face Restoration requested: explain and avoid charging/consume appropriately.
- Multiple/group faces: show that all/specific-face controls may differ; inspect identity per face.
- Face changed materially: flag/allow original or safer result; never replace silently.
- Text/logo changed: treat as critical failure for Natural/document/product modes.
- Colourisation uncertainty: label colours as estimated.
- Model/provider temporarily unavailable: queue, fallback only if approved, or offer retry/refund.
- Content too large for selected model: tile/professional queue or alternative model.
- Cancellation after compute started: communicate whether credits are held, released or partially consumed according to later policy.

## 7. Before/after and variations

- Support original/Standard/AI comparisons.
- Preserve zoom/pan synchronization.
- Clearly identify preview versus full result.
- Do not compare at different zoom/quality in a misleading way.
- If several variations exist, show settings and creation time.
- Deleting a variation must not remove another version.
- Regeneration with identical idempotency input should not create duplicate billing.

## 8. Local/cloud automatic routing

### Automatic route

- Simple, small, supported operation → local preferred.
- Saved/professional authoritative output → cloud CPU preferred.
- AI → cloud GPU initially.
- Large, batch or background continuation → cloud.

### Advanced override

- Customer may choose cloud for a locally eligible task.
- Customer may choose local only when operation/device/output is benchmark-approved.
- If device capability changes during the session, re-evaluate safely.
- If local processing fails, offer cloud retry without losing edits.
- If cloud is unavailable and local is eligible, offer local alternative.
- Avoid promising that local work continues after tab/browser closure.

## 9. Batch processing

1. Upload up to initial 50-item target.
2. Select all/some items.
3. Apply shared settings.
4. Override individual settings.
5. Start selected work.
6. Track state per item.
7. Retry failed items.
8. Download selected results/ZIP.

Edge cases:

- Duplicate filenames: use stable asset IDs and safe download names.
- One corrupt image: isolate failure.
- Mixed Standard/AI/untouched selection.
- User changes settings after some items started: apply only to unstarted/new version.
- Browser closes: cloud continues.
- Customer runs out of credits mid-batch: reserve estimated entitlement or pause remaining items; do not partially surprise-charge.
- ZIP generation fails: preserve individual results and retry packaging only.
- Partial cancellation: define selected/pending/in-progress behavior.

## 10. Large/professional image

1. Inspect compressed size, pixels, channels and bit depth.
2. Estimate processing resources.
3. Route to professional/tiled processing.
4. Show time and one-time/plan entitlement.
5. Notify on completion.

Edge cases:

- Small compressed file with enormous decoded size/decompression-bomb behavior.
- 100 MB file that is safe versus 20 MB file that is unsafe.
- Insufficient GPU memory: adjust tile size/requeue safely.
- Tile seam detected: fail quality gate or rerun; do not release bad paid output silently.
- Alpha/16-bit/profile unsupported by selected model: disclose conversion or route alternative.
- Extreme input exceeds hard ceiling: offer custom service/clear maximum rather than generic failure.

## 11. Download and one-time purchase

1. Customer selects 2×/4×/4K/8K/print/custom.
2. System recommends useful maximum and estimates final size.
3. Show included entitlement, credits or exact one-time price.
4. Customer pays if required.
5. Authoritative result is generated/unlocked.
6. Signed download is issued.

Edge cases:

- Payment succeeds but processing fails: retain entitlement and retry/refund according to policy.
- Processing succeeds but browser closes: result remains in workspace/history.
- Payment callback repeats: idempotent order.
- Customer selects 8K with no meaningful benefit: warn but allow when technically safe.
- Download link expires: authenticated regeneration without recharging.
- Customer requests a different format after purchase: later pricing policy decides included conversion versus new output.

## 12. Retention and deletion

- Default six months of inactivity for signed-in projects.
- User-selectable permitted retention.
- Warn before deletion.
- Reopening/extension updates inactivity according to policy.
- Delete all content derivatives/exports/temporary assets.

Edge cases:

- Project shared with others: owner/workspace policy controls deletion.
- Project has active job: prevent deletion or cancel/complete cleanup atomically.
- User deletes account but belongs to shared workspace: remove membership, not workspace-owned assets.
- Payment/audit records required after content deletion: retain no image content.
- Backup/object versioning delay: document effective deletion window.
- Guest-to-account conversion near expiry.

## 13. Workspace and sharing

- Every account has a personal workspace.
- Invitations can add Owner-approved Editors/Viewers.
- Billing/assets belong to workspace.
- Project links have permission, expiration, password and revocation.

Edge cases:

- Last Owner cannot leave without ownership transfer/deletion.
- Invitation email already belongs to another workspace/account.
- Revoked member has active session/download.
- Shared link leaked: revoke immediately and invalidate future access.
- Asset moved/copied between workspaces: explicit copy, ownership, billing and retention decision.
- Viewer attempts paid processing: deny or request permission.
- Concurrent edits: later editor architecture must define conflict/locking/version behavior.

## 14. Multi-page PDF creation

- Add/delete/duplicate/reorder pages.
- Multiple sizes/orientations.
- Images/text/shapes/signatures/background/page numbers.
- Original or derivative asset per placement.
- Undo/redo/autosave.
- Selected/all-page export.

Edge cases:

- Cannot delete the last remaining page; offer clear blank reset.
- Duplicated page must use new page/element IDs.
- Reordering must not change element coordinates/content.
- Change page size: choose scale, reflow or preserve-position behavior explicitly.
- Missing font: embed/substitute with preview warning.
- Overset text and content outside bleed/safe area.
- Low effective DPI on a placement.
- Very many pages: virtualized thumbnails/background export.
- Searchable/vector text versus flattened effects.

## 15. Existing PDF editing

1. Upload and inspect PDF.
2. Detect encryption/protection, forms, scanned pages and editable resources.
3. State supported capabilities.
4. Allow page operations and overlays.
5. Permit existing-content edits only where reliable.

Edge cases:

- Password-protected PDF: request password through secure UI; never log it.
- Owner restrictions: respect applicable permissions/policy.
- Scanned PDF: OCR may recognize text but reconstruction is a separate operation.
- Missing/subset embedded font: do not pretend exact editing.
- Digital signatures: modifications invalidate signatures; warn clearly.
- Forms, annotations, layers and attachments require explicit preservation policy.
- Large PDF: incremental/virtualized rendering and cloud export.
- Malformed PDF: isolate and report safely.

## 16. Project autosave and recovery

- Save non-destructive project state separately from generated files.
- Debounce frequent edits.
- Maintain revision/version capability for recovery.
- Display saving/saved/offline/error status.

Edge cases:

- Network lost during edits.
- Two tabs edit same project.
- Session expires while unsaved changes exist.
- Schema/version migration after application update.
- Referenced asset deleted or retention expired.

## 17. Security and abuse edge cases

- Fake extension/MIME mismatch
- Oversized dimensions/decompression bomb
- Malformed EXIF/ICC metadata
- Path traversal in filenames/ZIPs
- SVG/script-active content if supported later
- Malware-containing attachment/PDF
- Unauthorized guessed asset/project IDs
- Reused/expired signed URLs
- Excessive anonymous jobs
- External provider callback spoofing
- Model file tampering
- Sensitive image data in logs/error reports

## 18. Operational failure behavior

Normalize failures into actionable categories:

- Invalid input
- Unsupported format/feature
- Safety/resource limit
- Entitlement/payment required
- Queue capacity/delay
- Processor/model unavailable
- Processor quality failure
- Temporary infrastructure failure
- Permanent processing failure
- Cancellation

Each response should indicate whether the customer can change settings, retry, use an alternate route, wait, purchase capacity or contact support.

## 19. Decisions still needed during later design

- Exact browser-local final-download eligibility
- Credit reservation/refund semantics
- Concurrent editing conflict model
- PDF signature/form/layer preservation depth
- Sharing included in Release 1 versus later
- Notification channels
- Format/profile support matrix
- Effective deletion SLA

