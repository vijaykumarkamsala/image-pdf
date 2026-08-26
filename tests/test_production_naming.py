"""Names that production will inherit must not be scoped to the POC.

This repository is not a throwaway. Identifiers recorded here - policy names,
component ids, storage names, manifest ids - end up in run digests, in the
licence register, and eventually in production configuration. Renaming an
identifier that has already been recorded in a content-addressed digest is not
free: every run computed under the old name becomes incomparable.

So the rule is: **name things as production would name them, now.**

What is deliberately *not* covered by this rule:

* ``workspaces.toml`` ``task = "POC-001"`` - provenance. Recording which task
  created a workspace is useful forever.
* ``stage = "poc"`` - a real lifecycle stage that production code will read to
  refuse importing unreviewed work (D-036).
* Prose in docstrings and documentation that explains when and why something was
  built.

The distinction is between *describing* the POC, which is honest history, and
*naming* things after it, which becomes technical debt the day production starts.
"""

from __future__ import annotations

import json
import re
import tomllib
from pathlib import Path
from typing import Any

import pytest

from ipw.benchmark_runner.licence_register import load_register, register_path
from ipw.benchmark_runner.policy import DEFAULT_POLICY
from ipw.contracts.safety import DEFAULT_SAFETY_POLICY

# Matches an identifier VALUE scoped to the proof of concept, e.g. "poc-default".
# Deliberately anchored to value position so prose and task provenance are untouched.
POC_SCOPED_VALUE = re.compile(r'"[a-z0-9_-]*\bpoc[-_][a-z0-9_-]*"', re.IGNORECASE)

# Fields that legitimately reference the task that produced something.
PROVENANCE_KEYS = {"task", "stage", "reviewed_by", "notes", "evidence", "description", "role"}


def _walk(node: Any, path: str = "") -> list[tuple[str, str]]:
    """Yield (json path, string value) for every string in a document."""
    found: list[tuple[str, str]] = []
    if isinstance(node, dict):
        for key, value in node.items():
            if key in PROVENANCE_KEYS:
                continue
            found.extend(_walk(value, f"{path}/{key}"))
    elif isinstance(node, list):
        for index, value in enumerate(node):
            found.extend(_walk(value, f"{path}/{index}"))
    elif isinstance(node, str):
        found.append((path, node))
    return found


class TestConfigurationValues:
    @pytest.mark.parametrize(
        "relative",
        [
            "data/licences/register.json",
            "data/manifests/example.manifest.json",
            "data/reports/example/report.json",
            "data/goldens/index.json",
        ],
    )
    def test_no_committed_document_carries_a_poc_scoped_identifier(
        self, repo_root: Path, relative: str
    ) -> None:
        document = json.loads((repo_root / relative).read_text(encoding="utf-8"))
        offenders = [
            f"{path} = {value}"
            for path, value in _walk(document)
            if re.fullmatch(r"[a-z0-9_-]*\bpoc[-_][a-z0-9_-]*", value, re.IGNORECASE)
        ]
        assert offenders == [], (
            f"{relative} carries POC-scoped identifiers that production would inherit: {offenders}"
        )

    def test_default_policy_names_are_production_neutral(self) -> None:
        for name in (DEFAULT_POLICY.name, DEFAULT_SAFETY_POLICY.name):
            assert "poc" not in name.lower(), (
                f"policy name {name!r} is scoped to the proof of concept; it will be "
                "recorded in run digests and inherited by production"
            )

    def test_no_source_default_is_poc_scoped(self, repo_root: Path) -> None:
        """Catch a POC-scoped default before it reaches a committed document."""
        offenders: list[str] = []
        for workspace in ("packages", "services"):
            for module in sorted((repo_root / workspace).rglob("*.py")):
                if "tests" in module.parts:
                    continue
                for number, line in enumerate(module.read_text(encoding="utf-8").splitlines(), 1):
                    if line.lstrip().startswith("#") or '"""' in line:
                        continue
                    if POC_SCOPED_VALUE.search(line):
                        offenders.append(
                            f"{module.relative_to(repo_root).as_posix()}:{number}: {line.strip()}"
                        )
        assert offenders == [], f"POC-scoped identifier values in source: {offenders}"


class TestIdentifierConsistency:
    """One thing, one name.

    ProcessorIdentity.name and the licence register once disagreed about the
    standard baseline - "standard-pillow" in one place, "deterministic-baseline"
    in the other, with licence_ref pointing at the register name. A run record and
    the register named the same component differently, which is precisely the kind
    of defect that surfaces as an unresolvable audit question later.
    """

    def test_a_processor_licence_ref_matches_its_own_name(self) -> None:
        from ipw.processors.standard import pillow_processor, vips_processor

        for factory in (pillow_processor, vips_processor):
            identity = factory().describe()
            assert identity.licence_ref == identity.name, (
                f"{identity.name} refers to licence component {identity.licence_ref}; a "
                "component must have exactly one identifier"
            )

    def test_every_processor_licence_ref_is_registered(self, repo_root: Path) -> None:
        from ipw.processors.standard import pillow_processor, vips_processor

        register = load_register(register_path(repo_root))
        for factory in (pillow_processor, vips_processor):
            identity = factory().describe()
            assert identity.licence_ref is not None
            assert identity.licence_ref in register, (
                f"{identity.name} points at unregistered licence component {identity.licence_ref}"
            )

    def test_the_approved_fallback_map_points_at_real_components(self, repo_root: Path) -> None:
        register = load_register(register_path(repo_root))
        for operation, component_id in register.document.approved_fallback.items():
            assert component_id in register, (
                f"approved_fallback for {operation.value} names {component_id}, which is "
                "not in the register"
            )


class TestWorkspaceNaming:
    def test_workspace_names_are_production_shaped(self, repo_root: Path) -> None:
        """Distribution names ship; they must read as products, not as experiments."""
        manifest = tomllib.loads((repo_root / "workspaces.toml").read_text(encoding="utf-8"))
        for workspace in manifest["workspace"]:
            assert "poc" not in workspace["name"].lower(), (
                f"workspace {workspace['name']} is named after the proof of concept"
            )
            assert workspace["name"].startswith("ipw-"), (
                f"{workspace['name']} does not use the product namespace"
            )

    def test_task_and_stage_provenance_is_preserved(self, repo_root: Path) -> None:
        """The counterpart: recording which task built something is not naming debt."""
        manifest = tomllib.loads((repo_root / "workspaces.toml").read_text(encoding="utf-8"))
        assert any(w["task"].startswith("POC-") for w in manifest["workspace"]), (
            "task provenance was swept away; it is history, not a name"
        )
        assert any(w["stage"] == "poc" for w in manifest["workspace"])
