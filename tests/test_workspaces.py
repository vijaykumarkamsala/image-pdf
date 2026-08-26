"""Monorepo invariants.

``workspaces.toml`` is the manifest. These tests keep it honest — a declared
workspace must exist, an existing workspace must be declared — and enforce the
two structural rules that make the monorepo safe to grow:

* **Dependency direction.** ``benchmark-runner -> processors -> contracts``, never
  the reverse. A cycle here would mean the "contract is the source of truth"
  claim is untrue.
* **Stage separation (D-036).** A ``production`` workspace may never import from a
  ``poc`` workspace. There are no production workspaces yet, so the rule is
  currently vacuous — which is exactly why it should be wired now, while it costs
  nothing, rather than after the first production module exists.
"""

from __future__ import annotations

import ast
import tomllib
from pathlib import Path
from typing import Any

import pytest

WORKSPACE_PARENTS = ("apps", "packages", "services", "infra")

# Which workspace each importable module namespace belongs to.
MODULE_OWNER = {
    "ipw.contracts": "ipw-contracts",
    "ipw.processors": "ipw-processors",
    "ipw.benchmark_runner": "ipw-benchmark-runner",
}

# Permitted internal dependency edges. Anything else is a layering violation.
ALLOWED_EDGES = {
    ("ipw-contracts", "ipw-contracts"),
    ("ipw-processors", "ipw-contracts"),
    ("ipw-processors", "ipw-processors"),
    ("ipw-benchmark-runner", "ipw-contracts"),
    ("ipw-benchmark-runner", "ipw-processors"),
    ("ipw-benchmark-runner", "ipw-benchmark-runner"),
    # The application service sits above everything and is depended on by
    # nothing. Admitted deliberately: an edge list that grew by itself would
    # stop being a constraint.
    ("ipw-workspace-api", "ipw-contracts"),
    ("ipw-workspace-api", "ipw-processors"),
    ("ipw-workspace-api", "ipw-benchmark-runner"),
    ("ipw-workspace-api", "ipw-workspace-api"),
}


