"""Redaction that removes the words, rather than covering them up.

**Almost every tool gets this wrong, and the failure is silent.** Drawing a black
rectangle over a name changes what the page looks like and nothing else: the text
is still in the content stream, still selectable, still returned by copy-and-paste
and by every search index that touches the file. Court filings, medical records
and merger documents have all been published that way, and in each case the file
looked correct to the person who released it.

So this deletes. The characters are taken out of the content stream, the pixels
under the box are overwritten inside any image, and annotations that overlap are
dropped. The black rectangle is drawn too - but only as a mark for the reader,
last, on top of a page that no longer contains the words.

**Two things make that trustworthy rather than merely intended.** The document is
rebuilt from scratch rather than appended to, so no earlier version of the page
survives as a recoverable revision - which is how several published redaction
failures were actually undone. And :func:`verify` reads the finished file back
and reports any redacted phrase still present, so the promise is checked against
the bytes instead of asserted.

**What it cannot do.** Vector artwork - a drawn signature, a chart plotted as
paths - is not removed, because deciding which of thousands of line segments
belong to the thing being hidden needs judgement this cannot exercise. Those
pages are reported, by number, rather than quietly returned looking finished.
"""

from __future__ import annotations

import io
from dataclasses import dataclass, field
from typing import Any

from ipw.pdf.content import (
    IDENTITY,
    Matrix,
    TextRun,
    apply,
    extract_text,
    find_text,
    image_placements,
    multiply,
    page_content,
    tokenise,
)
from ipw.pdf.edit import (
    _filters_of,
    _GraphCopier,
    _page_body,
    page_body_without_xobjects,
)
from ipw.pdf.objects import Name, PdfWriter, Reference, Stream
from ipw.pdf.reader import PdfReader, RawStream

__all__ = [
    "Redaction",
    "RedactionReport",
    "redact",
    "redact_phrases",
    "verify",
]


@dataclass(frozen=True)
class Redaction:
    """One rectangle on one page, in PDF points from the bottom-left corner."""

    page: int
    """One-based, as the customer counts pages."""

    left: float
    bottom: float
    right: float
    top: float

    @property
    def box(self) -> tuple[float, float, float, float]:
        return (
            min(self.left, self.right),
            min(self.bottom, self.top),
            max(self.left, self.right),
            max(self.bottom, self.top),
        )


@dataclass
class RedactionReport:
    """What was removed, and what could not be."""

    characters_removed: int = 0
    runs_removed: int = 0
    images_painted: int = 0
    annotations_removed: int = 0
    pages_with_vector_art: list[int] = field(default_factory=list)
    removed_text: list[str] = field(default_factory=list)


