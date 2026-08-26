# Image & PDF Workspace — Product Requirements

**Status:** Expanded discovery baseline for review  
**Version:** 0.2  
**Date:** 24 August 2026  
**Working title:** To be decided

## 0. Document hierarchy

This file contains testable product and release requirements. It is not the only product document. The complete approved discovery set is:

- `MASTER_PRODUCT_BLUEPRINT.md` — complete vision, modules and commercial/technical direction
- `PRODUCT_REQUIREMENTS.md` — testable requirements and release boundaries
- `USER_FLOWS_AND_EDGE_CASES.md` — combinations, alternate paths and failures
- `PRODUCT_DECISION_LOG.md` — approved decisions, rationale, corrections and open items
- `TECHNICAL_POC_AND_MODEL_BENCHMARK_PLAN.md` — validation before architecture approval
- `POC_TASKS.md` — controlled POC tasks

AI agents must read the documents relevant to the current task. POC-focused files must not be interpreted as the full application scope.

## 1. Purpose

Build a standalone, production-grade web application that helps customers enhance images, restore photographs, create and edit multi-page PDFs, and download professional-quality outputs. The application must serve individuals and businesses through the same universal account and workspace model.

The product will operate independently under its own brand. Its capabilities must later be reusable inside the YearShift application umbrella through stable APIs and optional identity/billing integration, without coupling the initial product to YearShift internals.

## 2. Product Principles

1. Preserve every uploaded original; never overwrite it.
2. Make image enhancement optional. High-quality source images can proceed directly to PDF creation or download.
3. Keep standard enhancement and AI reconstruction clearly separate.
4. Hide infrastructure complexity from ordinary customers.
5. Provide quick defaults for beginners and advanced controls for experienced users.
6. Support both subscription customers and one-time purchasers.
7. Build production foundations first; do not create a throwaway demo.
8. Use modular services so image processing, PDF generation, storage and billing can be reused by future products.
9. Treat privacy, retention, security and cost measurement as product requirements, not later additions.
10. Make customer-facing failure states recoverable and understandable.

## 3. Target Customers

The long-term product supports:

- Individuals creating personal PDFs
- Photo studios and print shops
- Businesses creating catalogues and documents
- Schools, teachers and students
- Designers and content creators

The system must not require customers to classify themselves as an individual or business. Plans, usage, collaboration and billing determine capabilities.

## 4. Product Structure

The home page will use action-oriented service cards. Planned cards include:

- Enhance Images
- Create PDF
- Edit PDF
- Restore Old Photos
- Create Photo Book
- Merge PDFs
- Compress PDF
- Start Blank Design
- Recent Projects

These cards are different entry points into shared project, asset, processing, canvas and export services. They must not become separate disconnected applications.

## 5. Delivery Strategy

### 5.1 Release 1 — Production Image Enhancement

Release 1 must be a complete, production-ready image enhancement and download product. It includes the shared foundations needed for later PDF/editor releases.

### 5.2 Release 2 — Multi-page PDF Creation

Customers arrange original or enhanced images across multiple pages and export one PDF.

### 5.3 Release 3 — Existing PDF Editing

Customers upload PDFs, reorder/add/delete pages, add new content and edit supported existing elements. The UI must not promise Word-like editing for PDFs whose content cannot be reliably edited.

### 5.4 Later Releases

- Photo-book templates
- Advanced document tools
- Native desktop/mobile applications if justified
- Enterprise private processing
- YearShift umbrella integration

## 6. Release 1 User Journey

1. A visitor opens the product without signing in.
2. The visitor uploads an eligible image and sees a limited preview experience.
3. The application preserves the source as the original asset.
4. The customer chooses **Enhance** or **Enhance with AI**.
5. The application recommends settings based on the source while allowing manual controls.
6. The customer can compare original and result side by side.
7. The customer can create multiple result variations without losing earlier versions.
8. Signup is required to download, save a project, run batches or access history.
9. The customer chooses output dimensions/quality and sees any charge before purchase.
10. Processing continues in the background when cloud processing is used.
11. The customer downloads an individual image or batch ZIP.

## 7. Access and Authentication

### 7.1 Guest Access

