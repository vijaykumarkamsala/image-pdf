"""Licensed neural restoration engine for the isolated Image Quality Editor.

The model is allowed to restore photographic/illustrative assets only.  Flat
graphics stay on the deterministic contour pipeline because a perceptual model
can repaint brand colours and geometry.  Source bytes are immutable; this
module returns a new PNG derivative plus enough identity evidence to reproduce
the operation.
"""

from __future__ import annotations

import gc
import hashlib
import io
import struct
import tempfile
import zlib
from collections.abc import Callable, Sequence
from contextlib import ExitStack
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Literal, Protocol, cast

import numpy as np
import onnxruntime as ort  # type: ignore[import-untyped]
from PIL import Image, ImageCms, ImageOps, UnidentifiedImageError

from ipw.processing_worker.enhancement_engine import CANONICAL_SRGB_PROFILE

MODEL_ID = "public-realplksr-2x"
MODEL_VERSION = "2xPublic_realplksr_dysample_layernorm_real@90313fd/onnx-op17"
MODEL_FILENAME = "2xPublic_realplksr_dysample_layernorm_real_fp32_op17.onnx"
MODEL_SHA256 = "4c5c658893c927af11238d4aa767a7cb0bfcae773b98a7da3a6c486efa024f5f"
MODEL_BYTE_SIZE = 29_792_727
MODEL_INPUT_NAME = "input.1"
MODEL_OUTPUT_NAME = "2813"
MODEL_INPUT_SIZE = 256
MODEL_SCALE = 2
MODEL_CONTEXT = 24
MODEL_CORE = MODEL_INPUT_SIZE - MODEL_CONTEXT * 2
PROCESSOR_NAME = "ipw-public-realplksr-restoration"
PROCESSOR_VERSION = "1.0.0"
FLAT_ENGINE_ID = "ipw-deterministic-flat-graphic"
FLAT_ENGINE_VERSION = "1.0.0"
FLAT_ENGINE_SHA256 = hashlib.sha256(
    b"ipw-deterministic-flat-graphic/lanczos3/source-colour-v1"
).hexdigest()
FLAT_PROCESSOR_NAME = "ipw-deterministic-flat-graphic-restoration"
FLAT_PROCESSOR_VERSION = "1.0.0"
FLAT_SCALE = 4
SUPPORTED_MEDIA_TYPES = frozenset({"image/jpeg", "image/png", "image/webp"})
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
PNG_COLOUR_CHUNKS = frozenset({b"cICP", b"mDCV", b"cLLI"})

ContentClass = Literal["photo", "illustration", "flat-graphic"]
ProgressCallback = Callable[[int, int], None]
CancellationCheck = Callable[[], bool]


class ImageQualityModelError(ValueError):
    """A safe, customer-actionable model or source failure."""


class ImageQualityCancelledError(RuntimeError):
    """The caller requested cancellation between independently safe tiles."""


class InferenceSession(Protocol):
    def run(
        self, output_names: Sequence[str], input_feed: dict[str, np.ndarray[Any, Any]]
    ) -> list[Any]: ...


SessionFactory = Callable[[str, Sequence[str]], InferenceSession]


@dataclass(frozen=True)
class ImageQualitySource:
    data: bytes
    sha256: str
    media_type: str
    width: int
    height: int
    frame_count: int
    bit_depth: int
    content_class: ContentClass
    has_icc_profile: bool
    colour_primaries: str | None = None
    dynamic_range: str | None = None


@dataclass(frozen=True)
class RestorationFidelity:
    low_texture_mean_rgb_shift: float
    high_drift_fraction: float
    alpha_mismatch_fraction: float
    overall_mean_rgb_difference: float
    passed: bool


@dataclass(frozen=True)
class RestoredTile:
    data: bytes
    fidelity: RestorationFidelity


TileLoader = Callable[[str], RestoredTile | None]
TileSaver = Callable[[str, RestoredTile], None]


@dataclass(frozen=True)
class RestoredImage:
    data: bytes
    sha256: str
    media_type: str
    width: int
    height: int
    source_sha256: str
    model_id: str
    model_version: str
    model_sha256: str
    processor_name: str
    processor_version: str
    strength: int
    tile_count: int
    colour_policy: str
    fidelity: RestorationFidelity
    artifact_path: Path | None = None
    artifact_byte_size: int | None = None
    frame_count: int = 1
    bit_depth: int = 8
    has_icc_profile: bool = True
    colour_primaries: str | None = None
    dynamic_range: str | None = None
    model_usage: Literal["restore", "deterministic"] = "restore"
    deterministic: bool = False

    @property
    def byte_size(self) -> int:
        return self.artifact_byte_size if self.artifact_byte_size is not None else len(self.data)


def _default_session_factory(path: str, providers: Sequence[str]) -> InferenceSession:
    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    options.log_severity_level = 3
    return cast(
        InferenceSession,
        ort.InferenceSession(path, sess_options=options, providers=list(providers)),
    )


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _png_colour_chunks(path: Path) -> list[tuple[bytes, bytes]]:
    found: list[tuple[bytes, bytes]] = []
    with path.open("rb") as handle:
        if handle.read(8) != PNG_SIGNATURE:
            return []
        for _ in range(256):
            header = handle.read(8)
            if len(header) != 8:
                raise ImageQualityModelError("PNG colour metadata is truncated")
            length, kind = struct.unpack(">I4s", header)
            if kind == b"IDAT":
                break
            if length > 16 * 1024 * 1024:
                raise ImageQualityModelError("PNG metadata chunk exceeds the safe limit")
            payload = handle.read(length)
            checksum = handle.read(4)
            if len(payload) != length or len(checksum) != 4:
                raise ImageQualityModelError("PNG colour metadata is truncated")
            expected = zlib.crc32(kind + payload) & 0xFFFFFFFF
            if struct.unpack(">I", checksum)[0] != expected:
                raise ImageQualityModelError("PNG metadata checksum is invalid")
            if kind in PNG_COLOUR_CHUNKS:
                if kind == b"cICP" and length != 4:
                    raise ImageQualityModelError("PNG cICP colour signalling is malformed")
                found.append((kind, payload))
            if kind == b"IEND":
                break
    return found


def _copy_exact(source: Any, target: Any, length: int) -> None:
    remaining = length
    while remaining:
        block = source.read(min(1024 * 1024, remaining))
        if not block:
            raise ImageQualityModelError("processed PNG is truncated")
        target.write(block)
        remaining -= len(block)


