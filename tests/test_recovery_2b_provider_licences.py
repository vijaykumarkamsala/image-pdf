from __future__ import annotations

import json
import re
from pathlib import Path

from ipw.benchmark_runner.licence_register import load_register, register_path
from ipw.contracts.licence import Disposition

PYTHON_PROVIDER_CLOSURE = {
    "certifi": "2026.7.22",
    "charset-normalizer": "3.5.1",
    "google-api-core": "2.34.0",
    "google-auth": "2.57.0",
    "google-cloud-core": "2.7.0",
    "google-cloud-storage": "3.13.1",
    "google-crc32c": "1.8.0",
    "google-resumable-media": "2.10.2",
    "googleapis-common-protos": "1.75.2",
    "idna": "3.19",
    "proto-plus": "1.28.4",
    "protobuf": "7.36.0",
    "pyasn1": "0.6.4",
    "pyasn1-modules": "0.4.2",
    "requests": "2.34.2",
    "urllib3": "2.7.0",
}

NODE_PROVIDER_COMPONENTS = {
    "@google-cloud/storage": ("8.0.1", "google-cloud-storage-node"),
    "@google-cloud/tasks": ("7.0.0", "google-cloud-tasks-node"),
}

APPROVED_NODE_LICENCES = {
    "0BSD",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "ISC",
    "MIT",
    "MPL-2.0",
}


def _constraint_versions(path: Path) -> dict[str, str]:
    found: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r"([A-Za-z0-9_.-]+)==([^\s]+)", line)
        if match:
            found[match.group(1).lower()] = match.group(2)
    return found


def test_python_provider_closure_is_pinned_registered_and_approved(repo_root: Path) -> None:
    constraints = _constraint_versions(repo_root / "requirements-dev.lock.txt")
    register = load_register(register_path(repo_root))

    for name, version in PYTHON_PROVIDER_CLOSURE.items():
        assert constraints.get(name) == version, f"{name} is not pinned to {version}"
        component = register.get(name)
        assert component is not None, f"{name} is absent from the licence register"
        assert component.pinned_version == version
        assert component.disposition is Disposition.APPROVED
        assert component.supply_chain_gaps() == ()


def test_node_lock_has_exact_provider_sdks_and_reviewed_licences(repo_root: Path) -> None:
    lock = json.loads((repo_root / "package-lock.json").read_text(encoding="utf-8"))
    packages = lock["packages"]
    register = load_register(register_path(repo_root))

    for package_name, (version, component_id) in NODE_PROVIDER_COMPONENTS.items():
        package = packages[f"node_modules/{package_name}"]
        assert package["version"] == version
        assert package["license"] == "Apache-2.0"
        component = register.get(component_id)
        assert component is not None
        assert component.pinned_version == version
        assert component.disposition is Disposition.APPROVED
        assert component.supply_chain_gaps() == ()

    missing_licence = {"busboy": "busboy", "streamsearch": "streamsearch"}
    for package_path, package in packages.items():
        if not package_path.startswith("node_modules/") or package.get("link"):
            continue
        package_name = package_path.removeprefix("node_modules/")
        licence = package.get("license")
        if licence is None:
            fallback_component_id = missing_licence.get(package_name)
            assert fallback_component_id is not None, (
                f"{package_name} has no locked licence metadata"
            )
            component = register.get(fallback_component_id)
            assert component is not None
            assert component.disposition is Disposition.APPROVED
        else:
            assert licence in APPROVED_NODE_LICENCES, (
                f"{package_name}@{package.get('version')} has unreviewed licence {licence}"
            )


def test_clamav_service_is_pinned_and_commercially_approved(repo_root: Path) -> None:
    component = load_register(register_path(repo_root)).get("clamav-service")
    assert component is not None
    assert component.pinned_version == "1.5.3"
    assert component.disposition is Disposition.APPROVED
    assert component.supply_chain_gaps() == ()
