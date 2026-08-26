"""Per-asset result and its content-addressed identity.

The critical design point of this module is what :class:`ResultIdentity`
**excludes**: ``attempt``, timings, memory, failure state and output bytes.

Because the attempt counter is outside the identity, retrying a failed asset
regenerates the *same* ``result_id``. That single property satisfies three
separate product requirements:

* AGENTS.md - "Retry must be idempotent and must not duplicate billing/usage
  events."
* ``USER_FLOWS_AND_EDGE_CASES.md`` section 7 - "Regeneration with identical
  idempotency input should not create duplicate billing."
* ``MASTER_PRODUCT_BLUEPRINT.md`` section 7 - "Re-running an operation must
  create/reuse an idempotent result, not silently replace a version."
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import Field

from ipw.contracts.common import (
    AssetId,
    ContractModel,
    DigestId,
    NonNegInt,
    Sha256Hex,
)
from ipw.contracts.failure import NormalizedFailure
from ipw.contracts.measurement import Measurement
from ipw.contracts.operation import AnySettings, OperationKind, ProcessingVariant
from ipw.contracts.processor import OutputArtifact
from ipw.contracts.version import SCHEMA_VERSION


class ResultState(StrEnum):
    """Per-item batch state (PRODUCT_REQUIREMENTS.md section 13)."""

    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"
    SKIPPED = "skipped"


class ResultIdentity(ContractModel):
    """The exact document hashed to produce a ``result_id``.

    Every field here is a **declared input**. Nothing observed appears.
    """

    schema_version: str = Field(default=SCHEMA_VERSION, pattern=r"^\d+\.\d+\.\d+$")
    run_id: DigestId
    asset_id: AssetId
    input_sha256: Sha256Hex
    operation_kind: OperationKind
    variant: ProcessingVariant
    effective_settings: AnySettings


class LedgerEntry(ContractModel):
    """A usage event.

    The POC ledger stands in for production billing so that idempotency can be
    proved before billing exists (benchmark plan section 12: "No duplicate
    charging events in the POC ledger"). It is keyed by ``result_id``: recording
    the same result twice is a no-op, never a second entry.
    """

    result_id: DigestId
    run_id: DigestId
    asset_id: AssetId
    operation_kind: OperationKind
    units: NonNegInt = Field(default=1, description="Chargeable units. Output megapixels later.")
    recorded_at: str | None = None


class AssetResult(ContractModel):
    """One asset processed by one processor under one operation."""

    result_id: DigestId
    identity: ResultIdentity
    state: ResultState

    attempt: NonNegInt = Field(
        default=1,
        description="Attempt counter. Deliberately OUTSIDE the identity so a retry reuses "
        "the same result_id and cannot duplicate a usage event.",
    )
    output: OutputArtifact | None = None
    measurement: Measurement = Measurement()
    failure: NormalizedFailure | None = None
    nondeterministic: bool = False

    started_at: str | None = None
    finished_at: str | None = None

    @property
    def run_id(self) -> str:
        return self.identity.run_id

    @property
    def asset_id(self) -> str:
        return self.identity.asset_id
