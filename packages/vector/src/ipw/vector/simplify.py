"""Turning a pixel staircase into the shape a person meant to draw.

A traced outline is exact and unusable: it follows the pixel grid, so a curve
arrives as a flight of single-pixel steps and a 600-pixel circle costs several
thousand points. Left alone it prints as a visibly serrated edge and opens as a
file too heavy to edit.

Two jobs, in order, and the order matters:

**Find the corners first.** A logo has genuine corners that must stay sharp and
genuine curves that must come out smooth, and no amount of clever fitting can
recover a corner once it has been smoothed away. So corners are identified up
front and treated as fixed; everything between two corners is a run that may be
smoothed freely.

**Then fit each run.** Straight runs stay straight. Curved runs become cubic
Bezier segments fitted to the traced points, with the error measured and the run
split until it is under tolerance. Measuring rather than assuming is the whole
point: a fit that is not checked is a guess, and the customer finds out at the
cutter.

Everything here is driven by one number the customer can understand - how far,
in pixels, the result may stray from the original outline.
"""

from __future__ import annotations

import bisect
import math

__all__ = ["Segment", "fit_path", "simplify"]

Point = tuple[float, float]

# A path segment: a straight line to `end`, or a cubic Bezier through two
# control points. Kept as data rather than emitted text so both the SVG and PDF
# writers can render the same geometry without either re-deriving it.
Segment = tuple[str, tuple[Point, ...]]

# The shortest window, in pixels, over which a direction change can be measured
# without the pixel staircase drowning it. Not a guess: on a traced 150-pixel
# circle the sharpest angle measured over three pixels is 131 degrees - well
# inside any sane corner threshold, so every point on a smooth circle reads as a
# corner. Over six pixels the sharpest is 157 degrees, comfortably outside it.
# Below this the tool reports corners that are not there.
_MIN_WINDOW = 6.0


def simplify(points: list[tuple[int, int]], tolerance: float) -> list[Point]:
    """Ramer-Douglas-Peucker on a closed loop.

    Drops points that lie within `tolerance` of the line between their
    neighbours, which removes the pixel staircase while keeping every feature
    larger than the tolerance. Applied to a closed loop, so it starts from the
    two points furthest apart rather than an arbitrary one - beginning at an
    arbitrary point on a circle would anchor a vertex where the shape has no
    feature at all, and leave a visible flat spot.
    """
    if len(points) < 3:
        return [(float(x), float(y)) for x, y in points]

    start = 0
    end = max(range(len(points)), key=lambda i: _distance_squared(points[0], points[i]))
    if end == start:
        return [(float(x), float(y)) for x, y in points]

    first = _rdp(points[start : end + 1], tolerance)
    second = _rdp([*points[end:], points[0]], tolerance)
    return [*first[:-1], *second[:-1]]


def _rdp(points: list[tuple[int, int]], tolerance: float) -> list[Point]:
    if len(points) < 3:
        return [(float(x), float(y)) for x, y in points]

    a, b = points[0], points[-1]
    worst, index = 0.0, 0
    for i in range(1, len(points) - 1):
        gap = _point_to_segment(points[i], a, b)
        if gap > worst:
            worst, index = gap, i

    if worst <= tolerance:
        return [(float(a[0]), float(a[1])), (float(b[0]), float(b[1]))]

    left = _rdp(points[: index + 1], tolerance)
    right = _rdp(points[index:], tolerance)
    return [*left[:-1], *right]


def fit_path(
    points: list[Point], *, smoothness: float, tolerance: float
) -> tuple[Point, list[Segment]]:
    """Fit a closed outline with straight runs and curves.

    **Pass the traced outline here, not a simplified one.** Fitting to points
    that have already been thinned approximates an approximation, and the two
    errors do not cancel - they compound, and not smoothly. Doing it that way
    made a tolerance of 0.75 pixels produce a worse circle (3.0 px out) than a
    tolerance of 1.5 (0.7 px out), which is the kind of result that destroys
    trust in every number the tool reports.

    Fitting against every traced point instead lets the least-squares solve
    average the pixel staircase away, which is exactly what it is for.

    `smoothness` is the angle, in degrees, below which a bend counts as part of
    a curve rather than a corner. Zero keeps every vertex sharp, which is right
    for artwork that really is polygonal - a floor plan, a barcode, a QR code -
    and wrong for anything drawn by hand.
    """
    if len(points) < 3:
        return points[0], [("L", (point,)) for point in points[1:]]

    corners = _corners(points, smoothness, window=max(_MIN_WINDOW, tolerance * 3.0))
    if not corners:
        # A shape with no corners at all - a circle, a blob - is still one
        # closed run; it just has to start somewhere.
        corners = [0]

    segments: list[Segment] = []
    for index, corner in enumerate(corners):
        following = corners[(index + 1) % len(corners)]
        run = _run(points, corner, following)
        segments.extend(_fit_run(run, tolerance))

    # The start point is returned rather than left implicit. The path begins at
    # the first *corner*, which is rarely the first traced point, and a caller
    # that assumed otherwise would draw every shape with one edge running back
    # to the wrong place - a defect that looks like a catastrophic tracing bug
    # and is really just a missing return value.
    return points[corners[0]], segments


