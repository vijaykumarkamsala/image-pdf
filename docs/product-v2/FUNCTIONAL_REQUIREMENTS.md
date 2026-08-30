# Functional Requirements — Product V2

Requirement keywords **MUST**, **SHOULD** and **MAY** are normative.

## FR-1 Home, onboarding and accounts

- FR-1.1 The public home MUST present all major outcomes equally and make upload the fastest guest action.
- FR-1.2 Cloud import and blank creation MUST be visible secondary actions.
- FR-1.3 A focused shortcut MUST open the shared editor with the relevant workspace/panel selected.
- FR-1.4 A signed-in home MUST prioritise recent projects, shared work, quick create/import and job status.
- FR-1.5 Every account MUST receive a personal workspace and default files/project area.
- FR-1.6 The data model MUST NOT classify customers permanently as individual or business.
- FR-1.7 Guest work MAY be evaluated in a temporary session; saving, history and collaboration require account attachment.

## FR-2 Upload intelligence

- FR-2.1 Inspect real file signatures before trusting extension or MIME.
- FR-2.2 Detect corruption, dangerous decoded dimensions, malformed metadata and unsupported content without unnecessary full decode.
- FR-2.3 Calculate hash, dimensions, megapixels, orientation, frames/pages, alpha, bit depth and colour/ICC facts.
- FR-2.4 Detect sensitive EXIF/GPS metadata.
- FR-2.5 Classify source and regions among photos, portraits, documents, scans, illustrations, logos, screenshots, products, transparent graphics, textile artwork, repeats, high-quality assets and mixed content.
- FR-2.6 Detect relevant blur, noise, compression, exposure, glare, shadow, colour cast, skew, moiré, damage, pixelation, transparent halos and readability risks.
- FR-2.7 Present confidence and allow classification correction.
- FR-2.8 Infer intended use; interrupt only if the answer materially changes processing.
- FR-2.9 Generate a proposed safe-correction preview automatically but apply only after confirmation.
- FR-2.10 Report quality dimensions separately; do not collapse them into a deceptive universal score.
- FR-2.11 State when no enhancement is needed.

## FR-3 Image enhancement and reconstruction

- FR-3.1 Choose Preserve, Restore or Recreate using content and intended use.
- FR-3.2 Request explicit permission before Recreate.
- FR-3.3 Protect text, faces, logos, signatures and critical outlines by region.
- FR-3.4 Process mixed-content regions with compatible recipes.
- FR-3.5 Highlight substantially reconstructed regions and require production-export approval.
- FR-3.6 If an output exceeds trustworthy source capacity, show the largest trustworthy size and offer Recreate separately.
- FR-3.7 Recreate MUST generate two or three quick critical-region candidates and fully render only the selected candidate.
- FR-3.8 Provide simple outcome/strength controls first and full controls in Advanced.
- FR-3.9 Support crop, rotate, flip, resize, colour/light correction, sharpen, denoise, deblur, compression repair, damage repair, background removal/replacement, colourisation, face restoration and controlled super-resolution where validated and licensed.
- FR-3.10 Preserve processing recipe, model/provider version, weight hash and AI-region map.

## FR-4 Image & Graphic Studio

- FR-4.1 Store normal corrections as non-destructive adjustments/masks.
- FR-4.2 Store accepted AI results as new named layers/variants.
- FR-4.3 Support raster, vector, text and shape layers in one document.
- FR-4.4 Support groups, locks, masks, clipping, blending, opacity, alignment, grids, guides and rulers.
- FR-4.5 Support selection, healing, cloning, drawing, vector paths/Boolean operations, tracing, typography and effects.
- FR-4.6 Support multiple independent artboards with shared assets/styles.
- FR-4.7 Allow shared objects to be linked or detached; workspace brand assets are linked by default.
- FR-4.8 Smart Resize creates a new artboard and proposed layout.
- FR-4.9 Import verified structures from PSD/SVG/AI-compatible sources where possible and show a compatibility report.
- FR-4.10 Our native project format is authoritative; unsupported external features MUST NOT be silently discarded.
- FR-4.11 Choose a task-based workspace from source/use while retaining All Tools and command search.
- FR-4.12 Support continuous autosave, persistent undo/redo, automatic checkpoints and named versions.

