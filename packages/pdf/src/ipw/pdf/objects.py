"""PDF object serialisation and the cross-reference table.

The bottom of the PDF writer: how values become bytes, and how a file finds its
own objects. Everything above this composes these primitives.

**Why write a PDF engine at all.** Pillow already exports PDF, and it was tested
before this was written rather than dismissed: it embeds JPEG bytes untouched
(``DCTDecode``, so no requantisation) and handles multiple pages. What it has no
concept of is text, vector shapes or CMYK - and PRODUCT_REQUIREMENTS.md section 19
requires "add and format text", "backgrounds, shapes, signatures and page
numbers", and a print-ready export tier. A library that cannot draw a line cannot
be extended into one that can.

The alternative was reportlab or fpdf2. Both are capable and both are permanent
licence-register entries under Gate A, and the part of PDF this product needs -
pages, images, text in the standard fonts, paths - is a well-specified format that
takes a few hundred lines. The rest of the runtime surface has stayed at five
packages through eight POC tasks by making exactly this trade each time.

**Byte offsets are the whole game.** A PDF locates every object by its absolute
offset from the start of the file, listed in a cross-reference table at the end.
Get one offset wrong and the file opens in some readers and not others, which is
the worst failure mode available: it looks like it worked. So offsets are recorded
by the writer as it writes, never computed afterwards from lengths that might
disagree with what was actually emitted.
"""

from __future__ import annotations

import zlib
from dataclasses import dataclass, field
from typing import Any

__all__ = [
    "Name",
    "PdfWriter",
    "Raw",
    "Reference",
    "Stream",
    "serialise",
]


@dataclass(frozen=True)
class Name:
    """A PDF name such as ``/Type``. Distinct from a string, which is text."""

    value: str


@dataclass(frozen=True)
class Reference:
    """An indirect reference: ``12 0 R``."""

    number: int
    generation: int = 0


@dataclass(frozen=True)
class Raw:
    """Bytes to emit verbatim. For content streams already assembled."""

    data: bytes


@dataclass
class Stream:
    """A dictionary followed by data.

    Compression is applied here rather than by the caller so that the
    ``/Filter`` entry and the bytes can never disagree - a stream that claims
    ``FlateDecode`` and carries raw data is a file that fails to open with no
    useful message.
    """

    dictionary: dict[str, Any]
    data: bytes
    compress: bool = True
    filters: tuple[str, ...] = ()
    """Filters the data already carries, outermost first.

    JPEG bytes arrive already compressed as ``DCTDecode``; re-compressing them
    would enlarge the file and re-encoding them would lose quality, so such a
    stream declares its existing filter and is written untouched.
    """

    def encoded(self) -> tuple[bytes, dict[str, Any]]:
        dictionary = dict(self.dictionary)
        data = self.data
        filters = list(self.filters)

        if self.compress and not filters:
            compressed = zlib.compress(data, 9)
            # Only worth it if it actually helps; some small streams grow.
            if len(compressed) < len(data):
                data = compressed
                filters.append("FlateDecode")

        if filters:
            dictionary["Filter"] = (
                Name(filters[0]) if len(filters) == 1 else [Name(f) for f in filters]
            )
        dictionary["Length"] = len(data)
        return data, dictionary


def _escape_text(value: str) -> bytes:
    """PDF literal string escaping.

    Backslash, parentheses and non-ASCII need care. Unbalanced parentheses in a
    caption are the classic way a generated PDF becomes unreadable, so they are
    escaped unconditionally rather than counted.
    """
    out = bytearray(b"(")
    for character in value:
        code = ord(character)
        if character in "\\()":
            out += b"\\" + character.encode("latin-1")
        elif character == "\n":
            out += b"\\n"
        elif character == "\r":
            out += b"\\r"
        elif character == "\t":
            out += b"\\t"
        elif code < 32 or code > 126:
            # PDFDocEncoding covers Latin-1 for the standard fonts; anything
            # outside it is emitted as an octal escape of its Latin-1 byte, and
            # characters with no Latin-1 form become '?' rather than corrupting
            # the stream. Full Unicode needs an embedded font, which is a
            # separate piece of work with its own licensing questions.
            try:
                out += f"\\{ord(character.encode('latin-1')):03o}".encode("ascii")
            except UnicodeEncodeError:
                out += b"?"
        else:
            out += character.encode("latin-1")
    out += b")"
    return bytes(out)