def _corners(points: list[Point], smoothness: float, window: float = 4.0) -> list[int]:
    """Indices where the outline turns sharply enough to be a real corner.

    The angle is measured across a *window* of arc length rather than between
    immediate neighbours, and that detail decides whether this works at all. A
    traced outline is a staircase, so consecutive points turn ninety degrees at
    every step; judged locally, every point on a circle is a right-angled
    corner. An earlier version did exactly that and fitted a 150-pixel circle as
    five hundred and fifty-six straight lines - accurate, smooth-looking at a
    glance, and completely defeating the purpose of vectorising.

    Looking a few pixels either side instead lets staircase noise cancel out
    while a real corner - where the direction changes and *stays* changed -
    still stands out.
    """
    if smoothness <= 0:
        return list(range(len(points)))

    count = len(points)
    if count < 4:
        return list(range(count))

    # Arc length is computed once and then indexed into. Walking the loop to
    # answer "where am I six pixels from here?" made this the slowest step in
    # the product: fifty seconds for a one-megapixel photograph, most of it
    # spent measuring the same distances over and over.
    cumulative = _arc_lengths(points)
    perimeter = cumulative[-1]
    if perimeter <= 0:
        return list(range(count))

    limit = math.radians(180.0 - smoothness)
    scored: list[tuple[int, float]] = []
    for index in range(count):
        back = _index_at(cumulative, perimeter, count, index, -window)
        forward = _index_at(cumulative, perimeter, count, index, window)
        angle = _interior_angle(points[back], points[index], points[forward])
        if angle < limit:
            scored.append((index, angle))

    return _keep_sharpest(scored, cumulative, perimeter, window)


def _arc_lengths(points: list[Point]) -> list[float]:
    """Distance from the first point to each point, closing the loop at the end."""
    cumulative = [0.0]
    count = len(points)
    for index in range(count):
        cumulative.append(cumulative[-1] + math.dist(points[index], points[(index + 1) % count]))
    return cumulative


def _index_at(
    cumulative: list[float],
    perimeter: float,
    count: int,
    start: int,
    distance: float,
    min_points: int = 3,
) -> int:
    """Index `distance` pixels *and* at least `min_points` steps from `start`.

    Both conditions, because either alone fails on real outlines. Distance alone
    fails when the traced points are far apart - a long straight run can put
    neighbours seventeen pixels apart, so a six-pixel window lands on the
    immediate neighbour and measures the ninety-degree staircase step between
    them. Every point on a circle then reads as a corner.

    Point count alone fails the other way, on dense outlines where a few steps
    cover almost no ground and the angle is still pure staircase noise.
    """
    target = (cumulative[start] + distance) % perimeter
    index = bisect.bisect_right(cumulative, target) - 1
    index = max(0, min(index, count - 1))

    if distance >= 0:
        taken = (index - start) % count
        if taken < min_points:
            index = (start + min_points) % count
    else:
        taken = (start - index) % count
        if taken < min_points:
            index = (start - min_points) % count
    return index


