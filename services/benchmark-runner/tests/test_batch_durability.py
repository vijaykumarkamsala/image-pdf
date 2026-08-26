"""Durable batch execution at 1, 10 and 50 items (POC-013).

Acceptance criteria:

* Per-item state and failure isolation work.
* Retry is idempotent.
* Corrupt inputs do not stop valid items.
* Closing the client does not stop cloud work.
* Temporary artifacts are cleaned.
* Results map to the correct originals.

The fixtures are generated per test rather than committed. Fifty images is a lot
of bytes to carry in Git for a property that is about *count*, and generating them
makes the mixed-batch tests state their own composition instead of depending on a
directory someone might tidy.
"""

from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path

import pytest

from ipw.benchmark_runner.batch import (
    JOURNAL_NAME,
    BatchOutcome,
    execute_batch,
    read_journal,
    resume_batch,
)
from ipw.benchmark_runner.orchestrator import Ledger, RunPlan, retry_failed
from ipw.benchmark_runner.policy import DEFAULT_POLICY
from ipw.contracts.asset import (
    AssetCategory,
    AssetManifestEntry,
    MediaType,
    Provenance,
)
from ipw.contracts.manifest import AssetManifest
from ipw.contracts.operation import NoopSettings, Operation, ProcessingVariant
from ipw.contracts.result import ResultState
from ipw.contracts.runtime import RunContext
from ipw.processors.standard import pillow_processor

NOOP = Operation.build(NoopSettings(), ProcessingVariant.ORIGINAL_CONTROL)


def make_image(path: Path, seed: int) -> bytes:
    """A small, deterministic, genuinely distinct image."""
    from PIL import Image

    image = Image.new("RGB", (16, 16))
    pixels = image.load()
    assert pixels is not None
    for y in range(16):
        for x in range(16):
            pixels[x, y] = ((x * 11 + seed) % 256, (y * 17 + seed) % 256, (seed * 7) % 256)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    payload = buffer.getvalue()
    path.write_bytes(payload)
    return payload


def build_manifest(
    root: Path, count: int, *, corrupt_every: int = 0, missing_every: int = 0
) -> AssetManifest:
    """A manifest of ``count`` assets, optionally salted with bad ones.

    ``corrupt_every`` writes a file whose bytes are not an image. ``missing_every``
    declares an asset with no file at all. Both are the shapes a real batch hits,
    and both must leave their neighbours alone.
    """
    assets_dir = root / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)
    entries: list[AssetManifestEntry] = []

    for index in range(count):
        asset_id = f"batch-asset-{index:03d}"
        name = f"{asset_id}.png"
        path = assets_dir / name

        if missing_every and index % missing_every == 0:
            payload = b"never written"
            declared = hashlib.sha256(payload).hexdigest()
        elif corrupt_every and index % corrupt_every == 0:
            payload = b"this is not a PNG, whatever the extension claims"
            path.write_bytes(payload)
            declared = hashlib.sha256(payload).hexdigest()
        else:
            payload = make_image(path, index)
            declared = hashlib.sha256(payload).hexdigest()

        entries.append(
            AssetManifestEntry(
                asset_id=asset_id,
                category=AssetCategory.SYNTHETIC_FIXTURE,
                relative_path=f"assets/{name}",
                sha256=declared,
                declared_media_type=MediaType.PNG,
                declared_extension=".png",
                declared_bytes=len(payload),
                declared_width=16,
                declared_height=16,
                declared_channels=3,
                declared_bit_depth=8,
                provenance=Provenance(
                    source="generated-in-test",
                    owner="Image & PDF Workspace POC",
                    licence="CC0-1.0 (synthetic, generated per test run)",
                    permitted_benchmark_use=True,
                    public_demo_permitted=True,
                    contains_people=False,
                    contains_sensitive_information=False,
                    acquired_on="2026-08-25",
                ),
            )
        )

    return AssetManifest(
        manifest_id="batch-durability",
        name="batch durability fixture",
        assets=tuple(entries),
    )


