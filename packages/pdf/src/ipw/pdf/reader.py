"""Reading an existing PDF.

Reading is much harder than writing, because writing only has to produce one
shape and reading has to accept every shape twenty-five years of producers have
emitted. This handles what is actually in the wild:

* classic cross-reference tables, with any line-ending convention;
* cross-reference **streams** (PDF 1.5+), which most modern producers emit;
* **object streams**, where many small objects are packed into one compressed
  stream and have no byte offset of their own;
* incremental updates, where a file has several cross-reference sections chained
  by ``/Prev`` and later ones override earlier ones;
* ``FlateDecode`` with PNG predictors, ``ASCIIHexDecode``, ``ASCII85Decode`` and
  ``RunLengthDecode``.

**Objects are resolved on demand.** A twenty-megabyte file has thousands of
objects and a page operation touches a handful. Parsing everything up front would
turn "how many pages is this?" into a multi-second wait for no reason.

**What this deliberately does not do is render.** Turning a page into pixels means
implementing font rasterisation, path filling, shading, blend modes and colour
management - a viewer, not a feature. PRODUCT_REQUIREMENTS.md section 19 asks for
existing PDF content to be edited "only when technically supported, with honest
limitations", and the honest limitation is that page-level work (merge, split,
reorder, rotate, overlay, extract) is fully supported while re-flowing someone
else's vector text is not.
"""

from __future__ import annotations

import re
import zlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ipw.pdf.objects import Name, Reference

__all__ = ["PdfPage", "PdfReader", "PdfSyntaxError", "decode_stream"]

_WHITESPACE = b"\x00\t\n\x0c\r "
_DELIMITERS = b"()<>[]{}/%"


class PdfSyntaxError(ValueError):
    """The file does not parse. Carries where, because "invalid PDF" helps nobody."""


@dataclass
class RawStream:
    """A stream object: its dictionary and its still-encoded bytes."""

    dictionary: dict[str, Any]
    data: bytes

    def decoded(self) -> bytes:
        return decode_stream(self.dictionary, self.data)


@dataclass
class PdfPage:
    """One page of an existing document."""

    number: int
    reference: Reference
    dictionary: dict[str, Any]
    width: float
    height: float
    rotation: int = 0

    @property
    def inches(self) -> tuple[float, float]:
        return (self.width / 72.0, self.height / 72.0)

    @property
    def label(self) -> str:
        w, h = self.inches
        return f"{w:.2f} x {h:.2f} in"


# ------------------------------------------------------------------ filters --


