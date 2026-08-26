# Image & PDF Workspace — monorepo

Standalone image and PDF workspace. This repository currently holds the technical
proof of concept described in [`docs/`](docs/); production application workspaces
arrive after architecture approval.

The POC validates image-processing quality, performance, commercial eligibility
and cost **before** the production architecture is approved. It is not the
customer-facing application, and it is not permission to build one. Read
[`AGENTS.md`](AGENTS.md) before making any change.

**Current state: POC-001 through POC-005 complete** — monorepo layout, benchmark
contract, purpose-based licence and rights gates, header-first input inspection,
the deterministic standard-processing baseline on two engines, and the browser
laboratory with a cross-language-verified contract. No model, no model weights and
no external inference provider are integrated. That is enforced by tests, not just
by policy.

---

## Setup

Requires Python 3.11+ (verified on CPython 3.14.5, Windows 11). No compiler, no
GPU, no Docker, and no network access at test time.

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1                 # macOS/Linux: source .venv/bin/activate

python -m pip install -c requirements-dev.lock.txt -r requirements-dev.txt `
  -e packages/contracts -e packages/processors -e services/benchmark-runner
```

The three Python workspaces install as editable packages sharing the `ipw`
namespace. Every dependency resolves to a prebuilt wheel;
`requirements-dev.lock.txt` pins exact versions.

## Verify everything with one command

```powershell
python tools/check.py
```

Runs, in order: format, lint, strict type check, tests with coverage, fixture
integrity, fixture reproducibility, schema-drift check, example-manifest
validation. `--list` shows the gates and why each exists; `--fix` auto-formats
first.

## Commands

The CLI installs as `bench`, and also runs as `python -m ipw.benchmark_runner`.

```powershell
# Validate a manifest. Decodes no image; reads bytes only to verify SHA-256.
bench validate-manifest data/manifests/example.manifest.json
bench validate-manifest data/manifests/invalid/hash-mismatch.json --format json

# Report from validated metadata. --deterministic makes the output byte-stable.
bench report --manifest data/manifests/example.manifest.json --out build/report --deterministic

# Inspect real files: signature, header, limits, handling class. Decodes nothing.
bench inspect data/fixtures/images/synthetic-gradient-64.png
bench inspect data/fixtures/images/decompression-bomb.png --format json
bench inspect data/fixtures/images/*.png --max-pixels 100   # ceilings are configurable

bench schema export --check     # committed JSON Schema still matches the models
bench fixtures verify           # committed fixture bytes unchanged

# AI baseline versus a deterministic resize, over one manifest.
bench ai-baseline --manifest data/manifests/example.manifest.json --out data/reports/poc006

# Every available model against the deterministic baseline, side by side.
bench compare-models --manifest data/manifests/example.manifest.json --out data/reports/poc007

# Durable batch: state lives on disk, so an interrupted run can be resumed.
bench batch --manifest data/manifests/example.manifest.json --out run/
bench batch-status --journal run/run-journal.jsonl

# Blinded review: build a package, then aggregate the scores that come back.
bench review-build --comparison data/reports/poc007 --out review/package --sealed-key review-sealed/key.json
bench review-aggregate --package review/package/review-package.json --scores scores.json --out review

# Licence register: what is registered, and what each purpose permits.
bench licence list
bench licence check --purpose internal_benchmark
bench licence check --purpose production --component supir

bench version
```

**Exit codes:** `0` success, `1` internal error, `2` validation failure.

## Layout

```text
workspaces.toml               monorepo manifest — every workspace, its stage and owner task
├─ packages/
│  ├─ contracts/              Python · the versioned benchmark contract (SOURCE OF TRUTH)
│  ├─ processors/             Python · adapters + the guards around every processor call
│  ├─ schemas/v1/             JSON   · generated from contracts; language-neutral
│  ├─ contracts-ts/           TS     · generated types            — POC-005
│  └─ metrics/                Python · PSNR/SSIM/LPIPS/OCR/IoU    — POC-004+
├─ services/
│  └─ benchmark-runner/       Python · validation, ids, reporting, orchestration, `bench`
├─ apps/
│  └─ browser-lab/            TS     · device measurement harness — POC-005
├─ infra/
│  └─ docker/                 pinned inference runtimes           — POC-006
├─ data/                      manifests · fixtures · reports   (not code, not a workspace)
├─ docs/                      approved product and POC documents + ADRs
├─ data/                      manifests · fixtures · goldens · licences · corpus · vectors
├─ tests/                     repo-wide guards: scope, structure, layering, naming
└─ tools/                     check.py · generators · libvips installer · lab server
```

