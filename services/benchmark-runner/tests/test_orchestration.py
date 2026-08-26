"""Batch isolation, idempotent retry, workspace lifecycle and run identity.

These cover the AGENTS.md testing expectations for "Per-image batch failure
isolation", "Idempotent job/run identifiers" and "Temporary-file cleanup".
"""

from __future__ import annotations

from pathlib import Path

from ipw.benchmark_runner.orchestrator import Ledger, RunPlan, execute_run, retry_failed
from ipw.benchmark_runner.policy import DEFAULT_POLICY
from ipw.contracts.manifest import AssetManifest
from ipw.contracts.operation import (
    NoopSettings,
    Operation,
    ProcessingVariant,
    ResizeSettings,
)
from ipw.contracts.result import ResultState
from ipw.contracts.runtime import RunContext, workspace
from ipw.processors.fake import FakeBehaviour, FakeProcessor

NOOP = Operation.build(NoopSettings(), ProcessingVariant.ORIGINAL_CONTROL)
LOCAL_ASSET = "fixture-synthetic-gradient-64"
EXTERNAL_ASSET = "corpus-large-professional-001"


def make_plan(
    manifest: AssetManifest,
    repo_root: Path,
    processor: FakeProcessor,
    operation: Operation = NOOP,
    run_nonce: str = "",
) -> RunPlan:
    return RunPlan.create(
        processor=processor,
        manifest=manifest,
        operation=operation,
        policy=DEFAULT_POLICY,
        asset_root=repo_root,
        manifest_digest="mfst_" + "a" * 32,
        run_nonce=run_nonce,
    )


class TestRunIdentity:
    def test_identical_plans_produce_identical_run_ids(
        self, example_manifest: AssetManifest, repo_root: Path
    ) -> None:
        a = make_plan(example_manifest, repo_root, FakeProcessor())
        b = make_plan(example_manifest, repo_root, FakeProcessor())
        assert a.run_id == b.run_id

    def test_selection_order_does_not_change_the_run_id(
        self, example_manifest: AssetManifest, repo_root: Path
    ) -> None:
        forward = RunPlan.create(
            processor=FakeProcessor(),
            manifest=example_manifest,
            operation=NOOP,
            policy=DEFAULT_POLICY,
            asset_root=repo_root,
            manifest_digest="mfst_" + "a" * 32,
            selected_asset_ids=[LOCAL_ASSET, EXTERNAL_ASSET],
        )
        reverse = RunPlan.create(
            processor=FakeProcessor(),
            manifest=example_manifest,
            operation=NOOP,
            policy=DEFAULT_POLICY,
            asset_root=repo_root,
            manifest_digest="mfst_" + "a" * 32,
            selected_asset_ids=[EXTERNAL_ASSET, LOCAL_ASSET],
        )
        assert forward.run_id == reverse.run_id

    def test_a_different_operation_changes_the_run_id(
        self, example_manifest: AssetManifest, repo_root: Path
    ) -> None:
        resize = Operation.build(
            ResizeSettings(target_width=128), ProcessingVariant.STANDARD_SERVER_AUTHORITATIVE
        )
        assert (
            make_plan(example_manifest, repo_root, FakeProcessor()).run_id
            != make_plan(example_manifest, repo_root, FakeProcessor(), resize).run_id
        )

    def test_a_different_policy_changes_the_run_id(
        self, example_manifest: AssetManifest, repo_root: Path
    ) -> None:
        baseline = make_plan(example_manifest, repo_root, FakeProcessor())
        tightened = RunPlan.create(
            processor=FakeProcessor(),
            manifest=example_manifest,
            operation=NOOP,
            policy=DEFAULT_POLICY.model_copy(update={"max_declared_pixels": 100}),
            asset_root=repo_root,
            manifest_digest="mfst_" + "a" * 32,
        )
        assert baseline.run_id != tightened.run_id

    def test_a_different_processor_version_changes_the_run_id(
        self, example_manifest: AssetManifest, repo_root: Path
    ) -> None:
        assert (
            make_plan(example_manifest, repo_root, FakeProcessor(version="0.1.0")).run_id
            != make_plan(example_manifest, repo_root, FakeProcessor(version="0.2.0")).run_id
        )

    def test_the_nonce_allows_a_deliberate_repeat(
        self, example_manifest: AssetManifest, repo_root: Path
    ) -> None:
        assert (
            make_plan(example_manifest, repo_root, FakeProcessor()).run_id
            != make_plan(example_manifest, repo_root, FakeProcessor(), run_nonce="second").run_id
        )

    def test_result_id_is_derived_from_declared_inputs(
        self, example_manifest: AssetManifest, repo_root: Path
    ) -> None:
        plan = make_plan(example_manifest, repo_root, FakeProcessor())
        entry = next(e for e in plan.entries if e.asset_id == LOCAL_ASSET)
        assert plan.result_id(entry) == plan.result_id(entry)
        assert plan.result_id(entry).startswith("res_")


