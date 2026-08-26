# ADR-0008 — The journal is the run

**Status:** Accepted
**Date:** 25 August 2026
**Task:** POC-013 (taken out of order — see below)
**Decisions recorded:** D-065, D-066, D-067

---

## Why this task, and why now

POC-009 through POC-011 all need real material — portraits for identity
preservation, hair and glass for segmentation boundaries — and the corpus has not
arrived. POC-013 needs none: it is about *count*, *failure* and *interruption*,
all of which synthetic fixtures reproduce faithfully. It is also a prerequisite
for any real corpus run, so doing it while waiting is well-ordered rather than
opportunistic.

## Part 1 — "Closing the client does not stop cloud work" is about where state lives (D-065)

Every task before this one held a whole run in a local variable and returned it at
the end. That is fine for two fixtures and wrong for fifty images: kill the
process at item 47 and every completed result is gone. The acceptance criterion
is not really about clients at all — it is a statement about durability, and the
answer cannot be "in the caller's memory".

**Decision.** Each item's result is appended to a JSON Lines journal the moment it
completes, flushed and **fsynced** before the next item starts. The journal is the
run; the returned object is a convenience.

fsync rather than flush is deliberate. Flushing hands bytes to the operating
system; fsync asks it to commit them. The difference only appears when the machine
loses power rather than the process losing its terminal — which is precisely the
case a durability claim is about. It costs a few milliseconds per item, and the
alternative is a claim that has never been true.

The file handle is opened per record rather than held for the batch. A long-lived
handle is faster and loses whatever is buffered in it at the moment the process
dies, which is the one moment the file exists for.

## Part 2 — Crash-safety is about the half-written line (D-066)

A process killed mid-write leaves a truncated final record. The reader **discards
it and carries on** rather than refusing to parse the file.

That asymmetry is the whole design: losing one item's result is recoverable by
reprocessing it, whereas refusing to load the file would lose the forty-nine
before it too. The count of discarded records is reported rather than swallowed —
a resume that silently reprocessed an item because its record was corrupt would be
correct, but doing so without saying anything would hide the fact that the process
died.

Tested by truncating a real journal at 20%, 50%, 80% and 95% of its length, since
truncation is not a special case that politely happens at line boundaries.

## Part 3 — A skip is not a settled outcome (D-067)

This one came out of a failing test rather than a design session, and it changed
the design.

The first implementation treated `SUCCEEDED` and `SKIPPED` as terminal and
reprocessed everything else. A test then showed that a declared asset with no file
is recorded `SKIPPED`, not `FAILED` — correctly, because the processor never ran.

Which exposed the bug: an asset can be absent because it lives in **external
storage and has not been fetched yet**. Treating that skip as final would strand
it forever on a condition that had already been fixed. On a batch of one somebody
notices; on a batch of fifty nobody does.

**Decision.** Resume keeps outcomes that *concluded* and re-attempts outcomes that
*never ran*:

| state | meaning | resume |
| --- | --- | --- |
| `SUCCEEDED` | ran, worked | keep |
| `FAILED` | ran, could not finish | keep — that is `retry_failed`'s business |
| `SKIPPED` | never ran | **re-attempt** |
| `CANCELLED` | never ran | **re-attempt** |

The distinction is *was it attempted*, not *did it work*. A test proves it end to
end: an asset that is missing on the first pass and present on the second is
processed by the resume.

**Resume is not retry**, and keeping them separate matters. Resume continues work
that never happened; retry reprocesses work that happened and failed. Conflating
them would make a resume silently retry things the caller never asked it to.

## What the criteria now rest on

| criterion | mechanism |
| --- | --- |
| Per-item state and failure isolation | one journal record per item, independent |
| Retry is idempotent | `result_id` excludes `attempt`; ledger refuses duplicates |
| Corrupt inputs do not stop valid items | tested at 10 items with every third corrupt |
| Closing the client does not stop cloud work | fsynced journal, `--resume`, `batch-status` |
| Temporary artifacts are cleaned | asserted after a 50-item batch |
| Results map to the correct originals | each result's `input_sha256` checked against the manifest |

The last one is worth naming: order is not identity. The test compares every
result's recorded input digest against what the manifest declared for that
asset id, so a batch that silently transposed two items would fail even though it
produced the right number of results.

## Consequences

- Two commands: `bench batch [--resume]` and `bench batch-status`. The second
  reads a journal and runs nothing, because the point of durable state is that the
  process which started a run need not be the one that inspects it.
- No contract change. The journal is an operational artifact, not a benchmark
  document — it holds `AssetResult` records that already have a schema.
- Fifty-image fixtures are generated per test rather than committed. Fifty images
  is a lot of bytes in Git for a property that is about count, and generating them
  makes each test state its own composition.

## Still open

**This does not prove work continues on a server after a client disconnects**,
because there is no server. It proves the state model that makes such a thing
possible: run state is on disk, resumable by another process, and inspectable
without re-running. The distributed version is production architecture, not POC.
