"""Quality metrics for the benchmark.

Metrics rank; they do not judge (D-011). Every value produced here is an input to
the blinded human review in POC-008, never a substitute for it - a sharper but
invented face scores attractively and is still unacceptable.
"""

from __future__ import annotations

from ipw.metrics.reference import (
    GAUSSIAN_SIGMA,
    GAUSSIAN_WINDOW,
    SSIM_VARIANT,
    MetricValue,
    psnr,
    score_pair,
    ssim,
)

__all__ = [
    "GAUSSIAN_SIGMA",
    "GAUSSIAN_WINDOW",
    "SSIM_VARIANT",
    "MetricValue",
    "psnr",
    "score_pair",
    "ssim",
]
