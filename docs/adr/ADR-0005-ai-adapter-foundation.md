# ADR-0005 — The first AI adapter, and what it revealed

**Status:** Accepted, with two questions escalated to the product owner
**Date:** 24 August 2026
**Task:** POC-006
**Decisions recorded:** D-051, D-052, D-053, D-054, D-055

---

## Part 1 — The official package could not be used (D-051)

The obvious implementation of a Real-ESRGAN adapter is `pip install realesrgan`.
Its declared dependencies are:

```
basicsr>=1.4.2, facexlib>=0.2.5, gfpgan>=1.3.5, numpy,
opencv-python, Pillow, torch>=1.7, torchvision, tqdm
```

`gfpgan` is a **face restoration model**. POC-006 states plainly: *"Never silently
invoke face restoration."* Installing the official package would place a face
reconstruction model inside the executed dependency path of a general
super-resolution adapter.

A dependency that can reconstruct a face is not made safe by our choosing not to
call it. Code changes; a policy note in a docstring is not a control. The only
way to guarantee the operation can never run is for the model not to be present.

**Decision.** Reimplement the RRDBNet generator architecture directly (~120 lines,
in [`rrdbnet.py`](../../packages/processors/src/ipw/processors/ai_adapters/rrdbnet.py))
and load the official published weights into it. The executed inference path is
then `torch` and `numpy` and nothing else.

**How correctness is established, given that this is a reimplementation.**
Not by inspection, and not by "the output looks plausible". `load_state_dict`
runs with `strict=True`, so every parameter name and every tensor shape in the
official checkpoint must match exactly. Both published checkpoints load: 702
tensors, 16,697,987 parameters (x4) and 16,703,171 (x2). A wrong architecture
cannot load — it fails loudly rather than producing confident wrong output.

`basicsr` does not install on this interpreter in any case, so the alternative
was not actually available. But the reason above is the reason, and it would
still hold if it were.

**Consequence.** `gfpgan`, `facexlib` and `basicsr` are now in the repo-wide
forbidden-import set, asserted by test. A future face-restoration task (POC-009)
must add them deliberately, as its own reviewed decision.

## Part 2 — The licence answer is worse than the code licence suggests (D-052)

Real-ESRGAN's repository carries a BSD-3-Clause `LICENSE` file, "Copyright (c)
2021, Xintao Wang". Read alone, that reads like a clean commercial yes.

Two findings from the primary sources say otherwise.

**No weight licence exists.** The BSD file addresses the source code. Nothing in
the repository, the README or the release notes states terms for the published
`.pth` files. AGENTS.md is explicit that a code licence may not be assumed to
cover downloaded weights, so the disposition is `unknown` — not inherited.

**The training data is research-only.** `docs/Training.md` states the models were
trained on DF2K (DIV2K + Flickr2K) + OST. The DIV2K page at ETH Zurich states
verbatim:

> *this dataset is made available for academic research purpose only. All the
> images are collected from the Internet, and the copyright belongs to the
> original owners.*

Two restrictions, not one: research-only use, and third-party copyright in the
underlying images. Whether trained weights inherit a training dataset's licence
restrictions is legally unsettled and varies by jurisdiction. That is a question
for the product owner and, if the commercial answer matters, for counsel. It is
not something an engineer may wave through.

**Decision.** Register the datasets as first-class components
(`div2k-dataset` non-commercial, `flickr2k-dataset` and `ost-dataset` unknown)
and make the weights depend on them. The composite `real-esrgan` component
declares `review_required`, and **the inheritance rule resolves it to `unknown`**
— a permissive code licence does not launder restricted weights.

This is the D-038 gate matrix working on a real candidate rather than a test
fixture:

| Purpose | Outcome |
| --- | --- |
| `local_research` | permitted, marked |
| `internal_benchmark` | permitted, marked, *not eligible for commercial recommendation* |
| `public_demo` | **blocked** — `LICENCE.UNKNOWN_DISPOSITION` |
| `staging` | **blocked** |
| `production` | **blocked** |

Development was never blocked. That was the whole argument for purpose-based
gating, and it held.

## Part 3 — Two gates, proven independent (D-053)

Gate A (commercial licence) and Gate B (supply chain) are separate, and POC-006
is the first task where one opens while the other stays shut.

Recording the weight digests satisfied Gate B and flipped research use from
blocked to permitted. Gate A did not move, and every commercial purpose is still
refused. A test now asserts exactly that, replacing a POC-002 test which had
asserted that *nothing* could ever execute — true when written, and by POC-006 an
assertion that the gate never opens, which would make the gate decorative.

**Gate B in executable form:**

- Weights pinned by release tag and SHA-256 in
  [`install_model_weights.py`](../../tools/install_model_weights.py), duplicated
  in the adapter and cross-checked by test.
- The digest is verified **before** `torch.load`, not after. A tampered file
  never reaches the unpickler.
- `torch.load(weights_only=True)`. A `.pth` is a Python pickle and unrestricted
  unpickling executes arbitrary code from the file.
- `no_network()` replaces the socket constructors for the duration of inference,
  so a model that tried to phone home would fail loudly.
- Weights are gitignored and never committed, and never baked into the container
  image — no stated licence means no right to redistribute.

## Part 4 — The conformance suite was grading itself (D-054)

POC-006 was meant to be the task where the durable POC-001 deliverable paid off:
*"its test file is three lines."*

