"""Placing an image into a PDF without degrading it.

The single most consequential decision in this package: **a JPEG is embedded
byte-for-byte, never re-encoded.**

PDF's ``DCTDecode`` filter *is* JPEG. A JPEG can therefore be dropped into a PDF
untouched, and every reader will decode it correctly. The alternative - decode to
pixels, re-encode on the way out - is what most naive image-to-PDF code does, and
it requantises: a second lossy pass over data that has already lost information
once. On a photograph the difference is subtle. On the flat colour and hard line
work of a textile print it shows as ringing along every edge, which is precisely
the "even small minute lines" the material has to preserve.

So the rule here is that bytes pass through whenever the format allows it, and the
only images that get re-encoded are those PDF cannot carry directly.

**Effective DPI is computed, never claimed.** An image has pixels; a page has
physical size. The resolution a printer actually sees is one divided by the other,
and it changes every time the placement changes. Storing a DPI on the image would
be storing an assertion that goes stale the moment someone drags a corner, so it
is derived from the placement at the point of use.
"""

from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass
from pathlib import Path

from ipw.pdf.objects import Name, Stream

__all__ = ["EmbeddedImage", "PlacedImage", "effective_dpi", "embed_image"]

# Marker segments that carry a JPEG's frame header, and so its true dimensions
# and component count. SOF0/1/2 are baseline, extended and progressive; the rest
# are arithmetic-coded or hierarchical variants nobody produces but which are
# read the same way.
_SOF_MARKERS = {
    0xC0,
    0xC1,
    0xC2,
    0xC3,
    0xC5,
    0xC6,
    0xC7,
    0xC9,
    0xCA,
    0xCB,
    0xCD,
    0xCE,
    0xCF,
}


@dataclass(frozen=True)
class EmbeddedImage:
    """An image ready to become a PDF XObject."""

    stream: Stream
    width: int
    height: int
    colour_space: str
    bits: int
    source_format: str
    reencoded: bool
    """True when the pixels were decoded and written again.

    Reported so an export can say honestly whether a generation of quality was
    spent. A print-ready export refuses to spend one silently.
    """
    smask: Stream | None = None
    """Soft mask carrying the alpha channel, when the source had one.

    PDF has no notion of an RGBA image; transparency is a separate greyscale
    image referenced by the colour image. Flattening onto white instead - the
    common shortcut - destroys exactly the cut-out a designer needs when placing
    artwork over a coloured garment.
    """


@dataclass(frozen=True)
class PlacedImage:
    """An image positioned on a page, in points from the bottom-left."""

    image: EmbeddedImage
    x: float
    y: float
    width: float
    height: float
    rotation: int = 0


def _jpeg_frame(data: bytes) -> tuple[int, int, int] | None:
    """Read width, height and component count from a JPEG's frame header.

    Walks the marker segments rather than decoding. A JPEG that cannot be read
    this way is one this function refuses to embed blind - returning None sends
    it down the re-encode path, which is slower and lossy but always correct.
    """
    if data[:2] != b"\xff\xd8":
        return None
    offset = 2
    end = len(data)
    while offset < end - 1:
        if data[offset] != 0xFF:
            offset += 1
            continue
        marker = data[offset + 1]
        offset += 2
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            continue
        if marker == 0xD9 or offset + 2 > end:
            break
        (length,) = struct.unpack(">H", data[offset : offset + 2])
        if marker in _SOF_MARKERS:
            if offset + 8 > end:
                return None
            precision, height, width, components = struct.unpack(
                ">BHHB", data[offset + 2 : offset + 8]
            )
            if precision != 8:
                # 12-bit JPEG is legal and almost nothing renders it. Re-encoding
                # is the honest answer.
                return None
            return width, height, components
        offset += length
    return None