- Allow one-image evaluation without authentication.
- Use reduced-resolution previews where necessary to prevent abuse while allowing meaningful quality comparison.
- Require signup for downloads, project saving, batches and history.
- Guest assets use short temporary retention, initially targeted at 24 hours.
- Apply rate limiting, bot protection and abuse detection.

### 7.2 Account Model

- Every user receives a personal workspace automatically.
- Users may invite other users and later create or join additional workspaces.
- Projects, assets, entitlements, credits, subscriptions and invoices belong to a workspace.
- Do not create separate individual and business customer schemas.

### 7.3 Initial Roles

- **Owner:** Full control, billing, retention and deletion
- **Editor:** Upload, enhance, edit and download
- **Viewer:** View and download permitted outputs

### 7.4 Sharing

Support workspace invitations and project-specific links. Project links should eventually support view, download and edit permissions; expiration; password protection; and revocation. Saving or editing requires authentication unless an explicit future policy allows otherwise.

## 8. Asset and Version Model

- Store originals in object storage, not the relational database.
- Treat every enhancement as a derivative referencing the original or a selected prior derivative.
- Never destructively modify an original.
- Record the complete processing recipe, model/version, parameters and output metadata for reproducibility.
- Generate thumbnails/previews separately from professional outputs.
- Permit customers to select any eligible original or derivative for download.
- Database records store ownership, metadata, storage references, processing state, retention and billing information.

## 9. Standard Enhancement

The default **Enhance** action uses deterministic or non-generative processing and must not intentionally invent faces, objects or missing scene details.

Planned controls include:

- Resize using standard interpolation
- Crop, rotate and flip
- Brightness, contrast, exposure and saturation
- White balance and colour correction
- Sharpening
- Moderate denoising
- Limited deblurring/deconvolution where reliable
- Format conversion
- Metadata-aware orientation
- Lossless or controlled-quality output optimization
- Manual/background compositing after a mask exists

The UI must distinguish preview quality from final output quality.

## 10. AI Enhancement

The optional **Enhance with AI** action may reconstruct probable details. It does not require a disruptive consent modal. Display a short nearby explanation such as: “AI may reconstruct missing details.”

Production-targeted capabilities include:

- 2× and 4× super-resolution
- Advanced denoise, deblur and sharpen
- Face enhancement and restoration
- Scratch and old-photo damage repair
- Colour correction and colourisation
- Automatic background removal
- Background replacement, including optional generated backgrounds

AI modes should include Natural, Strong, Face Restoration, Damage Reconstruction and Colourisation where applicable. The customer chooses the operation; the system must not silently enable generative reconstruction.

No customer image may be used for model training unless the customer gives separate, explicit opt-in permission in a future feature.

## 11. Model Strategy

- Use a provider-independent internal image-processing contract.
- Begin by benchmarking pretrained models; do not train or fine-tune initially.
- Use Real-ESRGAN as one baseline candidate, not an automatically approved permanent model.
- Evaluate multiple models using a controlled test set covering old photos, faces, mobile images, documents/screenshots, products, illustrations and professional-size images.
- Evaluate visual quality, identity/text preservation, artifacts, processing time, memory, output size, tiling, licence and cost per output megapixel.
- Route different image categories or operations to different models when evidence supports it.
- Prefer self-hosted models for stable, high-volume or privacy-sensitive workloads.
- Keep optional external providers behind adapters for evaluation, overflow or fallback.
- Maintain a licence register for all code, weights and dependencies before commercial activation.
- Fine-tune only after measured production weaknesses justify the data, training and maintenance cost.

## 12. Hybrid Processing

### 12.1 Automatic Routing

The application chooses local browser processing or cloud processing automatically. Routing considers:

- Operation type
- Decoded pixel dimensions and memory estimate
- File and batch size
- Browser/device capability
- Requested output quality
- Need for saving, auditing or background continuation
- Standard versus AI processing
- Payment/entitlement requirements

### 12.2 Advanced Override

When both routes are safe and supported, advanced settings allow the customer to override the automatic recommendation and choose local or cloud processing. Unsupported choices must be disabled with a clear explanation.

### 12.3 Browser Responsibilities

