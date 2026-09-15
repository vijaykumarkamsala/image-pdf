"""Durable execution boundary for isolated Image Quality Editor restoration."""

from __future__ import annotations

import hashlib
import secrets
import tempfile
import threading
import time
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Protocol

from ipw.processing_worker.durable_intake import DispatchMessage, WorkerOutcome
from ipw.processing_worker.image_quality_model import (
    ImageQualityCancelledError,
    ImageQualityModelError,
    ImageQualitySource,
    RestorationFidelity,
    RestoredImage,
    RestoredTile,
)
from ipw.processing_worker.repository import JobBusyError
from ipw.storage import (
    LargeWorkerPrivateObjectStore,
    ObjectZone,
    PreviewPrivateObjectStore,
    PrivateObjectRef,
)

MAX_CURRENT_SOURCE_BYTES = 1024 * 1024 * 1024 * 1024
MAX_CURRENT_OUTPUT_BYTES = 4 * 1024**4
IN_MEMORY_SOURCE_BYTES = 64 * 1024 * 1024


class ImageQualitySliceYieldError(RuntimeError):
    """A bounded Cloud Run invocation checkpointed work and yielded safely."""


@dataclass(frozen=True)
class LeasedImageQualityJob:
    job_id: str
    request_id: str
    owner_scope: str
    source_version_id: str
    source_object_key: str
    source_storage_generation: str
    source_sha256: str
    source_media_type: str
    source_byte_size: int
    source_width: int
    source_height: int
    source_frame_count: int
    source_bit_depth: int
    source_has_icc_profile: bool
    source_colour_primaries: str | None
    source_dynamic_range: str | None
    content_class: str
    strength: int
    lease_token_hash: str
    trace_id: str
    attempt: int
    max_attempts: int


class ImageQualityJobRepository(Protocol):
    def claim_image_quality(
        self, *, job_id: str, worker_id: str, lease_token: str, trace_id: str
    ) -> LeasedImageQualityJob | None: ...

    def start_image_quality(self, lease: LeasedImageQualityJob) -> None: ...
    def heartbeat_image_quality(self, lease: LeasedImageQualityJob) -> None: ...
    def cancellation_requested_image_quality(self, lease: LeasedImageQualityJob) -> bool: ...
    def checkpoint_image_quality(
        self,
        lease: LeasedImageQualityJob,
        key: str,
        payload: dict[str, Any],
        progress_percent: int,
    ) -> None: ...

    def restored_tiles_image_quality(
        self, lease: LeasedImageQualityJob
    ) -> dict[str, dict[str, Any]]: ...

    def yield_image_quality(self, lease: LeasedImageQualityJob) -> None: ...

    def complete_image_quality(
        self,
        lease: LeasedImageQualityJob,
        *,
        object_key: str,
        storage_generation: str,
        result: RestoredImage,
    ) -> None: ...

    def fail_image_quality(
        self,
        lease: LeasedImageQualityJob,
        *,
        code: str,
        message: str,
        retryable: bool,
    ) -> str: ...


class ImageQualityRestorationEngine(Protocol):
    def restore(
        self,
        source: ImageQualitySource,
        *,
        strength: int,
        progress: Any = None,
        cancelled: Any = None,
    ) -> RestoredImage: ...

    def restore_path(
        self,
        source: ImageQualitySource,
        *,
        input_path: str,
        output_path: str,
        strength: int,
        progress: Any = None,
        cancelled: Any = None,
        load_tile: Any = None,
        save_tile: Any = None,
    ) -> RestoredImage: ...


