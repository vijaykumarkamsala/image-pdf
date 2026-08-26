"""Raster to vector: tracing pictures into shapes that have no resolution.

See ``vectorise.py`` for why this matters to a sign-writer, a laser cutter, an
embroiderer, a screen printer, a machinist and a marketing team alike, and for
what it honestly cannot do to a photograph.
"""

from ipw.vector.palette import Layer, otsu, separate
from ipw.vector.render import Shape, to_pdf_operators, to_svg
from ipw.vector.simplify import Segment, fit_path, simplify
from ipw.vector.trace import Loop, area, trace_mask
from ipw.vector.vectorise import MAX_TRACE_PIXELS, Settings, VectorResult, vectorise

__all__ = [
    "MAX_TRACE_PIXELS",
    "Layer",
    "Loop",
    "Segment",
    "Settings",
    "Shape",
    "VectorResult",
    "area",
    "fit_path",
    "otsu",
    "separate",
    "simplify",
    "to_pdf_operators",
    "to_svg",
    "trace_mask",
    "vectorise",
]
