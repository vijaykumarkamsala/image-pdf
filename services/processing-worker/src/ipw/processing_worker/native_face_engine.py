"""Unregistered, server-held native face adapter. No URL, approval flag or AI API.

Approved releases must separately clear commercial dependencies and real-photo
quality. The bundle digest binds configuration; it does not provide those rights.
"""

from __future__ import annotations

import hashlib
import json
import platform
import shutil
import sys
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import numpy as np
import onnx
import onnxruntime as ort  # type: ignore[import-untyped]
import pyvips
from pydantic import Field, ValidationError

from ipw.contracts.common import ContractModel, Sha256Hex
from ipw.contracts.image_quality_face import (
    NativeFaceAlignment,
    NativeFaceContext,
    NativeFaceRelease,
)
from ipw.processing_worker.face_quality import NativeFaceProposal
from ipw.processing_worker.native_face_colour import NativeFaceColour
from ipw.processing_worker.native_face_geometry import (
    align_face,
    aligned_rgb,
    decode_heads,
    detector_tensor,
    detector_windows,
    inverse,
    proposal_coordinates,
    sample_rgb,
    single_face,
)
from ipw.processing_worker.native_face_renderer import (
    MAX_SCRATCH_BYTES,
    NativeFaceRenderCancelledError,
    NativeFaceRenderError,
    inspect_native_face_png,
    native_face_colour_sha256,
)

YUNET_SHA256 = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"
YUNET_BYTES = 232589
HEADS = tuple(
    f"{name}_{stride}" for stride in (8, 16, 32) for name in ("cls", "obj", "bbox", "kps")
)


class NativeFaceBundle(ContractModel):
    """Trusted registration configuration, never parsed from a customer request."""

    recipe: Literal["native-face-sdr-detail-v1"] = "native-face-sdr-detail-v1"
    model_sha256: Sha256Hex
    model_bytes: int = Field(strict=True, ge=1, le=512 * 1024 * 1024)
    image_input: str = Field(min_length=1, max_length=128)
    fidelity_input: str = Field(min_length=1, max_length=128)
    output: str = Field(min_length=1, max_length=128)
    fidelity_type: Literal["tensor(float)", "tensor(double)"]
    fidelity_shape: tuple[Literal[1], ...] = Field(max_length=2)
    python_version: str = Field(pattern=r"^[0-9]+\.[0-9]+\.[0-9]+$")
    system: Literal["Windows", "Linux"]
    machine: str = Field(min_length=1, max_length=32)
    detector_windows: int = Field(strict=True, ge=1, le=128, default=128)

    def sha256(self) -> str:
        payload = [
            "ipw-native-face-bundle-v1",
            self.model_dump(mode="json"),
            {
                "yunet_sha256": YUNET_SHA256,
                "yunet_bytes": YUNET_BYTES,
                "onnxruntime": "1.30.0",
                "onnx": "1.22.0",
                "numpy": "2.5.2",
                "pyvips": "3.1.1",
                "libvips": "8.18.5",
                "provider": "CPUExecutionProvider",
                "intra_op_threads": 1,
                "inter_op_threads": 1,
                "execution": "sequential",
            },
        ]
        return hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode(
                "ascii"
            )
        ).hexdigest()


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verified_face_graph(path: Path, digest: str, size: int) -> bytes:
    if not 1 <= size <= 512 * 1024 * 1024 or path.stat().st_size != size:
        raise NativeFaceRenderError("Native face model size does not match its release")
    with path.open("rb") as stream:
        raw = stream.read(size + 1)
    if len(raw) != size or hashlib.sha256(raw).hexdigest() != digest:
        raise NativeFaceRenderError("Native face model digest does not match its release")
    model = onnx.load_model_from_string(raw)
    if model.functions or any(item.domain not in {"", "ai.onnx"} for item in model.opset_import):
        raise NativeFaceRenderError("Native face model requires unsupported functions or domains")

    def tensor(value: Any) -> None:
        if value.external_data or value.data_location == onnx.TensorProto.EXTERNAL:
            raise NativeFaceRenderError("Native face graph cannot resolve external tensor files")

    def graph(value: Any) -> None:
        for initializer in value.initializer:
            tensor(initializer)
        for sparse in value.sparse_initializer:
            tensor(sparse.values)
            tensor(sparse.indices)
        for node in value.node:
            if node.domain not in {"", "ai.onnx"}:
                raise NativeFaceRenderError(
                    "Native face graph requires unsupported custom operators"
                )
            for attribute in node.attribute:
                if attribute.HasField("t"):
                    tensor(attribute.t)
                for item in attribute.tensors:
                    tensor(item)
                if attribute.HasField("sparse_tensor"):
                    tensor(attribute.sparse_tensor.values)
                    tensor(attribute.sparse_tensor.indices)
                for sparse in attribute.sparse_tensors:
                    tensor(sparse.values)
                    tensor(sparse.indices)
                if attribute.HasField("g"):
                    graph(attribute.g)
                for item in attribute.graphs:
                    graph(item)

    graph(model.graph)
    onnx.checker.check_model(model)
    return raw


