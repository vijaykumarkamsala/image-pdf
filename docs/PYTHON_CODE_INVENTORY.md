# Python code inventory

Prepared 28 August 2026 at commit `2cd007a` (tag `handoff-audit-2026-08-28`).
Nothing was changed to produce this document.

**105 first-party Python modules** (29,741 lines), plus 53 test modules
(17,981 lines) and `conftest.py`.
Vendored upstream code is marked and counted separately.

## How the machine-derived columns were produced

| Column | Method |
|---|---|
| Lines | `wc -l` on the tracked file |
| Cover | The per-file figure from the full run recorded below |
| Reach | Import graph walked with `ast` from each entry point, first-party modules only |
| Deps | Top-level `import X` / `from X import` for torch, numpy, PIL, pyvips, pg8000, pydantic |
| Callers | Count of other tracked `.py` files importing the module (non-test / test) |

**Reach** has three values:

- **app** — reachable from `tools/serve_workspace.py` → `ipw.workspace_api.http`,
  the module the running application actually loads.
- **bench** — reachable from `ipw.benchmark_runner.cli` (the `bench` console
  script) but *not* from the application.
- **none** — reachable from neither entry point. Either test-support, a
  namespace `__init__`, or built-but-unwired.

Test run these figures come from:

```
$ .venv/Scripts/python.exe -m pytest -q
1703 passed, 1 skipped
TOTAL 10136 stmts, 824 miss, 2800 branch, 352 partial, 90%
Required test coverage of 90% reached. Total coverage: 90.01%
exit 0
```

`*/ai_adapters/vendor/*` is excluded from coverage by `pyproject.toml:204`
(decision D-056: it is upstream code, and measuring our coverage of it produces
a number that means nothing). Those files show `—`.

---

# Part 1 — Application Python

60 of 105 modules are reachable from the running application: 59 first-party
modules plus the vendored SwinIR network. Every one of them executes **on the server, in the Python process started by
`tools/serve_workspace.py`**. Nothing in this repository runs Python in the
browser, and nothing runs on a GPU unless a CUDA device is present *and* an AI
operation is invoked.

## 1.1 Entry point and HTTP layer

| Path | Lines | Cover | Reach | Deps | Callers |
|---|---|---|---|---|---|
| `tools/serve_workspace.py` | 57 | — | entry | — | 0 / 0 |
| `services/workspace-api/…/http.py` | 659 | 85% | app | — | 1 / 6 |
| `services/workspace-api/…/server.py` | 1984 | 87% | app | PIL, pydantic | 3 / 4 |
| `services/workspace-api/…/config.py` | 221 | 99% | app | — | 2 / 2 |
| `services/workspace-api/…/catalogue.py` | 412 | 92% | app | — | 2 / 1 |
| `services/workspace-api/…/storage.py` | 423 | 95% | app | — | 2 / 1 |
| `services/workspace-api/…/licence_guard.py` | 124 | 100% | app | — | 1 / 1 |
| `services/workspace-api/…/database.py` | 353 | 96% | app | pg8000 | 1 / 1 |

**`serve_workspace.py`** is the only way the product is started. It puts four
`src` directories on `sys.path`, imports `serve`, and opens a browser. It does
**not** add `packages/pdf/src`, `packages/vector/src` or `packages/metrics/src`
— those resolve because the packages are pip-installed editable into `.venv`.
A checkout without that install starts and then fails on the first PDF request.

**`http.py`** is the HTTP surface: routing, static file serving, request size
limits, the startup banner, `prepare_database()` and `enforce_licences()`. It is
the real composition root. Anyone reading `server.py` first — as the file name
invites — will miss startup behaviour entirely.

**`server.py`** is `WorkspaceService`: 1,984 lines and every operation the
product performs. Reads and writes bytes through `storage.py`; no direct
filesystem access. CPU-bound, synchronous, single-threaded per request.
**The largest single file in the repository and the least separable.**

**`database.py`** imports `pg8000.dbapi` lazily at line 350, so a machine with
no database still starts. It runs migrations from
`services/workspace-api/migrations/`. It is reachable and it executes at
startup — but nothing downstream reads or writes a row.