def make_plan(manifest: AssetManifest, root: Path) -> RunPlan:
    return RunPlan.create(
        processor=pillow_processor(),
        manifest=manifest,
        operation=NOOP,
        policy=DEFAULT_POLICY,
        asset_root=root,
        manifest_digest="mfst_" + "c" * 32,
        run_label="poc013-batch",
    )


def run_batch(root: Path, count: int, **kwargs: int) -> tuple[BatchOutcome, RunPlan, Path]:
    manifest = build_manifest(root, count, **kwargs)
    plan = make_plan(manifest, root)
    ctx = RunContext.create(temp_root=root / "tmp", deterministic=True)
    journal = root / JOURNAL_NAME
    return execute_batch(plan, ctx, journal), plan, journal


# ------------------------------------------------------------------- sizes ---


class TestMixedBatchSizes:
    """POC-013 names 1, 10 and 50 explicitly."""

    @pytest.mark.parametrize("count", [1, 10, 50])
    def test_every_item_produces_exactly_one_result(self, tmp_path: Path, count: int) -> None:
        outcome, _, _ = run_batch(tmp_path, count)
        assert len(outcome.run.results) == count
        assert len({result.identity.asset_id for result in outcome.run.results}) == count

    @pytest.mark.parametrize("count", [1, 10, 50])
    def test_results_map_to_the_correct_originals(self, tmp_path: Path, count: int) -> None:
        """Order is not identity. Each result must carry the input it was given."""
        manifest = build_manifest(tmp_path, count)
        plan = make_plan(manifest, tmp_path)
        ctx = RunContext.create(temp_root=tmp_path / "tmp", deterministic=True)
        outcome = execute_batch(plan, ctx, tmp_path / JOURNAL_NAME)

        declared = {entry.asset_id: entry.sha256 for entry in manifest.assets}
        for result in outcome.run.results:
            assert result.identity.input_sha256 == declared[result.identity.asset_id], (
                f"{result.identity.asset_id} was processed from the wrong input"
            )

    def test_a_fifty_item_batch_leaves_no_temporary_artifacts(self, tmp_path: Path) -> None:
        outcome, _, _ = run_batch(tmp_path, 50)
        assert outcome.run.summary.succeeded == 50
        temp_root = tmp_path / "tmp"
        leftovers = list(temp_root.iterdir()) if temp_root.exists() else []
        assert leftovers == [], f"temporary artifacts survived the batch: {leftovers}"


# ------------------------------------------------------- failure isolation ---


class TestFailureIsolation:
    def test_corrupt_inputs_do_not_stop_valid_items(self, tmp_path: Path) -> None:
        outcome, _, _ = run_batch(tmp_path, 10, corrupt_every=3)
        states = {r.identity.asset_id: r.state for r in outcome.run.results}
        failed = [asset for asset, state in states.items() if state is not ResultState.SUCCEEDED]
        succeeded = [asset for asset, state in states.items() if state is ResultState.SUCCEEDED]

        assert failed, "the fixture is not exercising failure"
        assert len(succeeded) == 10 - len(failed)
        assert len(outcome.run.results) == 10, "a failure must not shorten the batch"

    def test_missing_files_do_not_stop_valid_items(self, tmp_path: Path) -> None:
        """A declared asset with no file is SKIPPED, not FAILED.

        The distinction is load-bearing rather than cosmetic: skipped means the
        processor never ran, so the item is a candidate for a later resume once
        the asset arrives. Failed means it ran and could not finish.
        """
        outcome, _, _ = run_batch(tmp_path, 10, missing_every=4)
        assert len(outcome.run.results) == 10
        assert outcome.run.summary.succeeded > 0
        assert outcome.run.summary.skipped > 0
        assert outcome.run.summary.failed == 0

    def test_a_failure_carries_a_normalised_reason(self, tmp_path: Path) -> None:
        outcome, _, _ = run_batch(tmp_path, 6, corrupt_every=2)
        for result in outcome.run.results:
            if result.state is ResultState.SUCCEEDED:
                continue
            assert result.failure is not None
            assert result.failure.code.value
            assert result.failure.next_action.value

    def test_every_item_keeps_its_own_state(self, tmp_path: Path) -> None:
        """Per-item state, not a batch-level verdict."""
        outcome, _, _ = run_batch(tmp_path, 10, corrupt_every=5)
        states = {result.state for result in outcome.run.results}
        assert len(states) > 1, "a mixed batch must not collapse to one state"


