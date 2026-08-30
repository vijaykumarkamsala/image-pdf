"""Recovery 1 production-boundary checks.

These tests keep the new V2 foundation as a shell with explicit boundaries:
customer runtime code must not borrow benchmark, legacy UI, or POC processor
implementation details before a later recovery task approves promotion.
"""

from __future__ import annotations

import re
import tomllib
from pathlib import Path
from typing import Any

import pytest

TEXT_SUFFIXES = {
    ".css",
    ".html",
    ".js",
    ".jsx",
    ".json",
    ".md",
    ".mjs",
    ".py",
    ".ts",
    ".tsx",
    ".toml",
}


def _read_manifest(repo_root: Path) -> list[dict[str, Any]]:
    return tomllib.loads((repo_root / "workspaces.toml").read_text(encoding="utf-8"))["workspace"]


@pytest.fixture(scope="session")
def workspaces(repo_root: Path) -> list[dict[str, Any]]:
    return _read_manifest(repo_root)


def _workspace(workspaces: list[dict[str, Any]], name: str) -> dict[str, Any]:
    for workspace in workspaces:
        if workspace["name"] == name:
            return workspace
    raise AssertionError(f"workspace {name!r} is missing from workspaces.toml")


def _text_files(root: Path) -> list[Path]:
    if not root.is_dir():
        return []
    return [
        path
        for path in sorted(root.rglob("*"))
        if path.is_file()
        and path.suffix in TEXT_SUFFIXES
        and "node_modules" not in path.parts
        and "__pycache__" not in path.parts
        and "dist" not in path.parts
    ]


def _offenders(root: Path, pattern: str) -> list[str]:
    compiled = re.compile(pattern)
    found: list[str] = []
    for source in _text_files(root):
        body = source.read_text(encoding="utf-8")
        if compiled.search(body):
            found.append(source.as_posix())
    return found


class TestCustomerRuntimeBoundaries:
    def test_react_app_does_not_import_poc_or_legacy_runtime(
        self, repo_root: Path, workspaces: list[dict[str, Any]]
    ) -> None:
        web = repo_root / _workspace(workspaces, "ipw-web")["path"]
        forbidden = (
            r"apps/workspace-legacy|apps/browser-lab|services/benchmark-runner|"
            r"ipw[./\\_-](benchmark_runner|processors|pdf|vector|metrics|workspace-api)"
        )
        assert _offenders(web / "src", forbidden) == []

    def test_nest_api_does_not_import_benchmark_legacy_or_worker_implementation(
        self, repo_root: Path, workspaces: list[dict[str, Any]]
    ) -> None:
        api = repo_root / _workspace(workspaces, "ipw-api")["path"]
        forbidden = (
            r"benchmark[-_/\\.]runner|workspace[-_/\\.]legacy|"
            r"browser[-_/\\.]lab|processing[-_/\\.]worker|ipw[./\\_-]processors"
        )
        assert _offenders(api / "src", forbidden) == []

    def test_processing_worker_does_not_own_customer_policy_or_billing(
        self, repo_root: Path, workspaces: list[dict[str, Any]]
    ) -> None:
        worker = repo_root / _workspace(workspaces, "ipw-processing-worker")["path"]
        forbidden = r"\b(billing|invoice|checkout|subscription|tenant-policy|entitlement)\b"
        assert _offenders(worker / "src", forbidden) == []


class TestManifestBoundaries:
    def test_production_workspaces_do_not_depend_on_poc_workspaces(
        self, workspaces: list[dict[str, Any]]
    ) -> None:
        stage_by_name = {w["name"]: w["stage"] for w in workspaces}
        violations = [
            f"{workspace['name']} -> {dependency}"
            for workspace in workspaces
            if workspace["stage"] == "production"
            for dependency in workspace.get("depends_on", [])
            if stage_by_name.get(dependency) == "poc"
        ]
        assert violations == []

    def test_benchmark_runner_remains_development_only_owner(
        self, workspaces: list[dict[str, Any]]
    ) -> None:
        benchmark = _workspace(workspaces, "ipw-benchmark-runner")
        assert benchmark["stage"] == "poc"
        consumers = [
            workspace["name"]
            for workspace in workspaces
            if workspace["stage"] == "production"
            and "ipw-benchmark-runner" in workspace.get("depends_on", [])
        ]
        assert consumers == []

    def test_legacy_ui_is_isolated_from_production_workspaces(
        self, workspaces: list[dict[str, Any]]
    ) -> None:
        legacy = _workspace(workspaces, "ipw-workspace-legacy")
        assert legacy["path"] == "apps/workspace-legacy"
        assert legacy["stage"] == "poc"
        production_consumers = [
            workspace["name"]
            for workspace in workspaces
            if workspace["stage"] == "production"
            and "ipw-workspace-legacy" in workspace.get("depends_on", [])
        ]
        assert production_consumers == []


class TestGeneratedContractBoundary:
    def test_generated_typescript_contract_is_marked_do_not_edit(self, repo_root: Path) -> None:
        generated = repo_root / "packages/contracts-ts/src/generated/contracts.ts"
        header = generated.read_text(encoding="utf-8").splitlines()[0]
        assert header == "// GENERATED FILE - DO NOT EDIT."
