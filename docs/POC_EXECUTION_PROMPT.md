# Master Prompt for the AI Coding Agent

Copy the prompt below into the AI coding agent after placing all handoff files in the repository.

---

You are implementing a controlled technical proof of concept for a production image-enhancement product.

Before making any change:

1. Read `AGENTS.md` completely.
2. Read `docs/MASTER_PRODUCT_BLUEPRINT.md` completely.
3. Read `docs/PRODUCT_REQUIREMENTS.md` completely.
4. Read `docs/USER_FLOWS_AND_EDGE_CASES.md` completely.
5. Read `docs/PRODUCT_DECISION_LOG.md` completely.
6. Read `docs/TECHNICAL_POC_AND_MODEL_BENCHMARK_PLAN.md` completely.
7. Read `docs/POC_TASKS.md` completely.
8. Inspect the existing repository, language/tool versions and available test commands.
9. Report any conflict, missing prerequisite or unsafe assumption.

## Current objective

Begin only with **Task POC-001: Repository and benchmark-contract foundation** from `docs/POC_TASKS.md`.

Do not begin model integration, download model weights, build the customer application, add authentication/billing or implement later tasks.

The complete product documents preserve future requirements. Do not delete, narrow or reinterpret them simply because POC-001 implements only the benchmark foundation.

## Required working method

- First present a concise implementation plan for POC-001.
- Explain proposed technologies and why they fit the benchmark, including alternatives and trade-offs.
- Prefer current stable, production-supported versions, but do not change an existing approved stack silently.
- Ask for approval only if a choice materially changes architecture, security, licence exposure or operating cost.
- Implement the smallest complete foundation satisfying POC-001.
- Add tests and run all relevant checks.
- Inspect generated example manifests/reports directly.
- Review the final diff for scope, correctness, security and maintainability.

## Required final response

Provide:

1. Outcome
2. Files changed
3. Architecture/technology decisions made
4. Commands and checks run with results
5. Acceptance-criteria mapping
6. Assumptions
7. Known limitations or risks
8. Exact recommended next task—but do not implement it

If a check fails, do not describe the task as complete. Diagnose it or report the blocker precisely.

---

## Follow-up prompt pattern

After reviewing and accepting one task, use:

```text
Read AGENTS.md and all relevant approved docs again. Implement only Task POC-XXX
from docs/POC_TASKS.md. Inspect the current repository and previous task outputs
before planning. Follow the task acceptance criteria exactly. Add and run relevant
tests and checks, inspect generated artifacts, review the final diff, and stop
after reporting the next recommended task. Do not implement future tasks.
```

Do not combine tasks merely to save prompting time. Combine only when the product owner explicitly approves it after reviewing dependencies and risk.