class TestBatchIsolation:
    def test_one_failing_asset_does_not_stop_the_others(
        self, example_manifest: AssetManifest, repo_root: Path, ctx: RunContext
    ) -> None:
        processor = FakeProcessor(
            behaviour=FakeBehaviour.FAILS_ON_LISTED_ASSETS,
            failing_asset_ids=frozenset({LOCAL_ASSET}),
        )
        run = execute_run(make_plan(example_manifest, repo_root, processor), ctx)

        states = {r.asset_id: r.state for r in run.results}
        assert states[LOCAL_ASSET] is ResultState.FAILED
        # The external asset is skipped because it is not present locally - which
        # is itself an isolated, explained outcome rather than a crash.
        assert states[EXTERNAL_ASSET] is ResultState.SKIPPED
        assert run.summary.total == 2

    def test_a_missing_local_asset_is_skipped_with_an_explanation(
        self, example_manifest: AssetManifest, repo_root: Path, ctx: RunContext
    ) -> None:
        run = execute_run(make_plan(example_manifest, repo_root, FakeProcessor()), ctx)
        external = next(r for r in run.results if r.asset_id == EXTERNAL_ASSET)

        assert external.state is ResultState.SKIPPED
        assert external.failure is not None
        assert external.failure.code.value == "MANIFEST.ASSET_FILE_MISSING"
        assert external.failure.next_action.value == "wait"

    def test_an_unsupported_operation_skips_every_asset_cleanly(
        self, example_manifest: AssetManifest, repo_root: Path, ctx: RunContext
    ) -> None:
        processor = FakeProcessor(behaviour=FakeBehaviour.UNSUPPORTED_OPERATION)
        run = execute_run(make_plan(example_manifest, repo_root, processor), ctx)

        assert run.summary.skipped == 2
        assert all(r.failure is not None for r in run.results)

    def test_results_map_to_the_correct_originals(
        self, example_manifest: AssetManifest, repo_root: Path, ctx: RunContext
    ) -> None:
        run = execute_run(make_plan(example_manifest, repo_root, FakeProcessor()), ctx)
        by_asset = {r.asset_id: r for r in run.results}
        expected = {e.asset_id: e.sha256 for e in example_manifest.assets}
        for asset_id, result in by_asset.items():
            assert result.identity.input_sha256 == expected[asset_id]


