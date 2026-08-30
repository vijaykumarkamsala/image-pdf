# Recovery 2B: Durable Jobs and Secure File Intake

**Status:** Implemented locally; verification recorded below
**Branch:** `recovery/2b-durable-jobs-file-intake`
**Baseline:** `1ce04094a2d6d7e44bdfb6d5759dbd00b7d539d9`
**Authority:** `docs/product-v2/PRODUCT_V2_CONSOLIDATED_IMPLEMENTATION_AUTHORITY.md`, Sequence B, and the approved Recovery 2B task

## Customer outcome

An authenticated workspace member can select or drop an image/PDF from Home or
Default Files, transfer it through a private resumable upload session, observe
customer-safe upload and inspection progress, cancel the work, reconnect to an
active durable job, and see an accepted immutable original in Default Files.
Guests can complete the same journey at `/guest/upload`, see per-file progress
and rejection, recover an interrupted transfer after reselecting the same file,
and use **Sign in to save** through the existing identity boundary. Handoff
creates a workspace file for the exact accepted immutable source without
changing asset-original or source-version identity.

No editor, image/PDF processing operation, AI capability, cloud connector,
e-sign, payment, native application or deployment was added.

## Contracts and migrations

- Product contract version advances additively from `1.7.0` to `1.9.0` under
  the existing `product-v1` compatibility line. The benchmark contract remains
  `1.6.0` and unchanged.
- New generated contracts cover guest sessions, upload authorization and
  constraints, upload records/states, source facts, intake failures, durable
  jobs/states, ordered job events and the added upload/job permissions.
- Forty Product V2 JSON schemas and their TypeScript views are generated
  from the Python source of truth. Existing Recovery 2A fields remain valid.
- `0002_recovery_2b_upload_sessions.sql` adds guest/upload sessions,
  idempotency and strict owner/state constraints.
- `0003_recovery_2b_durable_jobs.sql` adds processing jobs, attempts, leases,
  checkpoints, ordered events and the transactional dispatch outbox.
- `0004_recovery_2b_guest_handoffs.sql` adds explicit identity-preserving guest
  handoff records and transactional promotion into workspace metadata.
- `0005_recovery_2b_gcs_integrity.sql` persists provider, generation, protected
  session, expected/verified checksum and reconciled metadata state.
- `0006_recovery_2b_durable_dispatch.sql` adds outbox delivery leases, attempts
  and retry availability for independent Cloud Tasks dispatch.
- `0007_recovery_2b_durable_cleanup.sql` adds cleanup leases and completion
  markers without making terminal source state mutable.

Canonical `WorkspaceFile` location remains separate from reusable project or
document references. Intake creates immutable `AssetOriginalRecord` and
`SourceVersionRecord` identity only after accepted promotion. Moving a file or
adding a reusable reference cannot change those identities.

## Intake and private storage

- Upload sessions are owner scoped to one actor/workspace or one guest session.
- Application resume authorizations are short lived. Provider resumable URIs
  are encrypted at rest, redacted from logs and never stored in browser recovery
  state or shown in customer details.
- The local client sends 4 MiB chunks with an explicit `Upload-Offset`; the API
  rejects conflicting offsets and byte-limit violations.
- Bytes enter a private quarantine object. The server derives digest, media
  type and source facts, then copies accepted bytes to an owner-scoped,
  content-addressed immutable object before committing source metadata.
- Cross-owner lookup returns not found and content reuse never reveals or
  shares another tenant's object.
- `GcsSdkPrivateClient` and `GcsWorkerPrivateObjectStore` are executable official
  Google Cloud Storage SDK adapters using Application Default Credentials.
  They initiate direct resumable uploads, accept GCS `308` progress, reconcile
  size/metadata/generation and use generation preconditions for no-overwrite
  promotion. Production composition selects GCS only with valid configuration
  and never falls back to local storage.
