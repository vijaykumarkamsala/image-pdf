from __future__ import annotations

import hashlib
from dataclasses import replace
from pathlib import Path
from typing import Any

from ipw.processing_worker.durable_intake import DispatchMessage
from ipw.processing_worker.image_quality import (
    DurableImageQualityProcessor,
    LeasedImageQualityJob,
)
from ipw.processing_worker.image_quality_model import (
    RestorationFidelity,
    RestoredImage,
    RestoredTile,
)
from ipw.storage import MaterializedPrivateObject, PrivateObjectSnapshot


def lease(payload: bytes) -> LeasedImageQualityJob:
    return LeasedImageQualityJob(
        job_id="job-quality",
        request_id="quality-request",
        owner_scope="guest-quality",
        source_version_id="source-quality",
        source_object_key="immutable/guest-quality/source",
        source_storage_generation="source-generation",
        source_sha256=hashlib.sha256(payload).hexdigest(),
        source_media_type="image/png",
        source_byte_size=len(payload),
        source_width=10,
        source_height=8,
        source_frame_count=1,
        source_bit_depth=8,
        source_has_icc_profile=False,
        source_colour_primaries=None,
        source_dynamic_range=None,
        content_class="illustration",
        strength=70,
        lease_token_hash=hashlib.sha256(b"quality-test-lease").hexdigest(),
        trace_id="trace-quality",
        attempt=1,
        max_attempts=3,
    )


class Repository:
    def __init__(self, job: LeasedImageQualityJob) -> None:
        self.job = job
        self.started = False
        self.cancelled = False
        self.checkpoints: list[tuple[str, int]] = []
        self.completed: tuple[str, str, RestoredImage] | None = None
        self.failed: tuple[str, bool] | None = None
        self.tile_records: dict[str, dict[str, Any]] = {}
        self.yielded = False

    def claim_image_quality(self, **_: object) -> LeasedImageQualityJob | None:
        return self.job

    def start_image_quality(self, _lease: LeasedImageQualityJob) -> None:
        self.started = True

    def heartbeat_image_quality(self, _lease: LeasedImageQualityJob) -> None:
        return

    def cancellation_requested_image_quality(self, _lease: LeasedImageQualityJob) -> bool:
        return self.cancelled

    def checkpoint_image_quality(
        self,
        _lease: LeasedImageQualityJob,
        key: str,
        payload: dict[str, Any],
        progress_percent: int,
    ) -> None:
        self.checkpoints.append((key, progress_percent))
        if key.startswith("restore-tile-"):
            self.tile_records[key.removeprefix("restore-tile-")] = payload

    def restored_tiles_image_quality(
        self, _lease: LeasedImageQualityJob
    ) -> dict[str, dict[str, Any]]:
        return dict(self.tile_records)

    def yield_image_quality(self, _lease: LeasedImageQualityJob) -> None:
        self.yielded = True

    def complete_image_quality(
        self,
        _lease: LeasedImageQualityJob,
        *,
        object_key: str,
        storage_generation: str,
        result: RestoredImage,
    ) -> None:
        self.completed = (object_key, storage_generation, result)

    def fail_image_quality(
        self,
        _lease: LeasedImageQualityJob,
        *,
        code: str,
        message: str,
        retryable: bool,
    ) -> str:
        del message
        self.failed = (code, retryable)
        if retryable:
            return "retry_wait"
        return "cancelled" if code.endswith("cancelled") else "failed"


class Objects:
    def __init__(self, payload: bytes) -> None:
        self.payload = payload
        self.written: bytes | None = None

    def read(self, ref: Any, *, generation: str, max_bytes: int) -> PrivateObjectSnapshot:
        assert generation == "source-generation"
        assert len(self.payload) <= max_bytes
        return PrivateObjectSnapshot(ref, generation, "image/png", self.payload)

    def write_derivative(
        self,
        ref: Any,
        *,
        data: bytes,
        media_type: str,
        sha256: str,
        max_bytes: int,
    ) -> PrivateObjectSnapshot:
        assert media_type == "image/png"
        assert hashlib.sha256(data).hexdigest() == sha256
        assert len(data) <= max_bytes
        self.written = data
        return PrivateObjectSnapshot(ref, "output-generation", media_type, data)