**`licence_guard.py`** reads `data/licences/register.json` and refuses to start
in production if any component that would execute is not `approved`. It works.
Given the register's current contents it would block a production start today.

## 1.2 Processors — standard (no model, no numpy)

| Path | Lines | Cover | Reach | Deps | Callers |
|---|---|---|---|---|---|
| `…/processors/standard/processor.py` | 421 | 91% | app | — | 1 / 0 |
| `…/processors/standard/engine.py` | 174 | 100% | app | — | 4 / 1 |
| `…/processors/standard/pillow_engine.py` | 409 | 77% | app | PIL | 2 / 1 |
| `…/processors/standard/vips_engine.py` | 408 | 67% | app | PIL | 2 / 0 |
| `…/processors/standard/vips_runtime.py` | 85 | 77% | app | pyvips | 2 / 0 |
| `…/processors/standard/upscale.py` | 230 | 97% | app | PIL | 2 / 1 |
| `…/processors/standard/document.py` | 275 | 95% | app | PIL | 2 / 1 |
| `…/processors/standard/perspective.py` | 313 | 92% | app | PIL | 2 / 1 |
| `…/processors/standard/measure.py` | 152 | 88% | app | — | 3 / 0 |
| `…/processors/standard/__init__.py` | 38 | 100% | app | — | 3 / 7 |

`engine.py` declares the engine Protocol; `pillow_engine.py` and
`vips_engine.py` implement it; `processor.py` picks between them and enforces the
contract. **This directory imports no numpy** — enforced by
`tests/test_scope_and_artifacts.py`, deliberately, so it stays the deterministic
control the benchmark measures against.

`upscale.py`, `document.py` and `perspective.py` are the three algorithms that
carry measured results: back-projection enlargement (+3.78 dB on text over a
plain resize), flat-field illumination correction (colour cast 64 → 0,
unevenness 46% → 3%), and projective page flattening with Otsu thresholding and
an 8×8 Gaussian elimination. All pure Pillow, all CPU, all deterministic.

**`vips_engine.py` at 67% and `vips_runtime.py` at 77% are the two lowest
figures in the application.** libvips is absent from the CI runner, so those
paths are exercised only on a developer machine that has it.

## 1.3 Processors — AI adapters

| Path | Lines | Cover | Reach | Deps | Callers |
|---|---|---|---|---|---|
| `…/ai_adapters/real_esrgan.py` | 484 | 95% | app | torch, PIL | 2 / 0 |
| `…/ai_adapters/swinir.py` | 636 | 96% | app | torch, PIL | 2 / 1 |
| `…/ai_adapters/rrdbnet.py` | 163 | 94% | app | torch | 2 / 1 |
| `…/ai_adapters/common.py` | 181 | 93% | app | torch, numpy, PIL | 4 / 3 |
| `…/ai_adapters/accelerator.py` | 109 | 72% | app | torch | 3 / 0 |
| `…/ai_adapters/vendor/network_swinir.py` | 1106 | — | app | torch | 1 / 1 |
| `…/ai_adapters/__init__.py` | 58 | 100% | app | — | 2 / 3 |
| `…/processors/tiling.py` | 255 | 100% | app | — | 2 / 1 |
| `…/processors/base.py` | 219 | 88% | app | — | 4 / 4 |

**This is the only GPU-capable code in the repository.** `accelerator.py` selects
CUDA when available and falls back to CPU; its 72% is the lowest in the
application because the CUDA branches never run on the machines that test it.
Measured on CPU: Real-ESRGAN ×4 on 450×250 took 77 s; SwinIR JPEG repair ~145 s.

`rrdbnet.py` is a first-party reimplementation of the Real-ESRGAN generator, so
`basicsr` is not imported at runtime. `network_swinir.py` **is** vendored
upstream (1,106 lines), attributed with its commit and digest, excluded from
ruff, mypy and coverage, and asserted by `tests/test_scope_and_artifacts.py` to
import nothing forbidden.

