"""Reading what is actually drawn on a page.

Everything else in this package treats a content stream as an opaque blob to be
copied intact - which is exactly why merge, split and rotate are lossless. This
module is the one place that looks inside, because two jobs cannot be done any
other way: finding where text sits on a page, and removing it.

**The graphics state is the hard part, not the tokens.** A text-showing operator
carries no position. Where the glyphs land is the product of the current
transformation matrix, the text matrix, the font size, the horizontal scale and
the accumulated advance of everything shown before it. A reader that tokenises
correctly and tracks state carelessly reports text in the wrong place - and for
redaction, reporting a position slightly wrong means covering the wrong pixels
while leaving the real words in the file.

So the matrices are maintained properly, including `q`/`Q` nesting, and the
widths come from the font's own `/Widths` array wherever the font provides one
rather than from an estimate.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from ipw.pdf.objects import Name
from ipw.pdf.reader import PdfReader, RawStream, _Lexer

__all__ = [
    "Glyph",
    "Matrix",
    "TextRun",
    "extract_text",
    "find_text",
    "glyphs",
    "image_placements",
    "page_content",
    "tokenise",
]

Matrix = tuple[float, float, float, float, float, float]
"""a b c d e f, as PDF writes it: x' = a*x + c*y + e, y' = b*x + d*y + f."""

IDENTITY: Matrix = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)

# Operators that show text, and how many operands precede the string.
_SHOW_TEXT = {"Tj", "TJ", "'", '"'}

_OPERATOR = re.compile(rb"[A-Za-z'\"*][A-Za-z0-9'\"*]*")

# Quote and double-quote both start a new line before drawing, which is easy
# to miss and puts every following glyph one line too high when missed.
_NEXT_LINE_THEN_SHOW = frozenset(_SHOW_TEXT - {"Tj", "TJ"})


@dataclass(frozen=True)
class Glyph:
    """One character and the box it occupies on the page."""

    character: str
    x0: float
    y0: float
    x1: float
    y1: float
    run: int = 0


@dataclass(frozen=True)
class TextRun:
    """One run of glyphs, and the box on the page it occupies."""

    text: str
    x0: float
    y0: float
    x1: float
    y1: float
    font: str
    size: float

    def intersects(self, box: tuple[float, float, float, float]) -> bool:
        left, bottom, right, top = box
        return not (self.x1 < left or self.x0 > right or self.y1 < bottom or self.y0 > top)


def multiply(first: Matrix, second: Matrix) -> Matrix:
    """first x second, in PDF's row-vector convention."""
    a1, b1, c1, d1, e1, f1 = first
    a2, b2, c2, d2, e2, f2 = second
    return (
        a1 * a2 + b1 * c2,
        a1 * b2 + b1 * d2,
        c1 * a2 + d1 * c2,
        c1 * b2 + d1 * d2,
        e1 * a2 + f1 * c2 + e2,
        e1 * b2 + f1 * d2 + f2,
    )


def apply(matrix: Matrix, x: float, y: float) -> tuple[float, float]:
    a, b, c, d, e, f = matrix
    return (a * x + c * y + e, b * x + d * y + f)


def tokenise(data: bytes) -> list[tuple[list[Any], str]]:
    """Split a content stream into (operands, operator) pairs.

    Inline images are the trap here. `BI ... ID <binary> EI` puts arbitrary bytes
    directly in the stream, and those bytes routinely contain sequences that look
    like operators. Scanning for the next `EI` delimiter rather than parsing on
    means a photograph embedded inline cannot derail everything after it.
    """
    lexer = _Lexer(data, 0)
    out: list[tuple[list[Any], str]] = []
    operands: list[Any] = []
    size = len(data)

    while True:
        lexer.skip_space()
        if lexer.position >= size:
            break

        byte = data[lexer.position]
        if byte in b"/[(<+-." or 0x30 <= byte <= 0x39:
            try:
                operands.append(lexer.parse())
            except Exception:  # noqa: BLE001 - a damaged stream must not stop the page
                lexer.position += 1
                operands = []
            continue

        match = _OPERATOR.match(data, lexer.position)
        if match is None:
            lexer.position += 1
            continue

        operator = match.group().decode("latin-1")
        lexer.position = match.end()

        if operator == "BI":
            end = data.find(b"EI", lexer.position)
            lexer.position = size if end < 0 else end + 2
            out.append(([], "BI"))
            operands = []
            continue

        if operator in ("true", "false", "null"):
            operands.append({"true": True, "false": False, "null": None}[operator])
            continue

        out.append((operands, operator))
        operands = []

    return out


