# ADR-0011: Recovery 2A Product Kernel

**Status:** Accepted by Recovery 2A approval
**Date:** 30 August 2026

## Context

Recovery 2A needs a real workspace/project/file metadata path without coupling
the production application to benchmark code or prematurely implementing media
processing, cloud storage or editors.

## Decision

1. Keep benchmark schema `v1` at `1.6.0` and create the additive production
   `product-v1` line at `1.7.0`.
2. Use PostgreSQL 17 as the approved database major. Repository tests must run
   against an actual PostgreSQL 17 server; in-memory tests are only fast domain
   evidence.
3. Keep immutable original/source identity in append-only tables. Store the
   mutable canonical location on `workspace_files` only.
4. Store reusable project/document ownership separately in
   `reusable_file_references`; moving a file does not alter these rows.
5. Store object metadata/reference only. Recovery 2A does not persist or process
   customer file bytes.
6. Make mutations transactional, tenant-scoped, audited and idempotent. Usage
   events always carry customer amount `0.00` and credit debit `0`; admin-only
   dimensions live in a separate table and response boundary.
7. Use deterministic in-memory adapters only for local development and fast
   tests. Production startup fails when `IPW_DATABASE_URL` is absent.
8. Rebuild the approved visual direction in React. The visual-reference HTML is
   documentation and cannot become a runtime dependency.

## Consequences

The production path has a stable contract and real PostgreSQL evidence while
remaining intentionally metadata-only. Authentication is still a provider
boundary with local headers outside production; OIDC integration is deferred.
No editor, processing, connector, billing, e-sign, native or deployment work is
authorized by this decision.