def _inject_png_colour_chunks(path: Path, chunks: list[tuple[bytes, bytes]]) -> None:
    if not chunks:
        return
    replacement = path.with_suffix(".colour-metadata.png")
    selected = {kind for kind, _payload in chunks}
    with path.open("rb") as source, replacement.open("xb") as target:
        if source.read(8) != PNG_SIGNATURE:
            raise ImageQualityModelError("processed PNG signature is invalid")
        target.write(PNG_SIGNATURE)
        inserted = False
        while True:
            header = source.read(8)
            if len(header) != 8:
                raise ImageQualityModelError("processed PNG is truncated")
            length, kind = struct.unpack(">I4s", header)
            if kind in selected:
                source.seek(length, 1)
            else:
                target.write(header)
                _copy_exact(source, target, length)
            checksum = source.read(4)
            if len(checksum) != 4:
                raise ImageQualityModelError("processed PNG is truncated")
            if kind not in selected:
                target.write(checksum)
            if kind == b"IHDR" and not inserted:
                for colour_kind, colour_payload in chunks:
                    target.write(struct.pack(">I4s", len(colour_payload), colour_kind))
                    target.write(colour_payload)
                    target.write(
                        struct.pack(">I", zlib.crc32(colour_kind + colour_payload) & 0xFFFFFFFF)
                    )
                inserted = True
            if kind == b"IEND":
                break
    replacement.replace(path)