# ------------------------------------------------------------- durability ----


class TestClosingTheClientDoesNotLoseWork:
    """The criterion that required a journal rather than an in-memory run."""

    def test_results_are_on_disk_before_the_batch_ends(self, tmp_path: Path) -> None:
        _, _, journal = run_batch(tmp_path, 10)
        recovered = read_journal(journal)
        assert len(recovered.results) == 10
        assert recovered.complete

    def test_a_journal_from_a_killed_process_is_still_readable(self, tmp_path: Path) -> None:
        """Simulate the kill: drop the completion record and half the items."""
        _, _, journal = run_batch(tmp_path, 10)
        lines = journal.read_text(encoding="utf-8").splitlines()
        partial = [line for line in lines if '"run_finished"' not in line][:6]
        journal.write_text("\n".join(partial) + "\n", encoding="utf-8", newline="\n")

        recovered = read_journal(journal)
        assert not recovered.complete
        assert 0 < len(recovered.results) < 10

    def test_a_half_written_final_line_is_discarded_not_fatal(self, tmp_path: Path) -> None:
        """A process killed mid-write leaves a truncated record.

        Losing that one item is recoverable by reprocessing it. Refusing to parse
        the file would lose every item before it as well.
        """
        _, _, journal = run_batch(tmp_path, 10)
        text = journal.read_text(encoding="utf-8")
        journal.write_text(text[: len(text) - 40], encoding="utf-8", newline="\n")

        recovered = read_journal(journal)
        assert recovered.truncated_records >= 1
        assert len(recovered.results) >= 8, "one bad line must not discard the good ones"

    @pytest.mark.parametrize("cut", [0.2, 0.5, 0.8, 0.95])
    def test_a_journal_truncated_anywhere_still_loads(self, tmp_path: Path, cut: float) -> None:
        """Truncation is not a special case that happens at line boundaries."""
        _, _, journal = run_batch(tmp_path, 10)
        text = journal.read_text(encoding="utf-8")
        journal.write_text(text[: int(len(text) * cut)], encoding="utf-8", newline="\n")

        recovered = read_journal(journal)  # must not raise
        assert not recovered.complete
        assert len(recovered.results) <= 10

    def test_an_absent_journal_is_an_empty_one(self, tmp_path: Path) -> None:
        recovered = read_journal(tmp_path / "never-written.jsonl")
        assert recovered.results == {}
        assert not recovered.complete


