"""Report generation is deterministic and matches the committed golden artifact.

Acceptance criterion 4.
"""

from __future__ import annotations

import json
from pathlib import Path

from ipw.benchmark_runner.licence_register import load_register, register_path
from ipw.benchmark_runner.policy import DEFAULT_POLICY
from ipw.benchmark_runner.report import (
    build_report,
    dump_report_json,
    render_markdown,
    write_report,
)
from ipw.benchmark_runner.validation import ValidationReport, validate_manifest_file
from ipw.benchmark_runner.workspace import TOOL_VERSION, find_repo_root, reports_dir
from ipw.contracts.manifest import AssetManifest
from ipw.contracts.runtime import RunContext
from ipw.contracts.version import SCHEMA_VERSION

# Derived from the monorepo root rather than from this file's location, so moving
# a workspace never silently repoints the golden comparison.
REPO_ROOT = find_repo_root()
GOLDEN_DIR = reports_dir(REPO_ROOT) / "example"
# The golden report is what `bench report` writes, and that command attaches the
# licence register. Building it any other way would compare two different documents.
REGISTER = load_register(register_path(REPO_ROOT))


def _validated(path: Path, repo_root: Path) -> tuple[AssetManifest, ValidationReport]:
    report, manifest = validate_manifest_file(path, policy=DEFAULT_POLICY, asset_root=repo_root)
    assert manifest is not None
    return manifest, report


class TestDeterminism:
    def test_two_deterministic_runs_are_byte_identical(
        self, example_manifest_path: Path, repo_root: Path, tmp_path: Path
    ) -> None:
        manifest, validation = _validated(example_manifest_path, repo_root)

        outputs = []
        for name in ("a", "b"):
            ctx = RunContext.create(temp_root=tmp_path / name, deterministic=True)
            report = build_report(
                manifest, validation, ctx, tool_version=TOOL_VERSION, register=REGISTER
            )
            json_path, md_path = write_report(report, tmp_path / name)
            outputs.append((json_path.read_bytes(), md_path.read_bytes()))

        assert outputs[0][0] == outputs[1][0], "report.json is not byte-reproducible"
        assert outputs[0][1] == outputs[1][1], "report.md is not byte-reproducible"

    def test_deterministic_mode_omits_the_observed_environment(
        self, example_manifest_path: Path, repo_root: Path, tmp_path: Path
    ) -> None:
        manifest, validation = _validated(example_manifest_path, repo_root)
        ctx = RunContext.create(temp_root=tmp_path, deterministic=True)
        report = build_report(
            manifest, validation, ctx, tool_version=TOOL_VERSION, register=REGISTER
        )

        assert report.environment is None
        assert report.deterministic is True
        assert report.generated_at == "1970-01-01T00:00:00+00:00"

    def test_default_mode_records_the_environment(
        self, example_manifest_path: Path, repo_root: Path, tmp_path: Path
    ) -> None:
        manifest, validation = _validated(example_manifest_path, repo_root)
        ctx = RunContext.create(temp_root=tmp_path, deterministic=False)
        report = build_report(
            manifest, validation, ctx, tool_version=TOOL_VERSION, register=REGISTER
        )

        assert report.environment is not None
        assert report.environment.python_version
        assert report.environment.dependency_versions.get("pydantic")
        assert report.environment.contract_version == SCHEMA_VERSION

    def test_identity_is_stable_across_modes(
        self, example_manifest_path: Path, repo_root: Path, tmp_path: Path
    ) -> None:
        """The observed environment must never influence the identity digest."""
        manifest, validation = _validated(example_manifest_path, repo_root)
        pinned = build_report(
            manifest,
            validation,
            RunContext.create(temp_root=tmp_path / "d", deterministic=True),
            tool_version=TOOL_VERSION,
            register=REGISTER,
        )
        live = build_report(
            manifest,
            validation,
            RunContext.create(temp_root=tmp_path / "l", deterministic=False),
            tool_version=TOOL_VERSION,
            register=REGISTER,
        )

        assert pinned.identity == live.identity
        assert pinned.identity_digest == live.identity_digest
        assert pinned.report_id == live.report_id


