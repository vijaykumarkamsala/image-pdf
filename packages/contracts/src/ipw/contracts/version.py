"""Contract version.

Every serialised document produced by the benchmark foundation carries
``schema_version``. The version is semantic:

* **patch** - editorial only (descriptions, examples); no field changes.
* **minor** - additive, backwards compatible (new optional field, new enum
  member that older readers may treat as unknown).
* **major** - breaking. Requires a new ``packages/schemas/v<major>/`` directory and an
  explicit migration note in the task report.

Identifier digests incorporate this value, so a version bump intentionally
changes every derived run/result identifier. That is deliberate: results
produced under different contract versions must not silently compare equal.
"""

from __future__ import annotations

SCHEMA_VERSION = "1.6.0"
"""Version of the benchmark contract defined in :mod:`ipw.contracts`.

History
-------
``1.0.0`` POC-001. The nine schema families.
``1.1.0`` POC-002 and POC-003, additive only: run purpose and licence standing
          on runs; safety policy, orientation and detected-metadata fields on
          inspection results. Older documents remain readable; the bump changes
          every derived identifier, which is intended - results produced under
          different contract versions must not silently compare equal.
``1.2.0`` POC-006, additive only: ``MemoryUsage.python_peak_delta_bytes``. The
          existing ``peak_rss_bytes`` is a process-lifetime high-water mark, so
          when an AI run and a deterministic control execute in one process both
          report the model's peak. The first POC-006 comparison showed exactly
          that - 410 MB against a Lanczos resize - which is true of the process
          and false of the operation. A per-call figure had to become part of the
          contract rather than a footnote, or every future comparison would carry
          the same misleading number.
``1.3.0`` POC-007, additive: the ``ai_denoise`` and ``jpeg_artifact_repair``
          operation kinds with their settings models, and
          ``EXPRESSIBLE_OPERATIONS`` alongside ``ADVERTISED_OPERATIONS``.
          PRODUCT_REQUIREMENTS.md section 10 lists "advanced denoise" as an AI
          capability, but the only ``denoise`` kind belonged to the STANDARD
          family - correctly, since a median filter must never be routed to a
          model - which left AI denoise inexpressible. POC-007 needed to
          benchmark it, so the omission surfaced. Older documents remain
          readable; readers that do not know the new members should treat them
          as unknown rather than as ``denoise``, which is the whole point of
          giving them their own names.
``1.4.0`` POC-008, additive: the blinded review documents - ``ReviewPackage``,
          ``SealedKey``, ``ReviewScore`` and ``ReviewSummary`` - with the ten
          review dimensions and eight critical-failure conditions from
          benchmark plan sections 8.2 and 8.3. The package and the key are
          separate documents because they have separate audiences: a reviewer
          receives one and must not receive the other.
``1.5.0`` POC-012, additive: ``Measurement.tiling``. Tile size had been a
          processor constructor default, which is not a decision; POC-012
          requires that the selection be recorded. It sits on the result
          rather than the identity because it depends on the image, and a
          per-image value in the identity would give one processor several
          identities.
``1.6.0`` Recovery 1, additive: Product V2 foundation contracts for
          workspaces, projects, storage object references, immutable originals,
          source versions, editable document versions, processing jobs, export
          requests/results, trace context, provenance, processor facts and
          licence release gates.
"""

SCHEMA_MAJOR = "v1"
"""Directory name under ``packages/schemas/`` holding the exported JSON Schema."""

PRODUCT_SCHEMA_VERSION = "1.11.0"
"""Additive Product V2 contract line, independent from benchmark identities."""

PRODUCT_SCHEMA_MAJOR = "product-v1"
"""Directory containing production product-kernel JSON Schema documents."""
