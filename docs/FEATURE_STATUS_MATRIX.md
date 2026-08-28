# Feature status matrix

Prepared 28 August 2026 at commit `2cd007a` (tag `handoff-audit-2026-08-28`).
Status reflects code that exists. Nothing was fixed to produce this document.

## Status key

| Status | Meaning |
|---|---|
| **Working** | Implemented, reachable from the UI, covered by tests, verified running |
| **Defective** | Implemented and reachable, but produces a wrong or misleading result |
| **Partial** | Implemented, reachable, but materially incomplete |
| **UI only** | Interface exists, no working backend behind it |
| **Backend only** | Server code exists and is tested, nothing in the UI reaches it |
| **Hidden** | Implemented but deliberately not shown |
| **Not implemented** | Advertised or planned, no implementation exists |

**Processing location** is server-side Python in every case. Nothing is
processed in the browser: `getImageData`, `putImageData`, `toDataURL`, `toBlob`,
`OffscreenCanvas` and `createImageBitmap` appear nowhere in `apps/`. The canvas
is a display surface only. This diverges from approved decision **D-018**
(“Browser handles interaction/previews and eligible small work”), which is not
implemented. See the handoff document, §8.

---

## Home page and intake

| Capability | Status | Files | Tests | Known issue |
|---|---|---|---|---|
| Landing page | **Defective** | `apps/workspace/index.html`, `styles.css` | none (no UI tests) | Headline and the four job cards are document-scanning only. Does not present the approved parent-product modules. Reported issue 3. |
| Drop / browse upload | **Working** | `app.js load()` | `test_http_layer.py` | — |
| Job shortcuts (4 cards) | **Partial** | `app.js wireJobs, applyPendingJob` | none | "Remove a name" and "Make a scan searchable" need a PDF; choosing them with an image shows an error only *after* the file is picked. |
| Multi-file / batch upload | **Working** | `batch-view.js`, `server.py batch_process` | `test_batch.py` | Cap of 50 enforced with the number in the message. |
| Direct-to-storage upload | **Working** | `app.js uploadDirect`, `storage.py signed_upload_url` | `test_uploads.py`, `test_storage.py` | Falls back to inline base64 when signing is unavailable. |
| Inspect / file facts | **Defective** | `server.py inspect`, `app.js renderFacts` | `test_inspection*.py` | Megapixels and Handling come from the upload-time inspection and are never recomputed, so they contradict Size after any edit. Reported issue 2. |

---

## Image editing — standard

| Capability | Status | Files | Tests | Known issue |
|---|---|---|---|---|
| Resize | **Working** | `standard/pillow_engine.py`, `vips_engine.py`, `processor.py` | `test_standard_engines.py`, goldens | Presets and a live "what you'll get" line added 28 Aug. |
| Crop | **Working** | `app.js` crop overlay, engines | `test_standard_engines.py` | Drag on image, shape presets, two-way bound numbers. |
| Rotate | **Working** | engines | goldens | Lossless 90° steps. |
| Flip | **Working** | engines | goldens | — |
| Light & colour (adjust) | **Working** | `pillow_engine.adjust` | `test_standard_baseline.py` | Brightness, contrast, exposure, saturation, white balance. |
| Sharpen | **Working** | `pillow_engine.sharpen` | goldens | — |
| Reduce noise (denoise) | **Working** | `pillow_engine.denoise` | goldens | Was unreachable from the API until 27 Aug — missing entry in `_STANDARD_BUILDERS`. |
| Convert & export format | **Working** | `processor.py`, `deliver()` | `test_standard_engines.py` | CMYK JPEG accepted since 27 Aug; transparency → JPEG still refused rather than silently flattened. |
| EXIF orientation | **Working** | `pillow_engine.load`, `vips_engine.load` | `test_standard_engines.py::TestOrientationIsHonoured` | Phone photos were coming out sideways until 27 Aug. |

---

## Document processing

| Capability | Status | Files | Tests | Known issue |
|---|---|---|---|---|
| Straighten a photographed page | **Working** | `standard/perspective.py` | `test_perspective.py` (9) | Auto-detect; corners can be supplied but **the UI offers no way to drag them**, so a wrong detection cannot be corrected in the interface. |
| Clean up a photographed page | **Working** | `standard/document.py` | `test_document_clean.py` (13) | Measured: cast 64→0, unevenness 46%→3%. Burnt-out glare rendered as paper with a warning. |
| Make print-ready (combined) | **Working** | `pillow_engine.print_ready`, `vips_engine.print_ready` | **none** | Crop → clean → lift ink → enlarge. 899×1599 → 2673×4533 in 23 s. `grep -rn print_ready --include="test_*.py"` returns nothing: the headline operation has no test of its own. |
| Standard enlargement | **Working** | `standard/upscale.py` | `test_upscale.py` (17) | Back-projection. Measured vs plain resize: +3.78 dB text, +2.66 dB photo, +0.56 dB cloth. |

---

## AI operations

