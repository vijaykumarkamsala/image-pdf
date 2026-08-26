"""Choosing a tile size, and recording why.

POC-012. Until now every adapter carried a tile size as a constructor default -
256 for Real-ESRGAN, 252 for SwinIR's window-7 variants - and a default is not a
decision. The acceptance criterion is "tile-size/overlap selection is recorded",
which means the size has to be *chosen* from the image and a memory budget, and
the choice has to survive into the result.

**What the budget is actually about.** A tile is not free: the model holds the
input tile, the output tile at ``scale**2`` the area, and its own activations. The
peak is driven by the *output* tile, which is why a x4 model can process a
quarter of the tile a x1 model can at the same budget. Choosing a tile without
reference to scale is how a benchmark discovers its memory ceiling by hitting it.

**Why the plan is per result, not per processor.** ``ProcessorIdentity.tile_size``
records the configured *budget* and feeds the run digest, which is right: it is a
property of how the processor was set up. The tile actually used depends on the
image, so it belongs to the result. Putting a per-image value in the identity
would give two images processed by the same processor two different processor
identities, and the run digest would stop meaning what it says.

**Overlap is not a free parameter.** POC-006 measured what tiling costs: at tile
32 with overlap 8, 54% of subpixels differed from whole-image inference, and
halving the overlap roughly tripled the mean deviation. Overlap is therefore
scaled with the tile rather than fixed, and never allowed below a floor - a large
tile with a token overlap is the configuration that produces visible seams.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

__all__ = [
    "DEFAULT_TILE_BUDGET_BYTES",
    "MIN_OVERLAP",
    "MIN_TILE",
    "OVERLAP_FRACTION",
    "TilePlan",
    "TileReason",
    "plan_tiles",
]

MIN_TILE = 64
"""The floor the *budget search* will not go below.

An explicit ``max_tile`` overrides it: that is an instruction, not a preference,
and silently returning something larger would answer a different question.

Below this a tile carries almost no context and the seams show.

POC-006's measurements are the evidence: shrinking the tile from 32 to 16 tripled
the mean deviation from whole-image inference. 64 is a floor, not a target.
"""

MIN_OVERLAP = 8
OVERLAP_FRACTION = 8
"""Overlap is tile/8, floored at MIN_OVERLAP.

Proportional rather than fixed because context is what overlap buys, and a large
tile with a token margin is exactly the configuration that seams.
"""

DEFAULT_TILE_BUDGET_BYTES = 256 * 1024 * 1024
"""Working-set budget for one tile's worth of processing.

