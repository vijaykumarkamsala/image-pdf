from __future__ import annotations

from ipw.contracts.licence import ComponentKind, Disposition, LicenceDisposition, RunPurpose
from ipw.licence_registry.register import LicenceRegister, RegisterDocument


def test_production_safe_register_evaluates_without_benchmark_runner_imports() -> None:
    document = RegisterDocument(
        components=(
            LicenceDisposition(
                component_id="standard-engine",
                display_name="Standard Engine",
                kind=ComponentKind.CODE,
                disposition=Disposition.APPROVED,
                licence_id="MIT",
                official_source="local",
                pinned_version="0.1.0",
            ),
        )
    )

    decision = LicenceRegister(document).evaluate("standard-engine", RunPurpose.PRODUCTION)

    assert decision.permitted is True
    assert decision.effective_disposition is Disposition.APPROVED
