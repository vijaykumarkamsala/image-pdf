"""The seeded register, dependency inheritance and run-level gating.

POC-002 acceptance criteria:

* SUPIR is blocked from commercial-candidate runs by default.
* Unknown weight licences block execution (as refined by D-038: they block every
  commercial purpose, and Gate B blocks every purpose while the weight hash is
  unrecorded).
* Reference-only runs are clearly marked and cannot appear as commercial
  recommendations.
* Tests cover every disposition and dependency inheritance.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from ipw.benchmark_runner.licence_register import (
    LicenceRegister,
    RegisterDocument,
    evaluate_assets,
    evaluate_components,
    load_register,
    register_path,
)
from ipw.benchmark_runner.orchestrator import Ledger, RunPlan, execute_run
from ipw.benchmark_runner.policy import DEFAULT_POLICY
from ipw.contracts.licence import (
    COMMERCIAL_PURPOSES,
    RESEARCH_PURPOSES,
    ComponentKind,
    Disposition,
    LicenceDisposition,
    RunPurpose,
    WeightFormat,
)
from ipw.contracts.manifest import AssetManifest
from ipw.contracts.operation import (
    ADVERTISED_OPERATIONS,
    NoopSettings,
    Operation,
    OperationKind,
    ProcessingVariant,
)
from ipw.contracts.result import ResultState
from ipw.contracts.runtime import RunContext
from ipw.processors.fake import FakeProcessor

NOOP = Operation.build(NoopSettings(), ProcessingVariant.ORIGINAL_CONTROL)

SEEDED_MODELS = (
    "real-esrgan",
    "swinir",
    "gfpgan",
    "codeformer",
    "supir",
    "rembg-u2net",
)

GATE_B_SATISFIED = frozenset({"real-esrgan", "swinir"})
"""Models whose weights are pinned by release tag and verified by digest.

This set grows one POC task at a time and never as a convenience. An entry means
someone downloaded the file, recorded its SHA-256, and wired that digest into the
adapter so a mismatch refuses to load - not that the model looked trustworthy.

