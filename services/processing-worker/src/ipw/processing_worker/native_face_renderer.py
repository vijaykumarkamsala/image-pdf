"""Native, exact-region still-image face composition for Image Quality Editor.

This renderer is not a released face-restoration model or a public task endpoint.
Its caller must supply a server-held, reviewed native-colour patch and cleared
release. Originals/base bytes are immutable; only private scratch pixels change.
"""

from __future__ import annotations

import hashlib
import json
import mmap
import os
import shutil
import struct
import tempfile
import zlib
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from ipw.contracts.image_quality_face import (
    NativeFaceCompositionRequest,
    NativeFaceRelease,
    native_face_candidate_sha256,
)

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
COLOUR_CHUNKS = frozenset({b"iCCP", b"sRGB", b"gAMA", b"cHRM", b"cICP", b"mDCV", b"cLLI"})
MAX_METADATA_BYTES = 16 * 1024 * 1024
MAX_SCRATCH_BYTES = 4 * 1024**4


class NativeFaceRenderError(ValueError):
    """A rejected proposal never replaces the immutable source/base or a file."""


class NativeFaceRenderCancelledError(RuntimeError):
    """Cancellation leaves no published derivative."""


@dataclass(frozen=True)
class NativeFaceRenderResult:
    path: Path
    sha256: str
    byte_size: int
    changed_pixels: int
    evidence: dict[str, Any]


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def native_face_pixel_sha256(pixels: np.ndarray[Any, Any]) -> str:
    if pixels.dtype not in {np.dtype("uint8"), np.dtype("uint16")}:
        raise NativeFaceRenderError("Face pixels must retain native uint8/uint16 precision")
    dtype = "<u2" if pixels.dtype.itemsize == 2 else "u1"
    return hashlib.sha256(pixels.astype(dtype, copy=False).tobytes(order="C")).hexdigest()


def _png_authority(path: Path) -> tuple[int, int, int, int, list[tuple[bytes, bytes]]]:
    """Check every chunk CRC without loading compressed image bytes into RAM.

    Accept only full-channel, non-interlaced still RGB/RGBA PNG bases. Palette,
    keyed transparency and APNG need explicit native adapters, not flattening.
    Sensitive metadata is deliberately excluded from the new PNG.
    """
    colours: list[tuple[bytes, bytes]] = []
    authority: tuple[int, int, int, int] | None = None
    metadata_bytes = 0
    saw_data = False
    with path.open("rb") as handle:
        if handle.read(8) != PNG_SIGNATURE:
            raise NativeFaceRenderError("The native face base must be a verified PNG")
        for chunk_index in range(1_000_000):
            header = handle.read(8)
            if len(header) != 8:
                raise NativeFaceRenderError("Native face PNG is truncated")
            length, kind = struct.unpack(">I4s", header)
            if chunk_index == 0 and (kind != b"IHDR" or length != 13):
                raise NativeFaceRenderError("Native face PNG has no valid first header")
            if kind in {b"acTL", b"fcTL", b"fdAT"}:
                raise NativeFaceRenderError(
                    "Animated face results need temporal proposals; no frame was flattened"
                )
            if kind == b"tRNS" or (kind[:1].isupper() and kind not in {b"IHDR", b"IDAT", b"IEND"}):
                raise NativeFaceRenderError(
                    "This PNG layout requires a separate native face adapter"
                )
            if kind != b"IDAT":
                metadata_bytes += length
                if metadata_bytes > MAX_METADATA_BYTES:
                    raise NativeFaceRenderError(
                        "Native face PNG metadata exceeds the safe parser budget"
                    )
            checksum = zlib.crc32(kind)
            payload = bytearray()
            remaining = length
            while remaining:
                block = handle.read(min(1024 * 1024, remaining))
                if not block:
                    raise NativeFaceRenderError("Native face PNG is truncated")
                checksum = zlib.crc32(block, checksum)
                if kind in COLOUR_CHUNKS or kind == b"IHDR":
                    payload.extend(block)
                remaining -= len(block)
            expected = handle.read(4)
            if len(expected) != 4 or struct.unpack(">I", expected)[0] != checksum & 0xFFFFFFFF:
                raise NativeFaceRenderError("Native face PNG chunk checksum failed")
            if kind == b"IHDR":
                if authority is not None:
                    raise NativeFaceRenderError("Native face PNG repeats its header")
                width, height, depth, layout, compression, filtering, interlace = struct.unpack(
                    ">IIBBBBB", payload
                )
                if (
                    not width
                    or not height
                    or depth not in {8, 16}
                    or layout not in {2, 6}
                    or any((compression, filtering, interlace))
                ):
                    raise NativeFaceRenderError(
                        "This PNG precision/layout needs a separate native face adapter"
                    )
                authority = (width, height, depth, 4 if layout == 6 else 3)
            if kind in COLOUR_CHUNKS:
                if saw_data or any(found_kind == kind for found_kind, _ in colours):
                    raise NativeFaceRenderError(
                        "Native face PNG colour authority has invalid ordering or duplicates"
                    )
                colours.append((kind, bytes(payload)))
            if kind == b"IDAT":
                saw_data = True
            if kind == b"IEND":
                if length or not saw_data or not authority or handle.read(1):
                    raise NativeFaceRenderError("Native face PNG has an invalid ending")
                return (*authority, colours)
    raise NativeFaceRenderError("Native face PNG exceeds the parser chunk budget")