class Engine:
    def __init__(self, output: bytes = b"processed-png", error: Exception | None = None) -> None:
        self.output = output
        self.error = error

    def restore(
        self, source: Any, *, strength: int, progress: Any, cancelled: Any
    ) -> RestoredImage:
        if self.error:
            raise self.error
        assert strength == 70
        assert not cancelled()
        progress(1, 2)
        progress(2, 2)
        return RestoredImage(
            data=self.output,
            sha256=hashlib.sha256(self.output).hexdigest(),
            media_type="image/png",
            width=20,
            height=16,
            source_sha256=source.sha256,
            model_id="public-realplksr-2x",
            model_version="model-version",
            model_sha256="a" * 64,
            processor_name="quality-worker",
            processor_version="1.0.0",
            strength=strength,
            tile_count=2,
            colour_policy="source-authoritative",
            fidelity=RestorationFidelity(1.0, 0.0, 0.0, 1.0, True),
        )


class LargeObjects(Objects):
    def __init__(self, payload: bytes, root: Path) -> None:
        super().__init__(payload)
        self.root = root
        self.file_write_used = False
        self.derivatives: dict[str, bytes] = {}

    def read(self, ref: Any, *, generation: str, max_bytes: int) -> PrivateObjectSnapshot:
        if ref.object_key in self.derivatives:
            data = self.derivatives[ref.object_key]
            assert hashlib.sha256(data).hexdigest() == generation
            assert len(data) <= max_bytes
            return PrivateObjectSnapshot(ref, generation, "application/octet-stream", data)
        return super().read(ref, generation=generation, max_bytes=max_bytes)

    def write_derivative(
        self,
        ref: Any,
        *,
        data: bytes,
        media_type: str,
        sha256: str,
        max_bytes: int,
    ) -> PrivateObjectSnapshot:
        assert media_type == "application/octet-stream"
        assert len(data) <= max_bytes
        assert hashlib.sha256(data).hexdigest() == sha256
        self.derivatives[ref.object_key] = data
        return PrivateObjectSnapshot(ref, sha256, media_type, data)

    def materialize(
        self,
        ref: Any,
        *,
        generation: str,
        destination: Path,
        max_bytes: int,
    ) -> MaterializedPrivateObject:
        assert generation == "source-generation"
        assert len(self.payload) <= max_bytes
        destination.write_bytes(self.payload)
        return MaterializedPrivateObject(
            ref,
            generation,
            "image/png",
            destination,
            len(self.payload),
            hashlib.sha256(self.payload).hexdigest(),
        )

    def write_derivative_file(
        self,
        ref: Any,
        *,
        source: Path,
        media_type: str,
        sha256: str,
        max_bytes: int,
    ) -> PrivateObjectSnapshot:
        output = source.read_bytes()
        assert len(output) <= max_bytes
        assert hashlib.sha256(output).hexdigest() == sha256
        self.file_write_used = True
        self.written = output
        return PrivateObjectSnapshot(ref, "output-generation", media_type, b"")


class FileEngine(Engine):
    def __init__(self, *, expect_resume: bool = False) -> None:
        super().__init__()
        self.expect_resume = expect_resume

    def restore_path(
        self,
        source: Any,
        *,
        input_path: str,
        output_path: str,
        strength: int,
        progress: Any,
        cancelled: Any,
        load_tile: Any,
        save_tile: Any,
    ) -> RestoredImage:
        assert Path(input_path).read_bytes()
        assert not cancelled()
        cached = load_tile("r0000000000-c0000000000")
        assert (cached is not None) is self.expect_resume
        if cached is None:
            save_tile(
                "r0000000000-c0000000000",
                RestoredTile(
                    b"durable-tile",
                    RestorationFidelity(1.0, 0.0, 0.0, 1.0, True),
                ),
            )
        progress(1, 1)
        output = b"file-backed-processed-png"
        path = Path(output_path)
        path.write_bytes(output)
        return replace(
            super().restore(
                source,
                strength=strength,
                progress=lambda *_: None,
                cancelled=cancelled,
            ),
            data=b"",
            sha256=hashlib.sha256(output).hexdigest(),
            artifact_path=path,
            artifact_byte_size=len(output),
            bit_depth=16,
            colour_policy="source-icc-preserved/16-bit",
        )