| Capability | Status | Files | Tests | Known issue |
|---|---|---|---|---|
| AI upscale | **Hidden-by-licence / Working locally** | `ai_adapters/real_esrgan.py`, `rrdbnet.py` | `test_real_esrgan.py` | Runs when weights present (77 s for 450×250 at ×4). **Weights licence `unknown`, DIV2K-derived — `licence_guard.py` refuses production start.** |
| AI denoise | **Working locally** | `ai_adapters/swinir.py` | `test_swinir.py` | Same licence position. |
| JPEG repair | **Working locally** | `ai_adapters/swinir.py` | `test_swinir.py` | Marked `advertised=False` (`catalogue.py:314`), but `advertised` appears nowhere in `apps/`, so the UI shows it regardless. ~145 s. |
| Face restoration | **Not implemented** | — | — | In the catalogue, `available: false`. **No adapter exists.** Installing weights would not help. |
| Damage repair | **Not implemented** | — | — | As above. |
| Colourisation | **Not implemented** | — | — | As above. |
| Background removal | **Not implemented** | — | — | As above. Registered model (`rembg-u2net`) is `review_required`. |
| Background replacement | **Not implemented** | — | — | As above. |

**Five of eight AI capabilities in the catalogue have no implementation.**

---

## PDF

| Capability | Status | Files | Tests | Known issue |
|---|---|---|---|---|
| Open / inspect PDF | **Working** | `pdf/reader.py`, `server.py pdf_inspect` | `test_pdf_routes.py` | — |
| Page grid / thumbnails | **Partial** | `pdf-view.js`, `pdf/images.py` | `test_pdf_routes.py` | Shows measured page size; renders a preview only for pages holding one full-page scan. Deliberate, per the comment at `pdf/images.py:70`: a guessed preview that differs from print is worse than none. No decision record covers this. |
| Split / keep pages | **Working** | `pdf/edit.py` | `test_pdf_edit.py` | — |
| Delete pages | **Working** | `pdf/edit.py` | `test_pdf_edit.py` | — |
| Reorder pages | **Working** | `pdf/edit.py` | `test_pdf_edit.py` | — |
| Rotate pages | **Working** | `pdf/edit.py` | `test_pdf_edit.py` | — |
| Merge documents | **Working** | `pdf/edit.py` | `test_pdf_edit.py` | Pages copied, not re-rendered. |
| Create PDF from images | **Working** | `server.py to_pdf` | `test_pdf_routes.py` | Reports effective DPI and print quality per page. |
| Add another image to a PDF | **Partial** | `app.js` `#btn-add-image` | none | Files are collected into `state.extraImages` and shown in a count, **but `exportPdf()` never reads them** — only the current image is exported. |
| Stamp text | **Working** | `pdf/edit.py` | `test_pdf_edit.py` | Own layer; artwork untouched. |
| Compress to a target size | **Working** | `pdf/compress.py` | `test_pdf_routes.py` | Refuses to return a larger file; reports honestly when it cannot hit the target. |
| Extract embedded images | **Working** | `pdf/images.py` | `test_pdf_routes.py` | — |
| OCR / searchable PDF | **Partial** | `pdf/ocr.py`, `pdf/textlayer.py` | `test_ocr.py`, `test_textlayer.py` | Works when Tesseract is installed. **Not installed on CI** (deliberate: the pinned tessdata cannot be fetched under the scope guard), so `ocr.py` is excluded from CI coverage. Availability reported to the UI. |
| Search text | **Working** | `pdf/content.py find_text` | `test_pdf_routes.py` | Returns coordinates. |
| Redaction | **Working** | `pdf/redact.py` | `test_redact.py`, incl. leak regression | Text is removed and verified against output bytes. A leak (original stream retained as an orphaned object) was found and fixed 27 Aug. |
| Bates numbering | **Working** | `pdf/numbering.py` | `test_numbering.py` | Returns `next_number` so a bundle runs unbroken. |
| PDF batch | **Working** | `batch-view.js`, `server.py batch_pdf` | `test_batch.py` | — |

---

## Vector

| Capability | Status | Files | Tests | Known issue |
|---|---|---|---|---|
| Raster → SVG | **Working** | `packages/vector/*` | `test_vector.py` | Verdict logic corrected 27 Aug: a single-colour logo was being told "almost nothing was found to trace". |

---

## Workspace, history and export

| Capability | Status | Files | Tests | Known issue |
|---|---|---|---|---|
| Canvas display | **Defective** | `app.js renderImages`, `styles.css .stage` | none | Root cause of the blank canvas (stage grew to image size, defeating fit) fixed in `867c29b`. **A `keepPlace` path may still leave an off-screen view after a size-changing operation — not reproduced.** Reported issue 1. |
| Zoom and pan | **Working** | `app.js` zoom block | none (no UI tests) | 5%–3200%, pointer-anchored, pixelated past 1:1. |
| Compare (before/after slider) | **Working** | `index.html #split`, `app.js` | none | Zoom stands down in this view by design. |
| Applied-operation history | **Partial** | `app.js state.applied` | none | Labels only. No thumbnails, timestamps, or per-step revert. Hidden until the first operation. Reported issue 6. |
| Undo | **Partial** | `app.js undo()` | none | One step at a time, unbounded memory, **no redo**, lost on reload. |
| Redo | **Not implemented** | — | — | — |
| Download (top bar) | **Defective** | `app.js download()` | none | Overlaps Export and ignores the Export format choice. Reported issue 5. |
| Export panel (JPEG/PNG/PDF/SVG) | **Working** | `app.js wireExport` | none | — |
| Batch ZIP download | **Working** | `server.py batch_zip` | `test_batch.py` | Duplicate names deduplicated; path components stripped. |
| Command palette (Ctrl+K) | **Working** | `app.js wirePalette` | none | Rebuilt per open from what is loaded. |
| Print-size planning | **Working** | `server.py print_plan` | `test_workspace_service.py` | Refuses impossible input since 27 Aug. |

