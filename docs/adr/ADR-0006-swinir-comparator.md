# ADR-0006 — The SwinIR comparator, and where the licence problem actually lives

**Status:** Accepted, with one question escalated to the product owner
**Date:** 25 August 2026
**Task:** POC-007
**Decisions recorded:** D-056, D-057, D-058, D-059, D-060

---

## The headline: adding a second model did not solve the licence problem

POC-006 ended with Real-ESRGAN permitted for research only, because no weight
licence is stated and the weights derive from DIV2K, which ETH Zurich publishes
for "academic research purpose only". The obvious hope for POC-007 was that a
second candidate might be cleaner.

**SwinIR's code is cleaner. Its weights are in exactly the same place.**

| | Real-ESRGAN | SwinIR |
| --- | --- | --- |
| Code licence | BSD-3-Clause | **Apache-2.0** (with a patent grant) |
| Upstream code chain | — | Swin-Transformer MIT, KAIR MIT |
| Code disposition | review_required | **approved** |
| Weight licence stated | none | none |
| Training data | DF2K + OST | DIV2K, DF2K, DFO, **DFWB** |
| Weight disposition | unknown | unknown |
| **Composite** | **unknown** | **unknown** |
| Research use | permitted, marked | permitted, marked |
| Commercial use | blocked | blocked |

Every published SwinIR checkpoint — all six task families, all 46 release assets
— is trained on a DIV2K-derived set. The README names them: DIV2K, DF2K
(DIV2K+Flickr2K), DFO (DF2K+OST), DFWB (DF2K+WED+BSD500), DFOWMFC.

**The restriction is upstream of the model.** It is a property of the dataset the
research community trains on, not of either project's licensing choices. Swapping
models is not a route around it, and D-040's "every advertised operation keeps an
approved fallback" is therefore load-bearing rather than precautionary: for
`super_resolution` and now `ai_denoise`, the fallback is the deterministic
pipeline, and it is the only thing standing between the product and having no
shippable option at all.

A test asserts this directly, so it cannot quietly stop being true:
`test_adding_a_second_model_did_not_close_any_gap`.

## Part 1 — Vendoring, and why it beat reimplementing (D-056)

POC-006 reimplemented RRDBNet (~120 lines) rather than install `realesrgan`,
because that package hard-depends on `gfpgan` — a face-restoration model POC-006
forbids from a general super-resolution path.

SwinIR presents no such problem, and reimplementing it would be a much worse
trade. `models/network_swinir.py` is **867 lines of Swin Transformer**: shifted
window attention, relative position bias tables, patch merging. Rewriting it
could produce a module that loads the published checkpoint with `strict=True` and
is still subtly wrong — a mismatched window-partition order or relative-position
index has the right parameter shapes and the wrong output, and nothing in the
loading path would notice.

**Decision.** Vendor the file verbatim under Apache-2.0, at pinned commit
`6545850f`, with its notices retained and its modifications stated in the file
itself. Two modifications, both mechanical: the `timm` import is replaced by local
equivalents (three small helpers do not justify a dependency, and `trunc_normal_`
was upstreamed into `torch.nn.init` anyway), and an attribution header is added.

The full code chain was read, not assumed: SwinIR Apache-2.0 → Swin-Transformer
MIT (Microsoft) → KAIR MIT (Kai Zhang). SwinIR's README explicitly directs users
to follow the upstream licences, so both were registered as components.

**Vendoring is now a governed act rather than a precedent.** New guards require
every vendored file to name its upstream, commit and digest, to state its
modifications, and to import nothing forbidden. The vendored tree is excluded
from ruff, mypy and coverage — formatting or type-annotating a copied file
destroys the diff against upstream, which is the only cheap way to re-verify it —
but it is **not** exempt from the import guards, because vendored code pulling in
a forbidden dependency would be exactly as dangerous as ours doing it.

## Part 2 — Two operations the contract could not express (D-057)

`PRODUCT_REQUIREMENTS.md` section 10 lists "Advanced denoise, deblur and sharpen"
among the AI capabilities. But `OperationKind` had only `denoise`, and `FAMILY_OF`
places it in the STANDARD family.

That mapping is correct and load-bearing — D-007/D-009 require that Standard
Enhance can never silently invoke AI, and `Operation.build` derives the family
from the kind, so a standard `denoise` genuinely cannot be routed to a model. The
consequence was that **AI denoise could not be expressed at all**. POC-007 needed
to benchmark it, so a gap that had been latent since POC-001 surfaced.

**Decision.** Add `ai_denoise` and `jpeg_artifact_repair` as AI-family operations
with their own settings models. Two names, two families, no overlap: a median
filter cannot invent detail and a learned restoration can, and the customer is
entitled to know which one ran.

**And stop deriving the advertised set.** `ADVERTISED_OPERATIONS` was "every kind
that is not INSPECTION", which fused two unrelated questions — what the contract
can *express* and what the product *sells*. Under that rule, adding an operation
kind so a benchmark could measure it would have advertised it to customers and
attached a D-040 fallback obligation to it, as a side effect of an enum. The set
is now written out explicitly, mirroring sections 9 and 10, with
`EXPRESSIBLE_OPERATIONS` keeping the old meaning under an honest name.

`jpeg_artifact_repair` is expressible but **deliberately not advertised**: SwinIR
implements it and POC-007 benchmarks it, but section 10 does not name it.
Measuring something is not promising it (**O-015**).

Contract **1.2.0 → 1.3.0**, additive.

## Part 3 — A gate that was asking datasets the wrong question (D-058)

