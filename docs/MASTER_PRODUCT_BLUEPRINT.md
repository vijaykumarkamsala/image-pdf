# Master Product Blueprint — Image & PDF Workspace

**Status:** Complete discovery baseline  
**Version:** 0.1  
**Date:** 24 August 2026  
**Working product name:** To be decided

## 1. Why this document exists

This is the complete product-level source of truth created from discovery and brainstorming. It preserves the full vision, combinations of use, customer experience, commercial direction and architectural boundaries. It is intentionally broader than the first technical proof of concept.

No single POC document represents the whole product. Read this blueprint with:

- `PRODUCT_REQUIREMENTS.md` for testable release requirements
- `USER_FLOWS_AND_EDGE_CASES.md` for alternate paths and failure behavior
- `PRODUCT_DECISION_LOG.md` for decisions and rationale
- `TECHNICAL_POC_AND_MODEL_BENCHMARK_PLAN.md` for pre-architecture validation
- `POC_TASKS.md` for controlled POC implementation

If documents conflict, the product owner must resolve the conflict; an AI coder must not silently choose.

## 2. Product vision

Create a standalone, production-grade web platform where customers can work with images and PDFs using only the tools they need. Image enhancement is one important service, not a mandatory step for every customer.

The product must support combinations such as:

- Low-quality image → Standard Enhance → download
- Low-quality image → Enhance with AI → compare → download
- High-quality images → no enhancement → combine into one PDF
- Mixed-quality images → enhance only selected items → combine into one PDF
- Old photographs → restore selected damage → download or photo book
- Images → blank/multi-page canvas → PDF
- Existing PDF → reorder/add/delete pages → add images/text → export
- Existing PDF → edit supported existing content → export
- Images/PDF → one-time paid professional output without subscription
- Saved project → invite collaborators or share a controlled link

The experience should feel like a simple action-oriented tool workspace, not a technical image-processing console.

## 3. Product identity and relationship to YearShift

- The product is completely separate, with its own future name and brand.
- It serves individuals directly.
- Individuals and businesses use the same underlying account/workspace design.
- The product may later appear under a YearShift umbrella alongside other apps.
- YearShift integration must happen through stable APIs and optional shared identity/billing, not direct coupling to YearShift internals.
- The image/PDF processing engine must be reusable by the standalone app, YearShift and future clients.
- The initial repository, authentication, billing and database remain independent from YearShift.

## 4. Target customers

The platform is intentionally broad:

- Individuals making personal documents
- Families restoring old photographs
- Photo studios and print shops
- Designers and content creators
- Schools, teachers and students
- Businesses creating catalogues and documents
- Professional users handling large or print-oriented assets

The data model must not permanently classify a workspace as individual or business. Commercial plans and permissions define capacity; the underlying collaboration model remains universal.

## 5. Home-page service model

The home page should present multiple action cards rather than forcing every customer through a blank canvas.

Planned cards:

1. Enhance Images
2. Create PDF
3. Edit PDF
4. Restore Old Photos
5. Create Photo Book
6. Merge PDFs
7. Compress PDF
8. Start Blank Design
9. Recent Projects

Additional cards can be added when they provide a distinct customer starting intention. All cards reuse shared services and project data; they must not become unrelated applications.

### Example entry behavior

- **Enhance Images:** opens upload/compare/download workflow.
- **Create PDF:** accepts high-quality or mixed images directly; enhancement remains optional.
- **Edit PDF:** starts with a PDF upload and capability inspection.
- **Restore Old Photos:** preselects restoration-oriented tools but still preserves Standard versus AI separation.
- **Photo Book:** begins with templates and page-based arrangement.
- **Blank Design:** opens the canvas without requiring an image.

## 6. Experience modes

### Quick mode

For beginners and one-time users:

- Recommended defaults
- One-click Standard Enhance
- Separate one-click Enhance with AI
- Automatic local/cloud processing decision
- Recommended output resolution
- Simple comparison and download

### Advanced mode

For experienced customers:

- Individual adjustment controls
- Multiple result variations
- Model-independent quality/intensity choices
- Exact output size, format, DPI and compression
- Local/cloud processing override when both are safe
- Per-image batch overrides
- Detailed processing metadata when useful

Advanced mode must not require customers to understand model names, CPUs, GPUs or providers.

## 7. Original and derivative principles

- Originals are immutable.
- Standard results, AI results, previews, thumbnails and exports are separate derivatives.
- Every derivative records its source and processing recipe.
- A derivative may be based on an original or a selected earlier derivative, but lineage remains traceable.
- Customers can always identify which version they selected for download or PDF placement.
- Deleting a derivative must not delete the original unless the customer explicitly deletes the original/project.
- Re-running an operation must create/reuse an idempotent result, not silently replace a version.