def serialise(value: Any) -> bytes:
    """One PDF value as bytes."""
    if isinstance(value, Raw):
        return value.data
    if isinstance(value, Name):
        return b"/" + value.value.encode("ascii")
    if isinstance(value, Reference):
        return f"{value.number} {value.generation} R".encode("ascii")
    if value is True:
        return b"true"
    if value is False:
        return b"false"
    if value is None:
        return b"null"
    if isinstance(value, int):
        return str(value).encode("ascii")
    if isinstance(value, float):
        # Fixed notation: PDF has no exponent form, and '1e-05' is a syntax error
        # that renders as a blank page rather than an error message.
        text = f"{value:.5f}".rstrip("0").rstrip(".")
        return (text or "0").encode("ascii")
    if isinstance(value, str):
        return _escape_text(value)
    if isinstance(value, bytes):
        return b"<" + value.hex().encode("ascii") + b">"
    if isinstance(value, (list, tuple)):
        return b"[" + b" ".join(serialise(item) for item in value) + b"]"
    if isinstance(value, dict):
        parts = [b"<<"]
        for key, item in value.items():
            parts.append(b"/" + key.encode("ascii") + b" " + serialise(item))
        parts.append(b">>")
        return b" ".join(parts)

    msg = f"cannot serialise {type(value).__name__} into a PDF object"
    raise TypeError(msg)


@dataclass
class PdfWriter:
    """Assembles objects and emits a complete file.

    Objects are reserved before they are written, so a page can reference its
    contents and its parent before either exists. That is not a convenience: a
    PDF page tree is genuinely circular - pages name their parent and the parent
    names its pages - and a writer that could not forward-reference would have to
    buffer the whole document and patch it.
    """

    version: str = "1.7"
    _objects: dict[int, Any] = field(default_factory=dict)
    _next: int = 1

    def reserve(self) -> Reference:
        """Claim an object number without deciding its contents yet."""
        number = self._next
        self._next += 1
        return Reference(number)

    def put(self, reference: Reference, value: Any) -> Reference:
        self._objects[reference.number] = value
        return reference

    def get(self, reference: Reference) -> Any:
        """The object this reference points at, if this writer holds it.

        Needed by callers that copy a graph and then have to amend part of it -
        redaction swapping a painted image into a page's resources, for example.
        Those resources may have arrived inline or as a reference, and without
        this the caller has to guess which.
        """
        return self._objects.get(reference.number)

    def add(self, value: Any) -> Reference:
        return self.put(self.reserve(), value)

    def build(self, root: Reference, info: dict[str, Any] | None = None) -> bytes:
        """Emit the complete file.

        The metadata object, when there is one, is added *before* any offset is
        computed. An earlier draft appended it afterwards and then re-emitted to
        repair the cross-reference table it had just invalidated - which worked,
        and was exactly the kind of cleverness that hides a stale-offset bug the
        first time someone edits it.
        """
        trailer: dict[str, Any] = {"Root": root}
        if info is not None:
            trailer["Info"] = self.add(info)

        missing = sorted(n for n in range(1, self._next) if n not in self._objects)
        if missing:
            # A reserved-but-unwritten object is a dangling reference. Readers
            # differ on how they cope, which means the file might open on the
            # machine that made it and fail at the printer.
            msg = f"objects reserved but never written: {missing}"
            raise ValueError(msg)

        out = bytearray()
        out += f"%PDF-{self.version}\n".encode("ascii")
        # A comment of high bytes marks the file binary, so tools that transfer
        # it in text mode do not mangle the streams.
        out += b"%\xe2\xe3\xcf\xd3\n"

        # Offsets are recorded as each object is written, never computed
        # afterwards from lengths that might disagree with what was emitted.
        offsets: dict[int, int] = {}
        for number in sorted(self._objects):
            offsets[number] = len(out)
            out += f"{number} 0 obj\n".encode("ascii")
            value = self._objects[number]
            if isinstance(value, Stream):
                data, dictionary = value.encoded()
                out += serialise(dictionary) + b"\nstream\n" + data + b"\nendstream"
            else:
                out += serialise(value)
            out += b"\nendobj\n"

        start_xref = len(out)
        count = self._next
        out += f"xref\n0 {count}\n".encode("ascii")
        out += b"0000000000 65535 f \n"
        for number in range(1, count):
            out += f"{offsets[number]:010d} 00000 n \n".encode("ascii")

        trailer["Size"] = count
        out += b"trailer\n" + serialise(trailer) + b"\n"
        out += f"startxref\n{start_xref}\n%%EOF\n".encode("ascii")
        return bytes(out)