class DurableImageQualityProcessor:
    def __init__(
        self,
        repository: ImageQualityJobRepository,
        objects: PreviewPrivateObjectStore,
        engine: ImageQualityRestorationEngine,
        *,
        worker_id: str,
        execution_lock: threading.Lock | None = None,
        max_slice_seconds: float = 8 * 60,
    ) -> None:
        self._repository = repository
        self._objects = objects
        self._engine = engine
        self._worker_id = worker_id
        self._execution_lock = execution_lock or threading.Lock()
        self._max_slice_seconds = max_slice_seconds
        self._slice_deadline: float | None = None

    def process(self, message: DispatchMessage) -> WorkerOutcome:
        with self._execution_lock:
            return self._process_locked(message)

    def _process_locked(self, message: DispatchMessage) -> WorkerOutcome:
        try:
            lease = self._repository.claim_image_quality(
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
            self._repository.start_image_quality(lease)
            self._heartbeat_and_cancel(lease)
            source_ref = PrivateObjectRef(
                lease.owner_scope,
                lease.source_object_key,
                ObjectZone.IMMUTABLE,
            )
            source = ImageQualitySource(
                data=b"",
                sha256=lease.source_sha256,
                media_type=lease.source_media_type,
                width=lease.source_width,
                height=lease.source_height,
                frame_count=lease.source_frame_count,
                bit_depth=lease.source_bit_depth,
                content_class=lease.content_class,  # type: ignore[arg-type]
                has_icc_profile=lease.source_has_icc_profile,
                colour_primaries=lease.source_colour_primaries,
                dynamic_range=lease.source_dynamic_range,
            )
            if (
                lease.source_byte_size > IN_MEMORY_SOURCE_BYTES
                or lease.source_bit_depth > 8
                or lease.source_has_icc_profile
                or lease.source_colour_primaries in {"display-p3", "bt2020"}
                or (lease.source_dynamic_range or "").startswith("hdr-")
            ):
                result, stored = self._restore_materialized(lease, source_ref, source)
            else:
                snapshot = self._objects.read(
                    source_ref,
                    generation=lease.source_storage_generation,
                    max_bytes=lease.source_byte_size,
                )
                if len(snapshot.data) != lease.source_byte_size:
                    raise ImageQualityModelError("immutable source byte count changed")
                if hashlib.sha256(snapshot.data).hexdigest() != lease.source_sha256:
                    raise ImageQualityModelError("immutable source checksum changed")
                result = self._engine.restore(
                    replace(source, data=snapshot.data),
                    strength=lease.strength,
                    progress=lambda completed, total: self._progress(lease, completed, total),
                    cancelled=lambda: self._repository.cancellation_requested_image_quality(lease),
                )
                output_ref = self._output_ref(lease, result)
                stored = self._objects.write_derivative(
                    output_ref,
                    data=result.data,
                    media_type=result.media_type,
                    sha256=result.sha256,
                    max_bytes=MAX_CURRENT_OUTPUT_BYTES,
                )
            self._repository.complete_image_quality(
                lease,
                object_key=stored.ref.object_key,
                storage_generation=stored.generation,
                result=result,
            )
            return WorkerOutcome("succeeded", lease.job_id)
        except ImageQualityCancelledError:
            state = self._repository.fail_image_quality(
                lease,
                code="image-quality-cancelled",
                message="Image enhancement was cancelled",
                retryable=False,
            )
            return WorkerOutcome(state, lease.job_id)
        except ImageQualitySliceYieldError:
            self._repository.yield_image_quality(lease)
            return WorkerOutcome("queued", lease.job_id)
        except (ImageQualityModelError, ValueError) as error:
            state = self._repository.fail_image_quality(
                lease,
                code="image-quality-source-unsupported",
                message=str(error),
                retryable=False,
            )
            return WorkerOutcome(state, lease.job_id)
        except (ConnectionError, OSError, RuntimeError) as error:
            state = self._repository.fail_image_quality(
                lease,
                code="image-quality-temporary-failure",
                message=str(error),
                retryable=True,
            )
            return WorkerOutcome(state, lease.job_id)

    def _restore_materialized(
        self,
        lease: LeasedImageQualityJob,
        source_ref: PrivateObjectRef,
        source: ImageQualitySource,
    ) -> tuple[RestoredImage, Any]:
        if not isinstance(self._objects, LargeWorkerPrivateObjectStore):
            raise RuntimeError("large-object storage capability is unavailable")
        with tempfile.TemporaryDirectory(prefix="ipw-quality-") as temporary:
            materialized = self._objects.materialize(
                source_ref,
                generation=lease.source_storage_generation,
                destination=Path(temporary) / "source.image",
                max_bytes=min(lease.source_byte_size, MAX_CURRENT_SOURCE_BYTES),
            )
            if materialized.byte_size != lease.source_byte_size:
                raise ImageQualityModelError("immutable source byte count changed")
            if materialized.sha256 != lease.source_sha256:
                raise ImageQualityModelError("immutable source checksum changed")
            tile_records = self._repository.restored_tiles_image_quality(lease)

            def load_tile(key: str) -> RestoredTile | None:
                record = tile_records.get(key)
                if not record:
                    return None
                try:
                    ref = PrivateObjectRef(
                        lease.owner_scope,
                        str(record["object_key"]),
                        ObjectZone.DERIVATIVE,
                    )
                    snapshot = self._objects.read(
                        ref,
                        generation=str(record["storage_generation"]),
                        max_bytes=8 * 1024 * 1024,
                    )
                    if hashlib.sha256(snapshot.data).hexdigest() != record["sha256"]:
                        raise RuntimeError("durable restoration tile checksum changed")
                    fidelity = record["fidelity"]
                    return RestoredTile(
                        snapshot.data,
                        RestorationFidelity(
                            float(fidelity["low_texture_mean_rgb_shift"]),
                            float(fidelity["high_drift_fraction"]),
                            float(fidelity["alpha_mismatch_fraction"]),
                            float(fidelity["overall_mean_rgb_difference"]),
                            bool(fidelity["passed"]),
                        ),
                    )
                except (KeyError, TypeError, ValueError):
                    return None

            def save_tile(key: str, tile: RestoredTile) -> None:
                digest = hashlib.sha256(tile.data).hexdigest()
                tile_ref = PrivateObjectRef(
                    lease.owner_scope,
                    (
                        f"derivative/{lease.owner_scope}/image-quality/{lease.request_id}/"
                        f"tiles/{key}-{digest}.raw"
                    ),
                    ObjectZone.DERIVATIVE,
                )
                stored_tile = self._objects.write_derivative(
                    tile_ref,
                    data=tile.data,
                    media_type="application/octet-stream",
                    sha256=digest,
                    max_bytes=8 * 1024 * 1024,
                )
                self._repository.checkpoint_image_quality(
                    lease,
                    f"restore-tile-{key}",
                    {
                        "tile_key": key,
                        "object_key": stored_tile.ref.object_key,
                        "storage_generation": stored_tile.generation,
                        "sha256": digest,
                        "byte_size": len(tile.data),
                        "fidelity": {
                            "low_texture_mean_rgb_shift": (
                                tile.fidelity.low_texture_mean_rgb_shift
                            ),
                            "high_drift_fraction": tile.fidelity.high_drift_fraction,
                            "alpha_mismatch_fraction": tile.fidelity.alpha_mismatch_fraction,
                            "overall_mean_rgb_difference": (
                                tile.fidelity.overall_mean_rgb_difference
                            ),
                            "passed": tile.fidelity.passed,
                        },
                    },
                    10,
                )

            self._slice_deadline = time.monotonic() + self._max_slice_seconds
            try:
                result = self._engine.restore_path(
                    source,
                    input_path=str(materialized.path),
                    output_path=str(Path(temporary) / "enhanced.png"),
                    strength=lease.strength,
                    progress=lambda completed, total: self._progress(
                        lease, completed, total
                    ),
                    cancelled=lambda: (
                        self._repository.cancellation_requested_image_quality(lease)
                    ),
                    load_tile=load_tile,
                    save_tile=save_tile,
                )
            finally:
                self._slice_deadline = None
            if not result.artifact_path:
                raise RuntimeError("large restoration did not create a file artifact")
            stored = self._objects.write_derivative_file(
                self._output_ref(lease, result),
                source=result.artifact_path,
                media_type=result.media_type,
                sha256=result.sha256,
                max_bytes=MAX_CURRENT_OUTPUT_BYTES,
            )
            return result, stored

    @staticmethod
    def _output_ref(
        lease: LeasedImageQualityJob, result: RestoredImage
    ) -> PrivateObjectRef:
        object_key = (
            f"derivative/{lease.owner_scope}/image-quality/{lease.request_id}/"
            f"{result.sha256}.png"
        )
        return PrivateObjectRef(lease.owner_scope, object_key, ObjectZone.DERIVATIVE)

    def _progress(self, lease: LeasedImageQualityJob, completed: int, total: int) -> None:
        self._heartbeat_and_cancel(lease)
        percent = 10 + round(completed / max(total, 1) * 80)
        self._repository.checkpoint_image_quality(
            lease,
            f"progress-{completed:08d}",
            {"completed_tiles": completed, "total_tiles": total},
            percent,
        )
        if self._slice_deadline is not None and time.monotonic() >= self._slice_deadline:
            raise ImageQualitySliceYieldError("durable image processing slice completed")

    def _heartbeat_and_cancel(self, lease: LeasedImageQualityJob) -> None:
        self._repository.heartbeat_image_quality(lease)
        if self._repository.cancellation_requested_image_quality(lease):
            raise ImageQualityCancelledError("image enhancement was cancelled")
