# Technical POC Task Breakdown

**Rule:** Implement one task at a time unless the product owner explicitly approves a combination. Each task ends with tests, artifact inspection, diff review and a handoff report.

## POC-001 — Repository and benchmark-contract foundation

### Goal

Create the minimal reproducible repository structure, schemas and test foundation needed by later benchmarks.

### Requirements

- Create the approved directory structure.
- Select and document the minimal language/runtime/tooling required for the benchmark runner and processor adapters.
- Define versioned schemas/types for:
  - Asset manifest entry
  - Operation/settings
  - Processor identity
  - Licence disposition
  - Safety inspection result
  - Benchmark run
  - Per-asset result
  - Timing/memory/cost measurements
  - Normalized failure
- Define a processor interface for `inspect`, `estimate` and `process`.
- Generate collision-resistant, reproducible run/result identifiers.
- Add one small synthetic/rights-cleared fixture and example manifest.
- Add a command that validates manifests without processing images.
- Add a command that creates an empty/example report from validated metadata.
- Add formatting, linting, type checking and tests.
- Add a concise developer README with setup and commands.

### Acceptance criteria

- A clean checkout can install dependencies using documented commands.
- Example manifest validation succeeds.
- Invalid extension/content metadata, excessive dimensions and missing provenance fail with normalized errors.
- Example report is generated deterministically from the same input.
- Processor contract has automated conformance tests using a fake processor.
- Original fixture hash is unchanged before and after all tests.
- All documented checks pass.
- No model, weight or external provider is integrated.

## POC-002 — Rights and licence manifest gates

### Goal

Prevent unapproved assets, code/models or weights from entering benchmark execution.

### Requirements

- Extend manifests with rights and public-display permissions.
- Add model/source/dependency licence records.
- Support dispositions: approved, review-required, non-commercial, blocked and unknown.
- Block benchmark execution when a required component is not approved.
- Record official source, pinned version/commit, weight hash and required notices.
- Seed records for Real-ESRGAN, SwinIR, GFPGAN, CodeFormer, SUPIR and rembg as preliminary—not final approvals.

### Acceptance criteria

- SUPIR is blocked from commercial-candidate runs by default.
- Unknown weight licences block execution.
- Reference-only runs are clearly marked and cannot appear as commercial recommendations.
- Tests cover every disposition and dependency inheritance.

## POC-003 — Input inspection and safety

### Goal

Safely inspect images before processing and assign standard/professional/blocked handling.

### Requirements

- Validate actual file signature and supported encoding.
- Decode metadata under resource limits.
- Normalize orientation metadata without mutating the original.
- Calculate pixels and estimated working memory.
- Detect decompression-bomb and unsupported-depth/channel risks.
- Classify standard, professional, extreme/custom or invalid.
- Record SHA-256 and metadata.

### Acceptance criteria

- Mismatched extension/signature is rejected.
- Excessive decoded dimensions are caught before unsafe allocation where possible.
- 25 MB/100 MB policies are configurable, not hard-coded throughout the codebase.
- Original bytes remain unchanged.
- Temporary resources are cleaned after all paths.

## POC-004 — Deterministic server baseline

### Goal

Implement authoritative standard-processing baselines without generative reconstruction.

### Requirements

- Bicubic and Lanczos resize
- Crop/rotate/flip
- Brightness/contrast/saturation and colour correction baseline
- Sharpen and moderate denoise baseline
- Controlled JPEG/PNG output
- Processing recipe/provenance and metrics
- Deterministic output where supported

### Acceptance criteria

- Golden fixtures verify expected dimensions and stable hashes/tolerances.
- Metadata/orientation/transparency behavior is tested.
- Original files remain unchanged.
- Invalid combinations return normalized failures.
- Timing and memory measurements populate the report.

## POC-005 — Browser laboratory

### Goal

Measure eligible local preview/final operations and device capability without coupling to production UI.

### Requirements

- Minimal browser lab for upload and supported lightweight operations.
- Run work off the main UI thread where appropriate.
- Feature/capability detection.
- Measure decode, preview, operation and export durations.
- Detect unsupported or unsafe local routes.
- Export a benchmark result compatible with the central report schema.

### Acceptance criteria

- UI remains responsive during tested operations.
- Unsupported devices receive a cloud-route recommendation.
- Refresh/backgrounding limitations are documented.
- Browser output is labelled preview unless explicitly eligible as final.
- Results can be compared with the server baseline.

## POC-006 — General AI adapter foundation and Real-ESRGAN baseline

### Goal

Integrate the first licence-approved, pinned general AI model behind the processor contract.

### Requirements

