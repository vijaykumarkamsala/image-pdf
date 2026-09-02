"""Durable full-resolution image exports and deterministic ZIP bundles."""

from __future__ import annotations

import hashlib
import io
import json
import secrets
import zipfile
from dataclasses import dataclass, field
from typing import Any, Protocol

from PIL import Image

from ipw.processing_worker.durable_intake import DispatchMessage, WorkerOutcome
from ipw.processing_worker.enhancement_engine import (
    MAX_COMPRESSED_SOURCE_BYTES,
    MAX_OUTPUT_BYTES,
    DeterministicImageEngine,
    RenderedImage,
    VerifiedRasterAsset,
)
from ipw.processing_worker.repository import JobBusyError
from ipw.storage import ObjectZone, PreviewPrivateObjectStore, PrivateObjectRef

MAX_ZIP_BYTES = 1024 * 1024 * 1024
MAX_ZIP_ITEMS = 64


@dataclass(frozen=True)
class ExportAssetReference:
    shared_asset_id: str
    source_version_id: str
    object_key: str
    storage_generation: str
    sha256: str
    media_type: str
    byte_size: int
    width: int
    height: int


@dataclass(frozen=True)
class ExportOutputTarget:
    output_id: str
    artboard_id: str
    filename: str
    profile: dict[str, Any]


@dataclass(frozen=True)
class LeasedImageExportJob:
    job_id: str
    export_request_id: str
    workspace_id: str
    actor_id: str
    document_id: str
    document_version_id: str
    recipe_id: str
    recipe_version: int
    operations: list[dict[str, Any]]
    snapshot: dict[str, Any]
    assets: tuple[ExportAssetReference, ...]
    outputs: tuple[ExportOutputTarget, ...]
    lease_token_hash: str
    trace_id: str
    attempt: int
    max_attempts: int


@dataclass(frozen=True)
class StoredExportOutput:
    output_id: str
    object_key: str
    storage_generation: str
    rendered: RenderedImage


@dataclass(frozen=True)
class BundleItem:
    output_id: str
    filename: str
    object_key: str
    storage_generation: str
    sha256: str
    byte_size: int
    media_type: str


@dataclass(frozen=True)
class LeasedExportBundleJob:
    job_id: str
    bundle_id: str
    export_request_id: str
    workspace_id: str
    actor_id: str
    items: tuple[BundleItem, ...]
    expires_at: str
    lease_token_hash: str
    trace_id: str
    attempt: int
    max_attempts: int


@dataclass(frozen=True)
class StoredExportBundle:
    object_key: str
    storage_generation: str
    sha256: str
    byte_size: int
    data: bytes = field(repr=False)


class ImageExportJobRepository(Protocol):
    def claim_image_export(
        self, *, job_id: str, worker_id: str, lease_token: str, trace_id: str
    ) -> LeasedImageExportJob | None: ...
    def start_image_export(self, lease: LeasedImageExportJob) -> None: ...
    def heartbeat_image_export(self, lease: LeasedImageExportJob) -> None: ...
    def cancellation_requested_image_export(self, lease: LeasedImageExportJob) -> bool: ...
    def start_export_output(self, lease: LeasedImageExportJob, output_id: str) -> None: ...
    def complete_export_output(
        self, lease: LeasedImageExportJob, stored: StoredExportOutput
    ) -> None: ...
    def fail_export_output(
        self, lease: LeasedImageExportJob, output_id: str, *, code: str, message: str
    ) -> None: ...
    def checkpoint_image_export(
        self, lease: LeasedImageExportJob, key: str, payload: dict[str, Any]
    ) -> None: ...
    def finish_image_export(self, lease: LeasedImageExportJob) -> str: ...
    def fail_image_export(
        self, lease: LeasedImageExportJob, *, code: str, message: str, retryable: bool
    ) -> str: ...
    def claim_export_bundle(
        self, *, job_id: str, worker_id: str, lease_token: str, trace_id: str
    ) -> LeasedExportBundleJob | None: ...
    def start_export_bundle(self, lease: LeasedExportBundleJob) -> None: ...
    def heartbeat_export_bundle(self, lease: LeasedExportBundleJob) -> None: ...
    def cancellation_requested_export_bundle(self, lease: LeasedExportBundleJob) -> bool: ...
    def complete_export_bundle(
        self, lease: LeasedExportBundleJob, stored: StoredExportBundle
    ) -> None: ...
    def fail_export_bundle(
        self, lease: LeasedExportBundleJob, *, code: str, message: str, retryable: bool
    ) -> str: ...


