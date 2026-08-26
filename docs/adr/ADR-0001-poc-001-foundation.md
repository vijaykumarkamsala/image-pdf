# ADR-0001 — POC-001 repository and benchmark-contract foundation

**Status:** Accepted
**Date:** 24 August 2026
**Task:** POC-001 (`docs/POC_TASKS.md`)
**Approved by:** Product owner, before implementation

This record exists because `PRODUCT_DECISION_LOG.md` requires approved changes to
be recorded as new entries rather than by silently rewriting an approved document.
It captures the technical baseline for the whole POC and the deviations the
product owner approved.

---

## 1. Context

POC-001 builds the measuring instrument, not the thing being measured. Every task
from POC-002 to POC-015 produces results that must be comparable across models,
machines and dates. That comparability is only possible if the contract — what a
run is, what a result is, how identity is computed, what a failure means — is
fixed and tested before the first model is downloaded.

If Real-ESRGAN arrived first and the schema were retrofitted around it, the schema
would silently encode Real-ESRGAN's assumptions and SwinIR's numbers would not be
comparable.

## 2. Decisions

### D-S1 — Python is the single benchmark-runner language

Every candidate model in the plan (Real-ESRGAN, SwinIR, GFPGAN, CodeFormer,
rembg) and every planned metric (PSNR/SSIM/LPIPS, OCR accuracy, face-embedding
similarity, IoU) is Python. Writing the runner in another language would introduce
Python at POC-006 anyway, leaving the contract implemented twice.

TypeScript enters only at POC-005 for the browser lab, and validates against the
JSON Schema exported from the Python models rather than re-implementing the
contract.

**Rejected:** TypeScript/Node for the runner (no ML ecosystem overlap); both
languages with a duplicated contract (guaranteed drift, surfacing as fake
benchmark discrepancies); Go or Rust (no ML overlap at all).

### D-S2 — Exactly one runtime dependency

Runtime: `pydantic` only. Development: `pytest`, `pytest-cov`, `ruff`, `mypy`,
`jsonschema`. The CLI uses stdlib `argparse` and the PNG fixture is written with
stdlib `zlib`/`struct`.

The reason is licence surface. AGENTS.md requires dependency licences to be
reviewed before commercial activation, so every avoided dependency is a
permanently smaller register. After POC-001 the runtime register has **one entry**.

`tests/test_scope_and_artifacts.py::TestNoModelIntegration` fails if that register
changes, so widening it is a deliberate act, not a drift.

**Rejected:** Typer/Click (ergonomics not worth a permanent licence entry for five
subcommands); Pillow for the fixture (an imaging dependency in a task that decodes
nothing, and its PNG output is not guaranteed byte-stable across versions).

### D-S3 — `pip` + `venv` + a pinned constraints file

`uv` is faster but is one more prerequisite a reviewer must install before they can
verify the work. `requirements-dev.lock.txt` pins exact versions.

### D-A1 — Two approved directories renamed to underscores

`benchmark-runner` → `benchmark_runner`, `ai-adapters` → `ai_adapters`. Python
module names cannot contain hyphens. `browser-lab` and `docker` keep hyphens
because they are not Python packages. Migration impact: none, nothing existed yet.

### D-A2 — Three directories added

`poc/contracts/`, `poc/schemas/` and `tests/`. The contract sits **beside** the
runner rather than inside it so the POC-005 browser lab can consume the exported
schema without depending on the benchmark runner.

### D-B1 — POC-001 validates declared metadata only

`POC_TASKS.md` asks for "a command that validates manifests without processing
images", while also requiring "invalid extension/content metadata" to fail.
POC-003 separately requires validating "actual file signature".

Resolution: POC-001 checks *declared* metadata (declared extension against
declared media type, declared dimensions, declared provenance) and never decodes
an image. It may stream bytes to verify SHA-256 and size — a read with no parsing,
so no decode-bomb surface. POC-003 adds real signature sniffing and guarded
decoding, writing into the same `InspectionResult` fields.

### D-B2 — JSON, not YAML, for manifests

YAML has no canonical form, which fights byte-determinism, and `yaml.safe_load`
still expands aliases (a "billion laughs" denial-of-service surface). JSON is
canonicalisable, has no alias or tag attack surface, and is the same format the
browser lab will emit. Trade-off accepted: JSON is less pleasant to hand-write.

### D-R1 — Python 3.14 ML-wheel risk is isolated, not avoided

Only CPython 3.14.5 is installed on the development machine. POC-001's
dependencies all resolve to prebuilt wheels there, but `torch`, `opencv-python`,
`basicsr` and `gfpgan` historically lag a new CPython release.

Rather than downgrade the runner, the container/adapter boundary decouples the
two: the runner declares `requires-python = ">=3.11"` and an inference image may
pin whatever interpreter its model requires. Re-check at POC-004.

