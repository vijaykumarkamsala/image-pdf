"""Bounded signature and header inspection for production file intake."""

from __future__ import annotations

import hashlib
import re
import struct
from dataclasses import dataclass
from pathlib import PurePath

from ipw.contracts.product_kernel import MalwareScanState, SourceFacts


@dataclass(frozen=True)
class InspectionLimits:
    max_bytes: int = 100 * 1024 * 1024
    max_pixels: int = 100_000_000
    max_pages: int = 500
    max_header_bytes: int = 1024 * 1024
    max_expansion_ratio: int = 10_000


@dataclass(frozen=True)
class InspectionOutcome:
    accepted: bool
    facts: SourceFacts | None = None
    code: str | None = None
    message: str | None = None


_MEDIA_OF_EXTENSION = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".webp": "image/webp",
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".pdf": "application/pdf",
}


def _reject(code: str, message: str) -> InspectionOutcome:
    return InspectionOutcome(accepted=False, code=code, message=message)


def _signature(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if data.startswith(b"BM"):
        return "image/bmp"
    if data.startswith((b"II*\x00", b"MM\x00*")):
        return "image/tiff"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if len(data) >= 12 and data[4:8] == b"ftyp" and data[8:12] in {b"heic", b"heix", b"mif1"}:
        return "image/heic"
    if data.startswith(b"%PDF-"):
        return "application/pdf"
    if data.startswith(b"PK\x03\x04"):
        return "application/zip"
    return None


def _png(data: bytes) -> tuple[int, int, int, bool, bool, int | None, tuple[str, ...]]:
    if len(data) < 33 or data[12:16] != b"IHDR" or struct.unpack(">I", data[8:12])[0] != 13:
        raise ValueError("PNG header is truncated or malformed")
    width, height, depth, colour = struct.unpack(">IIBB", data[16:26])
    if width < 1 or height < 1 or colour not in {0, 2, 3, 4, 6}:
        raise ValueError("PNG dimensions or colour type are invalid")
    header = data[: 1024 * 1024]
    alpha = colour in {4, 6} or b"tRNS" in header
    icc = b"iCCP" in header or b"sRGB" in header
    frames = 2 if b"acTL" in header else 1
    sensitive = tuple(
        name for marker, name in ((b"eXIf", "exif"), (b"tEXt", "text")) if marker in header
    )
    return width, height, depth, alpha, icc, frames, sensitive


def _jpeg(data: bytes) -> tuple[int, int, int, bool, bool, int | None, tuple[str, ...]]:
    offset = 2
    orientation: int | None = None
    icc = False
    sensitive: set[str] = set()
    while offset + 4 <= len(data) and offset < 1024 * 1024:
        if data[offset] != 0xFF:
            raise ValueError("JPEG segment marker is malformed")
        marker = data[offset + 1]
        if marker in {0xD8, 0xD9, *range(0xD0, 0xD8), 0x01}:
            offset += 2
            continue
        length = struct.unpack(">H", data[offset + 2 : offset + 4])[0]
        end = offset + 2 + length
        if length < 2 or end > len(data):
            raise ValueError("JPEG segment is truncated")
        payload = data[offset + 4 : end]
        if marker == 0xE1 and payload.startswith(b"Exif\x00\x00"):
            sensitive.add("exif")
            orientation = _jpeg_orientation(payload)
            if b"GPS" in payload:
                sensitive.add("gps")
        if marker == 0xE2 and payload.startswith(b"ICC_PROFILE\x00"):
            icc = True
        if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}:
            if len(payload) < 6:
                raise ValueError("JPEG frame header is truncated")
            depth, height, width, channels = struct.unpack(">BHHB", payload[:6])
            if width < 1 or height < 1 or channels not in {1, 2, 3, 4}:
                raise ValueError("JPEG frame dimensions are invalid")
            return width, height, depth, False, icc, orientation, tuple(sorted(sensitive))
        offset = end
    raise ValueError("JPEG frame header was not found within the bounded header")


def _jpeg_orientation(payload: bytes) -> int | None:
    tiff = payload[6:]
    if len(tiff) < 8 or tiff[:2] not in {b"II", b"MM"}:
        return None
    endian = "<" if tiff[:2] == b"II" else ">"
    ifd = struct.unpack(endian + "I", tiff[4:8])[0]
    if ifd + 2 > len(tiff):
        return None
    count = min(struct.unpack(endian + "H", tiff[ifd : ifd + 2])[0], 512)
    for index in range(count):
        start = ifd + 2 + index * 12
        if start + 12 > len(tiff):
            return None
        tag, value_type, values = struct.unpack(endian + "HHI", tiff[start : start + 8])
        if tag == 0x0112 and value_type == 3 and values == 1:
            value = struct.unpack(endian + "H", tiff[start + 8 : start + 10])[0]
            return value if 1 <= value <= 8 else None
    return None