Python workspaces use a `src/` layout and share the PEP 420 namespace `ipw`, so
imports read `from ipw.contracts import ...` regardless of which workspace a
module lives in.

### Dependency direction

```text
services/benchmark-runner  ──▶  packages/processors  ──▶  packages/contracts  ──▶  pydantic
```

Enforced by [`tests/test_workspaces.py`](tests/test_workspaces.py), not by
convention. `packages/contracts` depends on **no other workspace** — that is what
lets the TypeScript browser lab consume the generated schema without pulling in
the benchmark runner.

### Stages

Every workspace declares `stage` in `workspaces.toml`: `poc`, `shared`,
`production` or `tooling`. A `production` workspace may never import from a `poc`
workspace, so promoting code is an explicit, reviewable move rather than a quiet
import. There are no production workspaces yet — architecture approval is a
prerequisite (blueprint §29).

## Core design decisions

**One contract, one language, one generated artifact.** All schemas are pydantic
models in `packages/contracts`, exported as JSON Schema to `packages/schemas`.
The TypeScript browser lab validates against that export rather than
re-implementing the contract, so the two cannot drift.

**Identifiers are content-addressed.** A `run_id` is the SHA-256 of a canonical
document containing only *declared inputs* — manifest digest, sorted asset ids,
processor identity, operation, policy digest. Timings, memory, hostnames and
attempt counters are excluded. A `result_id` likewise excludes `attempt`, which
is what makes a retry idempotent: same result id, one ledger entry, no duplicate
billing event.

**Determinism is enforced, not hoped for.** Floats are rejected outright in
canonical documents; durations are integer nanoseconds and money a decimal
string. All clock and randomness access goes through an injected `RunContext`,
and a lint rule fails the build if any other module reads `time.time`,
`datetime.now`, `random` or `uuid4`.

**Originals cannot be mutated through the API, and are checked anyway.** The
processor contract hands out a read-only `InputRef` with no writable path, and
`ipw.processors.base` verifies the original's SHA-256 before *and* after every
call. A session-scoped guard hashes every committed fixture at the start and end
of the whole test run.

**Nothing crosses the processor boundary as an exception.** Anything an adapter
raises is normalised into a `NormalizedFailure` carrying a stable code, a
category, an RFC 6901 pointer and a next action. That is what makes "one failed
input must not fail an entire batch" structurally true.

**Standard and AI are separated by the type system.** Every `OperationKind` maps
to a fixed family; declaring `super_resolution` as `standard` is a validation
error (D-007, D-009).

## Input inspection (POC-003)

Headers are parsed; **pixels are never decoded**. PNG `IHDR` and JPEG `SOF` give
exact dimensions, depth and channel count from a few hundred bytes, so an
oversized or hostile image is refused *before* any buffer is allocated — which is
what "caught before unsafe allocation" actually requires. A library that decodes
first has already committed the memory by the time you can check.

The committed bomb fixture declares 3.6 gigapixels in 84 bytes. It is refused
after reading those 84 bytes; decoding it would have attempted roughly 10 GB.

| Class | Meaning |
| --- | --- |
| `standard` | within the 25 MB / 50 MP tier (D-021) |
| `professional` | within 100 MB / 200 MP |
| `extreme_custom` | beyond professional, below the hard ceiling — an actionable custom path, **not** a refusal (D-022) |
| `invalid` | signature mismatch, unsupported format, malformed header, bomb, or hard ceiling exceeded |

Every threshold lives in `SafetyPolicy`, never as a literal at a call site.
Orientation is normalised **as metadata**: the EXIF tag becomes a transform and
true display dimensions (a 16×8 image with orientation 6 displays as 8×16), while
the original is never rotated or rewritten. Passing a manifest entry additionally
cross-checks declared metadata against what the bytes actually say, so a manifest
that misstates its own corpus is detectable.

