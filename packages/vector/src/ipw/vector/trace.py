"""Turning a region of pixels into the outline that encloses it.

This is the step everything else in vectorising depends on, and the one with the
most ways to be subtly wrong. The output must be a set of *closed* loops with
consistent winding, because that is what lets a renderer fill a shape and knock
out its holes. A tracer that emits open paths, or loops wound inconsistently,
produces artwork that looks right in one viewer and inside-out in another.

**The method: follow the cracks between pixels, not the pixels.** A boundary is
made of the edges of filled cells that face an empty one. Every such edge is
emitted with a direction chosen so the filled side is always on the same hand,
and the edges then chain head-to-tail into loops. The result is exact - it
follows the pixel grid precisely rather than approximating it - which matters
because the smoothing that comes later should be a deliberate, measurable choice
rather than an accident of how the outline was found.

The alternative, marching squares on cell centres, cuts corners by half a pixel
everywhere. For a photograph nobody would see it. For a logo being cut out of
vinyl, half a pixel of drift at every corner is the difference between a clean
cut and a visibly soft one.
"""

from __future__ import annotations

import numpy as np

__all__ = ["Loop", "trace_mask"]

# A loop is a closed ring of integer grid points, first point not repeated at
# the end. Coordinates are grid corners: (0, 0) is the top-left corner of the
# top-left pixel, so a 1x1 image traces to (0,0) (1,0) (1,1) (0,1).
Loop = list[tuple[int, int]]

# Direction codes, in the order used to break ties at an ambiguous corner.
_RIGHT = (1, 0)
_DOWN = (0, 1)
_LEFT = (-1, 0)
_UP = (0, -1)


def trace_mask(mask: np.ndarray) -> list[Loop]:
    """Every closed outline in a boolean mask.

    Outer boundaries wind clockwise and holes wind anticlockwise, in a
    coordinate system with y increasing downward. That convention means a
    renderer using the non-zero winding rule fills shapes and clears their holes
    without being told which is which - the winding already says so.

    Returns loops in no particular order; the caller decides paint order.
    """
    if mask.ndim != 2:
        msg = f"a mask must be two-dimensional, got shape {mask.shape}"
        raise ValueError(msg)
    if mask.dtype != np.bool_:
        mask = mask.astype(bool)
    if not mask.any():
        return []

    edges = _boundary_edges(mask)
    return _chain(edges)


def _boundary_edges(mask: np.ndarray) -> dict[tuple[int, int], list[tuple[int, int]]]:
    """Directed edges along every filled/empty boundary, keyed by start point.

    Each filled cell contributes an edge for any of its four sides that faces
    outside the shape. Directions are chosen so that walking an edge keeps the
    filled side on the walker's right, which is what makes outer boundaries come
    out clockwise and holes anticlockwise without a second pass to work out
    which is which.
    """
    height, width = mask.shape
    padded = np.zeros((height + 2, width + 2), dtype=bool)
    padded[1:-1, 1:-1] = mask
    inner = padded[1:-1, 1:-1]

    # A side is a boundary when the neighbour across it is empty. Comparing
    # against the padded array means cells at the image edge are handled by the
    # same expression as everything else, rather than by four special cases.
    top = inner & ~padded[:-2, 1:-1]
    bottom = inner & ~padded[2:, 1:-1]
    left = inner & ~padded[1:-1, :-2]
    right = inner & ~padded[1:-1, 2:]

    edges: dict[tuple[int, int], list[tuple[int, int]]] = {}

    def add(ys: np.ndarray, xs: np.ndarray, start: tuple[int, int], end: tuple[int, int]) -> None:
        for y, x in zip(ys.tolist(), xs.tolist(), strict=True):
            a = (x + start[0], y + start[1])
            b = (x + end[0], y + end[1])
            edges.setdefault(a, []).append(b)

    # Filled side on the right of travel, y downward:
    #   top edge    -> travel right   left edge  -> travel up
    #   bottom edge -> travel left    right edge -> travel down
    for sides, start, end in (
        (top, (0, 0), (1, 0)),
        (right, (1, 0), (1, 1)),
        (bottom, (1, 1), (0, 1)),
        (left, (0, 1), (0, 0)),
    ):
        ys, xs = np.nonzero(sides)
        add(ys, xs, start, end)
    return edges