- Canvas/editor interaction
- Crop, rotate, flip and positioning
- Immediate lightweight previews
- Standard adjustment previews
- Before/after comparison
- Upload management
- Optional eligible local download

### 12.4 Cloud CPU Responsibilities

- Input validation and decoding
- Metadata inspection
- Authoritative standard-quality rendering
- Format conversion and thumbnails
- ZIP/PDF assembly
- Storage orchestration
- Deterministic full-resolution processing

### 12.5 Cloud GPU Responsibilities

- AI super-resolution
- Face restoration
- Complex deblur/damage reconstruction
- Colourisation
- Automatic segmentation
- Generative background operations

Cloud jobs must be asynchronous and survive browser closure. Browser results are previews unless the operation explicitly qualifies for a local final download.

## 13. Batch Processing

- Support up to 50 images per initial batch.
- Apply one configuration to selected images.
- Override settings for individual images.
- Show queued, processing, completed and failed state per image.
- Retry only failed or selected items.
- Permit original/result comparison per asset.
- Download individually or as a ZIP.
- Continue cloud jobs when the browser is closed.
- Notify the customer when long-running work completes.

## 14. Upload and Professional File Handling

- Standard path target: up to 25 MB per image.
- Professional path target: up to 100 MB per image.
- Inspect decoded dimensions and estimated memory in addition to compressed size.
- Very large files use asynchronous tiled processing.
- Do not present large professional files as arbitrary failures. Move them to a professional queue, show estimated processing time/cost and use a custom-processing path for extreme cases.
- Technical safety ceilings are mandatory even if the user-facing response offers an alternative instead of a simple rejection.

## 15. Output and Download

Support:

- Original dimensions
- 2× and 4× output
- 4K and 8K presets
- Print dimensions at a selected DPI
- Custom dimensions
- Maximum recommended quality
- JPG and PNG initially; additional formats based on validated demand
- Original plus enhanced files as ZIP
- Editable saved project
- High-quality and print-ready PDF in later PDF releases

Warn when a requested resolution is unlikely to produce meaningful additional detail. Preserve transparency and colour profile where supported and tested.

## 16. Pricing and Entitlements

Use a hybrid commercial model:

- Small recurring free allowance
- Subscription plans with included processing allowance
- Additional purchasable credits
- One-time purchase for a specific image or PDF output
- Enterprise/dedicated processing later

Do not finalize prices before benchmarking. Internally calculate cost using output megapixels, operation/model weight, generated version count, compute time, storage, bandwidth and payment overhead. Customers see a simple exact price or credit requirement before processing/purchase.

Plan entitlements may control resolution, batch size, storage, retention, collaborators, queue priority and AI operations. One-time purchasers must not be forced into a subscription.

## 17. Retention and Deletion

- Default signed-in project retention: six months of inactivity.
- Customers may choose another permitted retention period.
- Warn before automatic deletion.
- Workspace or enterprise policy may override defaults later.
- Opening or intentionally extending a project resets inactivity according to policy.
- Deletion must cover originals, derivatives, thumbnails, temporary files and exports.
- Maintain required billing/audit records separately where lawful and necessary, without retaining deleted image content.

## 18. Platform and Experience

- Release first as a responsive web application/PWA.
- Prioritize the full editor experience on desktop/laptop.
- Provide touch-friendly tablet and mobile flows from the beginning.
- Native applications are later options, not initial dependencies.
- Beginners receive quick defaults; advanced settings remain discoverable without cluttering the primary flow.
- Do not expose CPU/GPU/provider terminology in primary customer journeys.
- Use friendly statuses such as “Processing on your device” and “Processing securely in the cloud.”

## 19. PDF and Canvas Vision

Later PDF releases must support:

- Blank canvas and image-to-PDF entry points
- Add, delete, duplicate and reorder pages
- Portrait, landscape, standard and custom page sizes
- Move, resize, rotate and crop images
- Add and format text
- Backgrounds, shapes, signatures and page numbers
- Undo/redo and autosave
- Original or enhanced asset selection per page
- Export selected or all pages into one PDF
- Standard, high-quality and print-ready export
- Device, PDF, drag/drop, cloud-storage and camera imports in staged order
- Import and render existing PDFs
- Add content over existing pages
- Edit existing PDF content only when technically supported, with honest limitations

