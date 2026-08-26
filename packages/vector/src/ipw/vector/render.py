"""Writing fitted outlines out as SVG and as PDF.

Two formats, one geometry. Both writers take the same segments from the fitter,
so an SVG and a PDF of the same job describe the same shape rather than two
independent approximations of it - which is what makes "the proof looked right"
mean something about the file that goes to the machine.

**Both must use the non-zero winding rule.** The tracer emits outer boundaries
and holes with opposite winding, so non-zero fills a shape and knocks out its
holes automatically. It also handles the self-touching loop a diagonal stroke
produces, which the even-odd rule would punch a hole through. Even-odd is the
default in neither format, but it is one attribute away in both, and choosing it
by accident produces artwork that is subtly hollow in exactly the places that
matter - the counters of letters, the middle of a ring.
"""

from __future__ import annotations

from dataclasses import dataclass

from ipw.vector.simplify import Point, Segment

__all__ = ["Shape", "to_pdf_operators", "to_svg"]


@dataclass(frozen=True)
class Shape:
    """One filled colour: its outer boundaries and holes, and what colour it is."""

    colour: tuple[int, int, int]
    paths: list[tuple[Point, list[Segment]]]
    """Each entry is a start point and the segments that close back to it."""


def to_svg(
    shapes: list[Shape],
    width: int,
    height: int,
    *,
    background: tuple[int, int, int] | None = None,
    decimals: int = 2,
) -> str:
    """An SVG document, sized to the pixels it came from.

    The viewBox is the original pixel grid, so the artwork can be scaled to any
    size later without anything here having to guess at a physical size. A
    vector file that arrives pre-committed to 100mm is a vector file that has
    thrown away the one advantage it had.
    """
    body: list[str] = []
    if background is not None:
        body.append(f'<rect width="{width}" height="{height}" fill="{_hex(background)}"/>')

    for shape in shapes:
        data = " ".join(_svg_path(start, segments, decimals) for start, segments in shape.paths)
        if not data:
            continue
        # fill-rule is stated rather than left to the default. SVG's default is
        # already non-zero, but saying so keeps the file correct if it is ever
        # copied into a context that sets a different rule.
        body.append(f'<path fill="{_hex(shape.colour)}" fill-rule="nonzero" d="{data}"/>')

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" shape-rendering="geometricPrecision">'
        + "".join(body)
        + "</svg>"
    )


def _svg_path(start: Point, segments: list[Segment], decimals: int) -> str:
    def n(value: float) -> str:
        text = f"{value:.{decimals}f}".rstrip("0").rstrip(".")
        return text if text not in ("", "-0") else "0"

    out = [f"M{n(start[0])} {n(start[1])}"]
    for kind, points in segments:
        if kind == "L":
            out.append(f"L{n(points[0][0])} {n(points[0][1])}")
        else:
            a, b, c = points
            out.append(f"C{n(a[0])} {n(a[1])} {n(b[0])} {n(b[1])} {n(c[0])} {n(c[1])}")
    out.append("Z")
    return "".join(out)


def to_pdf_operators(
    shapes: list[Shape], height: float, *, scale: float = 1.0, decimals: int = 3
) -> bytes:
    """A PDF content stream drawing the same shapes.

    PDF's y axis runs upward from the bottom of the page while an image's runs
    downward from the top, so every y is flipped here. Doing it at the point of
    writing - rather than flipping the geometry earlier - keeps one coordinate
    system in the tracer, the fitter and the SVG writer, and confines the
    difference to the format that actually differs.
    """

    def n(value: float) -> str:
        return f"{value:.{decimals}f}".rstrip("0").rstrip(".") or "0"

    def x(value: float) -> str:
        return n(value * scale)

    def y(value: float) -> str:
        return n(height - value * scale)

    out: list[str] = []
    for shape in shapes:
        red, green, blue = (component / 255.0 for component in shape.colour)
        out.append(f"{n(red)} {n(green)} {n(blue)} rg")
        for start, segments in shape.paths:
            out.append(f"{x(start[0])} {y(start[1])} m")
            for kind, points in segments:
                if kind == "L":
                    out.append(f"{x(points[0][0])} {y(points[0][1])} l")
                else:
                    a, b, c = points
                    out.append(f"{x(a[0])} {y(a[1])} {x(b[0])} {y(b[1])} {x(c[0])} {y(c[1])} c")
            out.append("h")
        # `f` is the non-zero fill. `f*` would be even-odd and would hollow out
        # every counter and ring in the artwork.
        out.append("f")
    return "\n".join(out).encode("ascii")


def _hex(colour: tuple[int, int, int]) -> str:
    red, green, blue = (max(0, min(255, int(component))) for component in colour)
    return f"#{red:02x}{green:02x}{blue:02x}"
