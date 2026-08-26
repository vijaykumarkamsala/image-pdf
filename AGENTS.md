# Repository Instructions for AI Coding Agents

## Mission

Build and validate the technical proof of concept defined in:

- `docs/MASTER_PRODUCT_BLUEPRINT.md`
- `docs/PRODUCT_REQUIREMENTS.md`
- `docs/USER_FLOWS_AND_EDGE_CASES.md`
- `docs/PRODUCT_DECISION_LOG.md`
- `docs/TECHNICAL_POC_AND_MODEL_BENCHMARK_PLAN.md`
- `docs/POC_TASKS.md`

This repository validates image-processing quality, performance, commercial eligibility and cost before the production architecture is approved. It is not permission to build the full customer application.

The POC documents define the current implementation boundary; they do not replace the complete product vision. Preserve future-facing requirements in the master blueprint and do not remove or narrow them merely because they are excluded from the current POC.

## Instruction Precedence

1. Explicit current task from the product owner
2. This `AGENTS.md`
3. Approved product and benchmark documents
4. Existing repository conventions

If instructions conflict materially, stop and explain the conflict. Do not silently choose one.

## Agent Responsibilities

- Read the relevant requirements and current task completely before editing.
- Inspect the existing repository before proposing structural changes.
- For multi-file or ambiguous work, present a concise plan before implementation.
- Work on one approved task from `docs/POC_TASKS.md` at a time.
- State assumptions and ask only questions that materially change the implementation.
- Keep changes scoped. Do not implement future tasks opportunistically.
- Prefer simple, reproducible code over a visually impressive demo.
- Add or update tests with every behavioral change.
- Run applicable formatting, linting, type checks, tests and benchmark smoke checks.
- Review the final diff for correctness, security, licensing and scope.
- Report what changed, commands run, results, limitations and remaining risks.

## Product Invariants

- Never overwrite or mutate an original input asset.
- Every result is a derivative with traceable provenance.
- Standard enhancement and AI reconstruction are separate operations.
- AI processing is never silently enabled.
- Browser output is a preview unless explicitly eligible as a local final result.
- Heavy/cloud processing is asynchronous and designed to survive client closure.
- One failed input must not fail an entire batch.
- Retry must be idempotent and must not duplicate billing/usage events.
- Do not store large image bytes in a relational database.
- Do not use customer or private benchmark images for training.
- Do not commit private or large benchmark assets to Git.

## POC Boundaries

Do not implement unless a separate approved task explicitly requests it:

- Production authentication or billing
- Full customer dashboard
- Multi-page PDF editor
- Native desktop or mobile application
- Custom model training/fine-tuning
- Production deployment
- Final pricing
- YearShift integration

Mock or minimal local substitutes are allowed only where needed to validate the benchmark contract.

## Commercial Licence Rules

> **Amended 24 August 2026 by decisions D-038, D-039 and D-040** (product-owner
> approved). Gates now bind to what a run is *for*, not to whether a model was
> downloaded. See `docs/adr/ADR-0002-monorepo-and-licence-gates.md`.

**Gate by purpose.** Commercial clearance (`approved`) is required for
`public_demo`, `staging` and `production`. `local_research` and
`internal_benchmark` runs are permitted for any disposition except `blocked`,
provided the result is marked with its disposition and is excluded from
commercial recommendations. Rationale: evaluating a model in order to decide
whether to pursue a licence is normal internal research use, and requiring
clearance first would mean negotiating terms for models of unmeasured quality.

**Required before any download or execution, at every purpose level** (this is
security and supply chain, not commerce - the risk is identical before and after
shipping):

- Record the official source (not a mirror) and pin the commit or release tag.
- Record the weight SHA-256 and verify it at load time.
- Prefer `.safetensors`; if pickle is unavoidable, load inside a container with
  no network access.
- Disable network access during inference.
- If the download requires accepting terms, record exactly what was accepted -
  accepting the terms is entering the licence.

**Every advertised Release 1 operation must retain at least one `approved`
candidate in its shortlist**, so a licence negotiation is always an upgrade and
never a rescue.

- Record the official source, code licence and weight licence for every model before it is downloaded, installed or executed.
- Inspect dependencies that enter the executed inference path.
- Do not assume a wrapper licence covers bundled/downloaded weights.
- Mark non-commercial, research-only, unknown or ambiguous candidates as blocked.
- SUPIR is reference-only unless documented commercial permission is supplied.
- CodeFormer remains licence-gated until its commercial terms are approved.
- GFPGAN requires executed dependency-path review, not only top-level licence review.
- Pin approved repository commits, package versions and model hashes.
- Never bypass model verification or disable checksum validation in production-oriented code.