## 20. Non-functional Requirements

### Security and Privacy

- Strong tenant/workspace authorization on every project and asset operation
- Signed, expiring access for private files
- Encryption in transit and at rest
- Validated file type based on content, not filename alone
- Malware and decompression-bomb defenses
- No public object-storage exposure
- Secrets stored outside source control
- Audit significant access, processing, billing and deletion events

### Reliability

- Idempotent background jobs
- Safe retries without duplicate billing
- Per-asset failure isolation in batches
- Durable job state
- Provider/model timeout and fallback policies
- Original preservation even when processing fails

### Performance

- Immediate interactive previews for ordinary edits
- Background processing for expensive work
- Tiled processing for large images
- Measured queue wait, processing time and output size
- Performance targets finalized after proof-of-concept benchmarks

### Observability

- Correlated request/job identifiers
- Structured logs without exposing sensitive images or unnecessary personal data
- Metrics by operation, model, dimensions, duration, failure and cost
- Admin-visible retry/failure diagnostics
- Alerts for queue backlog, failure spikes and abnormal cost

### Accessibility

- Keyboard-accessible primary controls
- Visible focus and sufficient contrast
- Useful labels for controls and progress
- Do not rely on colour alone to communicate state

## 21. Administrative Capabilities

Production administration must eventually support:

- Model/provider availability and routing configuration
- Operation limits and plan entitlements
- Pricing weights and one-time price calculation inputs
- Queue/job inspection and safe retry
- Customer/workspace usage inspection
- Retention/deletion status
- Abuse controls
- Model version rollout and rollback
- Cost and quality monitoring

Direct access to customer images must be strictly controlled and audited.

## 22. Release 1 Acceptance Criteria

Release 1 is complete only when:

1. Guest and signed-in flows work according to access rules.
2. Originals remain unchanged and accessible according to retention policy.
3. Standard enhancement and optional AI enhancement are clearly separated.
4. At least the approved production model set supports the six targeted enhancement categories.
5. Individual and 50-image batch processing work with per-item status/retry.
6. Automatic local/cloud routing works, with advanced override where supported.
7. Cloud jobs survive page closure and can be resumed from project history.
8. Customers can compare versions and download individual or ZIP outputs.
9. 2×, 4×, 4K, 8K and custom/print output rules are validated.
10. Account, workspace, sharing foundation and workspace-level billing ownership work.
11. Free, subscription/credit and one-time entitlement paths cannot be bypassed.
12. Six-month inactivity retention and complete asset deletion are implemented and tested.
13. Security, authorization, file validation and abuse controls pass review.
14. Relevant unit, integration, end-to-end, visual and performance tests pass.
15. Build, lint, type checks, migrations and deployment verification pass.
16. Processing quality and cost are benchmarked and documented per production model.

## 23. Explicit Release 1 Exclusions

Unless separately approved, Release 1 does not include:

- Full multi-page canvas/PDF editor implementation
- Guaranteed editing of arbitrary existing PDF text
- Native desktop/mobile applications
- Custom model training or fine-tuning
- Unlimited anonymous processing
- Unlimited file sizes
- Direct coupling to YearShift authentication, billing or database
- Customer images used for training

These exclusions protect delivery order; they do not remove the capabilities from the complete product vision.

## 24. Required Next Artifacts

Before application implementation begins, create and approve:

1. Technical proof-of-concept and model benchmark report
2. Architecture and decision records
3. Release 1 user-flow specification
4. UI/interaction specification
5. Data model
6. API and job contracts
7. Security/threat model
8. Pricing-cost benchmark
9. Test plan
10. `AGENTS.md` repository instructions
11. Phased implementation plan

## 25. Open Decisions

- Product and brand name
- Exact free allowance and commercial plan pricing
- Final production model set
- Initial cloud/GPU provider and regions
- Exact output formats beyond JPG/PNG
- Notification channels
- Payment provider and supported currencies
- Exact sharing permissions included in Release 1
- Final performance and processing-time service targets
