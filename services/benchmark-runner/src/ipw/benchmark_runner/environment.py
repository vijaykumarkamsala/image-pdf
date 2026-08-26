"""Probe the observed execution environment.

Together with :mod:`ipw.contracts.runtime`, this is one of only two modules
permitted to read ambient state. Everything it produces lands in the
``environment`` section of a report and is excluded from every identity digest.
"""

from __future__ import annotations

import os
import platform
import sys
from importlib import metadata

from ipw.contracts.environment import EnvironmentRecord, HardwareRecord
from ipw.contracts.version import SCHEMA_VERSION

__all__ = ["RUNTIME_DEPENDENCIES", "dependency_versions", "probe_environment"]

RUNTIME_DEPENDENCIES: tuple[str, ...] = ("pydantic", "pillow", "pyvips", "torch", "numpy")
"""The complete runtime dependency register for the benchmark foundation.

POC-001 acceptance criterion 8 ("No model, weight or external provider is
integrated") is asserted against this tuple in
``tests/test_scope_and_artifacts.py``. Adding an entry requires an approved task
and a licence disposition record.

torch and numpy joined at POC-006. Their *versions* are reported here because a
result is only reproducible against a known build; importing them is a separate
matter and remains confined to the AI adapter package.
"""


def dependency_versions() -> dict[str, str]:
    """Installed versions of the declared runtime dependencies."""
    versions: dict[str, str] = {}
    for name in RUNTIME_DEPENDENCIES:
        try:
            versions[name] = metadata.version(name)
        except metadata.PackageNotFoundError:  # pragma: no cover - only if uninstalled
            versions[name] = "not-installed"
    return versions


def probe_environment() -> EnvironmentRecord:
    """Capture the current machine and runtime description."""
    hardware = HardwareRecord(
        machine=platform.machine() or "unknown",
        processor=platform.processor() or "unknown",
        logical_cpus=os.cpu_count() or 0,
        total_memory_bytes=None,
        gpu_name=None,
        gpu_vram_bytes=None,
        gpu_driver=None,
    )
    return EnvironmentRecord(
        os_name=platform.system() or "unknown",
        os_release=platform.release() or "unknown",
        platform=platform.platform() or "unknown",
        python_version=platform.python_version(),
        python_implementation=platform.python_implementation(),
        hardware=hardware,
        dependency_versions=dependency_versions(),
        contract_version=SCHEMA_VERSION,
        notes=(
            "No GPU probe is performed in POC-001; GPU fields are populated from POC-006 "
            "onward. Recorded from "
            f"CPython {sys.version_info.major}.{sys.version_info.minor}."
        ),
    )
