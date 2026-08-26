"""Full-reference image quality metrics: PSNR and SSIM.

**Read this before reading a number produced here.**

These metrics answer one question - *how close is this image to that image* - and
the benchmark asks a different one: *which output is better*. They are not the
same question, and the gap between them is the reason D-011 exists.

A super-resolution model that invents a plausible eyelash scores worse against the
ground truth than a blurry one that invents nothing, because the invented detail
is in the wrong place. Every GAN-based model, Real-ESRGAN and SwinIR's realSR
weights included, is trained to be *perceptually* convincing rather than
numerically close, and reliably loses on PSNR to a model nobody would ship. That
is a known property of the metric, not a finding about the model.

So: these values rank, they do not judge. They are inputs to the blinded human
review in POC-008. Anything here that reads like a verdict is being misread.

**Implementation notes.**

PSNR is exactly defined and has no variants worth arguing about. SSIM does have
variants, and the one implemented here is the original: Wang et al. (2004), an
11x11 Gaussian window with sigma 1.5, computed on each channel and averaged, with
``C1 = (0.01 * L)^2`` and ``C2 = (0.03 * L)^2`` for ``L = 255``. It is stated
because "SSIM" alone does not identify a number - a uniform-window implementation
gives a visibly different value for the same pair, and comparing across
implementations is how a benchmark quietly stops meaning anything.

Values are floats and must never reach an identity digest. ``canonical.py``
rejects floats outright, which enforces that at the type level rather than by
convention.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy

__all__ = [
    "GAUSSIAN_SIGMA",
    "GAUSSIAN_WINDOW",
    "SSIM_VARIANT",
    "MetricValue",
    "psnr",
    "score_pair",
    "ssim",
]

GAUSSIAN_WINDOW = 11
GAUSSIAN_SIGMA = 1.5
SSIM_VARIANT = "wang2004-gaussian-11x11-sigma1.5-per-channel-mean"
"""Names the exact SSIM being reported. "SSIM" on its own does not identify a
number, and a report that does not say which variant it used cannot be compared
against anything."""


@dataclass(frozen=True)
class MetricValue:
    """One observation. Never identity - see the module docstring."""

    metric: str
    value: float
    higher_is_better: bool
    variant: str = ""
    note: str = ""

    def rounded(self, places: int = 4) -> float:
        return round(self.value, places)


def _as_float_array(image: object) -> numpy.ndarray:
    """Accept a PIL image or an array; return float64 HxWxC in 0..255."""
    array = numpy.asarray(image, dtype=numpy.float64)
    if array.ndim == 2:
        array = array[:, :, numpy.newaxis]
    if array.ndim != 3:
        msg = f"expected a 2D or 3D image, got shape {array.shape}"
        raise ValueError(msg)
    return array


def _check_pair(a: numpy.ndarray, b: numpy.ndarray) -> None:
    if a.shape != b.shape:
        msg = (
            f"images must have identical shapes to be compared: {a.shape} vs {b.shape}. "
            "Resizing one to match the other would measure the resize, not the model."
        )
        raise ValueError(msg)


def psnr(image: object, reference: object, data_range: float = 255.0) -> MetricValue:
    """Peak signal-to-noise ratio in decibels. Higher is closer to the reference.

    Identical images give infinity rather than a large finite number. Returning a
    capped value would be a quiet lie, and callers that cannot render infinity
    should say "identical" instead of printing a number.
    """
    a, b = _as_float_array(image), _as_float_array(reference)
    _check_pair(a, b)

    mse = float(numpy.mean((a - b) ** 2))
    if mse == 0.0:
        return MetricValue(
            metric="psnr",
            value=math.inf,
            higher_is_better=True,
            note="identical to the reference",
        )
    return MetricValue(
        metric="psnr",
        value=10.0 * math.log10((data_range**2) / mse),
        higher_is_better=True,
    )


def _gaussian_kernel(size: int = GAUSSIAN_WINDOW, sigma: float = GAUSSIAN_SIGMA) -> numpy.ndarray:
    offsets = numpy.arange(size, dtype=numpy.float64) - (size - 1) / 2.0
    kernel = numpy.exp(-(offsets**2) / (2.0 * sigma**2))
    return kernel / kernel.sum()


def _filter_valid(plane: numpy.ndarray, kernel: numpy.ndarray) -> numpy.ndarray:
    """Separable Gaussian filter, 'valid' region only.

    Separable because a 2D Gaussian is the outer product of two 1D ones: two
    passes of O(n) instead of one of O(n^2), and identical results.
    """
    rows = numpy.apply_along_axis(lambda row: numpy.convolve(row, kernel, mode="valid"), 1, plane)
    return numpy.apply_along_axis(lambda col: numpy.convolve(col, kernel, mode="valid"), 0, rows)


def ssim(image: object, reference: object, data_range: float = 255.0) -> MetricValue:
    """Structural similarity, Wang et al. (2004). 1.0 means identical.

    Computed per channel and averaged, on the 'valid' region: the window needs
    real neighbours, and padding the border would invent them and then measure the
    invention.
    """
    a, b = _as_float_array(image), _as_float_array(reference)
    _check_pair(a, b)

    height, width, channels = a.shape
    if min(height, width) < GAUSSIAN_WINDOW:
        msg = (
            f"SSIM needs at least {GAUSSIAN_WINDOW}x{GAUSSIAN_WINDOW} pixels; got "
            f"{height}x{width}. A smaller image has no valid window position."
        )
        raise ValueError(msg)

    kernel = _gaussian_kernel()
    c1 = (0.01 * data_range) ** 2
    c2 = (0.03 * data_range) ** 2

    per_channel: list[float] = []
    for channel in range(channels):
        x, y = a[:, :, channel], b[:, :, channel]

        mu_x = _filter_valid(x, kernel)
        mu_y = _filter_valid(y, kernel)
        mu_xx, mu_yy, mu_xy = mu_x * mu_x, mu_y * mu_y, mu_x * mu_y

        # E[x^2] - E[x]^2, with the same window, is the local variance.
        sigma_xx = _filter_valid(x * x, kernel) - mu_xx
        sigma_yy = _filter_valid(y * y, kernel) - mu_yy
        sigma_xy = _filter_valid(x * y, kernel) - mu_xy

        numerator = (2 * mu_xy + c1) * (2 * sigma_xy + c2)
        denominator = (mu_xx + mu_yy + c1) * (sigma_xx + sigma_yy + c2)
        per_channel.append(float(numpy.mean(numerator / denominator)))

    return MetricValue(
        metric="ssim",
        value=float(numpy.mean(per_channel)),
        higher_is_better=True,
        variant=SSIM_VARIANT,
    )


def score_pair(image: object, reference: object) -> tuple[MetricValue, ...]:
    """Both metrics against one reference, for callers that want the usual pair."""
    return (psnr(image, reference), ssim(image, reference))