class PublicRealPlksrEngine:
    """Tiled native ONNX inference with a source-colour fidelity constraint."""

    def __init__(
        self,
        model_path: Path,
        *,
        providers: Sequence[str] | None = None,
        session_factory: SessionFactory = _default_session_factory,
        verify_model: bool = True,
    ) -> None:
        self._model_path = model_path
        self._providers = tuple(providers or ("CUDAExecutionProvider", "CPUExecutionProvider"))
        self._session_factory = session_factory
        self._session: InferenceSession | None = None
        if verify_model:
            self._verify_model()

    def _verify_model(self) -> None:
        if not self._model_path.is_file():
            raise ImageQualityModelError("approved image restoration model is not installed")
        if self._model_path.stat().st_size != MODEL_BYTE_SIZE:
            raise ImageQualityModelError("image restoration model byte count failed verification")
        if _sha256_file(self._model_path) != MODEL_SHA256:
            raise ImageQualityModelError("image restoration model checksum failed verification")

    def _get_session(self) -> InferenceSession:
        if self._session is None:
            available = set(ort.get_available_providers())
            selected = tuple(provider for provider in self._providers if provider in available)
            if not selected:
                raise ImageQualityModelError("no approved ONNX execution provider is available")
            self._session = self._session_factory(str(self._model_path), selected)
        return self._session

    def restore(
        self,
        source: ImageQualitySource,
        *,
        strength: int,
        progress: ProgressCallback | None = None,
        cancelled: CancellationCheck | None = None,
    ) -> RestoredImage:
        """Restore every verified frame and return a new PNG/APNG derivative."""

        self._validate_source(source, strength)
        if source.frame_count > 1:
            return self._restore_animation(
                source,
                strength=strength,
                progress=progress,
                cancelled=cancelled,
            )
        if source.content_class == "flat-graphic":
            return self._restore_flat_graphic(
                source,
                strength=strength,
                progress=progress,
                cancelled=cancelled,
            )
        rgb, alpha = self._decode_source(source)
        session = self._get_session()
        image, fidelity, tile_count = self._restore_pixels(
            session, rgb, alpha, strength, progress=progress, cancelled=cancelled
        )
        encoded = io.BytesIO()
        image.save(
            encoded,
            format="PNG",
            optimize=False,
            compress_level=6,
            icc_profile=CANONICAL_SRGB_PROFILE,
        )
        payload = encoded.getvalue()
        return RestoredImage(
            data=payload,
            sha256=hashlib.sha256(payload).hexdigest(),
            media_type="image/png",
            width=image.width,
            height=image.height,
            source_sha256=source.sha256,
            model_id=MODEL_ID,
            model_version=MODEL_VERSION,
            model_sha256=MODEL_SHA256,
            processor_name=PROCESSOR_NAME,
            processor_version=PROCESSOR_VERSION,
            strength=strength,
            tile_count=tile_count,
            colour_policy="source-authoritative-chroma/canonical-srgb-output",
            fidelity=fidelity,
        )

    def _restore_flat_graphic(
        self,
        source: ImageQualitySource,
        *,
        strength: int,
        progress: ProgressCallback | None,
        cancelled: CancellationCheck | None,
    ) -> RestoredImage:
        if cancelled is not None and cancelled():
            raise ImageQualityCancelledError("image restoration was cancelled")
        rgb, alpha = self._decode_source(source)
        image = Image.fromarray(rgb, "RGB").resize(
            (source.width * FLAT_SCALE, source.height * FLAT_SCALE),
            Image.Resampling.LANCZOS,
        )
        if alpha is not None:
            image.putalpha(alpha.resize(image.size, Image.Resampling.LANCZOS))
        encoded = io.BytesIO()
        image.save(
            encoded,
            format="PNG",
            optimize=False,
            compress_level=6,
            icc_profile=CANONICAL_SRGB_PROFILE,
        )
        payload = encoded.getvalue()
        if progress is not None:
            progress(1, 1)
        return RestoredImage(
            data=payload,
            sha256=hashlib.sha256(payload).hexdigest(),
            media_type="image/png",
            width=image.width,
            height=image.height,
            source_sha256=source.sha256,
            model_id=FLAT_ENGINE_ID,
            model_version=FLAT_ENGINE_VERSION,
            model_sha256=FLAT_ENGINE_SHA256,
            processor_name=FLAT_PROCESSOR_NAME,
            processor_version=FLAT_PROCESSOR_VERSION,
            strength=strength,
            tile_count=1,
            colour_policy="source-geometry-and-colour/canonical-srgb-output",
            fidelity=self._perfect_fidelity(),
            model_usage="deterministic",
            deterministic=True,
        )

    def _restore_animation(
        self,
        source: ImageQualitySource,
        *,
        strength: int,
        progress: ProgressCallback | None,
        cancelled: CancellationCheck | None,
    ) -> RestoredImage:
        deterministic = source.content_class == "flat-graphic"
        session = None if deterministic else self._get_session()
        restored_frames: list[Image.Image] = []
        durations: list[int] = []
        has_default_image = False
        fidelity_totals = np.zeros(4, dtype=np.float64)
        tile_count = 0
        tiles_per_frame = (
            1
            if deterministic
            else len(range(0, source.height, MODEL_CORE))
            * len(range(0, source.width, MODEL_CORE))
        )
        decoded_frame_count = source.frame_count
        total_tiles = tiles_per_frame * decoded_frame_count
        try:
            with Image.open(io.BytesIO(source.data)) as opened:
                if opened.size != (source.width, source.height):
                    raise ImageQualityModelError("decoded source dimensions changed")
                has_default_image = bool(opened.info.get("default_image", False))
                decoded_frame_count = source.frame_count + (1 if has_default_image else 0)
                if int(getattr(opened, "n_frames", 1)) != decoded_frame_count:
                    raise ImageQualityModelError("decoded source frame count changed")
                total_tiles = tiles_per_frame * decoded_frame_count
                embedded_profile = opened.info.get("icc_profile")
                if bool(embedded_profile) != source.has_icc_profile:
                    raise ImageQualityModelError("decoded source colour-profile state changed")
                profile = (
                    ImageCms.ImageCmsProfile(io.BytesIO(bytes(embedded_profile)))
                    if embedded_profile
                    else None
                )
                loop = int(opened.info.get("loop", 0))
                for frame_index in range(decoded_frame_count):
                    if cancelled is not None and cancelled():
                        raise ImageQualityCancelledError("image restoration was cancelled")
                    opened.seek(frame_index)
                    frame = opened.convert("RGBA")
                    alpha = frame.getchannel("A")
                    rgb_image = frame.convert("RGB")
                    if profile:
                        converted = ImageCms.profileToProfile(
                            rgb_image,
                            profile,
                            ImageCms.createProfile("sRGB"),
                            outputMode="RGB",
                        )
                        if converted is None:
                            raise ImageQualityModelError(
                                "source colour profile could not be converted"
                            )
                        rgb_image = converted
                    rgb = np.asarray(rgb_image, dtype=np.uint8).copy()
                    base = frame_index * tiles_per_frame
                    frame_progress: ProgressCallback | None = None
                    if progress is not None:
                        def frame_progress(
                            complete: int,
                            _total: int,
                            *,
                            offset: int = base,
                        ) -> None:
                            progress(offset + complete, total_tiles)
                    if deterministic:
                        restored = Image.fromarray(rgb, "RGB").resize(
                            (source.width * FLAT_SCALE, source.height * FLAT_SCALE),
                            Image.Resampling.LANCZOS,
                        )
                        restored.putalpha(alpha.resize(restored.size, Image.Resampling.LANCZOS))
                        evidence = self._perfect_fidelity()
                        frame_tiles = 1
                        if frame_progress is not None:
                            frame_progress(1, 1)
                    else:
                        assert session is not None
                        restored, evidence, frame_tiles = self._restore_pixels(
                            session,
                            rgb,
                            alpha,
                            strength,
                            progress=frame_progress,
                            cancelled=cancelled,
                        )
                    restored_frames.append(restored)
                    if not has_default_image or frame_index > 0:
                        durations.append(max(1, int(opened.info.get("duration", 100))))
                    fidelity_totals += np.array(
                        [
                            evidence.low_texture_mean_rgb_shift,
                            evidence.high_drift_fraction,
                            evidence.alpha_mismatch_fraction,
                            evidence.overall_mean_rgb_difference,
                        ]
                    )
                    tile_count += frame_tiles
        except (UnidentifiedImageError, OSError, ImageCms.PyCMSError) as error:
            raise ImageQualityModelError("animated source could not be decoded safely") from error
        if not restored_frames:
            raise ImageQualityModelError("animated source contained no frames")
        encoded = io.BytesIO()
        first, *remaining = restored_frames
        first.save(
            encoded,
            format="PNG",
            save_all=True,
            append_images=remaining,
            duration=durations,
            loop=loop,
            default_image=has_default_image,
            disposal=0,
            blend=0,
            optimize=False,
            compress_level=6,
            icc_profile=CANONICAL_SRGB_PROFILE,
        )
        payload = encoded.getvalue()
        averages = fidelity_totals / decoded_frame_count
        fidelity = RestorationFidelity(
            low_texture_mean_rgb_shift=float(averages[0]),
            high_drift_fraction=float(averages[1]),
            alpha_mismatch_fraction=float(averages[2]),
            overall_mean_rgb_difference=float(averages[3]),
            passed=float(averages[0]) <= 12 and float(averages[1]) <= 0.08,
        )
        return RestoredImage(
            data=payload,
            sha256=hashlib.sha256(payload).hexdigest(),
            media_type="image/png",
            width=source.width * (FLAT_SCALE if deterministic else MODEL_SCALE),
            height=source.height * (FLAT_SCALE if deterministic else MODEL_SCALE),
            source_sha256=source.sha256,
            model_id=FLAT_ENGINE_ID if deterministic else MODEL_ID,
            model_version=FLAT_ENGINE_VERSION if deterministic else MODEL_VERSION,
            model_sha256=FLAT_ENGINE_SHA256 if deterministic else MODEL_SHA256,
            processor_name=FLAT_PROCESSOR_NAME if deterministic else PROCESSOR_NAME,
            processor_version=(
                FLAT_PROCESSOR_VERSION if deterministic else PROCESSOR_VERSION
            ),
            strength=strength,
            tile_count=tile_count,
            colour_policy=(
                "frame-and-source-colour-preserving/canonical-srgb-output"
                if deterministic
                else "frame-preserving/canonical-srgb-output"
            ),
            fidelity=fidelity,
            frame_count=source.frame_count,
            model_usage="deterministic" if deterministic else "restore",
            deterministic=deterministic,
        )

    def _restore_pixels(
        self,
        session: InferenceSession,
        rgb: np.ndarray[Any, Any],
        alpha: Image.Image | None,
        strength: int,
        *,
        progress: ProgressCallback | None,
        cancelled: CancellationCheck | None,
    ) -> tuple[Image.Image, RestorationFidelity, int]:
        restored, tile_count = self._infer_tiles(
            session, rgb, progress=progress, cancelled=cancelled
        )
        reference = np.asarray(
            Image.fromarray(rgb, "RGB").resize(
                (rgb.shape[1] * MODEL_SCALE, rgb.shape[0] * MODEL_SCALE),
                Image.Resampling.LANCZOS,
            ),
            dtype=np.uint8,
        )
        fused = _source_colour_fusion(reference, restored, strength)
        fidelity = _measure_fidelity(reference, fused)
        image = Image.fromarray(fused, "RGB")
        if alpha is not None:
            image.putalpha(alpha.resize(image.size, Image.Resampling.LANCZOS))
        return image, fidelity, tile_count

    def restore_path(
        self,
        source: ImageQualitySource,
        *,
        input_path: str,
        output_path: str,
        strength: int,
        progress: ProgressCallback | None = None,
        cancelled: CancellationCheck | None = None,
        load_tile: TileLoader | None = None,
        save_tile: TileSaver | None = None,
    ) -> RestoredImage:
        """Restore a materialized still image with disk-backed, bounded-RAM tiles."""

        self._validate_metadata(source, strength)
        if source.frame_count > 1:
            return self._restore_animation_path(
                source,
                input_path=input_path,
                output_path=output_path,
                strength=strength,
                progress=progress,
                cancelled=cancelled,
                load_tile=load_tile,
                save_tile=save_tile,
            )
        try:
            import pyvips
        except (ImportError, OSError) as error:
            raise ImageQualityModelError(
                "the approved large-image colour runtime is unavailable"
            ) from error

        input_file = Path(input_path)
        output_file = Path(output_path)
        raw_file = output_file.with_suffix(".pixels")
        png_colour_chunks = (
            _png_colour_chunks(input_file) if source.media_type == "image/png" else []
        )
        cicp = next((payload for kind, payload in png_colour_chunks if kind == b"cICP"), None)
        signalled_dynamic_range = (
            "hdr-pq" if cicp and cicp[1] == 16
            else "hdr-hlg" if cicp and cicp[1] == 18
            else "sdr" if cicp
            else None
        )
        signalled_primaries = (
            {1: "srgb", 9: "bt2020", 12: "display-p3"}.get(cicp[0], "unknown")
            if cicp
            else None
        )
        if cicp and source.dynamic_range and signalled_dynamic_range != source.dynamic_range:
            raise ImageQualityModelError("source HDR signalling changed after inspection")
        if source.colour_primaries and signalled_primaries not in {
            None,
            source.colour_primaries,
        }:
            raise ImageQualityModelError("source colour primaries changed after inspection")
        source_image = pyvips.Image.new_from_file(
            str(input_file), access="random", fail_on="error"
        )
        if "orientation" in source_image.get_fields():
            source_image = source_image.autorot()
        if source_image.width != source.width or source_image.height != source.height:
            raise ImageQualityModelError("decoded source dimensions changed after inspection")

        alpha = source_image[source_image.bands - 1] if source_image.bands in {2, 4} else None
        if source_image.bands >= 3:
            colour = source_image[:3]
        else:
            colour = source_image[0].bandjoin([source_image[0], source_image[0]])
        source_profile: bytes | None = None
        if "icc-profile-data" in source_image.get_fields():
            source_profile = bytes(source_image.get("icc-profile-data"))

        precision = 16 if source.bit_depth > 8 else 8
        if source.content_class == "flat-graphic":
            return self._restore_flat_path(
                source,
                source_image=source_image,
                output_file=output_file,
                source_profile=source_profile,
                png_colour_chunks=png_colour_chunks,
                cicp=cicp,
                signalled_dynamic_range=signalled_dynamic_range,
                signalled_primaries=signalled_primaries,
                precision=precision,
                strength=strength,
                progress=progress,
                cancelled=cancelled,
            )
        source_native = self._normalise_vips_precision(colour, precision)
        if source_profile:
            try:
                working = colour.icc_transform("srgb", embedded=True, depth=precision)
            except Exception as error:
                raise ImageQualityModelError("the embedded ICC profile is invalid") from error
        else:
            working = source_native
        if alpha is not None:
            alpha = self._normalise_vips_precision(alpha, precision)

        output_width = source.width * MODEL_SCALE
        output_height = source.height * MODEL_SCALE
        bands = 4 if alpha is not None else 3
        dtype = np.uint16 if precision == 16 else np.uint8
        disk_pixels = np.memmap(
            raw_file,
            dtype=dtype,
            mode="w+",
            shape=(output_height, output_width, bands),
        )
        session = self._get_session()
        rows = list(range(0, source.height, MODEL_CORE))
        columns = list(range(0, source.width, MODEL_CORE))
        total = len(rows) * len(columns)
        completed = 0
        fidelity_totals = np.zeros(4, dtype=np.float64)
        fidelity_pixels = 0
        padded = working.embed(
            MODEL_CONTEXT,
            MODEL_CONTEXT,
            source.width + MODEL_CONTEXT * 2,
            source.height + MODEL_CONTEXT * 2,
            extend="mirror",
        )
        for top in rows:
            core_height = min(MODEL_CORE, source.height - top)
            for left in columns:
                if cancelled is not None and cancelled():
                    raise ImageQualityCancelledError("image restoration was cancelled")
                core_width = min(MODEL_CORE, source.width - left)
                target = disk_pixels[
                    top * MODEL_SCALE : (top + core_height) * MODEL_SCALE,
                    left * MODEL_SCALE : (left + core_width) * MODEL_SCALE,
                ]
                tile_key = f"r{top:010d}-c{left:010d}"
                restored_tile = load_tile(tile_key) if load_tile is not None else None
                expected_size = target.size * np.dtype(dtype).itemsize
                if restored_tile is not None:
                    if len(restored_tile.data) != expected_size:
                        raise ImageQualityModelError(
                            "a durable restoration tile failed size verification"
                        )
                    target[...] = np.frombuffer(restored_tile.data, dtype=dtype).reshape(
                        target.shape
                    )
                    evidence = restored_tile.fidelity
                else:
                    tile = padded.crop(
                        left,
                        top,
                        core_width + MODEL_CONTEXT * 2,
                        core_height + MODEL_CONTEXT * 2,
                    ).embed(0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE, extend="copy")
                    tile_array = self._vips_array(tile, precision, 3)
                    tile_8 = (
                        np.rint(tile_array / 257.0).astype(np.uint8)
                        if precision == 16
                        else tile_array.astype(np.uint8, copy=False)
                    )
                    learned = self._infer_model_tile(session, tile_8)
                    learned_core = learned[
                        MODEL_CONTEXT * MODEL_SCALE : (
                            MODEL_CONTEXT + core_height
                        ) * MODEL_SCALE,
                        MODEL_CONTEXT * MODEL_SCALE : (
                            MODEL_CONTEXT + core_width
                        ) * MODEL_SCALE,
                    ]
                    reference_tile = working.crop(
                        left, top, core_width, core_height
                    ).resize(MODEL_SCALE, kernel="lanczos3")
                    reference = self._vips_array(reference_tile, precision, 3)
                    reference_8 = (
                        np.rint(reference / 257.0).astype(np.uint8)
                        if precision == 16
                        else reference.astype(np.uint8, copy=False)
                    )
                    fused_8 = _source_colour_fusion(reference_8, learned_core, strength)
                    if source_profile or precision == 16:
                        native_reference_tile = source_native.crop(
                            left, top, core_width, core_height
                        ).resize(MODEL_SCALE, kernel="lanczos3")
                        native_reference = self._vips_array(
                            native_reference_tile, precision, 3
                        )
                        delta = fused_8.astype(np.int32) - reference_8.astype(np.int32)
                        unit = 257 if precision == 16 else 1
                        upper = 65535 if precision == 16 else 255
                        fused = np.clip(
                            native_reference.astype(np.int32) + delta * unit,
                            0,
                            upper,
                        ).astype(dtype)
                    else:
                        fused = fused_8
                    target[..., :3] = fused
                    if alpha is not None:
                        alpha_tile = alpha.crop(
                            left, top, core_width, core_height
                        ).resize(MODEL_SCALE, kernel="lanczos3")
                        target[..., 3] = self._vips_array(
                            alpha_tile, precision, 1
                        )[..., 0]
                    evidence = _measure_fidelity(reference_8, fused_8)
                    if save_tile is not None:
                        save_tile(
                            tile_key,
                            RestoredTile(target.copy().tobytes(), evidence),
                        )
                pixels = target.shape[0] * target.shape[1]
                fidelity_totals += np.array(
                    [
                        evidence.low_texture_mean_rgb_shift,
                        evidence.high_drift_fraction,
                        evidence.alpha_mismatch_fraction,
                        evidence.overall_mean_rgb_difference,
                    ]
                ) * pixels
                fidelity_pixels += pixels
                completed += 1
                if progress is not None:
                    progress(completed, total)
        del target
        disk_pixels.flush()
        rendered = pyvips.Image.new_from_memory(
            memoryview(disk_pixels), output_width, output_height, bands,
            "ushort" if precision == 16 else "uchar",
        ).copy(interpretation="rgb16" if precision == 16 else "srgb")

        save_options: dict[str, object] = {"compression": 6, "bitdepth": precision}
        profile_file: Path | None = None
        if source_profile or cicp is None:
            profile_file = output_file.with_suffix(".output.icc")
            profile_file.write_bytes(source_profile or CANONICAL_SRGB_PROFILE)
            save_options["profile"] = str(profile_file)
        try:
            rendered.pngsave(str(output_file), **save_options)
        finally:
            if profile_file:
                profile_file.unlink(missing_ok=True)
        _inject_png_colour_chunks(output_file, png_colour_chunks)
        del rendered
        del disk_pixels
        gc.collect()
        raw_file.unlink(missing_ok=True)
        byte_size = output_file.stat().st_size
        output_sha256 = _sha256_file(output_file)
        averages = fidelity_totals / max(1, fidelity_pixels)
        fidelity = RestorationFidelity(
            low_texture_mean_rgb_shift=float(averages[0]),
            high_drift_fraction=float(averages[1]),
            alpha_mismatch_fraction=float(averages[2]),
            overall_mean_rgb_difference=float(averages[3]),
            passed=float(averages[0]) <= 12 and float(averages[1]) <= 0.08,
        )
        return RestoredImage(
            data=b"",
            sha256=output_sha256,
            media_type="image/png",
            width=output_width,
            height=output_height,
            source_sha256=source.sha256,
            model_id=MODEL_ID,
            model_version=MODEL_VERSION,
            model_sha256=MODEL_SHA256,
            processor_name=PROCESSOR_NAME,
            processor_version=PROCESSOR_VERSION,
            strength=strength,
            tile_count=total,
            colour_policy=(
                f"source-cicp-{signalled_dynamic_range or 'wide-gamut'}-preserved/{precision}-bit"
                if cicp
                else "source-icc-preserved/16-bit" if source_profile and precision == 16
                else "source-icc-preserved/8-bit" if source_profile
                else "canonical-srgb/16-bit" if precision == 16
                else "canonical-srgb/8-bit"
            ),
            fidelity=fidelity,
            artifact_path=output_file,
            artifact_byte_size=byte_size,
            bit_depth=precision,
            has_icc_profile=bool(source_profile) or cicp is None,
            colour_primaries=signalled_primaries or source.colour_primaries or "srgb",
            dynamic_range=signalled_dynamic_range or source.dynamic_range or "sdr",
        )

    def _restore_animation_path(
        self,
        source: ImageQualitySource,
        *,
        input_path: str,
        output_path: str,
        strength: int,
        progress: ProgressCallback | None,
        cancelled: CancellationCheck | None,
        load_tile: TileLoader | None,
        save_tile: TileSaver | None,
    ) -> RestoredImage:
        """Process a materialized animation one frame at a time with durable tiles."""

        input_file = Path(input_path)
        output_file = Path(output_path)
        deterministic = source.content_class == "flat-graphic"
        frame_results: list[RestoredImage] = []
        durations: list[int] = []
        has_default_image = False
        frame_outputs: list[Path] = []
        fidelity_totals = np.zeros(4, dtype=np.float64)
        tile_count = 0
        tiles_per_frame = (
            1
            if deterministic
            else len(range(0, source.height, MODEL_CORE))
            * len(range(0, source.width, MODEL_CORE))
        )
        decoded_frame_count = source.frame_count
        total_tiles = tiles_per_frame * decoded_frame_count
        try:
            with Image.open(input_file) as opened, tempfile.TemporaryDirectory(
                prefix="ipw-animation-", dir=output_file.parent
            ) as temporary:
                if opened.size != (source.width, source.height):
                    raise ImageQualityModelError("decoded source dimensions changed")
                has_default_image = bool(opened.info.get("default_image", False))
                decoded_frame_count = source.frame_count + (1 if has_default_image else 0)
                if int(getattr(opened, "n_frames", 1)) != decoded_frame_count:
                    raise ImageQualityModelError("decoded source frame count changed")
                total_tiles = tiles_per_frame * decoded_frame_count
                embedded_profile = opened.info.get("icc_profile")
                if bool(embedded_profile) != source.has_icc_profile:
                    raise ImageQualityModelError("decoded source colour-profile state changed")
                profile = (
                    ImageCms.ImageCmsProfile(io.BytesIO(bytes(embedded_profile)))
                    if embedded_profile
                    else None
                )
                loop = int(opened.info.get("loop", 0))
                temporary_path = Path(temporary)
                for frame_index in range(decoded_frame_count):
                    if cancelled is not None and cancelled():
                        raise ImageQualityCancelledError("image restoration was cancelled")
                    opened.seek(frame_index)
                    if not has_default_image or frame_index > 0:
                        durations.append(max(1, int(opened.info.get("duration", 100))))
                    frame = opened.convert("RGBA")
                    if profile:
                        converted = ImageCms.profileToProfile(
                            frame.convert("RGB"),
                            profile,
                            ImageCms.createProfile("sRGB"),
                            outputMode="RGB",
                        )
                        if converted is None:
                            raise ImageQualityModelError(
                                "source colour profile could not be converted"
                            )
                        converted.putalpha(frame.getchannel("A"))
                        frame = converted
                    frame_input = temporary_path / f"source-{frame_index:08d}.png"
                    frame_output = temporary_path / f"restored-{frame_index:08d}.png"
                    frame.save(
                        frame_input,
                        format="PNG",
                        optimize=False,
                        compress_level=1,
                        icc_profile=CANONICAL_SRGB_PROFILE,
                    )
                    frame_payload_sha = _sha256_file(frame_input)
                    frame_source = replace(
                        source,
                        data=b"",
                        sha256=frame_payload_sha,
                        media_type="image/png",
                        frame_count=1,
                        bit_depth=8,
                        has_icc_profile=True,
                        colour_primaries="srgb",
                        dynamic_range="sdr",
                    )
                    prefix = f"f{frame_index:08d}-"

                    def frame_progress(
                        complete: int,
                        _total: int,
                        *,
                        offset: int = frame_index * tiles_per_frame,
                    ) -> None:
                        if progress is not None:
                            progress(offset + complete, total_tiles)

                    frame_load_tile: TileLoader | None = None
                    if load_tile is not None:

                        def frame_load_tile(
                            key: str,
                            *,
                            prefix: str = prefix,
                        ) -> RestoredTile | None:
                            return load_tile(prefix + key)

                    frame_save_tile: TileSaver | None = None
                    if save_tile is not None:

                        def frame_save_tile(
                            key: str,
                            tile: RestoredTile,
                            *,
                            prefix: str = prefix,
                        ) -> None:
                            save_tile(prefix + key, tile)

                    result = self.restore_path(
                        frame_source,
                        input_path=str(frame_input),
                        output_path=str(frame_output),
                        strength=strength,
                        progress=frame_progress,
                        cancelled=cancelled,
                        load_tile=frame_load_tile,
                        save_tile=frame_save_tile,
                    )
                    frame_results.append(result)
                    frame_outputs.append(frame_output)
                    tile_count += result.tile_count
                    fidelity_totals += np.array(
                        [
                            result.fidelity.low_texture_mean_rgb_shift,
                            result.fidelity.high_drift_fraction,
                            result.fidelity.alpha_mismatch_fraction,
                            result.fidelity.overall_mean_rgb_difference,
                        ]
                    )

                with ExitStack() as stack:
                    restored_frames = [
                        stack.enter_context(Image.open(path)) for path in frame_outputs
                    ]
                    first, *remaining = restored_frames
                    first.save(
                        output_file,
                        format="PNG",
                        save_all=True,
                        append_images=remaining,
                        duration=durations,
                        loop=loop,
                        default_image=has_default_image,
                        disposal=0,
                        blend=0,
                        optimize=False,
                        compress_level=6,
                        icc_profile=CANONICAL_SRGB_PROFILE,
                    )
        except (UnidentifiedImageError, OSError, ImageCms.PyCMSError) as error:
            raise ImageQualityModelError("animated source could not be decoded safely") from error
        if not frame_results:
            raise ImageQualityModelError("animated source contained no frames")
        averages = fidelity_totals / decoded_frame_count
        fidelity = RestorationFidelity(
            low_texture_mean_rgb_shift=float(averages[0]),
            high_drift_fraction=float(averages[1]),
            alpha_mismatch_fraction=float(averages[2]),
            overall_mean_rgb_difference=float(averages[3]),
            passed=float(averages[0]) <= 12 and float(averages[1]) <= 0.08,
        )
        byte_size = output_file.stat().st_size
        return RestoredImage(
            data=b"",
            sha256=_sha256_file(output_file),
            media_type="image/png",
            width=frame_results[0].width,
            height=frame_results[0].height,
            source_sha256=source.sha256,
            model_id=FLAT_ENGINE_ID if deterministic else MODEL_ID,
            model_version=FLAT_ENGINE_VERSION if deterministic else MODEL_VERSION,
            model_sha256=FLAT_ENGINE_SHA256 if deterministic else MODEL_SHA256,
            processor_name=FLAT_PROCESSOR_NAME if deterministic else PROCESSOR_NAME,
            processor_version=(
                FLAT_PROCESSOR_VERSION if deterministic else PROCESSOR_VERSION
            ),
            strength=strength,
            tile_count=tile_count,
            colour_policy=(
                "frame-and-source-colour-preserving/canonical-srgb-output"
                if deterministic
                else "frame-preserving/canonical-srgb-output"
            ),
            fidelity=fidelity,
            artifact_path=output_file,
            artifact_byte_size=byte_size,
            frame_count=source.frame_count,
            bit_depth=8,
            has_icc_profile=True,
            colour_primaries="srgb",
            dynamic_range="sdr",
            model_usage="deterministic" if deterministic else "restore",
            deterministic=deterministic,
        )

    def _restore_flat_path(
        self,
        source: ImageQualitySource,
        *,
        source_image: Any,
        output_file: Path,
        source_profile: bytes | None,
        png_colour_chunks: list[tuple[bytes, bytes]],
        cicp: bytes | None,
        signalled_dynamic_range: str | None,
        signalled_primaries: str | None,
        precision: int,
        strength: int,
        progress: ProgressCallback | None,
        cancelled: CancellationCheck | None,
    ) -> RestoredImage:
        if cancelled is not None and cancelled():
            raise ImageQualityCancelledError("image restoration was cancelled")
        rendered = source_image.resize(FLAT_SCALE, kernel="lanczos3")
        rendered = self._normalise_vips_precision(rendered, precision).copy(
            interpretation="rgb16" if precision == 16 else "srgb"
        )
        save_options: dict[str, object] = {"compression": 6, "bitdepth": precision}
        profile_file: Path | None = None
        if source_profile or cicp is None:
            profile_file = output_file.with_suffix(".output.icc")
            profile_file.write_bytes(source_profile or CANONICAL_SRGB_PROFILE)
            save_options["profile"] = str(profile_file)
        try:
            rendered.pngsave(str(output_file), **save_options)
        finally:
            if profile_file:
                profile_file.unlink(missing_ok=True)
        _inject_png_colour_chunks(output_file, png_colour_chunks)
        if cancelled is not None and cancelled():
            output_file.unlink(missing_ok=True)
            raise ImageQualityCancelledError("image restoration was cancelled")
        if progress is not None:
            progress(1, 1)
        byte_size = output_file.stat().st_size
        return RestoredImage(
            data=b"",
            sha256=_sha256_file(output_file),
            media_type="image/png",
            width=source.width * FLAT_SCALE,
            height=source.height * FLAT_SCALE,
            source_sha256=source.sha256,
            model_id=FLAT_ENGINE_ID,
            model_version=FLAT_ENGINE_VERSION,
            model_sha256=FLAT_ENGINE_SHA256,
            processor_name=FLAT_PROCESSOR_NAME,
            processor_version=FLAT_PROCESSOR_VERSION,
            strength=strength,
            tile_count=1,
            colour_policy=(
                f"source-cicp-{signalled_dynamic_range or 'wide-gamut'}-preserved/"
                f"deterministic-{precision}-bit"
                if cicp
                else f"source-icc-preserved/deterministic-{precision}-bit"
                if source_profile
                else f"canonical-srgb/deterministic-{precision}-bit"
            ),
            fidelity=self._perfect_fidelity(),
            artifact_path=output_file,
            artifact_byte_size=byte_size,
            bit_depth=precision,
            has_icc_profile=bool(source_profile) or cicp is None,
            colour_primaries=signalled_primaries or source.colour_primaries or "srgb",
            dynamic_range=signalled_dynamic_range or source.dynamic_range or "sdr",
            model_usage="deterministic",
            deterministic=True,
        )

    @staticmethod
    def _perfect_fidelity() -> RestorationFidelity:
        return RestorationFidelity(0.0, 0.0, 0.0, 0.0, True)

    @staticmethod
    def _normalise_vips_precision(image: Any, precision: int) -> Any:
        if precision == 16:
            return image if image.format == "ushort" else (image.cast("ushort") * 257)
        return image if image.format == "uchar" else (image / 257).cast("uchar")

    @staticmethod
    def _vips_array(image: Any, precision: int, bands: int) -> np.ndarray[Any, Any]:
        dtype = np.uint16 if precision == 16 else np.uint8
        return np.frombuffer(image.write_to_memory(), dtype=dtype).reshape(
            image.height, image.width, bands
        )

    @staticmethod
    def _infer_model_tile(
        session: InferenceSession, tile: np.ndarray[Any, Any]
    ) -> np.ndarray[Any, Any]:
        tensor = np.transpose(tile.astype(np.float32) / 255.0, (2, 0, 1))[None, ...]
        raw = session.run([MODEL_OUTPUT_NAME], {MODEL_INPUT_NAME: tensor})[0]
        prediction = np.asarray(raw, dtype=np.float32)
        expected = (1, 3, MODEL_INPUT_SIZE * MODEL_SCALE, MODEL_INPUT_SIZE * MODEL_SCALE)
        if prediction.shape != expected:
            raise ImageQualityModelError("image restoration model returned an invalid shape")
        prediction = np.transpose(prediction[0], (1, 2, 0))
        return np.clip(np.rint(prediction * 255.0), 0, 255).astype(np.uint8)

    @staticmethod
    def _validate_source(source: ImageQualitySource, strength: int) -> None:
        PublicRealPlksrEngine._validate_metadata(source, strength)
        if hashlib.sha256(source.data).hexdigest() != source.sha256:
            raise ImageQualityModelError("immutable source checksum failed verification")

    @staticmethod
    def _validate_metadata(source: ImageQualitySource, strength: int) -> None:
        if source.media_type not in SUPPORTED_MEDIA_TYPES:
            raise ImageQualityModelError("only JPEG, PNG and WebP images can be restored")
        if not 1 <= strength <= 100:
            raise ImageQualityModelError("enhancement strength must be between 1 and 100")
        if source.width < 1 or source.height < 1:
            raise ImageQualityModelError("source dimensions are invalid")
        if source.frame_count < 1:
            raise ImageQualityModelError("source frame count is invalid")

    @staticmethod
    def _decode_source(
        source: ImageQualitySource,
    ) -> tuple[np.ndarray[Any, Any], Image.Image | None]:
        try:
            with Image.open(io.BytesIO(source.data)) as opened:
                if opened.size != (source.width, source.height):
                    raise ImageQualityModelError("decoded source dimensions changed")
                if int(getattr(opened, "n_frames", 1)) != source.frame_count:
                    raise ImageQualityModelError("decoded source frame count changed")
                embedded_profile = opened.info.get("icc_profile")
                if bool(embedded_profile) != source.has_icc_profile:
                    raise ImageQualityModelError("decoded source colour-profile state changed")
                oriented = ImageOps.exif_transpose(opened)
                if embedded_profile:
                    profile = ImageCms.ImageCmsProfile(io.BytesIO(bytes(embedded_profile)))
                    converted = ImageCms.profileToProfile(
                        oriented.convert("RGB"),
                        profile,
                        ImageCms.createProfile("sRGB"),
                        outputMode="RGB",
                    )
                    if converted is None:
                        raise ImageQualityModelError("source colour profile could not be converted")
                    oriented = converted
                alpha = oriented.getchannel("A").copy() if "A" in oriented.getbands() else None
                rgb = np.asarray(oriented.convert("RGB"), dtype=np.uint8).copy()
        except (UnidentifiedImageError, OSError, ImageCms.PyCMSError) as error:
            raise ImageQualityModelError("source image could not be decoded safely") from error
        if rgb.shape[:2] != (source.height, source.width):
            raise ImageQualityModelError(
                "orientation-changing metadata must be normalised during immutable intake"
            )
        return rgb, alpha

    @staticmethod
    def _infer_tiles(
        session: InferenceSession,
        rgb: np.ndarray[Any, Any],
        *,
        progress: ProgressCallback | None,
        cancelled: CancellationCheck | None,
    ) -> tuple[np.ndarray[Any, Any], int]:
        height, width = rgb.shape[:2]
        rows = list(range(0, height, MODEL_CORE))
        columns = list(range(0, width, MODEL_CORE))
        total = len(rows) * len(columns)
        output = np.empty((height * MODEL_SCALE, width * MODEL_SCALE, 3), dtype=np.uint8)
        padded = np.pad(
            rgb,
            ((MODEL_CONTEXT, MODEL_CONTEXT), (MODEL_CONTEXT, MODEL_CONTEXT), (0, 0)),
            mode="reflect" if min(width, height) > 1 else "edge",
        )
        completed = 0
        for top in rows:
            core_height = min(MODEL_CORE, height - top)
            for left in columns:
                if cancelled is not None and cancelled():
                    raise ImageQualityCancelledError("image restoration was cancelled")
                core_width = min(MODEL_CORE, width - left)
                tile = padded[
                    top : top + core_height + MODEL_CONTEXT * 2,
                    left : left + core_width + MODEL_CONTEXT * 2,
                ]
                pad_bottom = MODEL_INPUT_SIZE - tile.shape[0]
                pad_right = MODEL_INPUT_SIZE - tile.shape[1]
                if pad_bottom or pad_right:
                    tile = np.pad(tile, ((0, pad_bottom), (0, pad_right), (0, 0)), mode="edge")
                tensor = np.transpose(tile.astype(np.float32) / 255.0, (2, 0, 1))[None, ...]
                raw = session.run([MODEL_OUTPUT_NAME], {MODEL_INPUT_NAME: tensor})[0]
                prediction = np.asarray(raw, dtype=np.float32)
                if prediction.shape != (1, 3, MODEL_INPUT_SIZE * 2, MODEL_INPUT_SIZE * 2):
                    raise ImageQualityModelError(
                        "image restoration model returned an invalid shape"
                    )
                prediction = np.transpose(prediction[0], (1, 2, 0))
                prediction = np.clip(np.rint(prediction * 255.0), 0, 255).astype(np.uint8)
                core = prediction[
                    MODEL_CONTEXT * MODEL_SCALE : (MODEL_CONTEXT + core_height) * MODEL_SCALE,
                    MODEL_CONTEXT * MODEL_SCALE : (MODEL_CONTEXT + core_width) * MODEL_SCALE,
                ]
                output[
                    top * MODEL_SCALE : (top + core_height) * MODEL_SCALE,
                    left * MODEL_SCALE : (left + core_width) * MODEL_SCALE,
                ] = core
                completed += 1
                if progress is not None:
                    progress(completed, total)
        return output, total