**Weights and licence — the blocking issue.** These adapters run only when
weight files are present, and the weight files are not in the repository (they
are `.gitignore`d as `*.pth`). Their register entries:

| Component | Kind | Disposition | Licence |
|---|---|---|---|
| `real-esrgan-weights-x4plus` | weights | **unknown** | — |
| `real-esrgan-weights-x2plus` | weights | **unknown** | — |
| `swinir-weights-realsr-m-x4-gan` | weights | **unknown** | — |
| `swinir-weights-realsr-m-x2-gan` | weights | **unknown** | — |
| `swinir-weights-colordn-noise15` | weights | **unknown** | — |
| `swinir-weights-colorcar-jpeg10` | weights | **unknown** | — |
| `real-esrgan-code` | code | review_required | BSD-3-Clause |
| `swinir-code` | code | approved | Apache-2.0 |
| `basicsr` | dependency | **review_required** | — |
| `div2k-dataset` | dataset | **non_commercial** | DIV2K-Academic-Research-Only |

Of 52 registered components, **8 weight sets are `unknown` and 2 are
`non_commercial`**; 9 further components are `review_required`. No AI weight in
this product is cleared for commercial use.

**Five AI operations in the catalogue have no adapter file at all**:
`face_restore`, `damage_repair`, `colourise`, `background_remove`,
`background_replace`. Installing weights would not make them work.

## 1.4 Inspection

| Path | Lines | Cover | Reach | Deps | Callers |
|---|---|---|---|---|---|
| `…/inspection/inspector.py` | 455 | 100% | app | — | 1 / 2 |
| `…/inspection/headers.py` | 362 | 98% | app | — | 2 / 1 |
| `…/inspection/__init__.py` | 30 | 100% | app | — | 7 / 2 |

Identifies a file from its bytes rather than its extension and decides how it
should be handled. `inspector.py` is one of only three application modules at
100%. Reads bytes, writes nothing, CPU-trivial.

## 1.5 PDF package

| Path | Lines | Cover | Reach | Deps | Callers |
|---|---|---|---|---|---|
| `…/pdf/reader.py` | 774 | 93% | app | — | 8 / 11 |
| `…/pdf/redact.py` | 716 | 88% | app | PIL | 1 / 5 |
| `…/pdf/edit.py` | 633 | 90% | app | PIL | 5 / 5 |
| `…/pdf/content.py` | 551 | 88% | app | — | 5 / 4 |
| `…/pdf/document.py` | 461 | 99% | app | — | 4 / 10 |
| `…/pdf/ocr.py` | 357 | 83% | app | PIL | 1 / 3 |
| `…/pdf/textlayer.py` | 331 | 90% | app | — | 2 / 2 |
| `…/pdf/compress.py` | 345 | 86% | app | PIL | 1 / 1 |
| `…/pdf/objects.py` | 268 | 89% | app | — | 10 / 11 |
| `…/pdf/images.py` | 254 | 84% | app | PIL | 2 / 0 |
| `…/pdf/numbering.py` | 213 | 88% | app | — | 1 / 1 |
| `…/pdf/__init__.py` | 42 | 100% | app | — | 1 / 2 |

4,945 lines with **no third-party PDF dependency** — xref tables, object
streams, content streams and Flate decoding are all first-party. CPU only, byte
in / byte out.

`redact.py` is the most safety-critical module here: it verifies its own output
bytes after writing. That check exists because a real leak was found — the
original text survived as an orphaned Flate object that rendered clean and
extracted clean but was recoverable with `qpdf --qdf`.

`ocr.py` at 83% is the lowest: it shells out to Tesseract, which is deliberately
not installed on CI, so it is excluded from the CI coverage configuration
(`.coveragerc-ci`) while remaining measured locally.

## 1.6 Vector package

