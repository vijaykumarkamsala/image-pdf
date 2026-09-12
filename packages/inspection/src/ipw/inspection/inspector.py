"""Bounded signature and header inspection for production file intake."""

from __future__ import annotations

import hashlib
import re
import struct
from dataclasses import dataclass
from pathlib import PurePath

from ipw.contracts.product_kernel import MalwareScanState, SourceColourModel, SourceFacts


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


RasterHeader = tuple[
    int,
    int,
    int,
    bool,
    bool,
    int | None,
    int,
    tuple[str, ...],
    str,
]


def _png(data: bytes) -> RasterHeader:
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
    colour_model = "grayscale" if colour in {0, 4} else "indexed" if colour == 3 else "rgb"
    return width, height, depth, alpha, icc, None, frames, sensitive, colour_model


def _jpeg(data: bytes) -> RasterHeader:
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
            tiff = payload[6:]
            for tag, category in (
                (0x010E, "description"),
                (0x0131, "software_device"),
                (0x013B, "software_device"),
                (0x8298, "copyright"),
                (0x8825, "gps"),
                (0x927C, "maker_notes"),
                (0x0201, "embedded_thumbnails"),
                (0x0202, "embedded_thumbnails"),
            ):
                if _tiff_contains_tag(tiff, tag):
                    sensitive.add(category)
        if marker == 0xE1 and payload.startswith(b"http://ns.adobe.com/xap/1.0/\x00"):
            sensitive.add("xmp")
        if marker == 0xE2 and payload.startswith(b"ICC_PROFILE\x00"):
            icc = True
        if marker == 0xED and payload.startswith(b"Photoshop 3.0\x00"):
            sensitive.add("iptc")
        if marker == 0xFE:
            sensitive.add("comments")
        if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}:
            if len(payload) < 6:
                raise ValueError("JPEG frame header is truncated")
            depth, height, width, channels = struct.unpack(">BHHB", payload[:6])
            if width < 1 or height < 1 or channels not in {1, 2, 3, 4}:
                raise ValueError("JPEG frame dimensions are invalid")
            colour_model = "grayscale" if channels == 1 else "rgb" if channels == 3 else "cmyk"
            return (
                width,
                height,
                depth,
                False,
                icc,
                orientation,
                1,
                tuple(sorted(sensitive)),
                colour_model,
            )
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


def _tiff_contains_tag(tiff: bytes, wanted: int) -> bool:
    if len(tiff) < 8 or tiff[:2] not in {b"II", b"MM"}:
        return False
    endian = "<" if tiff[:2] == b"II" else ">"
    try:
        pending = [struct.unpack(endian + "I", tiff[4:8])[0]]
        seen: set[int] = set()
        while pending and len(seen) < 64:
            offset = pending.pop()
            if offset in seen or offset < 8 or offset + 2 > len(tiff):
                return False
            seen.add(offset)
            count = struct.unpack(endian + "H", tiff[offset : offset + 2])[0]
            if count > 512:
                return False
            end = offset + 2 + count * 12
            if end + 4 > len(tiff):
                return False
            for index in range(count):
                start = offset + 2 + index * 12
                tag, value_type, values = struct.unpack(endian + "HHI", tiff[start : start + 8])
                if tag == wanted:
                    return True
                if tag in {0x8769, 0x8825, 0xA005} and value_type == 4 and values == 1:
                    child = struct.unpack(endian + "I", tiff[start + 8 : start + 12])[0]
                    if child:
                        pending.append(child)
            following = struct.unpack(endian + "I", tiff[end : end + 4])[0]
            if following:
                pending.append(following)
    except struct.error:
        return False
    return False


