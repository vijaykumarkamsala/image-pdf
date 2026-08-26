# Technical Proof of Concept & Model Benchmark Plan

**Product:** Image & PDF Workspace (working title)  
**Stage:** 2 — Technical validation before architecture approval  
**Version:** 0.1  
**Date:** 24 August 2026  
**Depends on:** `PRODUCT_REQUIREMENTS.md`

## 1. Objective

Prove that the Release 1 image-enhancement product can deliver commercially usable quality, predictable performance and sustainable cost before selecting the final architecture or asking an AI coder to build the complete application.

This stage is not a UI demo. It is a controlled technical experiment that answers:

1. Which operations are safe and useful in the browser?
2. Which deterministic operations require authoritative cloud CPU rendering?
3. Which AI models are eligible and best for each image category?
4. What quality, latency, memory and cost can be promised for 2×, 4×, 4K, 8K and print outputs?
5. How should very large images be tiled without visible seams?
6. Which models, weights and dependencies are commercially usable?
7. Which processing route should automatic routing select?

No production model is approved merely because it produces an attractive example.

## 2. Stage Outputs

The proof of concept must produce:

- Reproducible benchmark runner
- Curated, rights-cleared evaluation manifest
- Standard-processing baseline results
- AI model results by task and image category
- Browser, CPU and GPU performance measurements
- Large-image tiling and seam report
- Human visual-review scorecard
- Objective metric report where ground truth exists
- Commercial licence/dependency register
- Cost-per-operation and cost-per-output-megapixel estimates
- Recommended production model/routing matrix
- Rejected-model register with reasons
- Architecture constraints and open risks

## 3. Scope

### Included

- Standard enhancement
- General 2× and 4× super-resolution
- Denoise, JPEG artifact reduction, sharpen and limited deblur
- Face restoration
- Old-photo damage repair/inpainting
- Colour correction and colourisation
- Background removal
- Background replacement proof of concept
- Local/browser versus cloud routing
- Individual and 50-image batch execution
- Inputs through 25 MB standard and 100 MB professional paths
- 4K, 8K, custom and print-oriented outputs

### Excluded

- Full production web application
- Authentication, final billing or collaboration UI
- Full PDF canvas/editor
- Custom model training or fine-tuning
- Permanent provider contracts
- Final commercial prices

## 4. Hard Gates

A candidate cannot be recommended for production unless all gates pass.

### Gate A — Commercial eligibility

- Code licence reviewed
- Weight/model licence reviewed
- Dataset-derived restrictions investigated where relevant
- Dependency licences reviewed
- Required notices/attribution recorded
- No non-commercial restriction unless written commercial permission is obtained

### Gate B — Security and supply chain

- Official or independently verifiable source
- Version or commit pinned
- Model file hash recorded
- Unsafe arbitrary-code loading avoided where possible
- Container and dependencies scanned
- Network access disabled during inference unless explicitly required

### Gate C — Functional quality

- Meets the minimum task score
- Does not silently change the original
- Does not create unacceptable face/text/logo distortion
- Failure cases are detectable or clearly disclosed

### Gate D — Operational viability

- Fits approved CPU/GPU memory envelope
- Supports safe cancellation and timeouts
- Can process large images through tiling when needed
- Has reproducible output under the chosen runtime
- Cost and latency fit at least one viable plan or one-time price

## 5. Evaluation Corpus

Use both public benchmark data and private/product-realistic samples with documented rights. Do not use customer images without permission.

### 5.1 Image categories

| Category | Minimum samples | Important characteristics |
|---|---:|---|
| Modern mobile photos | 25 | Day/night, compression, motion, skin, foliage |
| Old photographs | 25 | Fading, scratches, folds, stains, monochrome |
| Faces/portraits | 25 | Single/group, age ranges, skin tones, spectacles |
| Documents/screenshots | 25 | Small text, UI, tables, logos, line art |
| Product/catalogue | 25 | Edges, labels, textures, transparency |
| Illustrations/anime | 20 | Flat colour, line art, gradients |
| Low-light/noisy | 20 | Colour noise, shadow detail |
| Background removal | 25 | Hair, fur, glass, shadows, complex edges |
| Large professional | 10 | High megapixels, 16-bit/alpha where supported |