| Path | Lines | Cover | Reach | Deps | Callers |
|---|---|---|---|---|---|
| `…/vector/simplify.py` | 453 | 82% | app | — | 3 / 1 |
| `…/vector/vectorise.py` | 275 | 95% | app | PIL | 2 / 1 |
| `…/vector/trace.py` | 221 | 91% | app | numpy | 2 / 1 |
| `…/vector/palette.py` | 173 | 93% | app | numpy, PIL | 2 / 0 |
| `…/vector/render.py` | 129 | 95% | app | — | 2 / 1 |
| `…/vector/__init__.py` | 31 | 100% | app | — | 1 / 1 |

Raster → SVG. CPU only. `simplify.py` at 82% is the weakest; it holds the curve
fitting, which has the most branches and the fewest direct tests.

## 1.7 Contracts used by the application

| Path | Lines | Cover | Reach | Deps | Callers |
|---|---|---|---|---|---|
| `…/contracts/operation.py` | 464 | 95% | app | pydantic | 25 / 14 |
| `…/contracts/runtime.py` | 343 | 96% | app | — | 19 / 11 |
| `…/contracts/licence.py` | 339 | 100% | app | pydantic | 13 / 5 |
| `…/contracts/safety.py` | 274 | 97% | app | pydantic | 10 / 3 |
| `…/contracts/processor.py` | 255 | 88% | app | pydantic | 14 / 4 |
| `…/contracts/failure.py` | 173 | 100% | app | pydantic | 15 / 6 |
| `…/contracts/measurement.py` | 168 | 98% | app | pydantic | 9 / 1 |
| `…/contracts/asset.py` | 162 | 96% | app | pydantic | 17 / 4 |
| `…/contracts/common.py` | 101 | 100% | app | pydantic | 18 / 1 |
| `…/contracts/version.py` | 64 | 100% | app | — | 14 / 2 |
| `…/contracts/manifest.py` | 30 | 100% | app | pydantic | 9 / 5 |

Pydantic models, no I/O, negligible CPU. The most-imported code in the
repository — `operation.py` has 25 non-test callers. Six of the eleven are at
100%.

## 1.8 Two benchmark modules the application imports

| Path | Lines | Cover | Reach | Deps | Callers |
|---|---|---|---|---|---|
| `…/benchmark_runner/licence_register.py` | 478 | 98% | **app** | pydantic | 7 / 7 |
| `…/benchmark_runner/workspace.py` | 79 | 90% | **app** | — | 7 / 1 |

**The application imports 2 of the 19 `benchmark_runner` modules.** They live
under a service the product otherwise does not use, which means the production
container must ship the benchmark package to start. Worth flagging: this is the
only structural coupling between the product and the POC harness.

---

# Part 2 — POC and benchmark Python

**Not product code.** This is the harness that was used to choose models and
record licence evidence. It is reachable from the `bench` console script
(`services/benchmark-runner/pyproject.toml:18`) and, apart from the two modules
above, not from the application.

| Path | Lines | Cover | Reach | Deps | Callers |
|---|---|---|---|---|---|
| `…/benchmark_runner/cli.py` | 1130 | 71% | bench | — | 1 / 3 |
| `…/benchmark_runner/validation.py` | 575 | 93% | bench | pydantic | 6 / 3 |
| `…/benchmark_runner/review.py` | 621 | 98% | bench | PIL | 1 / 1 |
| `…/benchmark_runner/model_comparison.py` | 498 | 93% | bench | PIL | 1 / 2 |
| `…/benchmark_runner/orchestrator.py` | 400 | 97% | bench | — | 5 / 3 |
| `…/benchmark_runner/comparison.py` | 382 | **54%** | bench | — | 1 / 0 |
| `…/benchmark_runner/report.py` | 332 | 90% | bench | — | 2 / 1 |
| `…/benchmark_runner/batch.py` | 321 | 87% | bench | — | 1 / 1 |
| `…/benchmark_runner/schema_export.py` | 124 | 81% | bench | pydantic | 1 / 1 |
| `…/benchmark_runner/ids.py` | 113 | 100% | bench | — | 8 / 1 |
| `…/benchmark_runner/canonical.py` | 103 | 94% | bench | — | 4 / 4 |
| `…/benchmark_runner/fixtures.py` | 101 | 89% | bench | — | 2 / 1 |
| `…/benchmark_runner/policy.py` | 94 | 98% | bench | pydantic | 8 / 8 |
| `…/benchmark_runner/environment.py` | 70 | 100% | bench | — | 5 / 1 |
| `…/benchmark_runner/__init__.py` | 37 | 100% | none | — | 0 / 0 |
| `…/benchmark_runner/__main__.py` | 8 | — | none | — | 0 / 0 |

