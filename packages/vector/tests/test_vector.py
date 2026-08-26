"""Tracing pictures into shapes.

Vectorising fails in a particular way: the output always looks plausible. A
tracer with a broken corner detector still returns smooth closed paths, and a
fitter whose control points overshoot still returns valid Bezier curves. Nothing
raises, nothing looks obviously wrong in a thumbnail, and the defect is found on
a cutting bed.

So these tests measure against shapes whose true geometry is known - a circle of
known radius, a square of known corners - rather than checking that something
came back.
"""

from __future__ import annotations

import math
import xml.etree.ElementTree as ElementTree
from itertools import pairwise
from typing import Any

import numpy as np
import pytest
from PIL import Image, ImageDraw

from ipw.vector import Settings, fit_path, otsu, separate, to_svg, trace_mask, vectorise
from ipw.vector.render import Shape
from ipw.vector.simplify import Segment
from ipw.vector.trace import area


def circle_mask(radius: int) -> Any:
    size = 2 * radius + 3
    ys, xs = np.mgrid[0:size, 0:size]
    return ((xs - size // 2) ** 2 + (ys - size // 2) ** 2) <= radius * radius


def flatten(start: tuple[float, float], segments: list[Segment]) -> list[tuple[float, float]]:
    """Sample a fitted path densely, so it can be compared against real geometry."""
    points = [start]
    current = start
    for kind, args in segments:
        if kind == "L":
            points.append(args[0])
            current = args[0]
        else:
            a, b, c = args
            for step in range(1, 25):
                t = step / 24
                u = 1 - t
                points.append(
                    (
                        u**3 * current[0]
                        + 3 * u * u * t * a[0]
                        + 3 * u * t * t * b[0]
                        + t**3 * c[0],
                        u**3 * current[1]
                        + 3 * u * u * t * a[1]
                        + 3 * u * t * t * b[1]
                        + t**3 * c[1],
                    )
                )
            current = c
    return points


class TestTracing:
    def test_a_single_pixel_encloses_exactly_one_unit_of_area(self) -> None:
        loops = trace_mask(np.array([[True]]))
        assert len(loops) == 1
        assert area(loops[0]) == pytest.approx(1.0)

    def test_an_empty_mask_traces_to_nothing(self) -> None:
        assert trace_mask(np.zeros((10, 10), dtype=bool)) == []

    def test_a_hole_winds_opposite_to_its_outer_boundary(self) -> None:
        """This is what lets a renderer knock the hole out.

        Outer boundaries and holes are distinguished by winding direction alone.
        Get it wrong and every ring, every letter O and every counter in the
        artwork fills in solid - a defect invisible in a wireframe preview and
        obvious the moment anything is printed or cut.
        """
        mask = np.array(
            [[1, 1, 1], [1, 0, 1], [1, 1, 1]],
            dtype=bool,
        )
        loops = trace_mask(mask)
        assert len(loops) == 2
        signs = sorted(math.copysign(1, area(loop)) for loop in loops)
        assert signs == [-1.0, 1.0], "the hole did not wind opposite to the outer boundary"

    def test_separate_shapes_trace_separately(self) -> None:
        mask = np.array([[1, 0, 1], [0, 0, 0], [1, 0, 1]], dtype=bool)
        assert len(trace_mask(mask)) == 4

    def test_a_diagonal_stroke_stays_one_connected_outline(self) -> None:
        """Pixels touching only at their corners are one stroke, not a chain.

        A diagonal line in a bitmap *is* a run of corner-touching pixels. Treating
        each as separate would turn every diagonal in the artwork into a row of
        disconnected diamonds - correct closed paths, useless output.
        """
        loops = trace_mask(np.eye(8, dtype=bool))
        assert len(loops) == 1
        assert sum(area(loop) for loop in loops) == pytest.approx(8.0)

    def test_total_area_always_matches_the_pixel_count(self) -> None:
        """The strongest single check on the tracer: it conserves area.

        Any missed edge, doubled edge or mis-wound loop shows up here as a
        number that does not match, regardless of what the shape looks like.
        """
        rng = np.zeros((40, 40), dtype=bool)
        rng[5:20, 5:20] = True
        rng[10:15, 10:15] = False
        rng[25:35, 25:38] = True
        rng[0, 39] = True
        total = sum(area(loop) for loop in trace_mask(rng))
        assert total == pytest.approx(float(rng.sum()))


class TestFitting:
    @pytest.mark.parametrize("radius", [20, 60, 150])
    def test_a_circle_is_reproduced_to_within_the_stated_tolerance(self, radius: int) -> None:
        """The tolerance has to mean something, or every number here is decoration."""
        size = 2 * radius + 3
        loop = max(trace_mask(circle_mask(radius)), key=len)
        points = [(float(x), float(y)) for x, y in loop]
        start, segments = fit_path(points, smoothness=25.0, tolerance=1.5)

        centre = size / 2
        worst = max(
            abs(math.hypot(x - centre, y - centre) - radius) for x, y in flatten(start, segments)
        )
        # A traced outline is itself up to about a pixel off a true circle, so
        # the fit is allowed the tolerance plus that inherent grid error.
        assert worst < 1.5 + 1.0, f"{worst:.2f}px from a true circle of radius {radius}"

    def test_a_circle_becomes_curves_rather_than_hundreds_of_lines(self) -> None:
        """An accurate polygon is not a vectorised circle.

        An early corner detector judged angles between adjacent points, so every
        step of the pixel staircase read as a right angle and a 150-pixel circle
        came back as 556 straight segments. It measured perfectly and defeated
        the entire purpose.
        """
        loop = max(trace_mask(circle_mask(150)), key=len)
        points = [(float(x), float(y)) for x, y in loop]
        _, segments = fit_path(points, smoothness=25.0, tolerance=1.5)
        assert len(segments) < 100, f"{len(segments)} segments for one circle"
        assert any(kind == "C" for kind, _ in segments), "no curves at all"

    def test_a_square_keeps_exactly_four_sharp_corners(self) -> None:
        mask = np.zeros((80, 80), dtype=bool)
        mask[10:70, 10:70] = True
        loop = max(trace_mask(mask), key=len)
        points = [(float(x), float(y)) for x, y in loop]
        start, segments = fit_path(points, smoothness=25.0, tolerance=1.0)

        assert len(segments) == 4
        assert all(kind == "L" for kind, _ in segments), "a square gained curved sides"
        corners = {start, *(args[-1] for _, args in segments)}
        assert corners == {(10.0, 10.0), (70.0, 10.0), (70.0, 70.0), (10.0, 70.0)}

    def test_no_control_point_escapes_the_shape(self) -> None:
        """Control points must stay near the artwork.

        Solving for two free 2-D control points is unstable on short, nearly
        straight runs: on a 150-pixel circle it produced a control point at
        x=412 for a run spanning x=205 to x=210. Every endpoint was still
        correct, so the path closed and the shape "worked" - while swinging
        hundreds of pixels outside the image.
        """
        size = 303
        loop = max(trace_mask(circle_mask(150)), key=len)
        points = [(float(x), float(y)) for x, y in loop]
        start, segments = fit_path(points, smoothness=25.0, tolerance=1.0)

        every = [start, *(point for _, args in segments for point in args)]
        margin = 20.0
        assert all(-margin <= x <= size + margin for x, _ in every), "a control point flew off"
        assert all(-margin <= y <= size + margin for _, y in every)

    def test_tighter_tolerance_is_never_worse(self) -> None:
        """Monotonicity, which an earlier version did not have.

        Fitting to already-simplified points compounded two approximations, and
        a tolerance of 0.75 produced a worse circle than 1.5. A setting that
        gets worse as you tighten it makes every number in the interface
        untrustworthy.
        """
        loop = max(trace_mask(circle_mask(150)), key=len)
        points = [(float(x), float(y)) for x, y in loop]
        centre = 303 / 2

        errors = []
        for tolerance in (1.0, 1.5, 2.0, 3.0):
            start, segments = fit_path(points, smoothness=25.0, tolerance=tolerance)
            errors.append(
                max(
                    abs(math.hypot(x - centre, y - centre) - 150)
                    for x, y in flatten(start, segments)
                )
            )
        for tighter, looser in pairwise(errors):
            assert tighter <= looser + 0.5, f"tightening made it worse: {errors}"

    def test_zero_smoothness_keeps_every_vertex(self) -> None:
        """Right for plans, barcodes and pixel art, where a curve would be a lie."""
        mask = np.zeros((40, 40), dtype=bool)
        mask[5:35, 5:35] = True
        mask[20:35, 20:35] = False
        loop = max(trace_mask(mask), key=len)
        points = [(float(x), float(y)) for x, y in loop]
        _, segments = fit_path(points, smoothness=0.0, tolerance=1.0)
        assert all(kind == "L" for kind, _ in segments)


class TestPalette:
    def test_otsu_finds_the_split_in_a_two_tone_image(self) -> None:
        """Any cut from the dark value up to just below the light one separates.

        The threshold is used as `dark = grey <= cut`, so 30 itself is a correct
        answer for a 30/220 image and so is 219: every one of them puts all the
        dark pixels on one side and all the light ones on the other, with the
        same between-class variance. Asserting a strict interior would be
        testing which of several equally right answers argmax happened to reach.
        """
        grey = np.concatenate(
            [np.full(1000, 30, dtype=np.uint8), np.full(1000, 220, dtype=np.uint8)]
        ).reshape(50, 40)
        cut = otsu(grey)
        assert 30 <= cut < 220
        assert (grey <= cut).sum() == 1000, "the cut did not separate the two tones"

    def test_otsu_beats_a_fixed_threshold_on_a_pale_scan(self) -> None:
        """A pencil sketch on cream paper lives entirely above 128.

        A fixed threshold would return a blank page, and the customer would
        conclude the tool cannot read their drawing.
        """
        grey = np.concatenate(
            [np.full(400, 150, dtype=np.uint8), np.full(1600, 240, dtype=np.uint8)]
        ).reshape(50, 40)
        cut = otsu(grey)
        assert 150 <= cut < 240, f"threshold {cut} would lose the pencil or the paper"

    def test_an_empty_histogram_does_not_divide_by_zero(self) -> None:
        assert otsu(np.zeros((0, 0), dtype=np.uint8)) == 128

    def test_the_background_is_left_transparent_by_default(self) -> None:
        """A vector with a baked-in white rectangle has to be edited before use."""
        image = Image.new("RGB", (50, 50), (255, 255, 255))
        ImageDraw.Draw(image).rectangle([10, 10, 20, 20], fill=(200, 0, 0))
        layers = separate(image, mode="flat_colour", colours=2)
        assert len(layers) == 1, "the background was drawn instead of left out"

    def test_the_background_can_be_kept_on_request(self) -> None:
        image = Image.new("RGB", (50, 50), (255, 255, 255))
        ImageDraw.Draw(image).rectangle([10, 10, 20, 20], fill=(200, 0, 0))
        layers = separate(image, mode="flat_colour", colours=2, ignore_background=False)
        assert len(layers) == 2

    def test_layers_come_back_largest_first(self) -> None:
        """Paint order: the biggest area is the background and must go down first."""
        image = Image.new("RGB", (60, 60), (255, 255, 255))
        draw = ImageDraw.Draw(image)
        draw.rectangle([0, 0, 40, 60], fill=(10, 10, 200))
        draw.rectangle([0, 0, 10, 10], fill=(200, 10, 10))
        layers = separate(image, mode="flat_colour", colours=3, ignore_background=False)
        sizes = [layer.pixels for layer in layers]
        assert sizes == sorted(sizes, reverse=True)

    def test_an_unknown_mode_is_refused(self) -> None:
        with pytest.raises(ValueError, match="unknown mode"):
            separate(Image.new("RGB", (4, 4)), mode="interpretive_dance", colours=2)


class TestSvg:
    def test_the_document_parses_and_carries_the_original_dimensions(self) -> None:
        shape = Shape((255, 0, 0), [((0.0, 0.0), [("L", ((10.0, 0.0),)), ("L", ((10.0, 10.0),))])])
        root = ElementTree.fromstring(  # noqa: S314 - SVG this test just generated, not input
            to_svg([shape], 640, 480)
        )
        assert root.get("viewBox") == "0 0 640 480"
        assert root.get("width") == "640"

    def test_paths_declare_the_non_zero_fill_rule(self) -> None:
        """Even-odd would punch holes through every self-touching diagonal."""
        shape = Shape((0, 0, 0), [((0.0, 0.0), [("L", ((5.0, 5.0),))])])
        root = ElementTree.fromstring(  # noqa: S314 - SVG this test just generated, not input
            to_svg([shape], 10, 10)
        )
        paths = [element for element in root.iter() if element.tag.endswith("path")]
        assert paths
        assert all(path.get("fill-rule") == "nonzero" for path in paths)

    def test_every_path_is_closed(self) -> None:
        shape = Shape((0, 0, 0), [((0.0, 0.0), [("L", ((5.0, 0.0),)), ("L", ((5.0, 5.0),))])])
        root = ElementTree.fromstring(  # noqa: S314 - SVG this test just generated, not input
            to_svg([shape], 10, 10)
        )
        path = next(element for element in root.iter() if element.tag.endswith("path"))
        assert path.get("d", "").endswith("Z"), "an unclosed path cannot be filled or cut"


class TestEndToEnd:
    @staticmethod
    def _logo() -> Image.Image:
        image = Image.new("RGB", (400, 300), (255, 255, 255))
        draw = ImageDraw.Draw(image)
        draw.ellipse([30, 30, 170, 170], fill=(0, 90, 180))
        draw.ellipse([65, 65, 135, 135], fill=(255, 255, 255))
        draw.polygon([(210, 40), (350, 40), (280, 165)], fill=(220, 40, 40))
        return image

    def test_a_flat_logo_traces_into_a_clean_set_of_shapes(self) -> None:
        result = vectorise(self._logo(), Settings(mode="flat_colour", colours=4))
        assert result.report["colours"] >= 2
        assert result.report["paths"] >= 3
        ElementTree.fromstring(  # noqa: S314 - SVG this test just generated, not input
            result.svg
        )

    def test_the_ring_keeps_its_hole(self) -> None:
        """The single most visible way this can go wrong."""
        result = vectorise(self._logo(), Settings(mode="flat_colour", colours=4))
        blue = next(
            shape
            for shape in result.shapes
            if shape.colour[2] > shape.colour[0] and shape.colour[2] > 120
        )
        assert len(blue.paths) >= 2, "the ring came back solid - its hole was lost"

    def test_the_svg_is_sized_in_the_original_pixels(self) -> None:
        image = self._logo()
        result = vectorise(image)
        assert (result.width, result.height) == image.size

    def test_line_art_finds_its_own_threshold(self) -> None:
        """A pale scan must not come back blank."""
        image = Image.new("RGB", (200, 200), (246, 242, 232))
        ImageDraw.Draw(image).ellipse([40, 40, 160, 160], outline=(90, 85, 80), width=4)
        result = vectorise(image, Settings(mode="line_art"))
        assert result.report["paths"] >= 1, "a pale drawing traced to nothing"

    def test_specks_are_dropped(self) -> None:
        """Scanner grain otherwise becomes thousands of real, cuttable specks."""
        image = Image.new("RGB", (120, 120), (255, 255, 255))
        draw = ImageDraw.Draw(image)
        draw.rectangle([20, 20, 100, 100], fill=(0, 0, 0))
        for offset in range(0, 120, 7):
            draw.point((offset, 5), fill=(0, 0, 0))

        noisy = vectorise(image, Settings(mode="line_art", despeckle=0))
        clean = vectorise(image, Settings(mode="line_art", despeckle=8))
        assert clean.report["paths"] < noisy.report["paths"]
        assert clean.report["specks_dropped"] > 0

    def test_a_photograph_is_reported_as_a_photograph(self) -> None:
        """Not a failure - but calling it vectorised artwork would be a lie."""
        image = Image.new("RGB", (200, 150))
        pixels = image.load()
        assert pixels is not None
        for y in range(150):
            for x in range(200):
                pixels[x, y] = (x % 256, (y * 2) % 256, (x + y) % 256)
        result = vectorise(image, Settings(mode="photographic", colours=16))
        assert "photograph" in result.report["suitability"]

    def test_a_very_large_image_is_traced_at_a_sane_size(self) -> None:
        """Downscaling to trace costs nothing: the output has no resolution."""
        image = Image.new("RGB", (3000, 2000), (255, 255, 255))
        ImageDraw.Draw(image).ellipse([200, 200, 2800, 1800], fill=(0, 0, 0))
        result = vectorise(image, Settings(mode="line_art"))
        assert result.report["downscaled_to_trace"] is True
        # The artwork is still described in the original coordinate system.
        assert (result.width, result.height) == (3000, 2000)
        assert result.report["traced_at"]["width"] < 3000