Conservative on purpose. The figure that matters is not how much memory the
machine has but how much a single job may take while other jobs run - which is a
capacity decision, not a hardware fact, so it is a parameter rather than a probe.
"""


class TileReason(StrEnum):
    """Why the planner chose what it chose. Recorded, not inferred later."""

    WHOLE_IMAGE = "whole_image"
    """The image fits the budget; tiling would add seams for nothing."""

    BUDGET = "budget"
    """Tiled to stay inside the memory budget."""

    MAX_TILE = "max_tile"
    """Tiled because the processor caps its tile size, not because of memory."""

    FLOOR = "floor"
    """The budget alone would demand a tile below the seam floor, so the floor won.

    Recorded rather than silently applied: it means the job is running above its
    configured budget, and someone should know that before reading its memory
    figures.
    """


@dataclass(frozen=True)
class TilePlan:
    """A tiling decision, with enough detail to reproduce and to audit it."""

    tile_size: int
    overlap: int
    columns: int
    rows: int
    reason: TileReason
    estimated_peak_bytes: int
    budget_bytes: int
    scale: int
    width: int
    height: int

    @property
    def tile_count(self) -> int:
        return self.columns * self.rows

    @property
    def is_tiled(self) -> bool:
        return self.tile_count > 1

    @property
    def exceeds_budget(self) -> bool:
        """True when the seam floor forced a plan over budget."""
        return self.estimated_peak_bytes > self.budget_bytes

    def as_record(self) -> dict[str, int | str | bool]:
        """A flat, JSON-safe form for the result document. No floats."""
        return {
            "tile_size": self.tile_size,
            "overlap": self.overlap,
            "columns": self.columns,
            "rows": self.rows,
            "tile_count": self.tile_count,
            "reason": self.reason.value,
            "estimated_peak_bytes": self.estimated_peak_bytes,
            "budget_bytes": self.budget_bytes,
            "exceeds_budget": self.exceeds_budget,
            "scale": self.scale,
        }


def _overlap_for(tile: int) -> int:
    return max(MIN_OVERLAP, tile // OVERLAP_FRACTION)


def _peak_bytes(tile: int, scale: int, bytes_per_pixel: int, activation_multiplier: int) -> int:
    """Estimated working set for one tile.

    Input tile plus output tile at ``scale**2`` the area, times a multiplier for
    the intermediate buffers a network holds while computing. Integer arithmetic
    throughout: this feeds a recorded decision, and a float would put a
    platform-dependent value into a document meant to be compared.
    """
    input_bytes = tile * tile * bytes_per_pixel
    output_bytes = tile * scale * tile * scale * bytes_per_pixel
    return (input_bytes + output_bytes) * activation_multiplier


def plan_tiles(
    width: int,
    height: int,
    *,
    scale: int = 1,
    budget_bytes: int = DEFAULT_TILE_BUDGET_BYTES,
    max_tile: int | None = None,
    multiple_of: int = 1,
    bytes_per_pixel: int = 4,
    activation_multiplier: int = 4,
) -> TilePlan:
    """Choose a tile size for one image, and say why.

    ``multiple_of`` accommodates architectures with a window constraint - SwinIR
    asserts ``tile % window_size == 0`` - so the planner rounds down to a legal
    size rather than handing the adapter something it will reject several seconds
    into a run.

    ``bytes_per_pixel`` defaults to 4 rather than 3: fp32 activations dominate the
    real footprint, and a planner that assumed 8-bit RGB would under-budget every
    AI path by a factor that grows with scale.
    """
    if width <= 0 or height <= 0:
        msg = f"cannot plan tiles for a {width}x{height} image"
        raise ValueError(msg)
    if scale < 1:
        msg = f"scale must be at least 1, got {scale}"
        raise ValueError(msg)

    longest = max(width, height)
    ceiling = min(max_tile, longest) if max_tile else longest

    # The seam floor applies to the budget search, not to an explicit instruction.
    # A caller who asks for a 32-pixel tile has said something deliberate - usually
    # to force the tiled path, sometimes because they know the material - and
    # quietly handing back 64 would answer a different question than the one asked.
    floor = min(MIN_TILE, max_tile) if max_tile else MIN_TILE
    if multiple_of > 1:
        floor = max(multiple_of, floor - floor % multiple_of)

    def legal(value: int) -> int:
        """Round down to the architecture's constraint, never below the floor."""
        if multiple_of > 1:
            value -= value % multiple_of
        return max(value, floor)

    whole = _peak_bytes(longest, scale, bytes_per_pixel, activation_multiplier)
    if whole <= budget_bytes and (max_tile is None or longest <= max_tile):
        # Tiling an image that fits would add seams to buy nothing.
        return TilePlan(
            tile_size=longest,
            overlap=0,
            columns=1,
            rows=1,
            reason=TileReason.WHOLE_IMAGE,
            estimated_peak_bytes=whole,
            budget_bytes=budget_bytes,
            scale=scale,
            width=width,
            height=height,
        )

    # Largest legal tile that fits the budget. Searched downward in steps rather
    # than solved algebraically: `multiple_of` makes the legal sizes a lattice, and
    # stepping it is clearer than rounding a closed-form answer and hoping.
    step = multiple_of if multiple_of > 1 else 16
    candidate = legal(ceiling)
    reason = TileReason.MAX_TILE if max_tile and ceiling <= longest else TileReason.BUDGET

    while candidate > floor:
        if _peak_bytes(candidate, scale, bytes_per_pixel, activation_multiplier) <= budget_bytes:
            break
        candidate = legal(candidate - step)
        reason = TileReason.BUDGET
    else:
        candidate = legal(floor)

    peak = _peak_bytes(candidate, scale, bytes_per_pixel, activation_multiplier)
    if peak > budget_bytes:
        # The floor beat the budget. Recorded, because it means this job runs
        # above the budget someone set and the memory figures should be read
        # knowing that.
        reason = TileReason.FLOOR

    overlap = _overlap_for(candidate)
    stride = max(candidate - overlap, 1)
    columns = max(1, -(-max(width - candidate, 0) // stride) + 1)
    rows = max(1, -(-max(height - candidate, 0) // stride) + 1)

    return TilePlan(
        tile_size=candidate,
        overlap=overlap,
        columns=columns,
        rows=rows,
        reason=reason,
        estimated_peak_bytes=peak,
        budget_bytes=budget_bytes,
        scale=scale,
        width=width,
        height=height,
    )
