# ADR-0002 — Monorepo layout and purpose-based licence gates

**Status:** Accepted
**Date:** 24 August 2026
**Approved by:** Product owner, before implementation
**Supersedes:** the "Repository Shape" section of `AGENTS.md`; refines decision D-013
**Decisions recorded:** D-038, D-039, D-040, D-041, D-042

---

## Part 1 — Licence gates bind to run purpose, not to model download

### Context

`AGENTS.md` states: *"Do not download, install or execute a model until its
official source, code licence and weight licence are recorded."* Read absolutely,
this blocks all model evaluation until commercial clearance completes — which can
take weeks per candidate and would mean negotiating terms for models whose quality
is still unmeasured.

The product owner challenged that reading. On re-examination the approved
documents are already less absolute:

- Benchmark plan **Gate A** governs what may be *"recommended for production"*.
- §6.2 marks SUPIR *"Reference-only; exclude from commercial recommendation"* —
  which presupposes it may be **run**.
- POC-002's own acceptance criterion says *"Reference-only runs are clearly marked
  and cannot appear as commercial recommendations"* — runs happen; they are
  labelled.
- AGENTS.md's verb is **recorded**, not **approved**. Recording a licence is a
  desk job of minutes. Obtaining written commercial permission is the slow part.

The over-restrictive reading was the implementing agent's, not the document's.

### Decision D-038 — gates bind to purpose

A new `RunPurpose` axis joins the contract. The gate becomes a matrix:

| Disposition ↓ / Purpose → | `local_research` | `internal_benchmark` | `public_demo` | `staging` | `production` |
|---|:---:|:---:|:---:|:---:|:---:|
| `approved` | yes | yes | yes | yes | yes |
| `review_required` | yes | yes, marked | no | no | no |
| `non_commercial` | yes | yes, marked reference-only | no | no | no |
| `unknown` | yes | yes, marked and warned | no | no | no |
| `blocked` | no | no | no | no | no |

Two mechanical safeguards prevent leakage:

1. Every `BenchmarkRun` records `purpose` **and** the licence disposition as it
   was at run time. Both feed the `run_id`, so a reference-only result cannot be
   relabelled later — the digest would change.
2. The POC-015 recommendation report reads only runs whose disposition is
   `approved`. Enforced in code, not prose.

### Decision D-039 — Gate B (security) stays mandatory from day 1

This is the boundary the purpose matrix does **not** move. Loading a `.pth` via
`torch.load` is arbitrary code execution on a developer machine; that risk is
identical before and after shipping and has nothing to do with commerce.

Required for **every** purpose, including `local_research`:

- official source URL (not a mirror)
- pinned commit or release tag
- weight SHA-256 recorded and verified at load time
- `.safetensors` preferred; if pickle is unavoidable, load inside a container with
  no network
- network disabled during inference

Also day-1, and cheap:

| Item | Why it cannot wait |
|---|---|
| Gated downloads (click-through terms) | Accepting the terms *is* entering the licence. Unrecorded, the permission cannot later be proved. |
| Explicitly prohibited weights | A small set forbid any download. Two-minute check. |

### Decision D-040 — one approved fallback per operation

Every advertised Release 1 operation must retain at least one `approved`
candidate in its shortlist.

The real risk of deferring commercial clearance is not legal exposure during
development — it is **sunk-cost anchoring**: six weeks of benchmarking makes a
non-commercial winner very hard to walk away from. This rule makes a licence
negotiation always an upgrade and never a rescue.

### Consequences

**Positive.** Model evaluation starts immediately. Quality is known before a
licence conversation begins, which is a strictly better negotiating position.
Security posture is unchanged.

**Negative.** More state to track: every run now carries a purpose. Reference-only
outputs must be marked and must never reach a demo — enforced by the report
filter, but it is a rule people must know.

**Unchanged.** Nothing reaches `public_demo`, `staging` or `production` without
`approved`. D-013's substance survives; only its scope is made explicit.

---

## Part 2 — Monorepo layout

### Context

POC-005 introduces TypeScript, POC-006 introduces Docker build contexts and
weight paths, and production frontend/backend workspaces follow architecture
approval. The `poc/` flat layout in `AGENTS.md` has no room for a second language
and no mechanism to keep production code from importing POC code.

### Decision D-041 — adopt `apps/ services/ packages/ data/ infra/`

```text
workspaces.toml            monorepo manifest: path, name, language, stage, task, deps
packages/contracts         Python · benchmark contract (source of truth)
packages/processors        Python · adapters + boundary guards
packages/schemas/v1        JSON   · generated from contracts
packages/contracts-ts      TS     · generated from schemas          — POC-005
packages/metrics           Python · quality metrics                 — POC-004+
services/benchmark-runner  Python · validation, ids, reporting, CLI
apps/browser-lab           TS     · device measurement              — POC-005
infra/docker               pinned inference runtimes                — POC-006
data/{manifests,fixtures,reports}   not code, not a workspace
```

