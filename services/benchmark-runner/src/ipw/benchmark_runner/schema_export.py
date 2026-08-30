"""Export the contract as JSON Schema.

The POC-005 browser lab is TypeScript. It must emit results that satisfy the same
contract as the Python runner, and the only honest way to guarantee that without
maintaining two hand-written implementations is to generate the schema from the
single source of truth and have both sides validate against it.

The exported files are committed. ``bench schema export --check`` fails when the
committed files no longer match the models, so schema drift is a CI failure
rather than a discovery made during POC-005 integration.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from ipw.benchmark_runner.policy import ValidationPolicy
from ipw.benchmark_runner.validation import ValidationReport
from ipw.benchmark_runner.workspace import schemas_dir as _schemas_dir
from ipw.contracts.failure import NormalizedFailure
from ipw.contracts.licence import LicenceDisposition
from ipw.contracts.manifest import AssetManifest
from ipw.contracts.measurement import Estimate, Measurement
from ipw.contracts.operation import Operation
from ipw.contracts.processor import ProcessorIdentity, ProcessOutcome
from ipw.contracts.product import (
    AssetOriginal,
    DocumentVersion,
    ExportRequest,
    ExportResult,
    LicenceReleaseGate,
    ProcessingJob,
    ProcessorFacts,
    ProductError,
    Project,
    ProvenanceRecord,
    SourceVersion,
    StorageObjectRef,
    TraceContext,
    WorkspaceReference,
)
from ipw.contracts.report import BenchmarkReport
from ipw.contracts.result import AssetResult
from ipw.contracts.review import (
    ReviewPackage,
    ReviewScore,
    ReviewSummary,
    SealedKey,
)
from ipw.contracts.run import BenchmarkRun
from ipw.contracts.safety import InspectionResult
from ipw.contracts.version import SCHEMA_MAJOR

__all__ = ["SCHEMA_EXPORTS", "check_schemas", "export_schemas", "schema_json", "schemas_dir"]

SCHEMA_EXPORTS: dict[str, type[BaseModel]] = {
    # The nine schema families required by POC-001, plus the documents the CLI
    # and the browser lab exchange.
    "asset-manifest": AssetManifest,
    "operation": Operation,
    "processor-identity": ProcessorIdentity,
    "licence-disposition": LicenceDisposition,
    "inspection-result": InspectionResult,
    "benchmark-run": BenchmarkRun,
    "asset-result": AssetResult,
    "measurement": Measurement,
    "normalized-failure": NormalizedFailure,
    # Supporting documents.
    "estimate": Estimate,
    "process-outcome": ProcessOutcome,
    "benchmark-report": BenchmarkReport,
    "validation-report": ValidationReport,
    "validation-policy": ValidationPolicy,
    # Blinded human review (POC-008). The package and the sealed key are exported
    # separately on purpose: they are two documents with two audiences, and a
    # consumer that could not tell them apart would be one careless join away from
    # unblinding a review.
    "review-package": ReviewPackage,
    "sealed-key": SealedKey,
    "review-score": ReviewScore,
    "review-summary": ReviewSummary,
    # Product V2 foundation contracts (Recovery 1). These are exported through
    # the existing path so every language sees the same source of truth.
    "workspace-reference": WorkspaceReference,
    "project": Project,
    "asset-original": AssetOriginal,
    "source-version": SourceVersion,
    "document-version": DocumentVersion,
    "processing-job": ProcessingJob,
    "export-request": ExportRequest,
    "export-result": ExportResult,
    "storage-object-ref": StorageObjectRef,
    "product-error": ProductError,
    "trace-context": TraceContext,
    "provenance-record": ProvenanceRecord,
    "processor-facts": ProcessorFacts,
    "licence-release-gate": LicenceReleaseGate,
}


def schemas_dir(repo_root: Path) -> Path:
    """Generated JSON Schema lives in its own workspace, consumed by every language."""
    return _schemas_dir(repo_root, SCHEMA_MAJOR)


def schema_json(model: type[BaseModel], name: str) -> str:
    """Render one model's JSON Schema deterministically."""
    schema: dict[str, Any] = model.model_json_schema(mode="serialization")
    schema["$id"] = (
        f"https://image-pdf-workspace.packages/schemas/{SCHEMA_MAJOR}/{name}.schema.json"
    )
    schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    return json.dumps(schema, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def export_schemas(repo_root: Path) -> list[Path]:
    """Write every schema file. Returns the paths written."""
    target = schemas_dir(repo_root)
    target.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for name, model in sorted(SCHEMA_EXPORTS.items()):
        path = target / f"{name}.schema.json"
        path.write_text(schema_json(model, name), encoding="utf-8", newline="\n")
        written.append(path)
    return written


def check_schemas(repo_root: Path) -> tuple[bool, list[str]]:
    """Verify the committed schema files match the models. Returns ``(ok, problems)``."""
    target = schemas_dir(repo_root)
    problems: list[str] = []
    expected_names = {f"{name}.schema.json" for name in SCHEMA_EXPORTS}

    for name, model in sorted(SCHEMA_EXPORTS.items()):
        path = target / f"{name}.schema.json"
        if not path.is_file():
            problems.append(f"missing exported schema: {path.name}")
            continue
        if path.read_text(encoding="utf-8") != schema_json(model, name):
            problems.append(
                f"schema drift: {path.name} does not match the model; "
                f"run 'bench schema export' and review the diff"
            )

    if target.is_dir():
        problems.extend(
            f"orphaned schema file: {path.name}"
            for path in sorted(target.glob("*.schema.json"))
            if path.name not in expected_names
        )

    return not problems, problems
