"""Cleaning up a photograph of a page.

Built against the case that prompted it: a prescription slip photographed under
a lamp, warm across the page, darker toward one corner, with the bulb's own
reflection burning a hole in it.

The tests measure the page rather than eyeball it. "Looks cleaner" is not a
property; "the paper is neutral to within two levels and the lighting varies by
under ten percent" is.
"""

from __future__ import annotations

from typing import Any

import numpy
import pytest
from PIL import Image, ImageDraw

from ipw.processors.standard.document import clean_document


def photographed_page(
    *,
    warm: bool = True,
    uneven: bool = True,
    glare: bool = False,
    size: tuple[int, int] = (600, 850),
) -> tuple[Any, Any]:
    """A page of handwriting, then the room laid over it.

    Returns the photograph *and* a mask of where the ink is. Measuring the
    writing by percentile does not work: ink covers about one percent of a page,
    so a low percentile lands on shadowed paper instead - which is how the first
    version of this file "proved" that cleaning had erased the handwriting, when
    what had actually gone was the shadow.
    """
    width, height = size
    page = Image.new("RGB", (width, height), (255, 255, 255))
    draw = ImageDraw.Draw(page)
    for row in range(10):
        y = int(height * 0.12) + row * int(height * 0.07)
        draw.line(
            [(width * 0.13, y), (width * (0.4 + (row % 4) * 0.12), y)],
            fill=(38, 46, 128),
            width=max(2, height // 300),
        )

    pixels = numpy.asarray(page, dtype=numpy.float32)
    yy, xx = numpy.mgrid[0:height, 0:width].astype(numpy.float32)

    field = numpy.ones((height, width), numpy.float32)
    if uneven:
        field = 1.0 - 0.42 * (((xx / width) ** 1.4) + ((yy / height) ** 1.5)) / 2.0

    tint = numpy.stack(
        [
            numpy.full((height, width), 1.00, numpy.float32),
            numpy.full((height, width), 0.90 if warm else 1.0, numpy.float32),
            numpy.full((height, width), 0.74 if warm else 1.0, numpy.float32),
        ],
        axis=2,
    )

    lit = pixels * field[:, :, None] * tint
    if glare:
        hot = numpy.exp(
            -(
                ((xx - width * 0.7) ** 2 + (yy - height * 0.3) ** 2)
                / (2 * (min(width, height) * 0.09) ** 2)
            )
        )
        lit = lit + hot[:, :, None] * 200.0

    ink = numpy.asarray(page, dtype=numpy.float32).mean(axis=2) < 200
    return Image.fromarray(numpy.clip(lit, 0, 255).astype("uint8"), "RGB"), ink


def paper_channels(image: Any) -> list[float]:
    """What the paper reads as, per channel. The 92nd percentile is the page
    rather than the brightest speck."""
    array = numpy.asarray(image.convert("RGB"), dtype=numpy.float32)
    return [float(numpy.percentile(array[:, :, index], 92)) for index in range(3)]


class TestTheCastComesOut:
    def test_brown_paper_comes_back_neutral(self) -> None:
        """The complaint that started this: 'photo paper looking slightly brown'."""
        before = paper_channels(photographed_page()[0])
        cleaned, _ = clean_document(photographed_page()[0])
        after = paper_channels(cleaned)

        assert max(before) - min(before) > 30, "the fixture must have a cast to remove"
        assert max(after) - min(after) <= 6, f"paper is still tinted: {after}"

    def test_the_paper_ends_up_bright(self) -> None:
        cleaned, _ = clean_document(photographed_page()[0])

        assert min(paper_channels(cleaned)) >= 235

    def test_a_page_that_was_already_fine_is_left_alone(self) -> None:
        """Correction must not be damage applied to a good photograph."""
        good = photographed_page(warm=False, uneven=False)[0]
        cleaned, report = clean_document(good)

        before, after = paper_channels(good), paper_channels(cleaned)
        assert abs(min(after) - min(before)) < 12
        assert report.evenness_before < 12


class TestTheLightingFlattens:
    def test_uneven_light_is_evened_out(self) -> None:
        _, report = clean_document(photographed_page()[0])

        assert report.evenness_before > 25, "the fixture must be unevenly lit"
        assert report.evenness_after < 12, f"still uneven: {report.evenness_after}"

    def test_the_writing_survives_and_darkens_against_the_page(self) -> None:
        """A correction that whitened the paper by erasing the ink would pass
        every test above, so this one measures the ink where the ink is."""
        source, ink = photographed_page()
        cleaned, _ = clean_document(source)

        def separation(image: Any) -> float:
            lum = numpy.asarray(image.convert("RGB"), dtype=numpy.float32).mean(axis=2)
            return float(lum[~ink].mean() - lum[ink].mean())

        assert separation(source) > 40, "the fixture must have legible writing"
        assert separation(cleaned) >= separation(source), (
            "the page got cleaner by losing the handwriting"
        )

    def test_strength_scales_the_correction(self) -> None:
        source = photographed_page()[0]
        light, _ = clean_document(source, strength_percent=30)
        full, _ = clean_document(source, strength_percent=100)

        def spread(image: Any) -> float:
            channels = paper_channels(image)
            return max(channels) - min(channels)

        assert spread(source) > spread(light) > spread(full)

    def test_no_strength_changes_nothing_much(self) -> None:
        source = photographed_page()[0]
        untouched, _ = clean_document(source, strength_percent=0)

        assert paper_channels(untouched) == pytest.approx(paper_channels(source), abs=2)


class TestWhatCannotBeRecovered:
    def test_a_burnt_out_reflection_is_reported_not_invented(self) -> None:
        """Where every channel clipped, the ink was never recorded. Filling it
        with plausible paper would be inventing a document."""
        _, report = clean_document(photographed_page(glare=True)[0])

        assert report.clipped_percent > 0.5
        assert any("cannot be recovered" in warning for warning in report.warnings)

    def test_the_clipped_area_is_left_as_it_was(self) -> None:
        source = photographed_page(glare=True)[0]
        cleaned, _ = clean_document(source)

        before = numpy.asarray(source.convert("RGB"), dtype=numpy.float32)
        after = numpy.asarray(cleaned.convert("RGB"), dtype=numpy.float32)
        clipped = (before >= 250).all(axis=2)

        assert clipped.any()
        assert numpy.array_equal(after[clipped], before[clipped])


class TestOptions:
    def test_ink_colour_is_kept_by_default(self) -> None:
        """A blue pen stays blue. An archive may want otherwise, but that is a
        choice rather than a side effect."""
        cleaned, _ = clean_document(photographed_page()[0])
        array = numpy.asarray(cleaned.convert("RGB"), dtype=numpy.float32)
        dark = array.mean(axis=2) < 150

        assert dark.any()
        assert array[:, :, 2][dark].mean() > array[:, :, 0][dark].mean() + 10

    def test_turning_off_ink_colour_gives_a_neutral_page(self) -> None:
        cleaned, _ = clean_document(photographed_page()[0], keep_ink_colour=False)
        array = numpy.asarray(cleaned.convert("RGB"), dtype=numpy.float32)

        assert abs(float(array[:, :, 0].mean() - array[:, :, 2].mean())) < 1.5

    def test_not_whitening_keeps_the_page_at_its_own_level(self) -> None:
        cleaned, _ = clean_document(photographed_page()[0], whiten=False)

        assert min(paper_channels(cleaned)) < 245

    def test_the_report_is_json_safe(self) -> None:
        import json

        _, report = clean_document(photographed_page(glare=True)[0])
        json.dumps(report.as_record())