- The worker performs the server-side byte-count and SHA-256 check before
  promotion; an optional expected SHA-256 must match. Incomplete or quarantined
  content has no `WorkspaceFile` and cannot appear in Default Files.
- Cancellation removes temporary data. The independently invokable
  `cleanup:intake` service command leases expired/cancelled/rejected uploads,
  removes their private object, audits cleanup and marks completion. Deployment
  scheduler creation remains outside Recovery 2B.

## Inspection and malware controls

`packages/inspection` is a production Python workspace with no import from
`ipw.processors`, `ipw.benchmark_runner` or another POC runtime. It validates
content signatures before trusting names or declared types and derives SHA-256,
byte size, dimensions, pixel count, orientation, frame/page count, alpha, bit
depth, ICC presence and sensitive-metadata indicators where supported.

The boundary rejects zero-byte, truncated, spoofed, corrupt, excessive
dimension/page/pixel, active-PDF and decompression-risk inputs with normalized
failures. Malware scanning is an adapter; deterministic tests reject the EICAR
marker. Production worker composition requires `IPW_MALWARE_SCANNER=clamav`
and a valid ClamAV service configuration. `ClamAvScanner` streams bounded
`INSTREAM` chunks privately and returns explicit clean, malicious, unavailable,
timeout or error states. Every non-clean or unavailable result prevents
promotion. TIFF/HEIF signatures are recognized, but unsupported structures are
safely rejected rather than partially decoded.

The local NestJS executor provides deterministic development evidence and is
disabled in production. `build_production_application` composes the Python
worker from PostgreSQL, the GCS worker adapter, ClamAV and Google OIDC task
verification. It imports no benchmark runner, POC processor or legacy package.

## Durable jobs and APIs

PostgreSQL is job truth. Queue adapters carry an opaque job reference only.
The repository owns attempts, lease tokens/hashes, expiry, heartbeat,
checkpoints, retry scheduling, cancellation, terminal outcomes, ordered event
cursors and transactional outbox delivery. Batch and repository tests prove
that one file's failure does not change another file's outcome.

`GoogleCloudTasksProviderClient` uses the official SDK and validated project,
region, queue, HTTPS target/audience and service-account settings to create OIDC
HTTP tasks containing only dispatch, job and trace identifiers. Production
cannot select `LocalJobDispatchQueue`. The independently invokable
`relay:outbox` command leases PostgreSQL outbox rows, marks delivery only after
provider acceptance, treats an existing deterministic task as idempotent and
releases failed rows with bounded retry availability.

`IntakeTaskApplication` authenticates the Cloud Tasks bearer identity and task
header before accepting the bounded envelope. `DurableIntakeProcessor` claims
the PostgreSQL job, reads the generation-bound private object, heartbeats,
checks cancellation, resumes safe checkpoints, retries only recoverable errors
and writes ordered events. Cancellation wins every terminal race. PostgreSQL
remains authoritative across API, relay or worker restarts and task redelivery.

Versioned endpoints added in this increment are:

```text
POST   /v1/guest-sessions
POST   /v1/workspaces/:workspaceId/upload-sessions
POST   /v1/guest/upload-sessions
PUT    /v1/uploads/:uploadSessionId/content
GET    /v1/upload-sessions/:uploadSessionId
POST   /v1/upload-sessions/:uploadSessionId/resume
DELETE /v1/upload-sessions/:uploadSessionId
POST   /v1/upload-sessions/:uploadSessionId/finalise
POST   /v1/upload-sessions/:uploadSessionId/handoff
GET    /v1/jobs/:jobId
GET    /v1/jobs/:jobId/events
POST   /v1/jobs/:jobId/cancel
```

Actor APIs enforce effective permissions and owner scoping. Guest APIs require
an opaque expiring bearer whose hash alone is stored. Mutations use
idempotency keys, reject payload conflicts, record trace-linked audit events
and return normalized customer-safe errors. Ordered cursor polling satisfies
the approved polling/event-stream alternative and survives browser refresh once
the durable job exists.

## React and visual evidence

