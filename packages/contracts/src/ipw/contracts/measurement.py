"""Timing, memory and cost measurement records.

Every measurement listed in ``docs/TECHNICAL_POC_AND_MODEL_BENCHMARK_PLAN.md``
section 10.3 and in the AGENTS.md reproducibility rules has a field here, so a
later task never has to widen the schema mid-benchmark and invalidate earlier
comparisons.

These are **observation** records. They are recorded in run and result documents
but are excluded from every identity digest (see :mod:`ipw.benchmark_runner.ids`),
because a retry that takes longer must still be the same result.
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import Field

from ipw.contracts.common import (
    ContractModel,
    CurrencyCode,
    DecimalStr,
    NonNegInt,
    PositiveInt,
    SafeInt,
)


class ThermalState(StrEnum):
    COLD = "cold"
    WARM = "warm"
    UNKNOWN = "unknown"


class Timing(ContractModel):
    """Wall-clock phase durations in integer nanoseconds."""

    queue_wait_ns: NonNegInt = 0
    cold_start_ns: NonNegInt = 0
    preprocess_ns: NonNegInt = 0
    inference_ns: NonNegInt = 0
    postprocess_ns: NonNegInt = 0
    total_ns: NonNegInt = 0
    cold_or_warm: ThermalState = ThermalState.UNKNOWN


class MemoryUsage(ContractModel):
    """Memory observed during a single processing call.

    Two figures, because on a shared process neither is trustworthy alone.
    ``peak_rss_bytes`` is a **process-lifetime high-water mark**: it includes
    native allocations, which dominate image work, but it never decreases. Run an
    AI model and a resize in one process and both report the model's peak - which
    is true of the process and false of the resize.

    ``python_peak_delta_bytes`` is the mirror image: genuinely per-call, but blind
    to whatever a C library allocated. Read together they bracket the answer. A
    single trustworthy per-call number needs process isolation, which is what the
    containerised runtime exists to provide.
    """

    peak_rss_bytes: NonNegInt = 0
    peak_vram_bytes: NonNegInt | None = Field(
        default=None,
        description="Peak video memory. None means no accelerator was present to measure, "
        "which is a different claim from zero VRAM used.",
    )
    python_peak_delta_bytes: NonNegInt | None = Field(
        default=None,
        description="Python-attributable peak allocation for this call alone. Unlike "
        "peak_rss_bytes this is not contaminated by earlier work in the same process, "
        "but it excludes native allocations. None means it was not measured.",
    )
    measurement_method: str = Field(
        default="not_measured",
        description="How the peak was obtained, e.g. 'tracemalloc', 'resource.getrusage', 'nvml'.",
    )


class CostBreakdown(ContractModel):
    """Direct job cost components from the benchmark plan section 13.

    All amounts are exact decimal strings. Money is never a float.
    """

    currency: CurrencyCode = "USD"
    compute: DecimalStr = "0"
    model_load_allocation: DecimalStr = "0"
    temporary_storage: DecimalStr = "0"
    retained_storage_allocation: DecimalStr = "0"
    output_bandwidth: DecimalStr = "0"
    external_provider_fee: DecimalStr = "0"
    payment_overhead_allocation: DecimalStr = "0"
    total: DecimalStr = "0"
    basis: str = Field(
        default="not_estimated",
        description="How the figures were derived, e.g. 'not_estimated', 'list_price_2026_08'.",
    )


class Estimate(ContractModel):
    """Result of ``Processor.estimate`` - a prediction, not an observation."""

    estimated_duration_ns: NonNegInt
    estimated_peak_memory_bytes: NonNegInt
    estimated_output_bytes: NonNegInt | None = None
    estimated_cost: CostBreakdown | None = None
    confidence: str = Field(default="low", pattern=r"^(low|medium|high)$")
    notes: str | None = None


class TilingRecord(ContractModel):
    """The tiling decision made for one call, and why (POC-012).

    Recorded per *result*, not per processor. ``ProcessorIdentity.tile_size`` is
    the configured budget and feeds the run digest, which is correct - it
    describes how the processor was set up. The tile actually used depends on the
    image, so putting it in the identity would give two images processed by the
    same processor two different processor identities.

    Every field is an integer or a string. Tiling changes output (POC-006
    measured 54% of subpixels differing at tile 32/overlap 8), so this record is
    part of explaining a result, and a float would make it platform-dependent.
    """

    tile_size: PositiveInt
    overlap: NonNegInt
    columns: PositiveInt = 1
    rows: PositiveInt = 1
    tile_count: PositiveInt = 1
    reason: str = Field(
        default="whole_image",
        description="Why this size was chosen: whole_image, budget, max_tile or floor.",
    )
    estimated_peak_bytes: NonNegInt = 0
    budget_bytes: NonNegInt = 0
    exceeds_budget: bool = Field(
        default=False,
        description="True when the minimum safe tile still exceeds the budget. The job "
        "ran above its configured budget, and its memory figures should be read knowing "
        "that rather than discovering it later.",
    )
    scale: PositiveInt = 1

    @property
    def is_tiled(self) -> bool:
        return self.tile_count > 1


class Measurement(ContractModel):
    """Everything observed about one processing call."""

    timing: Timing = Timing()
    memory: MemoryUsage = MemoryUsage()
    cost: CostBreakdown = CostBreakdown()
    input_bytes: NonNegInt = 0
    output_bytes: NonNegInt = 0
    input_width: SafeInt | None = None
    input_height: SafeInt | None = None
    output_width: SafeInt | None = None
    output_height: SafeInt | None = None
    retry_count: NonNegInt = 0
    tiling: TilingRecord | None = Field(
        default=None,
        description="How the image was tiled, when it was. None means the question did "
        "not arise - a processor that does not tile, or a call that failed before it "
        "would have.",
    )