def _chain(edges: dict[tuple[int, int], list[tuple[int, int]]]) -> list[Loop]:
    """Link directed edges head-to-tail into closed loops.

    Where two pixels touch only at a corner, two edges leave the same point and
    the choice between them decides whether the shapes come out joined or
    separate. They are joined here, deliberately: that pattern repeated *is* a
    diagonal stroke, and separating them would turn every diagonal line in the
    picture into a chain of disconnected diamonds. Treating the foreground as
    eight-connected keeps strokes whole, which is what the image means.

    The loop that results touches itself at that corner. That is fine to fill:
    both lobes wind the same way, so the non-zero winding rule covers both. A
    self-touching loop is only a problem under the even-odd rule, which is why
    the renderer must use non-zero - see `render.py`.

    Choosing arbitrarily would still produce closed loops, so nothing would
    visibly fail on a simple fixture. It would just occasionally cut a diagonal
    stroke into pieces, which is exactly the defect that survives testing
    against rectangles and appears the moment real artwork arrives.
    """
    remaining = {start: list(ends) for start, ends in edges.items()}
    loops: list[Loop] = []

    for origin in list(remaining):
        while remaining.get(origin):
            loop: Loop = []
            point = origin
            heading = None

            while True:
                options = remaining.get(point)
                if not options:
                    break
                nxt = (
                    options.pop(_pick(heading, point, options))
                    if len(options) > 1
                    else options.pop()
                )
                if not options:
                    remaining.pop(point, None)

                loop.append(point)
                heading = (nxt[0] - point[0], nxt[1] - point[1])
                point = nxt
                if point == origin:
                    break

            if len(loop) >= 4:
                loops.append(_drop_collinear(loop))

    return loops


def _pick(
    heading: tuple[int, int] | None, point: tuple[int, int], options: list[tuple[int, int]]
) -> int:
    """Index of the continuation to take, given where we came from.

    At an ambiguous corner this crosses into the diagonal neighbour rather than
    turning back along the current shape, which is what keeps a diagonal stroke
    a single connected outline.
    """
    if heading is None:
        return 0
    order = {_RIGHT: 0, _DOWN: 1, _LEFT: 2, _UP: 3}
    incoming = order[heading]
    # Anticlockwise-first in screen coordinates, then straight on, then the
    # sharp turn back, and only as a last resort reversing.
    preference = [(incoming + 3) % 4, incoming, (incoming + 1) % 4, (incoming + 2) % 4]
    best, best_rank = 0, len(preference)
    for index, end in enumerate(options):
        direction = (end[0] - point[0], end[1] - point[1])
        rank = preference.index(order[direction])
        if rank < best_rank:
            best, best_rank = index, rank
    return best


def _drop_collinear(loop: Loop) -> Loop:
    """Remove points that lie in the middle of a straight run.

    A traced outline has a point at every pixel corner, so a horizontal edge a
    thousand pixels long arrives as a thousand points describing a straight
    line. Dropping them costs nothing and makes everything downstream - the
    simplifier, the curve fitter, the file itself - proportionally smaller.
    """
    if len(loop) < 3:
        return loop
    out: Loop = []
    count = len(loop)
    for index in range(count):
        previous = loop[index - 1]
        current = loop[index]
        following = loop[(index + 1) % count]
        before = (current[0] - previous[0], current[1] - previous[1])
        after = (following[0] - current[0], following[1] - current[1])
        if before != after:
            out.append(current)
    return out or loop


def area(loop: Loop) -> float:
    """Signed area of a loop, by the shoelace formula.

    Positive means clockwise in this coordinate system, so the sign says whether
    a loop is an outer boundary or a hole, and the magnitude says whether it is
    a real shape or a speck of noise worth discarding.
    """
    total = 0
    count = len(loop)
    for index in range(count):
        x0, y0 = loop[index]
        x1, y1 = loop[(index + 1) % count]
        total += x0 * y1 - x1 * y0
    return total / 2.0