This is also why the repository still has **no imaging dependency**. Pillow or
pyvips arrives with POC-004, which genuinely needs pixels, and enters through the
POC-002 licence gates with a pinned version and a disposition record. See
[ADR-0003](docs/adr/ADR-0003-header-first-inspection.md).

## Browser laboratory (POC-005)

TypeScript enters here, and the contract crosses the language boundary:

```text
packages/contracts   Python        <- the single source of truth
      | bench schema export
packages/schemas     JSON Schema   <- language-neutral
      | tools/generate_ts_contracts.py
packages/contracts-ts TypeScript   <- generated, committed, drift-checked
```

**The agreement is proved, not assumed.** Both implementations of the
canonicalisation and digest rules verify against the *same* committed vector file
— 14 valid cases, 7 that must be rejected, 4 identity digests — covering exactly
where the two languages could diverge: non-ASCII values, NFC normalisation,
control-character escapes, key ordering, integer edges.

That is where two POC-001 decisions pay off. **No floats in identity documents**
(JavaScript has one number type) and **ASCII-only object keys** (Python sorts by
code point, JS by UTF-16 code unit) exist precisely so a digest computed in a
browser matches one computed by the runner. Removing `.sort()` from the TypeScript
serialiser fails 2 of 53 tests immediately.

```powershell
npm install
npm run build --workspace ipw-browser-lab
python tools/serve_browser_lab.py     # must be localhost: crypto.subtle needs a secure context
```

The lab probes capability (no user-agent parsing — benchmark plan §9), runs every
operation in a Worker with `OffscreenCanvas`, measures decode/operation/encode
separately, and **evidences** responsiveness rather than claiming it: it counts
frames painted while working, which would collapse toward zero on a blocked main
thread.

Browser output is always labelled a preview. Canvas resampling is
implementation-defined and differs between browsers and GPU drivers, so compare
timings and dimensions with the server baseline — not hashes. See
[`apps/browser-lab/README.md`](apps/browser-lab/README.md).

**No bundler.** `tsc` plus an import map. The entire Node dependency surface is
`typescript` and `@types/node`, neither of which ships — because every dependency
is a licence-register entry.

## Standard processing (POC-004)

Ten non-generative operations — bicubic and Lanczos resize, crop, rotate, flip,
brightness/contrast/saturation/exposure, white balance, unsharp mask, median
denoise, controlled JPEG/PNG output — behind one processor with two interchangeable
engines, so a Pillow-versus-libvips comparison measures the *engines* rather than
differences in plumbing.

| Engine | 64x64 Lanczos resize | Peak memory |
| --- | --- | --- |
| Pillow 12.3.0 | 280 B | 1.43 MB |
| libvips 8.18.5 | 2435 B | **0.08 MB** |

libvips uses ~17x less memory even at a trivial size — the streaming property
POC-012's tiling and the 100 MB professional path depend on.

Golden outputs are compared by **exact SHA-256** (D-046): 18 operations x 2
engines, versions pinned, with a documented regenerate-and-review procedure. A
tolerance would survive the very regression this benchmark exists to catch.

`libvips` is LGPL-2.1 and approved for server-side use with recorded notices. **A
native desktop or mobile application would trigger a mandatory licence re-review**
(D-047, O-012) — Pillow remains the approved fallback for every standard operation
so that condition stays survivable. See
[ADR-0004](docs/adr/ADR-0004-imaging-libraries-and-lgpl.md).

On this machine libvips needs a one-off install:

```powershell
python tools/install_libvips.py     # pinned version, SHA-256 verified before extraction
```

Hosts without it still run the whole suite: the engine reports
`PROCESSOR.UNAVAILABLE` and the run records it, which is how a benchmark should
behave when a candidate cannot execute somewhere.

## Evaluation corpus

`data/corpus/` is where your real images go. Nothing there is committed — images
live in protected storage and Git holds only the manifest, ids and hashes, which
is how the production asset model works (`PRODUCT_REQUIREMENTS.md` §8).

```powershell
python tools/draft_corpus_manifest.py     # drafts from headers; never decodes
bench validate-manifest data/corpus/corpus.manifest.json
```

The draft leaves the four rights questions unanswered on purpose, and validation
refuses the manifest until they are answered, naming the exact field. A tool must
not assert permission nobody granted. See
[`data/corpus/README.md`](data/corpus/README.md).

