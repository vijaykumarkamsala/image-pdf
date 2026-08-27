"""Enlarging, judged against ground truth rather than against an opinion.

The method: take a known image, shrink it, enlarge it back, and score the
result against the original. We know exactly what the answer should have been,
so "is this better than a plain resize" has a number rather than a view.

The fixtures matter as much as the method. Upscaling is easy on a blur and hard
on structure, and the structure this product meets is woven cloth, printed text
and photographs - so those are what it is measured on.
"""

from __future__ import annotations

from typing import Any

import pytest
from PIL import Image, ImageDraw, ImageFilter

from ipw.metrics.reference import psnr, ssim
from ipw.processors.standard.upscale import MATERIALS, upscale


def woven(size: int = 320) -> Any:
    """A twill weave: fine repeating structure, the hardest case to enlarge and
    the one that decides whether this is usable for printing on cloth."""
    image = Image.new("RGB", (size, size), (196, 178, 152))
    draw = ImageDraw.Draw(image)
    for offset in range(-size, size * 2, 6):
        draw.line([(offset, 0), (offset + size, size)], fill=(150, 128, 100), width=2)
    for offset in range(-size, size * 2, 9):
        draw.line([(offset, size), (offset + size, 0)], fill=(214, 200, 176), width=1)
    return image.filter(ImageFilter.GaussianBlur(0.4))


def printed(size: int = 320) -> Any:
    image = Image.new("RGB", (size, size), (250, 249, 246))
    draw = ImageDraw.Draw(image)
    y = 20
    for row in range(11):
        for x in range(16, size - 30, 7):
            if (x + row * 13) % 29 > 6:
                draw.rectangle([x, y, x + 3, y + 8], fill=(28, 28, 34))
        y += 27
    return image


def photograph(size: int = 320) -> Any:
    image = Image.new("RGB", (size, size))
    draw = ImageDraw.Draw(image)
    # A sky, drawn as bands rather than per pixel: `Image.load()` is typed as
    # possibly None, and one row at a time is both faster and honest about it.
    for y in range(size):
        draw.line(
            [(0, y), (size, y)],
            fill=(
                int(70 + 120 * (y / size)),
                int(110 + 90 * (y / size)),
                int(180 - 40 * (y / size)),
            ),
        )
    draw.rectangle([40, 160, 135, 310], fill=(64, 58, 54))
    draw.ellipse([230, 25, 285, 80], fill=(252, 246, 214))
    return image.filter(ImageFilter.GaussianBlur(0.3))


def halved(truth: Any) -> Any:
    return truth.resize((truth.width // 2, truth.height // 2), Image.Resampling.LANCZOS)


def plain_resize(small: Any, truth: Any) -> Any:
    return small.resize(truth.size, Image.Resampling.LANCZOS)


class TestItBeatsAPlainResize:
    """The whole claim of the feature, on each kind of material it will meet."""

    @pytest.mark.parametrize(
        ("name", "build", "material"),
        [
            ("woven cloth", woven, "texture"),
            ("printed text", printed, "text"),
            ("photograph", photograph, "photo"),
        ],
    )
    def test_it_scores_better_than_lanczos(self, name: str, build: Any, material: str) -> None:
        truth = build()
        small = halved(truth)

        baseline = psnr(truth, plain_resize(small, truth)).value
        result, _ = upscale(small, 2, material=material)
        scored = psnr(truth, result).value

        assert scored > baseline, (
            f"{name}: {scored:.2f} dB against {baseline:.2f} dB for a plain resize"
        )

    @pytest.mark.parametrize(
        ("build", "material"),
        [(woven, "texture"), (printed, "text"), (photograph, "photo")],
    )
    def test_structure_is_better_too(self, build: Any, material: str) -> None:
        """PSNR can be flattered by blurring. SSIM asks whether the structure
        survived, which is the question a printer actually cares about."""
        truth = build()
        small = halved(truth)

        baseline = ssim(truth, plain_resize(small, truth)).value
        result, _ = upscale(small, 2, material=material)

        assert ssim(truth, result).value > baseline


class TestTheMaterialMatters:
    def test_sharpening_ruins_a_weave(self) -> None:
        """The measurement behind asking the question at all: an unsharp mask
        cannot tell a thread from an edge, and adds contrast to every one."""
        truth = woven()
        small = halved(truth)

        as_texture, _ = upscale(small, 2, material="texture")
        as_photo, _ = upscale(small, 2, material="photo")

        assert psnr(truth, as_texture).value > psnr(truth, as_photo).value

    def test_sharpening_helps_text(self) -> None:
        truth = printed()
        small = halved(truth)

        as_text, _ = upscale(small, 2, material="text")
        as_texture, _ = upscale(small, 2, material="texture")

        assert psnr(truth, as_text).value > psnr(truth, as_texture).value

    def test_an_unknown_material_is_refused_by_name(self) -> None:
        with pytest.raises(ValueError, match="not a material"):
            upscale(photograph(), 2, material="cloth")

    def test_every_material_is_offered_by_the_contract(self) -> None:
        """The contract and the algorithm must agree on the list, or a request
        the API accepts is refused deep inside the engine."""
        from ipw.contracts.operation import EnlargeSettings

        allowed = EnlargeSettings.model_fields["material"].annotation
        assert set(getattr(allowed, "__args__", ())) == set(MATERIALS)


class TestTheLoopConverges:
    def test_more_passes_remove_more_error(self) -> None:
        truth = photograph()
        small = halved(truth)

        _, one = upscale(small, 2, iterations=1, material="photo")
        _, three = upscale(small, 2, iterations=3, material="photo")

        assert three.residual_after < one.residual_after
        assert three.improvement_percent > one.improvement_percent

    def test_no_passes_is_just_a_resize(self) -> None:
        small = halved(photograph())

        _, report = upscale(small, 2, iterations=0, material="texture")

        assert report.residual_after == pytest.approx(report.residual_before)
        assert report.improvement_percent == pytest.approx(0.0, abs=0.01)

    def test_the_report_says_how_much_was_recovered(self) -> None:
        _, report = upscale(halved(photograph()), 2, material="photo")

        assert 0 < report.improvement_percent <= 100
        assert report.residual_after < report.residual_before

    def test_scale_one_changes_nothing(self) -> None:
        source = photograph()
        result, report = upscale(source, 1)

        assert result.size == source.size
        assert report.iterations == 0

    def test_the_size_is_exactly_the_scale(self) -> None:
        source = photograph(size=100)

        for scale in (2, 3):
            result, _ = upscale(source, scale, iterations=1)
            assert result.size == (100 * scale, 100 * scale)

    def test_a_scale_below_one_is_refused(self) -> None:
        with pytest.raises(ValueError, match="scale must be at least 1"):
            upscale(photograph(), 0)

    def test_the_report_is_json_safe(self) -> None:
        import json

        _, report = upscale(halved(photograph()), 2)
        json.dumps(report.as_record())
