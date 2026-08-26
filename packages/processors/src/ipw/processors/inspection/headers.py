"""Signature detection and header parsing for PNG and JPEG.

Hand-written rather than delegated to an imaging library, for two reasons that
matter more than convenience:

1. **Nothing is allocated.** A library that decodes first and reports dimensions
   afterwards has already committed the memory by the time you can check them.
   Reading ``IHDR`` or ``SOF`` yields exact dimensions from a few hundred bytes,
   so the safety decision happens before any pixel buffer exists. That is what
   POC-003's "caught before unsafe allocation" criterion asks for.
2. **No dependency.** The runtime licence register stays at one entry. An imaging
   library arrives with POC-004, which genuinely needs pixels, and enters the
   register with a disposition record.

Everything here is defensive: the input is untrusted, every read is bounds
checked, and a malformed file yields a :class:`HeaderParseError` rather than an
exception from deep inside a parser.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from enum import StrEnum

__all__ = [
    "SIGNATURES",
    "HeaderParseError",
    "ImageHeader",
    "SignatureKind",
    "detect_signature",
    "parse_header",
    "parse_jpeg",
    "parse_png",
]


class HeaderParseError(ValueError):
    """The bytes are not a well-formed header of the detected type."""


class SignatureKind(StrEnum):
    """What the leading bytes say the file actually is."""

    PNG = "png"
    JPEG = "jpeg"
    GIF = "gif"
    BMP = "bmp"
    TIFF = "tiff"
    WEBP = "webp"
    HEIF = "heif"
    PDF = "pdf"
    ZIP = "zip"
    UNKNOWN = "unknown"


PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

SIGNATURES: tuple[tuple[bytes, SignatureKind], ...] = (
    (PNG_MAGIC, SignatureKind.PNG),
    (b"\xff\xd8\xff", SignatureKind.JPEG),
    (b"GIF87a", SignatureKind.GIF),
    (b"GIF89a", SignatureKind.GIF),
    (b"BM", SignatureKind.BMP),
    (b"II\x2a\x00", SignatureKind.TIFF),
    (b"MM\x00\x2a", SignatureKind.TIFF),
    (b"%PDF-", SignatureKind.PDF),
    (b"PK\x03\x04", SignatureKind.ZIP),
)


def detect_signature(data: bytes) -> SignatureKind:
    """Identify a file by its leading bytes. Filenames are never consulted."""
    for magic, kind in SIGNATURES:
        if data.startswith(magic):
            return kind
    # Container formats need a second marker at a fixed offset.
    if len(data) >= 12 and data[0:4] == b"RIFF" and data[8:12] == b"WEBP":
        return SignatureKind.WEBP
    if len(data) >= 12 and data[4:8] == b"ftyp" and data[8:12] in {b"heic", b"heix", b"mif1"}:
        return SignatureKind.HEIF
    return SignatureKind.UNKNOWN


@dataclass
class ImageHeader:
    """What the header actually says, as opposed to what the manifest declares."""

    kind: SignatureKind
    width: int
    height: int
    channels: int
    bit_depth: int
    encoding: str
    has_alpha: bool = False
    interlaced: bool = False
    progressive: bool = False
    animated: bool = False
    exif_orientation: int | None = None
    colour_profile: str | None = None
    bytes_examined: int = 0
    notes: tuple[str, ...] = field(default_factory=tuple)

    @property
    def pixels(self) -> int:
        return self.width * self.height


# ---------------------------------------------------------------------- PNG --

# Colour type -> (channels, has_alpha). PNG spec, IHDR byte 9.
_PNG_COLOUR_TYPES: dict[int, tuple[int, bool]] = {
    0: (1, False),  # greyscale
    2: (3, False),  # truecolour
    3: (1, False),  # indexed; the palette expands to RGB at decode time
    4: (2, True),  # greyscale + alpha
    6: (4, True),  # truecolour + alpha
}


def parse_png(data: bytes) -> ImageHeader:
    """Parse a PNG ``IHDR``, plus enough ancillary chunks to spot risks.

    ``IHDR`` is mandatory and must be the first chunk, so 33 bytes settle
    dimensions, bit depth and colour type. Later chunks are walked only to note
    transparency, colour profile and animation - never to decode.
    """
    if not data.startswith(PNG_MAGIC):
        msg = "not a PNG: signature mismatch"
        raise HeaderParseError(msg)
    if len(data) < 33:
        msg = "truncated PNG: IHDR is incomplete"
        raise HeaderParseError(msg)

    length, tag = struct.unpack(">I4s", data[8:16])
    if tag != b"IHDR":
        msg = f"malformed PNG: first chunk is {tag!r}, expected IHDR"
        raise HeaderParseError(msg)
    if length != 13:
        msg = f"malformed PNG: IHDR length is {length}, expected 13"
        raise HeaderParseError(msg)

    width, height, bit_depth, colour_type, compression, filter_method, interlace = struct.unpack(
        ">IIBBBBB", data[16:29]
    )
    if width == 0 or height == 0:
        msg = "malformed PNG: zero dimension"
        raise HeaderParseError(msg)
    if colour_type not in _PNG_COLOUR_TYPES:
        msg = f"malformed PNG: unknown colour type {colour_type}"
        raise HeaderParseError(msg)
    if compression != 0 or filter_method != 0:
        msg = "malformed PNG: unsupported compression or filter method"
        raise HeaderParseError(msg)

    channels, has_alpha = _PNG_COLOUR_TYPES[colour_type]
    notes: list[str] = []
    colour_profile: str | None = None
    animated = False

    # Walk the remaining chunk headers only. Chunk data is skipped, never read.
    offset = 8
    examined = 33
    while offset + 8 <= len(data):
        chunk_length, chunk_tag = struct.unpack(">I4s", data[offset : offset + 8])
        if chunk_length > len(data):
            notes.append("declared chunk length exceeds the available bytes")
            break
        if chunk_tag == b"tRNS":
            has_alpha = True
            notes.append("tRNS transparency chunk present")
        elif chunk_tag == b"iCCP":
            colour_profile = "embedded-icc"
        elif chunk_tag == b"sRGB":
            colour_profile = colour_profile or "sRGB"
        elif chunk_tag == b"acTL":
            animated = True
            notes.append("APNG animation control chunk present")
        elif chunk_tag == b"IEND":
            examined = offset + 12
            break
        offset += 12 + chunk_length
        examined = min(offset, len(data))

    return ImageHeader(
        kind=SignatureKind.PNG,
        width=width,
        height=height,
        channels=channels,
        bit_depth=bit_depth,
        encoding="png-indexed" if colour_type == 3 else "png",
        has_alpha=has_alpha,
        interlaced=interlace == 1,
        animated=animated,
        colour_profile=colour_profile,
        bytes_examined=examined,
        notes=tuple(notes),
    )


# --------------------------------------------------------------------- JPEG --

# Start-of-frame markers. C4 (DHT), C8 (JPG) and CC (DAC) are not frames.
_SOF_MARKERS = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
_PROGRESSIVE_SOF = {0xC2, 0xC6, 0xCA, 0xCE}
_STANDALONE = {0xD8, 0xD9, *range(0xD0, 0xD8), 0x01}

_JPEG_ENCODING = {
    0xC0: "jpeg-baseline",
    0xC1: "jpeg-extended-sequential",
    0xC2: "jpeg-progressive",
    0xC3: "jpeg-lossless",
    0xC5: "jpeg-differential-sequential",
    0xC6: "jpeg-differential-progressive",
    0xC7: "jpeg-differential-lossless",
    0xC9: "jpeg-arithmetic-sequential",
    0xCA: "jpeg-arithmetic-progressive",
    0xCB: "jpeg-arithmetic-lossless",
    0xCD: "jpeg-differential-arithmetic-sequential",
    0xCE: "jpeg-differential-arithmetic-progressive",
    0xCF: "jpeg-differential-arithmetic-lossless",
}


def _parse_exif_orientation(payload: bytes) -> int | None:
    """Extract the orientation tag from an APP1 Exif payload.

    Returns ``None`` for anything malformed. A corrupt EXIF block is a reason to
    ignore orientation, never a reason to fail the whole inspection - malformed
    metadata is an expected condition (USER_FLOWS section 17).
    """
    if not payload.startswith(b"Exif\x00\x00"):
        return None
    tiff = payload[6:]
    if len(tiff) < 8:
        return None

    if tiff[0:2] == b"II":
        endian = "<"
    elif tiff[0:2] == b"MM":
        endian = ">"
    else:
        return None
    if struct.unpack(endian + "H", tiff[2:4])[0] != 42:
        return None

    ifd_offset = struct.unpack(endian + "I", tiff[4:8])[0]
    if ifd_offset + 2 > len(tiff):
        return None

    entry_count = struct.unpack(endian + "H", tiff[ifd_offset : ifd_offset + 2])[0]
    # A plausible IFD holds tens of entries; a huge count means corruption.
    if entry_count > 512:
        return None

    for index in range(entry_count):
        start = ifd_offset + 2 + index * 12
        if start + 12 > len(tiff):
            return None
        tag, value_type, count = struct.unpack(endian + "HHI", tiff[start : start + 8])
        if tag != 0x0112:
            continue
        if value_type != 3 or count != 1:  # SHORT, single value
            return None
        value = struct.unpack(endian + "H", tiff[start + 8 : start + 10])[0]
        return value if 1 <= value <= 8 else None
    return None


def parse_jpeg(data: bytes) -> ImageHeader:
    """Walk JPEG segments to the start-of-frame, reading no entropy-coded data.

    Segment walking is strictly bounded: every length is validated against the
    buffer before it is used to advance, so a corrupt length cannot drive an
    out-of-range read or an unbounded loop.
    """
    if not data.startswith(b"\xff\xd8"):
        msg = "not a JPEG: SOI marker missing"
        raise HeaderParseError(msg)

    offset = 2
    orientation: int | None = None
    colour_profile: str | None = None
    notes: list[str] = []

    while offset + 4 <= len(data):
        if data[offset] != 0xFF:
            msg = f"malformed JPEG: expected a marker at byte {offset}"
            raise HeaderParseError(msg)

        marker = data[offset + 1]
        # 0xFF fill bytes are legal padding before a marker.
        while marker == 0xFF and offset + 2 < len(data):
            offset += 1
            marker = data[offset + 1]

        if marker in _STANDALONE:
            offset += 2
            continue
        if marker == 0xDA:  # start of scan: entropy data follows, stop here
            notes.append("stopped at SOS without reading entropy-coded data")
            break

        if offset + 4 > len(data):
            msg = "truncated JPEG: segment length is incomplete"
            raise HeaderParseError(msg)
        segment_length = struct.unpack(">H", data[offset + 2 : offset + 4])[0]
        if segment_length < 2:
            msg = f"malformed JPEG: segment length {segment_length} at byte {offset}"
            raise HeaderParseError(msg)

        payload_start = offset + 4
        payload_end = offset + 2 + segment_length
        if payload_end > len(data):
            msg = "truncated JPEG: segment extends beyond the available bytes"
            raise HeaderParseError(msg)
        payload = data[payload_start:payload_end]

        if marker == 0xE1:
            orientation = orientation or _parse_exif_orientation(payload)
        elif marker == 0xE2 and payload.startswith(b"ICC_PROFILE\x00"):
            colour_profile = "embedded-icc"
        elif marker in _SOF_MARKERS:
            if len(payload) < 6:
                msg = "malformed JPEG: start-of-frame payload is too short"
                raise HeaderParseError(msg)
            precision, height, width, components = struct.unpack(">BHHB", payload[0:6])
            if width == 0 or height == 0:
                msg = "malformed JPEG: zero dimension"
                raise HeaderParseError(msg)
            if components == 0 or components > 4:
                msg = f"malformed JPEG: {components} colour components"
                raise HeaderParseError(msg)
            return ImageHeader(
                kind=SignatureKind.JPEG,
                width=width,
                height=height,
                channels=components,
                bit_depth=precision,
                encoding=_JPEG_ENCODING.get(marker, f"jpeg-unknown-{marker:02x}"),
                has_alpha=False,  # JPEG has no alpha channel
                progressive=marker in _PROGRESSIVE_SOF,
                exif_orientation=orientation,
                colour_profile=colour_profile,
                bytes_examined=payload_end,
                notes=tuple(notes),
            )

        offset = payload_end

    msg = "malformed JPEG: no start-of-frame segment found"
    raise HeaderParseError(msg)


def parse_header(kind: SignatureKind, data: bytes) -> ImageHeader:
    """Dispatch to the parser for a detected signature."""
    if kind is SignatureKind.PNG:
        return parse_png(data)
    if kind is SignatureKind.JPEG:
        return parse_jpeg(data)
    msg = f"no header parser for {kind.value}"
    raise HeaderParseError(msg)