Target initial corpus: approximately 200 images. A smaller 40-image smoke subset runs on every change; the full suite runs for release decisions.

### 5.2 Paired and unpaired inputs

- **Paired:** Known high-quality image plus synthetically degraded versions. Enables objective comparison.
- **Unpaired:** Real low-quality image without ground truth. Requires structured human review.

Synthetic degradation must vary blur, noise, downsampling, JPEG compression and colour loss. Results must also be validated against real degradation because synthetic scores alone do not prove customer quality.

### 5.3 Rights manifest

For every source, record:

- Asset ID
- Category
- Source/owner
- Permitted benchmark use
- Whether results can appear in public demos
- Presence of people or sensitive information
- Ground-truth relationship
- Degradation recipe if generated

## 6. Candidate Matrix

This is a benchmark shortlist, not a production approval.

### 6.1 Deterministic baseline

- Browser Canvas/Web APIs for crop, rotate and simple adjustments
- OpenCV.js for eligible local preview operations
- Server OpenCV/libvips or equivalent for authoritative standard rendering
- Bicubic and Lanczos resize baselines
- Classical denoise, unsharp masking and contrast/colour baselines

### 6.2 General super-resolution/restoration

| Candidate | Purpose | Initial licence observation | Benchmark status |
|---|---|---|---|
| Real-ESRGAN | Practical real-world 2×/4× restoration baseline | Main repository BSD-3-Clause; dependencies/weights still require register | Include |
| SwinIR | SR, denoise and JPEG artifact reduction comparator | Official repository Apache-2.0; follow dependency licences | Include |
| Additional current candidate | Selected only after official-source and licence review | Pending | One slot reserved |
| SUPIR | High-quality research reference | Official project states non-commercial use only without permission | Reference-only; exclude from commercial recommendation unless permission obtained |

### 6.3 Face restoration

| Candidate | Purpose | Initial licence observation | Benchmark status |
|---|---|---|---|
| GFPGAN | Real-world face restoration | Repository says Apache-2.0, but its licence lists third-party components with additional terms | Include only after dependency-path review |
| CodeFormer | Face restoration/fidelity control | NTU S-Lab License 1.0; commercial terms require explicit review | Licence-gated |
| No-face-model baseline | General enhancement without face reconstruction | N/A | Mandatory control |

Face restoration must never become the automatic default. Results must be scored for identity preservation, not only perceived sharpness.

### 6.4 Background removal

| Candidate | Purpose | Initial licence observation | Benchmark status |
|---|---|---|---|
| rembg wrapper with selected supported model | Automatic segmentation/background removal | Wrapper is MIT; each selected model/weight requires its own review | Include after per-model review |
| Browser/manual mask | Non-AI control and correction | Implementation-dependent | Include |

### 6.5 Damage repair, colourisation and replacement

Do not adopt a model by popularity. For each operation, shortlist no more than three candidates after official-source, commercial-licence and dependency review. Archived projects may be used only as research references unless maintainability risk is accepted.

## 7. Processing Variants

Every eligible input should run through relevant variants:

1. Original control
2. Standard browser-preview processing
3. Standard authoritative server processing
4. AI Natural
5. AI Strong
6. AI task-specific option, such as Face Restoration

For upscaling, test native 2× and native 4× models separately. Do not represent post-resized 4× output as equivalent to a native 2× model without evidence.

## 8. Quality Evaluation

### 8.1 Objective metrics

Use only where meaningful:

- PSNR
- SSIM
- LPIPS or another perceptual metric
- OCR character/word accuracy for document images
- Face embedding similarity for identity preservation, with privacy-safe evaluation data
- Segmentation IoU/boundary metrics for background removal
- Colour difference for colour correction when reference colour exists