Contracts used only by the harness:

| Path | Lines | Cover | Reach |
|---|---|---|---|
| `…/contracts/review.py` | 321 | 92% | bench |
| `…/contracts/run.py` | 147 | 100% | bench |
| `…/contracts/report.py` | 124 | 100% | bench |
| `…/contracts/result.py` | 107 | 98% | bench |
| `…/contracts/environment.py` | 50 | 100% | bench |
| `…/metrics/reference.py` | 183 | 95% | bench (numpy) |
| `…/metrics/__init__.py` | 28 | 100% | bench |

`metrics/reference.py` holds PSNR and SSIM. It is the numeric basis for every
quality claim in these documents, and the application never imports it — the
product measures nothing about its own output at runtime.

`comparison.py` at **54%** is the least-tested module in the repository.

---

# Part 3 — Built but not wired

Reachable from **neither** entry point, and not test-support. These are complete,
heavily tested subsystems that nothing in the running product calls.

| Path | Lines | Cover | Tests | Callers |
|---|---|---|---|---|
| `…/workspace_api/jobs.py` | 294 | **100%** | `test_jobs.py` (36) | 2 / 3 |
| `…/workspace_api/pool.py` | 203 | 97% | `test_pool.py` (15) | 0 / 1 |
| `…/workspace_api/worker.py` | 187 | 99% | `test_worker.py` (20) | 0 / 1 |
| `…/workspace_api/handlers.py` | 136 | **100%** | `test_handlers.py` (15) | 0 / 1 |

**820 lines, 86 tests, ~99% covered, zero production callers.** `jobs.py` is
imported only by `worker.py` and `handlers.py`; those two and `pool.py` are
imported only by their own tests. No route enqueues a job, the Dockerfile has no
worker entry point, and nothing borrows a pooled connection.

`database.py` (§1.1) is the near-miss: it *is* imported by `http.py` and its
migrations *do* run, but no feature reads or writes a row. `test_pool.py` and
`pool.py` were untracked working-tree files at the start of this audit and are
included in the preserved commit.

---

# Part 4 — Test support

Not shipped, not reachable from either entry point, but required by the suite.

| Path | Lines | Cover | Used by |
|---|---|---|---|
| `…/processors/fake/fake_processor.py` | 322 | 90% | `test_processor_contract.py` |
| `…/benchmark_runner/conformance.py` | 294 | 96% | `test_processor_contract.py`, `test_real_esrgan.py` |
| `…/processors/fake/__init__.py` | 7 | 100% | as above |
| `conftest.py` | 169 | — | whole suite |

`conformance.py` is the shared Protocol-conformance suite every processor is run
against. `fake_processor.py` is the reference implementation used to prove the
suite itself catches violations. `fake-processor` is registered as `approved`
/ MIT in the licence register.

Namespace `__init__` files reachable from neither entry point because the
application imports submodules directly: `contracts/__init__.py` (187),
`processors/__init__.py` (30), `workspace_api/__init__.py` (20),
`ai_adapters/vendor/__init__.py` (21).

---

# Part 5 — Tools and scripts

Developer tooling. None is imported by anything; each is run by hand or by CI.