def _keep_sharpest(
    scored: list[tuple[int, float]],
    cumulative: list[float],
    perimeter: float,
    window: float,
) -> list[int]:
    """One corner per cluster - the sharpest.

    A real corner is detected several times over, once from each vantage point
    inside the window. Keeping them all would plant a run boundary at every
    pixel around the corner and leave nothing long enough to fit as a curve.

    Candidates are taken sharpest-first, and each is rejected if an already
    accepted corner sits within the window. Checking that against every accepted
    corner is quadratic, and on a photograph - where a loop can carry thousands
    of candidates - it dominated everything else the product does. Because arc
    length rises with index, the closest accepted corner is always one of the
    two neighbouring entries in a sorted list, so a binary search answers it.
    """
    if not scored:
        return []

    def gap(a: int, b: int) -> float:
        straight = abs(cumulative[a] - cumulative[b])
        return min(straight, perimeter - straight)

    chosen: list[int] = []
    for index, _ in sorted(scored, key=lambda item: item[1]):
        position = bisect.bisect_left(chosen, index)
        neighbours = []
        if chosen:
            neighbours.append(chosen[position % len(chosen)])
            neighbours.append(chosen[position - 1])
        if all(gap(index, taken) > window for taken in neighbours):
            chosen.insert(position, index)
    return chosen


def _interior_angle(a: Point, b: Point, c: Point) -> float:
    ax, ay = a[0] - b[0], a[1] - b[1]
    cx, cy = c[0] - b[0], c[1] - b[1]
    left = math.hypot(ax, ay)
    right = math.hypot(cx, cy)
    if left == 0 or right == 0:
        return math.pi
    cosine = (ax * cx + ay * cy) / (left * right)
    return math.acos(max(-1.0, min(1.0, cosine)))


def _run(points: list[Point], start: int, end: int) -> list[Point]:
    if end > start:
        return points[start : end + 1]
    return [*points[start:], *points[: end + 1]]


def _fit_run(run: list[Point], tolerance: float) -> list[Segment]:
    """One run between corners, as a line or as however many curves it needs."""
    if len(run) < 2:
        return []
    if len(run) == 2:
        return [("L", (run[1],))]

    # A run whose points already lie on a straight line does not need a curve,
    # and saying so keeps machine-drawn artwork exact rather than approximately
    # exact - a wall on a floor plan should be a line, not a very flat spline.
    if _max_deviation(run, run[0], run[-1]) <= tolerance:
        return [("L", (run[-1],))]

    return _fit_cubic(run, tolerance, depth=0)


def _fit_cubic(run: list[Point], tolerance: float, depth: int) -> list[Segment]:
    """Fit one cubic to the run; if it misses by too much, split and recurse.

    The split point is where the fit is worst, which is where the shape does
    something the single curve could not follow.
    """
    control_a, control_b = _control_points(run)
    error, worst = _curve_error(run, run[0], control_a, control_b, run[-1])

    # Three stopping conditions, and the last one is the interesting one.
    #
    # A traced outline zigzags by half a pixel at every step, so no smooth curve
    # can ever sit within half a pixel of all of it. Asking for a tighter
    # tolerance than the pixel grid can express would otherwise split until the
    # depth limit, emitting hundreds of curve segments that trace noise. Runs
    # shorter than six points are therefore fitted as they are: below that
    # length the remaining error is the grid, not the fit.
    too_short_to_improve = len(run) < 6
    if error <= tolerance or too_short_to_improve or depth >= 12:
        return [("C", (control_a, control_b, run[-1]))]
    if worst <= 0 or worst >= len(run) - 1:
        return [("C", (control_a, control_b, run[-1]))]

    left = _fit_cubic(run[: worst + 1], tolerance, depth + 1)
    right = _fit_cubic(run[worst:], tolerance, depth + 1)
    return [*left, *right]