def test_durable_quality_worker_writes_verified_derivative_and_checkpoints() -> None:
    payload = b"verified-source"
    repository = Repository(lease(payload))
    objects = Objects(payload)
    outcome = DurableImageQualityProcessor(
        repository,
        objects,  # type: ignore[arg-type]
        Engine(),  # type: ignore[arg-type]
        worker_id="worker-quality",
    ).process(DispatchMessage("dispatch-quality", "job-quality", "trace-quality"))

    assert outcome.state == "succeeded"
    assert repository.started
    assert repository.checkpoints == [
        ("progress-00000001", 50),
        ("progress-00000002", 90),
    ]
    assert objects.written == b"processed-png"
    assert repository.completed is not None
    assert repository.completed[0].startswith("derivative/guest-quality/image-quality/")
    assert repository.failed is None


def test_durable_quality_worker_rejects_changed_immutable_source() -> None:
    payload = b"verified-source"
    repository = Repository(replace(lease(payload), source_sha256="0" * 64))
    outcome = DurableImageQualityProcessor(
        repository,
        Objects(payload),  # type: ignore[arg-type]
        Engine(),  # type: ignore[arg-type]
        worker_id="worker-quality",
    ).process(DispatchMessage("dispatch-quality", "job-quality", "trace-quality"))

    assert outcome.state == "failed"
    assert repository.failed == ("image-quality-source-unsupported", False)


def test_durable_quality_worker_marks_transient_model_runtime_for_retry() -> None:
    payload = b"verified-source"
    repository = Repository(lease(payload))
    outcome = DurableImageQualityProcessor(
        repository,
        Objects(payload),  # type: ignore[arg-type]
        Engine(error=RuntimeError("provider temporarily unavailable")),  # type: ignore[arg-type]
        worker_id="worker-quality",
    ).process(DispatchMessage("dispatch-quality", "job-quality", "trace-quality"))

    assert outcome.state == "retry_wait"
    assert repository.failed == ("image-quality-temporary-failure", True)


def test_durable_quality_worker_honours_cancellation_before_source_read() -> None:
    payload = b"verified-source"
    repository = Repository(lease(payload))
    repository.cancelled = True
    objects = Objects(payload)
    outcome = DurableImageQualityProcessor(
        repository,
        objects,  # type: ignore[arg-type]
        Engine(),  # type: ignore[arg-type]
        worker_id="worker-quality",
    ).process(DispatchMessage("dispatch-quality", "job-quality", "trace-quality"))

    assert outcome.state == "cancelled"
    assert objects.written is None
    assert repository.failed == ("image-quality-cancelled", False)


def test_profiled_source_uses_streamed_file_pipeline(tmp_path: Path) -> None:
    payload = b"profiled-verified-source"
    job = replace(
        lease(payload),
        source_bit_depth=16,
        source_has_icc_profile=True,
    )
    repository = Repository(job)
    objects = LargeObjects(payload, tmp_path)
    outcome = DurableImageQualityProcessor(
        repository,
        objects,
        FileEngine(),
        worker_id="worker-quality",
    ).process(DispatchMessage("dispatch-quality", "job-quality", "trace-quality"))

    assert outcome.state == "succeeded"
    assert objects.file_write_used
    assert objects.written == b"file-backed-processed-png"
    assert repository.completed is not None
    assert repository.completed[2].bit_depth == 16

    repository.job = replace(job, attempt=2)
    resumed = DurableImageQualityProcessor(
        repository,
        objects,
        FileEngine(expect_resume=True),
        worker_id="worker-quality",
    ).process(DispatchMessage("dispatch-quality-2", "job-quality", "trace-quality"))
    assert resumed.state == "succeeded"


def test_large_restore_yields_after_a_durable_tile_and_can_resume(tmp_path: Path) -> None:
    payload = b"profiled-verified-source"
    job = replace(lease(payload), source_has_icc_profile=True)
    repository = Repository(job)
    objects = LargeObjects(payload, tmp_path)

    yielded = DurableImageQualityProcessor(
        repository,
        objects,
        FileEngine(),
        worker_id="worker-quality",
        max_slice_seconds=0,
    ).process(DispatchMessage("dispatch-quality", "job-quality", "trace-quality"))

    assert yielded.state == "queued"
    assert repository.yielded
    assert repository.tile_records
    assert not objects.file_write_used

    repository.job = replace(job, attempt=2)
    resumed = DurableImageQualityProcessor(
        repository,
        objects,
        FileEngine(expect_resume=True),
        worker_id="worker-quality",
    ).process(DispatchMessage("dispatch-quality-2", "job-quality", "trace-quality"))
    assert resumed.state == "succeeded"