def _colour_sha256(colours: list[tuple[bytes, bytes]]) -> str:
    canonical = [[kind.decode("ascii"), payload.hex()] for kind, payload in colours]
    encoded = json.dumps(["ipw-native-face-colour-v1", canonical], separators=(",", ":"))
    return hashlib.sha256(encoded.encode("ascii")).hexdigest()


def native_face_colour_sha256(path: Path) -> str:
    """Bind exact ICC/transfer/primaries metadata; an untagged base stays untagged."""
    return _colour_sha256(_png_authority(path)[4])


def inspect_native_face_png(
    path: Path,
) -> tuple[int, int, int, int, list[tuple[bytes, bytes]]]:
    """Expose the CRC-verified native PNG authority to worker-owned adapters."""
    return _png_authority(path)


def _chunk(target: Any, kind: bytes, payload: bytes) -> None:
    target.write(struct.pack(">I4s", len(payload), kind))
    target.write(payload)
    target.write(struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF))


def _check_cancel(cancelled: Callable[[], bool] | None) -> None:
    if cancelled and cancelled():
        raise NativeFaceRenderCancelledError(
            "Native face rendering cancelled; your original and base are unchanged"
        )


def _encode_png(
    path: Path,
    pixels: np.ndarray[Any, Any],
    depth: int,
    colours: list[tuple[bytes, bytes]],
    evidence: dict[str, Any],
    cancelled: Callable[[], bool] | None,
) -> None:
    height, width, bands = pixels.shape
    compressed = bytearray()
    compressor = zlib.compressobj(6)
    with path.open("xb") as target:
        target.write(PNG_SIGNATURE)
        _chunk(
            target,
            b"IHDR",
            struct.pack(">IIBBBBB", width, height, depth, 6 if bands == 4 else 2, 0, 0, 0),
        )
        for kind, payload in colours:
            _chunk(target, kind, payload)
        provenance = json.dumps(
            evidence, sort_keys=True, separators=(",", ":"), ensure_ascii=True
        ).encode("ascii")
        _chunk(target, b"iTXt", b"ipw-provenance\0\0\0\0\0" + provenance)
        # Disk-backed raw rows, bounded column blocks, no whole-image Python array.
        for row in range(height):
            _check_cancel(cancelled)
            compressed.extend(compressor.compress(b"\0"))
            for left in range(0, width, 4096):
                _check_cancel(cancelled)
                values = pixels[row, left : left + 4096]
                block = (
                    values.astype(">u2", copy=False).tobytes() if depth == 16 else values.tobytes()
                )
                compressed.extend(compressor.compress(block))
                if len(compressed) >= 1024 * 1024:
                    _chunk(target, b"IDAT", bytes(compressed))
                    compressed.clear()
        compressed.extend(compressor.flush())
        if compressed:
            _chunk(target, b"IDAT", bytes(compressed))
        _chunk(target, b"IEND", b"")
        target.flush()
        os.fsync(target.fileno())


