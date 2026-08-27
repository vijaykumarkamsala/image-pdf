"""Photograph a page at an angle; get back a rectangle.

Nobody photographs a document square on. The camera is held at whatever angle
keeps the photographer's shadow off the paper, so the page arrives as a
trapezium: the far edge shorter than the near one, the text leaning, the margins
unequal. Every measurement taken from it is wrong, and it does not read as a
document because documents are rectangles.

**What the correction is.** Four corners in, four corners out. A projective
transform is the exact model of a flat surface seen from an angle - not an
approximation of one - so given where the page's corners landed in the
photograph, the mapping that puts them back on a rectangle is determined
precisely. There is no guesswork in the geometry; the only question is where
the corners are.

**Finding them.** A page is a bright quadrilateral on a darker background, so
the page mask is found by threshold and the corners by extremes along the
diagonals: the top-left corner is the page pixel that minimises ``x + y``, the
top-right maximises ``x - y``, and so on. It is a decades-old trick, it is
robust to a torn edge or a finger at the margin, and it costs one pass over a
downscaled copy.

Detection is a *suggestion*. It is returned with a confidence and the interface
lets the corners be dragged, because a detector that silently gets it wrong on
a dark desk is worse than one that admits the page was hard to find.

**Output size is derived, not guessed.** The rectangle takes the longest
opposite edges of the quadrilateral, so a page photographed at an angle comes
back at roughly the resolution it was captured at rather than being stretched
to a shape somebody assumed.

Pillow only, like the rest of ``standard/``: the eight transform coefficients
come from an eight-by-eight solve written out here, which is less code than
importing an array library would be worth.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

__all__ = ["Corners", "PageDetection", "detect_page", "flatten_page"]

# Work at this edge length when looking for the page. The corners are scaled
# back up afterwards; a page boundary does not need megapixels to find.
DETECT_EDGE = 400

# A page must cover at least this fraction of the frame to be believed. Below
# it, the bright region is more likely a window, a lamp or a sheet of paper on
# the desk behind the one being photographed.
MIN_PAGE_COVERAGE = 0.12


@dataclass(frozen=True)
class Corners:
    """The page's four corners, clockwise from the top left, in pixels."""

    top_left: tuple[float, float]
    top_right: tuple[float, float]
    bottom_right: tuple[float, float]
    bottom_left: tuple[float, float]

    def as_list(self) -> list[tuple[float, float]]:
        return [self.top_left, self.top_right, self.bottom_right, self.bottom_left]

    def as_record(self) -> dict[str, list[float]]:
        return {
            "top_left": list(self.top_left),
            "top_right": list(self.top_right),
            "bottom_right": list(self.bottom_right),
            "bottom_left": list(self.bottom_left),
        }


@dataclass(frozen=True)
class PageDetection:
    """Where the page seems to be, and how much to trust that."""

    corners: Corners
    confidence: float
    coverage: float
    skew_percent: float
    note: str

    def as_record(self) -> dict[str, Any]:
        return {
            "corners": self.corners.as_record(),
            "confidence": round(self.confidence, 2),
            "coverage": round(self.coverage, 3),
            "skew_percent": round(self.skew_percent, 1),
            "note": self.note,
        }


def _otsu_threshold(histogram: list[int]) -> int:
    """The level that best separates two groups of brightness.

    Otsu's method: try every cut and keep the one that maximises the variance
    *between* the two sides. A fixed threshold fails the moment somebody
    photographs cream paper or works in a dim room, and this does not need to
    be told which case it is looking at.
    """
    total = sum(histogram)
    if not total:
        return 128

    sum_all = sum(level * count for level, count in enumerate(histogram))
    sum_background = 0.0
    weight_background = 0
    best_level, best_variance = 128, -1.0

    for level, count in enumerate(histogram):
        weight_background += count
        if weight_background == 0:
            continue
        weight_foreground = total - weight_background
        if weight_foreground == 0:
            break

        sum_background += level * count
        mean_background = sum_background / weight_background
        mean_foreground = (sum_all - sum_background) / weight_foreground
        between = weight_background * weight_foreground * (mean_background - mean_foreground) ** 2
        if between > best_variance:
            best_variance, best_level = between, level

    return best_level


