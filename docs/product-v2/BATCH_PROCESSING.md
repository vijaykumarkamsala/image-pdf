# Batch Processing

**Status:** Implemented product capability
**Date:** 12 September 2026
**Contract version:** 1.20.0

## Scope

Batch Processing applies existing, reviewed image recipes and export profiles to
multiple native image documents. The current boundary is standard deterministic
image processing only. It does not introduce generative reconstruction, PDF
processing, live provider calls or new image operations.

The customer workflow supports:

- selecting 1 to 50 distinct immutable document versions;
- explicitly including or excluding each selected document;
- grouping files with equivalent measured processing requirements;
- reviewing one authoritative worker-rendered preview per group;
- confirming only file-specific metadata, transparency or colour exceptions;
- starting, leaving and reopening a durable run;
- cancelling unfinished items without removing completed results;
- retrying failed outputs while preserving successful outputs; and
- downloading a group-level and per-file JSON report.

One request may create at most 200 included outputs. The UI currently creates one
output per included document, while the contract and orchestration boundary allow
multiple bounded output profiles for future customer workflows.

## Authority and execution boundaries

React owns selection, configuration, review, representative preview approval,
monitoring and report download. It limits document and preview preparation to five
concurrent requests so a 50-file selection cannot create an uncontrolled browser
request burst.

NestJS is authoritative for workspace permissions, input limits, source
capabilities, compatibility grouping, the reviewed plan digest, preview evidence,
durable submission, cancellation, retry, audit and zero-charge usage records. A
submission is accepted only if the server-recomputed plan has the exact digest,
group representatives, successful previews and individual exception confirmations
that the customer reviewed.

PostgreSQL stores immutable batch groups and items. Every included item receives
its own existing `image_export` request, processing job and outbox message in the
same transaction as the batch aggregate. Python therefore processes batch work
through the already-approved image export worker; no benchmark code or parallel
batch runtime is introduced into production.

## Compatibility groups

Compatibility is content-derived, not inferred from filenames or selection order.
The canonical digest includes:

- the ordered immutable recipe operations;
- normalized output behavior and source artboard dimensions; and
- the multiset of referenced raster facts: actual media type, dimensions, bit
  depth, colour model, alpha, ICC presence and sensitive-metadata count.

Source identities are deliberately removed from the digest after their measured
facts are validated. Equivalent files can therefore share a representative
preview, while a material recipe, output, source or risk difference creates a
different group. Excluded items never belong to a processing group.

## Durability, cancellation and retry

The batch aggregate does not perform image work. State is derived from the child
export requests and jobs, so closing the browser has no effect on execution and a
single failed item cannot fail unrelated items.

Cancellation changes queued child jobs directly to `cancelled` and requests
cooperative cancellation from leased or running jobs. Completed and failed
outputs are retained. Manual batch retry selects only requests containing failed
outputs, requeues only those outputs and creates a new independently leased job.
Successful output rows, object generations, checksums and provenance remain the
safe checkpoint and are never recomputed by that retry. Automatic retries within
one job continue to use the existing job checkpoint mechanism.

## API surface

All routes are workspace-scoped and require the corresponding batch permission.

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/v1/workspaces/:workspaceId/batches/plan` | Validate inputs and return the canonical review plan |
| `POST` | `/v1/workspaces/:workspaceId/batches` | Submit the exact reviewed plan idempotently |
| `GET` | `/v1/workspaces/:workspaceId/batches` | List the 50 most recent durable runs |
| `GET` | `/v1/workspaces/:workspaceId/batches/:batchId` | Read derived group and item state |
| `POST` | `/v1/workspaces/:workspaceId/batches/:batchId/cancel` | Cancel unfinished child work idempotently |
| `POST` | `/v1/workspaces/:workspaceId/batches/:batchId/retry` | Retry failed outputs only, idempotently |
| `GET` | `/v1/workspaces/:workspaceId/batches/:batchId/report` | Return the safe group and per-file report |

Mutation routes use the existing idempotency, CSRF, trace and permission
boundaries. The report contains filenames, states, checksums, byte counts and
bounded failure information; it does not contain object keys, signed URLs,
storage generations, credentials or original bytes.

## Operations and evidence

Migration `0020_batch_processing.sql` creates the aggregate tables, composite
tenant foreign keys, append-only configuration triggers and child-job links.
Operators continue to monitor and dispatch each child through the existing job
outbox. Batch events use the existing audit ledger, and usage activity records
the batch dimensions with effective customer charge fixed at zero.

Verification covers contract validation, exact plan approval, duplicate/version
and resource-bound rejection, 1/10/50-item behavior, idempotent replay, tenant
isolation, database constraints, outbox cardinality, checkpoint visibility,
cancellation, failed-only retry, reports, responsive visuals and accessibility.
The PostgreSQL 17 integration test requires `IPW_TEST_DATABASE_URL` and runs in the
canonical database CI job; it skips rather than substituting an in-memory claim
when PostgreSQL is absent locally.