def redact(
    reader: PdfReader,
    redactions: list[Redaction],
    *,
    mark: bool = True,
    colour: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> tuple[bytes, RedactionReport]:
    """Remove everything inside the given rectangles and return a new document."""
    if not redactions:
        msg = "no areas to redact were given"
        raise ValueError(msg)

    pages = reader.pages()
    for redaction in redactions:
        if not 1 <= redaction.page <= len(pages):
            msg = f"page {redaction.page} does not exist; this document has {len(pages)} page(s)"
            raise ValueError(msg)

    by_page: dict[int, list[Redaction]] = {}
    for redaction in redactions:
        by_page.setdefault(redaction.page, []).append(redaction)

    report = RedactionReport()
    writer = PdfWriter()
    catalog, tree = writer.reserve(), writer.reserve()
    copier = _GraphCopier(writer)

    refs: list[Reference] = []
    for index, page in enumerate(pages):
        boxes = [item.box for item in by_page.get(index + 1, [])]
        painted: dict[str, tuple[bytes, bool]] = {}

        if boxes:
            _record_removed(reader, page.dictionary, boxes, report)
            cleaned = _clean_stream(reader, page.dictionary, boxes, report)
            painted = _paint_images(reader, page.dictionary, boxes, report)
            # The originals are dropped from the page before it is copied, so
            # the unredacted pixels never reach the output at all.
            body = page_body_without_xobjects(reader, page.dictionary, set(painted))
            body = _without_annotations(reader, body, boxes, report)
            # **And the original text, for exactly the same reason.**
            #
            # `Contents` is replaced further down with the cleaned stream, but
            # the replacement happens *after* the page is copied - so copying a
            # body that still points at the original stream pulled the
            # unredacted text into the output as its own object. Nothing
            # referenced it, the page rendered correctly, extraction found
            # nothing and verify() passed; the name came back from `qpdf --qdf`
            # or two lines of zlib.
            #
            # That is the failure this module exists to prevent, and it is the
            # same one already fixed for images. Dropping the reference before
            # the copy is what makes "removed" mean removed.
            body.pop("Contents", None)
            if _has_vector_art(reader, page.dictionary, boxes):
                report.pages_with_vector_art.append(index + 1)
        else:
            cleaned = None
            body = _page_body(page.dictionary)

        copied = copier.copy(reader, body)
        if not isinstance(copied, dict):
            continue
        copied["Type"] = Name("Page")
        copied["Parent"] = tree

        if boxes:
            _replace_images(copied, painted, writer, reader, copier)
            stream = cleaned if cleaned is not None else b""
            if mark:
                stream += b"\n" + _marks(boxes, colour)
            copied["Contents"] = writer.add(Stream({}, stream))

        refs.append(writer.add(copied))

    writer.put(tree, {"Type": Name("Pages"), "Kids": refs, "Count": len(refs)})
    writer.put(catalog, {"Type": Name("Catalog"), "Pages": tree})
    # No /Prev, no incremental update: this is a fresh file, so there is no
    # earlier revision of these pages left inside it to recover.
    return writer.build(catalog, {"Producer": "Image & PDF Workspace"}), report


def verify(data: bytes, phrases: list[str]) -> list[str]:
    """Read the finished file back and report any phrase still present.

    The whole feature rests on this. Redaction that is asserted rather than
    checked is how documents get published with the names still in them, and the
    check is cheap: extract the text again and look.
    """
    wanted = [phrase.strip() for phrase in phrases if phrase.strip()]
    if not wanted:
        return []

    reader = PdfReader.from_bytes(data)
    found: set[str] = set()

    for page in reader.pages():
        text = " ".join(run.text for run in extract_text(reader, page.dictionary))
        # Also search the raw stream: a phrase split across two show operators
        # would be missed by the reconstructed text alone.
        raw = page_content(reader, page.dictionary).decode("latin-1", "replace")
        for phrase in wanted:
            if phrase in text or phrase in raw:
                found.add(phrase)

    return sorted(found)


# ------------------------------------------------------------------ text ----


def _record_removed(
    reader: PdfReader,
    page_dictionary: dict[str, Any],
    boxes: list[tuple[float, float, float, float]],
    report: RedactionReport,
) -> None:
    for run in extract_text(reader, page_dictionary):
        if any(run.intersects(box) for box in boxes):
            report.removed_text.append(run.text)


def _clean_stream(
    reader: PdfReader,
    page_dictionary: dict[str, Any],
    boxes: list[tuple[float, float, float, float]],
    report: RedactionReport,
) -> bytes:
    """Rebuild the content stream with the covered characters taken out.

    Removal is per character, not per operator. Dropping a whole show-text
    operator because one word inside it fell in the box would delete the rest of
    the line as well - and a customer redacting a name in a sentence expects the
    sentence to survive.

    Each removed character is replaced by the exact horizontal move it would have
    caused, written as a lone number in a `TJ` array. The pen therefore ends
    where it would have ended, so everything positioned relative to it stays put,
    and nothing is drawn.
    """
    from ipw.pdf.content import _font_widths, _State

    fonts = _font_widths(reader, page_dictionary)
    tokens = tokenise(page_content(reader, page_dictionary))

    out: list[bytes] = []
    state = _State()
    stack: list[_State] = []
    text_matrix = line_matrix = IDENTITY

    for operands, operator in tokens:
        if operator == "q":
            stack.append(_copy_state(state))
        elif operator == "Q":
            if stack:
                state = stack.pop()
        elif operator == "cm" and len(operands) >= 6:
            state.ctm = multiply(_as_matrix(operands[-6:]), state.ctm)
        elif operator == "BT":
            text_matrix = line_matrix = IDENTITY
        elif operator == "Tf" and len(operands) >= 2:
            name = operands[-2]
            state.font = name.value if isinstance(name, Name) else str(name)
            state.size = _as_number(operands[-1])
            metrics = fonts.get(state.font, {})
            state.widths = metrics.get("widths", {})
            state.default_width = metrics.get("default", 500.0)
        elif operator == "Tc" and operands:
            state.char_spacing = _as_number(operands[-1])
        elif operator == "Tw" and operands:
            state.word_spacing = _as_number(operands[-1])
        elif operator == "Tz" and operands:
            state.horizontal = _as_number(operands[-1]) / 100.0
        elif operator == "TL" and operands:
            state.leading = _as_number(operands[-1])
        elif operator == "Ts" and operands:
            state.rise = _as_number(operands[-1])
        elif operator == "Tm" and len(operands) >= 6:
            text_matrix = line_matrix = _as_matrix(operands[-6:])
        elif operator in ("Td", "TD") and len(operands) >= 2:
            if operator == "TD":
                state.leading = -_as_number(operands[-1])
            line_matrix = multiply(
                (1.0, 0.0, 0.0, 1.0, _as_number(operands[-2]), _as_number(operands[-1])),
                line_matrix,
            )
            text_matrix = line_matrix
        elif operator == "T*":
            line_matrix = multiply((1.0, 0.0, 0.0, 1.0, 0.0, -state.leading), line_matrix)
            text_matrix = line_matrix

        if operator in ("Tj", "TJ", "'", '"'):
            if operator in ("'", '"'):
                line_matrix = multiply((1.0, 0.0, 0.0, 1.0, 0.0, -state.leading), line_matrix)
                text_matrix = line_matrix
                out.append(b"T*")
            rebuilt, text_matrix = _rebuild_show(
                operands[-1] if operands else "", state, text_matrix, boxes, report
            )
            out.append(rebuilt)
            continue

        out.append(_write(operands, operator))

    return b"\n".join(chunk for chunk in out if chunk)


def _rebuild_show(
    shown: Any,
    state: Any,
    text_matrix: Matrix,
    boxes: list[tuple[float, float, float, float]],
    report: RedactionReport,
) -> tuple[bytes, Matrix]:
    """One show-text operator, with covered characters replaced by movement."""
    pieces: list[Any] = shown if isinstance(shown, list) else [shown]
    combined = multiply(text_matrix, state.ctm)

    parts: list[bytes] = []
    kept: list[str] = []
    pending = 0.0
    advance = 0.0
    removed_here = 0

    def flush_text() -> None:
        if kept:
            parts.append(_literal("".join(kept)))
            kept.clear()

    def flush_move() -> None:
        nonlocal pending
        if pending and state.size:
            amount = -pending * 1000.0 / (state.size * (state.horizontal or 1.0))
            parts.append(f"{amount:.4f}".rstrip("0").rstrip(".").encode("ascii"))
        pending = 0.0

    for piece in pieces:
        if isinstance(piece, (int, float)):
            flush_text()
            parts.append(f"{float(piece):.4f}".rstrip("0").rstrip(".").encode("ascii"))
            advance -= float(piece) / 1000.0 * state.size * state.horizontal
            continue
        if not isinstance(piece, str):
            continue

        for character in piece:
            code = ord(character)
            width = state.widths.get(code, state.default_width) / 1000.0
            step = width * state.size + state.char_spacing
            if code == 32:
                step += state.word_spacing
            step *= state.horizontal

            x0, y0 = apply(combined, advance, state.rise)
            x1, y1 = apply(combined, advance + step, state.rise)
            height = abs(state.size * (combined[3] or 1.0))
            glyph = TextRun(
                text=character,
                x0=min(x0, x1),
                y0=min(y0, y1) - height * 0.25,
                x1=max(x0, x1),
                y1=max(y0, y1) + height * 0.85,
                font=state.font,
                size=state.size,
            )

            if any(glyph.intersects(box) for box in boxes):
                flush_text()
                pending += step
                removed_here += 1
            else:
                flush_move()
                kept.append(character)

            advance += step

    flush_text()
    flush_move()

    if removed_here:
        report.characters_removed += removed_here
        report.runs_removed += 1

    body = b"[" + b" ".join(parts) + b"] TJ" if parts else b""
    return body, multiply((1.0, 0.0, 0.0, 1.0, advance, 0.0), text_matrix)


# ----------------------------------------------------------------- images ----


def _paint_images(
    reader: PdfReader,
    page_dictionary: dict[str, Any],
    boxes: list[tuple[float, float, float, float]],
    report: RedactionReport,
) -> dict[str, tuple[bytes, bool]]:
    """Overwrite the pixels under each box, inside every image on the page.

    Scans are the case that matters. A scanned contract has no text objects at
    all - the words are pixels - so removing text achieves nothing and only
    painting the image actually hides anything. The pixels are replaced, not
    covered: the returned image no longer contains them.
    """
    from PIL import Image

    placements = image_placements(reader, page_dictionary)
    painted: dict[str, tuple[bytes, bool]] = {}

    for name, (stream, ctm) in placements.items():
        try:
            regions = _pixel_regions(stream, ctm, boxes)
        except ZeroDivisionError:
            continue
        if not regions:
            continue

        try:
            picture = Image.open(io.BytesIO(stream.decoded()))
            picture.load()
        except Exception:  # noqa: BLE001, S112 - an unreadable image is left as it is
            continue

        flattened = picture.convert("RGB")
        for left, upper, right, lower in regions:
            flattened.paste((0, 0, 0), (left, upper, right, lower))

        # Match the original's encoding rather than picking one. Re-encoding a
        # lossless image as JPEG would spend a lossy generation on a legal
        # document for no reason; storing a photograph raw would multiply a
        # scanned bundle's size several times over.
        was_jpeg = "DCTDecode" in _filters_of(stream.dictionary)
        buffer = io.BytesIO()
        if was_jpeg:
            flattened.save(buffer, format="JPEG", quality=95, optimize=True)
        else:
            flattened.save(buffer, format="PNG", optimize=True)
        painted[name] = (buffer.getvalue(), was_jpeg)
        report.images_painted += 1

    return painted


def _pixel_regions(
    stream: RawStream, ctm: Matrix, boxes: list[tuple[float, float, float, float]]
) -> list[tuple[int, int, int, int]]:
    """Which pixels of this image fall under the boxes.

    An image is drawn into the unit square, so the page-to-pixel mapping is the
    inverse of the matrix in force at its `Do`. The corners of each box are
    mapped back and their bounding rectangle taken, which is exact for upright
    placements and deliberately generous for rotated ones - covering slightly
    too much is the safe direction here.
    """
    width = int(stream.dictionary.get("Width") or 0)
    height = int(stream.dictionary.get("Height") or 0)
    if width <= 0 or height <= 0:
        return []

    inverse = _invert(ctm)
    if inverse is None:
        return []

    regions: list[tuple[int, int, int, int]] = []
    for left, bottom, right, top in boxes:
        corners = [
            apply(inverse, left, bottom),
            apply(inverse, right, bottom),
            apply(inverse, right, top),
            apply(inverse, left, top),
        ]
        us = [u for u, _ in corners]
        vs = [v for _, v in corners]
        if max(us) <= 0 or min(us) >= 1 or max(vs) <= 0 or min(vs) >= 1:
            continue

        x0 = max(0, min(width, int(min(us) * width)))
        x1 = max(0, min(width, round(max(us) * width)))
        # v runs upward from the bottom of the image; pixel rows run downward.
        y0 = max(0, min(height, int((1.0 - max(vs)) * height)))
        y1 = max(0, min(height, round((1.0 - min(vs)) * height)))
        if x1 > x0 and y1 > y0:
            regions.append((x0, y0, x1, y1))
    return regions


def _replace_images(
    copied: dict[str, Any],
    painted: dict[str, tuple[bytes, bool]],
    writer: PdfWriter,
    reader: PdfReader,
    copier: _GraphCopier,
) -> None:
    """Put the painted versions into the copied page.

    The originals were removed before the copy, so this is adding rather than
    substituting - there is nothing left underneath.
    """
    if not painted:
        return
    resources = copied.get("Resources")
    if isinstance(resources, Reference):
        resources = writer.get(resources)
    if not isinstance(resources, dict):
        return
    xobjects = resources.get("XObject")
    if isinstance(xobjects, Reference):
        xobjects = writer.get(xobjects)
    if not isinstance(xobjects, dict):
        xobjects = {}
        resources["XObject"] = xobjects

    from PIL import Image

    for name, (data, was_jpeg) in painted.items():
        picture = Image.open(io.BytesIO(data))
        dictionary = {
            "Type": Name("XObject"),
            "Subtype": Name("Image"),
            "Width": picture.width,
            "Height": picture.height,
            "ColorSpace": Name("DeviceRGB"),
            "BitsPerComponent": 8,
        }
        if was_jpeg:
            xobjects[name] = writer.add(
                Stream(dictionary, data, compress=False, filters=("DCTDecode",))
            )
        else:
            xobjects[name] = writer.add(Stream(dictionary, picture.convert("RGB").tobytes()))


# ------------------------------------------------------------ annotations ----


def _without_annotations(
    reader: PdfReader,
    body: dict[str, Any],
    boxes: list[tuple[float, float, float, float]],
    report: RedactionReport,
) -> dict[str, Any]:
    """Drop annotations overlapping a box.

    A comment, a form field or a link sitting under a redaction carries its own
    text, entirely separate from the page's content stream. Leaving it is the
    same failure as leaving the words: invisible on the page, plainly there in
    the file.
    """
    annots = reader.resolve(body.get("Annots"))
    if not isinstance(annots, list):
        return body

    kept = []
    for entry in annots:
        annotation = reader.resolve(entry)
        rect = reader.resolve(annotation.get("Rect")) if isinstance(annotation, dict) else None
        if isinstance(rect, list) and len(rect) >= 4:
            values = [float(reader.resolve(value) or 0) for value in rect[:4]]
            left, bottom = min(values[0], values[2]), min(values[1], values[3])
            right, top = max(values[0], values[2]), max(values[1], values[3])
            if any(
                not (right < box[0] or left > box[2] or top < box[1] or bottom > box[3])
                for box in boxes
            ):
                report.annotations_removed += 1
                continue
        kept.append(entry)

    updated = dict(body)
    if kept:
        updated["Annots"] = kept
    else:
        updated.pop("Annots", None)
    return updated


def _has_vector_art(
    reader: PdfReader,
    page_dictionary: dict[str, Any],
    boxes: list[tuple[float, float, float, float]],
) -> bool:
    """Whether any path is painted on this page at all.

    Not whether it falls inside a box: tracking every path's extent through the
    graphics state would imply a precision this does not have. The honest report
    is 'this page has drawn artwork, and drawn artwork is not removed', which is
    what the caller is told.
    """
    for _, operator in tokenise(page_content(reader, page_dictionary)):
        if operator in ("S", "s", "f", "F", "f*", "B", "B*", "b", "b*"):
            return True
    return False


# ---------------------------------------------------------------- writing ----


def _marks(
    boxes: list[tuple[float, float, float, float]], colour: tuple[float, float, float]
) -> bytes:
    red, green, blue = colour
    parts = [f"q {red:.3f} {green:.3f} {blue:.3f} rg"]
    for left, bottom, right, top in boxes:
        parts.append(f"{left:.3f} {bottom:.3f} {right - left:.3f} {top - bottom:.3f} re f")
    parts.append("Q")
    return "\n".join(parts).encode("ascii")


def _write(operands: list[Any], operator: str) -> bytes:
    from ipw.pdf.objects import serialise

    parts = []
    for operand in operands:
        try:
            parts.append(serialise(operand))
        except Exception:  # noqa: BLE001 - an operand we cannot write is dropped, not fatal
            return b""
    parts.append(operator.encode("ascii"))
    return b" ".join(parts)


def _literal(text: str) -> bytes:
    escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    return b"(" + escaped.encode("latin-1", "replace") + b")"


def _invert(matrix: Matrix) -> Matrix | None:
    a, b, c, d, e, f = matrix
    determinant = a * d - b * c
    if abs(determinant) < 1e-12:
        return None
    return (
        d / determinant,
        -b / determinant,
        -c / determinant,
        a / determinant,
        (c * f - d * e) / determinant,
        (b * e - a * f) / determinant,
    )


def _as_matrix(operands: list[Any]) -> Matrix:
    values = [_as_number(value) for value in operands[:6]]
    while len(values) < 6:
        values.append(0.0)
    return (values[0], values[1], values[2], values[3], values[4], values[5])


def _as_number(value: Any) -> float:
    return float(value) if isinstance(value, (int, float)) else 0.0


def _copy_state(state: Any) -> Any:
    from ipw.pdf.content import _copy

    return _copy(state)


def redact_phrases(
    reader: PdfReader,
    phrases: list[str],
    *,
    pages: list[int] | None = None,
    ignore_case: bool = True,
    padding: float = 1.0,
    mark: bool = True,
) -> tuple[bytes, RedactionReport, list[Redaction]]:
    """Remove every occurrence of each phrase, across the whole document.

    This is what the work actually looks like. Nobody redacting a two-hundred
    page disclosure bundle wants to draw two hundred rectangles; they want every
    instance of a name, an account number or an address gone, and to be told how
    many there were. Doing it by hand is where redactions get missed - not
    through any technical failure, but because page 147 was scrolled past.

    The boxes are found from the page's own glyph positions, so they land on the
    words wherever the words are, and `padding` widens them slightly to cover
    antialiasing and the descenders of a following line.

    Returns the document, the report, and the rectangles used - so a caller can
    show exactly what was covered rather than asking for trust.
    """
    wanted = [phrase for phrase in phrases if phrase.strip()]
    if not wanted:
        msg = "no phrases to redact were given"
        raise ValueError(msg)

    every = reader.pages()
    chosen = set(pages) if pages else set(range(1, len(every) + 1))
    for number in sorted(chosen):
        if not 1 <= number <= len(every):
            msg = f"page {number} does not exist; this document has {len(every)} page(s)"
            raise ValueError(msg)

    boxes: list[Redaction] = []
    for index, page in enumerate(every):
        if index + 1 not in chosen:
            continue
        for phrase in wanted:
            for left, bottom, right, top in find_text(
                reader, page.dictionary, phrase, ignore_case=ignore_case
            ):
                boxes.append(
                    Redaction(
                        page=index + 1,
                        left=left - padding,
                        bottom=bottom - padding,
                        right=right + padding,
                        top=top + padding,
                    )
                )

    if not boxes:
        # Nothing found is a legitimate answer, and a very important one to say
        # clearly: a customer who assumes a name was removed because the tool
        # did not complain is in a worse position than before they started.
        return reader.data, RedactionReport(), []

    data, report = redact(reader, boxes, mark=mark)
    return data, report, boxes