## FR-5 Print and physical production

- FR-5.1 Provide versioned researched baseline profiles plus editable factory profiles.
- FR-5.2 A factory profile MUST support machine/RIP, material/fabric, substrate colour, ink configuration, physical dimensions, effective PPI, colour/ICC profile, transparency, white underbase, separations, line/text minimums, bleed, safe zones, repeat, mirroring, output format and proof policy.
- FR-5.3 Baseline families include DTG/DTF, screen/spot colour, sublimation/all-over, direct-to-fabric, seamless repeat, embroidery preparation, cut/vector and paper/fine-art printing.
- FR-5.4 Preflight MUST validate only against the selected profile/version.
- FR-5.5 Critical failure withholds the Production-ready approval.
- FR-5.6 An authorised user MAY Export anyway with recorded reason unless a strict profile forbids override.
- FR-5.7 Physical sample/swatches are optional tracking records; a profile/project MAY make approval mandatory.
- FR-5.8 Digital quality alone MUST NOT be represented as proof of machine/fabric colour or production behaviour.

## FR-6 Digital output and Export Center

- FR-6.1 Save, Save Version, Save As, Export, Download and Share MUST have distinct meanings.
- FR-6.2 One Export button opens the Export Center.
- FR-6.3 Completed exports offer Download, save to connected cloud and Share.
- FR-6.4 Support quick re-export with the last approved preset.
- FR-6.5 Support multiple profiles, sizes and formats in one job with individual or ZIP delivery.
- FR-6.6 Render every output directly from the editable master.
- FR-6.7 Digital profiles include web/app, social, email, marketplace, presentation, archive and custom.
- FR-6.8 Support validated PNG, JPEG, WebP, AVIF, SVG, TIFF and PDF behaviour as appropriate.
- FR-6.9 Preview actual pixels, target screens, safe areas, transparency, compression and file size.
- FR-6.10 Built-in presets are versioned; workspaces may create custom presets and receive update notices.
- FR-6.11 Remove sensitive GPS/device metadata from exports by default with explicit preserve option.

## FR-7 Batch processing

- FR-7.1 Initial target supports at least 50 items and is architected for configurable limits.
- FR-7.2 Analyse every item independently and group compatible recipes.
- FR-7.3 Keep exceptions visible and allow per-item overrides/exclusion/full editing.
- FR-7.4 Show representative group previews; require individual confirmation only for flagged risk/Recreate.
- FR-7.5 Run cloud batches as durable background jobs that survive client closure.
- FR-7.6 Cancel pending items, preserve completed results and isolate failures.
- FR-7.7 Retry from safe checkpoints without duplicating work or usage.
- FR-7.8 Use safe editable naming templates and never overwrite originals or existing exports.

## FR-8 Create PDF

- FR-8.1 Support quick images-to-PDF, scan-to-searchable-PDF, blank, template, project-assets and existing-file entry paths.
- FR-8.2 All entry paths open the same editor with progressive disclosure.
- FR-8.3 Keep text, images, vectors, shapes and backgrounds as independent native-project layers.
- FR-8.4 Support page thumbnails, reorder, add, remove, duplicate, sections and status.
- FR-8.5 Add Page supports blank, cover/text, image/asset, another PDF page, template, duplicate, camera/scan and cloud import.
- FR-8.6 Use one page size by default, allow per-page sizes and provide a safe Normalize Pages operation.
- FR-8.7 Support section-aware master pages with page override/detach.
- FR-8.8 Treat form fields, links, bookmarks and signature fields as editable validated objects.
- FR-8.9 Export screen, small, print, accessible and archival profiles independently from one master.
- FR-8.10 Automatically generate accessible structure and preflight; ask for missing human meaning such as alt text.