def _session(raw: bytes) -> ort.InferenceSession:
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.log_severity_level = 3
    return ort.InferenceSession(raw, sess_options=options, providers=["CPUExecutionProvider"])


def _check(cancelled: Callable[[], bool]) -> None:
    if cancelled():
        raise NativeFaceRenderCancelledError(
            "Native face work cancelled; original/base remain intact"
        )


@dataclass
class PreparedFace:
    context: NativeFaceContext
    source_path: Path
    base_path: Path
    temporary: tempfile.TemporaryDirectory[str]
    source: np.memmap[Any, Any]
    base: np.memmap[Any, Any]
    colour: NativeFaceColour
    alignment: NativeFaceAlignment
    reference: np.ndarray[Any, Any]


class NativeOnnxFaceEngine:
    """Not thread-safe: the durable processor's heavy-work lock owns each instance."""

    def __init__(
        self,
        *,
        bundle: NativeFaceBundle,
        detector_path: Path,
        model_path: Path,
        current_release: Callable[[], NativeFaceRelease | None],
    ) -> None:
        self._bundle = NativeFaceBundle.model_validate_json(bundle.model_dump_json())
        self._detector_path, self._model_path = detector_path, model_path
        self._current_release = current_release
        self._detector: ort.InferenceSession | None = None
        self._restorer: ort.InferenceSession | None = None
        self._prepared: PreparedFace | None = None

    def release(self) -> NativeFaceRelease | None:
        current = self._current_release()
        try:
            return (
                NativeFaceRelease.model_validate_json(current.model_dump_json())
                if current
                else None
            )
        except ValidationError:
            raise NativeFaceRenderError(
                "Native face release contains invalid approval evidence"
            ) from None

    def _approved(self) -> None:
        release = self.release()
        if (
            release is None
            or release.commercial_rights != "approved"
            or release.quality_review != "approved"
            or not (release.rights_evidence_id or "").strip()
            or not (release.quality_evidence_id or "").strip()
            or not release.model_id.strip()
            or not release.model_version.strip()
            or release.model_sha256 != self._bundle.model_sha256
            or release.dependency_lock_sha256 != self._bundle.sha256()
        ):
            raise NativeFaceRenderError(
                "Native face release is unregistered, changed or unapproved"
            )

    def _sessions(self) -> tuple[ort.InferenceSession, ort.InferenceSession]:
        actual = (
            sys.version.split()[0],
            platform.system(),
            platform.machine(),
            ort.__version__,
            onnx.__version__,
            np.__version__,
            pyvips.__version__,
            ".".join(str(pyvips.version(n)) for n in range(3)),
        )
        expected = (
            self._bundle.python_version,
            self._bundle.system,
            self._bundle.machine,
            "1.30.0",
            "1.22.0",
            "2.5.2",
            "3.1.1",
            "8.18.5",
        )
        if actual != expected:
            raise NativeFaceRenderError(
                "Native face execution pins differ from the reviewed bundle"
            )
        if self._detector is None or self._restorer is None:
            detector_bytes = verified_face_graph(self._detector_path, YUNET_SHA256, YUNET_BYTES)
            model_bytes = verified_face_graph(
                self._model_path, self._bundle.model_sha256, self._bundle.model_bytes
            )
            # Both graphs are verified before either session is constructed.
            detector, restorer = _session(detector_bytes), _session(model_bytes)
            inputs, outputs = detector.get_inputs(), detector.get_outputs()
            if (
                len(inputs) != 1
                or inputs[0].name != "input"
                or inputs[0].type != "tensor(float)"
                or inputs[0].shape != [1, 3, 640, 640]
                or {item.name for item in outputs} != set(HEADS)
            ):
                raise NativeFaceRenderError("Native detector I/O is incompatible")
            inputs = {item.name: item for item in restorer.get_inputs()}
            outputs = restorer.get_outputs()
            image, fidelity = (
                inputs.get(self._bundle.image_input),
                inputs.get(self._bundle.fidelity_input),
            )
            if (
                len(inputs) != 2
                or image is None
                or fidelity is None
                or image.type != "tensor(float)"
                or image.shape != [1, 3, 512, 512]
                or fidelity.type != self._bundle.fidelity_type
                or fidelity.shape != list(self._bundle.fidelity_shape)
                or len(outputs) != 1
                or outputs[0].name != self._bundle.output
                or outputs[0].type != "tensor(float)"
                or outputs[0].shape != [1, 3, 512, 512]
            ):
                raise NativeFaceRenderError("Native face model I/O is incompatible")
            self._detector, self._restorer = detector, restorer
        return self._detector, self._restorer

    def clear_source(self) -> None:
        prepared, self._prepared = self._prepared, None
        if prepared:
            for mapped in (prepared.source, prepared.base):
                mapped._mmap.close()  # noqa: SLF001 -- NumPy exposes no public memmap close API.
            prepared.temporary.cleanup()

    def _identities(self, source_path: Path, base_path: Path, context: NativeFaceContext) -> None:
        if (
            _hash_file(source_path) != context.source_sha256
            or _hash_file(base_path) != context.base_output_sha256
        ):
            raise NativeFaceRenderError("Native face source/base bytes changed")

    def _prepare(
        self,
        source_path: Path,
        base_path: Path,
        context: NativeFaceContext,
        detector: ort.InferenceSession,
        cancelled: Callable[[], bool],
    ) -> PreparedFace:
        _check(cancelled)
        self._identities(source_path, base_path, context)
        if self._prepared:
            if (
                self._prepared.context == context
                and self._prepared.source_path == source_path
                and self._prepared.base_path == base_path
            ):
                return self._prepared
            self.clear_source()
        width, height, depth, _, colours = inspect_native_face_png(base_path)
        if (width, height, depth) != (
            context.output_width,
            context.output_height,
            context.bit_depth,
        ) or native_face_colour_sha256(base_path) != context.colour_authority_sha256:
            raise NativeFaceRenderError("Native face base authority changed")
        with source_path.open("rb") as stream:
            signature = stream.read(12)
        if not (
            signature.startswith((b"\xff\xd8\xff", b"\x89PNG\r\n\x1a\n"))
            or (signature[:4] == b"RIFF" and signature[8:] == b"WEBP")
        ):
            raise NativeFaceRenderError("Native face source must be JPEG, PNG or WebP")
        source_image = pyvips.Image.new_from_file(
            str(source_path), access="sequential", fail_on="warning"
        )
        source_colours = (
            inspect_native_face_png(source_path)[4] if signature.startswith(b"\x89PNG") else None
        )
        if source_image.get_typeof("n-pages") and source_image.get("n-pages") != 1:
            raise NativeFaceRenderError("Animated face sources require a temporal adapter")
        source_image = source_image.autorot()
        base_image = pyvips.Image.new_from_file(
            str(base_path), access="sequential", fail_on="warning"
        )
        if (source_image.width, source_image.height) != (
            context.source_width,
            context.source_height,
        ):
            raise NativeFaceRenderError("Native face source framing differs from its context")
        source_colour, base_colour = (
            NativeFaceColour.from_image(source_image, source_colours),
            NativeFaceColour.from_image(base_image, colours),
        )
        windows = detector_windows(
            context.source_width, context.source_height, limit=self._bundle.detector_windows
        )
        temporary = tempfile.TemporaryDirectory(prefix="ipw-native-face-source-")
        directory = Path(temporary.name)
        required = sum(
            image.width * image.height * image.bands * (2 if image.format == "ushort" else 1)
            for image in (source_image, base_image)
        )
        mapped: list[np.memmap[Any, Any]] = []
        try:
            if (
                required > MAX_SCRATCH_BYTES
                or required + 64 * 1024 * 1024 > shutil.disk_usage(directory).free
            ):
                raise NativeFaceRenderError(
                    "Native face decode requires more private scratch storage"
                )
            for image, name in ((source_image, "source.raw"), (base_image, "base.raw")):
                _check(cancelled)
                path = directory / name
                image.rawsave(str(path))
                mapped.append(
                    np.memmap(
                        path,
                        mode="r",
                        dtype=np.uint16 if image.format == "ushort" else np.uint8,
                        shape=(image.height, image.width, image.bands),
                    )
                )
                _check(cancelled)
            self._identities(source_path, base_path, context)
            detections = []
            for window in windows:
                _check(cancelled)
                heads = detector.run(
                    list(HEADS),
                    {"input": detector_tensor(mapped[0], window, source_colour.working_rgb)},
                )
                _check(cancelled)
                detections.extend(decode_heads(dict(zip(HEADS, heads, strict=True)), window))
                if len(detections) > 4096:
                    raise NativeFaceRenderError(
                        "Native face detections exceed the bounded review budget"
                    )
            alignment = align_face(single_face(detections), YUNET_SHA256)
            reference = aligned_rgb(mapped[0], alignment, source_colour.working_rgb)
            if mapped[0].shape[2] == 4:
                a, b, tx, ty = inverse(alignment)
                yy, xx = np.mgrid[:512, :512]
                sx, sy = a * xx - b * yy + tx, b * xx + a * yy + ty
                core = ((xx - 256) / 148) ** 2 + ((yy - 309) / 168) ** 2 <= 1
                alpha = mapped[0][
                    np.clip(np.rint(sy).astype(int), 0, context.source_height - 1),
                    np.clip(np.rint(sx).astype(int), 0, context.source_width - 1),
                    3,
                ]
                if np.any(alpha[core] != (65535 if source_colour.bit_depth == 16 else 255)):
                    raise NativeFaceRenderError(
                        "A transparent face source requires an alpha-aware restorer"
                    )
            prepared = PreparedFace(
                context,
                source_path,
                base_path,
                temporary,
                mapped[0],
                mapped[1],
                base_colour,
                alignment,
                reference,
            )
            self._prepared = prepared
            return prepared
        except BaseException:
            for item in mapped:
                item._mmap.close()  # noqa: SLF001 -- Close before deleting private scratch on Windows.
            temporary.cleanup()
            raise

    def propose(
        self,
        *,
        source_path: Path,
        base_path: Path,
        context: NativeFaceContext,
        fidelity_permyriad: int,
        cancelled: Callable[[], bool],
    ) -> NativeFaceProposal:
        try:
            if type(fidelity_permyriad) is not int or not 0 <= fidelity_permyriad <= 10000:
                raise NativeFaceRenderError(
                    "Native face fidelity must be an integer from 0 to 10000"
                )
            context = NativeFaceContext.model_validate_json(context.model_dump_json())
            self._approved()
            _check(cancelled)
            detector, restorer = self._sessions()
            prepared = self._prepare(source_path, base_path, context, detector, cancelled)
            tensor = np.ascontiguousarray(
                prepared.reference.transpose(2, 0, 1)[None] * 2 - 1, dtype=np.float32
            )
            fidelity = np.full(
                self._bundle.fidelity_shape,
                fidelity_permyriad / 10000,
                dtype=np.float32 if self._bundle.fidelity_type == "tensor(float)" else np.float64,
            )
            self._approved()
            _check(cancelled)
            output = restorer.run(
                [self._bundle.output],
                {self._bundle.image_input: tensor, self._bundle.fidelity_input: fidelity},
            )[0]
            _check(cancelled)
            self._approved()
            if (
                output.dtype != np.float32
                or output.shape != (1, 3, 512, 512)
                or not np.all(np.isfinite(output))
                or np.any(np.abs(output) > 1.001)
            ):
                raise NativeFaceRenderError(
                    "Native face model output is incompatible, nonfinite or out of range"
                )
            restored = np.clip(output[0].transpose(1, 2, 0) * 0.5 + 0.5, 0, 1)
            region, u, v, mask = proposal_coordinates(context, prepared.alignment)
            base = prepared.base[
                region.y : region.y + region.height, region.x : region.x + region.width
            ]
            maximum = 65535 if context.bit_depth == 16 else 255
            pixels = np.empty((region.height, region.width, 4), dtype=base.dtype)
            pixels[..., :3] = base[..., :3]
            pixels[..., 3] = base[..., 3] if base.shape[2] == 4 else maximum
            # ICC/detail correction uses bounded tiles, not full-output tensors.
            for top in range(0, region.height, 128):
                for left in range(0, region.width, 1024):
                    _check(cancelled)
                    ys, xs = slice(top, top + 128), slice(left, left + 1024)
                    x, y = u[ys, xs], v[ys, xs]
                    reference = sample_rgb(prepared.reference, x, y, lambda value: value)
                    proposed = sample_rgb(restored, x, y, lambda value: value)
                    pixels[ys, xs] = prepared.colour.detail_proposal(
                        pixels[ys, xs], reference, proposed
                    )
            protected = mask == 0
            if base.shape[2] == 4:
                protected |= base[..., 3] == 0
            pixels[..., :3][protected] = base[..., :3][protected]
            self._approved()
            _check(cancelled)
            self._identities(source_path, base_path, context)
            return NativeFaceProposal(region, pixels, mask, prepared.alignment)
        except BaseException:
            self.clear_source()
            raise