## Licence and rights gates (POC-002)

Gates bind to **what a run is for**, not to whether a model was downloaded
(D-038). Three gates run independently:

| Gate | Applies to | Blocks |
| --- | --- | --- |
| **B — supply chain** (D-039) | *every* purpose, including local research | unrecorded source, unpinned version, unrecorded weight hash, enabled inference-time network |
| **A — commercial** (D-038) | `public_demo`, `staging`, `production` only | anything not `approved` |
| **Rights** | purpose-dependent | assets that forbid benchmark use, public display, or carry sensitive content |

| Disposition | local_research | internal_benchmark | public_demo / staging / production |
| --- | :---: | :---: | :---: |
| `approved` | yes | yes | yes |
| `review_required` | yes | yes, marked | no |
| `non_commercial` | yes | yes, reference-only | no |
| `unknown` | yes | yes, marked | no |
| `blocked` | no | no | no |

Two things make this safe rather than merely permissive:

- **Dependency inheritance.** A component is never more permissive than the least
  permissive component it executes. A permissively licensed wrapper does not
  launder a restrictive weight — `rembg`'s MIT wrapper still resolves to `unknown`
  because U2-Net's weights are unreviewed.
- **Purpose and disposition are part of the `run_id`.** A reference-only research
  result cannot be relabelled later as a production recommendation: changing
  either field changes the digest, so the two are visibly different runs.

Current register state: **44 components** — 17 resolve to `approved`, 4 to
`review_required`, 7 to `non_commercial` and 16 to `unknown`; 13 are still blocked
by Gate B. **Seven** advertised AI operations have **no approved fallback**
(D-040) — reported in every generated report rather than hidden.

Real-ESRGAN and SwinIR both clear Gate B and both fail Gate A, which demonstrates
two things at once. The gates are genuinely independent: weight digests are
recorded, so research runs proceed, while every commercial purpose is refused.
And the gap did not close by adding a second model — see POC-007 below for why
that is the more important finding.

## AI adapter and the Real-ESRGAN baseline (POC-006)

The first model behind the processor contract, at native x2 and x4.

```powershell
python tools/install_model_weights.py     # pinned by release tag, SHA-256 verified
bench ai-baseline --manifest data/manifests/example.manifest.json --out data/reports/poc006
```

Measured on a 64x64 synthetic gradient, CPU-only, 4 threads:

| | Real-ESRGAN x4 | Lanczos resize x4 |
| --- | ---: | ---: |
| output | 256x256, 83,125 B | 256x256, 2,630 B |
| total | 4,598 ms | 19 ms |
| **relative cost** | **~250x slower** | — |
| cold model load | ~4.3 s | n/a |
| per-call memory | 3.1 MB | 0.2 MB |

**That 250x is the evidence behind D-019's cloud-GPU routing**, on the smallest
input the product will ever handle. A 24-megapixel professional image is roughly
6,000x more pixels.

**No quality verdict appears anywhere.** Objective metrics rank; they do not judge
(D-011). Which output looks better is POC-008's blinded review, and a number here
would pre-empt a decision the product deliberately reserved for humans.

### Three things this adapter does that a wrapper would not

**It refuses to install the official package.** `realesrgan` on PyPI hard-depends
on `gfpgan` — a face-restoration model — and POC-006 states that face restoration
is never silently invoked. A dependency that can reconstruct a face is not made
safe by our choosing not to call it, so the generator architecture is
reimplemented instead (~120 lines) and no face model exists in the environment at
all. Correctness is not asserted: `load_state_dict(strict=True)` means a wrong
architecture cannot load the official checkpoint.

**It verifies the weight digest before loading, not after.** A `.pth` is a Python
pickle, and unrestricted unpickling executes arbitrary code from the file. The
digest is checked first, then `torch.load(weights_only=True)` restricts
reconstruction to tensors. A tampered file never reaches the unpickler.

**It refuses a scale it was not trained for.** The x4 weights decline an x2
request rather than resizing afterwards and calling it x2. Post-resizing an x4
result is not equivalent to a native x2 model and must never be reported as one.

### Licence standing

