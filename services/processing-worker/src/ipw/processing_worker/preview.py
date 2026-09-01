"""Durable, bounded raster proxies for Image & Graphic Studio."""

from __future__ import annotations

import hashlib
import io
import secrets
from dataclasses import dataclass, field
from typing import Any, Protocol

from PIL import Image, ImageCms, ImageOps, UnidentifiedImageError

from ipw.contracts import StudioEditableMediaType
from ipw.processing_worker.durable_intake import DispatchMessage, WorkerOutcome
from ipw.processing_worker.repository import JobBusyError
from ipw.storage import ObjectZone, PrivateObjectRef, WorkerPrivateObjectStore

MAX_COMPRESSED_BYTES = 100 * 1024 * 1024
MAX_DECODED_PIXELS = 100_000_000
MAX_DIMENSION = 50_000
WORKSPACE_EDGE = 2_048
THUMBNAIL_EDGE = 512
PROCESSOR_NAME = "ipw-bounded-pillow-preview"
PROCESSOR_VERSION = "1.0.0"
EDITABLE_MEDIA_TYPES = frozenset(value.value for value in StudioEditableMediaType)
Image.MAX_IMAGE_PIXELS = MAX_DECODED_PIXELS


@dataclass(frozen=True)
class LeasedPreviewJob:
    job_id: str
    document_id: str
    workspace_id: str
    actor_id: str
    source_version_id: str
    document_version_id: str
    source_object_key: str
    source_sha256: str
    source_media_type: str
    source_byte_size: int
    source_width: int
    source_height: int
    lease_token_hash: str
    trace_id: str
    attempt: int
    max_attempts: int


@dataclass(frozen=True)
class PreviewDerivative:
    preview_id: str
    zoom_level: str
    object_key: str
    sha256: str
    media_type: str
    byte_size: int
    width: int
    height: int
    colour_decision: str
    metadata_decision: str
    data: bytes = field(repr=False)


class PreviewJobRepository(Protocol):
    def claim_preview(self, *, job_id: str, worker_id: str, lease_token: str, trace_id: str) -> LeasedPreviewJob | None: ...
    def start_preview(self, lease: LeasedPreviewJob) -> None: ...
    def heartbeat_preview(self, lease: LeasedPreviewJob) -> None: ...
    def cancellation_requested_preview(self, lease: LeasedPreviewJob) -> bool: ...
    def checkpoint_preview(self, lease: LeasedPreviewJob, key: str, payload: dict[str, Any]) -> None: ...
    def complete_preview(self, lease: LeasedPreviewJob, derivatives: tuple[PreviewDerivative, ...]) -> None: ...
    def fail_preview(self, lease: LeasedPreviewJob, *, code: str, message: str, retryable: bool) -> str: ...


