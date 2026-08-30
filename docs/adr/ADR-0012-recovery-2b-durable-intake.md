# ADR-0012: Recovery 2B Durable Intake

**Status:** Accepted by Recovery 2B approval  
**Date:** 30 August 2026

## Context

Recovery 2A established workspace metadata, immutable original/source identity,
PostgreSQL 17 repositories and the React/NestJS boundary. It deliberately did
not accept customer bytes or execute durable work. Recovery 2B must add secure
image/PDF intake without importing POC processors into customer runtime or
mistaking queue delivery for job truth.

## Decision

1. Advance only the independent production contract line to `1.8.0`. Preserve
   benchmark schema `v1` at `1.6.0` and preserve existing Product V2 fields.
2. Authorize uploads with short-lived, owner-scoped sessions. Store bytes in a
   private quarantine object before inspection; never expose an internal object
   key or permanent public URL in customer contracts.
3. Represent an upload as a strict state machine: `initiated`, `uploading`,
   `finalising`, `inspecting`, then `ready`, `rejected`, `expired` or
   `cancelled`.
4. Keep PostgreSQL as processing-job truth. Queue adapters carry only an opaque
   job reference. Attempts, leases, heartbeats, checkpoints, cancellation,
   ordered events and an outbox are database records.
5. Promote header-first inspection into a new production Python package. The
   implementation may be derived from verified POC evidence, but production
   code cannot import `ipw.processors` or benchmark-runner modules.
6. Make malware scanning an adapter. A required but unavailable production
   scanner rejects processing; deterministic local tests include a known
   malicious signature.
7. Promote a verified object and create `ObjectReference`, `AssetOriginalRecord`,
   `SourceVersionRecord` and `WorkspaceFile` in one transaction. The immutable
   object key is owner scoped and content addressed. Deduplication never crosses
   an ownership boundary and never reveals another tenant's existence.
8. Store only a hash of an opaque guest bearer token. Guest objects remain
   private and temporary. Authenticated handoff preserves assigned asset and
   source identity.
9. Record audit and zero-charge usage events for accepted commands. No customer
   price, credit or monetary balance enters this flow.

## Consequences

Local deterministic storage, queue, scanner and worker adapters can prove the
journey without cloud credentials. Production-facing GCS and Cloud Tasks
adapters remain provider boundaries and fail closed when required configuration
or services are unavailable. Recovery 2B does not authorize editors, OCR,
enhancement, AI, export, connectors, billing, native applications or deployment.
