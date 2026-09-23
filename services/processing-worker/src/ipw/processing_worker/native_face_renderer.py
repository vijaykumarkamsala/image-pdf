"""Native, exact-region face composition for Image Quality Editor.

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


@dataclass(frozen=True)
class ApngControl:
    frame_count: int
    loop_count: int
    has_default_image: bool
    delays: tuple[tuple[int, int], ...]


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


def _png_authority(
    path: Path, *, allow_animation: bool = False
) -> tuple[int, int, int, int, list[tuple[bytes, bytes]]]:
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
            if kind in {b"acTL", b"fcTL", b"fdAT"} and not allow_animation:
                raise NativeFaceRenderError(
                    "Animated face results need temporal proposals; no frame was flattened"
                )
            if kind == b"tRNS" or (
                kind[:1].isupper()
                and kind not in {b"IHDR", b"IDAT", b"IEND", b"acTL", b"fcTL", b"fdAT"}
            ):
                raise NativeFaceRenderError(
                    "This PNG layout requires a separate native face adapter"
                )
            if kind not in {b"IDAT", b"fdAT"}:
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
            if kind in {b"IDAT", b"fdAT"}:
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
    return _colour_sha256(_png_authority(path, allow_animation=True)[4])


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


def _apng_control(path: Path, width: int, height: int) -> ApngControl:
    frame_count: int | None = None
    loop_count = 0
    delays: list[tuple[int, int]] = []
    saw_idat = False
    first_frame_control_before_idat: bool | None = None
    with path.open("rb") as handle:
        if handle.read(8) != PNG_SIGNATURE:
            raise NativeFaceRenderError("The temporal face base must be a verified APNG")
        while True:
            header = handle.read(8)
            if len(header) != 8:
                raise NativeFaceRenderError("Temporal face APNG is truncated")
            length, kind = struct.unpack(">I4s", header)
            payload = handle.read(length)
            expected = handle.read(4)
            if len(payload) != length or len(expected) != 4 or (
                struct.unpack(">I", expected)[0] != zlib.crc32(kind + payload) & 0xFFFFFFFF
            ):
                raise NativeFaceRenderError("Temporal face APNG chunk checksum failed")
            if kind == b"acTL":
                if frame_count is not None or length != 8:
                    raise NativeFaceRenderError("Temporal face APNG repeats its animation control")
                frame_count, loop_count = struct.unpack(">II", payload)
                if not frame_count or frame_count > 10_000:
                    raise NativeFaceRenderError("Temporal face APNG frame count is invalid")
            elif kind == b"fcTL":
                if length != 26:
                    raise NativeFaceRenderError("Temporal face APNG frame control is invalid")
                if first_frame_control_before_idat is None:
                    first_frame_control_before_idat = not saw_idat
                (
                    _sequence,
                    frame_width,
                    frame_height,
                    x,
                    y,
                    delay_numerator,
                    delay_denominator,
                    disposal,
                    blend,
                ) = struct.unpack(">IIIIIHHBB", payload)
                if (
                    (frame_width, frame_height, x, y) != (width, height, 0, 0)
                    or disposal != 0
                    or blend != 0
                    or delay_numerator == 0
                ):
                    raise NativeFaceRenderError(
                        "Temporal face composition requires full-canvas source-blend APNG frames"
                    )
                delays.append((delay_numerator, delay_denominator or 100))
            elif kind == b"IDAT":
                saw_idat = True
            elif kind == b"IEND":
                break
    if frame_count is None or frame_count != len(delays) or first_frame_control_before_idat is None:
        raise NativeFaceRenderError("Temporal face APNG frame metadata is incomplete")
    return ApngControl(frame_count, loop_count, not first_frame_control_before_idat, tuple(delays))


def _write_compressed_rgba(
    target: Any,
    raw_path: Path,
    *,
    width: int,
    height: int,
    kind: bytes,
    next_sequence: int,
    cancelled: Callable[[], bool] | None,
) -> int:
    compressor = zlib.compressobj(6)
    pending = bytearray()

    def flush_chunks() -> None:
        nonlocal next_sequence
        while len(pending) >= 1024 * 1024:
            payload = bytes(pending[: 1024 * 1024])
            del pending[: 1024 * 1024]
            if kind == b"fdAT":
                payload = struct.pack(">I", next_sequence) + payload
                next_sequence += 1
            _chunk(target, kind, payload)

    with raw_path.open("rb") as source:
        for _row in range(height):
            _check_cancel(cancelled)
            row = source.read(width * 4)
            if len(row) != width * 4:
                raise NativeFaceRenderError("Temporal face scratch frame is incomplete")
            pending.extend(compressor.compress(b"\0" + row))
            flush_chunks()
        if source.read(1):
            raise NativeFaceRenderError("Temporal face scratch frame has trailing pixels")
    pending.extend(compressor.flush())
    flush_chunks()
    if pending:
        payload = bytes(pending)
        if kind == b"fdAT":
            payload = struct.pack(">I", next_sequence) + payload
            next_sequence += 1
        _chunk(target, kind, payload)
    return next_sequence


def _encode_apng(
    path: Path,
    *,
    width: int,
    height: int,
    colours: list[tuple[bytes, bytes]],
    control: ApngControl,
    default_frame: Path | None,
    frames: list[Path],
    evidence: dict[str, Any],
    cancelled: Callable[[], bool] | None,
) -> None:
    if len(frames) != control.frame_count or bool(default_frame) != control.has_default_image:
        raise NativeFaceRenderError("Temporal face frame/timing evidence changed before encoding")
    sequence = 0
    with path.open("xb") as target:
        target.write(PNG_SIGNATURE)
        _chunk(target, b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        for kind, payload in colours:
            _chunk(target, kind, payload)
        provenance = json.dumps(
            evidence, sort_keys=True, separators=(",", ":"), ensure_ascii=True
        ).encode("ascii")
        _chunk(target, b"iTXt", b"ipw-provenance\0\0\0\0\0" + provenance)
        _chunk(target, b"acTL", struct.pack(">II", control.frame_count, control.loop_count))
        if default_frame is not None:
            sequence = _write_compressed_rgba(
                target,
                default_frame,
                width=width,
                height=height,
                kind=b"IDAT",
                next_sequence=sequence,
                cancelled=cancelled,
            )
        for index, frame in enumerate(frames):
            numerator, denominator = control.delays[index]
            _chunk(
                target,
                b"fcTL",
                struct.pack(
                    ">IIIIIHHBB",
                    sequence,
                    width,
                    height,
                    0,
                    0,
                    numerator,
                    denominator,
                    0,
                    0,
                ),
            )
            sequence += 1
            sequence = _write_compressed_rgba(
                target,
                frame,
                width=width,
                height=height,
                kind=b"fdAT" if default_frame is not None or index else b"IDAT",
                next_sequence=sequence,
                cancelled=cancelled,
            )
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
        if context.frame_count > 1:
            return self._compose_animation(
                request,
                release=release,
                source_path=source_path,
                base_path=base_path,
                pixels=pixels,
                mask=mask,
                output_path=output_path,
                cancelled=cancelled,
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
                    "candidate": candidate.model_dump(mode="json", exclude_defaults=True),
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

    def _compose_animation(
        self,
        request: NativeFaceCompositionRequest,
        *,
        release: NativeFaceRelease,
        source_path: Path,
        base_path: Path,
        pixels: np.ndarray[Any, Any],
        mask: np.ndarray[Any, Any],
        output_path: Path,
        cancelled: Callable[[], bool] | None,
    ) -> NativeFaceRenderResult:
        candidate, context = request.candidate, request.candidate.context
        region = candidate.region
        if context.bit_depth != 8 or (
            pixels.dtype != np.dtype("uint8")
            or pixels.shape
            != (context.frame_count, region.height, region.width, 4)
            or mask.dtype != np.dtype("uint8")
            or mask.shape != (context.frame_count, region.height, region.width)
        ):
            raise NativeFaceRenderError(
                "Temporal native face patches require one uint8 RGBA patch and mask per frame"
            )
        proposal, weights = pixels.copy(), mask.copy()
        if native_face_pixel_sha256(proposal) != candidate.pixels_sha256 or (
            hashlib.sha256(weights.tobytes()).hexdigest() != candidate.mask_sha256
        ):
            raise NativeFaceRenderError(
                "Temporal face patches or reconstruction masks failed their digest check"
            )
        if (
            _hash_file(source_path) != context.source_sha256
            or _hash_file(base_path) != context.base_output_sha256
        ):
            raise NativeFaceRenderError(
                "The immutable animated source or base failed its digest check"
            )
        width, height, depth, _bands, colours = _png_authority(
            base_path, allow_animation=True
        )
        control = _apng_control(base_path, width, height)
        if (
            (width, height, depth, control.frame_count)
            != (
                context.output_width,
                context.output_height,
                context.bit_depth,
                context.frame_count,
            )
            or _colour_sha256(colours) != context.colour_authority_sha256
        ):
            raise NativeFaceRenderError(
                "Temporal face base dimensions, frames or colour authority changed"
            )
        scratch_bytes = width * height * 4 * (control.frame_count + int(control.has_default_image))
        if (
            scratch_bytes > MAX_SCRATCH_BYTES
            or shutil.disk_usage(output_path.parent).free
            < scratch_bytes * 2 + 16 * 1024 * 1024
        ):
            raise NativeFaceRenderError(
                "Temporal face rendering needs more private scratch storage; "
                "no frames were dropped or resized"
            )
        try:
            from PIL import Image, UnidentifiedImageError
        except ImportError as error:
            raise NativeFaceRenderError("The temporal image runtime is unavailable") from error

        with tempfile.TemporaryDirectory(
            prefix="ipw-native-face-animation-", dir=output_path.parent
        ) as temporary:
            temporary_path = Path(temporary)
            raw_frames: list[Path] = []
            default_frame: Path | None = None
            changed = 0
            try:
                with Image.open(base_path) as opened:
                    expected_decoded = control.frame_count + int(control.has_default_image)
                    if (
                        opened.size != (width, height)
                        or int(getattr(opened, "n_frames", 1)) != expected_decoded
                        or bool(opened.info.get("default_image", False))
                        != control.has_default_image
                    ):
                        raise NativeFaceRenderError(
                            "Temporal face decoder returned different framing"
                        )
                    for decoded_index in range(expected_decoded):
                        _check_cancel(cancelled)
                        opened.seek(decoded_index)
                        frame = np.asarray(opened.convert("RGBA"), dtype=np.uint8).copy()
                        raw_path = temporary_path / f"frame-{decoded_index:08d}.rgba"
                        if control.has_default_image and decoded_index == 0:
                            frame.tofile(raw_path)
                            default_frame = raw_path
                            continue
                        frame_index = decoded_index - int(control.has_default_image)
                        target = frame[
                            region.y : region.y + region.height,
                            region.x : region.x + region.width,
                        ]
                        for row in range(region.height):
                            _check_cancel(cancelled)
                            original = target[row, :, :3].copy()
                            weight = weights[frame_index, row].astype(np.uint32)[:, None]
                            fused = (
                                (
                                    original.astype(np.uint32) * (255 - weight)
                                    + proposal[frame_index, row, :, :3].astype(np.uint32) * weight
                                    + 127
                                )
                                // 255
                            ).astype(np.uint8)
                            eligible = (weights[frame_index, row] != 0) & (
                                target[row, :, 3] != 0
                            )
                            fused[~eligible] = original[~eligible]
                            changed += int(np.count_nonzero(np.any(fused != original, axis=1)))
                            target[row, :, :3] = fused
                        frame.tofile(raw_path)
                        raw_frames.append(raw_path)
            except (UnidentifiedImageError, OSError, EOFError) as error:
                raise NativeFaceRenderError(
                    "Temporal face base could not be decoded safely"
                ) from error
            if changed == 0:
                raise NativeFaceRenderError(
                    "This reviewed temporal face proposal makes no pixel correction"
                )
            evidence = {
                "contract_version": request.contract_version,
                "kind": "explicit-face-recreate",
                "candidate_sha256": native_face_candidate_sha256(candidate),
                "candidate": candidate.model_dump(mode="json", exclude_defaults=True),
                "review": request.review.model_dump(mode="json"),
                "model_id": release.model_id,
                "model_version": release.model_version,
                "rights_evidence_id": release.rights_evidence_id,
                "quality_evidence_id": release.quality_evidence_id,
                "processor": "ipw-native-face-renderer@1.1.0",
                "changed_pixels": changed,
                "frame_count": context.frame_count,
                "loop_count": control.loop_count,
                "frame_delays": [list(value) for value in control.delays],
                "colour_policy": "exact-base-native-colour-and-precision",
                "alpha_policy": "exact-base-alpha",
                "animation_policy": "all-frames-reviewed-no-flattening",
            }
            png = temporary_path / "reviewed.apng"
            _encode_apng(
                png,
                width=width,
                height=height,
                colours=colours,
                control=control,
                default_frame=default_frame,
                frames=raw_frames,
                evidence=evidence,
                cancelled=cancelled,
            )
            _check_cancel(cancelled)
            if (
                _hash_file(source_path) != context.source_sha256
                or _hash_file(base_path) != context.base_output_sha256
            ):
                raise NativeFaceRenderError(
                    "The animated source or base changed during native face rendering"
                )
            verified = _apng_control(png, width, height)
            if verified != control:
                raise NativeFaceRenderError("Temporal face timing changed during encoding")
            output_sha256 = _hash_file(png)
            byte_size = png.stat().st_size
            try:
                os.link(png, output_path)
            except FileExistsError as error:
                raise NativeFaceRenderError(
                    "Native face output already exists; no file was overwritten"
                ) from error
            return NativeFaceRenderResult(
                output_path, output_sha256, byte_size, changed, evidence
            )