class NativeFaceRenderer:
    def compose(
        self,
        request: NativeFaceCompositionRequest,
        *,
        release: NativeFaceRelease,
        source_path: Path,
        base_path: Path,
        pixels: np.ndarray[Any, Any],
        mask: np.ndarray[Any, Any],
        output_path: Path,
        cancelled: Callable[[], bool] | None = None,
    ) -> NativeFaceRenderResult:
        # Revalidate even model_construct/model_copy inputs at the worker trust boundary.
        request = NativeFaceCompositionRequest.model_validate_json(request.model_dump_json())
        release = NativeFaceRelease.model_validate_json(release.model_dump_json())
        candidate, context = request.candidate, request.candidate.context
        if (
            release.commercial_rights != "approved"
            or not release.rights_evidence_id
            or (release.quality_review != "approved" or not release.quality_evidence_id)
        ):
            raise NativeFaceRenderError(
                "Native face model rights and quality evidence are not approved"
            )
        if (
            release.model_sha256 != candidate.model_sha256
            or release.dependency_lock_sha256 != candidate.dependency_lock_sha256
        ):
            raise NativeFaceRenderError(
                "Native face proposal belongs to a different model/dependency release"
            )
        _check_cancel(cancelled)
        if output_path.exists() or output_path.is_symlink():
            raise NativeFaceRenderError(
                "Native face output already exists; no file was overwritten"
            )
        region = candidate.region
        dtype = np.dtype("uint16" if context.bit_depth == 16 else "uint8")
        if (
            pixels.dtype != dtype
            or pixels.shape != (region.height, region.width, 4)
            or (mask.dtype != np.dtype("uint8") or mask.shape != (region.height, region.width))
        ):
            raise NativeFaceRenderError("Native face patch/mask shape or channel precision changed")
        # Snapshot only the bounded region, so an asynchronous producer cannot change it.
        proposal, weights = pixels.copy(), mask.copy()
        if native_face_pixel_sha256(proposal) != candidate.pixels_sha256 or (
            hashlib.sha256(weights.tobytes()).hexdigest() != candidate.mask_sha256
        ):
            raise NativeFaceRenderError(
                "Native face patch or reconstruction mask failed its digest check"
            )
        if (
            _hash_file(source_path) != context.source_sha256
            or _hash_file(base_path) != context.base_output_sha256
        ):
            raise NativeFaceRenderError(
                "The immutable source or base result failed its digest check"
            )
        width, height, depth, bands, colours = _png_authority(base_path)
        if (width, height, depth) != (
            context.output_width,
            context.output_height,
            context.bit_depth,
        ) or (_colour_sha256(colours) != context.colour_authority_sha256):
            raise NativeFaceRenderError(
                "Native face base dimensions, precision or colour authority changed"
            )
        scratch_bytes = width * height * bands * dtype.itemsize
        if (
            scratch_bytes > MAX_SCRATCH_BYTES
            or shutil.disk_usage(output_path.parent).free < scratch_bytes * 2 + 8 * 1024 * 1024
        ):
            raise NativeFaceRenderError(
                "Native face rendering needs more private scratch storage; "
                "no smaller output was substituted"
            )
        try:
            import pyvips
        except (ImportError, OSError) as error:
            raise NativeFaceRenderError("The native face colour runtime is unavailable") from error

        with tempfile.TemporaryDirectory(
            prefix="ipw-native-face-", dir=output_path.parent
        ) as temporary:
            temporary_path = Path(temporary)
            raw, png = temporary_path / "decoded.pixels", temporary_path / "reviewed.png"
            base = pyvips.Image.new_from_file(str(base_path), access="sequential", fail_on="error")
            if (base.width, base.height, base.bands, base.format) != (
                width,
                height,
                bands,
                "ushort" if depth == 16 else "uchar",
            ):
                raise NativeFaceRenderError(
                    "Native face decoder did not retain the verified base layout"
                )
            _check_cancel(cancelled)
            base.rawsave(str(raw))
            if raw.stat().st_size != scratch_bytes:
                raise NativeFaceRenderError(
                    "Native face decoder returned an incomplete pixel artifact"
                )
            _check_cancel(cancelled)
            with raw.open("r+b") as raw_handle:
                mapping = mmap.mmap(raw_handle.fileno(), 0)
            disk = np.ndarray((height, width, bands), dtype=dtype, buffer=mapping)
            try:
                target = disk[
                    region.y : region.y + region.height, region.x : region.x + region.width
                ]
                changed = 0
                for row in range(region.height):
                    _check_cancel(cancelled)
                    original = target[row, :, :3].copy()
                    weight = weights[row].astype(np.uint32)[:, None]
                    fused = (
                        (
                            original.astype(np.uint32) * (255 - weight)
                            + proposal[row, :, :3].astype(np.uint32) * weight
                            + 127
                        )
                        // 255
                    ).astype(dtype)
                    eligible = weights[row] != 0
                    if bands == 4:
                        eligible &= target[row, :, 3] != 0
                    fused[~eligible] = original[~eligible]
                    changed += int(np.count_nonzero(np.any(fused != original, axis=1)))
                    target[row, :, :3] = fused
                if changed == 0:
                    raise NativeFaceRenderError(
                        "This reviewed face proposal makes no pixel correction"
                    )
                mapping.flush()
                evidence = {
                    "contract_version": request.contract_version,
                    "kind": "explicit-face-recreate",
                    "candidate_sha256": native_face_candidate_sha256(candidate),
                    "candidate": candidate.model_dump(mode="json"),
                    "review": request.review.model_dump(mode="json"),
                    "model_id": release.model_id,
                    "model_version": release.model_version,
                    "rights_evidence_id": release.rights_evidence_id,
                    "quality_evidence_id": release.quality_evidence_id,
                    "processor": "ipw-native-face-renderer@1.0.0",
                    "changed_pixels": changed,
                    "colour_policy": "exact-base-native-colour-and-precision",
                    "alpha_policy": "exact-base-alpha",
                }
                _encode_png(png, disk, depth, colours, evidence, cancelled)
                _check_cancel(cancelled)
                if (
                    _hash_file(source_path) != context.source_sha256
                    or _hash_file(base_path) != context.base_output_sha256
                ):
                    raise NativeFaceRenderError(
                        "The source or base changed during native face rendering"
                    )
                output_sha256 = _hash_file(png)
                byte_size = png.stat().st_size
                # Atomic, exclusive publication. Never replace an existing path.
                _check_cancel(cancelled)
                try:
                    os.link(png, output_path)
                except FileExistsError as error:
                    raise NativeFaceRenderError(
                        "Native face output already exists; no file was overwritten"
                    ) from error
                return NativeFaceRenderResult(
                    output_path, output_sha256, byte_size, changed, evidence
                )
            finally:
                if "target" in locals():
                    del target
                del disk
                mapping.close()  # Close the owned scratch mapping before Windows cleanup.