## 8. Standard Enhance

**Enhance** is the default predictable path. It uses deterministic or non-generative processing and does not intentionally invent missing faces, objects, colours or scene details.

Capabilities include:

- Crop, rotate, flip and orientation correction
- Standard interpolation resize
- Brightness, contrast, exposure and saturation
- White balance and colour correction
- Sharpening
- Moderate noise reduction
- Limited classical deblur/deconvolution when reliable
- Format conversion
- Quality/compression selection
- Lossless optimization where applicable
- Manual masking and background compositing

Standard upscaling can increase dimensions but cannot truthfully claim to recover missing detail. The UI must not equate higher pixel count with AI restoration.

## 9. Enhance with AI

**Enhance with AI** is a separate customer action. No disruptive consent modal is required. The button and nearby description are sufficient, for example: “AI may reconstruct missing details.”

The customer intentionally selects AI; the system must not silently apply it.

Planned AI capabilities:

- 2× and 4× super-resolution
- Advanced denoise, deblur and sharpening
- Face enhancement/restoration
- Scratch, fold, stain and old-photo damage repair
- Colour correction and colourisation
- Automatic background removal
- Background replacement
- Optional generated background

Modes may include:

- Natural
- Strong
- Face Restoration
- Damage Reconstruction
- Colourisation

Natural is the recommended AI default. Face restoration and creative reconstruction remain explicit because they can change identity or invent detail. Colourisation must be described as estimated colour, not historical fact.

## 10. AI model and provider philosophy

AI coding assistants and runtime image models are different:

- Codex, Cursor and Claude help developers write code.
- Real-ESRGAN, SwinIR and similar models process customer images at runtime.
- Hugging Face is a model hub/managed hosting platform, not one competing model.

Runtime strategy:

- Start by benchmarking pretrained models.
- Do not train or fine-tune initially.
- Use Real-ESRGAN only as an initial baseline candidate.
- Compare models by task and image category.
- A model available on Hugging Face may still be self-hosted if its weights are downloaded and run on infrastructure controlled by us.
- A Hugging Face managed endpoint or another vendor API is managed/external processing, not fully self-operated inference.
- Keep every model/provider behind one internal processing contract.
- Prefer self-hosted models for stable high-volume or privacy-sensitive workloads.
- Use external providers only through adapters for early validation, specialist operations, overflow or fallback.
- Commercial licensing of code, weights and executed dependencies is a hard gate.
- Never treat popularity or an attractive demo as commercial approval.
- Fine-tune only when production evidence shows a specific repeatable weakness and legally usable data exists.

## 11. Hybrid local and cloud processing

Not every image must be processed on our server. The product uses a hybrid approach.

### Automatic decision

The application automatically chooses local browser processing or cloud processing using:

- Operation type
- Decoded pixel count and estimated working memory
- Compressed file size
- Batch size
- Browser/device capability
- Need to save or audit the output
- Need to continue after browser closure
- Requested output size/quality
- Standard versus AI processing
- Payment/entitlement requirements

### Advanced override

The default is automatic routing. Advanced settings allow customers to choose local or cloud when both routes are safe and supported. Unsafe or unsupported routes are disabled with a clear explanation.

### Browser responsibilities

- Upload interaction
- Canvas/editor interaction
- Crop, rotate, flip and positioning
- Immediate lightweight adjustment previews
- Before/after comparison
- Eligible small local operations
- Eligible normal-quality local downloads

### Cloud CPU responsibilities

- Trusted input inspection and decoding
- Metadata validation
- Authoritative deterministic final rendering
- Thumbnails and format conversion
- High-quality standard outputs
- ZIP and PDF assembly
- Storage orchestration
- Jobs requiring background continuation

### Cloud GPU responsibilities

- AI super-resolution
- Face restoration
- Complex deblur and damage reconstruction
- Colourisation
- Automatic segmentation/background removal
- Generative background work

Customers see friendly wording such as “Processing on your device” and “Processing securely in the cloud,” not infrastructure jargon.

## 12. File inputs

Initial input methods:

- Device image upload
- Existing PDF upload
- Multi-file drag and drop

Planned subsequent inputs:

- Cloud storage import
- Phone camera capture through mobile web
- Native camera/file integrations if native applications are built

Supported image formats begin with validated JPG and PNG. Additional formats are approved based on customer demand, decoding security, metadata/color requirements and browser/server support.

## 13. File-size and professional processing