def _source_colour_fusion(
    reference: np.ndarray[Any, Any], learned: np.ndarray[Any, Any], strength: int
) -> np.ndarray[Any, Any]:
    """Keep source chroma/tone authoritative while accepting learned structure."""

    reference_f = reference.astype(np.float32)
    learned_f = learned.astype(np.float32)
    reference_y = (
        reference_f[..., 0] + reference_f[..., 1] * 2.0 + reference_f[..., 2]
    ) / 4.0
    learned_y = (learned_f[..., 0] + learned_f[..., 1] * 2.0 + learned_f[..., 2]) / 4.0
    gradient_x = np.abs(reference_y - np.roll(reference_y, 1, axis=1))
    gradient_y = np.abs(reference_y - np.roll(reference_y, 1, axis=0))
    gradient_x[:, 0] = 0
    gradient_y[0, :] = 0
    texture = np.maximum(gradient_x, gradient_y)
    texture_gate = np.sqrt(np.clip((texture - 3.0) / 28.0, 0.0, 1.0))
    amount = strength / 100.0
    learned_mix = (0.12 + amount * 0.48) * (0.04 + texture_gate * 0.96)
    limit = 2.0 + amount * (2.0 + texture_gate * 23.0)
    target_y = reference_y + np.clip((learned_y - reference_y) * learned_mix, -limit, limit)
    reference_co = reference_f[..., 0] - reference_f[..., 2]
    reference_cg = reference_f[..., 1] - (
        reference_f[..., 0] + reference_f[..., 2]
    ) / 2.0
    output = np.empty_like(reference_f)
    output[..., 0] = target_y - reference_cg / 2.0 + reference_co / 2.0
    output[..., 1] = target_y + reference_cg / 2.0
    output[..., 2] = target_y - reference_cg / 2.0 - reference_co / 2.0
    return np.clip(np.rint(output), 0, 255).astype(np.uint8)


