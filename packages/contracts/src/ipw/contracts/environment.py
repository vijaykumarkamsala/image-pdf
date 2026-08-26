"""Observed execution environment.

AGENTS.md requires every benchmark result to record runtime and dependency
versions plus a hardware description. Those values are inherently
machine-specific, which conflicts with byte-reproducible reports - so the
contract keeps them in this separate **observation** record.

Reports carry an ``identity`` section (fully deterministic) and an
``environment`` section (this record, omitted in deterministic mode). Nothing in
here ever feeds an identity digest.

The model lives in :mod:`ipw.contracts`; the probe that fills it lives in
:mod:`ipw.benchmark_runner.environment`, which is one of the two modules allowed
to read ambient state.
"""

from __future__ import annotations

from pydantic import Field

from ipw.contracts.common import ContractModel, NonNegInt


class HardwareRecord(ContractModel):
    """Hardware description. GPU fields stay ``None`` until POC-006."""

    machine: str = "unknown"
    processor: str = "unknown"
    logical_cpus: NonNegInt = 0
    total_memory_bytes: NonNegInt | None = None
    gpu_name: str | None = None
    gpu_vram_bytes: NonNegInt | None = None
    gpu_driver: str | None = None


class EnvironmentRecord(ContractModel):
    """Runtime, dependency and hardware description for one run."""

    os_name: str = "unknown"
    os_release: str = "unknown"
    platform: str = "unknown"
    python_version: str = "unknown"
    python_implementation: str = "unknown"
    hardware: HardwareRecord = HardwareRecord()
    dependency_versions: dict[str, str] = Field(
        default_factory=dict,
        description="Installed versions of the declared runtime dependencies.",
    )
    contract_version: str = "unknown"
    notes: str | None = None
