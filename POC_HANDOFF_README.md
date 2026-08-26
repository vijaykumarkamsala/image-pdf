# AI Coder Handoff Guide

This package prepares another repository-aware AI coding agent to implement the technical proof of concept safely and incrementally.

## Files in the complete handoff

Place these files in the target repository:

```text
AGENTS.md
docs/
  MASTER_PRODUCT_BLUEPRINT.md
  PRODUCT_REQUIREMENTS.md
  USER_FLOWS_AND_EDGE_CASES.md
  PRODUCT_DECISION_LOG.md
  TECHNICAL_POC_AND_MODEL_BENCHMARK_PLAN.md
  POC_TASKS.md
  POC_EXECUTION_PROMPT.md
```

Copy every product and POC document into `docs/` without changing its content. `MASTER_PRODUCT_BLUEPRINT.md`, `USER_FLOWS_AND_EDGE_CASES.md` and `PRODUCT_DECISION_LOG.md` preserve the wider product scope that is intentionally excluded from current POC implementation.

## Recommended usage

1. Create a new Git repository dedicated to the POC. Do not mix it into the production YearShift repository.
2. Add all documents using the structure above.
3. Commit the documentation before generating implementation code.
4. Open the repository root in Codex, Cursor, Claude Code or another repository-aware agent.
5. Paste the master prompt from `docs/POC_EXECUTION_PROMPT.md`.
6. Require the agent to implement only POC-001.
7. Review its plan before allowing implementation when the tool supports Plan mode.
8. After implementation, inspect the diff and the agent’s acceptance-criteria mapping.
9. Run the documented commands yourself at least once.
10. Commit the accepted task before starting the next task.

## Do not paste all requirements repeatedly

`AGENTS.md` contains durable behavior and guardrails. The detailed files provide requirements and task context. The active prompt should normally identify only the current task and any new correction.

## Review checkpoints

Stop and review carefully when the agent proposes:

- A language/framework not justified by the benchmark needs
- A new model or weight download
- A model with non-commercial/unknown licensing
- An external inference provider
- GPU infrastructure or a paid service
- Unsafe model loading
- Large binary assets in Git
- Combining multiple POC tasks
- Production authentication, billing or UI outside POC scope

## Suggested Git workflow

Use one branch and commit per task:

```text
poc/001-foundation
poc/002-licence-gates
poc/003-input-safety
...
```

Review and merge each task before the next dependent task. Do not run multiple agents concurrently on overlapping files.

## What you should approve versus delegate

The AI coder may decide small implementation details that remain within the approved stack. You should explicitly approve:

- Repository technology/architecture baseline
- Model candidates
- Licences with ambiguity
- External providers
- Cloud/GPU spending
- Changes to product requirements or acceptance criteria
- Deferral of an advertised Release 1 operation

## First expected result

POC-001 should produce only the benchmark foundation: repository structure, schemas, fake processor contract, manifest validation, example report and tests. It should not enhance an image with AI yet.

This is intentional. It ensures every later model produces comparable, traceable and reviewable results.

## When to supply images

- Small synthetic/rights-cleared fixtures can enter Git.
- Large or private samples should remain outside Git in protected storage.
- Maintain a manifest with asset IDs, hashes, provenance and permissions.
- Before final model selection, provide representative customer-style samples and specify whether outputs may appear in a public demo.

## Completion of the handoff stage

The handoff is successful when the AI coder reads all documents, presents a scoped POC-001 plan, does not start model integration, and maps its final work directly to the POC-001 acceptance criteria.