Metrics do not replace visual review. A sharper but invented face may score attractively while being unacceptable.

### 8.2 Human review dimensions

Score each relevant dimension from 1 to 5:

- Overall usefulness
- Natural appearance
- Detail improvement
- Identity preservation
- Text/logo accuracy
- Colour faithfulness
- Artifact level
- Edge/halo quality
- Tiling/seam visibility
- Preference over the standard baseline

Reviewers see randomized outputs without model names. At least two reviewers score the smoke set; important disagreements receive a third review.

### 8.3 Critical failures

Automatically fail a result for:

- Material face/identity change in Natural mode
- Changed words, digits, brand names or logos
- Added/removed people or objects outside the selected operation
- Severe tiling seams
- Broken transparency
- Orientation corruption
- Unsupported silent colour-space conversion
- Output that is visually worse than the standard baseline without warning

## 9. Browser/Local Benchmark

Test at minimum:

- Current Chrome/Edge desktop on an ordinary Windows laptop
- Current Safari desktop if available
- Mid-range Android device
- Current iPhone/Safari
- Tablet browser where available

Measure:

- Initial library/model download size
- Decode time
- Time to first preview
- Operation latency
- Peak JavaScript/WASM memory where measurable
- Main-thread blocking and UI responsiveness
- Battery/thermal impact qualitatively on mobile
- Failure after tab backgrounding, refresh and device sleep
- Output consistency versus server implementation

The POC must define a conservative local eligibility rule. Automatic routing uses feature detection and measured limits, not user-agent assumptions alone. Advanced override appears only when the requested operation is supported safely.

## 10. Cloud CPU/GPU Benchmark

### 10.1 CPU matrix

Test representative vCPU/memory configurations for deterministic processing. Record cold start separately from warm processing.

### 10.2 GPU matrix

Begin with rented/on-demand GPU capacity. At minimum test one cost-oriented GPU and one higher-memory reference configuration where required. Do not buy permanent hardware during this stage.

### 10.3 Measurements per job

- Input compressed bytes
- Decoded width, height, channels and bit depth
- Output dimensions and bytes
- Operation/model/version/precision
- Tile size and overlap
- CPU model/vCPU count or GPU type/VRAM
- Queue wait
- Model load/cold start
- Preprocessing, inference and post-processing time
- Peak RAM/VRAM
- Retry count and failure type
- Compute, storage and bandwidth estimate

## 11. Large-image and Tiling Test

Test increasing megapixel levels and representative 25 MB/100 MB inputs.

Validate:

- Decode-bomb protection
- Tile-size auto-selection
- Overlap/blending strategy
- Edge consistency
- Alpha and 16-bit behaviour
- Cancellation and cleanup
- Temporary storage limits
- Resume/retry strategy
- Final output encoding time and memory

Compare tiled and non-tiled results on images that fit both paths. The difference must be visually acceptable and documented.

## 12. Batch and Durability Test

Run batches of 1, 10 and 50 images with mixed operations and failures.

Prove:

- Per-image status isolation
- Idempotent retry
- No duplicate charging events in the POC ledger
- Browser closure does not stop cloud jobs
- One corrupt image does not fail the batch
- Cancellation semantics are explicit
- Temporary and failed artifacts are cleaned up
- Results remain mapped to the correct original

## 13. Cost Model

For every candidate calculate:

```text
direct job cost =
  compute duration
  + model load/cold-start allocation
  + temporary storage
  + retained storage allocation
  + output bandwidth
  + external-provider fee (if any)
  + payment overhead allocation
```

Normalize to:

- Cost per input megapixel
- Cost per output megapixel
- Cost per 2×/4× operation
- Cost per 4K/8K output
- Cost per 50-image batch
- P50/P95 processing duration

Add an operational-risk margin before recommending a customer price. Final prices remain a later business decision.

## 14. Routing Decision Table

The POC must recommend actual thresholds for this policy:

