# First Prompt for Codex — V2 Recovery

Send the following after copying the complete `redesign_v2` set into `docs/product-v2/` in the audited repository.

---

We are beginning the approved V2 recovery of this repository. This is not permission to redesign or implement the product yet.

Before taking any action:

1. Read the repository `AGENTS.md` completely.
2. Read every file under `docs/product-v2/` completely.
3. Read earlier product/POC documents only as historical evidence.
4. Apply the precedence in `docs/product-v2/README.md`; V2 supersedes conflicting older scope.
5. Inspect Git status, branches, recent commits, workspace layout, dependency graph and existing validation commands.
6. Do not read `.env`, secrets, customer uploads or personal files.
7. Do not install packages, download models, call cloud services, run generators or modify files during this planning pass.

Current objective: **Recovery 0 — Preserve and reconcile**, planning only.

Use the previously verified baseline as evidence, but verify read-only facts that may have changed. Then provide:

- Your understanding of the V2 product and release boundary.
- A contradiction report between V2 and earlier documents/code.
- A folder/package classification: Keep, Repair, Refactor, Replace, Archive or Remove-later.
- Exact recommendation for preserving/tagging the current verified baseline.
- Exact proposed location/name for the frozen legacy UI.
- Exact proposed production monorepo shape for React, NestJS, Python workers, contracts, storage/jobs and docs.
- Dependency changes required to remove benchmark-runner code from customer runtime.
- A reuse matrix for contracts, inspection, processors, PDF, vector, metrics, storage, jobs and licence guards.
- Risks of the custom PDF engine and the benchmark required before production approval.
- Proposed Recovery 0 file diff, with files created/moved/edited and files explicitly untouched.
- Verification commands that Recovery 0 would run.
- Rollback plan.
- Mapping to `RECOVERY_ARCHITECTURE_AND_DELIVERY_PLAN.md`.
- Decisions requiring product-owner approval.

Restrictions:

- Do not implement React, NestJS, workers or product features yet.
- Do not move, rename, delete or archive files yet.
- Do not alter working code, tests, docs, Git history or configuration.
- Do not download/integrate AI models or fonts.
- Do not change approved product decisions silently.
- Do not start Recovery 1 or later.

End with a section titled **Decisions requiring product-owner approval**. Wait for approval before modifying the repository.

---