Gate B says nothing about licensing. Everything here is still subject to Gate A,
and Real-ESRGAN remains blocked from every commercial purpose.
"""


@pytest.fixture(scope="module")
def register(repo_root: Path) -> LicenceRegister:
    return load_register(register_path(repo_root))


def _component(component_id: str, **overrides: object) -> LicenceDisposition:
    """A Gate-B-complete component, so Gate A can be tested in isolation."""
    base: dict[str, object] = {
        "component_id": component_id,
        "display_name": component_id,
        "kind": ComponentKind.CODE,
        "official_source": "https://example.invalid/repo",
        "pinned_version": "v1.0.0",
        "weight_format": WeightFormat.NOT_APPLICABLE,
    }
    base.update(overrides)
    return LicenceDisposition.model_validate(base)


def _register(*components: LicenceDisposition) -> LicenceRegister:
    return LicenceRegister(RegisterDocument(components=components))


class TestSeededRegister:
    def test_all_six_candidates_are_seeded(self, register: LicenceRegister) -> None:
        for component_id in SEEDED_MODELS:
            assert component_id in register, f"{component_id} is missing from the register"

    def test_code_and_weights_are_registered_separately(self, register: LicenceRegister) -> None:
        """A wrapper licence is not weight approval (AGENTS.md).

        A model may ship more than one checkpoint - Real-ESRGAN publishes x2plus
        and x4plus as separate files with separate digests - so the assertion is
        that weights exist as their own component(s), not that there is exactly
        one of them. Gate B pins a file, not a concept.
        """
        for stem in ("real-esrgan", "swinir", "gfpgan", "codeformer", "supir"):
            assert f"{stem}-code" in register
            weights = [
                component
                for component in register.components()
                if component.component_id.startswith(f"{stem}-weights")
            ]
            assert weights, f"{stem} has no weights component; only its code is registered"
            assert all(component.kind.value == "weights" for component in weights), (
                f"{stem} weights are registered under the wrong kind"
            )

    def test_approval_always_carries_a_real_review(self, register: LicenceRegister) -> None:
        """The rule is not "no third party may be approved" - POC-004 approved several.

        The rule is that approval must be auditable: a named reviewer, a date, and
        evidence pointing at the licence text that was actually read. A record
        marked PRELIMINARY has been transcribed, not reviewed, and may never be
        approved.
        """
        for component in register.components():
            if component.disposition is not Disposition.APPROVED:
                continue
            assert component.reviewed_by, f"{component.component_id}: approved with no reviewer"
            assert component.reviewed_on, f"{component.component_id}: approved with no date"
            assert component.evidence, f"{component.component_id}: approved with no evidence"
            assert "PRELIMINARY" not in component.evidence, (
                f"{component.component_id} is approved on preliminary evidence; a transcription "
                "of someone else's observation is not a review"
            )

    def test_no_model_candidate_is_approved(self, register: LicenceRegister) -> None:
        """The six benchmark model candidates remain unreviewed.

        POC-004 approved imaging libraries whose licences were read directly. The
        models are a different matter: none has been reviewed, and marking one
        approved would be the exact failure POC-002 exists to prevent.
        """
        for component_id in SEEDED_MODELS:
            component = register.get(component_id)
            assert component is not None
            assert component.disposition is not Disposition.APPROVED, (
                f"{component_id} is marked approved; no model licence has been reviewed"
            )

    def test_every_seeded_model_record_is_marked_preliminary(
        self, register: LicenceRegister
    ) -> None:
        reviewed = {c.component_id for c in register.components() if c.reviewed_by}
        for component in register.components():
            if component.component_id in reviewed:
                continue
            assert component.evidence is not None
            assert "PRELIMINARY" in component.evidence, (
                f"{component.component_id} has no reviewer and no preliminary marking; "
                "a record must be one or the other"
            )

    def test_unpinned_models_still_cannot_execute(self, register: LicenceRegister) -> None:
        """Gate B blocks anything whose weights have not been pinned and hashed."""
        for component_id in SEEDED_MODELS:
            if component_id in GATE_B_SATISFIED:
                continue
            decision = register.evaluate(component_id, RunPurpose.LOCAL_RESEARCH)
            assert not decision.permitted, (
                f"{component_id} would execute with no pinned weight digest"
            )
            assert any(f.code.value == "LICENCE.SUPPLY_CHAIN_INCOMPLETE" for f in decision.failures)

    def test_satisfying_gate_b_opens_research_but_not_commerce(
        self, register: LicenceRegister
    ) -> None:
        """The two gates are independent, and POC-006 proves it on a real model.

        Real-ESRGAN's weight digests are recorded, so Gate B is satisfied and
        research may proceed. Its licence position is unresolved - no weight
        licence is stated and the training data is research-only - so Gate A still
        refuses every commercial purpose. Passing one gate must never imply the
        other; that is the whole reason there are two.
        """
        for component_id in GATE_B_SATISFIED:
            research = register.evaluate(component_id, RunPurpose.LOCAL_RESEARCH)
            assert research.permitted, f"{component_id} passed Gate B but cannot be researched"
            assert not any(
                f.code.value == "LICENCE.SUPPLY_CHAIN_INCOMPLETE" for f in research.failures
            )
            assert not research.eligible_for_commercial_recommendation, (
                f"{component_id} research results must never be presented as a recommendation"
            )
            assert research.warnings, "a non-approved research run must warn, not pass silently"

            for purpose in COMMERCIAL_PURPOSES:
                assert not register.evaluate(component_id, purpose).permitted, (
                    f"{component_id} is permitted for {purpose.value} on an unresolved licence"
                )

    def test_gate_b_is_satisfied_by_a_digest_on_every_checkpoint(
        self, register: LicenceRegister
    ) -> None:
        """Not one digest somewhere - every weight file that can be loaded."""
        for component in register.components():
            if component.kind.value != "weights":
                continue
            if not component.component_id.startswith(tuple(GATE_B_SATISFIED)):
                continue
            assert component.weights_sha256, f"{component.component_id} has no recorded digest"
            assert component.pinned_version, f"{component.component_id} has no pinned release"


class TestAcceptanceCriteria:
    def test_supir_is_blocked_from_commercial_candidate_runs(
        self, register: LicenceRegister
    ) -> None:
        for purpose in COMMERCIAL_PURPOSES:
            decision = register.evaluate("supir", purpose)
            assert not decision.permitted
            assert decision.reference_only
            assert any(f.code.value == "LICENCE.REFERENCE_ONLY" for f in decision.failures)
            assert not decision.eligible_for_commercial_recommendation

    def test_supir_remains_available_as_a_research_reference(self) -> None:
        """Reference-only means 'not commercial', not 'never runnable'."""
        pinned_supir = _register(
            _component("supir-code", disposition=Disposition.NON_COMMERCIAL, reference_only=True),
            _component(
                "supir-weights",
                kind=ComponentKind.WEIGHTS,
                disposition=Disposition.NON_COMMERCIAL,
                reference_only=True,
                weights_sha256="b" * 64,
                weight_format=WeightFormat.SAFETENSORS,
            ),
            _component(
                "supir",
                disposition=Disposition.NON_COMMERCIAL,
                reference_only=True,
                depends_on=["supir-code", "supir-weights"],
            ),
        )
        for purpose in RESEARCH_PURPOSES:
            decision = pinned_supir.evaluate("supir", purpose)
            assert decision.permitted, decision.failures
            assert "reference-only" in decision.markings
            assert not decision.eligible_for_commercial_recommendation

    def test_unknown_weight_licence_blocks_commercial_use(self) -> None:
        pinned = _register(
            _component(
                "wrapper",
                disposition=Disposition.APPROVED,
                licence_id="MIT",
                depends_on=["mystery-weights"],
            ),
            _component(
                "mystery-weights",
                kind=ComponentKind.WEIGHTS,
                disposition=Disposition.UNKNOWN,
                weights_sha256="c" * 64,
                weight_format=WeightFormat.SAFETENSORS,
            ),
        )
        for purpose in COMMERCIAL_PURPOSES:
            decision = pinned.evaluate("wrapper", purpose)
            assert not decision.permitted
            assert decision.effective_disposition is Disposition.UNKNOWN
            assert any(f.code.value == "LICENCE.UNKNOWN_DISPOSITION" for f in decision.failures)

    def test_unrecorded_weight_hash_blocks_every_purpose(self) -> None:
        """The stricter half of the original criterion, preserved by Gate B."""
        unpinned = _register(
            _component(
                "weights-no-hash",
                kind=ComponentKind.WEIGHTS,
                disposition=Disposition.APPROVED,
                licence_id="MIT",
            )
        )
        for purpose in RunPurpose:
            decision = unpinned.evaluate("weights-no-hash", purpose)
            assert not decision.permitted, f"{purpose.value} should be blocked by Gate B"

    def test_research_runs_are_marked_not_silent(self) -> None:
        pinned = _register(_component("candidate", disposition=Disposition.REVIEW_REQUIRED))
        decision = pinned.evaluate("candidate", RunPurpose.INTERNAL_BENCHMARK)
        assert decision.permitted
        assert "disposition:review_required" in decision.markings
        assert decision.warnings, "a non-approved research run must warn, never pass silently"
        assert not decision.eligible_for_commercial_recommendation


class TestDependencyInheritance:
    def test_a_composite_inherits_the_least_permissive_part(
        self, register: LicenceRegister
    ) -> None:
        """real-esrgan declares review_required but executes unknown weights."""
        assert register.get("real-esrgan") is not None
        declared = register.components()
        by_id = {c.component_id: c for c in declared}
        assert by_id["real-esrgan"].disposition is Disposition.REVIEW_REQUIRED
        assert register.effective_disposition("real-esrgan") is Disposition.UNKNOWN

    def test_a_permissive_wrapper_does_not_launder_unknown_weights(
        self, register: LicenceRegister
    ) -> None:
        """rembg's MIT wrapper cannot approve U2-Net's unreviewed weights."""
        by_id = {c.component_id: c for c in register.components()}
        assert by_id["rembg-code"].licence_id == "MIT"
        assert register.effective_disposition("rembg-u2net") is Disposition.UNKNOWN

    def test_inheritance_is_transitive(self) -> None:
        pinned = _register(
            _component(
                "top", disposition=Disposition.APPROVED, licence_id="MIT", depends_on=["middle"]
            ),
            _component(
                "middle", disposition=Disposition.APPROVED, licence_id="MIT", depends_on=["bottom"]
            ),
            _component("bottom", disposition=Disposition.BLOCKED),
        )
        assert pinned.effective_disposition("top") is Disposition.BLOCKED

    def test_a_blocked_dependency_blocks_every_purpose(self) -> None:
        pinned = _register(
            _component(
                "app", disposition=Disposition.APPROVED, licence_id="MIT", depends_on=["forbidden"]
            ),
            _component("forbidden", disposition=Disposition.BLOCKED),
        )
        for purpose in RunPurpose:
            assert not pinned.evaluate("app", purpose).permitted

    def test_an_unregistered_dependency_is_treated_as_unknown(self) -> None:
        pinned = _register(
            _component(
                "app", disposition=Disposition.APPROVED, licence_id="MIT", depends_on=["ghost"]
            )
        )
        assert pinned.effective_disposition("app") is Disposition.UNKNOWN
        decision = pinned.evaluate("app", RunPurpose.LOCAL_RESEARCH)
        assert any(f.code.value == "LICENCE.DEPENDENCY_NOT_REGISTERED" for f in decision.failures)

    def test_a_dependency_cycle_is_reported_not_looped(self) -> None:
        cyclic = _register(
            _component(
                "alpha", disposition=Disposition.APPROVED, licence_id="MIT", depends_on=["beta"]
            ),
            _component(
                "beta", disposition=Disposition.APPROVED, licence_id="MIT", depends_on=["alpha"]
            ),
        )
        decision = cyclic.evaluate("alpha", RunPurpose.LOCAL_RESEARCH)
        assert not decision.permitted
        assert any(f.code.value == "LICENCE.DEPENDENCY_CYCLE" for f in decision.failures)

    def test_an_unregistered_component_is_refused(self, register: LicenceRegister) -> None:
        decision = register.evaluate("not-in-the-register", RunPurpose.LOCAL_RESEARCH)
        assert not decision.permitted
        assert decision.failures[0].code.value == "LICENCE.COMPONENT_NOT_REGISTERED"


class TestApprovedFallback:
    """D-040: every advertised operation must retain an approved candidate."""

    def test_standard_operations_have_a_fallback(self, register: LicenceRegister) -> None:
        standard = (
            OperationKind.RESIZE,
            OperationKind.CROP,
            OperationKind.SHARPEN,
            OperationKind.DENOISE,
        )
        assert register.missing_approved_fallbacks(standard) == ()

    def test_ai_operations_currently_have_no_fallback(self, register: LicenceRegister) -> None:
        """A finding, not an oversight: this gap is what D-040 exists to surface."""
        gaps = register.missing_approved_fallbacks(ADVERTISED_OPERATIONS)
        missing = {str(item.context["operation"]) for item in gaps}
        assert missing == {
            "super_resolution",
            # Added at POC-007 along with the operation itself. Two independent
            # candidates now implement super-resolution and neither is approved,
            # which is the point: the gap did not close by adding a second model,
            # because both are blocked by the same upstream training data.
            "ai_denoise",
            "face_restore",
            "damage_repair",
            "colourise",
            "background_remove",
            "background_replace",
        }

    def test_adding_a_second_model_did_not_close_any_gap(self, register: LicenceRegister) -> None:
        """The POC-007 finding, stated as a licence-register assertion.

        Real-ESRGAN and SwinIR both implement super-resolution. If the D-040 gap
        were about model availability, a second candidate would have closed it. It
        did not, because the restriction lives in the training data both share.
        """
        from ipw.contracts.licence import Disposition

        candidates = ("real-esrgan", "swinir")
        for component_id in candidates:
            assert register.effective_disposition(component_id) is not Disposition.APPROVED

        gaps = register.missing_approved_fallbacks((OperationKind.SUPER_RESOLUTION,))
        assert gaps, (
            "super_resolution reports an approved fallback, but neither candidate is "
            "approved - the gap must remain visible until a licence question is answered"
        )

    def test_a_non_approved_fallback_does_not_count(self) -> None:
        pinned = LicenceRegister(
            RegisterDocument(
                components=(_component("candidate", disposition=Disposition.REVIEW_REQUIRED),),
                approved_fallback={OperationKind.RESIZE: "candidate"},
            )
        )
        assert pinned.missing_approved_fallbacks((OperationKind.RESIZE,)) != ()


class TestAssetRightsGate:
    def test_the_example_corpus_passes_research_purposes(
        self, example_manifest: AssetManifest
    ) -> None:
        for purpose in RESEARCH_PURPOSES:
            assert evaluate_assets(example_manifest, purpose).permitted

    def test_an_asset_can_forbid_public_display(self, example_manifest: AssetManifest) -> None:
        """One example asset is marked public_demo_permitted=false."""
        decision = evaluate_assets(example_manifest, RunPurpose.PUBLIC_DEMO)
        assert not decision.permitted
        assert any(f.code.value == "RIGHTS.PUBLIC_DEMO_NOT_PERMITTED" for f in decision.failures)

    def test_missing_provenance_blocks_use(
        self, example_manifest_path: Path, tmp_path: Path
    ) -> None:
        document = json.loads(example_manifest_path.read_text(encoding="utf-8"))
        del document["assets"][0]["provenance"]
        manifest = AssetManifest.model_validate(document)

        decision = evaluate_assets(manifest, RunPurpose.LOCAL_RESEARCH)
        assert not decision.permitted
        assert any(f.code.value == "RIGHTS.PROVENANCE_MISSING" for f in decision.failures)

    def test_sensitive_content_warns_for_research_and_blocks_commercial(
        self, example_manifest_path: Path
    ) -> None:
        document = json.loads(example_manifest_path.read_text(encoding="utf-8"))
        document["assets"][0]["provenance"]["contains_sensitive_information"] = True
        manifest = AssetManifest.model_validate(document)

        research = evaluate_assets(manifest, RunPurpose.LOCAL_RESEARCH)
        assert research.permitted
        assert any(w.code.value == "RIGHTS.SENSITIVE_CONTENT" for w in research.warnings)

        commercial = evaluate_assets(manifest, RunPurpose.STAGING)
        assert not commercial.permitted


class TestRunGating:
    def _plan(
        self,
        manifest: AssetManifest,
        repo_root: Path,
        register: LicenceRegister | None,
        purpose: RunPurpose,
        components: tuple[str, ...] = (),
    ) -> RunPlan:
        return RunPlan.create(
            processor=FakeProcessor(),
            manifest=manifest,
            operation=NOOP,
            policy=DEFAULT_POLICY,
            asset_root=repo_root,
            manifest_digest="mfst_" + "a" * 32,
            purpose=purpose,
            component_ids=components,
            register=register,
        )

    def test_a_blocked_gate_refuses_before_processing(
        self,
        example_manifest: AssetManifest,
        repo_root: Path,
        register: LicenceRegister,
        ctx: RunContext,
    ) -> None:
        plan = self._plan(example_manifest, repo_root, register, RunPurpose.PRODUCTION, ("supir",))
        run = execute_run(plan, ctx, Ledger())

        assert run.summary.skipped == run.summary.total
        assert run.summary.succeeded == 0
        assert run.licence is not None
        assert not run.licence.permitted
        assert not run.eligible_for_commercial_recommendation
        assert len(run.ledger) == 0, "a refused run must not record a usage event"

    def test_an_approved_component_runs(
        self,
        example_manifest: AssetManifest,
        repo_root: Path,
        register: LicenceRegister,
        ctx: RunContext,
    ) -> None:
        plan = self._plan(
            example_manifest,
            repo_root,
            register,
            RunPurpose.INTERNAL_BENCHMARK,
            ("standard-pillow",),
        )
        run = execute_run(plan, ctx, Ledger())

        assert run.summary.succeeded == 1
        assert run.licence is not None
        assert run.licence.permitted
        assert run.eligible_for_commercial_recommendation

    def test_purpose_is_part_of_the_run_identity(
        self, example_manifest: AssetManifest, repo_root: Path, register: LicenceRegister
    ) -> None:
        """A reference-only research result cannot be relabelled as production."""
        research = self._plan(
            example_manifest,
            repo_root,
            register,
            RunPurpose.INTERNAL_BENCHMARK,
            ("standard-pillow",),
        )
        production = self._plan(
            example_manifest,
            repo_root,
            register,
            RunPurpose.PRODUCTION,
            ("standard-pillow",),
        )
        assert research.run_id != production.run_id
        assert research.identity.purpose is RunPurpose.INTERNAL_BENCHMARK

    def test_licence_standing_is_part_of_the_run_identity(
        self, example_manifest: AssetManifest, repo_root: Path, register: LicenceRegister
    ) -> None:
        approved = self._plan(
            example_manifest,
            repo_root,
            register,
            RunPurpose.INTERNAL_BENCHMARK,
            ("standard-pillow",),
        )
        assert approved.identity.licence_disposition is Disposition.APPROVED
        assert not approved.identity.reference_only

    def test_an_unguarded_plan_is_marked_as_such(
        self, example_manifest: AssetManifest, repo_root: Path, ctx: RunContext
    ) -> None:
        """No register attached must never read as approval."""
        plan = self._plan(example_manifest, repo_root, None, RunPurpose.LOCAL_RESEARCH)
        run = execute_run(plan, ctx, Ledger())
        assert run.licence is not None
        assert "no-licence-register-attached" in run.licence.markings

    def test_asset_rights_can_block_a_run_on_their_own(
        self,
        example_manifest: AssetManifest,
        repo_root: Path,
        register: LicenceRegister,
        ctx: RunContext,
    ) -> None:
        """An approved model still cannot show a non-displayable asset publicly."""
        plan = self._plan(
            example_manifest,
            repo_root,
            register,
            RunPurpose.PUBLIC_DEMO,
            ("standard-pillow",),
        )
        run = execute_run(plan, ctx, Ledger())
        assert run.licence is not None
        assert not run.licence.permitted
        assert all(r.state is ResultState.SKIPPED for r in run.results)


class TestCombinedEvaluation:
    def test_combining_decisions_takes_the_least_permissive(
        self, register: LicenceRegister
    ) -> None:
        decision = evaluate_components(
            register, ("standard-pillow", "supir"), RunPurpose.INTERNAL_BENCHMARK
        )
        assert decision.effective_disposition is Disposition.NON_COMMERCIAL
        assert decision.reference_only

    def test_an_empty_component_set_is_permitted(self, register: LicenceRegister) -> None:
        decision = evaluate_components(register, (), RunPurpose.PRODUCTION)
        assert decision.permitted
