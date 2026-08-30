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
Guest API sessions can complete the same temporary intake and explicitly hand
an accepted source to a signed-in workspace without changing its assigned
asset-original or source-version identity.

No editor, image/PDF processing operation, AI capability, cloud connector,
e-sign, payment, native application or deployment was added.

## Contracts and migrations

- Product contract version advances additively from `1.7.0` to `1.8.0` under
  the existing `product-v1` compatibility line. The benchmark contract remains
  `1.6.0` and unchanged.
- New generated contracts cover guest sessions, upload authorization and
  constraints, upload records/states, source facts, intake failures, durable
  jobs/states, ordered job events and the added upload/job permissions.
- Thirty-nine Product V2 JSON schemas and their TypeScript views are generated
  from the Python source of truth. Existing Recovery 2A fields remain valid.
- `0002_recovery_2b_upload_sessions.sql` adds guest/upload sessions,
  idempotency and strict owner/state constraints.
- `0003_recovery_2b_durable_jobs.sql` adds processing jobs, attempts, leases,
  checkpoints, ordered events and the transactional dispatch outbox.
- `0004_recovery_2b_guest_handoffs.sql` adds explicit identity-preserving guest
  handoff records and transactional promotion into workspace metadata.

Canonical `WorkspaceFile` location remains separate from reusable project or
document references. Intake creates immutable `AssetOriginalRecord` and
`SourceVersionRecord` identity only after accepted promotion. Moving a file or
adding a reusable reference cannot change those identities.

## Intake and private storage

- Upload sessions are owner scoped to one actor/workspace or one guest session.
- Authorizations are short lived and contain no permanent public URL or object
  key. Browser credentials are never persisted or shown in Advanced details.
- The local client sends 4 MiB chunks with an explicit `Upload-Offset`; the API
  rejects conflicting offsets and byte-limit violations.
- Bytes enter a private quarantine object. The server derives digest, media
  type and source facts, then copies accepted bytes to an owner-scoped,
  content-addressed immutable object before committing source metadata.
- Cross-owner lookup returns not found and content reuse never reveals or
  shares another tenant's object.
- Memory and private-filesystem adapters are deterministic local evidence. The
  GCS adapter is a production provider boundary only; production startup fails
  closed until a configured private client is supplied.
- Cancellation removes quarantine data. Expired-session cleanup is
  deterministic and runs at intake-session creation; scheduling the retention
  sweep operationally is deferred to deployment work.

## Inspection and malware controls

`packages/inspection` is a production Python workspace with no import from
`ipw.processors`, `ipw.benchmark_runner` or another POC runtime. It validates
content signatures before trusting names or declared types and derives SHA-256,
byte size, dimensions, pixel count, orientation, frame/page count, alpha, bit
depth, ICC presence and sensitive-metadata indicators where supported.

The boundary rejects zero-byte, truncated, spoofed, corrupt, excessive
dimension/page/pixel, active-PDF and decompression-risk inputs with normalized
failures. Malware scanning is an adapter; deterministic tests reject the EICAR
marker. Production uses a required-scanner-unavailable adapter and fails closed
until an approved scanner is configured. TIFF/HEIF signatures are recognized,
but unsupported structures are safely rejected rather than partially decoded.

The local NestJS executor provides deterministic end-to-end development
evidence. The production Python worker consumes the independent inspection
package and preserves the React/NestJS/Python technology boundary.

## Durable jobs and APIs

PostgreSQL is job truth. Queue adapters carry an opaque job reference only.
The repository owns attempts, lease tokens/hashes, expiry, heartbeat,
checkpoints, retry scheduling, cancellation, terminal outcomes, ordered event
cursors and transactional outbox delivery. Batch and repository tests prove
that one file's failure does not change another file's outcome.

Versioned endpoints added in this increment are:

```text
POST   /v1/guest-sessions
POST   /v1/workspaces/:workspaceId/upload-sessions
POST   /v1/guest/upload-sessions
PUT    /v1/uploads/:uploadSessionId/content
GET    /v1/upload-sessions/:uploadSessionId
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

The responsive React app uses the generated `1.8.0` types and real APIs. The
upload dialog implements selection/drop, authorizing, chunk transfer, queued,
inspecting, ready, rejected, interrupted and cancelled states. Advanced details
show only upload, job and trace IDs. Accepted files refresh the real Default
Files list and non-monetary testing summary. Inactive editor outcomes remain
inactive.

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
- Every customer usage event remains constrained to amount `0.00`, credit debit
  `0` and currency `USD`; no price, credit or monetary balance is exposed in the
  customer UI.
- Server logs redact authorization/query credentials and tests prohibit signed
  URL, private object key, upload token and customer-path leakage.
- No `.env`, customer/personal upload, cloud service, model, font or private
  benchmark asset was read or called.
- No customer bytes enter PostgreSQL. Local Playwright bytes are rights-cleared
  synthetic fixtures and are confined to ignored test output.
- Production remains fail closed without PostgreSQL, private GCS storage and a
  required malware scanner. OIDC provider wiring remains a later security task;
  local actor headers are development/test evidence only.

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
python tools/check.py
git diff --check
```