The responsive React app uses the generated `1.9.0` types and real APIs. The
upload dialog implements selection/drop, authorizing, chunk transfer, queued,
inspecting, ready, rejected, interrupted and cancelled states. Advanced details
show only upload, job and trace IDs. Accepted files refresh the real Default
Files list and non-monetary testing summary. It supports multiple files with
isolated state, cancellation and eligible-only retry. Browser refresh restores
opaque upload/job state and asks for the same local file before resuming a
transfer. The guest route discloses 24-hour expiry and preserves the exact
accepted source during sign-in handoff. Inactive editor outcomes remain inactive.

Reviewed zero-tolerance baselines cover Home and the selected upload dialog in
light/dark at `1440x900`, `768x1024`, `638x768` and `390x844`. Existing Home
baselines changed only for the new Upload action; the dark baselines also use a
high-contrast brand-ink foreground on primary buttons. Phone navigation changed
only because the Home action is visible behind its scrim, and phone Default
Files changed for its two upload actions. Two intermediate Home baselines and
eight selected-dialog baselines are new. No visual-reference HTML was copied.

Every upload-dialog visual case also runs axe and asserts document width does
not exceed viewport width. The mobile navigation landmark has a distinct
accessible name. Representative generated images were inspected manually for
dialog framing, text wrapping, target size, mobile sheet height and overflow.

## Zero-charge, security and privacy evidence

- Intake audit/usage writes use the same PostgreSQL transaction as accepted
  metadata mutations where applicable.
- Internal usage rows remain constrained to amount `0.00`, credit debit `0` and
  currency `USD`. Customer APIs return only files, storage bytes, jobs,
  high-cost-processing count and non-monetary activities; amount, currency and
  credit/debit fields are absent.
- Server logs redact authorization/query credentials and tests prohibit signed
  URL, private object key, upload token and customer-path leakage.
- No `.env`, customer/personal upload, cloud service, model, font or private
  benchmark asset was read or called.
- No customer bytes enter PostgreSQL. Local Playwright bytes are rights-cleared
  synthetic fixtures and are confined to ignored test output.
- Production remains fail closed without PostgreSQL, private GCS storage, Cloud
  Tasks dispatch configuration, worker OIDC identity and ClamAV. Customer OIDC
  provider integration remains later work; local actor headers are
  development/test evidence only.

## Executable evidence index

| Requirement | Executable code | Real deterministic/integration tests |
| --- | --- | --- |
| GCS resumable intake | `services/api/src/domains/intake/gcs-private-client.ts`, `private-object-store.ts`, `apps/web/src/boundaries/apiClient.ts` | `services/api/tests/gcs-private-object-store.test.ts`, `apps/web/tests/uploadState.test.ts` |
| Worker private GCS | `packages/storage/src/ipw/storage/private.py` | `packages/storage/tests/test_storage_boundary.py` |
| Cloud Tasks and outbox | `cloud-tasks-client.ts`, `outbox-dispatcher.ts`, `outbox-relay.main.ts` | `services/api/tests/cloud-tasks-dispatch.test.ts`, `postgres.integration.test.ts` |
| Durable processing worker | `services/processing-worker/src/ipw/processing_worker/durable_intake.py`, `repository.py`, `task_server.py` | `test_durable_intake_execution.py`, `test_postgres_worker_integration.py` |
| ClamAV fail-closed scan | `packages/inspection/src/ipw/inspection/malware.py` | `packages/inspection/tests/test_production_inspection.py` |
| Guest/multi-file UX | `apps/web/src/components/UploadDialog.tsx`, `apps/web/src/App.tsx` | `apps/web/tests/e2e/workspace.spec.ts` |
| Integrity, cancellation and cleanup | migrations `0005`-`0007`, intake/job repositories and services | `intake-foundation.test.ts`, `durable-jobs.test.ts`, `intake-cleanup.test.ts`, `postgres.integration.test.ts` |
| Audit and customer usage | worker/API repositories, generated `UsageSummary` | API product/intake/job tests and actual PostgreSQL tests |
| Safe logging | `services/api/src/common/logger.ts` | `services/api/tests/safe-logger.test.ts` |
| Licence/runtime boundaries | `packages/licence-registry`, `data/licences/production-providers.json` | `tests/test_recovery_2b_provider_licences.py`, architecture/scope tests |

