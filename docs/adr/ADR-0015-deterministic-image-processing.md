# ADR-0015: Deterministic Image Processing

**Status:** Accepted for Recovery 2E
**Date:** 2 September 2026
**Task:** RECOVERY-2E

## Context

Recovery 2E needs reusable full-resolution deterministic image processing without
making the browser preview authoritative or importing the POC processor runtime.
The existing worker already has private generation-bound source reads, PostgreSQL
leases/checkpoints and Pillow 12.3.0 for bounded preview generation. The host has
the Python `pyvips` binding but not a loadable native libvips runtime, so local
verification cannot honestly claim a libvips execution gate.

## Decision

1. The Python processing worker owns final image rendering. NestJS owns recipes,
   permissions, idempotency, jobs, audit, zero-charge usage and result
   registration. React renders only an explicitly labelled interactive proxy.
2. Implement one validated, versioned recipe contract shared by UI, API and
   worker. Each operation records exact parameters, order and enabled state.
3. Use Pillow 12.3.0 for the bounded deterministic Recovery 2E execution path.
   Enforce compressed-byte, decoded-pixel, dimension, memory, time and output
   limits before decode and encode. Pillow is justified here because the
   supported codecs and operations need metadata/ICC behavior already exercised
   by the current worker and the path remains bounded.
4. Keep an engine boundary that records `pillow`, its exact runtime version and
   deterministic status in provenance. libvips remains the preferred production
   engine for streaming/tiled large-image routes after an executable runtime,
   golden-output comparison and packaging review pass.
5. Never import `ipw.processors`, benchmark-runner, PDF, vector or model code in
   the production worker. Existing POC processors remain evidence only.
6. Standard 2x/4x scaling uses conventional resampling and is always labelled
   `Standard resampling (not AI reconstruction)`.
7. Unsupported combinations fail with a customer-safe capability error. They
   are never silently approximated.

## Determinism and fidelity

- Apply EXIF orientation exactly once before recipe operations.
- Render every output from immutable source bytes plus the selected native
  document version and recipe version; never from a prior lossy export.
- Fixed operation order, fixed encoder options and exact runtime versions are
  recorded.
- Golden outputs are byte-exact at pinned versions. Pixel metrics support
  engineering review but do not replace visual acceptance.
- Multi-output failure is isolated. Completed outputs remain registered and are
  not removed by cancellation of pending work.

## Consequences

The initial production-shaped path is executable and bounded on the current
host. Large streaming/tiled libvips execution remains a release gate rather than
an implied capability. A future libvips adapter may replace Pillow behind the
same recipe and processor boundary without changing customer contracts.