@pytest.fixture(scope="session")
def manifest(repo_root: Path) -> dict[str, Any]:
    return tomllib.loads((repo_root / "workspaces.toml").read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def workspaces(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = manifest["workspace"]
    return entries


class TestManifestMatchesFilesystem:
    def test_every_declared_workspace_exists(
        self, repo_root: Path, workspaces: list[dict[str, Any]]
    ) -> None:
        missing = [w["path"] for w in workspaces if not (repo_root / w["path"]).is_dir()]
        assert missing == [], f"declared in workspaces.toml but absent on disk: {missing}"

    def test_every_workspace_directory_is_declared(
        self, repo_root: Path, workspaces: list[dict[str, Any]]
    ) -> None:
        declared = {w["path"] for w in workspaces}
        found: list[str] = []
        for parent in WORKSPACE_PARENTS:
            base = repo_root / parent
            if not base.is_dir():
                continue
            found.extend(
                child.relative_to(repo_root).as_posix()
                for child in base.iterdir()
                if child.is_dir()
            )
        undeclared = sorted(set(found) - declared)
        assert undeclared == [], (
            f"workspace directories missing from workspaces.toml: {undeclared}. "
            "Every code location must declare its stage so D-036 stays enforceable."
        )

    def test_workspace_names_are_unique(self, workspaces: list[dict[str, Any]]) -> None:
        names = [w["name"] for w in workspaces]
        assert len(names) == len(set(names))

    def test_every_workspace_declares_stage_language_and_task(
        self, workspaces: list[dict[str, Any]]
    ) -> None:
        for workspace in workspaces:
            for field in ("name", "path", "language", "stage", "task", "role"):
                assert workspace.get(field), f"{workspace.get('path')} is missing {field!r}"
            assert workspace["stage"] in {"poc", "shared", "production", "tooling"}

    def test_data_locations_exist(self, repo_root: Path, manifest: dict[str, Any]) -> None:
        for key, relative in manifest["data"].items():
            assert (repo_root / relative).is_dir(), f"data.{key} -> {relative} does not exist"


class TestPythonWorkspacePackaging:
    def test_python_workspaces_with_code_declare_a_pyproject(
        self, repo_root: Path, workspaces: list[dict[str, Any]]
    ) -> None:
        for workspace in workspaces:
            if workspace["language"] != "python":
                continue
            has_source = any((repo_root / workspace["path"]).rglob("*.py"))
            if has_source:
                assert (repo_root / workspace["path"] / "pyproject.toml").is_file(), (
                    f"{workspace['name']} contains Python source but declares no pyproject.toml"
                )

    def test_namespace_packages_have_no_init(
        self, repo_root: Path, workspaces: list[dict[str, Any]]
    ) -> None:
        """``ipw`` is a PEP 420 namespace; an ``__init__.py`` there would break it."""
        for workspace in workspaces:
            namespace_root = repo_root / workspace["path"] / "src" / "ipw"
            if namespace_root.is_dir():
                assert not (namespace_root / "__init__.py").exists(), (
                    f"{workspace['name']} adds src/ipw/__init__.py, which breaks the shared "
                    "namespace and makes the other workspaces unimportable"
                )


def _internal_imports(path: Path) -> set[str]:
    """Which ``ipw.*`` workspaces a module imports from."""
    found: set[str] = set()
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            module = node.module or ""
        elif isinstance(node, ast.Import):
            module = node.names[0].name
        else:
            continue
        for prefix, owner in MODULE_OWNER.items():
            if module == prefix or module.startswith(prefix + "."):
                found.add(owner)
    return found


class TestDependencyDirection:
    def test_no_layering_violation(self, repo_root: Path, workspaces: list[dict[str, Any]]) -> None:
        violations: list[str] = []
        for workspace in workspaces:
            source_root = repo_root / workspace["path"] / "src"
            if not source_root.is_dir():
                continue
            for module in sorted(source_root.rglob("*.py")):
                for imported in _internal_imports(module):
                    edge = (workspace["name"], imported)
                    if edge not in ALLOWED_EDGES:
                        violations.append(
                            f"{module.relative_to(repo_root).as_posix()}: {edge[0]} -> {edge[1]}"
                        )
        assert violations == [], (
            "internal dependency direction violated (runner -> processors -> contracts):\n"
            + "\n".join(violations)
        )

    def test_nothing_depends_on_the_application(self, repo_root: Path) -> None:
        """The app is a consumer, never a library.

        If the benchmark ever imported the application service, a measurement
        would depend on presentation code and the two would have to move
        together. Keeping the arrow one-way is what lets the interface change
        freely.
        """
        borrowed = [
            edge
            for edge in ALLOWED_EDGES
            if edge[1] == "ipw-workspace-api" and edge[0] != "ipw-workspace-api"
        ]
        assert borrowed == [], f"something is allowed to depend on the application: {borrowed}"

    def test_contracts_depends_on_nothing_internal(self, repo_root: Path) -> None:
        """The source of truth must stay standalone, or the browser lab cannot reuse it."""
        source_root = repo_root / "packages" / "contracts" / "src"
        for module in sorted(source_root.rglob("*.py")):
            imported = _internal_imports(module) - {"ipw-contracts"}
            assert imported == set(), (
                f"{module.relative_to(repo_root).as_posix()} imports {sorted(imported)}; "
                "ipw-contracts must depend on no other workspace"
            )


class TestStageSeparation:
    """D-036: the POC must not accidentally become unreviewed production architecture."""

    def test_production_never_imports_poc(
        self, repo_root: Path, workspaces: list[dict[str, Any]]
    ) -> None:
        stage_of = {w["name"]: w["stage"] for w in workspaces}
        violations: list[str] = []

        for workspace in workspaces:
            if workspace["stage"] != "production":
                continue
            source_root = repo_root / workspace["path"] / "src"
            if not source_root.is_dir():
                continue
            for module in sorted(source_root.rglob("*.py")):
                violations.extend(
                    f"{module.relative_to(repo_root).as_posix()} imports {imported} (stage: poc)"
                    for imported in _internal_imports(module)
                    if stage_of.get(imported) == "poc"
                )

        assert violations == [], (
            "a production workspace imports POC code. Promotion must be an explicit move "
            "between workspaces, reviewed as such:\n" + "\n".join(violations)
        )

    def test_no_production_workspace_exists_yet(self, workspaces: list[dict[str, Any]]) -> None:
        """A tripwire, not a preference.

        If this fails, production code has entered the repository. That requires
        approved architecture (delivery step 3 in the blueprint), so the failure
        should prompt a review rather than an edit to this test.
        """
        production = [w["name"] for w in workspaces if w["stage"] == "production"]
        assert production == [], (
            f"production workspaces declared: {production}. Architecture approval is a "
            "prerequisite (MASTER_PRODUCT_BLUEPRINT.md section 29)."
        )


class TestContractVersionAgreesAcrossLanguages:
    """One contract version, or the two languages compute different identifiers.

    The version feeds every identifier digest. When it was a hand-written literal
    on the TypeScript side, a Python bump left the browser lab on the old value -
    and the two would then produce different ids for identical documents while
    both looked perfectly correct. POC-006's bump to 1.2.0 hit exactly that, and
    the shared canonical vectors were what noticed.

    The literal is now emitted by the generator. These tests hold that in place:
    the first says the value agrees, the second says it is not hand-written
    anywhere, which is the part that actually prevents recurrence.
    """

    def test_the_generated_typescript_carries_the_python_version(self, repo_root: Path) -> None:
        from ipw.contracts.version import SCHEMA_VERSION

        generated = (
            repo_root / "packages" / "contracts-ts" / "src" / "generated" / "contracts.ts"
        ).read_text(encoding="utf-8")
        assert f'export const SCHEMA_VERSION = "{SCHEMA_VERSION}";' in generated, (
            "the generated TypeScript contract version does not match the Python one. "
            "Run: python tools/generate_ts_contracts.py"
        )

    def test_no_typescript_source_hardcodes_a_contract_version(self, repo_root: Path) -> None:
        import re

        generated = repo_root / "packages" / "contracts-ts" / "src" / "generated"
        pattern = re.compile(r'schema_version:\s*"\d+\.\d+\.\d+"|SCHEMA_VERSION\s*=\s*"\d+\.\d+')
        offenders: list[str] = []
        for workspace in ("packages/contracts-ts", "apps/browser-lab"):
            for source in sorted((repo_root / workspace / "src").rglob("*.ts")):
                if generated in source.parents:
                    continue
                offenders.extend(
                    f"{source.relative_to(repo_root).as_posix()}: {match.group(0)}"
                    for match in pattern.finditer(source.read_text(encoding="utf-8"))
                )
        assert offenders == [], (
            "a TypeScript source hardcodes the contract version instead of importing "
            f"SCHEMA_VERSION from the generated module: {offenders}"
        )
