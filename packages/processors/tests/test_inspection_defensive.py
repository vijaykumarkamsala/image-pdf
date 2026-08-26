"""Defensive parsing paths: malformed, hostile and unusual inputs.

Every input to these parsers is untrusted. The branches exercised here are the
ones an attacker reaches, so they are tested on their own merit rather than as a
coverage exercise: a corrupt length that drives an out-of-range read, an EXIF
block claiming thousands of entries, a chunk that declares more bytes than the
file contains.

The contract for all of them is the same: raise :class:`HeaderParseError`, or
return a result with the risk recorded. Never raise something else, never loop
unbounded, never read past the buffer.
"""

from __future__ import annotations

import struct
import zlib

import pytest

from ipw.contracts.safety import DEFAULT_SAFETY_POLICY, RiskFlag
from ipw.processors.inspection import (
    HeaderParseError,
    SignatureKind,
    parse_header,
    parse_jpeg,
    parse_png,
)
from ipw.processors.inspection.headers import PNG_MAGIC
from ipw.processors.inspection.inspector import _encoding_risks

# ------------------------------------------------------------------- helpers --


def png_chunk(tag: bytes, payload: bytes = b"") -> bytes:
    return (
        struct.pack(">I", len(payload))
        + tag
        + payload
        + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
    )


def png_with(
    *extra_chunks: bytes,
    width: int = 8,
    height: int = 8,
    bit_depth: int = 8,
    colour_type: int = 2,
    interlace: int = 0,
    compression: int = 0,
    filter_method: int = 0,
) -> bytes:
    ihdr = struct.pack(
        ">IIBBBBB", width, height, bit_depth, colour_type, compression, filter_method, interlace
    )
    return PNG_MAGIC + png_chunk(b"IHDR", ihdr) + b"".join(extra_chunks) + png_chunk(b"IEND")


def jpeg_with(*segments: bytes, width: int = 8, height: int = 8, marker: int = 0xC0) -> bytes:
    sof_payload = struct.pack(">BHHB", 8, height, width, 1) + bytes([1, 0x11, 0])
    sof = bytes([0xFF, marker]) + struct.pack(">H", len(sof_payload) + 2) + sof_payload
    return b"\xff\xd8" + b"".join(segments) + sof


def segment(marker: int, payload: bytes) -> bytes:
    return bytes([0xFF, marker]) + struct.pack(">H", len(payload) + 2) + payload


# ----------------------------------------------------------------- PNG paths --


class TestPngDefensiveParsing:
    def test_a_bad_ihdr_length_is_rejected(self) -> None:
        payload = PNG_MAGIC + struct.pack(">I4s", 99, b"IHDR") + b"\x00" * 40
        with pytest.raises(HeaderParseError, match="IHDR length"):
            parse_png(payload)

    @pytest.mark.parametrize(("compression", "filter_method"), [(1, 0), (0, 1)])
    def test_unsupported_compression_or_filter_is_rejected(
        self, compression: int, filter_method: int
    ) -> None:
        with pytest.raises(HeaderParseError, match="compression or filter"):
            parse_png(png_with(compression=compression, filter_method=filter_method))

    def test_a_zero_height_is_rejected(self) -> None:
        with pytest.raises(HeaderParseError, match="zero dimension"):
            parse_png(png_with(height=0))

    @pytest.mark.parametrize(
        ("colour_type", "channels", "alpha"),
        [(0, 1, False), (2, 3, False), (3, 1, False), (4, 2, True), (6, 4, True)],
    )
    def test_every_colour_type_maps_to_channels(
        self, colour_type: int, channels: int, alpha: bool
    ) -> None:
        header = parse_png(png_with(colour_type=colour_type))
        assert header.channels == channels
        assert header.has_alpha is alpha

    def test_indexed_colour_is_labelled(self) -> None:
        assert parse_png(png_with(colour_type=3)).encoding == "png-indexed"

    def test_a_trns_chunk_implies_transparency(self) -> None:
        header = parse_png(png_with(png_chunk(b"tRNS", b"\x00\x00\x00")))
        assert header.has_alpha
        assert any("tRNS" in note for note in header.notes)

    def test_an_iccp_chunk_records_an_embedded_profile(self) -> None:
        assert (
            parse_png(png_with(png_chunk(b"iCCP", b"p\x00\x00"))).colour_profile == "embedded-icc"
        )

    def test_an_srgb_chunk_records_the_profile(self) -> None:
        assert parse_png(png_with(png_chunk(b"sRGB", b"\x00"))).colour_profile == "sRGB"

    def test_an_actl_chunk_marks_the_file_animated(self) -> None:
        header = parse_png(png_with(png_chunk(b"acTL", b"\x00" * 8)))
        assert header.animated
        assert any("APNG" in note for note in header.notes)

    def test_interlacing_is_detected(self) -> None:
        assert parse_png(png_with(interlace=1)).interlaced

    def test_a_chunk_longer_than_the_file_is_noted_not_followed(self) -> None:
        """A corrupt length must not drive a read past the buffer."""
        oversized = struct.pack(">I", 0x7FFFFFFF) + b"IDAT" + b"\x00" * 4
        header = parse_png(
            PNG_MAGIC + png_chunk(b"IHDR", struct.pack(">IIBBBBB", 8, 8, 8, 2, 0, 0, 0)) + oversized
        )
        assert any("exceeds the available bytes" in note for note in header.notes)


