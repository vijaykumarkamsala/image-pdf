"""Durable batch execution: work that survives the client that started it.

POC-013. Everything before this task held a whole run in memory and returned it at
the end, which is fine for a fixture set and wrong for a batch: kill the process
at item 47 of 50 and every completed result is gone. The acceptance criterion
"closing the client does not stop cloud work" is really a statement about where
run state lives, and the answer cannot be "in the caller's variable".

**The journal is the run.** Each item's result is appended to a JSON Lines file
the moment it completes, flushed and fsynced before the next item starts. A crash
leaves a file that is still readable and still true as far as it goes; a resume
reads it, keeps what already reached a conclusion, and processes the remainder.

**Crash-safety is about the half-written line.** A process killed mid-write leaves
a truncated final record. The reader discards it rather than refusing to load -
losing one item's result is recoverable by reprocessing it, while refusing to
parse the file would lose all forty-nine of the others. This is tested by
truncating a real journal at every plausible offset.

**Resume is not retry.** ``retry_failed`` reprocesses items that ran and failed.
Resume reprocesses items that never ran at all, and must not touch either the
successes or the ledger entries already recorded for them - which is what makes
running it twice harmless.

**fsync, not just flush.** Flushing hands bytes to the operating system; fsync
asks the operating system to commit them. The difference only shows up when the
machine loses power rather than the process losing its terminal, which is
precisely the case a durability claim is about. It costs a few milliseconds per
item and the alternative is a claim that has never been true.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

from ipw.benchmark_runner.environment import probe_environment
from ipw.benchmark_runner.orchestrator import Ledger, RunPlan, process_one
from ipw.contracts.licence import GateDecision
from ipw.contracts.result import AssetResult, LedgerEntry, ResultState
from ipw.contracts.run import BenchmarkRun, RunSummary
from ipw.contracts.runtime import RunContext

__all__ = [
    "JOURNAL_NAME",
    "SETTLED_STATES",
    "BatchJournal",
    "BatchOutcome",
    "execute_batch",
    "read_journal",
    "resume_batch",
]

JOURNAL_NAME = "run-journal.jsonl"

SETTLED_STATES = frozenset({ResultState.SUCCEEDED, ResultState.FAILED})
"""States a resume keeps rather than reprocessing.

The distinction is *was it attempted*, not *did it work*.

``SUCCEEDED`` and ``FAILED`` both mean the processor ran and reached a conclusion.
Resume keeps them. A failed item is ``retry_failed``'s business, and conflating
the two would make a resume silently retry things the caller never asked it to.