- Standard target: up to 25 MB per image.
- Professional target: up to 100 MB per image.
- Measure decoded pixels, channels, bit depth and memory—not only compressed bytes.
- Initial batch target: 50 images.
- Very large professional images use asynchronous tiled processing.
- Avoid a customer-hostile simple rejection when an alternative path is possible.
- Move large work into a professional queue, show estimated time/cost and notify when ready.
- Extreme files may require a custom-processing quote.
- Hard technical safety ceilings still exist to protect the platform; present them as an actionable professional/custom path.

## 14. Batch processing

Customers can:

- Upload multiple images
- Apply shared settings to selected/all images
- Override settings for individual images
- Mix Standard, AI and untouched images in one project
- Start processing only selected items
- See queued, processing, completed, failed and cancelled status per item
- Retry failed items without repeating successful items
- Download one result or a ZIP
- Close the browser while cloud jobs continue
- Return through project history

One corrupt file must not fail the batch. Retries must be idempotent and cannot duplicate usage/billing events.

## 15. Comparison and version selection

Enhancement should support:

- Original versus Standard result
- Original versus AI result
- Standard versus AI result
- Multiple AI strength/operation variations
- Side-by-side and slider comparison
- Zoom/pan at meaningful detail
- Selection of the preferred result
- Reversion to original at any time

Preview must be sufficient to judge quality. Prefer reduced resolution over an intrusive watermark. Paid full-resolution files remain protected by authorization.

## 16. Output model

Image downloads:

- Original dimensions
- 2×
- 4×
- 4K
- 8K
- Custom width/height
- Print size with DPI
- Maximum recommended quality
- JPG
- PNG
- Individual file
- Original/result ZIP
- Editable saved project

Do not market 4K/8K as guaranteed added detail. Recommend an output based on source quality and warn when a larger file is unlikely to improve appearance.

Later PDF outputs:

- Standard PDF
- High-quality PDF
- Print-ready PDF
- Selected pages
- All pages

## 17. Multi-page PDF creator

Customers can create a PDF without enhancing images.

Core canvas/page capabilities:

- Start from images or blank canvas
- Page 1, Page 2 and additional pages
- Add many pages within plan/system limits
- Add, delete, duplicate and reorder pages
- A4, A3, Letter, Legal, photo sizes and custom dimensions
- Portrait and landscape
- Add one or multiple images per page
- Choose original or any enhanced derivative
- Move, resize, rotate and crop images
- Add and format text
- Add backgrounds, shapes, signatures and page numbers
- Alignment guides and margins
- Undo/redo
- Autosave and draft projects
- Export selected/all pages into one PDF

Text and vector elements should remain vector/searchable where feasible. Do not flatten the whole page unnecessarily. For professional export, target print-quality rendering and warn about insufficient source resolution.

## 18. Existing PDF editor

The product will support:

- Upload existing PDF
- Inspect PDF type/capabilities
- Render pages
- Add, delete, duplicate and reorder pages
- Add images, text, signatures, shapes and annotations over pages
- Merge additional PDFs/pages
- Export a new PDF

Editing text already inside a PDF is not uniformly possible. PDFs may contain positioned glyphs, embedded/subset fonts, outlines or scanned images. The UI must distinguish:

- Editable text/content
- Overlay-only editing
- Scanned content requiring OCR/reconstruction
- Unsupported/protected/encrypted content

Do not promise Word-like editing for every PDF.

## 19. Accounts, workspaces and sharing

- Signup is required for download, saving, batch processing and history.
- Every user receives a personal workspace.
- Users may invite others and later create/join additional workspaces.
- Projects, assets, entitlements, credits, subscriptions and invoices belong to a workspace.
- Individual versus business is not a separate schema.

Initial roles:

- Owner
- Editor
- Viewer

Later roles may include Admin, Billing Manager and custom roles.

Sharing options:

- Invite workspace members
- Share a project link
- View only
- View and download
- Edit
- Expiration date
- Password protection
- Link revocation

Anonymous viewing is allowed only when explicitly enabled. Editing/saving requires authentication unless a later explicit policy changes it.

## 20. Guest experience and abuse control

- Visitors can upload one eligible image and evaluate a limited preview without signup.
- Signup is required for download.
- Guest assets use short retention, initially approximately 24 hours.
- Use reduced-resolution previews where necessary.
- Apply rate limits, bot protection, file limits and abuse monitoring.
- Do not require a heavy watermark that prevents genuine quality evaluation.

## 21. Commercial model

Support three purchasing styles together:

### Free allowance