## Verification evidence

The delivery runs these gates:

```text
python tools/generate_product_contracts.py --check
python -m ruff format --check .
python -m ruff check .
python -m mypy
python -m pytest
npm run typecheck
npm run test
npm run build
npm run test:e2e --workspace ipw-web
npm run test:postgres --workspace ipw-api
python -m pytest services/processing-worker/tests/test_postgres_worker_integration.py
python tools/check.py
npm audit
git diff --check
```

The actual PostgreSQL gate used a fresh trust-local PostgreSQL `17.11` cluster
on an isolated loopback port. It ran all seven migrations twice, then passed the
combined Recovery 2A/2B repository journey: tenant isolation, immutable-row and
zero-charge constraints, upload idempotency and terminal immutability, durable
lease/start/heartbeat/checkpoint/retry/cancel events, accepted actor promotion,
guest completion, identity-preserving handoff and leased cleanup. The Node
repository result is `1/1`; the Python worker result is `2/2`, including retry
audits and redelivery. The server was stopped cleanly. No `pg-mem` result is
presented as this evidence.

The web suite runs real API signed-in/guest uploads, multi-file isolation,
cancel, refresh/resume, handoff, responsive navigation, axe and visual cases.
All 37 pass. Reviewed visual comparisons use `maxDiffPixelRatio: 0`.

The final repository command was run through the existing repository
environment as `.venv\Scripts\python.exe tools/check.py`. All 18 gates passed.
The Playwright portion contained 37 passing cases. No dependency was installed
or updated during verification.

## Logical commits

Initial Recovery 2B delivery:

1. `26e86cc` - define Recovery 2B intake contracts.
2. `7dedc1f` - add secure resumable upload sessions.
3. `2f5b810` - establish durable job dispatch.
4. `e9e1d92` - integrate production file inspection.
5. `91846c0` - deliver the responsive secure upload journey.
6. `538426f` - verify and record the initial delivery.

Corrective delivery after the accepted read-only completion audit:

1. `6209b65` - implement GCS resumable intake integrity.
2. `19099d7` - connect Cloud Tasks dispatch and the processing worker.
3. `43c97f8` - enforce production scanning and protected logs.
4. `2c86e7a` - complete guest intake, audit, cleanup and usage.
5. Final verification record - preserve benchmark evidence, close deterministic
   provider tests and correct this completion record.

## Known limitations and explicit deferrals

- Official GCS and Cloud Tasks SDK paths are executable and production-selected,
  but verification used deterministic provider fakes. No credentials, real
  bucket, queue, ADC exchange or cloud endpoint was called, so deployment
  acceptance remains unproven.
- ClamAV protocol and fail-closed composition are implemented. A deployed
  service, signature-update policy and operational health checks remain
  deployment work.
- Customer identity still uses the approved local boundary; customer OIDC is
  not implemented. Worker Cloud Tasks OIDC verification is implemented.
- Event delivery uses ordered cursor polling, not server-sent events.
- Browser security prevents persisting local file bytes. Interrupted direct
  transfer recovery preserves the server upload session but requires the
  customer to reselect the same file.
- Cleanup is independently executable and leased, but no cloud scheduler or
  retention infrastructure was created.
- The current Google SDK dependency tree has two moderate transitive npm audit
  advisories through `gaxios`/`uuid`; no direct patched SDK path was available
  in the pinned versions reviewed for this task. This remains a release review
  item, not a hidden passing security gate.
- Editors, OCR, enhancement, AI/models, export, connectors, e-sign, payments,
  native applications, deployment and all Recovery 2C/later capabilities remain
  untouched.