def _simple_image(
    media_type: str, data: bytes
) -> tuple[int, int, int, bool, bool, int | None, tuple[str, ...]]:
    if media_type == "image/gif":
        if len(data) < 10:
            raise ValueError("GIF header is truncated")
        width, height = struct.unpack("<HH", data[6:10])
        return width, height, 8, False, False, None, ()
    if media_type == "image/bmp":
        if len(data) < 30:
            raise ValueError("BMP header is truncated")
        width, height = struct.unpack("<ii", data[18:26])
        depth = struct.unpack("<H", data[28:30])[0]
        return abs(width), abs(height), depth, depth == 32, False, None, ()
    if media_type == "image/webp":
        if len(data) < 30 or data[12:16] != b"VP8X":
            raise ValueError("Only bounded WebP extended headers are currently accepted")
        flags = data[20]
        width = 1 + int.from_bytes(data[24:27], "little")
        height = 1 + int.from_bytes(data[27:30], "little")
        return width, height, 8, bool(flags & 0x10), bool(flags & 0x20), None, ()
    raise ValueError("This image container requires a separately approved parser")


def inspect_bytes(
    data: bytes,
    *,
    display_name: str,
    expected_media_type: str,
    malware_state: str = "clean",
    limits: InspectionLimits | None = None,
) -> InspectionOutcome:
    policy = limits or InspectionLimits()
    if not data:
        return _reject("file-empty", "The selected file is empty")
    if len(data) > policy.max_bytes:
        return _reject("file-too-large", "The selected file exceeds the intake size limit")
    detected = _signature(data)
    if detected is None:
        return _reject("signature-unknown", "The file signature is not a supported image or PDF")
    if detected == "application/zip":
        return _reject("archive-not-allowed", "Archive files cannot be uploaded here")
    if detected != expected_media_type:
        return _reject(
            "signature-mismatch", "The file contents do not match the selected file type"
        )
    declared_by_name = _MEDIA_OF_EXTENSION.get(PurePath(display_name).suffix.lower())
    if declared_by_name is not None and declared_by_name != detected:
        return _reject("extension-mismatch", "The file name does not match its contents")
    if malware_state == "malicious":
        return _reject("malware-detected", "The file was rejected by the safety scan")
    if malware_state == "unavailable":
        return _reject("scanner-unavailable", "The required safety scanner is unavailable")

    digest = hashlib.sha256(data).hexdigest()
    if detected == "application/pdf":
        return _inspect_pdf(data, digest, policy)
    try:
        if detected == "image/png":
            width, height, depth, alpha, icc, frames, sensitive = _png(data)
            orientation = None
        elif detected == "image/jpeg":
            width, height, depth, alpha, icc, orientation, sensitive = _jpeg(data)
            frames = 1
        else:
            width, height, depth, alpha, icc, orientation, sensitive = _simple_image(detected, data)
            frames = 1
    except (ValueError, struct.error) as error:
        return _reject("header-malformed", str(error))
    pixels = width * height
    if pixels > policy.max_pixels:
        return _reject("pixel-limit-exceeded", "Image dimensions exceed the safe pixel limit")
    estimated = pixels * 4 * max(1, (depth + 7) // 8)
    if estimated > 64 * 1024 * 1024 and estimated > len(data) * policy.max_expansion_ratio:
        return _reject("decompression-bomb", "The compressed file expands beyond the safe ratio")
    facts = SourceFacts(
        sha256=digest,
        detected_media_type=detected,
        byte_size=len(data),
        width=width,
        height=height,
        megapixels_milli=pixels // 1000,
        orientation=orientation,
        frame_count=frames,
        has_alpha=alpha,
        bit_depth=depth,
        has_icc_profile=icc,
        sensitive_metadata=sensitive,
        malware_scan_state=MalwareScanState.CLEAN,
    )
    return InspectionOutcome(accepted=True, facts=facts)


def _inspect_pdf(data: bytes, digest: str, policy: InspectionLimits) -> InspectionOutcome:
    if b"%%EOF" not in data[-4096:]:
        return _reject("pdf-truncated", "The PDF is incomplete or corrupt")
    dangerous = {
        b"/JavaScript": "javascript",
        b"/JS": "javascript",
        b"/Launch": "launch-action",
        b"/EmbeddedFile": "embedded-file",
        b"/RichMedia": "rich-media",
        b"/OpenAction": "open-action",
    }
    found = tuple(sorted({name for marker, name in dangerous.items() if marker in data}))
    if found:
        return _reject("pdf-dangerous-structure", "The PDF contains active or embedded content")
    pages = len(re.findall(rb"/Type\s*/Page(?!s)\b", data))
    if pages < 1:
        return _reject("pdf-pages-missing", "No readable PDF pages were found")
    if pages > policy.max_pages:
        return _reject("pdf-page-limit-exceeded", "The PDF has too many pages for safe intake")
    facts = SourceFacts(
        sha256=digest,
        detected_media_type="application/pdf",
        byte_size=len(data),
        page_count=pages,
        sensitive_metadata=("encrypted",) if b"/Encrypt" in data else (),
        malware_scan_state=MalwareScanState.CLEAN,
    )
    return InspectionOutcome(accepted=True, facts=facts)
