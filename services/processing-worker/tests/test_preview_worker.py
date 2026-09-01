from __future__ import annotations

import hashlib
import io

from PIL import Image

from ipw.processing_worker.durable_intake import DispatchMessage
from ipw.processing_worker.preview import (
    DurablePreviewProcessor,
    LeasedPreviewJob,
    PreviewDerivative,
)
from ipw.storage import ObjectZone, PrivateObjectRef, PrivateObjectSnapshot


def png(width: int = 96, height: int = 64) -> bytes:
    output = io.BytesIO()
    Image.new("RGB", (width, height), (32, 96, 180)).save(output, "PNG")
    return output.getvalue()


class Repository:
    def __init__(self, leased: LeasedPreviewJob) -> None:
        self.leased = leased
        self.started = False
        self.checkpoints: list[tuple[str, dict[str, object]]] = []
        self.completed: tuple[PreviewDerivative, ...] = ()
        self.failed: tuple[str, str, bool] | None = None
        self.cancelled = False

    def claim_preview(self, **_values: object) -> LeasedPreviewJob:
        return self.leased

    def start_preview(self, _lease: LeasedPreviewJob) -> None:
        self.started = True

    def heartbeat_preview(self, _lease: LeasedPreviewJob) -> None:
        pass

    def cancellation_requested_preview(self, _lease: LeasedPreviewJob) -> bool:
        return self.cancelled

    def checkpoint_preview(
        self, _lease: LeasedPreviewJob, key: str, payload: dict[str, object]
    ) -> None:
        self.checkpoints.append((key, payload))

    def complete_preview(
        self, _lease: LeasedPreviewJob, derivatives: tuple[PreviewDerivative, ...]
    ) -> None:
        self.completed = derivatives

    def fail_preview(
        self, _lease: LeasedPreviewJob, *, code: str, message: str, retryable: bool
    ) -> str:
        self.failed = (code, message, retryable)
        return "failed"


class Objects:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.writes: list[tuple[PrivateObjectRef, bytes, str]] = []

    def read(
        self, ref: PrivateObjectRef, *, generation: str, max_bytes: int
    ) -> PrivateObjectSnapshot:
        assert ref.zone is ObjectZone.IMMUTABLE
        assert generation == hashlib.sha256(self.data).hexdigest()
        assert len(self.data) <= max_bytes
        return PrivateObjectSnapshot(
            ref, hashlib.sha256(self.data).hexdigest(), "image/png", self.data
        )

    def write_derivative(
        self, ref: PrivateObjectRef, *, data: bytes, media_type: str, sha256: str
    ) -> PrivateObjectSnapshot:
        assert ref.zone is ObjectZone.DERIVATIVE
        assert hashlib.sha256(data).hexdigest() == sha256
        self.writes.append((ref, data, media_type))
        return PrivateObjectSnapshot(ref, sha256, media_type, data)


def leased_job(data: bytes, *, media_type: str = "image/png") -> LeasedPreviewJob:
    digest = hashlib.sha256(data).hexdigest()
    return LeasedPreviewJob(
        job_id="job-preview-unit",
        document_id="document-preview-unit",
        workspace_id="workspace-preview-unit",
        actor_id="actor-preview-unit",
        source_version_id="source-preview-unit",
        document_version_id="version-preview-unit",
        source_object_key=f"immutable/workspace-preview-unit/{digest}",
        source_sha256=digest,
        source_media_type=media_type,
        source_byte_size=len(data),
        source_width=96,
        source_height=64,
        source_storage_generation=digest,
        lease_token_hash="a" * 64,
        trace_id="trace-preview-unit",
        attempt=1,
        max_attempts=3,
    )


def test_preview_worker_generates_bounded_deterministic_zoom_derivatives() -> None:
    source = png()
    repository = Repository(leased_job(source))
    objects = Objects(source)

    outcome = DurablePreviewProcessor(repository, objects, worker_id="worker-unit").process(
        DispatchMessage("dispatch-unit", repository.leased.job_id, repository.leased.trace_id)
    )

    assert outcome.state == "succeeded"
    assert repository.started
    assert repository.checkpoints[0][0] == "preview-rendered"
    assert [item.zoom_level for item in repository.completed] == ["workspace", "thumbnail"]
    assert len(objects.writes) == 2
    for item, (_, payload, media_type) in zip(repository.completed, objects.writes, strict=True):
        edge = 2048 if item.zoom_level == "workspace" else 512
        assert item.width <= edge
        assert item.height <= edge
        assert item.sha256 == hashlib.sha256(payload).hexdigest()
        assert media_type == "image/png"
        with Image.open(io.BytesIO(payload)) as rendered:
            assert rendered.info.get("exif") is None


def test_preview_worker_fails_closed_for_format_policy_drift() -> None:
    source = png()
    repository = Repository(leased_job(source, media_type="image/tiff"))
    objects = Objects(source)

    outcome = DurablePreviewProcessor(repository, objects, worker_id="worker-unit").process(
        DispatchMessage("dispatch-unit", repository.leased.job_id, repository.leased.trace_id)
    )

    assert outcome.state == "failed"
    assert repository.failed is not None
    assert repository.failed[0] == "preview-source-unsafe"
    assert repository.failed[2] is False
    assert objects.writes == []