# ---------------------------------------------------------------- JPEG paths --


class TestJpegDefensiveParsing:
    def test_a_bad_segment_marker_is_rejected(self) -> None:
        with pytest.raises(HeaderParseError, match="expected a marker"):
            parse_jpeg(b"\xff\xd8" + b"\x00\x00\x00\x00")

    def test_standalone_markers_are_skipped(self) -> None:
        """RST markers and TEM carry no payload and must not be length-decoded."""
        header = parse_jpeg(b"\xff\xd8" + b"\xff\xd0" + b"\xff\x01" + jpeg_with()[2:])
        assert header.width == 8

    def test_fill_bytes_before_a_marker_are_tolerated(self) -> None:
        header = parse_jpeg(b"\xff\xd8" + b"\xff\xff\xd0" + jpeg_with()[2:])
        assert header.width == 8

    def test_a_progressive_frame_is_labelled(self) -> None:
        header = parse_jpeg(jpeg_with(marker=0xC2))
        assert header.progressive
        assert header.encoding == "jpeg-progressive"

    def test_an_unknown_sof_marker_is_labelled_not_rejected(self) -> None:
        header = parse_jpeg(jpeg_with(marker=0xC5))
        assert header.encoding == "jpeg-differential-sequential"

    def test_a_short_sof_payload_is_rejected(self) -> None:
        with pytest.raises(HeaderParseError, match="start-of-frame payload"):
            parse_jpeg(b"\xff\xd8" + segment(0xC0, b"\x08\x00"))

    def test_a_zero_dimension_frame_is_rejected(self) -> None:
        payload = struct.pack(">BHHB", 8, 0, 8, 1) + bytes([1, 0x11, 0])
        with pytest.raises(HeaderParseError, match="zero dimension"):
            parse_jpeg(b"\xff\xd8" + segment(0xC0, payload))

    def test_too_many_colour_components_is_rejected(self) -> None:
        payload = struct.pack(">BHHB", 8, 8, 8, 9) + bytes([1, 0x11, 0]) * 9
        with pytest.raises(HeaderParseError, match="colour components"):
            parse_jpeg(b"\xff\xd8" + segment(0xC0, payload))

    def test_an_icc_profile_segment_is_recorded(self) -> None:
        icc = segment(0xE2, b"ICC_PROFILE\x00" + b"\x00" * 4)
        assert parse_jpeg(jpeg_with(icc)).colour_profile == "embedded-icc"

    def test_reaching_the_start_of_scan_without_a_frame_is_rejected(self) -> None:
        with pytest.raises(HeaderParseError, match="no start-of-frame"):
            parse_jpeg(b"\xff\xd8" + segment(0xDB, b"\x00" * 65) + b"\xff\xda\x00\x08")