def embed_image(path: Path) -> EmbeddedImage:
    """Prepare an image for a PDF, passing bytes through where possible."""
    data = path.read_bytes()

    frame = _jpeg_frame(data)
    if frame is not None:
        width, height, components = frame
        colour_space = {1: "DeviceGray", 3: "DeviceRGB", 4: "DeviceCMYK"}.get(components)
        if colour_space is not None:
            # The good path: the JPEG goes in exactly as it arrived.
            dictionary = {
                "Type": Name("XObject"),
                "Subtype": Name("Image"),
                "Width": width,
                "Height": height,
                "ColorSpace": Name(colour_space),
                "BitsPerComponent": 8,
            }
            if colour_space == "DeviceCMYK":
                # Adobe-produced CMYK JPEGs store inverted values; without this
                # the page prints as a colour negative.
                dictionary["Decode"] = [1, 0, 1, 0, 1, 0, 1, 0]
            return EmbeddedImage(
                stream=Stream(dictionary, data, compress=False, filters=("DCTDecode",)),
                width=width,
                height=height,
                colour_space=colour_space,
                bits=8,
                source_format="jpeg",
                reencoded=False,
            )

    return _reencode(path)


def _reencode(path: Path) -> EmbeddedImage:
    """Decode and write again, for formats PDF cannot carry directly.

    PNG is the common case. Its own compression is zlib over filtered scanlines,
    which is nearly what PDF's ``FlateDecode`` wants but not exactly, and matching
    the predictor settings byte for byte is fragile enough that decoding is the
    safer trade. The pixels survive intact - PNG is lossless in and Flate is
    lossless out - so `reencoded` here means "re-packed", not "degraded".
    """
    from PIL import Image

    with Image.open(path) as handle:
        handle.load()
        # Widened deliberately: the conversions below return Image, not the
        # ImageFile that open() hands back.
        source: Image.Image = handle
        alpha: bytes | None = None

        if source.mode in ("RGBA", "LA", "P"):
            converted = source.convert("RGBA")
            alpha = converted.getchannel("A").tobytes()
            # A fully opaque alpha channel is not transparency; carrying it would
            # add a soft mask to every screenshot for nothing.
            if all(byte == 255 for byte in alpha[:4096]) and set(alpha) == {255}:
                alpha = None
            source = converted.convert("RGB")
        elif source.mode not in ("RGB", "L", "CMYK"):
            source = source.convert("RGB")

        width, height = source.size
        colour_space = {"RGB": "DeviceRGB", "L": "DeviceGray", "CMYK": "DeviceCMYK"}[source.mode]
        pixels = source.tobytes()

    stream = Stream(
        {
            "Type": Name("XObject"),
            "Subtype": Name("Image"),
            "Width": width,
            "Height": height,
            "ColorSpace": Name(colour_space),
            "BitsPerComponent": 8,
        },
        pixels,
    )

    smask = None
    if alpha is not None:
        smask = Stream(
            {
                "Type": Name("XObject"),
                "Subtype": Name("Image"),
                "Width": width,
                "Height": height,
                "ColorSpace": Name("DeviceGray"),
                "BitsPerComponent": 8,
            },
            zlib.compress(alpha, 9),
            compress=False,
            filters=("FlateDecode",),
        )

    return EmbeddedImage(
        stream=stream,
        width=width,
        height=height,
        colour_space=colour_space,
        bits=8,
        source_format=path.suffix.lstrip(".").lower() or "unknown",
        reencoded=True,
        smask=smask,
    )


def effective_dpi(image: EmbeddedImage, placed_width_pt: float, placed_height_pt: float) -> int:
    """The resolution a printer will actually see, in dots per inch.

    Derived from the placement rather than read from the file, because it is a
    property of the pair. The same 1000-pixel image is 500 DPI on a two-inch card
    and 55 DPI across an eighteen-inch panel, and only the second one is a
    problem worth warning about.

    The lower of the two axes is returned: a placement is only as good as its
    worst direction.
    """
    if placed_width_pt <= 0 or placed_height_pt <= 0:
        return 0
    horizontal = image.width / (placed_width_pt / 72.0)
    vertical = image.height / (placed_height_pt / 72.0)
    return int(min(horizontal, vertical))
