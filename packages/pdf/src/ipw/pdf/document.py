"""Pages, content and the document builder.

The API the rest of the product uses. Everything measured in **points** (1/72
inch), because that is what PDF uses and converting at the boundary is better than
converting in twelve places.

Covers the drawing half of PRODUCT_REQUIREMENTS.md section 19: pages of any size
and orientation, images placed and rotated, text in the standard fonts, rectangles
and lines for backgrounds and shapes, and page numbers.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any

from ipw.pdf.images import EmbeddedImage, PlacedImage, effective_dpi, embed_image
from ipw.pdf.objects import Name, PdfWriter, Reference, Stream

__all__ = [
    "PAGE_SIZES",
    "Fit",
    "Orientation",
    "Page",
    "PageSize",
    "PdfDocument",
    "StandardFont",
    "TextBox",
    "text_width",
]

MM = 72.0 / 25.4
INCH = 72.0


@dataclass(frozen=True)
class PageSize:
    """A page in points, with the name a person would use for it."""

    label: str
    width: float
    height: float

    def oriented(self, orientation: Orientation) -> PageSize:
        wide = self.width > self.height
        want_wide = orientation is Orientation.LANDSCAPE
        if wide == want_wide:
            return self
        return PageSize(self.label, self.height, self.width)

    @property
    def inches(self) -> tuple[float, float]:
        return (self.width / INCH, self.height / INCH)


class Orientation(StrEnum):
    PORTRAIT = "portrait"
    LANDSCAPE = "landscape"


# ISO sizes are defined in millimetres and US sizes in inches, so each is written
# in its own units and converted. Rounding an A4 to "595 x 842" is close enough
# for a screen and visibly wrong on a trimmed print run.
PAGE_SIZES: dict[str, PageSize] = {
    "a5": PageSize("A5", 148 * MM, 210 * MM),
    "a4": PageSize("A4", 210 * MM, 297 * MM),
    "a3": PageSize("A3", 297 * MM, 420 * MM),
    "a2": PageSize("A2", 420 * MM, 594 * MM),
    "a1": PageSize("A1", 594 * MM, 841 * MM),
    "a0": PageSize("A0", 841 * MM, 1189 * MM),
    "letter": PageSize("Letter", 8.5 * INCH, 11 * INCH),
    "legal": PageSize("Legal", 8.5 * INCH, 14 * INCH),
    "tabloid": PageSize("Tabloid", 11 * INCH, 17 * INCH),
    "square": PageSize("Square", 8 * INCH, 8 * INCH),
}


class Fit(StrEnum):
    """How an image is fitted to the space it is given."""

    CONTAIN = "contain"
    """Whole image visible, empty space around it. Nothing is lost."""

    COVER = "cover"
    """Space filled, edges of the image cropped away."""

    STRETCH = "stretch"
    """Fills exactly, distorting the aspect ratio.

    Offered because occasionally it is genuinely wanted, and named plainly so
    nobody chooses it by accident.
    """


class StandardFont(StrEnum):
    """The 14 fonts every PDF reader must provide, so none needs embedding.

    Embedding a font means shipping its bytes, which means holding a licence that
    permits redistribution. These fourteen avoid the question entirely. Anything
    beyond them is a separate decision with its own review.
    """

    HELVETICA = "Helvetica"
    HELVETICA_BOLD = "Helvetica-Bold"
    HELVETICA_OBLIQUE = "Helvetica-Oblique"
    TIMES = "Times-Roman"
    TIMES_BOLD = "Times-Bold"
    TIMES_ITALIC = "Times-Italic"
    COURIER = "Courier"
    COURIER_BOLD = "Courier-Bold"


@dataclass
class TextBox:
    """A run of text placed on a page."""

    text: str
    x: float
    y: float
    size: float = 12.0
    font: StandardFont = StandardFont.HELVETICA
    colour: tuple[float, float, float] = (0.0, 0.0, 0.0)
    align: str = "left"
    max_width: float | None = None


@dataclass
class Rect:
    """A filled or stroked rectangle: backgrounds, panels, trim guides."""

    x: float
    y: float
    width: float
    height: float
    fill: tuple[float, float, float] | None = None
    stroke: tuple[float, float, float] | None = None
    line_width: float = 1.0


@dataclass
class Page:
    """One page and everything on it."""

    size: PageSize
    background: tuple[float, float, float] | None = None
    images: list[PlacedImage] = field(default_factory=list)
    texts: list[TextBox] = field(default_factory=list)
    rects: list[Rect] = field(default_factory=list)

    def place_image(
        self,
        image: EmbeddedImage,
        *,
        margin: float = 0.0,
        fit: Fit = Fit.CONTAIN,
        rotation: int = 0,
    ) -> PlacedImage:
        """Fit an image into the page, inside a margin."""
        area_w = self.size.width - 2 * margin
        area_h = self.size.height - 2 * margin
        if area_w <= 0 or area_h <= 0:
            msg = f"a margin of {margin}pt leaves no room on a {self.size.label} page"
            raise ValueError(msg)

        ratio = image.width / image.height
        if fit is Fit.STRETCH:
            width, height = area_w, area_h
        else:
            by_width = (area_w, area_w / ratio)
            by_height = (area_h * ratio, area_h)
            fits = by_width[1] <= area_h
            width, height = by_width if (fits if fit is Fit.CONTAIN else not fits) else by_height

        placed = PlacedImage(
            image=image,
            x=margin + (area_w - width) / 2,
            y=margin + (area_h - height) / 2,
            width=width,
            height=height,
            rotation=rotation,
        )
        self.images.append(placed)
        return placed

    def dpi_of_images(self) -> list[int]:
        return [effective_dpi(p.image, p.width, p.height) for p in self.images]


class PdfDocument:
    """Builds a PDF from pages.

    Held in memory until ``render``. A document of a few dozen pages is a few
    dozen megabytes at worst, and streaming would trade that for the ability to
    reorder pages - which section 19 requires - so the trade goes the other way.
    """

    def __init__(self, title: str = "", author: str = "") -> None:
        self.pages: list[Page] = []
        self.title = title
        self.author = author
        self._images: dict[int, EmbeddedImage] = {}

    # ------------------------------------------------------------- authoring --

    def add_page(
        self,
        size: str | PageSize = "a4",
        orientation: Orientation = Orientation.PORTRAIT,
        background: tuple[float, float, float] | None = None,
    ) -> Page:
        resolved = PAGE_SIZES[size] if isinstance(size, str) else size
        page = Page(size=resolved.oriented(orientation), background=background)
        self.pages.append(page)
        return page

    def add_image_page(
        self,
        path: Path,
        *,
        size: str | PageSize | None = None,
        orientation: Orientation | None = None,
        margin: float = 0.0,
        fit: Fit = Fit.CONTAIN,
    ) -> Page:
        """Add a page holding one image.

        With no page size given, the page is made to match the image's own aspect
        ratio at its natural size. That is the right default for a design sheet:
        forcing a square print onto A4 adds white bands nobody asked for, and the
        product's own corpus is mostly square and 4:3 artwork rather than
        document-shaped pages.
        """
        image = embed_image(path)
        self._images[id(image)] = image

        if size is None:
            width = image.width * 72.0 / 96.0
            height = image.height * 72.0 / 96.0
            page_size = PageSize("Custom", width + 2 * margin, height + 2 * margin)
            page = Page(size=page_size)
            self.pages.append(page)
        else:
            chosen = PAGE_SIZES[size] if isinstance(size, str) else size
            if orientation is None:
                orientation = (
                    Orientation.LANDSCAPE if image.width > image.height else Orientation.PORTRAIT
                )
            page = self.add_page(chosen, orientation)

        page.place_image(image, margin=margin, fit=fit)
        return page

    def move_page(self, index: int, to: int) -> None:
        self.pages.insert(to, self.pages.pop(index))

    def duplicate_page(self, index: int) -> Page:
        import copy

        page = copy.deepcopy(self.pages[index])
        self.pages.insert(index + 1, page)
        return page

    def delete_page(self, index: int) -> None:
        self.pages.pop(index)

    def add_page_numbers(
        self,
        *,
        font: StandardFont = StandardFont.HELVETICA,
        size: float = 9.0,
        margin: float = 24.0,
        start_at: int = 1,
        skip_first: bool = False,
    ) -> None:
        for index, page in enumerate(self.pages):
            if skip_first and index == 0:
                continue
            page.texts.append(
                TextBox(
                    text=str(index + start_at),
                    x=page.size.width / 2,
                    y=margin,
                    size=size,
                    font=font,
                    colour=(0.4, 0.4, 0.4),
                    align="center",
                )
            )

    # --------------------------------------------------------------- rendering --

    def _content(self, page: Page, names: dict[int, str]) -> bytes:
        """The page's drawing operators, in painting order."""
        out = bytearray()

        if page.background:
            r, g, b = page.background
            out += (
                f"q {r:.4f} {g:.4f} {b:.4f} rg 0 0 {page.size.width:.2f} "
                f"{page.size.height:.2f} re f Q\n".encode("ascii")
            )

        for rect in page.rects:
            out += b"q\n"
            if rect.fill:
                r, g, b = rect.fill
                out += f"{r:.4f} {g:.4f} {b:.4f} rg\n".encode("ascii")
            if rect.stroke:
                r, g, b = rect.stroke
                out += f"{r:.4f} {g:.4f} {b:.4f} RG {rect.line_width:.2f} w\n".encode("ascii")
            out += f"{rect.x:.2f} {rect.y:.2f} {rect.width:.2f} {rect.height:.2f} re\n".encode(
                "ascii"
            )
            painter = b"B" if (rect.fill and rect.stroke) else (b"f" if rect.fill else b"S")
            out += painter + b"\nQ\n"

        for placed in page.images:
            name = names[id(placed.image)]
            out += b"q\n"
            # The image operator draws into a 1x1 unit square, so the matrix is
            # the placement: scale to size, then translate. Rotation composes on
            # top, about the centre so the image does not walk off the page.
            if placed.rotation % 360:
                import math

                angle = math.radians(placed.rotation % 360)
                cos, sin = math.cos(angle), math.sin(angle)
                cx = placed.x + placed.width / 2
                cy = placed.y + placed.height / 2
                out += f"1 0 0 1 {cx:.2f} {cy:.2f} cm\n".encode("ascii")
                out += f"{cos:.6f} {sin:.6f} {-sin:.6f} {cos:.6f} 0 0 cm\n".encode("ascii")
                out += f"1 0 0 1 {-placed.width / 2:.2f} {-placed.height / 2:.2f} cm\n".encode(
                    "ascii"
                )
                out += f"{placed.width:.2f} 0 0 {placed.height:.2f} 0 0 cm\n".encode("ascii")
            else:
                out += (
                    f"{placed.width:.2f} 0 0 {placed.height:.2f} {placed.x:.2f} {placed.y:.2f} cm\n"
                ).encode("ascii")
            out += f"/{name} Do\nQ\n".encode("ascii")

        for text in page.texts:
            from ipw.pdf.objects import serialise

            r, g, b = text.colour
            x = text.x
            if text.align in ("center", "right"):
                estimated = text_width(text.text, text.size, text.font)
                x -= estimated / 2 if text.align == "center" else estimated
            out += b"BT\n"
            out += f"/{_font_key(text.font)} {text.size:.2f} Tf\n".encode("ascii")
            out += f"{r:.4f} {g:.4f} {b:.4f} rg\n".encode("ascii")
            out += f"1 0 0 1 {x:.2f} {text.y:.2f} Tm\n".encode("ascii")
            out += serialise(text.text) + b" Tj\n"
            out += b"ET\n"

        return bytes(out)

    def render(self) -> bytes:
        """Produce the PDF."""
        if not self.pages:
            msg = "a PDF needs at least one page"
            raise ValueError(msg)

        writer = PdfWriter()
        catalog = writer.reserve()
        pages_node = writer.reserve()

        # Every distinct image becomes one XObject however many times it is
        # placed, so a repeated logo is stored once.
        image_refs: dict[int, Reference] = {}
        names: dict[int, str] = {}
        for page in self.pages:
            for placed in page.images:
                key = id(placed.image)
                if key in image_refs:
                    continue
                names[key] = f"Im{len(image_refs)}"
                stream = placed.image.stream
                if placed.image.smask is not None:
                    smask_ref = writer.add(placed.image.smask)
                    stream = Stream(
                        {**stream.dictionary, "SMask": smask_ref},
                        stream.data,
                        compress=stream.compress,
                        filters=stream.filters,
                    )
                image_refs[key] = writer.add(stream)

        fonts_used: set[StandardFont] = {t.font for page in self.pages for t in page.texts}
        font_refs = {
            font: writer.add(
                {
                    "Type": Name("Font"),
                    "Subtype": Name("Type1"),
                    "BaseFont": Name(font.value),
                    "Encoding": Name("WinAnsiEncoding"),
                }
            )
            for font in fonts_used
        }

        page_refs: list[Reference] = []
        for page in self.pages:
            content = writer.add(Stream({}, self._content(page, names)))
            resources: dict[str, Any] = {}
            used = {id(p.image) for p in page.images}
            if used:
                resources["XObject"] = {names[k]: image_refs[k] for k in used}
            page_fonts = {t.font for t in page.texts}
            if page_fonts:
                resources["Font"] = {_font_key(f): font_refs[f] for f in page_fonts}

            page_refs.append(
                writer.add(
                    {
                        "Type": Name("Page"),
                        "Parent": pages_node,
                        "MediaBox": [0, 0, round(page.size.width, 4), round(page.size.height, 4)],
                        "Resources": resources,
                        "Contents": content,
                    }
                )
            )

        writer.put(
            pages_node,
            {"Type": Name("Pages"), "Kids": page_refs, "Count": len(page_refs)},
        )
        writer.put(catalog, {"Type": Name("Catalog"), "Pages": pages_node})

        info: dict[str, Any] = {"Producer": "Image & PDF Workspace"}
        if self.title:
            info["Title"] = self.title
        if self.author:
            info["Author"] = self.author
        return writer.build(catalog, info)


def _font_key(font: StandardFont) -> str:
    return "F" + font.value.replace("-", "")


# Average glyph widths as a fraction of point size, used only to centre and
# right-align text. Real metrics live in the font's AFM tables; carrying those
# for fourteen fonts to place a page number would be a poor trade, and the error
# on a short run is under a couple of points.
_WIDTH_FACTOR = {
    StandardFont.COURIER: 0.600,
    StandardFont.COURIER_BOLD: 0.600,
    StandardFont.TIMES: 0.480,
    StandardFont.TIMES_BOLD: 0.500,
    StandardFont.TIMES_ITALIC: 0.480,
}


def text_width(text: str, size: float, font: StandardFont) -> float:
    """An estimate, and named as one wherever it is used."""
    return len(text) * size * _WIDTH_FACTOR.get(font, 0.520)
