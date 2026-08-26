"""Generate the POC-003 inspection fixtures. Deterministic, stdlib only.

These are hand-built so that POC-003 needs no imaging dependency. Every file is a
pure function of this script, byte-reproducible on any platform, and rights-clear
because it was generated here.

The JPEG is a genuine baseline JPEG: SOI, JFIF, one quantisation table, SOF0, the
standard Annex K luminance Huffman tables, SOS, and a complete entropy-coded
segment (four 8x8 blocks, each a zero DC difference followed by end-of-block),
then EOI. It is uniform mid-grey.

Honest limitation: it is verified against this repository's own header parser and
by structural inspection. It has **not** been round-tripped through a third-party
decoder, because POC-003 deliberately has no imaging dependency. POC-004 will
confirm it decodes when an imaging library enters the licence register.

    python tools/make_inspection_fixtures.py            # write
    python tools/make_inspection_fixtures.py --check    # verify reproducibility
"""

from __future__ import annotations

import argparse
import hashlib
import struct
import sys
import zlib
from pathlib import Path

# --------------------------------------------------------------------- PNG --

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def _chunk(tag: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + tag
        + payload
        + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
    )


def _stored_deflate(data: bytes) -> bytes:
    """A zlib stream of DEFLATE stored blocks: byte-identical on any zlib build."""
    out = bytearray(b"\x78\x01")
    if not data:
        out += b"\x01" + struct.pack("<HH", 0, 0xFFFF)
    else:
        for offset in range(0, len(data), 0xFFFF):
            block = data[offset : offset + 0xFFFF]
            final = offset + 0xFFFF >= len(data)
            out.append(0x01 if final else 0x00)
            out += struct.pack("<HH", len(block), len(block) ^ 0xFFFF)
            out += block
    out += struct.pack(">I", zlib.adler32(data) & 0xFFFFFFFF)
    return bytes(out)


def png(width: int, height: int, bit_depth: int, colour_type: int, raw: bytes) -> bytes:
    ihdr = struct.pack(">IIBBBBB", width, height, bit_depth, colour_type, 0, 0, 0)
    return (
        PNG_MAGIC
        + _chunk(b"IHDR", ihdr)
        + _chunk(b"IDAT", _stored_deflate(raw))
        + _chunk(b"IEND", b"")
    )


def png_16bit_rgb(size: int = 8) -> bytes:
    """A 16-bit-per-channel PNG. Outside the validated depth set, so it warns."""
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        for x in range(size):
            raw += struct.pack(">HHH", x * 4096 % 65536, y * 4096 % 65536, 32768)
    return png(size, size, 16, 2, bytes(raw))


def png_bomb(width: int = 60000, height: int = 60000) -> bytes:
    """A decompression-bomb probe.

    The IHDR declares 3.6 gigapixels while the file is a few hundred bytes. A
    header-first inspector must refuse it without reading further; an inspector
    that decodes first would try to allocate about 10 GB.

    The IDAT is deliberately short - a genuine 3.6-gigapixel PNG could not be
    committed, and is unnecessary: the attack lives entirely in the header.
    """
    return png(width, height, 8, 2, b"\x00" * 16)


# -------------------------------------------------------------------- JPEG --

# Annex K Table K.3: DC luminance. Code for symbol 0x00 is "00" (2 bits).
DC_BITS = bytes([0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0])
DC_VALS = bytes(range(12))

# Annex K Table K.5: AC luminance. End-of-block (0x00) is "1010" (4 bits).
AC_BITS = bytes([0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7D])
AC_VALS = bytes(
    [
        0x01,
        0x02,
        0x03,
        0x00,
        0x04,
        0x11,
        0x05,
        0x12,
        0x21,
        0x31,
        0x41,
        0x06,
        0x13,
        0x51,
        0x61,
        0x07,
        0x22,
        0x71,
        0x14,
        0x32,
        0x81,
        0x91,
        0xA1,
        0x08,
        0x23,
        0x42,
        0xB1,
        0xC1,
        0x15,
        0x52,
        0xD1,
        0xF0,
        0x24,
        0x33,
        0x62,
        0x72,
        0x82,
        0x09,
        0x0A,
        0x16,
        0x17,
        0x18,
        0x19,
        0x1A,
        0x25,
        0x26,
        0x27,
        0x28,
        0x29,
        0x2A,
        0x34,
        0x35,
        0x36,
        0x37,
        0x38,
        0x39,
        0x3A,
        0x43,
        0x44,
        0x45,
        0x46,
        0x47,
        0x48,
        0x49,
        0x4A,
        0x53,
        0x54,
        0x55,
        0x56,
        0x57,
        0x58,
        0x59,
        0x5A,
        0x63,
        0x64,
        0x65,
        0x66,
        0x67,
        0x68,
        0x69,
        0x6A,
        0x73,
        0x74,
        0x75,
        0x76,
        0x77,
        0x78,
        0x79,
        0x7A,
        0x83,
        0x84,
        0x85,
        0x86,
        0x87,
        0x88,
        0x89,
        0x8A,
        0x92,
        0x93,
        0x94,
        0x95,
        0x96,
        0x97,
        0x98,
        0x99,
        0x9A,
        0xA2,
        0xA3,
        0xA4,
        0xA5,
        0xA6,
        0xA7,
        0xA8,
        0xA9,
        0xAA,
        0xB2,
        0xB3,
        0xB4,
        0xB5,
        0xB6,
        0xB7,
        0xB8,
        0xB9,
        0xBA,
        0xC2,
        0xC3,
        0xC4,
        0xC5,
        0xC6,
        0xC7,
        0xC8,
        0xC9,
        0xCA,
        0xD2,
        0xD3,
        0xD4,
        0xD5,
        0xD6,
        0xD7,
        0xD8,
        0xD9,
        0xDA,
        0xE1,
        0xE2,
        0xE3,
        0xE4,
        0xE5,
        0xE6,
        0xE7,
        0xE8,
        0xE9,
        0xEA,
        0xF1,
        0xF2,
        0xF3,
        0xF4,
        0xF5,
        0xF6,
        0xF7,
        0xF8,
        0xF9,
        0xFA,
    ]
)