def _apply_predictor(data: bytes, params: dict[str, Any]) -> bytes:
    """Undo the PNG predictor some producers apply before Flate.

    Without this an xref stream decodes to plausible-looking nonsense and the
    file appears to have thousands of objects at impossible offsets - which is a
    far more confusing failure than a clean parse error.
    """
    predictor = int(params.get("Predictor", 1) or 1)
    if predictor < 10:
        return data

    columns = int(params.get("Columns", 1) or 1)
    colors = int(params.get("Colors", 1) or 1)
    bpc = int(params.get("BitsPerComponent", 8) or 8)
    sample = max(1, (colors * bpc) // 8)
    row_length = columns * sample

    out = bytearray()
    previous = bytearray(row_length)
    position = 0
    while position + 1 + row_length <= len(data) + row_length:
        if position >= len(data):
            break
        tag = data[position]
        row = bytearray(data[position + 1 : position + 1 + row_length])
        position += 1 + row_length
        if len(row) < row_length:
            row.extend(b"\0" * (row_length - len(row)))

        if tag == 1:  # Sub
            for i in range(sample, row_length):
                row[i] = (row[i] + row[i - sample]) & 0xFF
        elif tag == 2:  # Up
            for i in range(row_length):
                row[i] = (row[i] + previous[i]) & 0xFF
        elif tag == 3:  # Average
            for i in range(row_length):
                left = row[i - sample] if i >= sample else 0
                row[i] = (row[i] + ((left + previous[i]) >> 1)) & 0xFF
        elif tag == 4:  # Paeth
            for i in range(row_length):
                left = row[i - sample] if i >= sample else 0
                up = previous[i]
                upper_left = previous[i - sample] if i >= sample else 0
                p = left + up - upper_left
                pa, pb, pc = abs(p - left), abs(p - up), abs(p - upper_left)
                nearest = left if (pa <= pb and pa <= pc) else (up if pb <= pc else upper_left)
                row[i] = (row[i] + nearest) & 0xFF

        out += row
        previous = row
    return bytes(out)


def _ascii85(data: bytes) -> bytes:
    import base64

    body = data.split(b"~>")[0].replace(b"<~", b"")
    return base64.a85decode(body, adobe=False)


def _runlength(data: bytes) -> bytes:
    out = bytearray()
    index = 0
    while index < len(data):
        length = data[index]
        index += 1
        if length == 128:
            break
        if length < 128:
            out += data[index : index + length + 1]
            index += length + 1
        else:
            if index >= len(data):
                break
            out += bytes([data[index]]) * (257 - length)
            index += 1
    return bytes(out)


# Filters that mean "this is an image in its own right". They are left encoded:
# a DCTDecode stream *is* a JPEG, and decoding it just to re-encode it later is
# the quality loss this whole package exists to avoid.
IMAGE_FILTERS = {"DCTDecode", "JPXDecode", "JBIG2Decode", "CCITTFaxDecode"}


def decode_stream(dictionary: dict[str, Any], data: bytes) -> bytes:
    """Apply the stream's filters, stopping at an image filter."""
    filters = dictionary.get("Filter")
    if filters is None:
        return data
    if isinstance(filters, Name):
        filters = [filters]
    params = dictionary.get("DecodeParms") or dictionary.get("DP") or {}
    if isinstance(params, dict):
        params = [params]
    if not isinstance(params, list):
        params = [{}]

    for index, entry in enumerate(filters):
        name = entry.value if isinstance(entry, Name) else str(entry)
        if name in IMAGE_FILTERS:
            return data
        parameters = (
            params[index] if index < len(params) and isinstance(params[index], dict) else {}
        )
        if name in ("FlateDecode", "Fl"):
            try:
                data = zlib.decompress(data)
            except zlib.error:
                # Some producers emit a stream with trailing rubbish, or truncate
                # the final block. Salvaging what decompresses is better than
                # failing the whole document for one damaged object.
                decompressor = zlib.decompressobj()
                try:
                    data = decompressor.decompress(data)
                except zlib.error as exc:
                    msg = f"stream will not inflate: {exc}"
                    raise PdfSyntaxError(msg) from exc
            data = _apply_predictor(data, parameters)
        elif name in ("ASCIIHexDecode", "AHx"):
            body = data.split(b">")[0]
            data = bytes.fromhex(re.sub(rb"[^0-9A-Fa-f]", b"", body).decode("ascii"))
        elif name in ("ASCII85Decode", "A85"):
            data = _ascii85(data)
        elif name in ("RunLengthDecode", "RL"):
            data = _runlength(data)
        else:
            msg = f"unsupported stream filter /{name}"
            raise PdfSyntaxError(msg)
    return data


# ------------------------------------------------------------------- parser --


class _Lexer:
    """Parses PDF syntax from a buffer at a position."""

    def __init__(self, data: bytes, position: int = 0) -> None:
        self.data = data
        self.position = position

    def skip_space(self) -> None:
        data, size = self.data, len(self.data)
        while self.position < size:
            byte = data[self.position]
            if byte in _WHITESPACE:
                self.position += 1
            elif byte == 0x25:  # '%' comment runs to end of line
                while self.position < size and data[self.position] not in b"\r\n":
                    self.position += 1
            else:
                return

    def parse(self) -> Any:
        self.skip_space()
        if self.position >= len(self.data):
            msg = "unexpected end of file"
            raise PdfSyntaxError(msg)

        byte = self.data[self.position]

        if byte == 0x2F:  # /Name
            return Name(self._read_name())
        if byte == 0x28:  # (string)
            return self._read_literal_string()
        if byte == 0x3C:  # << dict >> or <hex>
            if self.data[self.position : self.position + 2] == b"<<":
                return self._read_dictionary()
            return self._read_hex_string()
        if byte == 0x5B:  # [array]
            self.position += 1
            items: list[Any] = []
            while True:
                self.skip_space()
                if self.position >= len(self.data):
                    msg = "unterminated array"
                    raise PdfSyntaxError(msg)
                if self.data[self.position] == 0x5D:
                    self.position += 1
                    return items
                items.append(self.parse())
        if byte == 0x5D or byte == 0x3E:
            msg = f"unexpected {chr(byte)!r} at {self.position}"
            raise PdfSyntaxError(msg)

        token = self.read_token()
        if token == b"true":
            return True
        if token == b"false":
            return False
        if token == b"null":
            return None

        # "12 0 R" is a reference; "12 0 obj" starts one. Both begin with two
        # integers, so the third token decides and must be looked at before
        # committing to a plain number.
        if re.fullmatch(rb"[+-]?\d+", token):
            save = self.position
            self.skip_space()
            second = self.read_token()
            if re.fullmatch(rb"\d+", second):
                self.skip_space()
                third = self.read_token()
                if third == b"R":
                    return Reference(int(token), int(second))
            self.position = save
            return int(token)

        if re.fullmatch(rb"[+-]?(\d*\.\d*|\d+)", token):
            try:
                return float(token)
            except ValueError:
                return 0.0

        msg = f"cannot parse token {token!r} at {self.position}"
        raise PdfSyntaxError(msg)

    def read_token(self) -> bytes:
        start = self.position
        data, size = self.data, len(self.data)
        while self.position < size:
            byte = data[self.position]
            if byte in _WHITESPACE or byte in _DELIMITERS:
                break
            self.position += 1
        if start == self.position:
            self.position += 1
        return data[start : self.position]

    def _read_name(self) -> str:
        self.position += 1
        start = self.position
        data, size = self.data, len(self.data)
        while self.position < size:
            byte = data[self.position]
            if byte in _WHITESPACE or byte in _DELIMITERS:
                break
            self.position += 1
        raw = data[start : self.position]
        # #xx escapes are legal in names and appear in real files.
        return re.sub(rb"#([0-9A-Fa-f]{2})", lambda m: bytes([int(m.group(1), 16)]), raw).decode(
            "latin-1"
        )

    def _read_literal_string(self) -> str:
        self.position += 1
        out = bytearray()
        depth = 1
        data, size = self.data, len(self.data)
        while self.position < size:
            byte = data[self.position]
            self.position += 1
            if byte == 0x5C:  # backslash
                if self.position >= size:
                    break
                nxt = data[self.position]
                self.position += 1
                mapping = {0x6E: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12}
                if nxt in mapping:
                    out.append(mapping[nxt])
                elif 0x30 <= nxt <= 0x37:
                    digits = chr(nxt)
                    for _ in range(2):
                        if self.position < size and 0x30 <= data[self.position] <= 0x37:
                            digits += chr(data[self.position])
                            self.position += 1
                    out.append(int(digits, 8) & 0xFF)
                elif nxt not in b"\r\n":
                    out.append(nxt)
            elif byte == 0x28:
                depth += 1
                out.append(byte)
            elif byte == 0x29:
                depth -= 1
                if depth == 0:
                    break
                out.append(byte)
            else:
                out.append(byte)
        return bytes(out).decode("latin-1")

    def _read_hex_string(self) -> str:
        self.position += 1
        end = self.data.index(b">", self.position)
        body = re.sub(rb"[^0-9A-Fa-f]", b"", self.data[self.position : end])
        self.position = end + 1
        if len(body) % 2:
            body += b"0"
        return bytes.fromhex(body.decode("ascii")).decode("latin-1")

    def _read_dictionary(self) -> dict[str, Any]:
        self.position += 2
        out: dict[str, Any] = {}
        while True:
            self.skip_space()
            if self.data[self.position : self.position + 2] == b">>":
                self.position += 2
                return out
            if self.position >= len(self.data):
                msg = "unterminated dictionary"
                raise PdfSyntaxError(msg)
            key = self.parse()
            if not isinstance(key, Name):
                msg = f"dictionary key is not a name: {key!r}"
                raise PdfSyntaxError(msg)
            out[key.value] = self.parse()


# ------------------------------------------------------------------- reader --


@dataclass
class PdfReader:
    """An existing PDF, parsed on demand."""

    data: bytes
    _offsets: dict[int, int] = field(default_factory=dict)
    _in_object_stream: dict[int, tuple[int, int]] = field(default_factory=dict)
    _cache: dict[int, Any] = field(default_factory=dict)
    _page_cache: list[PdfPage] | None = field(default=None, repr=False)
    trailer: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_path(cls, path: Path) -> PdfReader:
        return cls.from_bytes(path.read_bytes())

    @classmethod
    def from_bytes(cls, data: bytes) -> PdfReader:
        if not data.startswith(b"%PDF-"):
            msg = "not a PDF: the file does not begin with %PDF-"
            raise PdfSyntaxError(msg)
        reader = cls(data=data)
        reader._load_xref()
        if b"/Encrypt" in data and "Encrypt" in reader.trailer:
            msg = (
                "this PDF is encrypted. Page operations need the password, which "
                "the workspace does not ask for yet."
            )
            raise PdfSyntaxError(msg)
        # Walk the page tree now rather than on first use. A reader that
        # constructs successfully and then fails on `.pages()` pushes the error
        # somewhere no one is prepared to handle it; failing here means an
        # upload is either accepted or explained, never accepted-then-broken.
        # The walk is cached, so this costs nothing overall.
        reader.pages()
        return reader

    # ------------------------------------------------------------ xref ------

    def _load_xref(self) -> None:
        # The *last* startxref, not the first. Saving a PDF after the first time
        # appends a new body and a new table rather than rewriting the file, so
        # an edited document ends with several startxref markers and only the
        # final one names the current table. Taking the first works on large
        # files purely by accident - the earlier markers fall outside this
        # window - and silently opens small edited files at their previous
        # state, showing a form before it was filled in or a contract before it
        # was amended.
        window = self.data[-2048:]
        markers = list(re.finditer(rb"startxref\s+(\d+)", window))
        if not markers:
            self._rebuild_by_scanning()
            return
        marker = markers[-1]
        try:
            self._read_xref_section(int(marker.group(1)), set())
        except (PdfSyntaxError, ValueError, KeyError, IndexError):
            # A damaged table is common in files that have been through many
            # tools. Scanning for objects recovers almost all of them, and a
            # recovered document is worth far more to a customer than a refusal.
            self._rebuild_by_scanning()

        if not self._offsets and not self._in_object_stream:
            self._rebuild_by_scanning()

    def _read_xref_section(self, offset: int, seen: set[int]) -> None:
        if offset in seen or offset <= 0 or offset >= len(self.data):
            return
        seen.add(offset)

        lexer = _Lexer(self.data, offset)
        lexer.skip_space()

        if self.data[lexer.position : lexer.position + 4] == b"xref":
            trailer = self._read_classic_xref(lexer)
        else:
            trailer = self._read_xref_stream(offset)

        for key, value in trailer.items():
            self.trailer.setdefault(key, value)

        # A hybrid file carries both; both must be followed or objects go missing.
        for key in ("XRefStm", "Prev"):
            if key in trailer and isinstance(trailer[key], (int, float)):
                self._read_xref_section(int(trailer[key]), seen)

    def _read_classic_xref(self, lexer: _Lexer) -> dict[str, Any]:
        lexer.position += 4
        while True:
            lexer.skip_space()
            if self.data[lexer.position : lexer.position + 7] == b"trailer":
                lexer.position += 7
                parsed = lexer.parse()
                return parsed if isinstance(parsed, dict) else {}

            header = re.match(rb"(\d+)\s+(\d+)", self.data[lexer.position : lexer.position + 48])
            if header is None:
                return {}
            start, count = int(header.group(1)), int(header.group(2))
            lexer.position += header.end()
            lexer.skip_space()

            for index in range(count):
                entry = self.data[lexer.position : lexer.position + 20]
                fields = re.match(rb"(\d{10})\s(\d{5})\s([nf])", entry)
                if fields is None:
                    break
                if fields.group(3) == b"n":
                    # Earlier sections must not override later ones.
                    self._offsets.setdefault(start + index, int(fields.group(1)))
                # Entries are nominally 20 bytes, but files with \n endings use
                # 19. Advancing by what was matched plus its trailing space is
                # the only thing that works for both.
                lexer.position += fields.end()
                lexer.skip_space()

    def _read_xref_stream(self, offset: int) -> dict[str, Any]:
        number, _generation, value = self._parse_object_at(offset)
        if not isinstance(value, RawStream):
            msg = f"object at {offset} is not a cross-reference stream"
            raise PdfSyntaxError(msg)

        dictionary = value.dictionary
        widths = [int(w) for w in dictionary.get("W", [1, 1, 1])]
        size = int(dictionary.get("Size", 0))
        index = dictionary.get("Index") or [0, size]
        payload = value.decoded()

        position = 0
        row = sum(widths)
        for pair in range(0, len(index) - 1, 2):
            start, count = int(index[pair]), int(index[pair + 1])
            for entry in range(count):
                if position + row > len(payload):
                    break
                fields = []
                for width in widths:
                    fields.append(
                        int.from_bytes(payload[position : position + width], "big") if width else 1
                    )
                    position += width
                kind, second, third = ([*fields, 0, 0, 0])[:3]
                object_number = start + entry
                if kind == 1:
                    self._offsets.setdefault(object_number, second)
                elif kind == 2:
                    self._in_object_stream.setdefault(object_number, (second, third))
        del number
        return dictionary

    def _rebuild_by_scanning(self) -> None:
        """Find objects by looking for them, when the table cannot be trusted."""
        for match in re.finditer(rb"(?:^|[\r\n\s])(\d+)\s+(\d+)\s+obj\b", self.data):
            self._offsets[int(match.group(1))] = match.start(1)
        if not self.trailer:
            for match in re.finditer(rb"trailer", self.data):
                try:
                    parsed = _Lexer(self.data, match.end()).parse()
                except PdfSyntaxError:
                    continue
                if isinstance(parsed, dict):
                    self.trailer.update(parsed)
            if "Root" not in self.trailer:
                catalog = re.search(rb"(\d+)\s+\d+\s+obj\s*<<[^>]*?/Type\s*/Catalog", self.data)
                if catalog:
                    self.trailer["Root"] = Reference(int(catalog.group(1)))

    # ---------------------------------------------------------- objects ------

    def _parse_object_at(self, offset: int) -> tuple[int, int, Any]:
        lexer = _Lexer(self.data, offset)
        lexer.skip_space()
        header = re.match(rb"(\d+)\s+(\d+)\s+obj", self.data[lexer.position : lexer.position + 32])
        if header is None:
            msg = f"no object header at {offset}"
            raise PdfSyntaxError(msg)
        lexer.position += header.end()
        value = lexer.parse()

        lexer.skip_space()
        if self.data[lexer.position : lexer.position + 6] == b"stream":
            lexer.position += 6
            if self.data[lexer.position : lexer.position + 2] == b"\r\n":
                lexer.position += 2
            elif self.data[lexer.position : lexer.position + 1] in (b"\n", b"\r"):
                lexer.position += 1

            length = self.resolve(value.get("Length")) if isinstance(value, dict) else 0
            start = lexer.position
            if not isinstance(length, int) or length < 0 or start + length > len(self.data):
                # A wrong /Length is common enough that guessing from the
                # endstream keyword is the pragmatic answer, not a fallback.
                end = self.data.find(b"endstream", start)
                length = max(0, (end if end >= 0 else len(self.data)) - start)
            payload = self.data[start : start + length]
            if isinstance(value, dict):
                value = RawStream(value, payload)

        return int(header.group(1)), int(header.group(2)), value

    def object(self, number: int) -> Any:
        """The object with this number, parsed once and cached."""
        if number in self._cache:
            return self._cache[number]

        value: Any = None
        if number in self._offsets:
            try:
                _n, _g, value = self._parse_object_at(self._offsets[number])
            except PdfSyntaxError:
                value = None
        elif number in self._in_object_stream:
            value = self._from_object_stream(number)

        self._cache[number] = value
        return value

    def _from_object_stream(self, number: int) -> Any:
        container, _index = self._in_object_stream[number]
        stream = self.object(container)
        if not isinstance(stream, RawStream):
            return None
        payload = stream.decoded()
        count = int(self.resolve(stream.dictionary.get("N", 0)) or 0)
        first = int(self.resolve(stream.dictionary.get("First", 0)) or 0)

        header = _Lexer(payload, 0)
        pairs: list[tuple[int, int]] = []
        for _ in range(count):
            header.skip_space()
            object_number = header.read_token()
            header.skip_space()
            offset = header.read_token()
            try:
                pairs.append((int(object_number), int(offset)))
            except ValueError:
                break

        for candidate, offset_in_stream in pairs:
            if candidate == number:
                return _Lexer(payload, first + offset_in_stream).parse()
        return None

    def resolve(self, value: Any) -> Any:
        """Follow a reference, however many hops it takes."""
        seen = 0
        while isinstance(value, Reference):
            value = self.object(value.number)
            seen += 1
            if seen > 32:
                # A reference loop is malformed, and chasing it forever is worse
                # than reporting nothing.
                return None
        return value

    # ------------------------------------------------------------ pages ------

    @property
    def catalog(self) -> dict[str, Any]:
        root = self.resolve(self.trailer.get("Root"))
        return root if isinstance(root, dict) else {}

    def pages(self) -> list[PdfPage]:
        """Every page, in order, with inherited attributes applied.

        ``MediaBox``, ``Resources`` and ``Rotate`` may be set on any node of the
        page tree and inherited downward. A reader that only looks at the page
        itself gets the size wrong on any document whose producer hoisted them,
        which is most of them.
        """
        if self._page_cache is not None:
            return self._page_cache

        node = self.resolve(self.catalog.get("Pages"))
        found: list[PdfPage] = []
        if isinstance(node, dict):
            self._walk(node, {}, found, set())
        if not found:
            found = self._pages_by_scanning()
        if not found:
            # Recovering a damaged file beats refusing it, which is why every
            # step above falls back rather than raising. Recovering *nothing*
            # is not recovery though, and returning an empty list here would be
            # the worst outcome of all: a truncated upload would open as an
            # empty document, and merging it would silently drop it. A PDF with
            # no pages is not a document, so say so.
            msg = "this PDF is damaged: no pages could be read from it"
            raise PdfSyntaxError(msg)
        self._page_cache = found
        return found

    def _walk(
        self,
        node: dict[str, Any],
        inherited: dict[str, Any],
        found: list[PdfPage],
        seen: set[int],
    ) -> None:
        merged = dict(inherited)
        for key in ("MediaBox", "Resources", "Rotate", "CropBox"):
            if key in node:
                merged[key] = node[key]

        kind = node.get("Type")
        kind_name = kind.value if isinstance(kind, Name) else None

        if kind_name == "Page" or ("Kids" not in node and "Contents" in node):
            found.append(self._page_from(node, merged, len(found) + 1))
            return

        for kid in self.resolve(node.get("Kids")) or []:
            if isinstance(kid, Reference):
                if kid.number in seen:
                    continue  # a cycle in the page tree; ignore the repeat
                seen.add(kid.number)
            child = self.resolve(kid)
            if isinstance(child, dict):
                self._walk(child, merged, found, seen)

    def _page_from(self, node: dict[str, Any], inherited: dict[str, Any], number: int) -> PdfPage:
        box = self.resolve(node.get("MediaBox") or inherited.get("MediaBox")) or [0, 0, 612, 792]
        values = [float(self.resolve(v) or 0) for v in box]
        width = abs(values[2] - values[0])
        height = abs(values[3] - values[1])
        rotation = int(self.resolve(node.get("Rotate") or inherited.get("Rotate")) or 0) % 360
        if rotation in (90, 270):
            width, height = height, width
        return PdfPage(
            number=number,
            reference=Reference(0),
            dictionary={**inherited, **node},
            width=width,
            height=height,
            rotation=rotation,
        )

    def _pages_by_scanning(self) -> list[PdfPage]:
        """Last resort: find page objects directly.

        Used when the catalogue or page tree is unusable. Order comes from object
        number, which is usually but not always document order - so it is a
        recovery path, not a preference.
        """
        found: list[PdfPage] = []
        for number in sorted(self._offsets):
            value = self.object(number)
            if isinstance(value, dict):
                kind = value.get("Type")
                if isinstance(kind, Name) and kind.value == "Page":
                    found.append(self._page_from(value, {}, len(found) + 1))
        return found

    # ----------------------------------------------------------- summary ------

    def describe(self) -> dict[str, Any]:
        """What the application shows about an imported file."""
        pages = self.pages()
        info = self.resolve(self.trailer.get("Info"))
        info = info if isinstance(info, dict) else {}
        sizes = sorted({(round(p.width, 1), round(p.height, 1)) for p in pages})
        return {
            "page_count": len(pages),
            "pages": [
                {
                    "number": page.number,
                    "width_inches": round(page.inches[0], 2),
                    "height_inches": round(page.inches[1], 2),
                    "rotation": page.rotation,
                    "label": page.label,
                }
                for page in pages
            ],
            "uniform_size": len(sizes) <= 1,
            "producer": str(info.get("Producer", "") or ""),
            "creator": str(info.get("Creator", "") or ""),
            "title": str(info.get("Title", "") or ""),
            "version": self.data[5:8].decode("latin-1", "replace"),
            "object_count": len(self._offsets) + len(self._in_object_stream),
        }