- Complete licence/dependency disposition before download or execution.
- Containerize a pinned inference runtime.
- Verify weight hash.
- Support native approved scale(s), precision and tiling settings.
- Disable unexpected network access during inference.
- Capture cold/warm timing, RAM/VRAM and output metrics.
- Never silently invoke face restoration.

### Acceptance criteria

- Adapter passes processor-contract tests.
- 2×/4× behavior is accurately described.
- Small and tiled inputs run reproducibly within documented tolerance.
- Failure and cleanup paths are tested.
- Results compare against deterministic resize, not only the original.

## POC-007 — SwinIR comparator

### Goal

Benchmark SwinIR for eligible super-resolution, denoise and JPEG-artifact tasks using the same contract and corpus subset.

### Acceptance criteria

- Licence gate passes for executed code, weights and dependencies.
- Results use identical manifest/report structures.
- Runtime and quality comparison against Real-ESRGAN and deterministic baselines is generated.
- No winner is declared from objective metrics alone.

## POC-008 — Blinded quality-review workflow

### Goal

Create randomized, model-hidden review packages and aggregate human scores.

### Requirements

- Randomize presentation without losing traceability.
- Capture 1–5 scores for approved review dimensions.
- Support two reviewers and third-review tie resolution.
- Flag critical failures separately from preference scores.
- Produce category/task summaries.

### Acceptance criteria

- Reviewers cannot infer model identity from filenames/UI.
- Identity/text/logo critical failures override attractive aggregate scores.
- Results remain traceable to exact run/model versions.

## POC-009 — Face restoration candidates

### Goal

Evaluate only commercially eligible face candidates, including a no-face-model control.

### Requirements

- Complete GFPGAN dependency-path review.
- Keep CodeFormer blocked until its licence is approved.
- Measure identity preservation and group-face behavior.
- Provide Natural versus explicit Face Restoration comparisons.

### Acceptance criteria

- Face restoration is never selected automatically by default.
- Material identity changes are critical failures.
- Non-face regions are evaluated for unintended changes.

## POC-010 — Background removal candidates

### Goal

Evaluate segmentation quality and correction workflow.

### Requirements

- Review the selected wrapper and each model/weight licence.
- Test hair, fur, glass, shadows, products and complex boundaries.
- Measure mask/boundary quality and runtime.
- Support manual correction baseline.

### Acceptance criteria

- Wrapper licence is not treated as weight approval.
- Transparency and edge halos are reviewed.
- Incorrect automatic masks remain correctable.

## POC-011 — Damage repair, colourisation and background replacement

### Goal

Select and evaluate commercially eligible candidates for the remaining advertised AI operations.

### Acceptance criteria

- Maximum three candidates per operation after licence screening.
- Colourisation is labelled as estimated colour.
- Reconstruction does not occur under Standard Enhance.
- If no candidate passes, the operation is removed from Release 1 rather than faked.

## POC-012 — Large-image tiling and professional path

### Goal

Validate 25 MB, 100 MB and high-megapixel handling without visible seams or unsafe memory use.

### Acceptance criteria

- Tile-size/overlap selection is recorded.
- Tiled/non-tiled comparisons exist where both fit.
- Alpha/16-bit behavior is documented.
- Extreme images receive a professional/custom disposition, not an uncontrolled allocation.
- Cancellation and cleanup are proven.

## POC-013 — Batch durability

### Goal

Validate mixed batches of 1, 10 and 50 images.

### Acceptance criteria

- Per-item state and failure isolation work.
- Retry is idempotent.
- Corrupt inputs do not stop valid items.
- Closing the client does not stop cloud work.
- Temporary artifacts are cleaned.
- Results map to the correct originals.

## POC-014 — Cost and routing report

### Goal

Calculate operating cost and propose automatic local/cloud routing with Advanced override.

### Acceptance criteria

- Costs normalize per input/output megapixel, scale and operation.
- P50/P95 queue and processing times are reported.
- 4K, 8K and 50-image batch estimates are included.
- Routing thresholds come from measurements.
- Advanced override is permitted only where safe and supported.
- No final customer price is invented.

## POC-015 — Final technical decision record

### Goal

Approve/reject models and processing paths, document risks and hand constraints into production architecture.

### Acceptance criteria

- Every advertised Release 1 operation has an approved path or is explicitly deferred.
- Selected models/providers include pinned versions, hashes and licence disposition.
- Rejected candidates include reasons.
- Browser/CPU/GPU routing matrix is approved.
- Quality, latency, memory, cost and security limitations are explicit.
- The report recommends the next architecture-document stage without implementing the production application.

