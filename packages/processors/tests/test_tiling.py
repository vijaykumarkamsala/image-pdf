"""The tile planner, tested directly rather than through a model.

``plan_tiles`` is pure arithmetic - no torch, no weights, no image - but until
now it was only ever executed as a side effect of running Real-ESRGAN or SwinIR
with real checkpoints installed. That left it at 42% on a machine without them,
and it meant the module's actual claims were never checked: that a x4 model gets
a smaller tile than a x1 one at the same budget, that the seam floor is a floor
for the *budget search* and not for an explicit instruction, and that a plan
whose tiles do not cover the image would be a silent correctness bug.

Testing it here rather than through an adapter is the point. A decision module
deserves tests that state the decision.
"""

from __future__ import annotations

import pytest

from ipw.processors.tiling import (
    DEFAULT_TILE_BUDGET_BYTES,
    MIN_OVERLAP,
    MIN_TILE,
    TileReason,
    plan_tiles,
)


def test_an_image_that_fits_is_not_tiled() -> None:
    """Tiling an image that fits would add seams to buy nothing."""
    plan = plan_tiles(512, 384, scale=1)

    assert plan.reason is TileReason.WHOLE_IMAGE
    assert plan.tile_count == 1
    assert not plan.is_tiled
    assert plan.overlap == 0
    assert not plan.exceeds_budget


def test_scale_shrinks_the_tile_because_the_output_drives_the_peak() -> None:
    """The module's central claim, stated as a test.

    Peak memory is dominated by the *output* tile at ``scale**2`` the area, so a
    x4 model can afford roughly a quarter of the linear tile a x1 model can at
    the same budget. A planner that ignored scale would over-allocate every
    upscaling job by a factor that grows with the scale.
    """
    budget = 64 * 1024 * 1024
    at_x1 = plan_tiles(8000, 8000, scale=1, budget_bytes=budget)
    at_x4 = plan_tiles(8000, 8000, scale=4, budget_bytes=budget)

    assert at_x4.tile_size < at_x1.tile_size
    assert at_x1.estimated_peak_bytes <= budget
    assert at_x4.estimated_peak_bytes <= budget


def test_a_budgeted_plan_stays_inside_its_budget() -> None:
    plan = plan_tiles(6000, 4000, scale=2, budget_bytes=32 * 1024 * 1024)

    assert plan.reason is TileReason.BUDGET
    assert plan.is_tiled
    assert plan.estimated_peak_bytes <= plan.budget_bytes
    assert not plan.exceeds_budget


def test_max_tile_is_recorded_as_its_own_reason() -> None:
    """A cap from the processor is not the same fact as a memory limit.

    Both produce tiles; only one of them changes if the budget changes. The
    record has to say which, or a later reader cannot tell whether raising the
    budget would help.
    """
    plan = plan_tiles(4000, 4000, scale=1, max_tile=256, budget_bytes=DEFAULT_TILE_BUDGET_BYTES)

    assert plan.reason is TileReason.MAX_TILE
    assert plan.tile_size <= 256


def test_the_seam_floor_wins_and_says_so() -> None:
    """A budget too small for a legible tile is reported, not silently obeyed.

    Going below the floor would trade a memory figure for visible seams. The
    planner takes the seams off the table and records that the job is running
    over budget, so nobody reads its memory numbers as if the budget held.
    """
    plan = plan_tiles(4000, 4000, scale=4, budget_bytes=1024)

    assert plan.reason is TileReason.FLOOR
    assert plan.tile_size == MIN_TILE
    assert plan.exceeds_budget
    assert plan.estimated_peak_bytes > plan.budget_bytes


def test_an_explicit_small_max_tile_is_an_instruction_not_a_preference() -> None:
    """``max_tile`` below the floor is honoured; the floor guards the search only.

    A caller asking for a 32-pixel tile has said something deliberate. Handing
    back 64 would answer a different question than the one asked.
    """
    plan = plan_tiles(2000, 2000, scale=1, max_tile=32)

    assert plan.tile_size == 32


def test_a_window_constraint_is_never_violated() -> None:
    """SwinIR asserts ``tile % window == 0`` several seconds into a run.

    Rounding here is what stops that assertion being the way the constraint is
    discovered.
    """
    for window in (7, 8, 16):
        plan = plan_tiles(5000, 5000, scale=4, multiple_of=window, budget_bytes=16 * 1024 * 1024)
        assert plan.tile_size % window == 0, f"tile {plan.tile_size} illegal for window {window}"


def test_overlap_is_proportional_with_a_floor() -> None:
    """A large tile with a token margin is the configuration that seams."""
    big = plan_tiles(9000, 9000, scale=1, budget_bytes=DEFAULT_TILE_BUDGET_BYTES)
    assert big.overlap == max(MIN_OVERLAP, big.tile_size // 8)

    small = plan_tiles(2000, 2000, scale=1, max_tile=MIN_TILE)
    assert small.overlap >= MIN_OVERLAP


@pytest.mark.parametrize(
    ("width", "height", "scale"),
    [(4000, 3000, 4), (5000, 1000, 2), (1000, 5000, 2), (777, 1279, 3), (4096, 4096, 1)],
)
def test_the_tiles_actually_cover_the_image(width: int, height: int, scale: int) -> None:
    """The property that makes a plan correct rather than merely plausible.

    ``columns`` and ``rows`` are computed from a stride; if that arithmetic is
    off by one the last tile stops short and the output has an unprocessed strip
    down one edge. That is the kind of bug which looks fine on a square test
    image and ships. Checked here on deliberately awkward aspect ratios.
    """
    plan = plan_tiles(width, height, scale=scale, budget_bytes=8 * 1024 * 1024)
    stride = max(plan.tile_size - plan.overlap, 1)

    reach_x = plan.tile_size + (plan.columns - 1) * stride
    reach_y = plan.tile_size + (plan.rows - 1) * stride

    assert reach_x >= width, f"columns stop {width - reach_x}px short"
    assert reach_y >= height, f"rows stop {height - reach_y}px short"

    # And no wasted tile: dropping one must leave the image uncovered.
    if plan.columns > 1:
        assert plan.tile_size + (plan.columns - 2) * stride < width
    if plan.rows > 1:
        assert plan.tile_size + (plan.rows - 2) * stride < height


def test_the_record_is_flat_json_safe_and_free_of_floats() -> None:
    """It goes into the result document, which is compared byte for byte."""
    plan = plan_tiles(3000, 2000, scale=4, budget_bytes=16 * 1024 * 1024)
    record = plan.as_record()

    assert record["reason"] == TileReason.BUDGET.value
    assert isinstance(record["reason"], str)
    assert record["tile_count"] == plan.columns * plan.rows
    for key, value in record.items():
        assert not isinstance(value, float), f"{key} is a float and will not compare"
        assert isinstance(value, (int, str, bool)), f"{key} is {type(value).__name__}"


@pytest.mark.parametrize(
    ("width", "height", "scale"),
    [(0, 100, 1), (100, 0, 1), (-1, 100, 1), (100, -1, 1), (100, 100, 0), (100, 100, -2)],
)
def test_impossible_requests_are_refused(width: int, height: int, scale: int) -> None:
    with pytest.raises(ValueError, match=r"cannot plan tiles|scale must be at least"):
        plan_tiles(width, height, scale=scale)
