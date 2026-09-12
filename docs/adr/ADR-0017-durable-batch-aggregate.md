# ADR-0017: Durable batch aggregate over independent image-export jobs

**Status:** Accepted
**Date:** 12 September 2026
**Task:** Batch Processing

## Context

The product must apply reviewed image operations across at least 50 files while
surviving browser closure, isolating failures, preserving completed outputs and
supporting safe cancellation and retry. The existing image-export job already
owns authoritative rendering, output provenance, leases, retries, checkpoints,
object storage and metadata verification. A second batch processor would duplicate
those controls and create inconsistent production behavior.

Representative previews are safe only when grouped files are materially
equivalent. Grouping by extension, recipe name or customer selection order would
not account for source and output differences.

## Decision

1. The batch is a durable aggregate, not a new processing-job kind.
2. Every included item receives its own existing `image_export` request,
   processing job and outbox message in the aggregate transaction.
3. Batch state is derived from child export state. One failed item cannot fail an
   unrelated item.
4. The compatibility digest contains the ordered recipe, normalized output
   behavior, source artboard dimensions and validated raster facts. Source
   identities are omitted only after those measured facts are validated.
5. Submission recomputes the reviewed plan and requires its exact digest, exact
   representatives, one successful authoritative preview per group and exact
   individual exception confirmations.
6. Batch groups and items are immutable after submission. Their document version,
   recipe version, outputs, exclusions and review evidence cannot drift mid-run.
7. Cancellation cancels unfinished work cooperatively and preserves completed and
   failed results.
8. Manual retry selects failed outputs only and creates a new independently leased
   job. Successful outputs and their provenance are the safe checkpoint.
9. A batch contains 1 to 50 distinct document versions and at most 200 included
   outputs. Browser preparation and preview requests run at concurrency five.
10. Reports expose group and per-file outcomes without object keys, signed URLs,
    storage generations, credentials or original bytes.

## Consequences

- Python continues to execute one authoritative image-export path for single and
  batch work; benchmark code is not promoted into production.
- Customers can close and reopen the application without affecting processing.
- Completed results survive sibling failure, cancellation and failed-only retry.
- Idempotent commands prevent duplicate aggregates and jobs on network replay.
- Material input changes invalidate review and require a newly approved plan.
- Generative reconstruction, PDF work and live cloud-provider behavior remain
  outside this decision.
