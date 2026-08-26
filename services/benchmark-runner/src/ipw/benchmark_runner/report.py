"""Deterministic report construction and rendering.

``bench report`` builds a report from **validated manifest metadata only** - no
image is opened, no processing occurs. That is exactly what POC-001 asks for:
"a command that creates an empty/example report from validated metadata".

Determinism is achieved by three rules:

1. Everything derived from the manifest lives in ``identity``; everything
   observed lives in ``environment``.
2. ``--deterministic`` pins the clock to the Unix epoch and omits ``environment``
   entirely, making the whole file byte-stable.
3. JSON is written with sorted keys, fixed indentation, no ASCII escaping and a
   single trailing newline, so two runs differ only if the content differs.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from ipw.benchmark_runner.canonical import canonical_json
from ipw.benchmark_runner.environment import probe_environment
from ipw.benchmark_runner.ids import report_id_of
from ipw.benchmark_runner.licence_register import LicenceRegister
from ipw.benchmark_runner.validation import ValidationReport
from ipw.contracts.asset import AssetCategory, GroundTruthRelationship
from ipw.contracts.licence import Disposition, RunPurpose
from ipw.contracts.manifest import AssetManifest
from ipw.contracts.operation import ADVERTISED_OPERATIONS, ProcessingVariant
from ipw.contracts.report import (
    AssetInventory,
    BenchmarkReport,
    GroundTruthSummary,
    LicenceSummary,
    ReportIdentity,
    RightsSummary,
)
from ipw.contracts.runtime import RunContext
from ipw.contracts.version import SCHEMA_VERSION

__all__ = [
    "REPORT_JSON_NAME",
    "REPORT_MARKDOWN_NAME",
    "build_report",
    "dump_report_json",
    "render_markdown",
    "write_report",
]

REPORT_JSON_NAME = "report.json"
REPORT_MARKDOWN_NAME = "report.md"


def _inventory(manifest: AssetManifest) -> AssetInventory:
    by_category: dict[AssetCategory, int] = {}
    for entry in manifest.assets:
        by_category[entry.category] = by_category.get(entry.category, 0) + 1
    return AssetInventory(
        total=len(manifest.assets),
        local_fixtures=sum(1 for e in manifest.assets if e.is_local),
        external_references=sum(1 for e in manifest.assets if not e.is_local),
        # Sorted so that dict ordering never depends on manifest ordering.
        by_category=dict(sorted(by_category.items(), key=lambda item: item[0].value)),
        total_declared_bytes=sum(e.declared_bytes for e in manifest.assets),
        total_declared_pixels=sum(e.declared_pixels for e in manifest.assets),
    )


def _rights(manifest: AssetManifest) -> RightsSummary:
    provenances = [e.provenance for e in manifest.assets if e.provenance is not None]
    return RightsSummary(
        permitted_benchmark_use=sum(1 for p in provenances if p.permitted_benchmark_use),
        public_demo_permitted=sum(1 for p in provenances if p.public_demo_permitted),
        contains_people=sum(1 for p in provenances if p.contains_people),
        contains_sensitive_information=sum(
            1 for p in provenances if p.contains_sensitive_information
        ),
        missing_provenance=sum(1 for e in manifest.assets if e.provenance is None),
    )


def _ground_truth(manifest: AssetManifest) -> GroundTruthSummary:
    counts: dict[GroundTruthRelationship, int] = {}
    for entry in manifest.assets:
        counts[entry.ground_truth] = counts.get(entry.ground_truth, 0) + 1
    return GroundTruthSummary(
        by_relationship=dict(sorted(counts.items(), key=lambda item: item[0].value)),
        with_degradation_recipe=sum(1 for e in manifest.assets if e.degradation_recipe is not None),
    )


def _licences(register: LicenceRegister | None) -> LicenceSummary:
    """Summarise the register. An absent register is reported as such, never as approval."""
    if register is None:
        return LicenceSummary()

    counts: dict[Disposition, int] = {}
    for component in register.components():
        effective = register.effective_disposition(component.component_id)
        counts[effective] = counts.get(effective, 0) + 1

    gaps = register.missing_approved_fallbacks(ADVERTISED_OPERATIONS)
    return LicenceSummary(
        register_name=register.document.name,
        component_count=len(register),
        # Sorted so dict ordering never depends on register ordering.
        by_disposition=dict(sorted(counts.items(), key=lambda item: item[0].value)),
        reference_only_count=sum(1 for c in register.components() if c.reference_only),
        components_with_supply_chain_gaps=sum(
            1 for c in register.components() if c.supply_chain_gaps()
        ),
        operations_without_approved_fallback=tuple(
            sorted(str(item.context.get("operation", "")) for item in gaps)
        ),
    )


def build_report(
    manifest: AssetManifest,
    validation: ValidationReport,
    ctx: RunContext,
    *,
    tool_version: str,
    register: LicenceRegister | None = None,
    purpose: RunPurpose = RunPurpose.INTERNAL_BENCHMARK,
) -> BenchmarkReport:
    """Build a report from validated manifest metadata.

    ``runs`` is empty by design: POC-001 integrates no processor, so nothing has
    been executed. Later tasks append :class:`~ipw.contracts.report.RunReference`
    entries without changing the surrounding structure.
    """
    if validation.manifest_digest is None or validation.manifest_sha256 is None:
        msg = "cannot build a report from a manifest that failed structural validation"
        raise ValueError(msg)

    identity = ReportIdentity(
        schema_version=SCHEMA_VERSION,
        manifest_id=manifest.manifest_id,
        manifest_name=manifest.name,
        manifest_digest=validation.manifest_digest,
        manifest_sha256=validation.manifest_sha256,
        policy_digest=validation.policy_digest,
        inventory=_inventory(manifest),
        rights=_rights(manifest),
        ground_truth=_ground_truth(manifest),
        planned_variants=tuple(ProcessingVariant),
        runs=(),
        licences=_licences(register),
        validation_passed=validation.ok,
        validation_failure_codes=tuple(sorted(validation.failure_codes)),
    )

    identity_json = identity.model_dump(mode="json")
    return BenchmarkReport(
        schema_version=SCHEMA_VERSION,
        report_id=report_id_of(identity_json),
        tool_version=tool_version,
        identity=identity,
        identity_digest=hashlib.sha256(canonical_json(identity_json)).hexdigest(),
        generated_at=ctx.clock.now().isoformat(),
        deterministic=ctx.deterministic,
        environment=None if ctx.deterministic else probe_environment(),
        default_purpose=purpose,
    )


def dump_report_json(report: BenchmarkReport) -> str:
    """Serialise a report to stable, human-readable JSON."""
    payload: dict[str, Any] = report.model_dump(mode="json")
    return json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def render_markdown(report: BenchmarkReport) -> str:
    """Render the human-readable companion to ``report.json``.

    Contains only content already present in the report, so it is exactly as
    deterministic as the JSON it accompanies.
    """
    identity = report.identity
    inventory = identity.inventory
    rights = identity.rights

    lines: list[str] = [
        f"# Benchmark report - {identity.manifest_name}",
        "",
        "Generated by the Image & PDF Workspace technical POC benchmark foundation.",
        "No image was decoded and no processor was executed to produce this report.",
        "",
        "## Identity",
        "",
        "| Field | Value |",
        "| --- | --- |",
        f"| Report id | `{report.report_id}` |",
        f"| Identity digest | `{report.identity_digest}` |",
        f"| Contract version | {report.schema_version} |",
        f"| Tool version | {report.tool_version} |",
        f"| Manifest id | `{identity.manifest_id}` |",
        f"| Manifest digest | `{identity.manifest_digest}` |",
        f"| Manifest SHA-256 | `{identity.manifest_sha256}` |",
        f"| Policy digest | `{identity.policy_digest}` |",
        f"| Generated at | {report.generated_at} |",
        f"| Deterministic mode | {'yes' if report.deterministic else 'no'} |",
        "",
        "## Corpus inventory",
        "",
        "| Field | Value |",
        "| --- | --- |",
        f"| Total assets | {inventory.total} |",
        f"| Local rights-cleared fixtures | {inventory.local_fixtures} |",
        f"| External protected-storage references | {inventory.external_references} |",
        f"| Total declared bytes | {inventory.total_declared_bytes} |",
        f"| Total declared pixels | {inventory.total_declared_pixels} |",
        "",
        "### By category",
        "",
        "| Category | Count |",
        "| --- | --- |",
    ]
    lines.extend(f"| {category} | {count} |" for category, count in inventory.by_category.items())

    lines += [
        "",
        "## Rights posture",
        "",
        "| Field | Count |",
        "| --- | --- |",
        f"| Permitted for benchmark use | {rights.permitted_benchmark_use} |",
        f"| Permitted in a public demo | {rights.public_demo_permitted} |",
        f"| Contains people | {rights.contains_people} |",
        f"| Contains sensitive information | {rights.contains_sensitive_information} |",
        f"| Missing provenance | {rights.missing_provenance} |",
        "",
        "## Ground truth",
        "",
        "| Relationship | Count |",
        "| --- | --- |",
    ]
    lines.extend(
        f"| {relationship} | {count} |"
        for relationship, count in identity.ground_truth.by_relationship.items()
    )
    lines += [
        f"| With degradation recipe | {identity.ground_truth.with_degradation_recipe} |",
        "",
        "## Planned processing variants",
        "",
    ]
    lines.extend(f"- {variant}" for variant in identity.planned_variants)

    licences = identity.licences
    lines += [
        "",
        "## Licence register",
        "",
        "| Field | Value |",
        "| --- | --- |",
        f"| Register | {licences.register_name} |",
        f"| Components | {licences.component_count} |",
        f"| Reference-only | {licences.reference_only_count} |",
        f"| Failing Gate B (supply chain) | {licences.components_with_supply_chain_gaps} |",
        f"| Gates evaluated for purpose | {report.default_purpose} |",
        "",
        "### Effective disposition",
        "",
        "| Disposition | Components |",
        "| --- | --- |",
    ]
    lines.extend(
        f"| {disposition} | {count} |" for disposition, count in licences.by_disposition.items()
    )
    lines += [
        "",
        "### Operations without an approved fallback (D-040)",
        "",
    ]
    if licences.operations_without_approved_fallback:
        lines.extend(f"- {name}" for name in licences.operations_without_approved_fallback)
        lines += [
            "",
            "Each of these is an advertised Release 1 operation with no commercially approved",
            "candidate retained. Until that changes, a licence negotiation for one of these",
            "operations is a rescue rather than an upgrade.",
        ]
    else:
        lines.append("None. Every advertised operation retains an approved candidate.")

    lines += [
        "",
        "## Runs",
        "",
        f"{len(identity.runs)} run(s) recorded.",
        "",
        "POC-001 integrates no model, no weights and no external provider, so no run has been",
        "executed. Later tasks populate this section through the same schema.",
        "",
        "## Validation",
        "",
        f"- Passed: {'yes' if identity.validation_passed else 'no'}",
        f"- Failure codes: {', '.join(identity.validation_failure_codes) or 'none'}",
        "",
    ]

    if report.environment is not None:
        env = report.environment
        lines += [
            "## Environment (observed, excluded from the identity digest)",
            "",
            "| Field | Value |",
            "| --- | --- |",
            f"| OS | {env.os_name} {env.os_release} |",
            f"| Platform | {env.platform} |",
            f"| Python | {env.python_implementation} {env.python_version} |",
            f"| Logical CPUs | {env.hardware.logical_cpus} |",
            f"| Machine | {env.hardware.machine} |",
            "",
        ]

    return "\n".join(lines)


def write_report(report: BenchmarkReport, out_dir: Path) -> tuple[Path, Path]:
    """Write ``report.json`` and ``report.md`` into ``out_dir``."""
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / REPORT_JSON_NAME
    md_path = out_dir / REPORT_MARKDOWN_NAME
    json_path.write_text(dump_report_json(report), encoding="utf-8", newline="\n")
    md_path.write_text(render_markdown(report), encoding="utf-8", newline="\n")
    return json_path, md_path
