"""PDF authoring for the Image & PDF Workspace.

Standard library only. See ``objects.py`` for why a PDF engine exists here rather
than a dependency - the short version is that Pillow's PDF export was tested and
cannot draw text, shapes or CMYK, all of which PRODUCT_REQUIREMENTS.md section 19
requires.

The rule that matters most: a JPEG is embedded byte-for-byte, never re-encoded.
"""

from __future__ import annotations

from ipw.pdf.document import (
    PAGE_SIZES,
    Fit,
    Orientation,
    Page,
    PageSize,
    PdfDocument,
    Rect,
    StandardFont,
    TextBox,
    text_width,
)
from ipw.pdf.images import EmbeddedImage, PlacedImage, effective_dpi, embed_image

__all__ = [
    "PAGE_SIZES",
    "EmbeddedImage",
    "Fit",
    "Orientation",
    "Page",
    "PageSize",
    "PdfDocument",
    "PlacedImage",
    "Rect",
    "StandardFont",
    "TextBox",
    "effective_dpi",
    "embed_image",
    "text_width",
]
