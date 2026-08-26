"""PSNR and SSIM (POC-007).

These are measuring instruments for the benchmark, so they are tested against
properties that must hold rather than against numbers copied from somewhere. A
metric that silently disagrees with its own definition would corrupt every
comparison downstream while looking perfectly healthy.
"""

from __future__ import annotations

import math
from typing import Any

import numpy
import pytest

from ipw.metrics import GAUSSIAN_SIGMA, GAUSSIAN_WINDOW, SSIM_VARIANT, psnr, score_pair, ssim
from ipw.metrics.reference import _gaussian_kernel


# Annotated `Any` rather than `numpy.ndarray`. numpy's stubs are skipped by mypy
# (they use 3.12+ syntax and this project checks at its 3.11 floor), so an ndarray
# annotation resolves to Any anyway and only trips disallow_any_unimported. Saying
# Any outright is the same information without the noise.
@pytest.fixture
def image() -> Any:
    """A deterministic textured image. Not random: a fixture that changes between
    runs turns a metric regression into an intermittent one."""
    y, x = numpy.mgrid[0:48, 0:48]
    base = ((x * 5 + y * 3) % 256).astype(numpy.float64)
    texture = (((x // 4 + y // 4) % 2) * 40).astype(numpy.float64)
    plane = numpy.clip(base + texture, 0, 255)
    return numpy.stack([plane, numpy.roll(plane, 7, axis=1), numpy.roll(plane, 3, axis=0)], axis=2)


class TestIdentity:
    def test_psnr_of_identical_images_is_infinite(self, image: Any) -> None:
        """Not a large finite number. A cap would be a quiet lie."""
        result = psnr(image, image)
        assert result.value == math.inf
        assert "identical" in result.note

    def test_ssim_of_identical_images_is_one(self, image: Any) -> None:
        assert ssim(image, image).value == pytest.approx(1.0, abs=1e-12)

    def test_both_metrics_are_symmetric(self, image: Any) -> None:
        other = numpy.clip(image + 12.0, 0, 255)
        assert psnr(image, other).value == pytest.approx(psnr(other, image).value)
        assert ssim(image, other).value == pytest.approx(ssim(other, image).value)


class TestMonotonicity:
    """More corruption must score worse. If it does not, the metric is not one."""

    def test_psnr_falls_as_noise_grows(self, image: Any) -> None:
        rng = numpy.random.default_rng(11)
        scores = [
            psnr(numpy.clip(image + rng.normal(0, sigma, image.shape), 0, 255), image).value
            for sigma in (1, 5, 15, 40)
        ]
        assert scores == sorted(scores, reverse=True), scores

    def test_ssim_falls_as_noise_grows(self, image: Any) -> None:
        rng = numpy.random.default_rng(11)
        scores = [
            ssim(numpy.clip(image + rng.normal(0, sigma, image.shape), 0, 255), image).value
            for sigma in (1, 5, 15, 40)
        ]
        assert scores == sorted(scores, reverse=True), scores

    def test_a_flat_image_scores_far_worse_than_a_noisy_one(self, image: Any) -> None:
        """SSIM is structural: losing all structure must cost more than noise."""
        rng = numpy.random.default_rng(3)
        noisy = numpy.clip(image + rng.normal(0, 10, image.shape), 0, 255)
        flat = numpy.full_like(image, image.mean())
        assert ssim(flat, image).value < ssim(noisy, image).value

    def test_psnr_matches_its_definition(self, image: Any) -> None:
        """Computed independently from the formula, not from the implementation."""
        other = numpy.clip(image + 9.0, 0, 255)
        mse = float(numpy.mean((image - other) ** 2))
        expected = 10.0 * math.log10((255.0**2) / mse)
        assert psnr(other, image).value == pytest.approx(expected)


class TestVariantIsDeclared:
    def test_the_ssim_variant_is_named(self, image: Any) -> None:
        """ "SSIM" alone does not identify a number, so the report must say which."""
        assert ssim(image, image).variant == SSIM_VARIANT
        assert "11x11" in SSIM_VARIANT
        assert "1.5" in SSIM_VARIANT

    def test_the_gaussian_kernel_is_normalised_and_symmetric(self) -> None:
        kernel = _gaussian_kernel()
        assert len(kernel) == GAUSSIAN_WINDOW
        assert kernel.sum() == pytest.approx(1.0)
        assert numpy.allclose(kernel, kernel[::-1])
        # sigma 1.5 over 11 taps: the centre weight is the analytic value.
        centre = 1.0 / (GAUSSIAN_SIGMA * math.sqrt(2 * math.pi))
        assert kernel[GAUSSIAN_WINDOW // 2] == pytest.approx(centre, rel=0.02)


class TestRefusals:
    def test_mismatched_shapes_are_refused(self, image: Any) -> None:
        """Resizing to compare would measure the resize."""
        smaller = image[:24, :24, :]
        with pytest.raises(ValueError, match="identical shapes"):
            psnr(smaller, image)
        with pytest.raises(ValueError, match="identical shapes"):
            ssim(smaller, image)

    def test_an_image_smaller_than_the_window_is_refused(self) -> None:
        tiny = numpy.zeros((8, 8, 3))
        with pytest.raises(ValueError, match="valid window position"):
            ssim(tiny, tiny)

    def test_score_pair_returns_both(self, image: Any) -> None:
        names = {score.metric for score in score_pair(image, image)}
        assert names == {"psnr", "ssim"}


class TestGrayscaleAndPil:
    def test_a_two_dimensional_image_is_accepted(self) -> None:
        plane = numpy.tile(numpy.arange(32, dtype=numpy.float64), (32, 1))
        assert ssim(plane, plane).value == pytest.approx(1.0, abs=1e-12)

    def test_a_pil_image_is_accepted(self, image: Any) -> None:
        from PIL import Image

        rendered = Image.fromarray(image.astype(numpy.uint8), mode="RGB")
        assert ssim(rendered, rendered).value == pytest.approx(1.0, abs=1e-12)
        assert psnr(rendered, rendered).value == math.inf


class TestValuesNeverBecomeIdentity:
    def test_the_canonicaliser_rejects_a_metric_value(self, image: Any) -> None:
        """D-011 and the determinism rules, enforced at the type level.

        Metric values are floats and vary between platforms. If one reached an
        identity digest, two runs of identical work would stop comparing equal.
        The canonicaliser refuses floats outright, so this cannot happen by
        oversight - it would have to be deliberate.
        """
        from ipw.benchmark_runner.canonical import CanonicalisationError, canonical_json

        score = ssim(image, image)
        with pytest.raises(CanonicalisationError):
            canonical_json({"ssim": score.value})