| Path | Lines | Purpose | Network |
|---|---|---|---|
| `tools/serve_workspace.py` | 57 | **Starts the product.** The entry point. | no |
| `tools/check.py` | 183 | Runs the 16 repository gates | no |
| `tools/serve_browser_lab.py` | 94 | Serves the measurement page (not the product) | no |
| `tools/install_model_weights.py` | 284 | Downloads AI weights | **yes** |
| `tools/install_libvips.py` | 160 | Downloads and unpacks libvips | **yes** |
| `tools/generate_ts_contracts.py` | 267 | Emits TypeScript types from the pydantic contracts | no |
| `tools/make_inspection_fixtures.py` | 373 | Builds inspection fixtures | no |
| `tools/make_fixtures.py` | 254 | Builds test fixtures | no |
| `tools/make_goldens.py` | 221 | Regenerates golden images | no |
| `tools/make_canonical_vectors.py` | 214 | Builds canonical vector fixtures | no |
| `tools/draft_corpus_manifest.py` | 168 | Drafts a corpus manifest | no |

The two network tools are the only first-party code that fetches anything.
`install_model_weights.py` is what an auditor should read before running
anything: it is the path by which uncleared weights arrive on a machine.

---

# Part 6 — Line counts

Counted from the tracked files, not estimated.

| Group | Modules | Lines |
|---|---|---|
| Application Python | 59 | 18,790 |
| POC / benchmark Python | 21 | 5,824 |
| Tools and scripts | 11 | 2,275 |
| Vendored upstream (SwinIR) | 1 | 1,106 |
| Built but not wired | 4 | 820 |
| Test support (excl. `conftest.py`) | 3 | 623 |
| Namespace `__init__` files | 6 | 303 |
| **First-party non-test total** | **105** | **29,741** |
| Test modules | 53 | 17,981 |
| `conftest.py` | 1 | 169 |

Application Python is 63% of the non-test first-party code. The four unwired
modules and the twenty-one benchmark modules together are 22% of it.

---

# Closing assessment

## Genuinely reusable

`packages/pdf` (4,945 lines, 83–99%) — a complete PDF read/write implementation
with no third-party PDF dependency, whose redaction path verifies its own output
bytes. `packages/contracts` — small, near-fully covered, the most-imported code
here, and the reason operations, failures and licences have one shape across the
repository. `packages/processors/standard` — three measured algorithms, pure
Pillow, deterministic, numpy-free by enforced design. `licence_guard.py` and
`licence_register.py` — the only reason the weights problem is visible rather
than latent.

## Experimental

All of `services/benchmark-runner` except `licence_register.py` and
`workspace.py`: a harness for choosing models, with `comparison.py` at 54% and
`cli.py` at 71%. `packages/metrics` — the measurement basis for the quality
claims, never used at runtime. The AI adapters are experimental commercially
rather than technically: the code is well covered, the weights cannot be
licensed.

## Needs redesign

`server.py` — 1,984 lines in one class, holding every operation; the largest and
least separable file here. The `http.py` / `server.py` split, where the file
named `server` is not the server and startup behaviour lives in the other one.
The application's import of two `benchmark_runner` modules, which drags the POC
harness into the production dependency set. `vips_engine.py` at 67% — a second
full engine implementation with the weakest coverage in the application.

## Unsafe or unknown

- **The weights cannot be shipped.** 8 weight components `unknown`, 2
  `non_commercial`, `basicsr` `review_required` and in the execution path.
- **Five catalogued AI operations have no code.**
- **820 lines of job/queue/worker/pool** at ~99% unit coverage with zero
  integration tests and zero production callers — well-tested code that has
  never run in situ is not the same as working code.
- **`tools/install_model_weights.py`** fetches from the network and is the route
  by which unlicensed weights reach a machine.
- **No authentication module exists** anywhere in these 105 files.
- **`serve_workspace.py` depends on an editable install** it does not perform
  and does not check; a fresh clone starts and then fails at the first PDF
  request.

## Questions for the next team

1. Should `licence_register.py` and `workspace.py` move out of
   `benchmark-runner` so the product stops depending on the POC harness?
2. Is the job/worker/pool layer wanted? It is 820 lines of ready, unreachable
   code — wire it or delete it, but it should not stay as it is.
3. Should `vips_engine.py` remain? Two engines double the surface and the
   libvips one is the least covered code in the application.
4. Which of the five unimplemented AI operations are actually in scope?
5. Is there a commercially clearable upscaling model? Every candidate in the
   register fails Gate A or Gate B.