class DurablePreviewProcessor:
    def __init__(self, repository: PreviewJobRepository, objects: WorkerPrivateObjectStore, *, worker_id: str) -> None:
        self._repository = repository
        self._objects = objects
        self._worker_id = worker_id

    def process(self, message: DispatchMessage) -> WorkerOutcome:
        try:
            lease = self._repository.claim_preview(
                job_id=message.job_id,
                worker_id=self._worker_id,
                lease_token=secrets.token_urlsafe(32),
                trace_id=message.trace_id,
            )
        except JobBusyError:
            return WorkerOutcome("busy", message.job_id)
        if lease is None:
            return WorkerOutcome("already_terminal", message.job_id)
        try:
            self._repository.start_preview(lease)
            self._cancel_guard(lease)
            source = PrivateObjectRef(lease.workspace_id, lease.source_object_key, ObjectZone.IMMUTABLE)
            snapshot = self._objects.read(source, generation="", max_bytes=MAX_COMPRESSED_BYTES)
            if len(snapshot.data) != lease.source_byte_size:
                raise ValueError("immutable source byte count does not match its source version")
            if hashlib.sha256(snapshot.data).hexdigest() != lease.source_sha256:
                raise ValueError("immutable source checksum does not match its source version")
            derivatives = self._render(lease, snapshot.data)
            self._repository.checkpoint_preview(
                lease,
                "preview-rendered",
                {"source_sha256": lease.source_sha256, "derivatives": [item.sha256 for item in derivatives]},
            )
            self._cancel_guard(lease)
            for derivative in derivatives:
                ref = PrivateObjectRef(lease.workspace_id, derivative.object_key, ObjectZone.DERIVATIVE)
                self._objects.write_derivative(
                    ref,
                    data=derivative.data,
                    media_type=derivative.media_type,
                    sha256=derivative.sha256,
                )
            self._repository.complete_preview(lease, derivatives)
            return WorkerOutcome("succeeded", lease.job_id)
        except PreviewCancelled:
            return WorkerOutcome("cancelled", lease.job_id)
        except (ValueError, UnidentifiedImageError, Image.DecompressionBombError) as error:
            state = self._repository.fail_preview(lease, code="preview-source-unsafe", message=str(error), retryable=False)
            return WorkerOutcome(state, lease.job_id)
        except (TimeoutError, ConnectionError, OSError) as error:
            state = self._repository.fail_preview(lease, code="preview-temporary-failure", message=str(error), retryable=True)
            return WorkerOutcome(state, lease.job_id)

    def _render(self, lease: LeasedPreviewJob, data: bytes) -> tuple[PreviewDerivative, ...]:
        if lease.source_media_type not in EDITABLE_MEDIA_TYPES:
            raise ValueError("source format has no approved Studio preview path")
        with Image.open(io.BytesIO(data)) as opened:
            if opened.width != lease.source_width or opened.height != lease.source_height:
                raise ValueError("decoded dimensions do not match inspected source facts")
            if opened.width > MAX_DIMENSION or opened.height > MAX_DIMENSION:
                raise ValueError("source dimension exceeds preview processor capacity")
            if opened.width * opened.height > MAX_DECODED_PIXELS:
                raise ValueError("source pixels exceed preview processor capacity")
            opened.load()
            upright = ImageOps.exif_transpose(opened)
            alpha = (
                upright.convert("RGBA").getchannel("A")
                if "A" in upright.getbands() or "transparency" in upright.info
                else None
            )
            profile = opened.info.get("icc_profile")
            if profile:
                try:
                    working = ImageCms.profileToProfile(
                        upright.convert("RGB"),
                        ImageCms.ImageCmsProfile(io.BytesIO(profile)),
                        ImageCms.createProfile("sRGB"),
                        outputMode="RGB",
                    )
                except ImageCms.PyCMSError as error:
                    raise ValueError("embedded colour profile could not be interpreted safely") from error
                colour_decision = "embedded ICC profile converted to sRGB"
            else:
                working = upright.convert("RGB")
                colour_decision = "unprofiled channels treated as sRGB for the preview"
            if alpha is not None:
                working.putalpha(alpha)
            metadata_decision = "EXIF orientation applied; source metadata omitted from the proxy"
            rendered: list[PreviewDerivative] = []
            for level, edge in (("workspace", WORKSPACE_EDGE), ("thumbnail", THUMBNAIL_EDGE)):
                proxy = working.copy()
                proxy.thumbnail((edge, edge), Image.Resampling.LANCZOS)
                output = io.BytesIO()
                proxy.save(output, format="PNG", optimize=False, compress_level=6)
                payload = output.getvalue()
                digest = hashlib.sha256(payload).hexdigest()
                item = PreviewDerivative(
                    preview_id=f"preview-{hashlib.sha256(f'{lease.job_id}:{level}'.encode()).hexdigest()[:24]}",
                    zoom_level=level,
                    object_key=f"derivative/{lease.workspace_id}/{lease.source_version_id}/{lease.job_id}/{level}.png",
                    sha256=digest,
                    media_type="image/png",
                    byte_size=len(payload),
                    width=proxy.width,
                    height=proxy.height,
                    colour_decision=colour_decision,
                    metadata_decision=metadata_decision,
                    data=payload,
                )
                rendered.append(item)
            return tuple(rendered)

    def _cancel_guard(self, lease: LeasedPreviewJob) -> None:
        self._repository.heartbeat_preview(lease)
        if self._repository.cancellation_requested_preview(lease):
            self._repository.fail_preview(lease, code="preview-cancelled", message="Preview preparation was cancelled", retryable=False)
            raise PreviewCancelled()


class PreviewCancelled(RuntimeError):
    pass