Real-ESRGAN is permitted for `local_research` and `internal_benchmark` **only**,
with every artifact marked. The repository's BSD-3-Clause `LICENSE` covers source
code; no weight licence is stated anywhere, and the published weights derive from
DIV2K, which ETH Zurich publishes "for academic research purpose only". Whether
trained weights inherit training-data restrictions is legally unsettled — a
product-owner and counsel question (**O-013**), not an engineering one.

`torch` is pinned to the **CPU** build deliberately. On Linux the default PyPI
wheel bundles NVIDIA CUDA runtime libraries under non-permissive terms that have
not been reviewed (**O-014**), so the container installs from the CPU index
explicitly. That line is a licence control, not a size optimisation.

### Container

[`infra/docker/inference.Dockerfile`](infra/docker/inference.Dockerfile) pins the
runtime and the thread count. **It has never been built** — Docker is not
installed on this machine — and is marked unexercised rather than presented as
done. Weights are mounted, never baked into a layer: no stated licence means no
right to redistribute.

See [ADR-0005](docs/adr/ADR-0005-ai-adapter-foundation.md), which also records two
defects POC-006 exposed in earlier work: the conformance suite had never exercised
a successful processing path, and the reported peak-memory figure was a
process-lifetime high-water mark that made a Lanczos resize look like it cost
410 MB.

## SwinIR comparator, and where the licence problem lives (POC-007)

A second model candidate, across three restoration tasks.

```powershell
python tools/install_model_weights.py --model swinir
bench compare-models --manifest data/manifests/example.manifest.json --out data/reports/poc007 --operation super_resolution --scale 4
bench compare-models --manifest data/manifests/example.manifest.json --out data/reports/poc007 --operation ai_denoise
```

### The finding that matters most

Adding a second model **did not** solve the licence problem, and the reason is
worth reading carefully.

| | Real-ESRGAN | SwinIR |
| --- | --- | --- |
| Code licence | BSD-3-Clause | **Apache-2.0**, with a patent grant |
| Code disposition | review_required | **approved** |
| Weight licence stated | none | none |
| Training data | DF2K + OST | DIV2K, DF2K, DFO, DFWB |
| **Composite** | **unknown** | **unknown** |
| Commercial use | blocked | blocked |

SwinIR's code chain is genuinely clean — Apache-2.0 over MIT (Microsoft's
Swin-Transformer) over MIT (KAIR), all three read directly. It changes nothing,
because **every** published SwinIR checkpoint is trained on a DIV2K-derived set,
and DIV2K is published "for academic research purpose only".

**The restriction is upstream of the model.** It belongs to the dataset the
research community trains on, not to either project's licensing. Swapping models
is not a route around it — which makes D-040's approved-fallback rule
load-bearing rather than precautionary. A test asserts it:
`test_adding_a_second_model_did_not_close_any_gap`.

### Measured

Super-resolution ×4, 64×64 asset, CPU, 4 threads:

| candidate | output | total | commercial |
| --- | --- | ---: | --- |
| deterministic-lanczos | 256×256, 2,630 B | 56 ms | eligible |
| real-esrgan | 256×256, 83,125 B | 1,948 ms | **not eligible** |
| swinir | 256×256, 87,651 B | 2,216 ms | **not eligible** |

AI denoise against the median filter customers get today: SwinIR is **67× slower**
(2,418 ms vs 36 ms).

### No winner is computed, and that is structural

POC-007 requires that no winner be declared from objective metrics alone. Rather
than declaring one carefully, there is no code that could: the comparison document
carries a `winner` field that is always `null` with a note saying where the answer
comes from, and a test asserts no ranking field exists anywhere in it.

The first run justified the rule immediately — **the two metrics disagree**:

| | PSNR (dB) | SSIM |
| --- | ---: | ---: |
| Real-ESRGAN | **21.59** | 0.6539 |
| SwinIR | 20.95 | **0.6776** |

Any numeric verdict would have been a choice of metric dressed as a finding. The
quality question belongs to POC-008's blinded review.

Metrics are also measured against the *deterministic control*, never a ground
truth — for real-world super-resolution none exists, since a high-resolution
original would make upscaling pointless. A high score means "close to a Lanczos
resize", which for a generative model is closer to a criticism than a compliment.

### Vendored architecture

SwinIR's 867-line Swin Transformer is **vendored verbatim** rather than
reimplemented (D-056). A rewrite could load the published checkpoint with
`strict=True` and still be subtly wrong — a mismatched window-partition order has
the right shapes and the wrong output, and nothing would notice. An attributed
copy cannot fail that way.