class TestGoldenArtifact:
    def test_json_matches_the_committed_golden(
        self, example_manifest_path: Path, repo_root: Path, tmp_path: Path
    ) -> None:
        manifest, validation = _validated(example_manifest_path, repo_root)
        ctx = RunContext.create(temp_root=tmp_path, deterministic=True)
        report = build_report(
            manifest, validation, ctx, tool_version=TOOL_VERSION, register=REGISTER
        )

        golden = (GOLDEN_DIR / "report.json").read_text(encoding="utf-8")
        assert dump_report_json(report) == golden, (
            "generated report.json differs from data/reports/example/report.json; "
            "regenerate with 'bench report --deterministic' and review the diff"
        )

    def test_markdown_matches_the_committed_golden(
        self, example_manifest_path: Path, repo_root: Path, tmp_path: Path
    ) -> None:
        manifest, validation = _validated(example_manifest_path, repo_root)
        ctx = RunContext.create(temp_root=tmp_path, deterministic=True)
        report = build_report(
            manifest, validation, ctx, tool_version=TOOL_VERSION, register=REGISTER
        )

        golden = (GOLDEN_DIR / "report.md").read_text(encoding="utf-8")
        assert render_markdown(report) == golden


class TestReportContent:
    def test_summarises_the_corpus_correctly(
        self, example_manifest_path: Path, repo_root: Path, tmp_path: Path
    ) -> None:
        manifest, validation = _validated(example_manifest_path, repo_root)
        ctx = RunContext.create(temp_root=tmp_path, deterministic=True)
        report = build_report(
            manifest, validation, ctx, tool_version=TOOL_VERSION, register=REGISTER
        )

        inventory = report.identity.inventory
        assert inventory.total == 2
        assert inventory.local_fixtures == 1
        assert inventory.external_references == 1
        assert report.identity.rights.missing_provenance == 0
        assert report.identity.rights.permitted_benchmark_use == 2

    def test_no_runs_are_recorded(
        self, example_manifest_path: Path, repo_root: Path, tmp_path: Path
    ) -> None:
        """POC-001 integrates no processor, so a report must claim no runs."""
        manifest, validation = _validated(example_manifest_path, repo_root)
        ctx = RunContext.create(temp_root=tmp_path, deterministic=True)
        report = build_report(
            manifest, validation, ctx, tool_version=TOOL_VERSION, register=REGISTER
        )
        assert report.identity.runs == ()

    def test_identity_digest_covers_the_identity_subtree(
        self, example_manifest_path: Path, repo_root: Path, tmp_path: Path
    ) -> None:
        import hashlib

        from ipw.benchmark_runner.canonical import canonical_json

        manifest, validation = _validated(example_manifest_path, repo_root)
        ctx = RunContext.create(temp_root=tmp_path, deterministic=True)
        report = build_report(
            manifest, validation, ctx, tool_version=TOOL_VERSION, register=REGISTER
        )

        recomputed = hashlib.sha256(
            canonical_json(report.identity.model_dump(mode="json"))
        ).hexdigest()
        assert report.identity_digest == recomputed

    def test_a_changed_manifest_changes_the_report_id(
        self, example_manifest_path: Path, repo_root: Path, tmp_path: Path
    ) -> None:
        manifest, validation = _validated(example_manifest_path, repo_root)
        ctx = RunContext.create(temp_root=tmp_path, deterministic=True)
        baseline = build_report(
            manifest, validation, ctx, tool_version=TOOL_VERSION, register=REGISTER
        )

        document = json.loads(example_manifest_path.read_text(encoding="utf-8"))
        document["name"] = "A different corpus"
        altered_path = tmp_path / "altered.json"
        altered_path.write_text(json.dumps(document), encoding="utf-8")

        altered_manifest, altered_validation = _validated(altered_path, repo_root)
        altered = build_report(
            altered_manifest,
            altered_validation,
            RunContext.create(temp_root=tmp_path / "x", deterministic=True),
            tool_version=TOOL_VERSION,
            register=REGISTER,
        )
        assert altered.report_id != baseline.report_id