class TestIdempotentRetry:
    def test_retry_reuses_the_result_id_and_does_not_duplicate_the_ledger(
        self, example_manifest: AssetManifest, repo_root: Path, ctx: RunContext
    ) -> None:
        processor = FakeProcessor(behaviour=FakeBehaviour.FAILS_THEN_SUCCEEDS)
        plan = make_plan(example_manifest, repo_root, processor)
        ledger = Ledger()

        first = execute_run(plan, ctx, ledger)
        assert first.summary.failed == 1
        assert len(first.ledger) == 0

        second = retry_failed(plan, first, ctx, ledger)
        assert second.summary.failed == 0
        assert second.summary.succeeded == 1

        before = {r.asset_id: r.result_id for r in first.results}
        after = {r.asset_id: r.result_id for r in second.results}
        assert before == after, "a retry must not mint a new result id"

        assert len(second.ledger) == 1, "a retry must not duplicate a usage event"
        assert second.run_id == first.run_id

    def test_the_attempt_counter_increments_but_stays_out_of_the_identity(
        self, example_manifest: AssetManifest, repo_root: Path, ctx: RunContext
    ) -> None:
        processor = FakeProcessor(behaviour=FakeBehaviour.FAILS_THEN_SUCCEEDS)
        plan = make_plan(example_manifest, repo_root, processor)
        ledger = Ledger()

        first = execute_run(plan, ctx, ledger)
        second = retry_failed(plan, first, ctx, ledger)

        retried = next(r for r in second.results if r.asset_id == LOCAL_ASSET)
        assert retried.attempt == 2
        assert retried.measurement.retry_count == 1
        original = next(r for r in first.results if r.asset_id == LOCAL_ASSET)
        assert retried.identity == original.identity

    def test_recording_the_same_result_twice_is_a_no_op(self) -> None:
        from ipw.contracts.operation import OperationKind
        from ipw.contracts.result import LedgerEntry

        entry = LedgerEntry(
            result_id="res_" + "a" * 32,
            run_id="run_" + "b" * 32,
            asset_id="some-asset",
            operation_kind=OperationKind.NOOP,
        )
        ledger = Ledger()
        assert ledger.record(entry) is True
        assert ledger.record(entry) is False
        assert len(ledger) == 1

    def test_a_successful_run_records_exactly_one_ledger_entry_per_success(
        self, example_manifest: AssetManifest, repo_root: Path, ctx: RunContext
    ) -> None:
        ledger = Ledger()
        run = execute_run(make_plan(example_manifest, repo_root, FakeProcessor()), ctx, ledger)
        assert run.summary.succeeded == 1
        assert len(run.ledger) == 1

    def test_re_executing_an_identical_run_does_not_duplicate_the_ledger(
        self, example_manifest: AssetManifest, repo_root: Path, ctx: RunContext
    ) -> None:
        ledger = Ledger()
        plan = make_plan(example_manifest, repo_root, FakeProcessor())
        execute_run(plan, ctx, ledger)
        second = execute_run(plan, ctx, ledger)
        assert len(second.ledger) == 1


class TestWorkspaceLifecycle:
    def test_the_workspace_is_removed_after_success(self, tmp_path: Path) -> None:
        with workspace(tmp_path / "tmp", "t") as ws:
            root = ws.root
            ws.write_bytes("out.bin", b"data")
            assert root.exists()
        assert not root.exists()

    def test_the_workspace_is_removed_after_an_exception(self, tmp_path: Path) -> None:
        captured: Path | None = None
        try:
            with workspace(tmp_path / "tmp", "t") as ws:
                captured = ws.root
                msg = "boom"
                raise RuntimeError(msg)
        except RuntimeError:
            pass
        assert captured is not None
        assert not captured.exists()

    def test_no_workspace_survives_a_full_run(
        self, example_manifest: AssetManifest, repo_root: Path, tmp_path: Path
    ) -> None:
        temp_root = tmp_path / "tmp"
        ctx = RunContext.create(temp_root=temp_root, deterministic=True)
        execute_run(make_plan(example_manifest, repo_root, FakeProcessor()), ctx)

        leftovers = list(temp_root.iterdir()) if temp_root.exists() else []
        assert leftovers == [], f"temporary artifacts leaked: {leftovers}"

    def test_workspace_paths_cannot_escape(self, tmp_path: Path) -> None:
        import pytest

        with workspace(tmp_path / "tmp", "t") as ws:
            for hostile in ("..", "../escape", "."):
                with pytest.raises(ValueError, match=r"workspace|invalid"):
                    ws.path(hostile)

    def test_run_context_cleans_its_temp_root_on_exit(self, tmp_path: Path) -> None:
        temp_root = tmp_path / "ctx-tmp"
        with RunContext.create(temp_root=temp_root, deterministic=True) as context:
            with context.workspace("t") as ws:
                ws.write_bytes("x.bin", b"1")
            assert temp_root.exists()
        assert not temp_root.exists()
