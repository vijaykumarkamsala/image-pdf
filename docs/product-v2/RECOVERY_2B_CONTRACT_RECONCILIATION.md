# Recovery 2B Contract Reconciliation

**Status:** Approved implementation record  
**Date:** 30 August 2026  
**Authority:** `PRODUCT_V2_CONSOLIDATED_IMPLEMENTATION_AUTHORITY.md`, Sequence B,
and the product-owner Recovery 2B task

## Reconciled baseline

Recovery 2A remote commit
`1ce04094a2d6d7e44bdfb6d5759dbd00b7d539d9` is the exact parent of this
delivery branch. Its PostgreSQL 17 product kernel, immutable source identities,
zero-charge ledger and responsive React workspace remain the production
foundation.

| Earlier state or evidence | Recovery 2B authority | Resolution |
| --- | --- | --- |
| `packages/storage` and `packages/jobs` exposed protocol shells only. | Real intake needs deterministic adapters and durable state. | Extend the production boundaries; PostgreSQL owns job truth and storage owns private bytes. |
| Verified inspection lived under POC `packages/processors`. | Customer runtime cannot depend on POC code. | Promote reviewed header logic into a separately declared production inspection package with no POC import. |
| `/files` accepted caller-supplied object metadata. | Customer intake must not trust filenames, media types, hashes or object keys. | Keep the 2A endpoint for compatibility evidence; the React upload journey uses upload sessions and server-derived facts only. |
| Object references were metadata-only. | Bytes must be quarantined, inspected and promoted without overwrite. | Add owner-scoped quarantine and immutable-object adapters; create source metadata only after verified promotion. |
| Jobs had no API or persisted implementation. | Refresh, retry, cancellation and reconnect require durable progress. | Add a PostgreSQL state machine, event cursor, checkpoints, leases, heartbeats and transactional outbox. |
| Local actor headers represented the only session boundary. | Guests may inspect temporary uploads without becoming workspace members. | Add opaque expiring guest sessions; authenticated handoff is explicit and preserves source identity. |

## Contract compatibility

- Product schema `product-v1` advances additively from `1.7.0` to `1.9.0`.
- Existing model fields and API resource shapes are preserved. New permission
  values and intake/job models are additive.
- Benchmark schema `v1`, canonical benchmark identifiers, POC schemas and
  benchmark evidence remain unchanged.
- API responses use the generated production version constant. No product code
  hard-codes the new version independently.
- New clients treat unknown enum values as unsupported states and continue
  polling; they do not reinterpret them as success.

## Ownership and identity

An upload session belongs to exactly one authenticated actor/workspace pair or
one guest session. Canonical file location remains mutable and separate.
Promotion assigns immutable `AssetOriginalRecord` and `SourceVersionRecord`
identity; moving or reusing the resulting file cannot modify those identities.
Guest handoff changes ownership and canonical location, not source identity.

## Explicit deferrals

Image/PDF editing, OCR, enhancement, AI/models, export, cloud connectors, e-sign,
payments, native applications and deployment remain outside Recovery 2B. GCS
and Cloud Tasks now have executable official-SDK adapters selected by production
composition. Verification uses deterministic provider fakes and makes no real
cloud call, so deployment compatibility and credentials remain unapproved.