---

## Infrastructure

| Capability | Status | Files | Tests | Known issue |
|---|---|---|---|---|
| Postgres schema + migrations | **Backend only** | `database.py`, `migrations/0001_initial.sql` | `test_database.py` (40) | Runs at startup. **No feature reads or writes a row.** |
| Job queue | **Backend only** | `jobs.py` | `test_jobs.py` (36) | No route enqueues anything. |
| Worker | **Backend only** | `worker.py` | `test_worker.py` (20) | No entry point in the Dockerfile. |
| Job handlers | **Backend only** | `handlers.py` | `test_handlers.py` (15) | Nothing registers them. |
| Connection pool | **Backend only** | `pool.py` | `test_pool.py` (15) | Nothing borrows a connection. |
| Licence guard | **Working** | `licence_guard.py` | `test_licence_guard.py` (11) | Refuses production start on uncleared weights. Currently would block production. |
| GCS storage | **Working** | `storage.py` | `test_storage.py` | Hand-rolled V4 signing, verified against a real bucket. |
| Authentication | **Not implemented** | — | — | None anywhere. |
| Accounts / multi-user | **Not implemented** | — | — | `accounts` table exists in the migration; nothing uses it. |
| Container image | **Partial** | `Dockerfile` | none | **Never built** — no Docker on the development machine. |
| Cloud Run deployment | **Not implemented** | `deploy/README.md` | — | Documented, never executed. |

---

## Counts

| Status | Count |
|---|---|
| Working | 39 |
| Works locally, blocked from production by licence | 3 |
| Defective | 4 |
| Partial | 7 |
| Backend only | 5 |
| Not implemented | 9 |
| **Total capabilities assessed** | **67** |

Counted by parsing the tables above, not by hand.

Operations offered by the API catalogue: **20** — 12 standard (always
available) and 8 AI, of which 3 report `available: true` and 5 report `false`.
Counted from a live `GET /api/catalogue` on 28 August 2026.
Test suite at this commit: **1703 passed, 1 skipped, 90.01% coverage, exit 0.**

---

## Closing assessment

### Genuinely reusable

The PDF package (`packages/pdf`, 4,945 lines, 83–99% covered). It reads and
writes PDF at the object level with no third-party PDF library, and the
redaction path verifies its own output bytes after a real leak was found there.
The standard processors (`perspective.py`, `document.py`, `upscale.py`) are
measured rather than asserted, use only Pillow, and carry numbers that were
produced by running them. The contracts package and the licence register are
sound and are the reason the missing-weights problem is visible at all.

### Experimental

Everything under `services/benchmark-runner` except `licence_register.py` and
`workspace.py`. It is a measurement harness for choosing models, not product
code, and the application imports two of its nineteen modules. `browser-lab` is
the same: a measurement page, not a feature. The AI adapters are experimental in
the commercial sense — they run, but on weights the register cannot clear.

### Needs redesign

The front end. `apps/workspace/app.js` is a single 1,892-line module holding
state, rendering, event wiring, history and export together, with no tests of
any kind — every UI defect in this matrix was found by screenshotting the
running page, not by a test. `server.py` is 1,984 lines in one class. The
landing page presents a document-scanning product rather than the approved
module set. Undo, history and the two download paths need to be one design, not
three.

### Unsafe or unknown

- **No authentication anywhere.** Any caller can use every route.
- **AI weights cannot be shipped.** Eight weight components are `unknown`, two
  `non_commercial`. `licence_guard.py` correctly refuses production start.
- **Five advertised AI capabilities have no code.** Not a packaging gap.
- **`basicsr` is `review_required`** and sits in the Real-ESRGAN execution path.
- **The whole job/worker/database/pool layer is untested in situ** — 126 unit
  tests, zero integration, nothing in production calls it.
- **The container has never been built** and deployment has never been run.

### Questions for the next team

1. Which modules is the home page meant to present? The approved set is in
   `docs/MASTER_PRODUCT_BLUEPRINT.md`; the built page does not match it.
2. Are the five unimplemented AI capabilities in scope, or should they be
   removed from the catalogue so the interface stops advertising them?
3. Is a commercially clearable upscaling model available? Every current
   candidate fails Gate A or Gate B.
4. Should processing move to the browser as decision **D-018** approved? Nothing
   is processed client-side today.
5. Is the job queue intended for this product, or was it built ahead of need?
   It is 820 lines of tested, unreachable code.
