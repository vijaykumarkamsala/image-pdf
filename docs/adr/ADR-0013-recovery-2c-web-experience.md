# ADR-0013: Recovery 2C Web Experience

**Status:** Accepted by Recovery 2C approval
**Date:** 31 August 2026

## Context

Recovery 2B established secure file intake and durable job truth, but the React
surface remains a foundation shell. Sequence C requires a production responsive
experience, real home aggregation, jobs, notifications, search, a hidden future
panel framework and truthful PWA behavior without implementing editors.

## Decision

1. Keep `apps/web` as the only customer application and implement a reusable
   semantic-token/component design system inside that workspace.
2. Make `/` the public guest home. Authenticated workspace routes remain under
   `/w/:workspaceId` and expose only Home, Projects, Files and Jobs.
3. Add one additive Recovery 2C experience migration for notifications,
   classification corrections and supporting indexes. Home, attention and
   search are server-authoritative projections over existing product records.
4. Store notification read state durably and scope every projection by actor
   membership and workspace. Search uses typed, paginated results and cannot
   query another workspace through client filters.
5. Keep the editor panel framework hidden from ordinary customers. Its state is
   versioned local layout data with validation, reset and viewport recovery.
6. Use a hand-written, versioned service worker that caches only public shell
   assets and an offline document. It must bypass `/v1`, upload URLs, credentials
   and customer files.
7. Continue using ordered polling for jobs/notifications in this increment.

## Consequences

The web application becomes installable and useful at public, signed-in,
desktop, tablet and phone boundaries without pretending that an editor or
processing capability exists. Later editor and event-stream work can reuse the
design system, panel contracts and typed search/notification boundaries without
changing current customer behavior.
