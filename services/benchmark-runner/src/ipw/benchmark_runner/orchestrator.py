"""Minimal run orchestration.

POC-001 needs just enough orchestration to prove the contract holds:

* every asset is isolated - one failure never stops the batch;
* every processing call gets a fresh workspace that is destroyed on all paths;
* the original's digest is checked before and after every call;
* a retry reuses the same ``result_id`` and cannot duplicate a ledger entry.

Real corpus execution, tiling, concurrency and cost accounting arrive with
POC-004 and later, on top of this same shape.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path

from ipw.benchmark_runner.environment import probe_environment
from ipw.benchmark_runner.ids import result_id_of, run_id_of
from ipw.benchmark_runner.licence_register import (
    LicenceRegister,
    evaluate_assets,
    evaluate_components,
)
from ipw.benchmark_runner.policy import ValidationPolicy
from ipw.benchmark_runner.validation import resolve_asset_path
from ipw.contracts.asset import AssetManifestEntry
from ipw.contracts.failure import (
    FailureCategory,
    FailureCode,
    NextAction,
    NormalizedFailure,
    failure,
)
from ipw.contracts.licence import Disposition, GateDecision, RunPurpose
from ipw.contracts.manifest import AssetManifest
from ipw.contracts.operation import Operation
from ipw.contracts.processor import Processor
from ipw.contracts.result import AssetResult, LedgerEntry, ResultIdentity, ResultState
from ipw.contracts.run import BenchmarkRun, ProcessorIdentityDigest, RunIdentity, RunSummary
from ipw.contracts.runtime import InputRef, RunContext
from ipw.processors.base import guarded_inspect, guarded_process, guarded_supports

__all__ = ["Ledger", "RunPlan", "execute_run", "input_ref_for", "retry_failed"]


@dataclass
class Ledger:
    """Usage ledger keyed by ``result_id``.

    Stands in for production billing so that idempotency is provable before
    billing exists. Recording the same result twice is a no-op - that is the
    whole point (benchmark plan section 12: "No duplicate charging events").
    """

    _entries: dict[str, LedgerEntry] = field(default_factory=dict)

    def record(self, entry: LedgerEntry) -> bool:
        """Record a usage event. Returns ``True`` only if it was genuinely new."""
        if entry.result_id in self._entries:
            return False
        self._entries[entry.result_id] = entry
        return True

    def entries(self) -> tuple[LedgerEntry, ...]:
        return tuple(self._entries[key] for key in sorted(self._entries))

    def __len__(self) -> int:
        return len(self._entries)


@dataclass(frozen=True)
class RunPlan:
    """Everything that defines a run, before anything is executed."""

    processor: Processor
    manifest: AssetManifest
    operation: Operation
    policy: ValidationPolicy
    asset_root: Path
    manifest_digest: str
    selected_asset_ids: tuple[str, ...] = ()
    purpose: RunPurpose = RunPurpose.INTERNAL_BENCHMARK
    component_ids: tuple[str, ...] = ()
    register: LicenceRegister | None = None
    run_label: str = ""
    run_nonce: str = ""

    @classmethod
    def create(
        cls,
        *,
        processor: Processor,
        manifest: AssetManifest,
        operation: Operation,
        policy: ValidationPolicy,
        asset_root: Path,
        manifest_digest: str,
        selected_asset_ids: Sequence[str] | None = None,
        purpose: RunPurpose = RunPurpose.INTERNAL_BENCHMARK,
        component_ids: Sequence[str] | None = None,
        register: LicenceRegister | None = None,
        run_label: str = "",
        run_nonce: str = "",
    ) -> RunPlan:
        selected = tuple(selected_asset_ids) if selected_asset_ids else manifest.asset_ids
        return cls(
            processor=processor,
            manifest=manifest,
            operation=operation,
            policy=policy,
            asset_root=asset_root,
            manifest_digest=manifest_digest,
            # Sorted so that selection *order* can never change the run id.
            selected_asset_ids=tuple(sorted(selected)),
            purpose=purpose,
            component_ids=tuple(sorted(component_ids or ())),
            register=register,
            run_label=run_label,
            run_nonce=run_nonce,
        )

    @property
    def entries(self) -> tuple[AssetManifestEntry, ...]:
        chosen = set(self.selected_asset_ids)
        return tuple(e for e in self.manifest.assets if e.asset_id in chosen)

    def evaluate_licence(self) -> GateDecision:
        """Apply the licence and rights gates for this plan's purpose.

        With no register attached the plan is unguarded, which is only valid for
        the fake processor in tests; ``execute_run`` records that explicitly
        rather than implying approval.
        """
        if self.register is None:
            return GateDecision(
                purpose=self.purpose,
                permitted=True,
                effective_disposition=Disposition.APPROVED,
                markings=("no-licence-register-attached",),
            )

        components = evaluate_components(self.register, self.component_ids, self.purpose)
        assets = evaluate_assets(self.manifest, self.purpose)
        return GateDecision(
            purpose=self.purpose,
            permitted=components.permitted and assets.permitted,
            effective_disposition=components.effective_disposition,
            reference_only=components.reference_only,
            markings=components.markings,
            failures=components.failures + assets.failures,
            warnings=components.warnings + assets.warnings,
        )

    @property
    def identity(self) -> RunIdentity:
        gate = self.evaluate_licence()
        return RunIdentity(
            manifest_id=self.manifest.manifest_id,
            manifest_digest=self.manifest_digest,
            asset_ids=self.selected_asset_ids,
            processor=ProcessorIdentityDigest.of(self.processor.describe()),
            operation=self.operation,
            policy_digest=self.policy.digest(),
            purpose=self.purpose,
            component_ids=self.component_ids,
            licence_disposition=gate.effective_disposition,
            reference_only=gate.reference_only,
            run_label=self.run_label,
            run_nonce=self.run_nonce,
        )

    @property
    def run_id(self) -> str:
        return run_id_of(self.identity.model_dump(mode="json"))

    def result_identity(self, entry: AssetManifestEntry) -> ResultIdentity:
        return ResultIdentity(
            run_id=self.run_id,
            asset_id=entry.asset_id,
            input_sha256=entry.sha256,
            operation_kind=self.operation.kind,
            variant=self.operation.variant,
            effective_settings=self.operation.settings,
        )

    def result_id(self, entry: AssetManifestEntry) -> str:
        return result_id_of(self.result_identity(entry).model_dump(mode="json"))


def _skipped(
    identity: ResultIdentity, result_id: str, reason: NormalizedFailure, attempt: int
) -> AssetResult:
    return AssetResult(
        result_id=result_id,
        identity=identity,
        state=ResultState.SKIPPED,
        attempt=attempt,
        failure=reason,
    )


def input_ref_for(
    plan: RunPlan, entry: AssetManifestEntry
) -> tuple[InputRef | None, NormalizedFailure | None]:
    if entry.relative_path is None:
        return None, failure(
            FailureCode.MANIFEST_ASSET_FILE_MISSING,
            FailureCategory.UNSUPPORTED_FEATURE,
            "asset is held in protected external storage and is not available locally",
            next_action=NextAction.WAIT,
            remediation="Fetch external corpus assets before running, or select local assets.",
            asset_id=entry.asset_id,
        )

    path, path_failure = resolve_asset_path(entry.relative_path, plan.asset_root, "/relative_path")
    if path_failure is not None:
        return None, path_failure
    assert path is not None

    if not path.is_file():
        return None, failure(
            FailureCode.MANIFEST_ASSET_FILE_MISSING,
            FailureCategory.INVALID_INPUT,
            "declared asset file does not exist",
            next_action=NextAction.CHANGE_SETTINGS,
            asset_id=entry.asset_id,
        )

    return (
        InputRef(
            asset_id=entry.asset_id,
            expected_sha256=entry.sha256,
            path=path,
            declared_bytes=entry.declared_bytes,
        ),
        None,
    )


def process_one(
    plan: RunPlan,
    entry: AssetManifestEntry,
    ctx: RunContext,
    ledger: Ledger,
    attempt: int = 1,
) -> AssetResult:
    """Process a single asset. Never raises: every path returns an ``AssetResult``."""
    identity = plan.result_identity(entry)
    result_id = result_id_of(identity.model_dump(mode="json"))
    started_at = ctx.clock.now().isoformat()

    supported, support_failure = guarded_supports(
        plan.processor, plan.operation, plan.operation.settings
    )
    if not supported and support_failure is not None:
        return _skipped(identity, result_id, support_failure, attempt)

    ref, ref_failure = input_ref_for(plan, entry)
    if ref_failure is not None or ref is None:
        assert ref_failure is not None
        return _skipped(identity, result_id, ref_failure, attempt)

    inspection = guarded_inspect(plan.processor, ref, ctx)
    if not inspection.accepted:
        return AssetResult(
            result_id=result_id,
            identity=identity,
            state=ResultState.FAILED,
            attempt=attempt,
            failure=inspection.failure,
            started_at=started_at,
            finished_at=ctx.clock.now().isoformat(),
        )

    with ctx.workspace(f"res-{entry.asset_id}") as ws:
        outcome = guarded_process(
            plan.processor, ref, plan.operation, plan.operation.settings, ws, ctx
        )

    if outcome.succeeded:
        state = ResultState.SUCCEEDED
    elif outcome.failure is not None and outcome.failure.category is FailureCategory.CANCELLED:
        state = ResultState.CANCELLED
    else:
        state = ResultState.FAILED

    if state is ResultState.SUCCEEDED:
        ledger.record(
            LedgerEntry(
                result_id=result_id,
                run_id=identity.run_id,
                asset_id=entry.asset_id,
                operation_kind=plan.operation.kind,
                units=1,
                recorded_at=ctx.clock.now().isoformat(),
            )
        )

    measurement = outcome.measurement.model_copy(update={"retry_count": attempt - 1})
    return AssetResult(
        result_id=result_id,
        identity=identity,
        state=state,
        attempt=attempt,
        output=outcome.output,
        measurement=measurement,
        failure=outcome.failure,
        nondeterministic=outcome.nondeterministic,
        started_at=started_at,
        finished_at=ctx.clock.now().isoformat(),
    )


def execute_run(plan: RunPlan, ctx: RunContext, ledger: Ledger | None = None) -> BenchmarkRun:
    """Execute every selected asset with per-item failure isolation.

    The licence and rights gates run **before** any asset is processed. A blocked
    gate produces a complete run document in which every asset is ``SKIPPED`` with
    the gate's failure attached — not an exception, and not a partial run. That
    keeps a blocked run reviewable: the report shows exactly what was refused and
    why, which is what POC-002 exists to guarantee.
    """
    active_ledger = ledger if ledger is not None else Ledger()
    started_at = ctx.clock.now().isoformat()
    gate = plan.evaluate_licence()

    if not gate.permitted:
        results = tuple(
            _skipped(
                plan.result_identity(entry),
                plan.result_id(entry),
                gate.failures[0],
                attempt=1,
            )
            for entry in plan.entries
        )
        return BenchmarkRun(
            run_id=plan.run_id,
            identity=plan.identity,
            processor=plan.processor.describe(),
            summary=RunSummary.of(results),
            results=results,
            ledger=active_ledger.entries(),
            started_at=started_at,
            finished_at=ctx.clock.now().isoformat(),
            environment=None if ctx.deterministic else probe_environment(),
            licence=gate,
            notes="refused before processing: licence or rights gate not satisfied",
        )

    results = tuple(process_one(plan, entry, ctx, active_ledger) for entry in plan.entries)

    return BenchmarkRun(
        run_id=plan.run_id,
        identity=plan.identity,
        processor=plan.processor.describe(),
        summary=RunSummary.of(results),
        results=results,
        ledger=active_ledger.entries(),
        started_at=started_at,
        finished_at=ctx.clock.now().isoformat(),
        # AGENTS.md requires a hardware description per benchmark result; it is
        # omitted only in deterministic mode, where it would break reproducibility.
        environment=None if ctx.deterministic else probe_environment(),
        licence=gate,
    )


def retry_failed(plan: RunPlan, run: BenchmarkRun, ctx: RunContext, ledger: Ledger) -> BenchmarkRun:
    """Retry only the failed items of ``run``.

    The retried results keep their original ``result_id`` - it is derived from
    declared inputs, and ``attempt`` is deliberately not one of them. Successful
    items are never reprocessed, and the ledger cannot gain a duplicate entry.
    """
    by_asset = {entry.asset_id: entry for entry in plan.entries}
    updated: list[AssetResult] = []

    for previous in run.results:
        if previous.state is not ResultState.FAILED:
            updated.append(previous)
            continue
        entry = by_asset.get(previous.asset_id)
        if entry is None:  # pragma: no cover - defensive
            updated.append(previous)
            continue
        updated.append(process_one(plan, entry, ctx, ledger, attempt=previous.attempt + 1))

    results = tuple(updated)
    return run.model_copy(
        update={
            "results": results,
            "summary": RunSummary.of(results),
            "ledger": ledger.entries(),
            "finished_at": ctx.clock.now().isoformat(),
        }
    )