## Security Rules

- Treat all image inputs and metadata as untrusted.
- Validate content signatures and decoded dimensions, not filename/extension alone.
- Protect against decompression bombs and excessive pixel counts.
- Use explicit resource, timeout and temporary-storage limits.
- Do not use unsafe dynamic evaluation.
- Avoid unsafe pickle/model loading where a safer format or verified trusted source is available.
- Disable unexpected inference-time network access.
- Keep secrets outside source control.
- Ensure temporary artifacts are isolated and removed after success, failure or cancellation.
- Do not log image bytes, sensitive paths or unnecessary personal metadata.

## Reproducibility Rules

Every benchmark result must record:

- Input asset ID and cryptographic hash
- Operation and settings
- Model/provider name and exact version
- Model weight hash
- Runtime and dependency versions
- Hardware description
- Precision, tile size and overlap
- Input/output dimensions and byte sizes
- Cold/warm state
- Timing and memory measurements
- Exit state and normalized failure code

Use deterministic seeds where the model/runtime permits. Clearly label nondeterministic outputs.

## Repository Shape

> **Amended 24 August 2026 by decision D-041** (product-owner approved).
> The original flat `poc/` shape is preserved verbatim below and in
> `docs/adr/ADR-0002-monorepo-and-licence-gates.md`, which records the need and
> the full migration mapping.

The repository is a monorepo. Every code location declares itself in
`workspaces.toml` with a `stage`:

```text
workspaces.toml            monorepo manifest: path, name, language, stage, task, deps
docs/                      approved product and POC documents, plus ADRs
packages/
  contracts/               Python - the versioned benchmark contract (source of truth)
  processors/              Python - adapters and the guards around every processor call
  schemas/                 JSON   - generated from contracts; language-neutral
  contracts-ts/            TS     - generated from schemas            (POC-005)
  metrics/                 Python - quality metrics                   (POC-004+)
services/
  benchmark-runner/        Python - validation, ids, reporting, orchestration, CLI
apps/
  browser-lab/             TS     - device measurement harness        (POC-005)
infra/
  docker/                  pinned inference runtime images            (POC-006)
data/
  manifests/ fixtures/ reports/    benchmark data; not code, not a workspace
tests/                     repo-wide guards: scope, structure, layering
tools/                     check.py, make_fixtures.py
```

Python workspaces use a `src/` layout and share the PEP 420 namespace `ipw`.

Two rules are enforced by `tests/test_workspaces.py`, not by convention:

- **Dependency direction** is `benchmark-runner -> processors -> contracts`.
  `packages/contracts` imports no other workspace.
- **Stage separation** (D-036): a `production` workspace may never import from a
  `poc` workspace. Promotion is an explicit move between workspaces.

Do not reorganize the repository, or add a workspace, without explaining the need
and migration impact and recording it in an ADR.

<details>
<summary>Original shape, superseded by D-041</summary>

```text
docs/
poc/
  benchmark-runner/
  browser-lab/
  processors/
    standard/
    ai-adapters/
  manifests/
  metrics/
  reports/
  fixtures/
  docker/
```

</details>

## Interface Direction

Processors should converge on an internal contract equivalent to:

```text
inspect(input) -> metadata and safety decision
estimate(input, operation, settings) -> time/cost/memory estimate
process(input, operation, settings) -> result and measured metrics
```

Keep model/provider-specific code behind adapters. Benchmark orchestration must not depend directly on Real-ESRGAN, SwinIR or an external vendor.

## Testing Expectations

At minimum, cover:

- Input inspection and safety limits
- Original preservation
- Deterministic manifest/result serialization
- Processor contract conformance
- Idempotent job/run identifiers
- Per-image batch failure isolation
- Temporary-file cleanup
- Metric calculation against known fixtures
- Licence gate behavior

Use small, rights-cleared fixtures in Git. Large/private assets are referenced through manifests and hashes.

## Completion Standard

A task is complete only when:

- Its acceptance criteria are met.
- Relevant automated checks pass.
- Generated reports/artifacts are inspected, not only created.
- The diff contains no unrelated changes.
- No known licence/security blocker is hidden.
- Documentation reflects behavior.
- The agent reports unresolved limitations honestly.

Never declare completion because code was generated successfully.