[`vendor/network_swinir.py`](packages/processors/src/ipw/processors/ai_adapters/vendor/network_swinir.py)
names its upstream, commit and digest, states its two modifications, and is
excluded from ruff, mypy and coverage — reformatting a copied file destroys the
diff against upstream that makes it verifiable. It is **not** excluded from the
import guards.

### Two contract gaps this exposed

**AI denoise could not be expressed.** Section 10 of the requirements lists
"advanced denoise" as an AI capability, but the only `denoise` kind is in the
STANDARD family — correctly, since a median filter must never route to a model.
`ai_denoise` and `jpeg_artifact_repair` are now their own AI operations (D-057).

**"Advertised" was derived from an enum.** `ADVERTISED_OPERATIONS` used to mean
"everything not INSPECTION", so adding an operation kind for a benchmark would
have advertised it to customers. It is now written out explicitly, and
`jpeg_artifact_repair` is expressible but deliberately unadvertised pending a
product decision (**O-015**).

See [ADR-0006](docs/adr/ADR-0006-swinir-comparator.md), which also records two
POC-006 defects found here: a pinned byte count that was wrong *and* never
checked, and Gate B controls existing in two copies that could drift.

## Blinded quality review (POC-008)

POC-007 refused to declare a winner from PSNR and SSIM and pointed here. This is
where the quality question is actually answered, which makes the review workflow a
measuring instrument — and an instrument needs the same care about bias that a
numerical one needs about calibration.

```powershell
bench review-build --comparison data/reports/poc007-sr --out review/package --sealed-key review-sealed/key.json --seed my-seed
# reviewers score review/package/REVIEW.md into scores.json
bench review-aggregate --package review/package/review-package.json --scores scores.json --out review --sealed-key review-sealed/key.json
```

### Blinding is not filenames

Taking the acceptance criterion literally would have produced a workflow that
fails in practice. Every channel that correlates with the producer is closed:

| channel | closed by |
| --- | --- |
| filename | opaque `item-NN` labels |
| directory layout | one flat directory, no per-model folders |
| ordering | keyed shuffle, seed sealed |
| **file size** | **re-encode, then pad to a common size** |
| image metadata | re-encode, ancillary chunks dropped |

**File size would have defeated the whole exercise.** The three POC-007
candidates wrote 2,630, 83,125 and 87,651 bytes — a file browser with a size
column identifies the deterministic baseline before the reviewer opens anything.
After blinding all three are 87,663 bytes. A test asserts *both* that the blinded
files match and that the sources did not, so it can never pass for the wrong
reason.

What blinding cannot close is stated rather than hidden: the images genuinely
differ, so a reviewer may guess which item is the soft deterministic control. What
they cannot do is tell Real-ESRGAN from SwinIR, or map any item to a run.

### Two identifiers, because one cannot do both jobs

Blinding and traceability pull in opposite directions. The reviewer sees
`item-07`, which carries nothing; a **sealed key** holds run id, result id,
processor version, weight digest and licence standing.

Deriving the label from `sha256(run_id)` looks opaque and is trivially reversible
with three candidates. The ordering is a *keyed* shuffle whose seed lives in the
sealed half. `random` is banned repo-wide for reproducibility and is not needed —
sorting by `sha256(seed ‖ key)` is a permutation, reproducible from the seed and
unguessable without it.

`review-build` **refuses to write the sealed key inside the package directory**,
checked on the argument before anything is read or written.

### Critical failures override attractive scores

Eight conditions from benchmark plan §8.3 form a separate, dominant channel. One
reviewer raising one failure fails the item — a second opinion that the image
looks lovely does not make a changed digit correct.

The first run demonstrates it:

| item | mean | failed | third review |
| --- | ---: | --- | --- |
| item-01 | 3.38 | no | no |
| **item-02** | **4.62** | **YES** | yes |
| item-03 | 3.25 | no | yes |

**The highest-scoring item is the failed one.** Under any averaging scheme it
would have won. Disagreements are flagged for a third review rather than averaged
— item-03 is a 2-versus-4 split, and averaging it to 3 would manufacture a
consensus nobody holds.