## 3. Technical mechanisms chosen

### Content-addressed identifiers

An identifier is the digest of the declared inputs that define the thing it names.

- Canonical JSON: a restricted RFC 8785 subset — floats rejected, ASCII-only
  object keys, NFC-normalised strings, integers within ±(2^53−1), compact
  separators, sorted keys. The restrictions exist so an equivalent JavaScript
  implementation is a few lines rather than a port.
- Domain separation: `_id_kind` and `_schema_version` prefix every identity
  document, so a run identity cannot collide with a result identity.
- SHA-256 → base32 lower, unpadded, truncated to 32 characters = 160 bits.

**Excluded from every identity:** timestamps, hostnames, durations, memory,
attempt counters, output paths. `result_id` specifically excludes `attempt`, which
is the mechanism behind idempotent retry and the "no duplicate billing event"
rule.

### Identity/environment split in reports

AGENTS.md requires every result to record hardware and runtime versions; POC-001
acceptance criterion 4 requires byte-reproducible reports. These conflict in a
flat document. The report therefore carries a deterministic `identity` section and
an observed `environment` section, plus an `identity_digest` so a live report can
be proved equivalent to the golden one without comparing whole files.

### Injected `RunContext`

Clock, cancellation token, temporary root, seed and logger are all injected.
`poc/contracts/runtime.py` and `poc/benchmark_runner/environment.py` are the only
modules permitted to read ambient state, enforced by a ruff `banned-api` rule with
per-file exemptions.

### Byte-reproducible PNG fixture

The fixture is written with DEFLATE **stored** blocks rather than
`zlib.compress`, because zlib output can differ between versions and builds while
the stored-block layout is fixed by RFC 1951. Cost: about 12 KB instead of about
1 KB. Benefit: `make_fixtures.py --check` verifies byte-for-byte reproducibility
on any platform, forever, with no imaging dependency.

### Structural enforcement of product decisions

| Decision | Mechanism |
| --- | --- |
| D-006 originals are immutable | read-only `InputRef` with no writable path; SHA-256 verified before and after every call; session-wide fixture hash guard |
| D-007 / D-009 Standard is not AI | `FAMILY_OF` maps each operation to a fixed family; a mismatched declaration is a validation error |
| D-010 colourisation is estimated colour | `disclose_estimated_colour: Literal[True]` — the type makes disabling it impossible |
| Idempotent retry, no duplicate billing | `attempt` excluded from `result_id`; ledger keyed by `result_id` |
| Batch isolation | every exception normalised at the processor boundary |
| Section 18 failure taxonomy | `NormalizedFailure` cannot be constructed without a category and a next action |

## 4. Consequences

**Positive.** One source of truth for the contract. A reusable conformance suite
waiting for POC-006's first real adapter. A one-entry runtime licence register.
Byte-reproducible reports and fixtures. Product invariants enforced by types and
tests rather than by reviewer vigilance.

**Negative.** Schema changes must be re-exported and committed (mitigated: drift
fails CI). The contract will need additive minor versions as later tasks reveal
missing fields — accepted, because over-designing now would be worse. The
stored-block PNG is larger than a compressed one.

**Deferred.** Docker is not installed on the development machine and is required
by POC-006. No GPU is available; the benchmark plan already assumes rented
capacity. Git was not initialised during POC-001 at the product owner's explicit
instruction ("write code first, we'll do git at the very last after local
testing"), so the per-task branch workflow in `POC_HANDOFF_README.md` has not
started.

## 5. Bug found and fixed during implementation

The conformance suite caught a real defect in the first version of
`poc/processors/base.py`: `InputRef.assert_unchanged` reads the file from disk, so
a missing original raised `FileNotFoundError` straight out of `guarded_process`.
Because that exception escaped the guard, a single absent asset would have aborted
an entire batch — precisely the failure the guard exists to prevent.

Fixed by normalising `OSError` into a `MANIFEST.ASSET_FILE_MISSING` failure with
category `invalid_input`, distinguished from a processor fault so an operator is
not sent to debug the wrong component. Locked in by
`test_an_unreadable_original_is_reported_as_invalid_input`.

Worth recording because it is evidence the conformance suite does its job before
any real model exists.

## 6. Related

- `AGENTS.md` — repository instructions and product invariants
- `docs/TECHNICAL_POC_AND_MODEL_BENCHMARK_PLAN.md` sections 15, 16 — POC shape and phases
- `docs/PRODUCT_DECISION_LOG.md` — D-006, D-007, D-009, D-010, D-021, D-022, D-036, D-037
- `docs/USER_FLOWS_AND_EDGE_CASES.md` section 18 — normalised failure taxonomy
