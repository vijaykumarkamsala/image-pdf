"""Straightening a page photographed at an angle.

Verified by construction: a known rectangle is projected the way a camera would
project it, then corrected, and the grid printed on it is measured. A leaning
page has grid lines that crowd toward the far edge; a corrected one has them
evenly spaced. That is the property, so that is the measurement - rather than
"it looks straighter".
"""

from __future__ import annotations

from itertools import pairwise
from typing import Any

import pytest
from PIL import Image, ImageDraw

from ipw.processors.standard.perspective import (
    Corners,
    _solve,
    detect_page,
    flatten_page,
)

PAGE = (600, 800)
SCENE = (900, 1000)
QUAD = [(180.0, 120.0), (760.0, 210.0), (700.0, 900.0), (120.0, 760.0)]


def gridded_page() -> Any:
    """A page with a 100px grid, so distortion is measurable rather than felt."""
    page = Image.new("RGB", PAGE, (252, 251, 248))
    draw = ImageDraw.Draw(page)
    for index in range(1, 6):
        draw.line([(index * 100, 0), (index * 100, 800)], fill=(60, 60, 70), width=3)
    for index in range(1, 8):
        draw.line([(0, index * 100), (600, index * 100)], fill=(60, 60, 70), width=3)
    return page


def photographed(page: Any, quad: list[tuple[float, float]] = QUAD) -> Any:
    """The page as a camera at an angle would record it, on a dark desk."""
    flat = [
        (0.0, 0.0),
        (float(PAGE[0]), 0.0),
        (float(PAGE[0]), float(PAGE[1])),
        (0.0, float(PAGE[1])),
    ]
    matrix: list[list[float]] = []
    vector: list[float] = []
    for (source_x, source_y), (out_x, out_y) in zip(flat, quad, strict=True):
        matrix.append([out_x, out_y, 1, 0, 0, 0, -source_x * out_x, -source_x * out_y])
        vector.append(source_x)
        matrix.append([0, 0, 0, out_x, out_y, 1, -source_y * out_x, -source_y * out_y])
        vector.append(source_y)

    warped = page.transform(
        SCENE, Image.Transform.PERSPECTIVE, _solve(matrix, vector), Image.Resampling.BICUBIC
    )
    scene = Image.new("RGB", SCENE, (38, 34, 30))
    scene.paste(warped, (0, 0), warped.convert("L").point(lambda v: 255 if v > 12 else 0))
    return scene


def grid_gaps(image: Any, y_fraction: float) -> list[float]:
    """Distance between the vertical grid lines along one row."""
    grey = image.convert("L")
    width, height = grey.size
    y = int(height * y_fraction)
    dark = [x for x in range(width) if grey.getpixel((x, y)) < 140]

    centres: list[float] = []
    run: list[int] = []
    for x in dark:
        if run and x - run[-1] > 3:
            centres.append(sum(run) / len(run))
            run = []
        run.append(x)
    if run:
        centres.append(sum(run) / len(run))
    return [b - a for a, b in pairwise(centres)]


class TestTheGeometryIsExact:
    def test_a_leaning_page_comes_back_square(self) -> None:
        """The whole feature, measured on the grid rather than judged by eye."""
        scene = photographed(gridded_page())

        before = grid_gaps(scene, 0.2)
        assert before, "the fixture must show a grid to measure"
        assert max(before) - min(before) > 30, "the fixture must actually lean"

        found = detect_page(scene)
        assert found is not None
        flat = flatten_page(scene, found.corners)

        for fraction in (0.2, 0.8):
            gaps = grid_gaps(flat, fraction)
            assert gaps, "no grid found in the corrected page"
            assert max(gaps) - min(gaps) <= 4, (
                f"still leaning at {fraction:.0%} down the page: {gaps}"
            )

    def test_the_output_is_about_the_page_size(self) -> None:
        """Derived from the quadrilateral's own edges, so a page is not stretched
        into a shape somebody assumed."""
        scene = photographed(gridded_page())
        found = detect_page(scene)
        assert found is not None

        flat = flatten_page(scene, found.corners)

        assert 0.85 < (flat.width / PAGE[0]) < 1.15
        assert 0.75 < (flat.height / PAGE[1]) < 1.15

    def test_an_explicit_size_is_honoured(self) -> None:
        flat = flatten_page(
            gridded_page(),
            Corners(*[(0.0, 0.0), (600.0, 0.0), (600.0, 800.0), (0.0, 800.0)]),
            width=300,
            height=400,
        )

        assert flat.size == (300, 400)

    def test_corners_in_a_line_are_refused(self) -> None:
        """Four collinear points describe no page, and the solve would be
        singular - which should read as a message, not a linear algebra error."""
        flat_line = Corners((0.0, 0.0), (100.0, 0.0), (200.0, 0.0), (300.0, 0.0))

        with pytest.raises(ValueError, match="do not describe a page"):
            flatten_page(gridded_page(), flat_line)


class TestFindingThePage:
    def test_the_corners_land_close_to_the_truth(self) -> None:
        found = detect_page(photographed(gridded_page()))
        assert found is not None

        for got, want in zip(found.corners.as_list(), QUAD, strict=True):
            distance = ((got[0] - want[0]) ** 2 + (got[1] - want[1]) ** 2) ** 0.5
            assert distance < 20, f"corner off by {distance:.0f}px"

    def test_a_photograph_with_no_page_says_so(self) -> None:
        """Better than four corners the caller has to second-guess."""
        noise = Image.new("RGB", SCENE, (40, 38, 34))
        draw = ImageDraw.Draw(noise)
        for index in range(30):
            draw.ellipse(
                [index * 29, index * 13, index * 29 + 18, index * 13 + 18], fill=(60, 55, 50)
            )

        assert detect_page(noise) is None

    def test_it_reports_how_much_the_page_leans(self) -> None:
        found = detect_page(photographed(gridded_page()))
        assert found is not None

        assert found.skew_percent > 0
        assert 0.0 <= found.confidence <= 1.0
        assert found.note

    def test_a_square_page_is_reported_as_needing_little(self) -> None:
        square = [(100.0, 100.0), (700.0, 100.0), (700.0, 900.0), (100.0, 900.0)]
        found = detect_page(photographed(gridded_page(), square))
        assert found is not None

        assert found.skew_percent < 3
        assert "little" in found.note

    def test_the_detection_is_json_safe(self) -> None:
        import json

        found = detect_page(photographed(gridded_page()))
        assert found is not None
        json.dumps(found.as_record())