Python workspaces use `src/` layout and share the PEP 420 namespace `ipw`.

**Timing.** Done now because it is the cheapest it will ever be: no git history to
rewrite, nothing deployed, 96 files. After POC-005 and POC-006 the same move would
also have to relocate a Node toolchain, Docker build contexts and CI matrices.

**Two mechanisms the flat layout could not provide:**

*Dependency direction.* `benchmark-runner → processors → contracts`, verified by
AST inspection in `tests/test_workspaces.py`. `packages/contracts` imports no
other workspace, which is what allows the TypeScript browser lab to consume the
generated schema without depending on the runner.

*Stage separation (D-036).* Each workspace declares `stage`. A `production`
workspace may never import from a `poc` workspace. There are no production
workspaces yet, so the rule is currently vacuous — wired now, while it costs
nothing, rather than after the first production module exists. A tripwire test
fails if a `production` workspace appears at all, since architecture approval is
a prerequisite (blueprint §29).

**On D-036 and the handoff guide.** `POC_HANDOFF_README.md` says not to mix the
POC into *the YearShift repository*. This is not that repository. D-036 requires
the POC not to become unreviewed production architecture, and the stage mechanism
enforces that more strongly than directory separation alone.

### Decision D-042 — structure without ceremony

| Layer | Chosen | Rejected, and why |
|---|---|---|
| Node workspaces | npm workspaces (npm 11 already present) | pnpm is better at scale but is a prerequisite a reviewer must install first — the same reasoning that ruled out `uv` in ADR-0001. Revisit if hoisting causes real problems. |
| Python | pip + venv, one `pyproject.toml` per workspace | `uv` workspaces are genuinely nicer with 3+ Python packages. Revisit at POC-006. |
| Task orchestration | extend `tools/check.py` | Turborepo and Nx solve CI duration and cache invalidation. The full suite runs in ~12 seconds. Revisit when CI exceeds roughly 5 minutes. |

The root `pyproject.toml` declares no `[project]` — it holds only shared ruff,
mypy, pytest and coverage configuration. Each workspace owns its real
dependencies, so the dependency direction is enforced by packaging rather than by
convention.

### Migration record

| Before | After |
|---|---|
| `poc/contracts/` | `packages/contracts/src/ipw/contracts/` |
| `poc/processors/` | `packages/processors/src/ipw/processors/` |
| `poc/benchmark_runner/` | `services/benchmark-runner/src/ipw/benchmark_runner/` |
| `poc/manifests/` | `data/manifests/` |
| `poc/fixtures/` | `data/fixtures/` (generator to `tools/make_fixtures.py`) |
| `poc/reports/` | `data/reports/` |
| `poc/schemas/` | `packages/schemas/` |
| `poc/browser-lab/` | `apps/browser-lab/` |
| `poc/docker/` | `infra/docker/` |
| `poc/metrics/` | `packages/metrics/` |
| `tests/` (flat) | per-workspace `tests/` + repo-wide `tests/` |
| import root `poc.` | namespace `ipw.` |

**What was verified after the move.** All 8 gates pass. The committed fixture's
SHA-256 is unchanged (`ab8dbedf…0ab5fd`), proving no benchmark input was disturbed.

**What legitimately changed.** The example manifest's `relative_path` moved from
`poc/fixtures/...` to `data/fixtures/...`. That is manifest *content*, so
`manifest_digest`, `report_id` and `identity_digest` all changed and the golden
report was regenerated. The report's `inventory`, `rights` and `ground_truth`
subtrees are byte-identical to the pre-migration values, which is the evidence
that nothing semantic changed.

Two path-resolution helpers were hardened during the move: the repository root is
now found by walking up for `workspaces.toml` rather than by counting `__file__`
parents, and the golden-report path is derived from that root. Both would
otherwise break silently the next time a workspace moves.

### Consequences

**Positive.** Room for TypeScript, Docker and production code without a second
migration. Layering and stage separation are testable. Each workspace's licence
surface is separately reviewable.

**Negative.** Deeper paths. Three editable installs instead of one (a single
documented command). Contributors must know which workspace a change belongs in.

**Deferred.** Node tooling until POC-005; task orchestration until CI time
justifies it; `uv` until there are more Python workspaces.

---

## Related

- `docs/adr/ADR-0001-poc-001-foundation.md` — the technical baseline this builds on
- `docs/PRODUCT_DECISION_LOG.md` — D-013, D-036, D-037
- `docs/TECHNICAL_POC_AND_MODEL_BENCHMARK_PLAN.md` §4 (Gates A–D), §6, §15
- `AGENTS.md` — Repository Shape (superseded by D-041), Commercial Licence Rules
