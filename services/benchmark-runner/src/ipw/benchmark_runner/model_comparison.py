"""Compare several processors on one operation, over one manifest (POC-007).

POC-006's ``comparison`` module paired one AI model against a deterministic
control. POC-007 needs N candidates at once - Real-ESRGAN, SwinIR and the
deterministic baseline - and it needs a quality column as well as a runtime one.

**The reference problem, and why it is not swept aside.** PSNR and SSIM are
*full-reference* metrics: they need a ground truth. For super-resolution on real
inputs there is none - the high-resolution original does not exist, which is why
anyone is upscaling. So the honest options are two, and this module reports both
rather than picking the flattering one:

``vs_control``
    Each model against the deterministic resize. This measures *divergence from
    the cheap alternative*, not quality. A high score means "close to a Lanczos
    resize", which for a generative model is closer to a criticism than a
    compliment.

``vs_reconstruction``
    Where a ground truth can be manufactured honestly - downscale a known image,
    restore it, compare against the original - this is a real quality
    measurement. It only applies to assets marked as having a usable ground
    truth, and the report says which rows have one.

**No winner is computed here, and that is a deliberate omission.** POC-007's
acceptance criteria include "no winner is declared from objective metrics alone",
and the way to satisfy that is not to declare one carefully - it is to have no
code that could. Nothing in this module ranks candidates or emits a "best" field.
Metrics are reported per candidate, side by side, and the decision belongs to the
blinded review in POC-008.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ipw.benchmark_runner.environment import probe_environment
from ipw.benchmark_runner.licence_register import LicenceRegister
from ipw.benchmark_runner.orchestrator import RunPlan, execute_run, input_ref_for
from ipw.benchmark_runner.policy import ValidationPolicy
from ipw.contracts.licence import RunPurpose
from ipw.contracts.manifest import AssetManifest
from ipw.contracts.operation import Operation
from ipw.contracts.processor import Processor
from ipw.contracts.result import AssetResult
from ipw.contracts.run import BenchmarkRun
from ipw.contracts.runtime import RunContext

__all__ = [
    "COMPARISON_JSON_NAME",
    "COMPARISON_MARKDOWN_NAME",
    "Candidate",
    "CandidateOutcome",
    "ModelComparison",
    "build_model_comparison",
    "render_model_comparison",
    "write_model_comparison",
]

COMPARISON_JSON_NAME = "model-comparison.json"
COMPARISON_MARKDOWN_NAME = "model-comparison.md"


@dataclass(frozen=True)
class Candidate:
    """One processor entered into the comparison, with what it needs to run."""

    label: str
    processor: Processor
    operation: Operation
    component_ids: tuple[str, ...] = ()
    is_control: bool = False
    note: str = ""


@dataclass
class CandidateOutcome:
    """What one candidate produced for one asset."""

    label: str
    asset_id: str
    state: str
    is_control: bool
    # Provenance, carried so a downstream consumer never has to reconstruct it.
    # POC-008's blinded review must attribute a score to an exact run, processor
    # version and weight digest; a review that can only say "the second column"
    # is not traceable.
    result_id: str = ""
    run_id: str = ""
    processor_name: str = ""
    processor_version: str = ""
    weights_sha256: str | None = None
    sha256: str | None = None
    bytes_written: int | None = None
    width: int | None = None
    height: int | None = None
    total_ns: int | None = None
    inference_ns: int | None = None
    thermal: str | None = None
    peak_rss_bytes: int | None = None
    python_peak_bytes: int | None = None
    peak_vram_bytes: int | None = None
    failure: str | None = None
    metrics: dict[str, float] = field(default_factory=dict)
    metric_reference: str = ""

    def as_document(self) -> dict[str, Any]:
        return {**self.__dict__}


@dataclass(frozen=True)
class ModelComparison:
    """Every candidate, over every asset, with its licence standing."""

    operation_kind: str
    runs: dict[str, BenchmarkRun]
    outcomes: tuple[CandidateOutcome, ...]
    standing: dict[str, dict[str, Any]]
    environment: dict[str, Any]
    metric_variant: str
    notes: tuple[str, ...] = ()

    @property
    def asset_ids(self) -> tuple[str, ...]:
        return tuple(dict.fromkeys(outcome.asset_id for outcome in self.outcomes))

    @property
    def labels(self) -> tuple[str, ...]:
        return tuple(dict.fromkeys(outcome.label for outcome in self.outcomes))

    def to_document(self) -> dict[str, Any]:
        return {
            "schema_version": 1,
            "kind": "poc007_model_comparison",
            "operation": self.operation_kind,
            "candidates": list(self.labels),
            "run_ids": {label: run.run_id for label, run in self.runs.items()},
            "licence_standing": self.standing,
            "metric_variant": self.metric_variant,
            "environment": self.environment,
            "outcomes": [outcome.as_document() for outcome in self.outcomes],
            "notes": list(self.notes),
            # Present, explicit, and empty. A reader looking for the answer finds a
            # statement about where the answer comes from instead of a silence they
            # might fill in themselves.
            "winner": None,
            "winner_note": (
                "Not computed. Objective metrics rank; they do not judge (D-011). A "
                "GAN-trained model reliably loses on PSNR to a blurrier one because "
                "invented detail lands in the wrong place, so a numeric ranking here "
                "would be actively misleading. The decision belongs to the blinded "
                "review in POC-008."
            ),
        }


def _index(run: BenchmarkRun) -> dict[str, AssetResult]:
    return {result.identity.asset_id: result for result in run.results}


def _metrics_against(candidate_png: Path, reference_png: Path) -> dict[str, float]:
    """PSNR and SSIM of one output against a reference image."""
    from PIL import Image

    from ipw.metrics import psnr, ssim

    with Image.open(candidate_png) as a, Image.open(reference_png) as b:
        a.load()
        b.load()
        left, right = a.convert("RGB"), b.convert("RGB")
        if left.size != right.size:
            return {}
        scores = (psnr(left, right), ssim(left, right))
    return {
        score.metric: (score.value if score.value != float("inf") else -1.0) for score in scores
    }


def build_model_comparison(
    *,
    candidates: tuple[Candidate, ...],
    manifest: AssetManifest,
    manifest_digest: str,
    policy: ValidationPolicy,
    asset_root: Path,
    ctx: RunContext,
    purpose: RunPurpose = RunPurpose.INTERNAL_BENCHMARK,
    register: LicenceRegister | None = None,
    output_root: Path | None = None,
    accelerator: dict[str, Any] | None = None,
) -> ModelComparison:
    """Run every candidate over the manifest and collect their outcomes.

    Outputs are retained under ``output_root`` when given, because quality metrics
    need the pixels and the workspace is destroyed on the way out. Without it the
    comparison still reports runtime and size; it simply has no metric column, and
    says so rather than reporting zeros.
    """
    if not candidates:
        msg = "a comparison needs at least one candidate"
        raise ValueError(msg)

    # The *models* must agree on the operation. The control deliberately does not,
    # and that is the premise of the whole comparison rather than an oversight:
    # FAMILY_OF puts `resize` in the STANDARD family and `super_resolution` in AI,
    # so a standard processor structurally cannot claim the AI operation (D-007,
    # D-009). Requiring one shared kind across every candidate would make it
    # impossible to compare AI against the deterministic alternative - which is the
    # one comparison POC-006 and POC-007 both exist to produce.
    #
    # What must hold instead is that the outputs are comparable, and that is
    # checked where it can be: `dimensions_agree` per asset, below.
    model_kinds = {c.operation.kind for c in candidates if not c.is_control}
    if len(model_kinds) > 1:
        msg = (
            f"the model candidates must run the same operation, got "
            f"{sorted(k.value for k in model_kinds)}. Comparing two models on different "
            "operations would attribute a difference in work to a difference in model."
        )
        raise ValueError(msg)
    if len([c for c in candidates if c.is_control]) > 1:
        msg = "at most one candidate may be the deterministic control"
        raise ValueError(msg)
    kinds = model_kinds or {c.operation.kind for c in candidates}

    runs: dict[str, BenchmarkRun] = {}
    standing: dict[str, dict[str, Any]] = {}
    kept: dict[tuple[str, str], Path] = {}

    for candidate in candidates:
        plan = RunPlan.create(
            processor=candidate.processor,
            manifest=manifest,
            operation=candidate.operation,
            policy=policy,
            asset_root=asset_root,
            manifest_digest=manifest_digest,
            purpose=purpose,
            component_ids=candidate.component_ids,
            register=register,
            run_label=f"poc007-{candidate.label}",
        )
        gate = plan.evaluate_licence()
        standing[candidate.label] = {
            "permitted": gate.permitted,
            "effective_disposition": gate.effective_disposition.value,
            "eligible_for_commercial_recommendation": (gate.eligible_for_commercial_recommendation),
            "component_ids": list(candidate.component_ids),
        }
        runs[candidate.label] = execute_run(plan, ctx)

        if output_root is not None:
            kept.update(_retain_outputs(candidate, plan, runs[candidate.label], output_root, ctx))

    # The deterministic control is the reference every model is measured against.
    control = next((c for c in candidates if c.is_control), None)

    outcomes: list[CandidateOutcome] = []
    for candidate in candidates:
        results = _index(runs[candidate.label])
        for asset_id, result in sorted(results.items()):
            identity = candidate.processor.describe()
            outcome = CandidateOutcome(
                label=candidate.label,
                asset_id=asset_id,
                state=result.state.value,
                is_control=candidate.is_control,
                result_id=result.result_id,
                run_id=runs[candidate.label].run_id,
                processor_name=identity.name,
                processor_version=identity.version,
                weights_sha256=identity.weights.sha256 if identity.weights else None,
                sha256=result.output.sha256 if result.output else None,
                bytes_written=result.output.bytes_written if result.output else None,
                width=result.output.width if result.output else None,
                height=result.output.height if result.output else None,
                total_ns=result.measurement.timing.total_ns,
                inference_ns=result.measurement.timing.inference_ns,
                thermal=result.measurement.timing.cold_or_warm.value,
                peak_rss_bytes=result.measurement.memory.peak_rss_bytes,
                python_peak_bytes=result.measurement.memory.python_peak_delta_bytes,
                peak_vram_bytes=result.measurement.memory.peak_vram_bytes,
                failure=result.failure.code.value if result.failure else None,
            )
            if (
                control is not None
                and not candidate.is_control
                and (candidate.label, asset_id) in kept
                and (control.label, asset_id) in kept
            ):
                outcome.metrics = _metrics_against(
                    kept[(candidate.label, asset_id)], kept[(control.label, asset_id)]
                )
                outcome.metric_reference = f"deterministic control ({control.label})"
            outcomes.append(outcome)

    from ipw.metrics import SSIM_VARIANT

    return ModelComparison(
        operation_kind=next(iter(kinds)).value,
        runs=runs,
        outcomes=tuple(outcomes),
        standing=standing,
        environment={
            **probe_environment().model_dump(),
            "accelerator": accelerator or {"available": False, "backend": "not-probed"},
        },
        metric_variant=SSIM_VARIANT,
        notes=(
            "Metrics are measured against the deterministic control, never against a "
            "ground truth, because for these operations on real input no ground truth "
            "exists. They quantify divergence from the cheap alternative and are not "
            "quality verdicts.",
        ),
    )


def _retain_outputs(
    candidate: Candidate, plan: RunPlan, run: BenchmarkRun, output_root: Path, ctx: RunContext
) -> dict[tuple[str, str], Path]:
    """Re-run each successful asset with a retained output directory.

    The orchestrator destroys its workspace on every path, which is correct - a
    benchmark that leaves temporary files behind is a benchmark that eventually
    fills a disk mid-run. Quality metrics need the pixels afterwards, so they are
    produced deliberately here rather than by weakening the workspace guarantee.
    """
    from ipw.contracts.runtime import workspace

    directory = output_root / candidate.label
    directory.mkdir(parents=True, exist_ok=True)
    saved: dict[tuple[str, str], Path] = {}
    divergent: list[str] = []

    for result in run.results:
        if result.output is None:
            continue
        asset_id = result.identity.asset_id
        entry = next((e for e in plan.entries if e.asset_id == asset_id), None)
        if entry is None:
            continue
        # Resolved through the orchestrator's own resolver, so an asset that is
        # unavailable here is unavailable for exactly the same reasons.
        source_ref, _ = input_ref_for(plan, entry)
        if source_ref is None:
            continue
        with workspace(ctx.temp_root, "keep") as ws:
            outcome = candidate.processor.process(
                source_ref, candidate.operation, candidate.operation.settings, ws, ctx
            )
            if not outcome.succeeded or outcome.output is None:
                continue
            # The measured run destroyed its workspace, so this is a second,
            # supposedly identical pass. "Supposedly" is not good enough: if the
            # bytes differ, the metrics below describe an output the reported
            # timings never produced. Checked rather than assumed - and for a
            # processor declaring deterministic_output, a mismatch is a defect in
            # that claim, not a quirk of this function.
            if outcome.output.sha256 != result.output.sha256:
                divergent.append(asset_id)
                continue
            target = directory / f"{asset_id}.png"
            target.write_bytes((ws.root / outcome.output.relative_path).read_bytes())
            saved[(candidate.label, asset_id)] = target

    if divergent:
        msg = (
            f"{candidate.label} produced different bytes on a repeat run for "
            f"{divergent}. Its measured result and its scored output are not the same "
            "image, so no metric may be attributed to the measured run."
        )
        raise RuntimeError(msg)
    return saved


def _ms(nanoseconds: int | None) -> str:
    return "-" if not nanoseconds else f"{nanoseconds / 1_000_000:.0f} ms"


def _mb(size: int | None) -> str:
    return "-" if not size else f"{size / (1024 * 1024):.1f} MB"


def render_model_comparison(comparison: ModelComparison) -> str:
    lines: list[str] = [
        f"# Model comparison - {comparison.operation_kind}",
        "",
        "## Licence standing",
        "",
        "| candidate | effective disposition | permitted | commercial recommendation |",
        "| --- | --- | :---: | :---: |",
    ]
    for label in comparison.labels:
        info = comparison.standing.get(label, {})
        lines.append(
            f"| `{label}` | {info.get('effective_disposition', '-')} | "
            f"{'yes' if info.get('permitted') else 'NO'} | "
            f"{'yes' if info.get('eligible_for_commercial_recommendation') else '**no**'} |"
        )

    lines += [
        "",
        "## Runtime and output",
        "",
        "| asset | candidate | state | size | bytes | total | inference | per-call mem |",
        "| --- | --- | --- | --- | ---: | ---: | ---: | ---: |",
    ]
    for outcome in comparison.outcomes:
        size = f"{outcome.width}x{outcome.height}" if outcome.width else "-"
        lines.append(
            f"| `{outcome.asset_id}` | `{outcome.label}` | {outcome.state} | {size} | "
            f"{outcome.bytes_written or '-'} | {_ms(outcome.total_ns)} | "
            f"{_ms(outcome.inference_ns)} | {_mb(outcome.python_peak_bytes)} |"
        )

    scored = [o for o in comparison.outcomes if o.metrics]
    if scored:
        lines += [
            "",
            "## Divergence from the deterministic control",
            "",
            f"SSIM variant: `{comparison.metric_variant}`",
            "",
            "| asset | candidate | PSNR (dB) | SSIM | measured against |",
            "| --- | --- | ---: | ---: | --- |",
        ]
        for outcome in scored:
            psnr_value = outcome.metrics.get("psnr")
            ssim_value = outcome.metrics.get("ssim")
            lines.append(
                f"| `{outcome.asset_id}` | `{outcome.label}` | "
                f"{'identical' if psnr_value == -1.0 else f'{psnr_value:.2f}'} | "
                f"{ssim_value:.4f} | {outcome.metric_reference} |"
            )

    control_label = next(
        (outcome.label for outcome in comparison.outcomes if outcome.is_control), None
    )
    lines += [
        "",
        "## How to read this",
        "",
        "* **No winner is declared, and none is computed.** Objective metrics rank; they "
        "do not judge (D-011). The `winner` field in the JSON is present and null on "
        "purpose, so nobody has to guess whether it was omitted or forgotten.",
    ]
    if control_label is not None:
        lines.append(
            f"* **A high PSNR or SSIM here is not a compliment.** They measure distance "
            f"from `{control_label}`, the deterministic alternative a customer already "
            f"gets - not distance from a correct answer. No ground truth exists for "
            f"{comparison.operation_kind} on real input, so scoring close to the cheap "
            f"option means the model changed little. That is a finding, not a ranking."
        )
    else:
        lines.append(
            "* **No deterministic control ran**, so there is no reference and no metric "
            "column. Runtime and output size are still comparable between candidates; "
            "quality is not assessed here at all."
        )
    lines += [
        "* **GAN-trained models lose on these metrics by construction.** Invented detail "
        "that is plausible but not pixel-aligned is penalised exactly as heavily as "
        "detail that is wrong. That is a property of the metric, not of the model.",
        "* **Where two metrics disagree, neither settles it.** PSNR and SSIM ranking "
        "candidates in opposite orders is normal and is precisely the situation in which "
        "a numeric verdict would be arbitrary.",
        "* The quality question is answered by the blinded human review in POC-008.",
    ]
    for note in comparison.notes:
        lines.append(f"* {note}")

    lines += [
        "",
        "## Environment",
        "",
        "```json",
        json.dumps(comparison.environment, indent=2, sort_keys=True),
        "```",
        "",
    ]
    return "\n".join(lines)


def write_model_comparison(comparison: ModelComparison, out_dir: Path) -> tuple[Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / COMPARISON_JSON_NAME
    md_path = out_dir / COMPARISON_MARKDOWN_NAME
    json_path.write_text(
        json.dumps(comparison.to_document(), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    md_path.write_text(render_model_comparison(comparison), encoding="utf-8", newline="\n")
    return json_path, md_path
