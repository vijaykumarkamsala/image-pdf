"""Benchmark run document and its content-addressed identity.

:class:`RunIdentity` contains **only declared inputs**. Timestamps, hostname,
durations, memory and attempt counts are excluded, so two identical runs on two
machines produce the same ``run_id`` and are directly comparable.

``run_nonce`` is the deliberate escape hatch: set it when you genuinely intend to
record a distinct repeat of an otherwise identical run.
"""

from __future__ import annotations

from pydantic import Field

from ipw.contracts.common import (
    AssetId,
    ContractModel,
    DigestId,
    NonNegInt,
    Sha256Hex,
    SlugId,
)
from ipw.contracts.environment import EnvironmentRecord
from ipw.contracts.licence import Disposition, GateDecision, RunPurpose
from ipw.contracts.operation import Operation, OperationFamily
from ipw.contracts.processor import ProcessorIdentity
from ipw.contracts.result import AssetResult, LedgerEntry, ResultState
from ipw.contracts.version import SCHEMA_VERSION


class ProcessorIdentityDigest(ContractModel):
    """The processor fields that make a run reproducible.

    A narrower projection of :class:`~ipw.contracts.processor.ProcessorIdentity`:
    descriptive fields (display names, notes) are excluded so that editorial
    changes do not silently change a ``run_id``.
    """

    name: SlugId
    version: str
    family: OperationFamily
    weights_sha256: Sha256Hex | None = None
    precision: str
    tile_size: int | None = None
    tile_overlap: int | None = None
    runtime_language: str
    runtime_language_version: str
    runtime_framework: str | None = None
    runtime_framework_version: str | None = None
    container_digest: Sha256Hex | None = None

    @classmethod
    def of(cls, identity: ProcessorIdentity) -> ProcessorIdentityDigest:
        return cls(
            name=identity.name,
            version=identity.version,
            family=identity.family,
            weights_sha256=identity.weights.sha256 if identity.weights else None,
            precision=identity.precision,
            tile_size=identity.tile_size,
            tile_overlap=identity.tile_overlap,
            runtime_language=identity.runtime.language,
            runtime_language_version=identity.runtime.language_version,
            runtime_framework=identity.runtime.framework,
            runtime_framework_version=identity.runtime.framework_version,
            container_digest=identity.runtime.container_digest,
        )


class RunIdentity(ContractModel):
    """The exact document hashed to produce a ``run_id``."""

    schema_version: str = Field(default=SCHEMA_VERSION, pattern=r"^\d+\.\d+\.\d+$")
    manifest_id: SlugId
    manifest_digest: DigestId
    asset_ids: tuple[AssetId, ...] = Field(
        min_length=1,
        description="Selected assets, sorted, so selection order cannot change the id.",
    )
    processor: ProcessorIdentityDigest
    operation: Operation
    policy_digest: DigestId

    # -- licence standing, part of the identity by design (D-038) ----------
    # A run's purpose and the licence disposition in force when it executed both
    # feed the run_id. A reference-only research result therefore cannot be
    # re-presented later as a production recommendation: changing either field
    # changes the digest, so the two runs are visibly different runs.
    purpose: RunPurpose = RunPurpose.INTERNAL_BENCHMARK
    component_ids: tuple[SlugId, ...] = ()
    licence_disposition: Disposition = Disposition.APPROVED
    reference_only: bool = False

    run_label: str = ""
    run_nonce: str = Field(
        default="",
        description="Set to deliberately distinguish an otherwise identical repeat run.",
    )


class RunSummary(ContractModel):
    """Per-state counts. Proves batch isolation at a glance."""

    total: NonNegInt = 0
    succeeded: NonNegInt = 0
    failed: NonNegInt = 0
    cancelled: NonNegInt = 0
    skipped: NonNegInt = 0

    @classmethod
    def of(cls, results: tuple[AssetResult, ...]) -> RunSummary:
        return cls(
            total=len(results),
            succeeded=sum(1 for r in results if r.state is ResultState.SUCCEEDED),
            failed=sum(1 for r in results if r.state is ResultState.FAILED),
            cancelled=sum(1 for r in results if r.state is ResultState.CANCELLED),
            skipped=sum(1 for r in results if r.state is ResultState.SKIPPED),
        )


class BenchmarkRun(ContractModel):
    """One processor, one operation, one selection of assets."""

    schema_version: str = Field(default=SCHEMA_VERSION, pattern=r"^\d+\.\d+\.\d+$")
    run_id: DigestId
    identity: RunIdentity
    processor: ProcessorIdentity
    summary: RunSummary = RunSummary()
    results: tuple[AssetResult, ...] = ()
    ledger: tuple[LedgerEntry, ...] = ()

    started_at: str | None = None
    finished_at: str | None = None
    environment: EnvironmentRecord | None = Field(
        default=None, description="Observed. Omitted in deterministic mode."
    )
    licence: GateDecision | None = Field(
        default=None,
        description="Gate outcome at execution time, including the markings that must travel "
        "with every result of this run.",
    )
    notes: str | None = None

    @property
    def eligible_for_commercial_recommendation(self) -> bool:
        """Whether POC-015 may cite this run as a production recommendation."""
        return self.licence is not None and self.licence.eligible_for_commercial_recommendation