Verdicts store score sums and counts, never a mean; the mean is derived for
display. A committed artifact holding a float invites drift unrelated to what is
being measured.

**Licence standing travels with the attribution**, so a research-only model cannot
be laundered into a recommendation by scoring well.

### What POC-008 does not do

It does not *conduct* the review. There are no reviewers yet and no corpus of real
images — the demonstration uses two synthetic reviewers over synthetic fixtures.
The workflow is built and exercised end to end; the actual judgement on
Real-ESRGAN and SwinIR needs people and real material.

See [ADR-0007](docs/adr/ADR-0007-blinded-review.md).

## Batch durability (POC-013)

Taken out of order: POC-009 to POC-011 all need real portraits and complex
boundaries, and the corpus has not arrived. POC-013 needs none — it is about
count, failure and interruption, which synthetic fixtures reproduce faithfully —
and it is a prerequisite for any real corpus run.

```powershell
bench batch --manifest data/manifests/example.manifest.json --out run/
bench batch-status --journal run/run-journal.jsonl     # any process, not just the one that ran it
bench batch --manifest ... --out run/ --resume         # continue after an interruption
```

### The journal is the run

Everything before this held a whole run in a local variable and returned it at the
end — fine for two fixtures, wrong for fifty images: kill the process at item 47
and every completed result is gone. "Closing the client does not stop cloud work"
is really a statement about *where state lives*, and the answer cannot be "in the
caller's memory".

Each result is appended to a JSON Lines journal the moment it completes, flushed
and **fsynced** before the next item starts. Flushing hands bytes to the operating
system; fsync asks it to commit them — the difference only shows up when the
machine loses power rather than the process losing its terminal, which is exactly
the case a durability claim is about.

### Crash-safety is about the half-written line

A process killed mid-write leaves a truncated final record. The reader **discards
it and carries on**: losing one item is recoverable by reprocessing it, whereas
refusing to parse the file would lose the forty-nine before it too. The count of
discarded records is reported rather than swallowed. Tested by truncating a real
journal at 20%, 50%, 80% and 95% — truncation does not politely happen at line
boundaries.

### A skip is not a settled outcome

This came out of a failing test and changed the design. A declared asset with no
file is recorded `SKIPPED`, not `FAILED`, because the processor never ran. An
asset can be absent because it is **in external storage and not fetched yet** — so
treating that skip as final would strand it forever on a condition already fixed.

| state | meaning | resume |
| --- | --- | --- |
| `SUCCEEDED` | ran, worked | keep |
| `FAILED` | ran, could not finish | keep — that's `retry_failed`'s job |
| `SKIPPED` | never ran | **re-attempt** |
| `CANCELLED` | never ran | **re-attempt** |

The distinction is *was it attempted*, not *did it work*. A test proves it: an
asset missing on the first pass and present on the second is processed by the
resume.

### What the criteria rest on

Batches of 1, 10 and 50; corrupt inputs and missing files interleaved; retry
reusing the same `result_id` so the ledger cannot gain a duplicate; no temporary
artifact surviving a 50-item run. And **results map to the correct originals** —
each result's recorded input digest is checked against what the manifest declared
for that asset id, so a batch that silently transposed two items fails even though
it produced the right number of results.

**What it does not prove:** that work continues on a server after a client
disconnects, because there is no server. It proves the state model that makes that
possible — run state on disk, resumable by another process, inspectable without
re-running.

See [ADR-0008](docs/adr/ADR-0008-batch-durability.md).

## Working on the next task

Read `AGENTS.md` and the relevant `docs/`, then implement exactly one task from
[`docs/POC_TASKS.md`](docs/POC_TASKS.md). Do not combine tasks.

Adding a third-party runtime dependency requires an approved task and a licence
disposition record with evidence a reviewer actually read —
[`tests/test_scope_and_artifacts.py`](tests/test_scope_and_artifacts.py) fails if
the register changes without one.

**Name things as production would name them (D-048).** Identifiers reach run
digests, the licence register and eventually production configuration; renaming one
after it has been recorded makes every prior run incomparable. Task and lifecycle
stage fields stay as provenance —
[`tests/test_production_naming.py`](tests/test_production_naming.py) enforces the
distinction.

Architecture decisions live in [`docs/adr/`](docs/adr/).