``SKIPPED`` and ``CANCELLED`` mean the item never ran. Resume re-attempts them,
because the reason they were passed over may no longer hold: a missing asset may
since have been fetched from external storage, a cancelled batch may be being
continued deliberately. Treating a skip as final would strand an asset forever on
a condition that had already been fixed - which is exactly the failure mode a
batch of fifty produces and a batch of one never does.
"""


@dataclass
class BatchJournal:
    """What a journal file reconstructs to, including what it lost."""

    run_id: str = ""
    started_at: str = ""
    results: dict[str, AssetResult] = field(default_factory=dict)
    ledger_entries: list[LedgerEntry] = field(default_factory=list)
    finished_at: str = ""
    truncated_records: int = 0
    """Records discarded as unparseable - normally 0, or 1 after a crash.

    Reported rather than swallowed. A resume that silently reprocessed an item
    because its record was corrupt would be correct; a resume that did so without
    saying anything would hide the fact that the process died.
    """

    @property
    def complete(self) -> bool:
        return bool(self.finished_at)

    def settled_asset_ids(self) -> set[str]:
        """Assets whose recorded outcome a resume will keep."""
        return {
            asset_id for asset_id, result in self.results.items() if result.state in SETTLED_STATES
        }


@dataclass(frozen=True)
class BatchOutcome:
    """The finished run, plus what resuming had to do."""

    run: BenchmarkRun
    journal_path: Path
    processed: int
    reused_from_journal: int

    @property
    def was_resumed(self) -> bool:
        return self.reused_from_journal > 0


def _append(path: Path, record: dict[str, object]) -> None:
    """Append one record and commit it to storage before returning.

    Opened per record rather than held open for the batch. A long-lived handle is
    faster and loses everything buffered in it when the process dies, which is the
    one moment this file exists for.
    """
    line = json.dumps(record, sort_keys=True, ensure_ascii=False) + "\n"
    with path.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(line)
        handle.flush()
        os.fsync(handle.fileno())


def read_journal(path: Path) -> BatchJournal:
    """Reconstruct batch state, discarding any record a crash left incomplete."""
    journal = BatchJournal()
    if not path.is_file():
        return journal

    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            # A process killed mid-write leaves a partial final line. Losing that
            # item is recoverable by reprocessing it; refusing to parse the file
            # would lose every item before it too.
            journal.truncated_records += 1
            continue

        kind = record.get("kind")
        if kind == "run_started":
            journal.run_id = str(record.get("run_id", ""))
            journal.started_at = str(record.get("started_at", ""))
        elif kind == "item":
            try:
                result = AssetResult.model_validate(record["result"])
            except (KeyError, ValueError):
                journal.truncated_records += 1
                continue
            journal.results[result.identity.asset_id] = result
            entry = record.get("ledger_entry")
            if entry:
                try:
                    journal.ledger_entries.append(LedgerEntry.model_validate(entry))
                except ValueError:  # pragma: no cover - defensive
                    journal.truncated_records += 1
        elif kind == "run_finished":
            journal.finished_at = str(record.get("finished_at", ""))

    return journal


def _run_batch(
    plan: RunPlan,
    ctx: RunContext,
    journal_path: Path,
    ledger: Ledger | None,
    *,
    resuming: bool,
) -> BatchOutcome:
    active_ledger = ledger if ledger is not None else Ledger()
    journal_path.parent.mkdir(parents=True, exist_ok=True)

    existing = read_journal(journal_path) if resuming else BatchJournal()
    already_done = existing.settled_asset_ids() if resuming else set()

    # A resumed run keeps its original start time. Overwriting it would make the
    # elapsed figure describe the resume rather than the work.
    started_at = existing.started_at or ctx.clock.now().isoformat()
    if not resuming or not existing.run_id:
        _append(
            journal_path,
            {"kind": "run_started", "run_id": plan.run_id, "started_at": started_at},
        )

    # Ledger entries already recorded must be replayed, or a resumed run could
    # bill the same result twice.
    for entry in existing.ledger_entries:
        active_ledger.record(entry)

    gate = plan.evaluate_licence()
    if not gate.permitted:
        # Nothing is processed and nothing is journalled as done: a refused batch
        # is refused every time it is resumed, not gradually admitted.
        run = _refused_run(plan, ctx, active_ledger, gate, started_at)
        _append(journal_path, {"kind": "run_finished", "finished_at": run.finished_at})
        return BatchOutcome(run, journal_path, processed=0, reused_from_journal=0)

    results: list[AssetResult] = []
    processed = 0

    for asset in plan.entries:
        if asset.asset_id in already_done:
            results.append(existing.results[asset.asset_id])
            continue

        result = process_one(plan, asset, ctx, active_ledger)
        processed += 1
        results.append(result)

        recorded = next(
            (item for item in active_ledger.entries() if item.result_id == result.result_id),
            None,
        )
        _append(
            journal_path,
            {
                "kind": "item",
                "asset_id": asset.asset_id,
                "result": result.model_dump(mode="json"),
                "ledger_entry": recorded.model_dump(mode="json") if recorded else None,
            },
        )

    finished_at = ctx.clock.now().isoformat()
    _append(journal_path, {"kind": "run_finished", "finished_at": finished_at})

    ordered = tuple(results)
    run = BenchmarkRun(
        run_id=plan.run_id,
        identity=plan.identity,
        processor=plan.processor.describe(),
        summary=RunSummary.of(ordered),
        results=ordered,
        ledger=active_ledger.entries(),
        started_at=started_at,
        finished_at=finished_at,
        environment=None if ctx.deterministic else probe_environment(),
        licence=gate,
        notes=(
            f"resumed: {len(already_done)} item(s) reused from the journal" if already_done else ""
        ),
    )
    return BatchOutcome(
        run=run,
        journal_path=journal_path,
        processed=processed,
        reused_from_journal=len(already_done),
    )


def _refused_run(
    plan: RunPlan,
    ctx: RunContext,
    ledger: Ledger,
    gate: GateDecision,
    started_at: str,
) -> BenchmarkRun:
    from ipw.benchmark_runner.orchestrator import _skipped

    # A refused gate always carries at least one failure; a gate that refused
    # without saying why would be a defect in the gate, not something to paper
    # over here with a fallback message.
    if not gate.failures:
        msg = "the licence gate refused the batch but recorded no failure"
        raise ValueError(msg)
    reason = gate.failures[0]
    results = tuple(
        _skipped(plan.result_identity(asset), plan.result_id(asset), reason, attempt=1)
        for asset in plan.entries
    )
    return BenchmarkRun(
        run_id=plan.run_id,
        identity=plan.identity,
        processor=plan.processor.describe(),
        summary=RunSummary.of(results),
        results=results,
        ledger=ledger.entries(),
        started_at=started_at,
        finished_at=ctx.clock.now().isoformat(),
        environment=None if ctx.deterministic else probe_environment(),
        licence=gate,
        notes="refused before processing: licence or rights gate not satisfied",
    )


def execute_batch(
    plan: RunPlan,
    ctx: RunContext,
    journal_path: Path,
    ledger: Ledger | None = None,
) -> BatchOutcome:
    """Run every item, journalling each result as it completes."""
    return _run_batch(plan, ctx, journal_path, ledger, resuming=False)


def resume_batch(
    plan: RunPlan,
    ctx: RunContext,
    journal_path: Path,
    ledger: Ledger | None = None,
) -> BatchOutcome:
    """Continue a batch from its journal, processing only what never ran.

    Safe to call on a journal that is already complete: every item is settled,
    nothing is reprocessed, and the ledger gains nothing. Safe to call on a
    journal from a process that died mid-item: the truncated record is discarded
    and that one item runs again. Items that were skipped are re-attempted - see
    ``SETTLED_STATES`` for why that is not the same as retrying a failure.
    """
    return _run_batch(plan, ctx, journal_path, ledger, resuming=True)
