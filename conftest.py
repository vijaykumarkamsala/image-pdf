"""Shared fixtures and the two session-wide guards.

**Network guard.** Any attempt to open a socket during the test session fails
loudly. POC-001 acceptance criterion 8 is "No model, weight or external provider
is integrated"; a test suite that silently reaches the network would make that
claim unverifiable. It also pre-establishes benchmark plan Gate B ("network
access disabled during inference").

**Fixture-integrity guard.** Every committed fixture is hashed at session start
and again at session end. This is the mechanical proof of acceptance criterion 6
("Original fixture hash is unchanged before and after all tests"). Together with
the per-call check in ``ipw.processors.base``, a processor that corrupts an
original mid-session is caught even if it politely restores the bytes afterwards.
"""

from __future__ import annotations

import ipaddress
import socket
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest

from ipw.benchmark_runner.fixtures import compute_fixture_hashes
from ipw.benchmark_runner.policy import DEFAULT_POLICY, ValidationPolicy
from ipw.benchmark_runner.workspace import manifests_dir
from ipw.contracts.manifest import AssetManifest
from ipw.contracts.runtime import RunContext

# conftest.py sits at the monorepo root, so every workspace test tree inherits
# these session guards without duplicating them.
REPO_ROOT = Path(__file__).resolve().parent


class NetworkAccessDuringTestsError(RuntimeError):
    """Raised when a test attempts to open a network connection."""


# Loopback is not the network. The guard below exists so no test can quietly
# download a model, a weight file or a result from an external provider - a
# downloaded artefact would make a measurement unreproducible and, worse, could
# make a benchmark look like it passed on this machine when it would fail on
# another. A connection to 127.0.0.1 reaches a server the test itself started
# moments earlier and cannot fetch anything from anywhere.
#
# Banning it too would not make the suite safer; it would make the HTTP layer
# untestable, and an untested request path is where a customer meets the first
# bug. So the ban is on leaving this machine, which is what was meant all along.
_LOOPBACK_NAMES = frozenset({"localhost", ""})


def _is_loopback(address: object) -> bool:
    """True only for an address that cannot leave this machine.

    The host is parsed as an IP rather than matched as a string. A prefix test
    such as ``startswith("127.")`` accepts ``127.0.0.1.evil.example``, which is
    a hostname that resolves wherever its owner points it - so the one check
    meant to keep traffic on this machine would be the one letting it off.
    """
    if not isinstance(address, tuple) or not address:
        return False
    host = address[0]
    if not isinstance(host, str):
        return False
    if host in _LOOPBACK_NAMES:
        return True
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        # Any other name would need resolving to judge, and resolving it here
        # would be the network call this guard exists to prevent.
        return False


@pytest.fixture(autouse=True, scope="session")
def _block_network() -> Iterator[None]:
    """Fail any test that tries to reach off this machine."""
    # Held as separate names rather than a dict: a dict of heterogeneous
    # callables types as `object`, and the resulting calls need suppressions
    # that would hide a genuine mistake alongside the noise.
    real_connect: Callable[..., Any] = socket.socket.connect
    real_connect_ex: Callable[..., Any] = socket.socket.connect_ex
    real_create_connection: Callable[..., Any] = socket.create_connection

    def refuse(address: object) -> None:
        msg = (
            "network access is forbidden in the test suite; no model, weight or "
            f"external provider may be fetched (attempted {address!r}). "
            "Connections to 127.0.0.1 are allowed, for servers a test starts itself."
        )
        raise NetworkAccessDuringTestsError(msg)

    def guarded_connect(self: Any, address: object) -> Any:
        if not _is_loopback(address):
            refuse(address)
        return real_connect(self, address)

    def guarded_connect_ex(self: Any, address: object) -> Any:
        if not _is_loopback(address):
            refuse(address)
        return real_connect_ex(self, address)

    def guarded_create_connection(address: object, *args: Any, **kwargs: Any) -> Any:
        if not _is_loopback(address):
            refuse(address)
        return real_create_connection(address, *args, **kwargs)

    socket.socket.connect = guarded_connect  # type: ignore[method-assign]
    socket.socket.connect_ex = guarded_connect_ex  # type: ignore[method-assign]
    socket.create_connection = guarded_create_connection
    try:
        yield
    finally:
        socket.socket.connect = real_connect  # type: ignore[method-assign]
        socket.socket.connect_ex = real_connect_ex  # type: ignore[method-assign]
        socket.create_connection = real_create_connection


@pytest.fixture(autouse=True, scope="session")
def _fixture_integrity() -> Iterator[None]:
    """Hash every committed fixture before and after the whole session."""
    before = compute_fixture_hashes(REPO_ROOT)
    assert before, "no committed fixtures were found; the integrity guard would be vacuous"
    yield
    after = compute_fixture_hashes(REPO_ROOT)
    assert after == before, (
        "committed fixture bytes changed during the test session. Product invariant D-006 "
        "(originals are immutable) has been violated somewhere in this run.\n"
        f"before={before}\nafter={after}"
    )


@pytest.fixture(scope="session")
def repo_root() -> Path:
    return REPO_ROOT


@pytest.fixture(scope="session")
def policy() -> ValidationPolicy:
    return DEFAULT_POLICY


@pytest.fixture(scope="session")
def example_manifest_path(repo_root: Path) -> Path:
    return manifests_dir(repo_root) / "example.manifest.json"


@pytest.fixture(scope="session")
def invalid_manifest_dir(repo_root: Path) -> Path:
    return manifests_dir(repo_root) / "invalid"


@pytest.fixture(scope="session")
def example_manifest(example_manifest_path: Path, repo_root: Path) -> AssetManifest:
    from ipw.benchmark_runner.validation import validate_manifest_file

    report, manifest = validate_manifest_file(
        example_manifest_path, policy=DEFAULT_POLICY, asset_root=repo_root
    )
    assert manifest is not None, f"example manifest failed to load: {report.failure_codes}"
    return manifest


@pytest.fixture
def ctx(tmp_path: Path) -> RunContext:
    """A deterministic run context with an isolated temporary root."""
    return RunContext.create(temp_root=tmp_path / "tmp", deterministic=True)
