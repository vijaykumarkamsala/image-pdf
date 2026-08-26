"""The D-038 gate matrix, Gate B requirements and disposition ordering.

Contract-level: these test the rules themselves, independent of any register file.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from ipw.contracts.licence import (
    COMMERCIAL_PURPOSES,
    RESEARCH_PURPOSES,
    ComponentKind,
    Disposition,
    GateDecision,
    LicenceDisposition,
    RunPurpose,
    WeightFormat,
    is_permitted,
    least_permissive,
)

# The approved D-038 matrix, transcribed. If this table and the code disagree,
# the code is wrong: the table is the decision.
EXPECTED_MATRIX: dict[Disposition, dict[RunPurpose, bool]] = {
    Disposition.APPROVED: dict.fromkeys(RunPurpose, True),
    Disposition.REVIEW_REQUIRED: {p: p in RESEARCH_PURPOSES for p in RunPurpose},
    Disposition.NON_COMMERCIAL: {p: p in RESEARCH_PURPOSES for p in RunPurpose},
    Disposition.UNKNOWN: {p: p in RESEARCH_PURPOSES for p in RunPurpose},
    Disposition.BLOCKED: dict.fromkeys(RunPurpose, False),
}


def _pinned(**overrides: object) -> LicenceDisposition:
    """A component that satisfies Gate B, so Gate A can be tested in isolation."""
    base: dict[str, object] = {
        "component_id": "pinned-example",
        "display_name": "Pinned example",
        "kind": ComponentKind.CODE,
        "official_source": "https://example.invalid/repo",
        "pinned_version": "v1.2.3",
        "weight_format": WeightFormat.NOT_APPLICABLE,
        "network_disabled_at_inference": True,
    }
    base.update(overrides)
    return LicenceDisposition.model_validate(base)


class TestGateMatrix:
    @pytest.mark.parametrize("disposition", list(Disposition))
    @pytest.mark.parametrize("purpose", list(RunPurpose))
    def test_matches_the_approved_table(
        self, disposition: Disposition, purpose: RunPurpose
    ) -> None:
        assert is_permitted(disposition, purpose) is EXPECTED_MATRIX[disposition][purpose]

    def test_every_disposition_is_covered(self) -> None:
        assert set(EXPECTED_MATRIX) == set(Disposition)

    def test_commercial_purposes_require_approved(self) -> None:
        for purpose in COMMERCIAL_PURPOSES:
            permitted = [d for d in Disposition if is_permitted(d, purpose)]
            assert permitted == [Disposition.APPROVED]

    def test_research_purposes_permit_everything_except_blocked(self) -> None:
        for purpose in RESEARCH_PURPOSES:
            refused = [d for d in Disposition if not is_permitted(d, purpose)]
            assert refused == [Disposition.BLOCKED]

    def test_unknown_is_not_treated_as_approval(self) -> None:
        assert not is_permitted(Disposition.UNKNOWN, RunPurpose.PRODUCTION)


class TestDispositionOrdering:
    @pytest.mark.parametrize(
        ("inputs", "expected"),
        [
            ([Disposition.APPROVED, Disposition.APPROVED], Disposition.APPROVED),
            ([Disposition.APPROVED, Disposition.REVIEW_REQUIRED], Disposition.REVIEW_REQUIRED),
            ([Disposition.APPROVED, Disposition.NON_COMMERCIAL], Disposition.NON_COMMERCIAL),
            ([Disposition.REVIEW_REQUIRED, Disposition.UNKNOWN], Disposition.UNKNOWN),
            ([Disposition.APPROVED, Disposition.BLOCKED], Disposition.BLOCKED),
            ([Disposition.UNKNOWN, Disposition.NON_COMMERCIAL], Disposition.UNKNOWN),
        ],
    )
    def test_least_permissive(self, inputs: list[Disposition], expected: Disposition) -> None:
        assert least_permissive(inputs) is expected

    def test_empty_is_unknown_not_approved(self) -> None:
        """The absence of information is never approval."""
        assert least_permissive([]) is Disposition.UNKNOWN

    def test_a_permissive_wrapper_cannot_launder_a_restrictive_weight(self) -> None:
        """AGENTS.md: a wrapper licence never covers bundled or downloaded weights."""
        assert least_permissive([Disposition.APPROVED, Disposition.UNKNOWN]) is Disposition.UNKNOWN


class TestSupplyChainGateB:
    """D-039: required at every purpose level, including local research."""

    def test_a_fully_pinned_component_has_no_gaps(self) -> None:
        assert _pinned().supply_chain_gaps() == ()

    def test_missing_official_source_is_a_gap(self) -> None:
        gaps = _pinned(official_source=None).supply_chain_gaps()
        assert any("official_source" in gap for gap in gaps)

    def test_missing_pinned_version_is_a_gap(self) -> None:
        gaps = _pinned(pinned_version=None).supply_chain_gaps()
        assert any("pinned_version" in gap for gap in gaps)

    def test_weights_require_a_hash_and_a_declared_format(self) -> None:
        gaps = _pinned(kind=ComponentKind.WEIGHTS).supply_chain_gaps()
        assert any("weights_sha256" in gap for gap in gaps)
        assert any("weight_format" in gap for gap in gaps)

    def test_pinned_weights_with_a_hash_have_no_gaps(self) -> None:
        component = _pinned(
            kind=ComponentKind.WEIGHTS,
            weights_sha256="a" * 64,
            weight_format=WeightFormat.SAFETENSORS,
        )
        assert component.supply_chain_gaps() == ()

    def test_enabled_inference_network_is_a_gap(self) -> None:
        gaps = _pinned(network_disabled_at_inference=False).supply_chain_gaps()
        assert any("network" in gap for gap in gaps)

    def test_gate_b_is_independent_of_disposition(self) -> None:
        """An approved licence does not excuse an unpinned, unhashed download."""
        approved_but_unpinned = LicenceDisposition(
            component_id="approved-unpinned",
            display_name="Approved but unpinned",
            kind=ComponentKind.WEIGHTS,
            disposition=Disposition.APPROVED,
            licence_id="MIT",
        )
        assert approved_but_unpinned.supply_chain_gaps() != ()
        assert approved_but_unpinned.is_permitted_for(RunPurpose.PRODUCTION)


class TestAuditability:
    def test_approval_requires_a_licence_id_or_evidence(self) -> None:
        with pytest.raises(ValidationError, match="auditable"):
            LicenceDisposition(
                component_id="unaudited",
                display_name="Approved with no evidence",
                kind=ComponentKind.CODE,
                disposition=Disposition.APPROVED,
            )

    def test_approval_with_evidence_is_accepted(self) -> None:
        component = LicenceDisposition(
            component_id="audited",
            display_name="Approved with evidence",
            kind=ComponentKind.CODE,
            disposition=Disposition.APPROVED,
            evidence="Read LICENSE at commit abc123 on 2026-08-24.",
        )
        assert component.is_commercially_eligible

    def test_a_gated_download_must_record_what_was_accepted(self) -> None:
        """Clicking 'I accept' IS entering the licence (D-039)."""
        with pytest.raises(ValidationError, match="accepted_terms_reference"):
            LicenceDisposition(
                component_id="gated",
                display_name="Gated download",
                kind=ComponentKind.WEIGHTS,
                download_requires_terms_acceptance=True,
            )

    def test_a_recorded_acceptance_is_accepted(self) -> None:
        component = LicenceDisposition(
            component_id="gated-recorded",
            display_name="Gated download, recorded",
            kind=ComponentKind.WEIGHTS,
            download_requires_terms_acceptance=True,
            accepted_terms_reference="docs/licences/accepted/2026-08-24-example.md",
        )
        assert component.accepted_terms_reference


class TestReferenceOnly:
    def test_reference_only_is_never_commercially_eligible(self) -> None:
        component = _pinned(disposition=Disposition.APPROVED, licence_id="MIT", reference_only=True)
        assert not component.is_commercially_eligible
        for purpose in COMMERCIAL_PURPOSES:
            assert not component.is_permitted_for(purpose)

    def test_reference_only_remains_usable_for_research(self) -> None:
        component = _pinned(disposition=Disposition.NON_COMMERCIAL, reference_only=True)
        for purpose in RESEARCH_PURPOSES:
            assert component.is_permitted_for(purpose)


class TestGateDecision:
    def test_only_approved_non_reference_decisions_are_recommendable(self) -> None:
        recommendable = GateDecision(
            purpose=RunPurpose.INTERNAL_BENCHMARK,
            permitted=True,
            effective_disposition=Disposition.APPROVED,
        )
        assert recommendable.eligible_for_commercial_recommendation

        for decision in (
            GateDecision(
                purpose=RunPurpose.INTERNAL_BENCHMARK,
                permitted=True,
                effective_disposition=Disposition.APPROVED,
                reference_only=True,
            ),
            GateDecision(
                purpose=RunPurpose.INTERNAL_BENCHMARK,
                permitted=True,
                effective_disposition=Disposition.NON_COMMERCIAL,
            ),
            GateDecision(
                purpose=RunPurpose.INTERNAL_BENCHMARK,
                permitted=False,
                effective_disposition=Disposition.APPROVED,
            ),
        ):
            assert not decision.eligible_for_commercial_recommendation