## FR-9 Scan and OCR

- FR-9.1 Detect page boundaries, orientation, perspective, glare, shadow and colour cast.
- FR-9.2 Generate cleanup and OCR proposals but apply only after confirmation.
- FR-9.3 Preserve the visual page and store searchable OCR text separately.
- FR-9.4 Flag low-confidence OCR regions and support correction.
- FR-9.5 Create a reconstructed editable page only on explicit request and show differences.
- FR-9.6 Preservation mode MUST prevent AI from silently rewriting visible medical/legal/financial text.

## FR-10 Edit & Manage PDF

- FR-10.1 Inspect encryption, permissions, signatures, fonts, text, images, vectors, forms, annotations, layers, tags, attachments, active content and conformance before editing.
- FR-10.2 Classify PDFs as fully editable, limited, page-management only, reconstructable copy or view-only.
- FR-10.3 Never silently flatten unsupported content.
- FR-10.4 Provide Manage Pages and Edit Page views in the same workspace.
- FR-10.5 Manage pages supports merge, split, ranges/bookmarks/target size, reorder, remove, extract, duplicate, rotate, crop, insert, normalise, labels and sections.
- FR-10.6 Edit supports permitted text, images, vectors, links, forms, annotations, OCR, layers, comments, watermarks and page furniture.
- FR-10.7 Preserve unaffected native PDF objects and disclose unavoidable compatibility changes.
- FR-10.8 Protect signed originals; permitted edits create clearly labelled unsigned derivatives.
- FR-10.9 Open active content in sandboxed safe mode with actions disabled and offer sanitisation.
- FR-10.10 Unlock requires valid password/authorised credential and creates a decrypted derivative.

## FR-11 Fonts

- FR-11.1 Resolve exact family, weight, style and version where possible.
- FR-11.2 Respect OpenType/PDF embedding rights.
- FR-11.3 Recover approved open-licensed fonts automatically or with one click.
- FR-11.4 Support customer-owned workspace font uploads and authorised provider connections.
- FR-11.5 Validate/scan uploaded fonts and control project/workspace use and raw download.
- FR-11.6 Never download or redistribute an unlicensed commercial font.
- FR-11.7 Compare line breaks, glyphs, overflow, spacing and geometry after font changes.

## FR-12 PDF compress, repair, convert and redact

- FR-12.1 Compression offers purpose presets and Advanced controls with size estimate and visual comparison.
- FR-12.2 Repair creates a recovered derivative and reports recovered/lost/changed objects.
- FR-12.3 PDF-to-Office/reconstructed conversion creates a page-level fidelity report.
- FR-12.4 Support validated conversions to/from office formats, HTML, images and PDF/A through approved engines.
- FR-12.5 Redaction marks remain reversible in the project until Apply.
- FR-12.6 Apply creates a permanently redacted and sanitised derivative and verifies removed bytes/hidden data.

## FR-13 E-sign

- FR-13.1 Provide native envelope UI, signing portal, public API, audit evidence and webhooks.
- FR-13.2 DocuSign/Adobe Sign adapters are optional; regulated trust-provider adapters are supported where required.
- FR-13.3 Recipients do not require product accounts; secure links and sender policy determine authentication.
- FR-13.4 Support email, OTP, identity and qualified signing levels through policy/provider capability.
- FR-13.5 Recommend assurance using document risk and jurisdiction without claiming universal legality.
- FR-13.6 Support sequential, parallel and mixed routing with approver, signer, witness and copy roles.
- FR-13.7 Preserve consent, events, authentication evidence, timestamps, hashes, certificate validation and final audit package.
- FR-13.8 Normal PDF editing/export MUST NOT require e-sign.

## FR-14 Projects, sharing and collaboration

