# Quality metrics

**Empty placeholder. Implemented from POC-004 onward.**

Metric *records* already exist in the contract
(`poc/contracts/measurement.py`). Metric *implementations* land here:

| Metric | Applies to | Arrives with |
| --- | --- | --- |
| PSNR, SSIM | paired images with ground truth | POC-004 |
| LPIPS or another perceptual metric | paired images | POC-007 |
| OCR character/word accuracy | documents and screenshots | POC-007 |
| Face embedding similarity | portraits, identity preservation | POC-009 |
| Segmentation IoU and boundary quality | background removal | POC-010 |
| Colour difference | colour correction with a reference | POC-011 |
| Tiling seam detection | large professional images | POC-012 |

## Two rules that apply to everything in this directory

**Metrics never replace visual review.** Benchmark plan section 8.1: "A sharper
but invented face may score attractively while being unacceptable." Objective
scores are inputs to the blinded human review in POC-008, not a substitute for it.

**Metric values are observations, never identity.** They are floats and they may
vary between runs and platforms. They must never be placed in a field that feeds
an identity digest — `poc/benchmark_runner/canonical.py` rejects floats outright,
which enforces this at the type level.