class DurableImageExportProcessor:
    def __init__(
        self,
        repository: ImageExportJobRepository,
        objects: PreviewPrivateObjectStore,
        *,
        worker_id: str,
        engine: DeterministicImageEngine | None = None,
    ) -> None:
        self._repository = repository
        self._objects = objects
        self._worker_id = worker_id
        self._engine = engine or DeterministicImageEngine()

    def process(self, message: DispatchMessage) -> WorkerOutcome:
        try:
            lease = self._repository.claim_image_export(
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
            self._repository.start_image_export(lease)
            self._cancel_guard(lease)
            assets = self._read_assets(lease)
            for target in lease.outputs:
                self._cancel_guard(lease)
                self._repository.start_export_output(lease, target.output_id)
                try:
                    rendered = self._engine.render(
                        snapshot=lease.snapshot,
                        artboard_id=target.artboard_id,
                        assets=assets,
                        operations=lease.operations,
                        profile=target.profile,
                    )
                    extension = {
                        "jpeg": "jpg",
                        "png": "png",
                        "webp": "webp",
                        "tiff": "tif",
                    }[str(target.profile["format"])]
                    key = (
                        f"derivative/{lease.workspace_id}/exports/"
                        f"{lease.export_request_id}/{target.output_id}/result.{extension}"
                    )
                    stored_snapshot = self._objects.write_derivative(
                        PrivateObjectRef(lease.workspace_id, key, ObjectZone.DERIVATIVE),
                        data=rendered.data,
                        media_type=rendered.media_type,
                        sha256=rendered.sha256,
                        max_bytes=MAX_OUTPUT_BYTES,
                    )
                    stored = StoredExportOutput(
                        target.output_id, key, stored_snapshot.generation, rendered
                    )
                    self._repository.complete_export_output(lease, stored)
                    self._repository.checkpoint_image_export(
                        lease,
                        f"output-{target.output_id}",
                        {"sha256": rendered.sha256, "byte_size": len(rendered.data)},
                    )
                except (ValueError, Image.DecompressionBombError) as error:
                    self._repository.fail_export_output(
                        lease,
                        target.output_id,
                        code="export-output-unsupported",
                        message=str(error),
                    )
            request_state = self._repository.finish_image_export(lease)
            return WorkerOutcome(
                "succeeded" if request_state in {"completed", "partially_completed"} else "failed",
                lease.job_id,
            )
        except ExportCancelledError:
            return WorkerOutcome("cancelled", lease.job_id)
        except (TimeoutError, ConnectionError, OSError) as error:
            state = self._repository.fail_image_export(
                lease,
                code="export-temporary-failure",
                message=str(error),
                retryable=True,
            )
            return WorkerOutcome(state, lease.job_id)
        except (ValueError, RuntimeError) as error:
            state = self._repository.fail_image_export(
                lease,
                code="export-source-integrity-failed",
                message=str(error),
                retryable=False,
            )
            return WorkerOutcome(state, lease.job_id)

    def _read_assets(self, lease: LeasedImageExportJob) -> dict[str, VerifiedRasterAsset]:
        assets: dict[str, VerifiedRasterAsset] = {}
        for source in lease.assets:
            snapshot = self._objects.read(
                PrivateObjectRef(lease.workspace_id, source.object_key, ObjectZone.IMMUTABLE),
                generation=source.storage_generation,
                max_bytes=MAX_COMPRESSED_SOURCE_BYTES,
            )
            if len(snapshot.data) != source.byte_size:
                raise ValueError("immutable source byte count changed")
            if hashlib.sha256(snapshot.data).hexdigest() != source.sha256:
                raise ValueError("immutable source checksum changed")
            assets[source.shared_asset_id] = VerifiedRasterAsset(
                shared_asset_id=source.shared_asset_id,
                source_version_id=source.source_version_id,
                sha256=source.sha256,
                media_type=source.media_type,
                byte_size=source.byte_size,
                width=source.width,
                height=source.height,
                data=snapshot.data,
            )
        return assets

    def _cancel_guard(self, lease: LeasedImageExportJob) -> None:
        self._repository.heartbeat_image_export(lease)
        if self._repository.cancellation_requested_image_export(lease):
            self._repository.fail_image_export(
                lease,
                code="export-cancelled",
                message="Image export was cancelled",
                retryable=False,
            )
            raise ExportCancelledError()


class DurableExportBundleProcessor:
    def __init__(
        self,
        repository: ImageExportJobRepository,
        objects: PreviewPrivateObjectStore,
        *,
        worker_id: str,
    ) -> None:
        self._repository = repository
        self._objects = objects
        self._worker_id = worker_id

    def process(self, message: DispatchMessage) -> WorkerOutcome:
        try:
            lease = self._repository.claim_export_bundle(
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
            self._repository.start_export_bundle(lease)
            self._cancel_guard(lease)
            stored = self._build(lease)
            snapshot = self._objects.write_derivative(
                PrivateObjectRef(lease.workspace_id, stored.object_key, ObjectZone.DERIVATIVE),
                data=stored.data,
                media_type="application/zip",
                sha256=stored.sha256,
                max_bytes=MAX_ZIP_BYTES,
            )
            self._repository.complete_export_bundle(
                lease,
                StoredExportBundle(
                    stored.object_key,
                    snapshot.generation,
                    stored.sha256,
                    stored.byte_size,
                    stored.data,
                ),
            )
            return WorkerOutcome("succeeded", lease.job_id)
        except ExportCancelledError:
            return WorkerOutcome("cancelled", lease.job_id)
        except (TimeoutError, ConnectionError, OSError) as error:
            state = self._repository.fail_export_bundle(
                lease,
                code="bundle-temporary-failure",
                message=str(error),
                retryable=True,
            )
            return WorkerOutcome(state, lease.job_id)
        except (ValueError, RuntimeError, zipfile.BadZipFile) as error:
            state = self._repository.fail_export_bundle(
                lease,
                code="bundle-integrity-failed",
                message=str(error),
                retryable=False,
            )
            return WorkerOutcome(state, lease.job_id)

    def _build(self, lease: LeasedExportBundleJob) -> StoredExportBundle:
        if not lease.items or len(lease.items) > MAX_ZIP_ITEMS:
            raise ValueError("ZIP item count exceeds the approved limit")
        names: set[str] = set()
        entries: list[tuple[BundleItem, bytes]] = []
        total = 0
        for item in sorted(lease.items, key=lambda value: (value.filename, value.output_id)):
            name = self._safe_name(item.filename)
            if name.casefold() in names:
                raise ValueError("ZIP filenames are not unique")
            names.add(name.casefold())
            snapshot = self._objects.read(
                PrivateObjectRef(lease.workspace_id, item.object_key, ObjectZone.DERIVATIVE),
                generation=item.storage_generation,
                max_bytes=MAX_OUTPUT_BYTES,
            )
            if len(snapshot.data) != item.byte_size:
                raise ValueError("ZIP source byte count changed")
            if hashlib.sha256(snapshot.data).hexdigest() != item.sha256:
                raise ValueError("ZIP source checksum changed")
            total += len(snapshot.data)
            if total > MAX_ZIP_BYTES:
                raise ValueError("ZIP source bytes exceed the approved limit")
            entries.append((item, snapshot.data))
        manifest = {
            "schema_version": "1.18.0",
            "bundle_id": lease.bundle_id,
            "export_request_id": lease.export_request_id,
            "expires_at": lease.expires_at,
            "items": [
                {
                    "output_id": item.output_id,
                    "filename": item.filename,
                    "sha256": item.sha256,
                    "byte_size": item.byte_size,
                    "media_type": item.media_type,
                }
                for item, _ in entries
            ],
        }
        output = io.BytesIO()
        with zipfile.ZipFile(
            output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6
        ) as archive:
            for item, data in entries:
                archive.writestr(self._info(self._safe_name(item.filename)), data)
            archive.writestr(
                self._info("manifest.json"),
                json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode(),
            )
        data = output.getvalue()
        if not data or len(data) > MAX_ZIP_BYTES:
            raise ValueError("ZIP output exceeds the approved limit")
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            archive_names = archive.namelist()
            if archive_names[-1] != "manifest.json" or len(archive_names) != len(entries) + 1:
                raise ValueError("ZIP verification failed")
            if any(info.file_size > MAX_OUTPUT_BYTES for info in archive.infolist()):
                raise ValueError("ZIP entry exceeds the approved limit")
        digest = hashlib.sha256(data).hexdigest()
        return StoredExportBundle(
            object_key=(
                f"derivative/{lease.workspace_id}/exports/"
                f"{lease.export_request_id}/bundles/{lease.bundle_id}.zip"
            ),
            storage_generation=digest,
            sha256=digest,
            byte_size=len(data),
            data=data,
        )

    def _cancel_guard(self, lease: LeasedExportBundleJob) -> None:
        self._repository.heartbeat_export_bundle(lease)
        if self._repository.cancellation_requested_export_bundle(lease):
            self._repository.fail_export_bundle(
                lease,
                code="bundle-cancelled",
                message="ZIP preparation was cancelled",
                retryable=False,
            )
            raise ExportCancelledError()

    @staticmethod
    def _safe_name(value: str) -> str:
        if (
            not value
            or len(value) > 240
            or "/" in value
            or "\\" in value
            or value in {".", ".."}
            or any(ord(character) < 32 for character in value)
        ):
            raise ValueError("ZIP filename is unsafe")
        return value

    @staticmethod
    def _info(filename: str) -> zipfile.ZipInfo:
        info = zipfile.ZipInfo(filename, date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o600 << 16
        info.create_system = 3
        return info


class ExportCancelledError(RuntimeError):
    pass
