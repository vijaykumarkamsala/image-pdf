"""Benchmark report document.

The report is split into two sections for one specific reason: AGENTS.md requires
every result to record the hardware and runtime it was produced on, while POC-001
acceptance criterion 4 requires the report to be generated **deterministically**
from the same input. Those two requirements conflict in a single flat document.

* ``identity`` - derived only from validated manifest metadata and policy. Byte
  reproducible on any machine, at any time.
* ``environment`` - observed and machine-specific. Omitted entirely in
  deterministic mode.

``identity_digest`` is the SHA-256 of the canonical ``identity`` subtree, so a
default (non-deterministic) report can still be proved equivalent to the golden
one without comparing whole files.
"""

from __future__ import annotations

from pydantic import Field

from ipw.contracts.asset import AssetCategory, GroundTruthRelationship
from ipw.contracts.common import ContractModel, DigestId, NonNegInt, Sha256Hex, SlugId
from ipw.contracts.environment import EnvironmentRecord
from ipw.contracts.licence import Disposition, RunPurpose
from ipw.contracts.operation import OperationKind, ProcessingVariant
from ipw.contracts.run import RunSummary
from ipw.contracts.version import SCHEMA_VERSION


class AssetInventory(ContractModel):
    """What the manifest contains, counted."""

    total: NonNegInt = 0
    local_fixtures: NonNegInt = 0
    external_references: NonNegInt = 0
    by_category: dict[AssetCategory, int] = Field(default_factory=dict)
    total_declared_bytes: NonNegInt = 0
    total_declared_pixels: NonNegInt = 0


class RightsSummary(ContractModel):
    """Rights posture of the corpus.

    Recorded from POC-001 so that the corpus approval conversation can happen
    before models exist. POC-002 turns these counts into gates.
    """

    permitted_benchmark_use: NonNegInt = 0
    public_demo_permitted: NonNegInt = 0
    contains_people: NonNegInt = 0
    contains_sensitive_information: NonNegInt = 0
    missing_provenance: NonNegInt = 0


class GroundTruthSummary(ContractModel):
    """Paired versus unpaired split (benchmark plan section 5.2)."""

    by_relationship: dict[GroundTruthRelationship, int] = Field(default_factory=dict)
    with_degradation_recipe: NonNegInt = 0


class LicenceSummary(ContractModel):
    """Licence posture of the register at report time (POC-002).

    Recorded in the deterministic identity section so that a report can be
    audited long after the fact: what was registered, what was approved, and
    which advertised operations had no approved fallback (D-040).
    """

    register_name: str = "none"
    component_count: NonNegInt = 0
    by_disposition: dict[Disposition, int] = Field(default_factory=dict)
    reference_only_count: NonNegInt = 0
    components_with_supply_chain_gaps: NonNegInt = 0
    """Components failing Gate B (D-039). These cannot execute at any purpose level."""
    operations_without_approved_fallback: tuple[str, ...] = ()
    """D-040 gaps. Reported, never hidden."""


class RunReference(ContractModel):
    """A run included in this report. Empty in POC-001: nothing has been processed."""

    run_id: DigestId
    processor_name: SlugId
    operation_kind: OperationKind
    summary: RunSummary = RunSummary()


class ReportIdentity(ContractModel):
    """Fully deterministic report content, derived from validated metadata only."""

    schema_version: str = Field(default=SCHEMA_VERSION, pattern=r"^\d+\.\d+\.\d+$")
    manifest_id: SlugId
    manifest_name: str
    manifest_digest: DigestId
    manifest_sha256: Sha256Hex
    policy_digest: DigestId

    inventory: AssetInventory = AssetInventory()
    rights: RightsSummary = RightsSummary()
    ground_truth: GroundTruthSummary = GroundTruthSummary()

    planned_variants: tuple[ProcessingVariant, ...] = ()
    runs: tuple[RunReference, ...] = ()
    licences: LicenceSummary = LicenceSummary()

    validation_passed: bool = True
    validation_failure_codes: tuple[str, ...] = ()


class BenchmarkReport(ContractModel):
    """The document written by ``bench report``."""

    schema_version: str = Field(default=SCHEMA_VERSION, pattern=r"^\d+\.\d+\.\d+$")
    report_id: DigestId
    tool_version: str
    identity: ReportIdentity
    identity_digest: Sha256Hex
    generated_at: str
    deterministic: bool = False
    environment: EnvironmentRecord | None = None
    default_purpose: RunPurpose = RunPurpose.INTERNAL_BENCHMARK
    """The purpose the gates were evaluated against when building this report."""
