"""Deterministic standard-processing baselines (POC-004).

Non-generative by decision D-009: these operations resize, crop, adjust, sharpen
and denoise. None of them reconstructs detail that was not in the source, and the
contract enforces that structurally - every operation declared here belongs to the
standard family.

Two engines behind one processor, so a Pillow-versus-libvips comparison measures
the engines rather than differences in plumbing (D-045).
"""

from __future__ import annotations

from ipw.processors.standard.engine import EngineError, EngineImage, ImageEngine, ResampleFilter
from ipw.processors.standard.pillow_engine import PillowEngine
from ipw.processors.standard.processor import (
    SUPPORTED_OPERATIONS,
    StandardProcessor,
    pillow_processor,
    vips_processor,
)
from ipw.processors.standard.vips_engine import VipsEngine
from ipw.processors.standard.vips_runtime import libvips_version, vips_available

__all__ = [
    "SUPPORTED_OPERATIONS",
    "EngineError",
    "EngineImage",
    "ImageEngine",
    "PillowEngine",
    "ResampleFilter",
    "StandardProcessor",
    "VipsEngine",
    "libvips_version",
    "pillow_processor",
    "vips_available",
    "vips_processor",
]
