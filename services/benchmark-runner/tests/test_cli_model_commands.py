"""The `ai-baseline` and `compare-models` commands (POC-006, POC-007).

Deliberately the *failure* paths, plus argument wiring. A successful run of either
command loads several hundred megabytes of weights and takes minutes, and is
already covered end-to-end by the adapter suites and by the committed reports.
What is not covered elsewhere is how these commands behave when something is
wrong - which is where CLI defects actually live, and the one place a benchmark
tool must not crash: a bad manifest or an absent model has to produce a diagnosis,
not a traceback.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from ipw.benchmark_runner.cli import EXIT_INTERNAL_ERROR, EXIT_VALIDATION_FAILED, build_parser, main


class TestArgumentWiring:
    @pytest.mark.parametrize("command", ["ai-baseline", "compare-models"])
    def test_the_command_is_registered(self, command: str) -> None:
        parser = build_parser()
        args = parser.parse_args([command, "--manifest", "m.json", "--out", "o"])
        assert args.func is not None
        assert args.purpose == "internal_benchmark"

    def test_compare_models_defaults_to_super_resolution_at_x4(self) -> None:
        args = build_parser().parse_args(["compare-models", "--manifest", "m", "--out", "o"])
        assert args.operation == "super_resolution"
        assert args.scale == 4

    @pytest.mark.parametrize(
        "operation", ["super_resolution", "ai_denoise", "jpeg_artifact_repair"]
    )
    def test_every_poc007_operation_is_selectable(self, operation: str) -> None:
        args = build_parser().parse_args(
            ["compare-models", "--manifest", "m", "--out", "o", "--operation", operation]
        )
        assert args.operation == operation

    def test_an_unsupported_scale_is_refused_by_the_parser(self) -> None:
        """Only x2 and x4 have pinned weights; the parser says so before anything loads."""
        with pytest.raises(SystemExit):
            build_parser().parse_args(
                ["compare-models", "--manifest", "m", "--out", "o", "--scale", "3"]
            )

    def test_every_purpose_is_selectable(self) -> None:
        """A run must be able to declare what it is for; that is what D-038 gates on."""
        for purpose in ("local_research", "internal_benchmark", "production"):
            args = build_parser().parse_args(
                ["compare-models", "--manifest", "m", "--out", "o", "--purpose", purpose]
            )
            assert args.purpose == purpose


@pytest.fixture
def broken_manifest(tmp_path: Path) -> Path:
    """A manifest that validates as JSON and fails as a manifest."""
    path = tmp_path / "broken.manifest.json"
    path.write_text(
        json.dumps(
            {
                "schema_version": "1.3.0",
                "manifest_id": "broken",
                "name": "broken",
                "assets": [
                    {
                        "asset_id": "missing-asset",
                        "category": "synthetic_fixture",
                        "relative_path": "data/fixtures/images/does-not-exist.png",
                        "sha256": "0" * 64,
                        "declared_media_type": "image/png",
                        "declared_extension": ".png",
                        "declared_bytes": 1,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    return path


class TestManifestFailuresAreDiagnosed:
    """A benchmark tool that crashes on a bad manifest is not usable unattended."""

    @pytest.mark.parametrize("command", ["ai-baseline", "compare-models"])
    def test_a_broken_manifest_exits_with_the_validation_code(
        self, command: str, broken_manifest: Path, tmp_path: Path, repo_root: Path
    ) -> None:
        code = main(
            [
                command,
                "--manifest",
                str(broken_manifest),
                "--out",
                str(tmp_path / "out"),
                "--asset-root",
                str(repo_root),
            ]
        )
        assert code == EXIT_VALIDATION_FAILED

    @pytest.mark.parametrize("command", ["ai-baseline", "compare-models"])
    def test_nothing_is_written_when_the_manifest_fails(
        self, command: str, broken_manifest: Path, tmp_path: Path, repo_root: Path
    ) -> None:
        out = tmp_path / "out"
        main(
            [
                command,
                "--manifest",
                str(broken_manifest),
                "--out",
                str(out),
                "--asset-root",
                str(repo_root),
            ]
        )
        assert not out.exists(), "a refused run must not leave a half-written report behind"

    @pytest.mark.parametrize("command", ["ai-baseline", "compare-models"])
    def test_an_unreadable_manifest_is_an_error_not_a_traceback(
        self, command: str, tmp_path: Path, repo_root: Path
    ) -> None:
        code = main(
            [
                command,
                "--manifest",
                str(tmp_path / "absent.json"),
                "--out",
                str(tmp_path / "out"),
                "--asset-root",
                str(repo_root),
            ]
        )
        assert code in {EXIT_INTERNAL_ERROR, EXIT_VALIDATION_FAILED}


class TestMissingWeightsAreReported:
    def test_ai_baseline_reports_absent_weights(
        self,
        tmp_path: Path,
        repo_root: Path,
        example_manifest_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        """An uninstalled model is a routing fact, not a crash."""
        pytest.importorskip("torch")
        from ipw.processors.ai_adapters import RealEsrganAdapter

        monkeypatch.setattr(RealEsrganAdapter, "available", lambda self: False)
        code = main(
            [
                "ai-baseline",
                "--manifest",
                str(example_manifest_path),
                "--out",
                str(tmp_path / "out"),
                "--asset-root",
                str(repo_root),
            ]
        )
        assert code == EXIT_INTERNAL_ERROR
        assert "install_model_weights" in capsys.readouterr().err

    def test_compare_models_skips_unavailable_candidates(
        self,
        tmp_path: Path,
        repo_root: Path,
        example_manifest_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        """One absent model must not stop the others being compared."""
        pytest.importorskip("torch")
        from ipw.processors.ai_adapters import RealEsrganAdapter, SwinIrAdapter

        monkeypatch.setattr(RealEsrganAdapter, "available", lambda self: False)
        monkeypatch.setattr(SwinIrAdapter, "available", lambda self: False)

        code = main(
            [
                "compare-models",
                "--manifest",
                str(example_manifest_path),
                "--out",
                str(tmp_path / "out"),
                "--asset-root",
                str(repo_root),
            ]
        )
        captured = capsys.readouterr()
        assert "skipping real-esrgan" in captured.out
        assert "skipping swinir" in captured.out
        # The deterministic control is still available, so the run proceeds.
        assert code == 0
        assert (tmp_path / "out" / "model-comparison.json").is_file()

    def test_a_comparison_with_no_available_candidate_fails_cleanly(
        self,
        tmp_path: Path,
        repo_root: Path,
        example_manifest_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        pytest.importorskip("torch")
        from ipw.processors.ai_adapters import SwinIrAdapter

        monkeypatch.setattr(SwinIrAdapter, "available", lambda self: False)
        code = main(
            [
                "compare-models",
                "--manifest",
                str(example_manifest_path),
                "--out",
                str(tmp_path / "out"),
                "--operation",
                "jpeg_artifact_repair",
            ]
        )
        assert code == EXIT_INTERNAL_ERROR
        assert "no candidate is available" in capsys.readouterr().err


class TestReviewCommands:
    """`review-build` and `review-aggregate` (POC-008)."""

    def test_both_commands_are_registered(self) -> None:
        parser = build_parser()
        built = parser.parse_args(
            ["review-build", "--comparison", "c", "--out", "o", "--sealed-key", "k.json"]
        )
        assert built.func is not None
        aggregated = parser.parse_args(
            ["review-aggregate", "--package", "p.json", "--scores", "s.json", "--out", "o"]
        )
        assert aggregated.func is not None
        assert aggregated.sealed_key is None, "the key stays shut unless asked for"

    def test_dimensions_are_repeatable(self) -> None:
        args = build_parser().parse_args(
            [
                "review-build",
                "--comparison",
                "c",
                "--out",
                "o",
                "--sealed-key",
                "k.json",
                "--dimension",
                "overall_usefulness",
                "--dimension",
                "text_logo_accuracy",
            ]
        )
        assert args.dimension == ["overall_usefulness", "text_logo_accuracy"]

    def test_an_unknown_dimension_is_refused(self) -> None:
        with pytest.raises(SystemExit):
            build_parser().parse_args(
                [
                    "review-build",
                    "--comparison",
                    "c",
                    "--out",
                    "o",
                    "--sealed-key",
                    "k.json",
                    "--dimension",
                    "vibes",
                ]
            )

    def test_a_missing_comparison_is_diagnosed(self, tmp_path: Path) -> None:
        code = main(
            [
                "review-build",
                "--comparison",
                str(tmp_path / "absent"),
                "--out",
                str(tmp_path / "pkg"),
                "--sealed-key",
                str(tmp_path / "key.json"),
            ]
        )
        assert code == EXIT_INTERNAL_ERROR

    def test_the_sealed_key_may_not_live_inside_the_package(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """The one mistake that would silently unblind every future review.

        Refused before anything is written, and refused on the argument rather
        than on the outcome - a key written and then moved has already been in the
        package directory.
        """
        package_dir = tmp_path / "pkg"
        code = main(
            [
                "review-build",
                "--comparison",
                str(tmp_path / "comparison"),
                "--out",
                str(package_dir),
                "--sealed-key",
                str(package_dir / "sealed-key.json"),
            ]
        )
        assert code == EXIT_INTERNAL_ERROR
        assert "refusing to write the sealed key inside" in capsys.readouterr().err
        assert not package_dir.exists(), "nothing may be written when the layout is refused"

    def test_a_nested_sealed_key_path_is_also_refused(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        package_dir = tmp_path / "pkg"
        code = main(
            [
                "review-build",
                "--comparison",
                str(tmp_path / "comparison"),
                "--out",
                str(package_dir),
                "--sealed-key",
                str(package_dir / "nested" / "deeper" / "sealed-key.json"),
            ]
        )
        assert code == EXIT_INTERNAL_ERROR
        assert "refusing to write the sealed key inside" in capsys.readouterr().err

    def test_build_then_aggregate_round_trips(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """End to end through the CLI, with a critical failure on the best item."""
        from ipw.benchmark_runner.model_comparison import (
            Candidate,
            build_model_comparison,
            write_model_comparison,
        )
        from ipw.benchmark_runner.policy import DEFAULT_POLICY
        from ipw.benchmark_runner.validation import validate_manifest_file
        from ipw.contracts.operation import NoopSettings, Operation, ProcessingVariant
        from ipw.contracts.runtime import RunContext
        from ipw.processors.standard import pillow_processor

        repo_root = Path(__file__).resolve().parents[3]
        _, manifest = validate_manifest_file(
            repo_root / "data" / "manifests" / "example.manifest.json",
            policy=DEFAULT_POLICY,
            asset_root=repo_root,
        )
        assert manifest is not None

        noop = Operation.build(NoopSettings(), ProcessingVariant.ORIGINAL_CONTROL)
        comparison = build_model_comparison(
            candidates=(
                Candidate(
                    label="control",
                    processor=pillow_processor(),
                    operation=noop,
                    is_control=True,
                ),
                Candidate(label="model", processor=pillow_processor(), operation=noop),
            ),
            manifest=manifest,
            manifest_digest="mfst_" + "c" * 32,
            policy=DEFAULT_POLICY,
            asset_root=repo_root,
            ctx=RunContext.create(temp_root=tmp_path / "tmp", deterministic=True),
            output_root=tmp_path / "comparison" / "outputs",
        )
        write_model_comparison(comparison, tmp_path / "comparison")

        code = main(
            [
                "review-build",
                "--comparison",
                str(tmp_path / "comparison"),
                "--out",
                str(tmp_path / "pkg"),
                "--sealed-key",
                str(tmp_path / "sealed" / "key.json"),
                "--seed",
                "cli-round-trip",
                "--deterministic",
            ]
        )
        assert code == 0, capsys.readouterr().err
        package_path = tmp_path / "pkg" / "review-package.json"
        assert package_path.is_file()

        package = json.loads(package_path.read_text(encoding="utf-8"))
        labels = [item["label"] for item in package["items"]]
        assert labels, "the package has no items to review"

        scores = [
            {
                "label": labels[0],
                "reviewer_id": "reviewer-a",
                "scores": {"overall_usefulness": 5},
                "critical_failures": [],
            },
            {
                "label": labels[0],
                "reviewer_id": "reviewer-b",
                "scores": {"overall_usefulness": 5},
                "critical_failures": ["text_or_logo_changed"],
            },
        ]
        scores_path = tmp_path / "scores.json"
        scores_path.write_text(json.dumps(scores), encoding="utf-8")

        code = main(
            [
                "review-aggregate",
                "--package",
                str(package_path),
                "--scores",
                str(scores_path),
                "--out",
                str(tmp_path / "aggregated"),
                "--sealed-key",
                str(tmp_path / "sealed" / "key.json"),
            ]
        )
        assert code == 0
        output = capsys.readouterr().out
        assert "CRITICAL FAILURE" in output, "a perfect-scoring item still failed; say so"
        assert (tmp_path / "aggregated" / "review-attribution.json").is_file()