| Condition | Default route | Advanced override |
|---|---|---|
| Small, simple standard edit | Browser local | Cloud allowed |
| Eligible local standard download | Browser local | Cloud allowed |
| Saved/professional authoritative output | Cloud CPU | Local only if product explicitly supports it |
| AI operation | Cloud GPU | No local override initially unless benchmark proves safe |
| Large/professional image | Cloud CPU/GPU | Local disabled when unsafe |
| Batch/background continuation | Cloud | Local disabled |

Customers see simple route descriptions, not infrastructure terminology.

## 15. Recommended POC Implementation Shape

Use a small reproducible monorepo or isolated repository containing:

```text
poc/
  benchmark-runner/
  browser-lab/
  processors/
    standard/
    ai-adapters/
  manifests/
  metrics/
  reports/
  fixtures/        # only rights-cleared small fixtures in git
  docker/
```

Large/private benchmark assets belong in protected object storage. Git stores only manifests, hashes and permitted small fixtures.

Each processor implements one internal contract:

```text
inspect(input) -> input metadata and safety decision
estimate(input, operation, settings) -> time/cost/memory estimate
process(input, operation, settings) -> result plus measured metrics
```

## 16. Execution Phases

### Phase A — Corpus and harness

- Approve rights manifest
- Create synthetic degradation recipes
- Implement common result/metric format
- Establish deterministic standard baseline

### Phase B — General SR

- Benchmark Real-ESRGAN, SwinIR and one approved current candidate
- Test 2×/4×, photo/document/illustration and tiling

### Phase C — Specialized operations

- Face restoration
- Background removal
- Damage repair
- Colourisation
- Background replacement

### Phase D — Browser/cloud routing

- Measure local operations across devices
- Measure CPU/GPU paths
- Derive automatic thresholds and override policy

### Phase E — Batch and cost

- Run 50-image durability tests
- Produce cost and queue models

### Phase F — Decision review

- Approve/reject each candidate
- Publish model/routing matrix
- Feed constraints into `ARCHITECTURE.md`

## 17. Exit Criteria

Stage 2 is complete only when:

1. Evaluation corpus and rights manifest are approved.
2. Benchmark runner reproduces results from a clean environment.
3. Every candidate has a licence/dependency disposition.
4. At least one viable standard path is approved.
5. At least one viable general 2× and 4× AI path is approved, or the gap is explicitly escalated.
6. Every advertised specialized operation has an approved model/provider or is removed from Release 1 until solved.
7. Browser/local thresholds are based on measured devices.
8. 25 MB/100 MB professional paths and tiled large-image behaviour are measured.
9. A 50-image mixed batch completes with correct isolation/retry.
10. Cost and P50/P95 latency are documented.
11. Automatic routing and Advanced override rules are approved.
12. Architecture receives a clear recommended model/processing matrix.

## 18. Inputs Needed to Execute

Before running the full benchmark, obtain:

- Rights-cleared representative personal/product images from the product owner, if available
- Permission on whether selected samples/results may be shown publicly
- At least one ordinary Windows test machine
- Access to representative mobile/tablet devices
- Temporary on-demand CPU/GPU environment and cost budget
- Product owner availability for blinded visual review

Public benchmark data can begin the harness, but product-owner samples are required before a production decision.

## 19. Initial Source Register

- Real-ESRGAN official repository: https://github.com/xinntao/Real-ESRGAN
- SwinIR official repository: https://github.com/JingyunLiang/SwinIR
- GFPGAN official repository: https://github.com/TencentARC/GFPGAN
- CodeFormer official repository: https://github.com/sczhou/CodeFormer
- SUPIR official repository: https://github.com/Fanghua-Yu/SUPIR
- rembg repository: https://github.com/danielgatis/rembg
- OpenCV.js documentation: https://docs.opencv.org/4.x/df/d0a/tutorial_js_intro.html

This register is informational. Production approval requires exact pinned versions, files, weights and dependency licences.

