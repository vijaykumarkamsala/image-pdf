"""Pair an AI result with a deterministic-resize control over the same assets.

POC-006 acceptance: *"Results compare against deterministic resize, not only the
original."* The reason that criterion exists is that "AI output next to the
original" always flatters the model. The original is small; anything larger looks
better. The only comparison that means anything is against the cheap,
deterministic thing a product would otherwise ship - a Lanczos resize to the same
dimensions - because that is the alternative the model has to beat.

So this module runs two complete benchmark runs over one manifest:

* the AI variant, at the model's **native** scale;
* the standard variant, resized by the **same rational factor**.

Both go through the same orchestrator, the same licence gates and the same
per-asset failure isolation. Nothing about the comparison is special-cased, which
is what makes the two columns comparable at all.

**What this deliberately does not do.** It records no quality score. Deciding
which output looks better from PSNR or SSIM alone is exactly what D-011 and
POC-008 forbid: objective metrics rank, they do not judge, and a blinded human
review is the mechanism the product has chosen. This module therefore reports
what can be measured without opinion - dimensions, bytes, timing, memory, digests
- and says plainly that the quality question is open.

**Marking is not decoration.** If the licence gate permits the run only for
research, every artifact produced here carries that marking. A comparison that
lost its provenance on the way to a slide deck is precisely the failure D-038
exists to prevent.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from ipw.benchmark_runner.environment import probe_environment
from ipw.benchmark_runner.licence_register import LicenceRegister
from ipw.benchmark_runner.orchestrator import RunPlan, execute_run
from ipw.benchmark_runner.policy import ValidationPolicy
from ipw.contracts.licence import RunPurpose
from ipw.contracts.manifest import AssetManifest
from ipw.contracts.operation import (
    Operation,
    ProcessingRoute,
    ProcessingVariant,
    ResizeSettings,
    SuperResolutionSettings,
)
from ipw.contracts.processor import Processor
from ipw.contracts.result import AssetResult, ResultState
from ipw.contracts.run import BenchmarkRun
from ipw.contracts.runtime import RunContext

__all__ = [
    "COMPARISON_JSON_NAME",
    "COMPARISON_MARKDOWN_NAME",
    "ComparisonRow",
    "VariantComparison",
    "build_comparison",
    "render_comparison_markdown",
    "write_comparison",
]

NativeScale = Literal[2, 4]
"""The scales the pinned checkpoints were trained for.