The actual PostgreSQL gate used a fresh trust-local PostgreSQL `17.11` cluster
on an isolated loopback port. It ran all four migrations twice, then passed the
combined Recovery 2A/2B repository journey: tenant isolation, immutable-row and
zero-charge constraints, upload idempotency and terminal immutability, durable
lease/start/heartbeat/checkpoint/retry/cancel events, accepted actor promotion,
guest completion and identity-preserving handoff. Result: `1/1` passed. The
server was stopped cleanly. No `pg-mem` result is presented as this evidence.

The web suite runs a real API accepted-upload journey and an interrupted-transfer
cancellation journey. Its reviewed visual comparison is deterministic and uses
`maxDiffPixelRatio: 0`.

The final repository command was run through the existing repository
environment as `.venv\Scripts\python.exe tools/check.py`. All 18 gates passed.
The Playwright portion contained 33 passing cases. No dependency was installed
or updated during verification.

## Logical commits

1. `26e86cc` - define Recovery 2B intake contracts.
2. `7dedc1f` - add secure resumable upload sessions.
3. `2f5b810` - establish durable job dispatch.
4. `e9e1d92` - integrate production file inspection.
5. `91846c0` - deliver the responsive secure upload journey.
6. Final verification record - this document, test-harness corrections and the
   completed gate evidence.

## Known limitations and explicit deferrals

- GCS and Cloud Tasks have production-facing contracts/adapters but no approved
  provider client is configured or called. Production fails closed.
- A production malware provider is not selected. The required production
  adapter fails closed; deterministic local scanning is evidence only.
- Event delivery uses ordered cursor polling, not server-sent events.
- Active durable jobs reconnect after finalisation. Pre-finalisation upload
  credentials are intentionally not persisted; an interrupted browser session
  may require file reselection before expiry cleanup.
- Retention cleanup is implemented as a deterministic operation but not wired
  to a deployed scheduler.
- Production OIDC/session validation, notification delivery and deployment
  operations remain outside this increment.
- Editors, OCR, enhancement, AI/models, export, connectors, e-sign, payments,
  native applications and all Recovery 2C/later capabilities remain untouched.

## Rollback

1. Stop local web/API/worker and PostgreSQL processes.
2. Revert the six Recovery 2B commits in reverse order on this branch.
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
| Authorized authenticated and guest intake | Owner-scoped APIs, permission tests and guest token-hash tests |
| Private resumable transfer and quarantine | Offset-aware adapters, limits, cancellation cleanup and accepted promotion tests |
| Server-derived safe source facts | Production inspection package and spoof/corrupt/bomb/metadata fixtures |
| Malware fail-closed behavior | Scanner adapter, EICAR rejection and unavailable-production-scanner tests |
| PostgreSQL durable job truth | Migration/repository tests for attempts, leases, heartbeat, checkpoints, retry, cancel, terminal states and outbox |
| Queue is dispatch only | Opaque local/Cloud Tasks queue contracts and outbox tests |
| Per-file and tenant isolation | Batch-failure, owner-scope, cross-tenant and no-dedup-leak tests |
| Ordered reconnectable status/events | Cursor API, monotonic event tests and React session recovery |
| Guest signed-in handoff preserves identity | Memory and actual PostgreSQL handoff assertions |
| Immutable original/source and independent location | Promotion transaction, immutable triggers and Recovery 2A reference invariants |
| Idempotency, audit and trace behavior | Replay/conflict, audit and normalized-error tests |
| Zero customer charge | Contract literals, SQL checks, API tests and customer-copy assertions |
| Responsive accessible real-API React journey | Playwright accepted/cancel journeys, axe and zero-pixel baselines at four widths/light/dark |
| Actual PostgreSQL 17 compatibility | Fresh PostgreSQL `17.11`, all migrations twice, `1/1` integration test passed |
| POC/customer-runtime separation | Workspace layering tests and no production import from processors/benchmark runner |
| Scope remains Recovery 2B | Deferred list, unchanged editors/models/connectors/payments/native/deployment areas |

## Recommended next increment

Remain paused after Recovery 2B. Begin no Sequence C/Recovery 2C or later work
until the product owner supplies and approves an explicitly bounded next task.
