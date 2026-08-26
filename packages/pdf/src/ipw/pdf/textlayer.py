"""Making a scanned page searchable without changing how it looks.

A scan is a picture of words. Nothing can search it, select from it, copy out of
it, or redact a name in it, because as far as every piece of software is
concerned the page is one photograph. The fix is a *text layer*: the recognised
words, written into the content stream in invisible render mode, positioned
exactly over the pixels they came from.

**This is the half of OCR that decides whether the result is any good, and it is
not the recognition.** An engine returns words and boxes; every engine returns
words and boxes. What makes the difference to a person is whether selecting a
line highlights that line, whether searching lands the viewport in the right
place, and whether a redaction driven by a phrase covers the right pixels. All of
that is geometry, and all of it happens here.

So the text is not merely dropped near the right place. Each word is scaled
horizontally - `Tz` - so its invisible glyphs span exactly the width the engine
measured, and sized so they sit on the same baseline. Selection then matches the
ink.

**Nothing here recognises anything.** The engine is an argument, so the licence
question it raises stays a separate decision from the code that uses it, and a
test can drive this with hand-written words and no engine at all.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from ipw.pdf.document import StandardFont
from ipw.pdf.edit import _GraphCopier, _page_body
from ipw.pdf.objects import Name, PdfWriter, Reference, Stream
from ipw.pdf.reader import PdfReader

__all__ = ["OcrEngine", "Word", "add_text_layer", "coverage"]


@dataclass(frozen=True)
class Word:
    """One recognised word and where it sits, in PDF points from bottom-left."""

    text: str
    left: float
    bottom: float
    right: float
    top: float
    confidence: float = 1.0

    @property
    def width(self) -> float:
        return abs(self.right - self.left)

    @property
    def height(self) -> float:
        return abs(self.top - self.bottom)


class OcrEngine(Protocol):
    """What any recogniser has to provide, and nothing more.

    Deliberately narrow. Every candidate engine - Tesseract, PaddleOCR, docTR,
    a cloud service - can satisfy this, which keeps the choice of engine a
    licence and accuracy decision rather than an architectural one. It also
    means the text-layer code below is testable with a fake that returns fixed
    words, so the geometry can be verified without installing anything.
    """

    def read(self, image: Any, *, page_height: float, page_width: float) -> list[Word]:
        """Recognise words in a page image, in PDF points."""
        ...


# Text render mode 3: fill nothing, stroke nothing, clip nothing. The glyphs are
# laid out and measured exactly as if drawn, and no marks reach the page - which
# is what makes the layer searchable and invisible at the same time.
INVISIBLE = 3

# Every glyph in the OCR font is declared this wide, in thousandths of an em.
OCR_GLYPH_WIDTH = 500

# How much text a page needs before it counts as searchable.
#
# A scanned page is rarely blank in the file: producers stamp a page number, a
# Bates number or a footer over the image. Counting those would report a bundle
# of scans as fully searchable and quietly skip the recognition it needs, which
# is the failure this whole function exists to prevent. Eight characters clears
# a page number and a short footer without excluding a real, if short, sentence.
MIN_SEARCHABLE_CHARACTERS = 8


def add_text_layer(
    reader: PdfReader,
    words_by_page: dict[int, list[Word]],
    *,
    font: StandardFont = StandardFont.HELVETICA,
    keep_private_data: bool = False,
) -> tuple[bytes, dict[str, Any]]:
    """Write recognised words onto their pages, invisibly.

    The existing content is untouched: the layer is appended as an extra content
    stream, so the scan is still the same bytes and still looks identical. What
    changes is that the page now also contains the words.
    """
    if not words_by_page:
        msg = "no recognised words were given"
        raise ValueError(msg)

    pages = reader.pages()
    for number in words_by_page:
        if not 1 <= number <= len(pages):
            msg = f"page {number} does not exist; this document has {len(pages)} page(s)"
            raise ValueError(msg)

    writer = PdfWriter()
    catalog, tree = writer.reserve(), writer.reserve()
    copier = _GraphCopier(writer)
    # An explicit /Widths array, every glyph the same width.
    #
    # A standard-14 font carries no widths, so a reader has to fall back on an
    # assumption - and this package's own extractor assumes 500 while its text
    # measurer assumes 520. Four percent does not sound like much until a search
    # highlights a span two and a half points short of the word it found.
    #
    # Declaring the metrics removes the disagreement: the layout, this package's
    # extractor and any other reader all use the same numbers. Uniform widths
    # cost nothing here because each word is positioned and scaled individually,
    # so the span of a word is exact even though the glyphs inside it are not
    # where a typesetter would put them. Nothing is drawn, so nobody sees it.
    font_ref = writer.add(
        {
            "Type": Name("Font"),
            "Subtype": Name("Type1"),
            "BaseFont": Name(font.value),
            "Encoding": Name("WinAnsiEncoding"),
            "FirstChar": 32,
            "LastChar": 255,
            "Widths": [OCR_GLYPH_WIDTH] * (255 - 32 + 1),
        }
    )

    written = 0
    refs: list[Reference] = []
    for index, page in enumerate(pages):
        words = [word for word in words_by_page.get(index + 1, []) if word.text.strip()]
        body = _page_body(page.dictionary, keep_private_data=keep_private_data)

        if words:
            # Resources are resolved into a plain dictionary so the font can be
            # added to this page without editing an object other pages share.
            resources = reader.resolve(body.get("Resources"))
            resources = dict(resources) if isinstance(resources, dict) else {}
            fonts = reader.resolve(resources.get("Font"))
            fonts = dict(fonts) if isinstance(fonts, dict) else {}
            resources["Font"] = fonts
            body["Resources"] = resources

        copied = copier.copy(reader, body)
        if not isinstance(copied, dict):
            continue
        copied["Type"] = Name("Page")
        copied["Parent"] = tree

        if words:
            _attach_font(copied, writer, font_ref)
            layer = writer.add(Stream({}, _layer(words, font)))
            copied["Contents"] = _appended(copied.get("Contents"), layer, writer)
            written += len(words)

        refs.append(writer.add(copied))

    writer.put(tree, {"Type": Name("Pages"), "Kids": refs, "Count": len(refs)})
    writer.put(catalog, {"Type": Name("Catalog"), "Pages": tree})
    data = writer.build(catalog, {"Producer": "Image & PDF Workspace"})

    return data, {
        "words_written": written,
        "pages_with_text": sum(1 for entries in words_by_page.values() if entries),
        "page_count": len(pages),
        "note": (
            f"{written} word(s) added as an invisible layer over the scan. The pages look "
            "exactly as they did; they can now be searched, selected, copied from, and "
            "redacted by phrase."
        ),
    }


def _layer(words: list[Word], font: StandardFont) -> bytes:
    """The content stream for one page's worth of invisible text.

    Each word gets its own text object with a horizontal scale computed to make
    the glyphs span the measured box exactly. Without that scaling the invisible
    text drifts from the ink - selection highlights the wrong span, search puts
    the viewport in the wrong place, and a redaction driven by a phrase covers
    pixels next to the ones that matter.
    """
    parts = [f"q BT {INVISIBLE} Tr"]
    key = "/IpwOcr"

    for word in words:
        if word.width <= 0 or word.height <= 0:
            continue

        # Cap-height is roughly 0.7 em for the standard fonts, so a box drawn
        # around visible ink is about that fraction of the font size.
        size = max(1.0, word.height / 0.7)
        # Measured from the declared widths above rather than from an estimate,
        # so the scale below makes the word span its box exactly.
        natural = len(word.text) * size * (OCR_GLYPH_WIDTH / 1000.0)
        if natural <= 0:
            continue
        scale = max(1.0, min(word.width / natural * 100.0, 1000.0))

        escaped = word.text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        parts.append(f"{key} {size:.2f} Tf")
        parts.append(f"{scale:.2f} Tz")
        parts.append(f"1 0 0 1 {word.left:.2f} {word.bottom:.2f} Tm")
        parts.append(f"({escaped}) Tj")

    parts.append("ET Q")
    return "\n".join(parts).encode("latin-1", "replace")


def _attach_font(copied: dict[str, Any], writer: PdfWriter, font_ref: Reference) -> None:
    resources = copied.get("Resources")
    if isinstance(resources, Reference):
        resources = writer.get(resources)
    if not isinstance(resources, dict):
        return
    fonts = resources.get("Font")
    if isinstance(fonts, Reference):
        fonts = writer.get(fonts)
    if not isinstance(fonts, dict):
        fonts = {}
        resources["Font"] = fonts
    fonts["IpwOcr"] = font_ref


def _appended(existing: Any, layer: Reference, writer: PdfWriter) -> Any:
    """Add the layer after whatever the page already draws.

    Appending rather than replacing is the same reasoning as stamping: the scan
    is the page, and a text layer that overwrote it would be a catastrophic way
    to make a document searchable.
    """
    if existing is None:
        return layer
    if isinstance(existing, list):
        return [*existing, layer]
    return [existing, layer]


def coverage(reader: PdfReader) -> dict[str, Any]:
    """How much of this document is already searchable.

    Answers the question that decides whether OCR is needed at all: a PDF
    exported from Word needs none, a scan needs it on every page, and a bundle
    of both needs it on some. Running recognition over pages that already have
    perfectly good text would be slower and *less* accurate than what is there.
    """
    from ipw.pdf.content import extract_text
    from ipw.pdf.edit import extract_images

    pages = reader.pages()
    with_text: list[int] = []
    for index, page in enumerate(pages):
        runs = extract_text(reader, page.dictionary)
        if sum(len(run.text.strip()) for run in runs) >= MIN_SEARCHABLE_CHARACTERS:
            with_text.append(index + 1)

    images = {image.page_number for image in extract_images(reader)}
    scanned = [
        index + 1
        for index in range(len(pages))
        if index + 1 not in with_text and index + 1 in images
    ]

    return {
        "page_count": len(pages),
        "pages_with_text": with_text,
        "pages_needing_ocr": scanned,
        "fully_searchable": len(with_text) == len(pages),
        "note": _coverage_note(len(pages), len(with_text), len(scanned)),
    }


def _coverage_note(total: int, searchable: int, scanned: int) -> str:
    """Describe all three kinds of page, not two.

    A page can carry real text, or be a scan, or be neither - vector artwork, a
    diagram, a blank. Collapsing that into "text or scan" produces a confidently
    wrong sentence on ordinary documents: a 27-page design file with one photo
    on page 25 was reported as "all 27 pages are scans", which would send someone
    to run recognition over 26 pages that contain no words at all.
    """
    other = total - searchable - scanned

    if total == 0:
        return "This document has no pages."
    if searchable == total:
        return (
            "Every page already has real text. Searching, copying and redacting by phrase "
            "all work on this document as it is - it needs no recognition."
        )
    if scanned == 0 and searchable == 0:
        return (
            f"None of the {total} page(s) contain words - they are vector artwork, diagrams "
            "or blanks. There is nothing for recognition to read."
        )
    if scanned == total:
        return (
            f"All {total} page(s) are scans: the words are pixels, so nothing can search or "
            "select them. Recognition would make them searchable, and would let a name be "
            "redacted by typing it rather than by drawing a box on every page."
        )

    parts: list[str] = []
    if searchable:
        parts.append(f"{searchable} page(s) have real text")
    if scanned:
        parts.append(f"{scanned} are scans and cannot be searched until recognised")
    if other:
        parts.append(f"{other} hold no words at all - artwork, diagrams or blanks")

    sentence = "; ".join(parts) + "."
    if searchable and scanned:
        sentence += (
            " A search will find matches in the first group and silently miss the second, "
            "which is the dangerous half of a mixed bundle."
        )
    return sentence