def _segment(marker: int, payload: bytes) -> bytes:
    return bytes([0xFF, marker]) + struct.pack(">H", len(payload) + 2) + payload


def _exif_app1(orientation: int) -> bytes:
    """A minimal little-endian Exif APP1 carrying only the orientation tag."""
    entry = struct.pack("<HHIHH", 0x0112, 3, 1, orientation, 0)  # SHORT, count 1, value, pad
    ifd = struct.pack("<H", 1) + entry + struct.pack("<I", 0)  # 1 entry, no next IFD
    tiff = b"II" + struct.pack("<H", 42) + struct.pack("<I", 8) + ifd
    return b"Exif\x00\x00" + tiff


def jpeg_grey(width: int = 16, height: int | None = None, orientation: int | None = None) -> bytes:
    """A uniform mid-grey baseline JPEG.

    Both dimensions must be multiples of 8: one 8x8 block per MCU, each encoded
    as a zero DC difference ("00") followed by end-of-block ("1010").
    """
    height = width if height is None else height
    if width % 8 or height % 8:
        msg = "dimensions must be multiples of 8"
        raise ValueError(msg)

    blocks = (width // 8) * (height // 8)
    bits = "".join("00" + "1010" for _ in range(blocks))
    # Pad to a byte boundary with 1s, as the JPEG spec requires.
    bits += "1" * (-len(bits) % 8)
    entropy = bytes(int(bits[i : i + 8], 2) for i in range(0, len(bits), 8))
    # 0xFF inside entropy data would need byte stuffing; assert it never occurs.
    assert 0xFF not in entropy, "entropy data needs byte stuffing"

    out = bytearray(b"\xff\xd8")  # SOI
    out += _segment(0xE0, b"JFIF\x00" + bytes([1, 1, 0]) + struct.pack(">HH", 1, 1) + b"\x00\x00")
    if orientation is not None:
        out += _segment(0xE1, _exif_app1(orientation))
    out += _segment(0xDB, bytes([0x00]) + bytes([16] * 64))  # DQT: table 0, flat
    out += _segment(0xC0, struct.pack(">BHHB", 8, height, width, 1) + bytes([1, 0x11, 0]))  # SOF0
    out += _segment(0xC4, bytes([0x00]) + DC_BITS + DC_VALS)  # DHT: DC table 0
    out += _segment(0xC4, bytes([0x10]) + AC_BITS + AC_VALS)  # DHT: AC table 0
    out += _segment(0xDA, bytes([1, 1, 0x00]) + bytes([0, 63, 0]))  # SOS
    out += entropy
    out += b"\xff\xd9"  # EOI
    return bytes(out)


# ------------------------------------------------------------------ layout --

FIXTURES: dict[str, bytes] = {
    # A valid baseline JPEG, for signature and header tests.
    "synthetic-grey-16.jpg": jpeg_grey(16),
    # A 16x8 image with EXIF orientation 6 (rotate 90 CW): display becomes 8x16,
    # so the axis swap is observable rather than hidden by a square image.
    "synthetic-grey-16x8-orientation6.jpg": jpeg_grey(16, 8, orientation=6),
    # JPEG bytes wearing a .png extension: the classic renamed-upload attack.
    "mismatched-extension.png": jpeg_grey(8),
    # IHDR declares 3.6 gigapixels in a few hundred bytes.
    "decompression-bomb.png": png_bomb(),
    # 16-bit depth: outside the validated set, so inspection warns.
    "unsupported-depth-16bit.png": png_16bit_rgb(),
    # Not an image at all, but named like one.
    "not-an-image.png": b"This file is plain text, not an image.\n" * 4,
    # A PNG truncated mid-IHDR: a malformed header, not a bomb.
    "truncated-header.png": (PNG_MAGIC + struct.pack(">I4s", 13, b"IHDR") + b"\x00\x00\x00"),
}


def target_dir(repo_root: Path) -> Path:
    return repo_root / "data" / "fixtures" / "images"


def repo_root_from_here() -> Path:
    return Path(__file__).resolve().parents[1]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate POC-003 inspection fixtures.")
    parser.add_argument("--check", action="store_true", help="verify without writing")
    parser.add_argument("--repo-root", type=Path, default=repo_root_from_here())
    args = parser.parse_args(argv)

    directory = target_dir(args.repo_root)
    directory.mkdir(parents=True, exist_ok=True)
    failures = 0

    for name, payload in FIXTURES.items():
        path = directory / name
        digest = hashlib.sha256(payload).hexdigest()
        if args.check:
            if not path.is_file():
                sys.stderr.write(f"missing fixture: {name}\n")
                failures += 1
            elif path.read_bytes() != payload:
                sys.stderr.write(f"not reproducible: {name}\n")
                failures += 1
            else:
                sys.stdout.write(f"{name:<38} reproducible  {len(payload):>6} B  {digest[:16]}\n")
        else:
            path.write_bytes(payload)
            sys.stdout.write(f"wrote {name:<38} {len(payload):>6} B  sha256={digest}\n")

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