def _measure_fidelity(
    reference: np.ndarray[Any, Any], output: np.ndarray[Any, Any]
) -> RestorationFidelity:
    """Measure the same source-coordinate drift protected by the browser route."""

    reference_f = reference.astype(np.float32)
    output_f = output.astype(np.float32)
    per_pixel = np.mean(np.abs(reference_f - output_f), axis=2)
    reference_y = np.mean(reference_f, axis=2)
    horizontal = np.abs(reference_y - np.roll(reference_y, 1, axis=1))
    vertical = np.abs(reference_y - np.roll(reference_y, 1, axis=0))
    horizontal[:, 0] = 0
    vertical[0, :] = 0
    low_texture = np.maximum(horizontal, vertical) <= 10
    low_texture_shift = float(np.mean(per_pixel[low_texture])) if np.any(low_texture) else 0.0
    high_drift_fraction = float(np.mean(per_pixel > 42))
    overall_difference = float(np.mean(per_pixel))
    return RestorationFidelity(
        low_texture_mean_rgb_shift=low_texture_shift,
        high_drift_fraction=high_drift_fraction,
        alpha_mismatch_fraction=0.0,
        overall_mean_rgb_difference=overall_difference,
        passed=low_texture_shift <= 12 and high_drift_fraction <= 0.08,
    )
