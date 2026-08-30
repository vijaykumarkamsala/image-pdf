from __future__ import annotations

import struct

import pytest

from ipw.inspection import DeterministicMalwareScanner, InspectionLimits, inspect_bytes


def png(width: int = 1, height: int = 1) -> bytes:
    return (
        b"\x89PNG\r\n\x1a\n"
        + struct.pack(">I4sIIBBBBB", 13, b"IHDR", width, height, 8, 6, 0, 0, 0)
        + b"\x00\x00\x00\x00"
        + struct.pack(">I4s", 0, b"IEND")
        + b"\x00\x00\x00\x00"
    )


def test_png_facts_are_derived_header_first() -> None:
    data = png(20, 10)
    result = inspect_bytes(data, display_name="source.png", expected_media_type="image/png")

    assert result.accepted
    assert result.facts is not None
    assert (result.facts.width, result.facts.height) == (20, 10)
    assert result.facts.has_alpha is True
    assert result.facts.byte_size == len(data)


def test_spoof_truncation_zero_and_bomb_are_rejected() -> None:
    spoof = inspect_bytes(png(), display_name="source.jpg", expected_media_type="image/jpeg")
    truncated = inspect_bytes(
        b"\x89PNG\r\n\x1a\n", display_name="source.png", expected_media_type="image/png"
    )
    zero = inspect_bytes(b"", display_name="source.png", expected_media_type="image/png")
    bomb = inspect_bytes(
        png(50_000, 50_000),
        display_name="source.png",
        expected_media_type="image/png",
        limits=InspectionLimits(max_pixels=100_000),
    )

    assert spoof.code == "signature-mismatch"
    assert truncated.code == "header-malformed"
    assert zero.code == "file-empty"
    assert bomb.code == "pixel-limit-exceeded"


def test_pdf_active_content_and_missing_eof_are_rejected() -> None:
    safe = b"%PDF-1.7\n1 0 obj<</Type /Page>>endobj\n%%EOF"
    active = safe.replace(b">>endobj", b"/JavaScript (x)>>endobj")

    accepted = inspect_bytes(safe, display_name="safe.pdf", expected_media_type="application/pdf")
    dangerous = inspect_bytes(
        active, display_name="active.pdf", expected_media_type="application/pdf"
    )
    truncated = inspect_bytes(
        safe[:-5], display_name="cut.pdf", expected_media_type="application/pdf"
    )

    assert accepted.accepted
    assert accepted.facts is not None
    assert accepted.facts.page_count == 1
    assert dangerous.code == "pdf-dangerous-structure"
    assert truncated.code == "pdf-truncated"


def test_deterministic_scanner_recognises_only_the_rights_safe_test_marker() -> None:
    scanner = DeterministicMalwareScanner()

    assert scanner.scan(b"ordinary bytes").state == "clean"
    assert scanner.scan(b"prefix EICAR-STANDARD-ANTIVIRUS-TEST-FILE suffix").state == "malicious"


def jpeg(width: int = 3, height: int = 2) -> bytes:
    return b"\xff\xd8\xff\xc0\x00\x08" + struct.pack(">BHHB", 8, height, width, 3)


def test_jpeg_gif_bmp_and_webp_headers_are_bounded() -> None:
    gif = b"GIF89a" + struct.pack("<HH", 4, 5)
    bmp = bytearray(30)
    bmp[:2] = b"BM"
    struct.pack_into("<ii", bmp, 18, 6, -7)
    struct.pack_into("<H", bmp, 28, 32)
    webp = bytearray(30)
    webp[:4], webp[8:12], webp[12:16] = b"RIFF", b"WEBP", b"VP8X"
    webp[20] = 0x10
    webp[24:27] = (7).to_bytes(3, "little")
    webp[27:30] = (8).to_bytes(3, "little")

    cases = [
        (jpeg(), "source.jpg", "image/jpeg", (3, 2)),
        (gif, "source.gif", "image/gif", (4, 5)),
        (bytes(bmp), "source.bmp", "image/bmp", (6, 7)),
        (bytes(webp), "source.webp", "image/webp", (8, 9)),
    ]
    for data, name, media_type, dimensions in cases:
        result = inspect_bytes(data, display_name=name, expected_media_type=media_type)
        assert result.accepted
        assert result.facts is not None
        assert (result.facts.width, result.facts.height) == dimensions


