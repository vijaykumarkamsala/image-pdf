# Recovery 2C Contract Reconciliation

**Status:** Approved implementation authority
**Date:** 31 August 2026
**Baseline:** `800d7f5a9cd74a7d819e63a280e8d62ec7e5d1c8`
**Authority:** Product V2 Consolidated Implementation Authority Sequence C and
the product-owner Recovery 2C task

## Reconciled baseline

Recovery 2B provides the real guest and authenticated resumable-intake journey,
PostgreSQL-authoritative jobs, immutable source identity, production-selected
GCS/Cloud Tasks/ClamAV adapters and non-monetary usage. Recovery 2C builds the
production web experience on those contracts; it does not replace their
security, ownership or durability rules.

| Earlier record or implementation | Recovery 2C authority | Resolution |
| --- | --- | --- |
| `docs/product-v2/README.md` still names Recovery 2A as current. | The current product-owner task starts Recovery 2C from the approved 2B remote commit. | Record this explicit successor authority here and update the current-authority pointer without rewriting historical records. |
| ADR-0012 records the initial `1.8.0` contract and provider-boundary-only state. | Corrective Recovery 2B is approved at `1.9.0` with executable official-SDK adapters. | Treat the approved Recovery 2B completion record and commit history as the later decision; preserve ADR-0012 as historical context. |
| The web app boots a local signed-in actor at `/` and exposes only Home, Projects and Files. | `/` is the public guest home; authenticated navigation exposes only Home, Projects, Files and Jobs. | Make the public route real, keep local identity as development evidence and add only real destinations. |
| Home uses a workspace-foundation message rather than current work. | Signed-in Home must aggregate recent work, attention, jobs and notifications from real APIs. | Add additive contracts, PostgreSQL queries and deterministic adapters; never substitute sample arrays. |
| Upload completion shows state but not a complete customer-facing fact view. | Recovery 2C must present verified facts and truthful recommendations without processing. | Derive presentation only from accepted source facts; add optional customer classification correction without claiming unmeasured defects or quality. |
| No notification, search or feature-state persistence exists. | Sequence C requires durable notifications, permission-aware search and server-authoritative feature state. | Add only the minimal Recovery 2C tables and endpoints for those domains. |

## Compatibility policy

- Advance the additive `product-v1` line without changing benchmark schema
  `v1`, canonical benchmark identifiers or Recovery 2B fields.
- Keep PostgreSQL as job, notification, search-authorisation and read-state
  truth. Browser state is presentation/session recovery only.
- Preserve immutable `AssetOriginalRecord` and `SourceVersionRecord` identity.
- Keep GCS, Cloud Tasks and ClamAV live-provider compatibility plus the two
  moderate transitive dependency advisories as documented release gates.
- Do not add editor-document, collaboration, connector, e-sign, billing, AI,
  OCR, export or production-profile persistence.

## Customer-truth rules

- An inactive product outcome is informative and cannot launch a fake editor.
- Intake recommendations do not modify a source and are based only on verified
  type/facts or an explicit customer classification.
- Image/PDF previews are not generated unless a separately approved safe render
  path exists. PDFs use a truthful generic representation in this increment.
- Offline UI distinguishes locally queued interaction from work accepted by the
  server. Private API responses, upload credentials and customer bytes are not
  cached by the service worker.