def _webp(data: bytes) -> RasterHeader:
    if len(data) < 20:
        raise ValueError("WebP header is truncated")
    declared_end = int.from_bytes(data[4:8], "little") + 8
    if declared_end > len(data) or declared_end < 20:
        raise ValueError("WebP RIFF size is invalid")
    end = min(declared_end, 1024 * 1024)
    offset = 12
    width = height = 0
    alpha = icc = False
    sensitive: set[str] = set()
    animation_frames = 0
    while offset + 8 <= end:
        kind = data[offset : offset + 4]
        size = int.from_bytes(data[offset + 4 : offset + 8], "little")
        payload_start = offset + 8
        payload_end = payload_start + size
        if payload_end > declared_end or payload_end > len(data):
            raise ValueError("WebP chunk is truncated")
        payload = data[payload_start:payload_end]
        if kind == b"VP8X":
            if len(payload) != 10:
                raise ValueError("WebP extended header is malformed")
            flags = payload[0]
            width = 1 + int.from_bytes(payload[4:7], "little")
            height = 1 + int.from_bytes(payload[7:10], "little")
            alpha |= bool(flags & 0x10)
            icc |= bool(flags & 0x20)
            if flags & 0x08:
                sensitive.add("exif")
            if flags & 0x04:
                sensitive.add("xmp")
        elif kind == b"VP8 ":
            if len(payload) < 10 or payload[3:6] != b"\x9d\x01\x2a":
                raise ValueError("WebP lossy frame header is malformed")
            width = int.from_bytes(payload[6:8], "little") & 0x3FFF
            height = int.from_bytes(payload[8:10], "little") & 0x3FFF
        elif kind == b"VP8L":
            if len(payload) < 5 or payload[0] != 0x2F:
                raise ValueError("WebP lossless frame header is malformed")
            packed = int.from_bytes(payload[1:5], "little")
            width = (packed & 0x3FFF) + 1
            height = ((packed >> 14) & 0x3FFF) + 1
            alpha = True
        elif kind == b"ICCP":
            icc = True
        elif kind == b"EXIF":
            sensitive.add("exif")
            exif_tiff = payload[6:] if payload.startswith(b"Exif\x00\x00") else payload
            if _tiff_contains_tag(exif_tiff, 0x8825):
                sensitive.add("gps")
            if _tiff_contains_tag(exif_tiff, 0x927C):
                sensitive.add("maker_notes")
            if _tiff_contains_tag(exif_tiff, 0x0201) or _tiff_contains_tag(exif_tiff, 0x0202):
                sensitive.add("embedded_thumbnails")
        elif kind == b"XMP ":
            sensitive.add("xmp")
        elif kind == b"ANMF":
            animation_frames += 1
        offset = payload_end + (size & 1)
    if width < 1 or height < 1:
        raise ValueError("WebP frame dimensions were not found in the bounded header")
    return (
        width,
        height,
        8,
        alpha,
        icc,
        None,
        max(1, animation_frames),
        tuple(sorted(sensitive)),
        "rgb",
    )