class TestExifDefensiveParsing:
    """A corrupt EXIF block yields no orientation, never an exception."""

    def _with_app1(self, payload: bytes) -> int | None:
        return parse_jpeg(jpeg_with(segment(0xE1, payload))).exif_orientation

    def test_a_non_exif_app1_is_ignored(self) -> None:
        assert self._with_app1(b"http://ns.adobe.com/xap/1.0/\x00") is None

    def test_a_truncated_tiff_header_is_ignored(self) -> None:
        assert self._with_app1(b"Exif\x00\x00" + b"II") is None

    def test_an_unknown_byte_order_is_ignored(self) -> None:
        assert self._with_app1(b"Exif\x00\x00" + b"XX" + b"\x00" * 8) is None

    def test_a_wrong_magic_number_is_ignored(self) -> None:
        payload = b"Exif\x00\x00" + b"II" + struct.pack("<H", 99) + struct.pack("<I", 8)
        assert self._with_app1(payload + b"\x00" * 8) is None

    def test_an_out_of_range_ifd_offset_is_ignored(self) -> None:
        payload = b"Exif\x00\x00" + b"II" + struct.pack("<H", 42) + struct.pack("<I", 9999)
        assert self._with_app1(payload) is None

    def test_an_implausible_entry_count_is_ignored(self) -> None:
        """A count of 60000 means corruption, not a real IFD."""
        payload = (
            b"Exif\x00\x00"
            + b"II"
            + struct.pack("<H", 42)
            + struct.pack("<I", 8)
            + struct.pack("<H", 60000)
        )
        assert self._with_app1(payload) is None

    def test_a_truncated_entry_list_is_ignored(self) -> None:
        payload = (
            b"Exif\x00\x00"
            + b"II"
            + struct.pack("<H", 42)
            + struct.pack("<I", 8)
            + struct.pack("<H", 5)
            + b"\x00" * 6
        )
        assert self._with_app1(payload) is None

    def test_an_orientation_of_the_wrong_type_is_ignored(self) -> None:
        entry = struct.pack("<HHIHH", 0x0112, 4, 1, 6, 0)  # LONG, not SHORT
        payload = (
            b"Exif\x00\x00"
            + b"II"
            + struct.pack("<H", 42)
            + struct.pack("<I", 8)
            + struct.pack("<H", 1)
            + entry
            + struct.pack("<I", 0)
        )
        assert self._with_app1(payload) is None

    def test_an_out_of_range_orientation_value_is_ignored(self) -> None:
        entry = struct.pack("<HHIHH", 0x0112, 3, 1, 42, 0)
        payload = (
            b"Exif\x00\x00"
            + b"II"
            + struct.pack("<H", 42)
            + struct.pack("<I", 8)
            + struct.pack("<H", 1)
            + entry
            + struct.pack("<I", 0)
        )
        assert self._with_app1(payload) is None

    def test_other_tags_are_skipped_to_reach_orientation(self) -> None:
        other = struct.pack("<HHIHH", 0x010F, 2, 1, 0, 0)  # Make
        orientation = struct.pack("<HHIHH", 0x0112, 3, 1, 8, 0)
        payload = (
            b"Exif\x00\x00"
            + b"II"
            + struct.pack("<H", 42)
            + struct.pack("<I", 8)
            + struct.pack("<H", 2)
            + other
            + orientation
            + struct.pack("<I", 0)
        )
        assert self._with_app1(payload) == 8

    def test_big_endian_exif_is_parsed(self) -> None:
        entry = struct.pack(">HHIHH", 0x0112, 3, 1, 3, 0)
        payload = (
            b"Exif\x00\x00"
            + b"MM"
            + struct.pack(">H", 42)
            + struct.pack(">I", 8)
            + struct.pack(">H", 1)
            + entry
            + struct.pack(">I", 0)
        )
        assert self._with_app1(payload) == 3


class TestDispatch:
    def test_an_unparseable_kind_is_rejected(self) -> None:
        with pytest.raises(HeaderParseError, match="no header parser"):
            parse_header(SignatureKind.GIF, b"GIF89a")

    @pytest.mark.parametrize("kind", [SignatureKind.PNG, SignatureKind.JPEG])
    def test_supported_kinds_dispatch(self, kind: SignatureKind) -> None:
        data = png_with() if kind is SignatureKind.PNG else jpeg_with()
        assert parse_header(kind, data).kind is kind


class TestEncodingRiskFlags:
    """Each structural property maps to a recorded risk flag."""

    @pytest.mark.parametrize(
        ("chunk", "expected"),
        [
            (png_chunk(b"acTL", b"\x00" * 8), RiskFlag.ANIMATED_CONTENT),
            (png_chunk(b"iCCP", b"p\x00\x00"), RiskFlag.UNSUPPORTED_COLOUR_PROFILE),
            (png_chunk(b"tRNS", b"\x00\x00\x00"), RiskFlag.TRANSPARENCY_PRESENT),
        ],
    )
    def test_png_properties_raise_their_flag(self, chunk: bytes, expected: RiskFlag) -> None:
        header = parse_png(png_with(chunk))
        flags, _ = _encoding_risks(header, DEFAULT_SAFETY_POLICY)
        assert expected in flags

    def test_interlacing_raises_its_flag(self) -> None:
        flags, _ = _encoding_risks(parse_png(png_with(interlace=1)), DEFAULT_SAFETY_POLICY)
        assert RiskFlag.INTERLACED in flags

    def test_progressive_jpeg_raises_its_flag(self) -> None:
        flags, _ = _encoding_risks(parse_jpeg(jpeg_with(marker=0xC2)), DEFAULT_SAFETY_POLICY)
        assert RiskFlag.PROGRESSIVE in flags

    def test_a_truncated_chunk_raises_its_flag(self) -> None:
        oversized = struct.pack(">I", 0x7FFFFFFF) + b"IDAT" + b"\x00" * 4
        header = parse_png(
            PNG_MAGIC + png_chunk(b"IHDR", struct.pack(">IIBBBBB", 8, 8, 8, 2, 0, 0, 0)) + oversized
        )
        flags, _ = _encoding_risks(header, DEFAULT_SAFETY_POLICY)
        assert RiskFlag.TRUNCATED in flags
