"""Input inspection: signature detection, header parsing and safety classification.

POC-003. Parses headers only - no pixel buffer is ever allocated, so an oversized
or malicious image is refused before it can consume memory. Depends on nothing
outside the standard library and :mod:`ipw.contracts`.
"""

from __future__ import annotations

from ipw.processors.inspection.headers import (
    HeaderParseError,
    ImageHeader,
    SignatureKind,
    detect_signature,
    parse_header,
    parse_jpeg,
    parse_png,
)
from ipw.processors.inspection.inspector import inspect_input

__all__ = [
    "HeaderParseError",
    "ImageHeader",
    "SignatureKind",
    "detect_signature",
    "inspect_input",
    "parse_header",
    "parse_jpeg",
    "parse_png",
]