def detect_page(image: Any) -> PageDetection | None:
    """Find the page in a photograph, or say that it could not.

    Returns ``None`` when nothing page-shaped is present, which is the honest
    answer for a photograph of a landscape and better than four corners the
    caller would have to second-guess.
    """
    from PIL import Image, ImageFilter

    grey = image.convert("L")
    scale = max(grey.width, grey.height) / DETECT_EDGE
    if scale > 1:
        small = grey.resize(
            (max(16, int(grey.width / scale)), max(16, int(grey.height / scale))),
            Image.Resampling.BILINEAR,
        )
    else:
        small, scale = grey, 1.0

    # Blur first: a page's texture and its print both cross the threshold, and
    # smoothing them leaves the page as one region rather than a cloud of specks.
    small = small.filter(ImageFilter.GaussianBlur(2))
    cut = _otsu_threshold(small.histogram())
    mask = small.point(lambda level: 255 if level > cut else 0)

    pixels = mask.load()
    width, height = mask.size
    if pixels is None:
        return None

    found_any = False
    best: dict[str, tuple[tuple[int, int], float]] = {}
    lit = 0
    for y in range(height):
        for x in range(width):
            if not pixels[x, y]:
                continue
            lit += 1
            plus, minus = float(x + y), float(x - y)
            if not found_any:
                # Seed every extreme from the first page pixel, so none of them
                # start at a sentinel that could survive into the result.
                best = {
                    "tl": ((x, y), plus),
                    "br": ((x, y), plus),
                    "tr": ((x, y), minus),
                    "bl": ((x, y), minus),
                }
                found_any = True
                continue
            if plus < best["tl"][1]:
                best["tl"] = ((x, y), plus)
            if plus > best["br"][1]:
                best["br"] = ((x, y), plus)
            if minus > best["tr"][1]:
                best["tr"] = ((x, y), minus)
            if minus < best["bl"][1]:
                best["bl"] = ((x, y), minus)

    coverage = lit / float(width * height)
    if coverage < MIN_PAGE_COVERAGE or not found_any:
        return None

    def up(point: Any) -> tuple[float, float]:
        return (point[0] * scale, point[1] * scale)

    corners = Corners(
        top_left=up(best["tl"][0]),
        top_right=up(best["tr"][0]),
        bottom_right=up(best["br"][0]),
        bottom_left=up(best["bl"][0]),
    )

    # How far from a rectangle this is, as a percentage of the page's own size.
    # It is both the reason to correct and the measure of whether it worked.
    top = _distance(corners.top_left, corners.top_right)
    bottom = _distance(corners.bottom_left, corners.bottom_right)
    left = _distance(corners.top_left, corners.bottom_left)
    right = _distance(corners.top_right, corners.bottom_right)
    skew = (
        (
            abs(top - bottom) / max(1.0, max(top, bottom))
            + abs(left - right) / max(1.0, max(left, right))
        )
        / 2
        * 100
    )

    # A page filling the frame squarely leaves nothing to do; one that is small
    # in frame or oddly shaped is where a detector is most likely to be wrong.
    confidence = min(1.0, coverage * 1.8)
    if skew > 45:
        confidence *= 0.5

    if confidence < 0.45:
        note = (
            "A page was found but not confidently. Check the corners before "
            "correcting - drag any that are in the wrong place."
        )
    elif skew < 2:
        note = "This page is already square to the camera; correcting it would change little."
    else:
        note = f"Page found, leaning about {skew:.0f}%."

    return PageDetection(
        corners=corners, confidence=confidence, coverage=coverage, skew_percent=skew, note=note
    )


def _distance(a: tuple[float, float], b: tuple[float, float]) -> float:
    return float(((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5)


def _solve(matrix: list[list[float]], vector: list[float]) -> list[float]:
    """Gaussian elimination with partial pivoting, for the eight coefficients.

    Written out rather than imported: ``standard/`` stays a plain imaging
    pipeline, and an eight-by-eight solve is smaller than the argument for
    adding an array dependency to reach one.
    """
    size = len(vector)
    rows = [[*row, vector[index]] for index, row in enumerate(matrix)]

    for column in range(size):
        pivot = max(range(column, size), key=lambda r: abs(rows[r][column]))
        if abs(rows[pivot][column]) < 1e-12:
            msg = "those four corners do not describe a page - they may be in a line"
            raise ValueError(msg)
        rows[column], rows[pivot] = rows[pivot], rows[column]

        for target in range(size):
            if target == column:
                continue
            factor = rows[target][column] / rows[column][column]
            for position in range(column, size + 1):
                rows[target][position] -= factor * rows[column][position]

    return [rows[index][size] / rows[index][index] for index in range(size)]


def flatten_page(
    image: Any, corners: Corners, *, width: int | None = None, height: int | None = None
) -> Any:
    """Map the quadrilateral onto a rectangle, and return the flattened page.

    The output size defaults to the longest opposite edges of the quadrilateral,
    so the page comes back at about the resolution it was photographed at rather
    than a shape somebody assumed.
    """
    from PIL import Image

    points = corners.as_list()
    top = _distance(points[0], points[1])
    bottom = _distance(points[3], points[2])
    left = _distance(points[0], points[3])
    right = _distance(points[1], points[2])

    out_width = int(width or max(top, bottom))
    out_height = int(height or max(left, right))
    if out_width < 2 or out_height < 2:
        msg = f"a {out_width}x{out_height} page is too small to be one"
        raise ValueError(msg)

    target = [(0, 0), (out_width, 0), (out_width, out_height), (0, out_height)]

    # PIL maps *output* coordinates back to the source, so the system is solved
    # in that direction: source = (a*x + b*y + c) / (g*x + h*y + 1), and likewise
    # for y. Eight unknowns, and four corner pairs give exactly eight equations.
    matrix: list[list[float]] = []
    vector: list[float] = []
    for (source_x, source_y), (out_x, out_y) in zip(points, target, strict=True):
        matrix.append([out_x, out_y, 1, 0, 0, 0, -source_x * out_x, -source_x * out_y])
        vector.append(source_x)
        matrix.append([0, 0, 0, out_x, out_y, 1, -source_y * out_x, -source_y * out_y])
        vector.append(source_y)

    coefficients = _solve(matrix, vector)

    return image.convert("RGB").transform(
        (out_width, out_height),
        Image.Transform.PERSPECTIVE,
        coefficients,
        Image.Resampling.BICUBIC,
    )