Registering WED and BSDS500 exposed a category error. Gate B requires
`pinned_version` on every component — "pin what you execute". A dataset is never
downloaded, unpickled or given network access by anything here; it is registered
so the restrictions it carries propagate to weights trained on it.

The already-registered datasets passed Gate B only because a plausible year had
been typed into the field. That is not a supply-chain control; it is a habit that
looks like one. WED's official page now returns 404 and Berkeley's states no
terms, so for these two there was no honest value to type.

**Decision.** Gate B's execution-shaped requirements do not apply to `dataset`
components. `official_source` is still required — provenance must be traceable —
and the disposition still propagates in full through Gate A inheritance, which is
the entire reason datasets are registered. Nothing about the restriction weakens;
only a question that had no meaning stops being asked.

## Part 4 — Quality metrics, and refusing to rank with them (D-059)

`packages/metrics` had been an empty placeholder since POC-004. POC-007's
acceptance criteria require a quality comparison, so PSNR and SSIM landed:
implemented directly on numpy, no scipy, no scikit-image, no torchmetrics.

**The SSIM variant is named in every report.** "SSIM" alone does not identify a
number — a uniform-window implementation gives a visibly different value for the
same pair. Reports carry
`wang2004-gaussian-11x11-sigma1.5-per-channel-mean`.

**No winner is computed, and the absence is structural.** POC-007 requires that
no winner be declared from objective metrics alone, and the way to satisfy that is
not to declare one carefully — it is to have no code that could. The comparison
document has a `winner` field that is present and always `null`, with a note
saying where the answer comes from, and a test asserts that no ranking field
exists anywhere in the document.

The first real run showed exactly why. On the same asset:

| | PSNR (dB) | SSIM |
| --- | ---: | ---: |
| Real-ESRGAN | **21.59** | 0.6539 |
| SwinIR | 20.95 | **0.6776** |

**The two metrics rank the two models in opposite orders.** Any numeric verdict
here would have been a choice of metric dressed up as a finding.

A further honesty constraint: these are measured against the *deterministic
control*, not a ground truth, because for real-world super-resolution no ground
truth exists — if a high-resolution original were available, nobody would be
upscaling. A high score means "close to a Lanczos resize", which for a generative
model is closer to a criticism than a compliment. The report says so, and names
the actual control rather than assuming it was a resize.

## Part 5 — What was measured

`bench compare-models`, 64×64 synthetic asset, CPU, 4 threads:

**Super-resolution ×4** — three candidates:

| candidate | output | total | inference | commercial |
| --- | --- | ---: | ---: | --- |
| deterministic-lanczos | 256×256, 2,630 B | 56 ms | 29 ms | eligible |
| real-esrgan | 256×256, 83,125 B | 1,948 ms | 922 ms | **not eligible** |
| swinir | 256×256, 87,651 B | 2,216 ms | 1,163 ms | **not eligible** |

**AI denoise** — SwinIR against the median filter a customer gets today:

| candidate | total | PSNR vs control | SSIM vs control |
| --- | ---: | ---: | ---: |
| deterministic-median | 36 ms | — | — |
| swinir | 2,418 ms | 37.25 | 0.9536 |

SwinIR is roughly **67× slower** than the median filter and **1.3× slower** than
Real-ESRGAN on the same super-resolution work — expected for a transformer, and
now measured rather than assumed. Both AI paths remain far outside what a browser
or a request-response CPU path can absorb, which is the same conclusion POC-006
reached and the reason D-019 routes AI to cloud GPU.

## Part 6 — Two POC-006 defects found while doing this (D-060)

**A pin that was wrong and never checked.** The installer recorded
`bytes_expected=67_105_069` for `RealESRGAN_x2plus.pth`; the real file is
67,061,725 bytes. The digest was correct, so nothing was broken — but the field
was never read by `install()` or `verify()`. A dead field that is also wrong is
worse than no field, because it reads like a check. The value is corrected and
the size is now verified before the digest, which is free and catches a truncated
download before hashing a hundred megabytes.

**Gate B controls existed in two copies.** POC-006 wrote digest verification,
restricted unpickling, the network guard and the tensor conversions inline. A
second adapter would have meant two copies that could drift, and a control that
applies to one model and quietly not the other is the failure nobody notices.
They now live once, in `ai_adapters/common.py`, and both adapters use them.

## Escalated to the product owner

**O-015 — should `jpeg_artifact_repair` be an advertised operation?** SwinIR
implements it well enough to benchmark, and it is a real customer need for
scanned and re-saved images. But `PRODUCT_REQUIREMENTS.md` section 10 does not
name it, and advertising an operation attaches a D-040 fallback obligation to it
that nothing currently satisfies. It is expressible and benchmarked; whether it is
sold is not an engineering decision.

## Consequences

- The licence register holds 44 components. Three more are `approved`
  (`swinir-code`, `swin-transformer-code`, `kair-code`) and the composite still
  is not — which is the inheritance rule doing its job on a second real candidate.
- `ai_denoise` joins the D-040 list of advertised operations with no approved
  fallback. That list grew rather than shrank in a task that added a model, which
  is the finding rather than a regression.
- `numpy` is no longer confined to the AI adapters; it is array arithmetic, and
  the metrics package needs it. `torch` stays confined, and the standard baseline
  is still barred from both.
- Contract 1.3.0. Goldens regenerated and reviewed: the diff is the version
  string, four digests, the register counts, and `ai_denoise` appearing in the
  D-040 gap list.
