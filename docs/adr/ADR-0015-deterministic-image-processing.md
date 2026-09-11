# ADR-0015: Deterministic Image Processing

**Status:** Accepted for Recovery 2E
**Date:** 2 September 2026
**Task:** RECOVERY-2E

## Context

Recovery 2E needs reusable full-resolution deterministic image processing without
making the browser preview authoritative or importing the POC processor runtime.
The existing worker already has private generation-bound source reads, PostgreSQL
leases/checkpoints and Pillow 12.3.0. The corrected comparison path also needs
immutable, registered previews rendered with the same geometry and operation
semantics as export; a CSS treatment of the interactive canvas is not evidence.
The host has the Python `pyvips` binding but not a loadable native libvips
runtime, so local verification cannot honestly claim a libvips execution gate.

## Decision

1. The Python processing worker owns final image rendering and registered
   Original, Current and Recommended comparison previews. NestJS owns recipes,
   permissions, idempotency, jobs, audit, zero-charge usage and result
   registration. React's editor canvas remains an interaction proxy; comparison
   evidence is loaded from immutable worker outputs.
2. Implement one validated, versioned recipe contract shared by UI, API and
   worker. Each operation records exact parameters, order and enabled state.
3. Use Pillow 12.3.0 with its LittleCMS-backed `ImageCms` path for the bounded
   deterministic Recovery 2E execution path. Full enhancement source decode,
   native artboard, intermediates and each final output are limited to 16
   megapixels, a 12,000 pixel edge and 64 MiB source/output objects. One
   cooperative 768 MiB process-RSS/60-second budget is created after an export
   lease is claimed but before immutable source reads, and the same budget is
   reused across every requested output; adding outputs cannot reset or multiply
   the job budget. The shared worker lock serializes preparation preview, image
   export and ZIP execution within one worker application instance.

   This is a cooperative checkpoint and process-RSS guard, not an OS/container
   hard memory or CPU limit. Intake work may overlap in the process, so the RSS
   check is deliberately conservative. The durable Studio preparation preview
   has a separate 100 megapixel decoded-source admission ceiling because it
   immediately produces bounded 2,048 and 512 pixel proxies; those limits do not
   increase full enhancement capacity and that preview is not the enhancement
   comparison path.
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
8. Standard native text uses only the bundled `IPW Standard` Regular font: the
   CC0 Aileron 0.102 limited-character subset embedded by pinned Pillow 12.3.0,
   SHA-256 `69853909b940023570964e29cffe30da95aea8de3627736b5cd15ab30143143169f`.
   Browser and worker bytes are identical. External fonts, styled runs,
   unsupported glyphs, justification and advanced typography fail API export
   preflight; no font is silently substituted. Position, size, hexadecimal
   colour, opacity, rotation, artboard ownership and layer order remain native
   composition inputs.

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
same recipe, preview and output contracts after differential, packaging,
resource and live-provider checks pass.
