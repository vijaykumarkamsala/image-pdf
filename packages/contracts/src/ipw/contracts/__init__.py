"""Versioned benchmark contract for the Image & PDF Workspace POC.

This package is the single source of truth for every document the benchmark
foundation reads or writes. It is deliberately independent of the benchmark
runner so that other consumers - notably the POC-005 browser lab, which is
TypeScript - can validate against the exported JSON Schema in ``packages/schemas/v1/``
without depending on the runner.

The nine schema families required by POC-001:

============================  ========================================
Asset manifest entry          :mod:`ipw.contracts.asset`
Operation / settings          :mod:`ipw.contracts.operation`
Processor identity            :mod:`ipw.contracts.processor`
Licence disposition           :mod:`ipw.contracts.licence`
Safety inspection result      :mod:`ipw.contracts.safety`
Benchmark run                 :mod:`ipw.contracts.run`
Per-asset result              :mod:`ipw.contracts.result`
Timing / memory / cost        :mod:`ipw.contracts.measurement`
Normalised failure            :mod:`ipw.contracts.failure`
============================  ========================================
"""

from __future__ import annotations

from ipw.contracts.asset import (
    AssetCategory,
    AssetManifestEntry,
    DegradationRecipe,
    ExternalRef,
    GroundTruthRelationship,
    MediaType,
    Provenance,
)
from ipw.contracts.common import ContractModel
from ipw.contracts.environment import EnvironmentRecord, HardwareRecord
from ipw.contracts.failure import (
    FailureCategory,
    FailureCode,
    NextAction,
    NormalizedFailure,
    Severity,
    failure,
)
from ipw.contracts.licence import (
    COMMERCIAL_PURPOSES,
    ComponentKind,
    Disposition,
    LicenceDisposition,
    RunPurpose,
    WeightFormat,
    is_permitted,
    least_permissive,
)
from ipw.contracts.manifest import AssetManifest
from ipw.contracts.measurement import (
    CostBreakdown,
    Estimate,
    Measurement,
    MemoryUsage,
    ThermalState,
    Timing,
)
from ipw.contracts.operation import (
    AnySettings,
    Operation,
    OperationFamily,
    OperationKind,
    ProcessingRoute,
    ProcessingVariant,
)
from ipw.contracts.processor import (
    OutputArtifact,
    Processor,
    ProcessorIdentity,
    ProcessOutcome,
    RuntimeIdentity,
    Support,
    WeightsIdentity,
)
from ipw.contracts.product import (
    AssetOriginal,
    DocumentVersion,
    ExportRequest,
    ExportResult,
    ExportState,
    JobCheckpoint,
    JobKind,
    JobState,
    LicenceReleaseGate,
    ProcessingJob,
    ProcessorFacts,
    ProductContractModel,
    ProductError,
    Project,
    ProjectNodeKind,
    ProvenanceRecord,
    SourceVersion,
    StorageObjectRef,
    TraceContext,
    WorkspaceReference,
)
from ipw.contracts.report import (
    AssetInventory,
    BenchmarkReport,
    GroundTruthSummary,
    ReportIdentity,
    RightsSummary,
    RunReference,
)
from ipw.contracts.result import AssetResult, LedgerEntry, ResultIdentity, ResultState
from ipw.contracts.run import BenchmarkRun, RunIdentity, RunSummary
from ipw.contracts.runtime import (
    CancellationToken,
    Clock,
    FixedClock,
    InputRef,
    OriginalMutatedError,
    ProcessingCancelledError,
    RunContext,
    SystemClock,
    Workspace,
)
from ipw.contracts.safety import (
    DEFAULT_SAFETY_POLICY,
    HandlingClass,
    InspectionResult,
    Orientation,
    RiskFlag,
    SafetyPolicy,
)
from ipw.contracts.version import SCHEMA_MAJOR, SCHEMA_VERSION

__all__ = [
    "COMMERCIAL_PURPOSES",
    "DEFAULT_SAFETY_POLICY",
    "SCHEMA_MAJOR",
    "SCHEMA_VERSION",
    "AnySettings",
    "AssetCategory",
    "AssetInventory",
    "AssetManifest",
    "AssetManifestEntry",
    "AssetOriginal",
    "AssetResult",
    "BenchmarkReport",
    "BenchmarkRun",
    "CancellationToken",
    "Clock",
    "ComponentKind",
    "ContractModel",
    "CostBreakdown",
    "DegradationRecipe",
    "Disposition",
    "DocumentVersion",
    "EnvironmentRecord",
    "Estimate",
    "ExternalRef",
    "ExportRequest",
    "ExportResult",
    "ExportState",
    "FailureCategory",
    "FailureCode",
    "FixedClock",
    "GroundTruthRelationship",
    "GroundTruthSummary",
    "HandlingClass",
    "HardwareRecord",
    "InputRef",
    "InspectionResult",
    "JobCheckpoint",
    "JobKind",
    "JobState",
    "LedgerEntry",
    "LicenceDisposition",
    "LicenceReleaseGate",
    "Measurement",
    "MediaType",
    "MemoryUsage",
    "NextAction",
    "NormalizedFailure",
    "Operation",
    "OperationFamily",
    "OperationKind",
    "Orientation",
    "OriginalMutatedError",
    "OutputArtifact",
    "ProcessOutcome",
    "ProcessingCancelledError",
    "ProcessingJob",
    "ProcessingRoute",
    "ProcessingVariant",
    "Processor",
    "ProcessorFacts",
    "ProcessorIdentity",
    "ProductContractModel",
    "ProductError",
    "Project",
    "ProjectNodeKind",
    "Provenance",
    "ProvenanceRecord",
    "ReportIdentity",
    "ResultIdentity",
    "ResultState",
    "RightsSummary",
    "RiskFlag",
    "RunContext",
    "RunIdentity",
    "RunPurpose",
    "RunReference",
    "RunSummary",
    "RuntimeIdentity",
    "SafetyPolicy",
    "Severity",
    "SourceVersion",
    "StorageObjectRef",
    "Support",
    "SystemClock",
    "ThermalState",
    "Timing",
    "TraceContext",
    "WeightFormat",
    "WeightsIdentity",
    "Workspace",
    "failure",
    "is_permitted",
    "least_permissive",
]