def page_content(reader: PdfReader, page_dictionary: dict[str, Any]) -> bytes:
    """Every content stream of one page, decoded and concatenated.

    A page's `/Contents` may be an array, and the pieces are defined to behave as
    one stream - a producer is allowed to split an operator's operands across the
    boundary. Concatenating before tokenising is therefore not an optimisation,
    it is the only correct reading.
    """
    contents = reader.resolve(page_dictionary.get("Contents"))
    parts = contents if isinstance(contents, list) else [contents]
    chunks: list[bytes] = []
    for part in parts:
        stream = reader.resolve(part)
        if isinstance(stream, RawStream):
            try:
                chunks.append(stream.decoded())
            except Exception:  # noqa: BLE001, S112 - one bad stream must not lose the page
                continue
    return b"\n".join(chunks)


@dataclass
class _State:
    ctm: Matrix = IDENTITY
    font: str = ""
    size: float = 0.0
    char_spacing: float = 0.0
    word_spacing: float = 0.0
    horizontal: float = 1.0
    leading: float = 0.0
    rise: float = 0.0
    widths: dict[int, float] = field(default_factory=dict)
    default_width: float = 500.0


def extract_text(reader: PdfReader, page_dictionary: dict[str, Any]) -> list[TextRun]:
    """Every run of text on a page, with where it sits in page coordinates.

    Used for two things: telling a customer whether a PDF has real text at all,
    and proving that redaction removed it. The second is why this exists - a
    redaction that is not verified by reading the file back is a promise, and
    this is the only thing that can turn it into a check.
    """
    runs: list[TextRun] = []
    current: list[Glyph] = []
    font = ""
    size = 0.0

    for glyph, run_id, glyph_font, glyph_size in _layout(reader, page_dictionary):
        if current and run_id != current[0].run:
            runs.append(_to_run(current, font, size))
            current = []
        current.append(glyph)
        font, size = glyph_font, glyph_size

    if current:
        runs.append(_to_run(current, font, size))
    return [run for run in runs if run.text.strip()]


def glyphs(reader: PdfReader, page_dictionary: dict[str, Any]) -> list[Glyph]:
    """Every character on a page, individually placed.

    Runs are convenient for reading; individual characters are what searching
    needs. A phrase a customer wants redacted rarely lines up with the producer's
    show-text operators - a name can easily arrive as three operators with
    kerning numbers between them - so matching has to happen on a flat string of
    characters and map back to the boxes those characters came from.
    """
    return [glyph for glyph, _, _, _ in _layout(reader, page_dictionary)]


def _to_run(collected: list[Glyph], font: str, size: float) -> TextRun:
    return TextRun(
        text="".join(glyph.character for glyph in collected),
        x0=min(glyph.x0 for glyph in collected),
        y0=min(glyph.y0 for glyph in collected),
        x1=max(glyph.x1 for glyph in collected),
        y1=max(glyph.y1 for glyph in collected),
        font=font,
        size=size,
    )


def _layout(
    reader: PdfReader, page_dictionary: dict[str, Any]
) -> list[tuple[Glyph, int, str, float]]:
    """Place every glyph on the page, tracking the full graphics state.

    One implementation, used by everything that needs to know where text is.
    Keeping separate copies for reading and for searching would guarantee they
    eventually disagree, and a search that disagrees with the extractor is how a
    redaction misses by half a line.
    """
    fonts = _font_widths(reader, page_dictionary)
    tokens = tokenise(page_content(reader, page_dictionary))

    placed: list[tuple[Glyph, int, str, float]] = []
    state = _State()
    stack: list[_State] = []
    text_matrix = line_matrix = IDENTITY
    run_id = 0

    for operands, operator in tokens:
        if operator == "q":
            stack.append(_copy(state))
        elif operator == "Q":
            if stack:
                state = stack.pop()
        elif operator == "cm" and len(operands) >= 6:
            state.ctm = multiply(_matrix(operands[-6:]), state.ctm)
        elif operator == "BT":
            text_matrix = line_matrix = IDENTITY
        elif operator == "Tf" and len(operands) >= 2:
            name = operands[-2]
            state.font = name.value if isinstance(name, Name) else str(name)
            state.size = _number(operands[-1])
            metrics = fonts.get(state.font, {})
            state.widths = metrics.get("widths", {})
            state.default_width = metrics.get("default", 500.0)
        elif operator == "Tc" and operands:
            state.char_spacing = _number(operands[-1])
        elif operator == "Tw" and operands:
            state.word_spacing = _number(operands[-1])
        elif operator == "Tz" and operands:
            state.horizontal = _number(operands[-1]) / 100.0
        elif operator == "TL" and operands:
            state.leading = _number(operands[-1])
        elif operator == "Ts" and operands:
            state.rise = _number(operands[-1])
        elif operator == "Tm" and len(operands) >= 6:
            text_matrix = line_matrix = _matrix(operands[-6:])
        elif operator in ("Td", "TD") and len(operands) >= 2:
            if operator == "TD":
                state.leading = -_number(operands[-1])
            line_matrix = multiply(
                (1.0, 0.0, 0.0, 1.0, _number(operands[-2]), _number(operands[-1])), line_matrix
            )
            text_matrix = line_matrix
        elif operator == "T*":
            line_matrix = multiply((1.0, 0.0, 0.0, 1.0, 0.0, -state.leading), line_matrix)
            text_matrix = line_matrix
        elif operator in _SHOW_TEXT:
            if operator in _NEXT_LINE_THEN_SHOW:
                line_matrix = multiply((1.0, 0.0, 0.0, 1.0, 0.0, -state.leading), line_matrix)
                text_matrix = line_matrix
            run_id += 1
            shown = operands[-1] if operands else ""
            for glyph in place_glyphs(shown, state, text_matrix, run_id):
                placed.append((glyph, run_id, state.font, state.size))
            text_matrix = multiply((1.0, 0.0, 0.0, 1.0, advance_of(shown, state), 0.0), text_matrix)

    return placed