It was — but writing those three lines exposed a defect in the suite. Its probe
asset was the byte string `b"conformance-probe-asset-v1"`. Every image processor
refuses that at inspection, so `first.succeeded` was always false, and every
check gated on a successful run — deterministic output, measurement, workspace
cleanup after a real write — was silently skipped. The suite reported eleven
passing checks while exercising only the failure paths.

**Decision.** The probe is now a real 16×16 PNG, constructed from the standard
library so the runner acquires no imaging dependency. `_supported_operation`
negotiates the scale with the processor rather than assuming x2, and a twelfth
check, `successful_output_is_measured`, was added.

The standard processor and the AI adapter now both run a genuinely successful
operation through conformance. The AI adapter passes all twelve in 5.4 seconds
including real inference.

Worth stating plainly: this defect had been present since POC-001 and no test
caught it, because the suite's own reporting looked healthy. It was found by
using it for its intended purpose.

## Part 5 — The memory number was misleading (D-055)

The first comparison run produced this:

| | AI (x4) | Lanczos resize (×4) |
| --- | ---: | ---: |
| peak RSS | 410.3 MB | 410.3 MB |

Identical, and not a coincidence. `peak_rss_bytes` is a **process-lifetime
high-water mark**. Both runs execute in one process, so once the model has
allocated, the deterministic control reports the model's peak as if it were its
own. True of the process; false of the operation. Anyone reading that table would
conclude a Lanczos resize costs 410 MB.

**Decision.** Add `MemoryUsage.python_peak_delta_bytes` to the contract — a
per-call, `tracemalloc`-attributable figure that is not contaminated by other
work in the same process. It undercounts native allocation, which is why both
figures are kept: read together they bracket the answer.

| | AI (x4) | Lanczos resize (×4) |
| --- | ---: | ---: |
| per-call (Python-attributable) | 3.1 MB | 0.2 MB |

Contract version **1.1.0 → 1.2.0**, additive. The bump changes every derived
identifier by design, so goldens were regenerated and reviewed: the diff is the
version string, four digests and the register component counts, and nothing else.

A single trustworthy per-call total needs process isolation. That is what the
container definition is for, and why it is more than packaging.

## Part 6 — What was measured

`bench ai-baseline --manifest data/manifests/example.manifest.json --scale 4`,
on a 64×64 synthetic gradient, CPU-only, 4 threads:

| | AI (x4) | Lanczos resize (×4) |
| --- | ---: | ---: |
| output | 256×256, 83,125 B | 256×256, 2,630 B |
| total | 4,598 ms | 19 ms |
| **relative cost** | **~250× slower** | — |
| cold model load | ~4.3 s | n/a |
| per-call memory | 3.1 MB | 0.2 MB |

**The routing conclusion is now measured rather than assumed.** D-019 routes AI
work to cloud GPU. A 250× penalty on a 4,096-pixel image — the smallest input the
product will ever see — is that decision's evidence. A 24-megapixel professional
image is roughly 6,000× more pixels.

**The quality question is not answered here, deliberately.** No PSNR, no SSIM, no
verdict on which output looks better. Objective metrics rank; they do not judge
(D-011). That is POC-008's blinded review, and pre-empting it with a number would
be exactly the failure the product decided against.

**Reproducibility and its documented tolerance.** fp32 CPU convolution is
byte-deterministic for a fixed torch build and thread count — asserted by test,
including through the tiled path. It is *not* guaranteed across torch versions,
thread counts or hardware. Comparisons are therefore valid within one
environment, and every report carries the environment block that makes this
checkable.

**Tiling is not output-neutral, and it was measured rather than assumed.** A
convolutional network sees a limited context; every tile gets less of it than the
whole image had, and the overlap margins reduce that penalty without removing it.
On the 64x64 noise fixture at x4, against whole-image inference:

| tiling | subpixels differing | max delta | mean delta |
| --- | ---: | ---: | ---: |
| tile 32, overlap 8 | 105,999 / 196,608 (54%) | 8 / 255 | 0.71 |
| tile 16, overlap 4 | 165,888 / 196,608 (84%) | 16 / 255 | 2.22 |

Small and bounded, but real, and it worsens as tiles shrink. Whether it is
*visible* is POC-012's question. What matters now is that a tiled result and a
whole-image result are **different results**. The contract already handles this
correctly: `tile_size` and `tile_overlap` are part of `ProcessorIdentityDigest`,
so the three configurations above produce three distinct run identities and
cannot be silently averaged into one figure. Verified, not assumed.

## Escalated to the product owner

1. **May Real-ESRGAN weights be used commercially?** Unresolved and not resolvable
   by engineering. No weight licence is stated, and the training data is
   research-only. Blocks POC-013's commercial recommendation for this model, not
   the benchmark itself.
2. **Does the GPU path need its own licence review?** Yes, before it runs. The
   CUDA torch build bundles NVIDIA runtime libraries under the NVIDIA Software
   Licence Agreement, which is not permissive and has not been reviewed. The CPU
   pin is currently a licence control as much as a hardware one.

## Consequences

- `torch` and `numpy` join the runtime register, confined by test to
  `ipw/processors/ai_adapters`. The standard baseline is provably free of a
  tensor runtime, or "standard versus AI" would stop being a real comparison.
- The `torch` record was corrected from BSD-3-Clause to the compound expression
  the wheel actually declares. All permissive; the attribution obligation is
  real and recorded.
- The container definition exists but is unbuilt — no Docker here. Marked
  unexercised rather than presented as done.