def _tiff(data: bytes) -> RasterHeader:
    if len(data) < 8 or data[:2] not in {b"II", b"MM"}:
        raise ValueError("TIFF header is truncated")
    endian = "<" if data[:2] == b"II" else ">"
    if struct.unpack(endian + "H", data[2:4])[0] != 42:
        raise ValueError("TIFF version is unsupported")
    bounded = data[: 1024 * 1024]

    def u16(offset: int) -> int:
        if offset < 0 or offset + 2 > len(bounded):
            raise ValueError("TIFF directory is outside the bounded header")
        return int(struct.unpack(endian + "H", bounded[offset : offset + 2])[0])

    def u32(offset: int) -> int:
        if offset < 0 or offset + 4 > len(bounded):
            raise ValueError("TIFF directory is outside the bounded header")
        return int(struct.unpack(endian + "I", bounded[offset : offset + 4])[0])

    def values(entry: int, value_type: int, count: int) -> list[int]:
        sizes = {1: 1, 3: 2, 4: 4}
        size = sizes.get(value_type)
        if size is None or count < 1 or count > 16:
            return []
        total = size * count
        start = entry + 8 if total <= 4 else u32(entry + 8)
        if start + total > len(bounded):
            raise ValueError("TIFF tag value is outside the bounded header")
        if value_type == 1:
            return list(bounded[start : start + count])
        code = "H" if value_type == 3 else "I"
        return list(struct.unpack(endian + code * count, bounded[start : start + total]))

    first_ifd = u32(4)
    if first_ifd < 8:
        raise ValueError("TIFF first directory is invalid")
    ifd = first_ifd
    seen: set[int] = set()
    first_tags: dict[int, list[int]] = {}
    sensitive: set[str] = set()
    frames = 0
    while ifd and frames < 64:
        if ifd in seen:
            raise ValueError("TIFF directory chain is cyclic")
        seen.add(ifd)
        count = u16(ifd)
        if count > 512:
            raise ValueError("TIFF directory contains too many tags")
        directory_end = ifd + 2 + count * 12
        if directory_end + 4 > len(bounded):
            raise ValueError("TIFF directory is truncated")
        tags: dict[int, list[int]] = {}
        for index in range(count):
            entry = ifd + 2 + index * 12
            tag = u16(entry)
            tags[tag] = values(entry, u16(entry + 2), u32(entry + 4))
            category = {
                270: "description",
                305: "software_device",
                315: "software_device",
                33432: "copyright",
                33723: "iptc",
                34665: "exif",
                34853: "gps",
                37500: "maker_notes",
                513: "embedded_thumbnails",
                514: "embedded_thumbnails",
                700: "xmp",
            }.get(tag)
            if category:
                sensitive.add(category)
        if not first_tags:
            first_tags = tags
        frames += 1
        ifd = u32(directory_end)
    if ifd:
        raise ValueError("TIFF contains more than 64 image directories")
    for tag, category in (
        (34665, "exif"),
        (34853, "gps"),
        (37500, "maker_notes"),
        (513, "embedded_thumbnails"),
        (514, "embedded_thumbnails"),
        (700, "xmp"),
    ):
        if _tiff_contains_tag(bounded, tag):
            sensitive.add(category)

    def first(tag: int, default: int = 0) -> int:
        items = first_tags.get(tag, [])
        return items[0] if items else default

    width, height = first(256), first(257)
    bits = first_tags.get(258, [1])
    depth = max(bits)
    samples = first(277, len(bits))
    photometric = first(262, -1)
    if width < 1 or height < 1 or depth < 1:
        raise ValueError("TIFF dimensions or sample depth are invalid")
    colour_model = {
        0: "grayscale",
        1: "grayscale",
        2: "rgb",
        3: "indexed",
        5: "cmyk",
    }.get(photometric)
    if colour_model is None:
        raise ValueError("TIFF photometric interpretation is unsupported")
    if colour_model == "cmyk" and samples < 4:
        raise ValueError("TIFF CMYK samples are incomplete")
    orientation = first(274, 1)
    if orientation < 1 or orientation > 8:
        orientation = 1
    has_alpha = bool(first_tags.get(338)) or (
        samples > (4 if colour_model == "cmyk" else 3 if colour_model == "rgb" else 1)
    )
    return (
        width,
        height,
        depth,
        has_alpha,
        34675 in first_tags,
        orientation if orientation != 1 else None,
        frames,
        tuple(sorted(sensitive)),
        colour_model,
    )


def _simple_image(media_type: str, data: bytes) -> RasterHeader:
    if media_type == "image/gif":
        if len(data) < 10:
            raise ValueError("GIF header is truncated")
        width, height = struct.unpack("<HH", data[6:10])
        return width, height, 8, False, False, None, 1, (), "indexed"
    if media_type == "image/bmp":
        if len(data) < 30:
            raise ValueError("BMP header is truncated")
        width, height = struct.unpack("<ii", data[18:26])
        depth = struct.unpack("<H", data[28:30])[0]
        return abs(width), abs(height), depth, depth == 32, False, None, 1, (), "rgb"
    if media_type == "image/webp":
        return _webp(data)
    if media_type == "image/tiff":
        return _tiff(data)
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
    if malware_state in {"unavailable", "timeout", "error"}:
        return _reject("scanner-unavailable", "The required safety scanner is unavailable")

    digest = hashlib.sha256(data).hexdigest()
    if detected == "application/pdf":
        return _inspect_pdf(data, digest, policy)
    try:
        if detected == "image/png":
            parsed = _png(data)
        elif detected == "image/jpeg":
            parsed = _jpeg(data)
        else:
            parsed = _simple_image(detected, data)
        width, height, depth, alpha, icc, orientation, frames, sensitive, colour_model = parsed
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
        colour_model=SourceColourModel(colour_model),
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
