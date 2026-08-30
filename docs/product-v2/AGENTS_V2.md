# Repository Instructions for AI Coding Agents — Product V2

## Mission

Recover the verified repository into the production Intelligent Visual Production Workspace defined under `docs/product-v2/`.

The existing processing code and tests are evidence and reuse candidates. The legacy customer UI, POC-only task sequence and prototype HTTP surface do not define the production product.

## Instruction precedence

1. Current explicit product-owner task
2. This `AGENTS.md`
3. `docs/product-v2/README.md` and its V2 authority order
4. Approved architecture/decision records for the current recovery stage
5. Existing repository conventions
6. Historical POC documents where not conflicting

Report material conflicts. Never silently choose an older requirement.

## Working discipline

- Read the relevant V2 documents completely before planning or editing.
- Inspect current code, Git status and tests before proposing change.
- Work on one explicitly approved recovery task at a time.
- Separate read-only diagnosis, planning and implementation authority.
- Preserve unrelated user changes and existing history.
- Prefer small reviewable diffs with rollback.
- Add/update tests with behaviour.
- Run applicable format, lint, type, unit, contract, integration, end-to-end, visual, accessibility, security and performance checks.
- Inspect generated files/results; generation success alone is not verification.
- Report files changed, commands/results, acceptance mapping, limitations, risks and next task.

## Product invariants

- Original assets/PDF bytes are immutable.
- Every derivative/version has provenance.
- Standard/Preserve processing does not silently use generative reconstruction.
- Recreate requires explicit permission and reviewable AI-region evidence.
- No silent PDF flattening, font substitution, signature invalidation, external-file overwrite or external deletion.
- Long work is durable and idempotent.
- One failed item does not fail unrelated batch items.
- Browser/local processing and cloud processing follow trusted policy; UI does not call model workers directly.
- Benchmark code is not a production runtime dependency.
- Customer content is private, region/policy controlled and not used for training by default.
- Live billing/payment is disabled during testing; usage/shadow pricing finalises at effective charge zero.

## Approved architecture direction

- React + TypeScript owns the customer experience and browser-local work.
- NestJS owns identity, workspaces, projects, permissions, jobs, public API, e-sign orchestration, cloud connectors, audit and shadow pricing.
- Python owns image/AI/OCR/heavy processing workers behind versioned contracts and durable queues.
- PostgreSQL stores metadata/workflow state.
- Object storage stores originals, derivatives, previews, project packages, exports and evidence.
- Model/provider/PDF/font/cloud integrations remain behind adapters and licence/security gates.

Do not replace this direction without product-owner approval supported by concrete evidence and migration impact.

## Legacy and reuse rules

- Tag/freeze the verified baseline before structural changes.
- Freeze the legacy UI; do not incrementally mix React into its global-state implementation.
- Do not delete POC/benchmark code solely because it is not production runtime.
- Reuse candidates must pass the reuse gates in `RECOVERY_ARCHITECTURE_AND_DELIVERY_PLAN.md`.
- The custom PDF engine is not production-approved until the required differential/compatibility/security benchmark passes.
- Commercial model/font/provider approval includes executed dependencies and distribution/embedding rights.

## Security rules

- Treat every upload, archive, image metadata, PDF object, font and callback as untrusted.
- Validate actual type, dimensions, resource budgets and active content.
- Enforce workspace/tenant authorisation on every object and operation.
- Use least-privilege expiring file/job/provider access.
- Do not read or expose `.env`, credentials, private uploads or customer content unless the current task explicitly requires it and authority exists.
- Never log file bytes, passwords, signing keys, tokens or unnecessary personal data.
- Do not bypass PDF passwords, model/font licences, certificate validation or checksum gates.
- Redaction requires permanent removal, hidden-data sanitisation and verification.

## Generated contracts

- Maintain one documented contract source of truth.
- Generated JSON Schema/OpenAPI/TypeScript/Python outputs are not manually edited.
- Generated artifacts include a “do not edit” marker where supported.
- Breaking changes require versioning, migration and compatibility tests.

## Completion standard

A task is complete only when:

- Its approved scope and acceptance criteria are met.
- Relevant checks pass.
- No known Critical/High defect or hidden licence/security blocker remains.
- Data migrations and rollback are verified where relevant.
- Documentation matches behaviour.
- The diff is reviewed and contains no unrelated changes.
- Remaining risks are stated honestly.

Never declare a whole product/module complete merely because code exists or unit tests pass.