Mirrors the contract's SuperResolutionSettings.scale. Any other factor means
resampling after inference, which is a different operation entirely."""

COMPARISON_JSON_NAME = "ai-baseline-comparison.json"
COMPARISON_MARKDOWN_NAME = "ai-baseline-comparison.md"


@dataclass(frozen=True)
class ComparisonRow:
    """One asset, measured on both paths."""

    asset_id: str
    state: str
    ai_sha256: str | None
    ai_bytes: int | None
    ai_width: int | None
    ai_height: int | None
    ai_total_ns: int | None
    ai_inference_ns: int | None
    ai_thermal: str | None
    ai_peak_rss_bytes: int | None
    ai_python_peak_bytes: int | None
    ai_peak_vram_bytes: int | None
    ai_failure: str | None
    control_sha256: str | None
    control_bytes: int | None
    control_width: int | None
    control_height: int | None
    control_total_ns: int | None
    control_peak_rss_bytes: int | None
    control_python_peak_bytes: int | None
    control_failure: str | None

    @property
    def dimensions_agree(self) -> bool:
        """Both paths must land on the same size, or nothing below is comparable."""
        return self.ai_width is not None and (self.ai_width, self.ai_height) == (
            self.control_width,
            self.control_height,
        )

    @property
    def slowdown(self) -> float | None:
        """How many times slower the AI path is. The number that decides routing."""
        if not self.ai_total_ns or not self.control_total_ns:
            return None
        return self.ai_total_ns / self.control_total_ns


@dataclass(frozen=True)
class VariantComparison:
    """The full comparison: both runs, paired, with their gate decisions."""

    scale: NativeScale
    ai_run: BenchmarkRun
    control_run: BenchmarkRun
    rows: tuple[ComparisonRow, ...]
    eligible_for_commercial_recommendation: bool
    marking: str
    environment: dict[str, object]

    def to_document(self) -> dict[str, object]:
        return {
            "schema_version": 1,
            "kind": "poc006_ai_baseline_comparison",
            "scale": self.scale,
            "marking": self.marking,
            "eligible_for_commercial_recommendation": (self.eligible_for_commercial_recommendation),
            "ai_run_id": self.ai_run.run_id,
            "control_run_id": self.control_run.run_id,
            "ai_processor": self.ai_run.identity.processor.name,
            "control_processor": self.control_run.identity.processor.name,
            "environment": self.environment,
            "rows": [row.__dict__ for row in self.rows],
            "quality_verdict": (
                "not determined. Objective metrics rank, they do not judge (D-011); the "
                "quality question is settled by the blinded review in POC-008."
            ),
        }


def _index(run: BenchmarkRun) -> dict[str, AssetResult]:
    return {result.identity.asset_id: result for result in run.results}


def build_comparison(
    *,
    ai_processor: Processor,
    control_processor: Processor,
    manifest: AssetManifest,
    manifest_digest: str,
    policy: ValidationPolicy,
    asset_root: Path,
    ctx: RunContext,
    scale: NativeScale,
    purpose: RunPurpose = RunPurpose.INTERNAL_BENCHMARK,
    register: LicenceRegister | None = None,
    ai_component_ids: tuple[str, ...] = (),
    control_component_ids: tuple[str, ...] = (),
    accelerator: dict[str, object] | None = None,
) -> VariantComparison:
    """Run both variants over one manifest and pair the results by asset."""
    ai_operation = Operation.build(
        SuperResolutionSettings(scale=scale, mode="natural"),
        ProcessingVariant.AI_NATURAL,
        route=ProcessingRoute.CLOUD_CPU,
    )
    # The same rational factor, not a hardcoded pixel size: the control has to
    # land on the model's output dimensions for any asset, or the two columns are
    # measuring different work.
    control_operation = Operation.build(
        ResizeSettings(algorithm="lanczos", scale_numerator=scale, scale_denominator=1),
        ProcessingVariant.STANDARD_SERVER_AUTHORITATIVE,
        route=ProcessingRoute.CLOUD_CPU,
    )

    def plan_for(
        processor: Processor,
        operation: Operation,
        label: str,
        components: tuple[str, ...],
    ) -> RunPlan:
        return RunPlan.create(
            processor=processor,
            manifest=manifest,
            operation=operation,
            policy=policy,
            asset_root=asset_root,
            manifest_digest=manifest_digest,
            purpose=purpose,
            component_ids=components,
            register=register,
            run_label=label,
        )

    # Each run is gated on its own components. Gating the deterministic control on
    # the model's licence would mark a perfectly commercial baseline as restricted.
    ai_plan = plan_for(ai_processor, ai_operation, "poc006-ai-native", ai_component_ids)
    control_plan = plan_for(
        control_processor,
        control_operation,
        "poc006-deterministic-control",
        control_component_ids,
    )

    gate = ai_plan.evaluate_licence()
    ai_run = execute_run(ai_plan, ctx)
    control_run = execute_run(control_plan, ctx)

    ai_results, control_results = _index(ai_run), _index(control_run)
    rows: list[ComparisonRow] = []
    for asset_id in sorted(set(ai_results) | set(control_results)):
        ai = ai_results.get(asset_id)
        control = control_results.get(asset_id)
        rows.append(
            ComparisonRow(
                asset_id=asset_id,
                state=(ai.state.value if ai else ResultState.SKIPPED.value),
                ai_sha256=ai.output.sha256 if ai and ai.output else None,
                ai_bytes=ai.output.bytes_written if ai and ai.output else None,
                ai_width=ai.output.width if ai and ai.output else None,
                ai_height=ai.output.height if ai and ai.output else None,
                ai_total_ns=ai.measurement.timing.total_ns if ai and ai.measurement else None,
                ai_inference_ns=(
                    ai.measurement.timing.inference_ns if ai and ai.measurement else None
                ),
                ai_thermal=(
                    ai.measurement.timing.cold_or_warm.value if ai and ai.measurement else None
                ),
                ai_peak_rss_bytes=(
                    ai.measurement.memory.peak_rss_bytes if ai and ai.measurement else None
                ),
                ai_python_peak_bytes=(
                    ai.measurement.memory.python_peak_delta_bytes if ai else None
                ),
                ai_peak_vram_bytes=(ai.measurement.memory.peak_vram_bytes if ai else None),
                ai_failure=ai.failure.code.value if ai and ai.failure else None,
                control_sha256=control.output.sha256 if control and control.output else None,
                control_bytes=control.output.bytes_written if control and control.output else None,
                control_width=control.output.width if control and control.output else None,
                control_height=control.output.height if control and control.output else None,
                control_total_ns=(
                    control.measurement.timing.total_ns if control and control.measurement else None
                ),
                control_peak_rss_bytes=(
                    control.measurement.memory.peak_rss_bytes
                    if control and control.measurement
                    else None
                ),
                control_python_peak_bytes=(
                    control.measurement.memory.python_peak_delta_bytes if control else None
                ),
                control_failure=control.failure.code.value if control and control.failure else None,
            )
        )

    eligible = gate.eligible_for_commercial_recommendation
    marking = (
        "Eligible for commercial recommendation."
        if eligible
        else (
            "RESEARCH AND INTERNAL BENCHMARK ONLY. The licence gate did not clear this "
            "model for commercial use, so no result below may be presented as a product "
            "recommendation, in a public demo, or to a customer (D-038)."
        )
    )

    return VariantComparison(
        scale=scale,
        ai_run=ai_run,
        control_run=control_run,
        rows=tuple(rows),
        eligible_for_commercial_recommendation=eligible,
        marking=marking,
        # The accelerator description is injected rather than probed here: only the
        # AI adapter package may import the inference runtime, and the runner must
        # not acquire one just to describe a machine.
        environment={
            **probe_environment().model_dump(),
            "accelerator": accelerator or {"available": False, "backend": "not-probed"},
        },
    )


def _ms(nanoseconds: int | None) -> str:
    return "-" if nanoseconds is None else f"{nanoseconds / 1_000_000:.0f} ms"


def _mb(size: int | None) -> str:
    return "-" if size is None else f"{size / (1024 * 1024):.1f} MB"


def render_comparison_markdown(comparison: VariantComparison) -> str:
    lines: list[str] = [
        f"# AI baseline versus deterministic resize (x{comparison.scale})",
        "",
        f"> **{comparison.marking}**",
        "",
        f"* AI run: `{comparison.ai_run.run_id}` - {comparison.ai_run.identity.processor.name}",
        f"* Control run: `{comparison.control_run.run_id}` - "
        f"{comparison.control_run.identity.processor.name}",
        f"* Control operation: Lanczos resize by {comparison.scale}/1, the same rational "
        "factor as the model's native scale.",
        "",
        "## Per asset",
        "",
        "| asset | state | size | AI bytes | resize bytes | AI total | resize total | "
        "slower by | AI per-call mem | resize per-call mem |",
        "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]

    for row in comparison.rows:
        size = f"{row.ai_width}x{row.ai_height}" if row.ai_width else "-"
        if row.ai_width and not row.dimensions_agree:
            size += " (MISMATCH)"
        slower = f"{row.slowdown:.0f}x" if row.slowdown else "-"
        lines.append(
            f"| `{row.asset_id}` | {row.state} | {size} | "
            f"{row.ai_bytes or '-'} | {row.control_bytes or '-'} | "
            f"{_ms(row.ai_total_ns)} | {_ms(row.control_total_ns)} | {slower} | "
            f"{_mb(row.ai_python_peak_bytes)} | {_mb(row.control_python_peak_bytes)} |"
        )

    failures = [
        f"* `{row.asset_id}`: AI `{row.ai_failure or '-'}`, control `{row.control_failure or '-'}`"
        for row in comparison.rows
        if row.ai_failure or row.control_failure
    ]
    if failures:
        lines += ["", "## Failures", "", *failures]

    lines += [
        "",
        "## What this does and does not establish",
        "",
        "* **Established:** both paths produce the same dimensions, and the cost of the "
        "AI path relative to a deterministic resize is measured rather than assumed.",
        "* **Not established:** which output is better. No quality score appears here on "
        "purpose. Objective metrics rank; they do not judge (D-011). The quality "
        "question is answered by the blinded review in POC-008.",
        "* **Reproducibility:** fp32 CPU convolution is deterministic for a fixed torch "
        "build and thread count. Comparisons are valid within one environment; the "
        "environment block below is what makes that checkable.",
        "* **Why per-call memory and not peak RSS:** peak RSS is a process-lifetime "
        "high-water mark. Both runs execute in one process here, so once the model has "
        "allocated, the deterministic control reports the model's peak as if it were its "
        "own. The per-call column above is Python-attributable only - it undercounts "
        "native allocation - but it is not contaminated by the other run. Both raw "
        "figures are in the JSON. An uncontaminated total needs process isolation, which "
        "is what the container definition under infra/docker is for.",
        "",
        "## Environment",
        "",
        "```json",
        json.dumps(comparison.environment, indent=2, sort_keys=True),
        "```",
        "",
    ]
    return "\n".join(lines)


def write_comparison(comparison: VariantComparison, out_dir: Path) -> tuple[Path, Path]:
    """Write both artifacts and return their paths."""
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / COMPARISON_JSON_NAME
    md_path = out_dir / COMPARISON_MARKDOWN_NAME
    json_path.write_text(
        json.dumps(comparison.to_document(), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    md_path.write_text(render_comparison_markdown(comparison), encoding="utf-8", newline="\n")
    return json_path, md_path