def _control_points(run: list[Point]) -> tuple[Point, Point]:
    """Control points for a cubic through the run's endpoints.

    **The control points are constrained to the endpoint tangents**, and only
    their distances along those tangents are solved for. Solving for two free
    two-dimensional points instead - the obvious formulation - is unstable on
    exactly the runs that occur most: short ones, and nearly straight ones. On a
    150-pixel circle it put a control point at x=412 for a run spanning x=205 to
    x=210, producing a path that swung hundreds of pixels outside the image
    while every endpoint remained correct. Endpoints being right is what makes
    that failure so easy to miss.

    Two scalars cannot do that. The curve leaves along the outline's direction
    and arrives along it, which is also what makes a fitted curve look like the
    line someone drew rather than like a spline that happens to pass nearby.
    """
    start, end = run[0], run[-1]
    span = math.dist(start, end)
    left_tangent = _tangent(run, at_start=True)
    right_tangent = _tangent(run, at_start=False)

    fallback = (
        (start[0] + left_tangent[0] * span / 3.0, start[1] + left_tangent[1] * span / 3.0),
        (end[0] + right_tangent[0] * span / 3.0, end[1] + right_tangent[1] * span / 3.0),
    )
    if span <= 0:
        return fallback

    ts = _chord_lengths(run)
    c11 = c12 = c22 = x1 = x2 = 0.0
    for point, t in zip(run, ts, strict=True):
        u = 1.0 - t
        b0, b1, b2, b3 = u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t

        a1 = (left_tangent[0] * b1, left_tangent[1] * b1)
        a2 = (right_tangent[0] * b2, right_tangent[1] * b2)

        c11 += a1[0] * a1[0] + a1[1] * a1[1]
        c12 += a1[0] * a2[0] + a1[1] * a2[1]
        c22 += a2[0] * a2[0] + a2[1] * a2[1]

        rx = point[0] - ((b0 + b1) * start[0] + (b2 + b3) * end[0])
        ry = point[1] - ((b0 + b1) * start[1] + (b2 + b3) * end[1])
        x1 += a1[0] * rx + a1[1] * ry
        x2 += a2[0] * rx + a2[1] * ry

    determinant = c11 * c22 - c12 * c12
    if abs(determinant) < 1e-9:
        return fallback

    alpha = (x1 * c22 - x2 * c12) / determinant
    beta = (c11 * x2 - c12 * x1) / determinant

    # A negative distance points the curve backwards out of its own endpoint,
    # and an enormous one bows it far outside the shape. Both are the solver
    # telling us this run is not well described by one cubic; the caller's next
    # step is to split it, so a sane curve here is all that is needed.
    limit = span * 1.5
    if not (0.0 < alpha < limit and 0.0 < beta < limit):
        return fallback

    return (
        (start[0] + left_tangent[0] * alpha, start[1] + left_tangent[1] * alpha),
        (end[0] + right_tangent[0] * beta, end[1] + right_tangent[1] * beta),
    )


def _tangent(run: list[Point], *, at_start: bool) -> Point:
    """Unit direction the outline travels at one end of a run.

    Averaged over a few points rather than taken from the immediate neighbour:
    on a pixel staircase the immediate neighbour is always axis-aligned, so a
    single step would report every tangent as due north, south, east or west.
    """
    points = run if at_start else run[::-1]
    origin = points[0]
    dx = dy = 0.0
    for index in range(1, min(5, len(points))):
        weight = 1.0 / index
        dx += (points[index][0] - origin[0]) * weight
        dy += (points[index][1] - origin[1]) * weight
    length = math.hypot(dx, dy)
    if length == 0:
        return (0.0, 0.0)
    return (dx / length, dy / length)


def _chord_lengths(run: list[Point]) -> list[float]:
    """Each point's position along the run, from 0 to 1, by distance."""
    lengths = [0.0]
    for index in range(1, len(run)):
        step = math.dist(run[index - 1], run[index])
        lengths.append(lengths[-1] + step)
    total = lengths[-1]
    if total <= 0:
        return [index / max(len(run) - 1, 1) for index in range(len(run))]
    return [length / total for length in lengths]


def _curve_error(run: list[Point], p0: Point, p1: Point, p2: Point, p3: Point) -> tuple[float, int]:
    """How far the fitted curve strays from the traced points, and where worst.

    This is the measurement that makes the tolerance mean something. Without it
    the fit is a plausible guess, and a guess that is wrong by three pixels on a
    logo is wrong on every sign, shirt and cut sheet it is used for.
    """
    ts = _chord_lengths(run)
    worst_error, worst_index = 0.0, 0
    for index, (point, t) in enumerate(zip(run, ts, strict=True)):
        u = 1.0 - t
        bx = u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0]
        by = u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]
        error = math.dist(point, (bx, by))
        if error > worst_error:
            worst_error, worst_index = error, index
    return worst_error, worst_index


def _max_deviation(run: list[Point], a: Point, b: Point) -> float:
    return max((_point_to_segment(point, a, b) for point in run), default=0.0)


def _point_to_segment(point: Point | tuple[int, int], a: Point, b: Point) -> float:
    px, py = float(point[0]), float(point[1])
    ax, ay = float(a[0]), float(a[1])
    bx, by = float(b[0]), float(b[1])
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def _distance_squared(a: tuple[int, int], b: tuple[int, int]) -> float:
    return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2
