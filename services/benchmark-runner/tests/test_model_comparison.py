"""Multi-candidate comparison (POC-007).

Uses the fake processor throughout. The point of these tests is the comparison
*structure* - what it refuses, what it records, and what it refuses to conclude -
and running real models here would make them slow without making them stronger.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from ipw.benchmark_runner.model_comparison import (
    COMPARISON_JSON_NAME,
    COMPARISON_MARKDOWN_NAME,
    Candidate,
    ModelComparison,
    build_model_comparison,
    render_model_comparison,
    write_model_comparison,
)
from ipw.benchmark_runner.policy import DEFAULT_POLICY
from ipw.contracts.manifest import AssetManifest
from ipw.contracts.operation import (
    NoopSettings,
    Operation,
    ProcessingVariant,
    ResizeSettings,
    SuperResolutionSettings,
)
from ipw.contracts.runtime import RunContext
from ipw.processors.fake import FakeProcessor

NOOP = Operation.build(NoopSettings(), ProcessingVariant.ORIGINAL_CONTROL)
RESIZE = Operation.build(
    ResizeSettings(algorithm="lanczos", scale_numerator=4, scale_denominator=1),
    ProcessingVariant.STANDARD_SERVER_AUTHORITATIVE,
)
SUPER_RESOLUTION = Operation.build(SuperResolutionSettings(scale=4), ProcessingVariant.AI_NATURAL)


def candidate(label: str, operation: Operation = NOOP, *, control: bool = False) -> Candidate:
    return Candidate(
        label=label, processor=FakeProcessor(), operation=operation, is_control=control
    )


def build(
    manifest: AssetManifest,
    repo_root: Path,
    tmp_path: Path,
    candidates: tuple[Candidate, ...],
) -> ModelComparison:
    ctx = RunContext.create(temp_root=tmp_path / "tmp", deterministic=True)
    return build_model_comparison(
        candidates=candidates,
        manifest=manifest,
        manifest_digest="mfst_" + "a" * 32,
        policy=DEFAULT_POLICY,
        asset_root=repo_root,
        ctx=ctx,
    )


class TestWhatItRefuses:
    def test_no_candidates(
        self, example_manifest: AssetManifest, repo_root: Path, tmp_path: Path
    ) -> None:
        with pytest.raises(ValueError, match="at least one candidate"):
            build(example_manifest, repo_root, tmp_path, ())

    def test_two_models_on_different_operations(
        self, example_manifest: AssetManifest, repo_root: Path, tmp_path: Path
    ) -> None:
        """Comparing different work would attribute it to a difference in model."""
        with pytest.raises(ValueError, match="same operation"):
            build(
                example_manifest,
                repo_root,
                tmp_path,
                (candidate("a", NOOP), candidate("b", RESIZE)),
            )

    def test_two_controls(
        self, example_manifest: AssetManifest, repo_root: Path, tmp_path: Path
    ) -> None:
        with pytest.raises(ValueError, match="at most one candidate may be the deterministic"):
            build(
                example_manifest,
                repo_root,
                tmp_path,
                (candidate("a", NOOP, control=True), candidate("b", NOOP, control=True)),
            )


class TestTheControlMayDifferFromTheModels:
    """The premise of the whole comparison, not an exception to a rule.

    ``FAMILY_OF`` places ``resize`` in the STANDARD family and
    ``super_resolution`` in AI, and ``Operation.build`` derives the family from
    the kind - so a standard processor structurally cannot claim the AI operation
    (D-007, D-009). Requiring one shared operation kind across every candidate
    would make it impossible to compare AI against the deterministic alternative,
    which is the one comparison POC-006 and POC-007 exist to produce.
    """

    def test_a_control_on_a_different_operation_is_accepted(
        self, example_manifest: AssetManifest, repo_root: Path, tmp_path: Path
    ) -> None:
        comparison = build(
            example_manifest,
            repo_root,
            tmp_path,
            (
                candidate("deterministic", RESIZE, control=True),
                candidate("model-a", SUPER_RESOLUTION),
                candidate("model-b", SUPER_RESOLUTION),
            ),
        )
        assert comparison.operation_kind == "super_resolution"
        assert set(comparison.labels) == {"deterministic", "model-a", "model-b"}

    def test_the_reported_operation_is_the_models_not_the_controls(
        self, example_manifest: AssetManifest, repo_root: Path, tmp_path: Path
    ) -> None:
        comparison = build(
            example_manifest,
            repo_root,
            tmp_path,
            (
                candidate("deterministic", RESIZE, control=True),
                candidate("model", SUPER_RESOLUTION),
            ),
        )
        assert comparison.operation_kind == "super_resolution"


class TestWhatItRecords:
    @pytest.fixture
    def comparison(
        self, example_manifest: AssetManifest, repo_root: Path, tmp_path: Path
    ) -> ModelComparison:
        return build(
            example_manifest,
            repo_root,
            tmp_path,
            (candidate("control", NOOP, control=True), candidate("model", NOOP)),
        )

    def test_one_outcome_per_candidate_and_asset(
        self, comparison: ModelComparison, example_manifest: AssetManifest
    ) -> None:
        expected = len(comparison.labels) * len(example_manifest.asset_ids)
        assert len(comparison.outcomes) == expected

    def test_each_candidate_carries_its_own_licence_standing(
        self, comparison: ModelComparison
    ) -> None:
        assert set(comparison.standing) == set(comparison.labels)
        for standing in comparison.standing.values():
            assert "effective_disposition" in standing
            assert "eligible_for_commercial_recommendation" in standing

    def test_the_control_is_flagged(self, comparison: ModelComparison) -> None:
        controls = {o.label for o in comparison.outcomes if o.is_control}
        assert controls == {"control"}

    def test_the_environment_is_recorded(self, comparison: ModelComparison) -> None:
        assert comparison.environment["contract_version"]
        assert "accelerator" in comparison.environment

    def test_the_ssim_variant_is_named(self, comparison: ModelComparison) -> None:
        """A report that does not say which SSIM it used cannot be compared."""
        assert "11x11" in comparison.metric_variant


class TestNoWinnerIsDeclared:
    """POC-007 acceptance: no winner is declared from objective metrics alone."""

    @pytest.fixture
    def document(
        self, example_manifest: AssetManifest, repo_root: Path, tmp_path: Path
    ) -> dict[str, Any]:
        comparison = build(
            example_manifest,
            repo_root,
            tmp_path,
            (candidate("control", NOOP, control=True), candidate("model", NOOP)),
        )
        return dict(comparison.to_document())

    def test_the_winner_field_is_present_and_null(self, document: dict[str, Any]) -> None:
        """Present, so nobody wonders whether it was forgotten. Null, because it is."""
        assert "winner" in document
        assert document["winner"] is None

    def test_the_absence_is_explained(self, document: dict[str, Any]) -> None:
        assert "D-011" in document["winner_note"]
        assert "POC-008" in document["winner_note"]

    def test_no_ranking_field_exists_anywhere(self, document: dict[str, Any]) -> None:
        serialised = json.dumps(document).lower()
        for banned in ('"best"', '"rank"', '"score_order"', '"recommended"'):
            assert banned not in serialised, f"the document contains {banned}"


class TestRendering:
    @pytest.fixture
    def comparison(
        self, example_manifest: AssetManifest, repo_root: Path, tmp_path: Path
    ) -> ModelComparison:
        return build(
            example_manifest,
            repo_root,
            tmp_path,
            (
                candidate("deterministic", RESIZE, control=True),
                candidate("model", SUPER_RESOLUTION),
            ),
        )

    def test_the_markdown_names_the_control(self, comparison: ModelComparison) -> None:
        rendered = render_model_comparison(comparison)
        assert "`deterministic`" in rendered
        assert "No winner is declared" in rendered

    def test_the_guidance_names_the_actual_control(self, comparison: ModelComparison) -> None:
        """It used to hardcode "Lanczos resize", which was wrong on a denoise run."""
        rendered = render_model_comparison(comparison)
        assert "distance from `deterministic`" in rendered

    def test_a_comparison_without_a_control_says_so(
        self, example_manifest: AssetManifest, repo_root: Path, tmp_path: Path
    ) -> None:
        comparison = build(
            example_manifest, repo_root, tmp_path, (candidate("model", SUPER_RESOLUTION),)
        )
        rendered = render_model_comparison(comparison)
        assert "No deterministic control ran" in rendered
        assert "quality is not assessed here at all" in rendered

    def test_both_artifacts_are_written(self, comparison: ModelComparison, tmp_path: Path) -> None:
        json_path, md_path = write_model_comparison(comparison, tmp_path / "out")
        assert json_path.name == COMPARISON_JSON_NAME
        assert md_path.name == COMPARISON_MARKDOWN_NAME
        document = json.loads(json_path.read_text(encoding="utf-8"))
        assert document["kind"] == "poc007_model_comparison"
        assert document["winner"] is None
        assert md_path.read_text(encoding="utf-8").startswith("# Model comparison")