## Rollback

1. Stop local web/API/worker and PostgreSQL processes.
2. Revert the five corrective commits and then the six initial Recovery 2B
   commits, all in reverse order on this branch.
3. Delete only isolated local/test object-store data after verifying its path.
4. For an isolated Recovery 2B database, drop the database. For any database
   containing real immutable records, restore from the approved backup/point in
   time instead of applying destructive table-level down migrations.
5. Return to accepted Recovery 2A commit
   `1ce04094a2d6d7e44bdfb6d5759dbd00b7d539d9`.
6. Rerun `python tools/check.py`, the Recovery 2A PostgreSQL gate and exact Git
   status verification.

## Acceptance mapping

| Recovery 2B criterion | Evidence |
| --- | --- |
| Executable production GCS path | `GcsSdkPrivateClient`, `GcsPrivateObjectStore`, `GcsWorkerPrivateObjectStore`; official-SDK and deterministic worker-storage tests |
| Resumable/reconnect protocol | Provider-aware generated contract, browser `308` offset parser, protected provider URI and `/resume`; GCS and Playwright refresh tests |
| Size/checksum/generation integrity | Metadata reconciliation, optional checksum contract, worker SHA-256, generation-bound read/copy and no-overwrite tests |
| Production storage fail-closed | `createPrivateObjectStore`; composition test proves production cannot select memory/filesystem |
| Executable Cloud Tasks path | `GoogleCloudTasksProviderClient`, OIDC task construction and deterministic name/redelivery tests |
| Independent durable dispatch | `OutboxDispatcher`, `relay:outbox`, row leases, success-only marking and failure release tests |
| Functioning Python worker | `IntakeTaskApplication`, `DurableIntakeProcessor`, `PostgresWorkerRepository`; task-auth, checkpoint, heartbeat and real PostgreSQL tests |
| Retry and cancellation races | Recoverable-only retry, retry audit/outbox, cancel-wins repository and worker tests |
| Production malware scanning | `ClamAvScanner`, fail-closed factory, bounded `INSTREAM` and clean/malicious/unavailable/timeout/error tests |
| Guest React journey | `/guest/upload` real API Playwright journey, explicit expiry and sign-in handoff |
| Multi-file isolation and retry | Per-item React queue and Playwright completed/unsupported-file isolation test |
| Exact immutable handoff | Memory and PostgreSQL assertions retain `AssetOriginal` and `SourceVersion` IDs |
| Permissions and tenant isolation | Independent `upload.cancel`/`job.cancel`, opaque guest bearer and cross-owner/cross-workspace tests |
| Idempotency and replay | Conflicting payload, finalisation replay, provider task redelivery and cleanup completion tests |
| Independent cleanup | `cleanup:intake`, lease migration, object removal, one-time audit and PostgreSQL concurrent-claim test |
| Complete audit categories | Inspection, reasoned rejection, retry requested/performed, cancellation requested/completed, handoff, promotion and cleanup code/tests |
| Non-monetary customer usage | Generated `UsageSummary`, API/contract tests and PostgreSQL query exclude amount/currency/credit fields; SQL zero constraints remain |
| Protected logging | URL/query/header/path/error-cause/stack redaction tests in `safe-logger.test.ts` |
| Responsive accessible UX | 37 Playwright cases, axe, no-overflow and zero-pixel baselines at all four approved sizes and themes |
| Actual PostgreSQL 17 compatibility | Fresh PostgreSQL `17.11`, all seven migrations twice, Node repository and Python worker integration tests |
| Licence and runtime boundaries | Composed production provider register, release tests and architecture guards; benchmark reports remain unchanged |
| Scope remains Recovery 2B | Deferred list and unchanged editor/model/connector/payment/native/deployment areas |

## Recommended next increment

Remain paused after Recovery 2B. Begin no Sequence C/Recovery 2C or later work
until the product owner supplies and approves an explicitly bounded next task.