@pytest.mark.parametrize(
    ("data", "name", "media_type", "code"),
    [
        (b"plain text", "plain.png", "image/png", "signature-unknown"),
        (b"PK\x03\x04archive", "archive.zip", "application/zip", "archive-not-allowed"),
        (png(), "wrong.jpg", "image/png", "extension-mismatch"),
        (b"\xff\xd8\xff\xc0\x00", "cut.jpg", "image/jpeg", "header-malformed"),
        (b"GIF89a", "cut.gif", "image/gif", "header-malformed"),
        (b"BM", "cut.bmp", "image/bmp", "header-malformed"),
    ],
)
def test_unsupported_and_malformed_structures_have_stable_codes(
    data: bytes, name: str, media_type: str, code: str
) -> None:
    result = inspect_bytes(data, display_name=name, expected_media_type=media_type)
    assert not result.accepted
    assert result.code == code


def test_malware_and_scanner_unavailability_fail_closed() -> None:
    malicious = inspect_bytes(
        png(),
        display_name="source.png",
        expected_media_type="image/png",
        malware_state="malicious",
    )
    unavailable = inspect_bytes(
        png(),
        display_name="source.png",
        expected_media_type="image/png",
        malware_state="unavailable",
    )

    assert malicious.code == "malware-detected"
    assert unavailable.code == "scanner-unavailable"


def test_jpeg_orientation_icc_and_sensitive_metadata_are_reported() -> None:
    tiff = b"II*\x00" + struct.pack("<I", 8)
    tiff += struct.pack("<H", 1)
    tiff += struct.pack("<HHI", 0x0112, 3, 1) + struct.pack("<H", 6) + b"\x00\x00"
    exif = b"Exif\x00\x00" + tiff
    app1 = b"\xff\xe1" + struct.pack(">H", len(exif) + 2) + exif
    icc = b"ICC_PROFILE\x00profile"
    app2 = b"\xff\xe2" + struct.pack(">H", len(icc) + 2) + icc
    data = b"\xff\xd8" + app1 + app2 + jpeg()[2:]

    result = inspect_bytes(data, display_name="oriented.jpg", expected_media_type="image/jpeg")

    assert result.accepted
    assert result.facts is not None
    assert result.facts.orientation == 6
    assert result.facts.has_icc_profile is True
    assert result.facts.sensitive_metadata == ("exif",)


def test_detected_but_unapproved_containers_fail_at_the_parser_boundary() -> None:
    tiff = b"II*\x00" + b"\x00" * 20
    heif = b"\x00\x00\x00\x18ftypheic" + b"\x00" * 12
    malformed_webp = b"RIFF\x00\x00\x00\x00WEBPbad!"

    assert (
        inspect_bytes(tiff, display_name="source.tif", expected_media_type="image/tiff").code
        == "header-malformed"
    )
    assert (
        inspect_bytes(heif, display_name="source.heic", expected_media_type="image/heic").code
        == "header-malformed"
    )
    assert (
        inspect_bytes(
            malformed_webp, display_name="source.webp", expected_media_type="image/webp"
        ).code
        == "header-malformed"
    )


def test_byte_pixel_and_expansion_limits_are_independent() -> None:
    too_many_bytes = inspect_bytes(
        png(),
        display_name="source.png",
        expected_media_type="image/png",
        limits=InspectionLimits(max_bytes=10),
    )
    zero_dimension = inspect_bytes(
        png(0, 1), display_name="source.png", expected_media_type="image/png"
    )
    expansion = inspect_bytes(
        png(5_000, 5_000),
        display_name="source.png",
        expected_media_type="image/png",
        limits=InspectionLimits(max_pixels=30_000_000),
    )

    assert too_many_bytes.code == "file-too-large"
    assert zero_dimension.code == "header-malformed"
    assert expansion.code == "decompression-bomb"


def test_pdf_page_limits_and_sensitive_encryption_are_recorded() -> None:
    no_pages = b"%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF"
    two_pages = b"%PDF-1.7\n/Type /Page\n/Type /Page\n/Encrypt\n%%EOF"

    missing = inspect_bytes(
        no_pages, display_name="none.pdf", expected_media_type="application/pdf"
    )
    limited = inspect_bytes(
        two_pages,
        display_name="many.pdf",
        expected_media_type="application/pdf",
        limits=InspectionLimits(max_pages=1),
    )
    accepted = inspect_bytes(
        two_pages,
        display_name="two.pdf",
        expected_media_type="application/pdf",
        limits=InspectionLimits(max_pages=2),
    )

    assert missing.code == "pdf-pages-missing"
    assert limited.code == "pdf-page-limit-exceeded"
    assert accepted.facts is not None
    assert accepted.facts.sensitive_metadata == ("encrypted",)