class TestResume:
    def test_resume_processes_only_what_never_ran(self, tmp_path: Path) -> None:
        manifest = build_manifest(tmp_path, 10)
        plan = make_plan(manifest, tmp_path)
        ctx = RunContext.create(temp_root=tmp_path / "tmp", deterministic=True)
        journal = tmp_path / JOURNAL_NAME

        execute_batch(plan, ctx, journal)
        lines = journal.read_text(encoding="utf-8").splitlines()
        kept = [line for line in lines if '"run_finished"' not in line][:5]
        journal.write_text("\n".join(kept) + "\n", encoding="utf-8", newline="\n")
        already = len(read_journal(journal).results)

        outcome = resume_batch(plan, ctx, journal)
        assert outcome.was_resumed
        assert outcome.reused_from_journal == already
        assert outcome.processed == 10 - already
        assert len(outcome.run.results) == 10

    def test_resuming_a_complete_batch_does_nothing(self, tmp_path: Path) -> None:
        manifest = build_manifest(tmp_path, 10)
        plan = make_plan(manifest, tmp_path)
        ctx = RunContext.create(temp_root=tmp_path / "tmp", deterministic=True)
        journal = tmp_path / JOURNAL_NAME

        execute_batch(plan, ctx, journal)
        outcome = resume_batch(plan, ctx, journal)
        assert outcome.processed == 0
        assert outcome.reused_from_journal == 10

    def test_resume_is_repeatable(self, tmp_path: Path) -> None:
        """Running it three times must not process anything a second time."""
        manifest = build_manifest(tmp_path, 5)
        plan = make_plan(manifest, tmp_path)
        ctx = RunContext.create(temp_root=tmp_path / "tmp", deterministic=True)
        journal = tmp_path / JOURNAL_NAME

        execute_batch(plan, ctx, journal)
        for _ in range(3):
            assert resume_batch(plan, ctx, journal).processed == 0

    def test_resume_does_not_duplicate_ledger_entries(self, tmp_path: Path) -> None:
        """A resumed batch must not bill the same result twice."""
        manifest = build_manifest(tmp_path, 10)
        plan = make_plan(manifest, tmp_path)
        ctx = RunContext.create(temp_root=tmp_path / "tmp", deterministic=True)
        journal = tmp_path / JOURNAL_NAME

        first = execute_batch(plan, ctx, journal)
        billed = len(first.run.ledger)

        lines = journal.read_text(encoding="utf-8").splitlines()
        journal.write_text(
            "\n".join(line for line in lines if '"run_finished"' not in line) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        resumed = resume_batch(plan, ctx, journal, Ledger())

        assert len(resumed.run.ledger) == billed
        result_ids = [entry.result_id for entry in resumed.run.ledger]
        assert len(result_ids) == len(set(result_ids)), "the ledger gained a duplicate"

    def test_a_resumed_run_keeps_its_original_start_time(self, tmp_path: Path) -> None:
        """Otherwise the elapsed figure describes the resume, not the work."""
        manifest = build_manifest(tmp_path, 4)
        plan = make_plan(manifest, tmp_path)
        ctx = RunContext.create(temp_root=tmp_path / "tmp", deterministic=True)
        journal = tmp_path / JOURNAL_NAME

        first = execute_batch(plan, ctx, journal)
        resumed = resume_batch(plan, ctx, journal)
        assert resumed.run.started_at == first.run.started_at

    def test_a_resumed_run_says_so(self, tmp_path: Path) -> None:
        manifest = build_manifest(tmp_path, 4)
        plan = make_plan(manifest, tmp_path)
        ctx = RunContext.create(temp_root=tmp_path / "tmp", deterministic=True)
        journal = tmp_path / JOURNAL_NAME

        execute_batch(plan, ctx, journal)
        notes = resume_batch(plan, ctx, journal).run.notes
        assert notes is not None
        assert "resumed" in notes

    def test_an_asset_that_arrives_late_is_processed_on_resume(self, tmp_path: Path) -> None:
        """The reason SKIPPED is not treated as settled.

        A declared asset can be absent because it lives in external storage and
        has not been fetched yet. If a resume treated that skip as final, the
        asset would be stranded forever on a condition that had already been
        fixed - and on a fifty-item batch nobody would notice which one.
        """
        manifest = build_manifest(tmp_path, 6, missing_every=6)
        plan = make_plan(manifest, tmp_path)
        ctx = RunContext.create(temp_root=tmp_path / "tmp", deterministic=True)
        journal = tmp_path / JOURNAL_NAME

        first = execute_batch(plan, ctx, journal)
        skipped = [
            result.identity.asset_id
            for result in first.run.results
            if result.state is ResultState.SKIPPED
        ]
        assert skipped, "the fixture is not exercising a missing asset"

        # The asset arrives. Its bytes must match what the manifest declared.
        for asset_id in skipped:
            entry = next(item for item in manifest.assets if item.asset_id == asset_id)
            assert entry.relative_path is not None
            (tmp_path / entry.relative_path).write_bytes(b"never written")

        resumed = resume_batch(plan, ctx, journal)
        assert resumed.processed == len(skipped), (
            "a resume must re-attempt an asset that was skipped, not keep the skip"
        )
        assert resumed.reused_from_journal == 6 - len(skipped)

    def test_a_settled_failure_is_not_reprocessed_by_resume(self, tmp_path: Path) -> None:
        """Resume is not retry. A failure that ran and concluded is left alone."""
        manifest = build_manifest(tmp_path, 6, corrupt_every=3)
        plan = make_plan(manifest, tmp_path)
        ctx = RunContext.create(temp_root=tmp_path / "tmp", deterministic=True)
        journal = tmp_path / JOURNAL_NAME

        first = execute_batch(plan, ctx, journal)
        failed = [r for r in first.run.results if r.state is ResultState.FAILED]
        assert failed, "the fixture is not exercising failure"

        resumed = resume_batch(plan, ctx, journal)
        assert resumed.processed == 0, "resume reprocessed a settled failure"


class TestRetryIsIdempotent:
    def test_retrying_reuses_the_result_id(self, tmp_path: Path) -> None:
        """A retry is the same result, attempted again - not a new result."""
        manifest = build_manifest(tmp_path, 6, corrupt_every=2)
        plan = make_plan(manifest, tmp_path)
        ctx = RunContext.create(temp_root=tmp_path / "tmp", deterministic=True)
        ledger = Ledger()

        first = execute_batch(plan, ctx, tmp_path / JOURNAL_NAME, ledger).run
        before = {r.identity.asset_id: r.result_id for r in first.results}

        retried = retry_failed(plan, first, ctx, ledger)
        after = {r.identity.asset_id: r.result_id for r in retried.results}
        assert before == after

    def test_retrying_does_not_duplicate_ledger_entries(self, tmp_path: Path) -> None:
        manifest = build_manifest(tmp_path, 6, corrupt_every=2)
        plan = make_plan(manifest, tmp_path)
        ctx = RunContext.create(temp_root=tmp_path / "tmp", deterministic=True)
        ledger = Ledger()

        first = execute_batch(plan, ctx, tmp_path / JOURNAL_NAME, ledger).run
        billed = len(first.ledger)
        retried = retry_failed(plan, first, ctx, ledger)

        assert len(retried.ledger) == billed
        ids = [entry.result_id for entry in retried.ledger]
        assert len(ids) == len(set(ids))

    def test_retrying_does_not_reprocess_successes(self, tmp_path: Path) -> None:
        manifest = build_manifest(tmp_path, 6, corrupt_every=2)
        plan = make_plan(manifest, tmp_path)
        ctx = RunContext.create(temp_root=tmp_path / "tmp", deterministic=True)
        ledger = Ledger()

        first = execute_batch(plan, ctx, tmp_path / JOURNAL_NAME, ledger).run
        succeeded_before = {
            r.identity.asset_id: r.attempt
            for r in first.results
            if r.state is ResultState.SUCCEEDED
        }
        retried = retry_failed(plan, first, ctx, ledger)
        for result in retried.results:
            if result.identity.asset_id in succeeded_before:
                assert result.attempt == succeeded_before[result.identity.asset_id]

    def test_a_retried_failure_records_a_higher_attempt(self, tmp_path: Path) -> None:
        manifest = build_manifest(tmp_path, 6, corrupt_every=2)
        plan = make_plan(manifest, tmp_path)
        ctx = RunContext.create(temp_root=tmp_path / "tmp", deterministic=True)
        ledger = Ledger()

        first = execute_batch(plan, ctx, tmp_path / JOURNAL_NAME, ledger).run
        retried = retry_failed(plan, first, ctx, ledger)
        bumped = [r for r in retried.results if r.attempt > 1]
        assert bumped, "nothing was retried; the fixture is not exercising retry"


class TestJournalShape:
    def test_the_journal_is_one_json_object_per_line(self, tmp_path: Path) -> None:
        _, _, journal = run_batch(tmp_path, 5)
        for line in journal.read_text(encoding="utf-8").splitlines():
            assert isinstance(json.loads(line), dict)

    def test_the_journal_opens_and_closes_with_run_records(self, tmp_path: Path) -> None:
        _, _, journal = run_batch(tmp_path, 5)
        lines = [json.loads(line) for line in journal.read_text(encoding="utf-8").splitlines()]
        assert lines[0]["kind"] == "run_started"
        assert lines[-1]["kind"] == "run_finished"
        assert sum(1 for line in lines if line["kind"] == "item") == 5

    def test_each_item_record_names_its_asset(self, tmp_path: Path) -> None:
        _, _, journal = run_batch(tmp_path, 5)
        for line in journal.read_text(encoding="utf-8").splitlines():
            record = json.loads(line)
            if record["kind"] == "item":
                assert record["asset_id"] == record["result"]["identity"]["asset_id"]


class TestBatchCli:
    """`bench batch` and `bench batch-status` (POC-013)."""

    def test_the_commands_are_registered(self) -> None:
        from ipw.benchmark_runner.cli import build_parser

        parser = build_parser()
        batch = parser.parse_args(["batch", "--manifest", "m.json", "--out", "o"])
        assert batch.func is not None
        assert batch.resume is False, "a plain batch must not silently resume"

        status = parser.parse_args(["batch-status", "--journal", "j.jsonl"])
        assert status.func is not None

    def test_a_broken_manifest_starts_no_batch(self, tmp_path: Path, repo_root: Path) -> None:
        from ipw.benchmark_runner.cli import EXIT_VALIDATION_FAILED, main

        bad = tmp_path / "bad.manifest.json"
        bad.write_text('{"manifest_id": "broken"}', encoding="utf-8")
        code = main(
            [
                "batch",
                "--manifest",
                str(bad),
                "--out",
                str(tmp_path / "out"),
                "--asset-root",
                str(repo_root),
            ]
        )
        assert code == EXIT_VALIDATION_FAILED
        assert not (tmp_path / "out").exists()

    def test_status_of_an_absent_journal_is_an_error(self, tmp_path: Path) -> None:
        from ipw.benchmark_runner.cli import EXIT_INTERNAL_ERROR, main

        assert main(["batch-status", "--journal", str(tmp_path / "nothing.jsonl")]) == (
            EXIT_INTERNAL_ERROR
        )

    def test_run_then_status_then_resume(
        self,
        tmp_path: Path,
        repo_root: Path,
        example_manifest_path: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        """The whole durability story, through the CLI a person would use."""
        from ipw.benchmark_runner.cli import main

        out = tmp_path / "batch"
        assert (
            main(
                [
                    "batch",
                    "--manifest",
                    str(example_manifest_path),
                    "--out",
                    str(out),
                    "--asset-root",
                    str(repo_root),
                    "--deterministic",
                ]
            )
            == 0
        )
        journal = out / JOURNAL_NAME
        assert journal.is_file()
        capsys.readouterr()

        # A separate invocation reads the state - the point of durability is that
        # the process which started the run need not be the one that inspects it.
        assert main(["batch-status", "--journal", str(journal)]) == 0
        assert "complete         : yes" in capsys.readouterr().out

        assert (
            main(
                [
                    "batch",
                    "--manifest",
                    str(example_manifest_path),
                    "--out",
                    str(out),
                    "--asset-root",
                    str(repo_root),
                    "--resume",
                    "--deterministic",
                ]
            )
            == 0
        )
        resumed_output = capsys.readouterr().out
        # The example manifest holds one asset in external storage that is not
        # present locally. It is SKIPPED, never attempted, so a resume re-attempts
        # it - and the succeeded item is reused from disk rather than reprocessed.
        # A resume that reported "processed 0" here would mean skips were being
        # treated as final, which is the bug SETTLED_STATES exists to avoid.
        assert "reused from disk : 1" in resumed_output
        assert "processed now    : 1" in resumed_output
        assert "1 succeeded" in resumed_output

    def test_status_reports_an_interrupted_run(
        self,
        tmp_path: Path,
        repo_root: Path,
        example_manifest_path: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        from ipw.benchmark_runner.cli import main

        out = tmp_path / "batch"
        main(
            [
                "batch",
                "--manifest",
                str(example_manifest_path),
                "--out",
                str(out),
                "--asset-root",
                str(repo_root),
                "--deterministic",
            ]
        )
        journal = out / JOURNAL_NAME
        text = journal.read_text(encoding="utf-8")
        journal.write_text(text[: len(text) - 60], encoding="utf-8", newline="\n")
        capsys.readouterr()

        assert main(["batch-status", "--journal", str(journal)]) == 0
        output = capsys.readouterr().out
        assert "NO - interrupted" in output
        assert "truncated records" in output
        assert "Resume with" in output