def advance_of(shown: Any, state: _State) -> float:
    """Total horizontal movement one show-text operator causes."""
    pieces: list[Any] = shown if isinstance(shown, list) else [shown]
    total = 0.0
    for piece in pieces:
        if isinstance(piece, (int, float)):
            total -= float(piece) / 1000.0 * state.size * state.horizontal
        elif isinstance(piece, str):
            for character in piece:
                total += step_of(character, state)
    return total


def step_of(character: str, state: _State) -> float:
    """How far one character moves the pen, including spacing."""
    code = ord(character)
    width = state.widths.get(code, state.default_width) / 1000.0
    step = width * state.size + state.char_spacing
    if code == 32:
        step += state.word_spacing
    return step * state.horizontal


def place_glyphs(shown: Any, state: _State, text_matrix: Matrix, run_id: int) -> list[Glyph]:
    """Where each character of one show-text operator lands."""
    pieces: list[Any] = shown if isinstance(shown, list) else [shown]
    combined = multiply(text_matrix, state.ctm)
    height = abs(state.size * (combined[3] or 1.0))

    out: list[Glyph] = []
    advance = 0.0
    for piece in pieces:
        if isinstance(piece, (int, float)):
            advance -= float(piece) / 1000.0 * state.size * state.horizontal
            continue
        if not isinstance(piece, str):
            continue
        for character in piece:
            step = step_of(character, state)
            x0, y0 = apply(combined, advance, state.rise)
            x1, y1 = apply(combined, advance + step, state.rise)
            out.append(
                Glyph(
                    character=character,
                    x0=min(x0, x1),
                    # The vertical extent comes from the font size rather than
                    # per-glyph metrics: ascender and descender vary by font and
                    # the difference is well under a line. Erring generous is
                    # right for redaction - a box slightly too tall is harmless,
                    # one slightly too short is a leak.
                    y0=min(y0, y1) - height * 0.25,
                    x1=max(x0, x1),
                    y1=max(y0, y1) + height * 0.85,
                    run=run_id,
                )
            )
            advance += step
    return out