- Small recurring allowance, initially explored around three standard operations rather than only one
- Limited resolution/storage/retention as appropriate
- Enough quality evaluation to establish trust

### Subscription

- Monthly included processing allowance
- Larger resolution and batches
- Faster queue
- More storage/retention
- Collaboration features
- Advanced/PDF features as plans evolve

Possible commercial labels: Free, Personal, Creator, Professional and Business. These are plans, not different customer entities.

### Credits and one-time purchase

- Buy additional credits without switching plan
- Pay for one specific image or PDF output
- Show exact price before purchase
- Do not force occasional customers into subscriptions

Internal cost calculation considers:

- Input/output megapixels
- Standard versus AI operation
- Model weight/complexity
- 2×/4× and output size
- Face/damage/colour/background operations
- Number of variations
- Compute duration
- Storage and bandwidth
- Payment overhead
- Operational margin

Customers see simple prices/credits, not the internal formula. Final prices are decided only after benchmarks.

## 22. Retention and deletion

- Default signed-in retention: six months of inactivity.
- Customers can choose another permitted retention period.
- Warn before automatic deletion.
- Reopening or explicitly extending a project resets inactivity according to policy.
- Workspace/enterprise policies may override defaults later.
- Delete originals, derivatives, thumbnails, temporary files and exports when content deletion becomes effective.
- Keep only legally/operationally necessary non-content billing/audit records.
- Guest content has much shorter retention.
- No customer image is used for training without separate explicit opt-in.

## 23. Platform approach

- Responsive web application/PWA first.
- Full workspace optimized for desktop/laptop.
- Touch-friendly mobile and tablet flows from the start.
- Mobile web camera capture can arrive before native apps.
- Native desktop/mobile applications remain later options.

## 24. Notifications

Long-running cloud jobs must not require the page to remain open. Provide in-app completion state; later add selected email/push channels. Notifications must identify the project/job without exposing private image content.

## 25. Administration and operations

Admin capabilities eventually include:

- Operation/model/provider availability
- Model routing and fallback configuration
- Version rollout/rollback
- Plan limits and entitlements
- Cost/pricing weights
- Job/queue inspection and safe retry
- Workspace usage/support inspection
- Retention/deletion status
- Abuse controls
- Quality, latency, failure and cost monitoring
- Licence register and approved model inventory

Access to customer images is exceptional, least-privileged and audited.

## 26. Security and privacy

- Workspace authorization on every operation
- Private object storage
- Signed expiring download/access URLs
- Encryption in transit and at rest
- File validation by actual content
- Decoded-dimension/decompression-bomb protection
- Malware/safety scanning where appropriate
- Resource/time/temp-storage limits
- Secrets outside source control
- Structured logs without image bytes or unnecessary personal data
- Audit important access, processing, sharing, billing and deletion actions
- Model/runtime supply-chain controls and verified hashes

## 27. Reliability and observability

- Durable asynchronous jobs
- Idempotent processing and retry
- Per-item batch isolation
- Safe cancellation semantics
- Provider/model timeouts and fallback policy
- Original preservation on every failure
- Correlated request/project/asset/job identifiers
- Metrics by operation, dimensions, model, duration, failure and cost
- Alerts for queue backlog, failure spikes and abnormal cost

## 28. Accessibility and usability

- Keyboard-accessible primary controls
- Visible focus
- Sufficient contrast
- Descriptive labels/statuses
- Do not rely on colour alone
- Friendly empty/error states
- Progressive disclosure of advanced details
- Beginners should not need technical knowledge

## 29. Delivery sequence

1. Complete discovery documentation
2. Technical POC and model benchmark
3. Approve architecture and technical decisions
4. User-flow/UI specification
5. Data model/API/job contracts
6. Security/threat model and test plan
7. Production Release 1: image enhancement/download
8. Multi-page PDF creator
9. Existing PDF editing
10. Photo books and additional document tools
11. YearShift umbrella integration

Release 1 is production-ready image enhancement, not a throwaway demo. Shared foundations must anticipate later modules without implementing them prematurely.

## 30. Product success expectations

The product succeeds when customers can confidently choose the shortest suitable path, originals are safe, results are honest, professional outputs are reliable, pricing is understandable and later PDF capabilities reuse the same assets/projects rather than creating a disconnected system.

## 31. Open decisions

- Product/brand name
- Final production model set
- Final commercial licences and notices
- Initial compute/cloud regions
- Exact formats beyond JPG/PNG
- Payment provider/currencies
- Exact free allowance and plan pricing
- Notification channels
- Release 1 sharing depth
- Performance/service targets
- Native app timing
- Exact YearShift umbrella integration method