- FR-14.1 Support lightweight and structured project styles.
- FR-14.2 Support collections and true subprojects.
- FR-14.3 Permission inheritance is default; child overrides and origin are visible.
- FR-14.4 Support role presets plus granular capabilities.
- FR-14.5 Only one editor may hold a renewable document lock.
- FR-14.6 Other users may view/comment and edit other project documents.
- FR-14.7 Lock expiry autosaves and releases; takeover warns and audits.
- FR-14.8 Anchor comments to exact version/region and carry unresolved threads forward traceably.
- FR-14.9 Approval is optional per workspace/project.
- FR-14.10 Sharing links support live/fixed target, view/comment/download, expiry, password and revocation; editing requires account.

## FR-15 Cloud connectivity

- FR-15.1 Support personal and admin-managed workspace connections with least-privilege access.
- FR-15.2 Support Google Drive, SharePoint/OneDrive and Dropbox before external tester release.
- FR-15.3 Import as a copy or linked source.
- FR-15.4 External source changes create a new source version and ask before updating current work; remembered policy MUST NOT alter frozen/approved/archived versions.
- FR-15.5 Save to cloud creates a new file/provider version by default; replacement requires permission and confirmation.
- FR-15.6 Disconnect/delete MUST NOT delete external files automatically.
- FR-15.7 Our native project remains authoritative for layers/history/approvals.

## FR-16 API platform

- FR-16.1 Expose stable core processing, project, export and e-sign capabilities where security permits.
- FR-16.2 UI and API use the same domain services and contracts.
- FR-16.3 Support workspace service accounts/API credentials and scoped OAuth delegation.
- FR-16.4 Every write supports idempotency.
- FR-16.5 Slow work uses durable async jobs, status APIs, cancellation/retry and signed webhooks.
- FR-16.6 Synchronous completion is allowed only for benchmark-approved small operations.

## FR-17 Free testing and shadow pricing

- FR-17.1 Display “Free during testing.”
- FR-17.2 Do not collect payments, show unapproved future prices, deduct credits or issue customer invoices.
- FR-17.3 Meter usage and compute versioned shadow prices with effective charge zero.
- FR-17.4 Keep shadow price details admin-only.
- FR-17.5 Use transparent fair-use/technical limits and admin-approved increases.
- FR-17.6 Show testers non-monetary jobs/files/storage/high-cost usage.

## FR-18 Retention and deletion

- FR-18.1 Apply the six-month rule to an entirely inactive free workspace, with repeated warnings and policy overrides.
- FR-18.2 Approved production files and completed signing packages use explicit retention/legal-hold policy.
- FR-18.3 Delete revokes access and links immediately.
- FR-18.4 A disclosed trash period permits recovery before permanent purge.
- FR-18.5 Purge active storage and expire backups within documented windows.
- FR-18.6 Never delete connected external provider files automatically.

## FR-19 Privacy, security and regions

- FR-19.1 Customer content is not used for training by default.
- FR-19.2 Training requires separate copy, verified rights and revocable consent.
- FR-19.3 Support access is user-approved, time-bound, purpose-bound and audited; break-glass is controlled.
- FR-19.4 Choose a workspace home region, keep processing/storage there where supported and disclose exceptions.
- FR-19.5 Enforce tenant isolation, encryption, expiring access, malware/decompression controls, secret management and content-safe logging.
- FR-19.6 Processing jobs use least-privilege, expiring access to required objects.

## FR-20 Diagnostics and operations

- FR-20.1 Use one trace ID across browser, API, queue, processor, storage and notification.
- FR-20.2 Customers see friendly status/recovery first and an optional Advanced trace.
- FR-20.3 Elevated diagnostic sessions are scoped, expiring, reasoned, permitted and audited.
- FR-20.4 Recoverable failures resume from the last safe checkpoint, preserve results and isolate items.
- FR-20.5 A sanitised support package excludes content/secrets unless separately approved.