def _font_widths(reader: PdfReader, page_dictionary: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Glyph widths per font, from the file's own metrics where it has them.

    A font that ships `/Widths` knows exactly how wide each glyph is, and using
    that beats any estimate. Only fonts without one - the standard fourteen,
    usually - fall back to an average, and that fallback is why the extents here
    are treated as approximate everywhere they are used.
    """
    resources = reader.resolve(page_dictionary.get("Resources")) or {}
    fonts = reader.resolve(resources.get("Font")) if isinstance(resources, dict) else None
    if not isinstance(fonts, dict):
        return {}

    out: dict[str, dict[str, Any]] = {}
    for key, entry in fonts.items():
        font = reader.resolve(entry)
        if not isinstance(font, dict):
            continue
        widths: dict[int, float] = {}
        first = reader.resolve(font.get("FirstChar"))
        table = reader.resolve(font.get("Widths"))
        if isinstance(table, list) and isinstance(first, (int, float)):
            for offset, value in enumerate(table):
                resolved = reader.resolve(value)
                if isinstance(resolved, (int, float)):
                    widths[int(first) + offset] = float(resolved)

        descriptor = reader.resolve(font.get("FontDescriptor")) or {}
        missing = descriptor.get("MissingWidth") if isinstance(descriptor, dict) else None
        out[key] = {
            "widths": widths,
            "default": float(missing) if isinstance(missing, (int, float)) else 500.0,
        }
    return out


def _matrix(operands: list[Any]) -> Matrix:
    values = [_number(value) for value in operands[:6]]
    while len(values) < 6:
        values.append(0.0)
    return (values[0], values[1], values[2], values[3], values[4], values[5])


def _number(value: Any) -> float:
    return float(value) if isinstance(value, (int, float)) else 0.0


def _copy(state: _State) -> _State:
    return _State(
        ctm=state.ctm,
        font=state.font,
        size=state.size,
        char_spacing=state.char_spacing,
        word_spacing=state.word_spacing,
        horizontal=state.horizontal,
        leading=state.leading,
        rise=state.rise,
        widths=state.widths,
        default_width=state.default_width,
    )


def find_text(
    reader: PdfReader, page_dictionary: dict[str, Any], phrase: str, *, ignore_case: bool = True
) -> list[tuple[float, float, float, float]]:
    """Boxes around every occurrence of a phrase on one page.

    Whitespace in the page is collapsed before matching, because a producer may
    emit a space as a positioning move rather than a space character - so a
    document that reads "Jane Doe" can contain the characters "JaneDoe". Matching
    the visible words rather than the encoded ones is what makes a search find
    what the customer can see.
    """
    found = glyphs(reader, page_dictionary)
    if not found or not phrase.strip():
        return []

    # Build a searchable string alongside a map back to the glyph that produced
    # each character.
    #
    # **Word breaks are inferred from position, not taken from space
    # characters.** Plenty of producers never emit a space at all: they finish
    # one word, move the pen, and start the next. A text layer written over a
    # scan does exactly the same, one operator per recognised word. Matching on
    # the encoded characters alone turns "Claimant Jane Doe" into
    # "ClaimantJaneDoe", and a search for a person's full name finds nothing -
    # on precisely the documents where finding it matters most.
    text: list[str] = []
    origin: list[int] = []
    previous_space = True
    previous: Glyph | None = None

    for index, glyph in enumerate(found):
        character = glyph.character

        if previous is not None and not character.isspace() and not previous_space:
            gap = glyph.x0 - previous.x1
            new_line = abs(glyph.y0 - previous.y0) > max(previous.y1 - previous.y0, 1.0) * 0.5
            # A quarter of a character's width is comfortably wider than the
            # kerning inside a word and far narrower than a real space.
            wide = gap > max(previous.x1 - previous.x0, 1.0) * 0.25
            if new_line or wide:
                text.append(" ")
                origin.append(index)

        if character.isspace():
            if not previous_space:
                text.append(" ")
                origin.append(index)
                previous_space = True
            previous = glyph
            continue

        text.append(character)
        origin.append(index)
        previous_space = False
        previous = glyph

    haystack = "".join(text)
    needle = " ".join(phrase.split())
    if ignore_case:
        haystack = haystack.lower()
        needle = needle.lower()
    if not needle:
        return []

    boxes: list[tuple[float, float, float, float]] = []
    start = haystack.find(needle)
    while start >= 0:
        span = [found[origin[i]] for i in range(start, min(start + len(needle), len(origin)))]
        if span:
            boxes.append(
                (
                    min(glyph.x0 for glyph in span),
                    min(glyph.y0 for glyph in span),
                    max(glyph.x1 for glyph in span),
                    max(glyph.y1 for glyph in span),
                )
            )
        start = haystack.find(needle, start + 1)
    return boxes


def image_placements(
    reader: PdfReader, page_dictionary: dict[str, Any]
) -> dict[str, tuple[RawStream, Matrix]]:
    """Where each image XObject is drawn, as the matrix in force at its `Do`.

    The matrix is what makes an image's *placed* size knowable, and placed size
    is the only thing that decides whether its pixels are useful. A 4000-pixel
    photograph dropped into a 2-inch box carries 2000 DPI: three quarters of its
    weight cannot be seen at any print resolution. Nothing can judge that from
    the image alone - it needs the matrix in force where the image is drawn.
    """
    resources = reader.resolve(page_dictionary.get("Resources")) or {}
    xobjects = reader.resolve(resources.get("XObject")) if isinstance(resources, dict) else None
    if not isinstance(xobjects, dict):
        return {}

    found: dict[str, tuple[RawStream, Matrix]] = {}
    ctm: Matrix = IDENTITY
    stack: list[Matrix] = []

    for operands, operator in tokenise(page_content(reader, page_dictionary)):
        if operator == "q":
            stack.append(ctm)
        elif operator == "Q":
            if stack:
                ctm = stack.pop()
        elif operator == "cm" and len(operands) >= 6:
            ctm = multiply(_matrix(operands[-6:]), ctm)
        elif operator == "Do" and operands:
            name = operands[-1]
            key = name.value if isinstance(name, Name) else str(name)
            stream = reader.resolve(xobjects.get(key))
            if isinstance(stream, RawStream):
                subtype = stream.dictionary.get("Subtype")
                if isinstance(subtype, Name) and subtype.value == "Image":
                    found[key] = (stream, ctm)
    return found
