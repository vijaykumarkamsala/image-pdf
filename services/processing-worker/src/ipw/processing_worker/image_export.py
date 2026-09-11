"""Durable full-resolution image exports and deterministic ZIP bundles."""

from __future__ import annotations

import hashlib
import io
import json
import secrets
import tempfile
import threading
import unicodedata
import zipfile
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

from PIL import Image

from ipw.contracts import PRODUCT_SCHEMA_VERSION
from ipw.processing_worker.durable_intake import DispatchMessage, WorkerOutcome
from ipw.processing_worker.enhancement_engine import (
    MAX_COMPRESSED_SOURCE_BYTES,
    MAX_OUTPUT_BYTES,
    DeterministicImageEngine,
    ProcessingBudget,
    ProcessingLimits,
    RenderedImage,
    VerifiedRasterAsset,
)
from ipw.processing_worker.repository import JobBusyError
from ipw.storage import ObjectZone, PreviewPrivateObjectStore, PrivateObjectRef

MAX_ZIP_BYTES = 128 * 1024 * 1024
MAX_ZIP_EXPANDED_BYTES = 96 * 1024 * 1024
MAX_ZIP_ITEMS = 64
MAX_ZIP_COMPRESSION_RATIO = 100
ZIP_CHUNK_BYTES = 1024 * 1024
WINDOWS_RESERVED_NAMES = {
    "aux",
    "clock$",
    "con",
    "nul",
    "prn",
    *(f"com{value}" for value in range(1, 10)),
    *(f"lpt{value}" for value in range(1, 10)),
}


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
    orientation: int | None = None
    bit_depth: int | None = None
    frame_count: int | None = None
    has_icc_profile: bool | None = None
    colour_model: str | None = None


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
        execution_lock: threading.Lock | None = None,
        budget_factory: Callable[[Callable[[str], None]], ProcessingBudget] | None = None,
    ) -> None:
        self._repository = repository
        self._objects = objects
        self._worker_id = worker_id
        self._engine = engine or DeterministicImageEngine()
        self._execution_lock = execution_lock or threading.Lock()
        self._budget_factory = budget_factory or (
            lambda checkpoint: ProcessingBudget(checkpoint=checkpoint)
        )

    def process(self, message: DispatchMessage) -> WorkerOutcome:
        with self._execution_lock:
            return self._process_locked(message)

    def _process_locked(self, message: DispatchMessage) -> WorkerOutcome:
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
            budget = self._budget_factory(lambda _stage: self._cancel_guard(lease))
            self._repository.start_image_export(lease)
            budget.check("job-start")
            assets = self._read_assets(lease, budget)
            for target in lease.outputs:
                budget.check(f"output-start:{target.output_id}")
                self._repository.start_export_output(lease, target.output_id)
                try:
                    rendered = self._engine.render(
                        snapshot=lease.snapshot,
                        artboard_id=target.artboard_id,
                        assets=assets,
                        operations=lease.operations,
                        profile=target.profile,
                        budget=budget,
                    )
                    self._cancel_guard(lease)
                    extension = {
                        "jpeg": "jpg",
                        "png": "png",
                        "webp": "webp",
                        "tiff": "tif",
                    }[str(target.profile["format"])]
                    key = (
                        f"derivative/{lease.workspace_id}/exports/"
                        f"{lease.export_request_id}/{target.output_id}/"
                        f"attempt-{lease.attempt}-{lease.lease_token_hash[:12]}/result.{extension}"
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
                    try:
                        self._cancel_guard(lease)
                        self._repository.complete_export_output(lease, stored)
                    except Exception:
                        self._objects.delete(
                            PrivateObjectRef(lease.workspace_id, key, ObjectZone.DERIVATIVE),
                            generation=stored_snapshot.generation,
                        )
                        raise
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
        except JobBusyError:
            return WorkerOutcome("busy", lease.job_id)
        except TimeoutError as error:
            state = self._repository.fail_image_export(
                lease,
                code="export-resource-timeout",
                message=str(error),
                retryable=False,
            )
            return WorkerOutcome(state, lease.job_id)
        except MemoryError as error:
            state = self._repository.fail_image_export(
                lease,
                code="export-resource-memory",
                message=str(error),
                retryable=False,
            )
            return WorkerOutcome(state, lease.job_id)
        except (ConnectionError, OSError) as error:
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

    def _read_assets(
        self, lease: LeasedImageExportJob, budget: ProcessingBudget
    ) -> dict[str, VerifiedRasterAsset]:
        assets: dict[str, VerifiedRasterAsset] = {}
        for source in lease.assets:
            budget.check(f"source-read-start:{source.shared_asset_id}")
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
                orientation=source.orientation,
                bit_depth=source.bit_depth,
                frame_count=source.frame_count,
                has_icc_profile=source.has_icc_profile,
                colour_model=source.colour_model,
            )
            budget.check(f"source-read-complete:{source.shared_asset_id}")
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
        execution_lock: threading.Lock | None = None,
    ) -> None:
        self._repository = repository
        self._objects = objects
        self._worker_id = worker_id
        self._execution_lock = execution_lock or threading.Lock()

    def process(self, message: DispatchMessage) -> WorkerOutcome:
        with self._execution_lock:
            return self._process_locked(message)

    def _process_locked(self, message: DispatchMessage) -> WorkerOutcome:
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
            budget = ProcessingBudget(
                ProcessingLimits(max_seconds=90),
                checkpoint=lambda _stage: self._cancel_guard(lease),
            )
            stored = self._build(lease, budget)
            budget.check("bundle-write")
            snapshot = self._objects.write_derivative(
                PrivateObjectRef(lease.workspace_id, stored.object_key, ObjectZone.DERIVATIVE),
                data=stored.data,
                media_type="application/zip",
                sha256=stored.sha256,
                max_bytes=MAX_ZIP_BYTES,
            )
            try:
                self._cancel_guard(lease)
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
            except Exception:
                self._objects.delete(
                    PrivateObjectRef(lease.workspace_id, stored.object_key, ObjectZone.DERIVATIVE),
                    generation=snapshot.generation,
                )
                raise
            return WorkerOutcome("succeeded", lease.job_id)
        except ExportCancelledError:
            return WorkerOutcome("cancelled", lease.job_id)
        except JobBusyError:
            return WorkerOutcome("busy", lease.job_id)
        except TimeoutError as error:
            state = self._repository.fail_export_bundle(
                lease,
                code="bundle-resource-timeout",
                message=str(error),
                retryable=False,
            )
            return WorkerOutcome(state, lease.job_id)
        except MemoryError as error:
            state = self._repository.fail_export_bundle(
                lease,
                code="bundle-resource-memory",
                message=str(error),
                retryable=False,
            )
            return WorkerOutcome(state, lease.job_id)
        except (ConnectionError, OSError) as error:
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

    def _build(
        self, lease: LeasedExportBundleJob, budget: ProcessingBudget | None = None
    ) -> StoredExportBundle:
        active_budget = budget or ProcessingBudget(ProcessingLimits(max_seconds=90))
        if not lease.items or len(lease.items) > MAX_ZIP_ITEMS:
            raise ValueError("ZIP item count exceeds the approved limit")
        names: set[str] = set()
        entries: list[tuple[str, BundleItem]] = []
        total = sum(item.byte_size for item in lease.items)
        if total > MAX_ZIP_EXPANDED_BYTES:
            raise ValueError("ZIP source bytes exceed the approved expanded-size limit")
        for item in lease.items:
            name = self._safe_name(item.filename)
            collision_key = unicodedata.normalize("NFKC", name).casefold()
            if collision_key in names:
                raise ValueError(
                    "ZIP filenames collide after Unicode normalization and case folding"
                )
            names.add(collision_key)
            entries.append((name, item))
        entries.sort(
            key=lambda value: (
                unicodedata.normalize("NFKC", value[0]).casefold(),
                value[1].output_id,
            )
        )
        manifest = {
            "schema_version": PRODUCT_SCHEMA_VERSION,
            "bundle_id": lease.bundle_id,
            "export_request_id": lease.export_request_id,
            "expires_at": lease.expires_at,
            "items": [
                {
                    "output_id": item.output_id,
                    "filename": name,
                    "sha256": item.sha256,
                    "byte_size": item.byte_size,
                    "media_type": item.media_type,
                }
                for name, item in entries
            ],
        }
        with tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024) as output:
            with zipfile.ZipFile(
                output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6
            ) as archive:
                for name, item in entries:
                    active_budget.check(f"bundle-member:{item.output_id}")
                    snapshot = self._objects.read(
                        PrivateObjectRef(
                            lease.workspace_id, item.object_key, ObjectZone.DERIVATIVE
                        ),
                        generation=item.storage_generation,
                        max_bytes=MAX_OUTPUT_BYTES,
                    )
                    if len(snapshot.data) != item.byte_size:
                        raise ValueError("ZIP source byte count changed")
                    if hashlib.sha256(snapshot.data).hexdigest() != item.sha256:
                        raise ValueError("ZIP source checksum changed")
                    with archive.open(self._info(name), "w") as member:
                        for offset in range(0, len(snapshot.data), ZIP_CHUNK_BYTES):
                            active_budget.check(f"bundle-chunk:{item.output_id}")
                            member.write(snapshot.data[offset : offset + ZIP_CHUNK_BYTES])
                archive.writestr(
                    self._info("manifest.json"),
                    json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode(),
                )
            output.seek(0, io.SEEK_END)
            output_size = output.tell()
            if output_size < 1 or output_size > MAX_ZIP_BYTES:
                raise ValueError("ZIP output exceeds the approved limit")
            output.seek(0)
            data = output.read(MAX_ZIP_BYTES + 1)
        if not data or len(data) > MAX_ZIP_BYTES:
            raise ValueError("ZIP output exceeds the approved limit")
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            archive_names = archive.namelist()
            if archive_names[-1] != "manifest.json" or len(archive_names) != len(lease.items) + 1:
                raise ValueError("ZIP verification failed")
            expanded = 0
            expected = dict(entries)
            for info in archive.infolist():
                expanded += info.file_size
                if info.file_size > MAX_OUTPUT_BYTES:
                    raise ValueError("ZIP entry exceeds the approved limit")
                if (
                    info.filename != "manifest.json"
                    and info.file_size > 1024
                    and info.file_size / max(1, info.compress_size) > MAX_ZIP_COMPRESSION_RATIO
                ):
                    raise ValueError("ZIP compression ratio exceeds the approved limit")
                if info.filename != "manifest.json":
                    expected_item = expected.get(info.filename)
                    if expected_item is None:
                        raise ValueError("ZIP contains an undeclared entry")
                    member_digest = hashlib.sha256()
                    read_size = 0
                    with archive.open(info, "r") as member:
                        while chunk := member.read(ZIP_CHUNK_BYTES):
                            active_budget.check(f"bundle-verify:{expected_item.output_id}")
                            read_size += len(chunk)
                            if read_size > expected_item.byte_size:
                                raise ValueError("ZIP member exceeds its declared byte count")
                            member_digest.update(chunk)
                    if (
                        read_size != expected_item.byte_size
                        or member_digest.hexdigest() != expected_item.sha256
                    ):
                        raise ValueError("ZIP member failed checksum verification")
            if expanded > MAX_ZIP_EXPANDED_BYTES + 64 * 1024:
                raise ValueError("ZIP expanded bytes exceed the approved limit")
        bundle_sha256 = hashlib.sha256(data).hexdigest()
        return StoredExportBundle(
            object_key=(
                f"derivative/{lease.workspace_id}/exports/"
                f"{lease.export_request_id}/bundles/{lease.bundle_id}/"
                f"attempt-{lease.attempt}-{lease.lease_token_hash[:12]}.zip"
            ),
            storage_generation=bundle_sha256,
            sha256=bundle_sha256,
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
        normalized = unicodedata.normalize("NFC", value)
        compatibility = unicodedata.normalize("NFKC", normalized)
        stem = compatibility.rsplit(".", 1)[0].rstrip(" .").casefold()
        confusable_separators = {"\u2044", "\u2215", "\u29f8", "\ufe68"}
        if (
            not normalized
            or len(normalized.encode("utf-8")) > 240
            or "/" in value
            or "\\" in value
            or any(character in value for character in confusable_separators)
            or "/" in compatibility
            or "\\" in compatibility
            or ":" in compatibility
            or normalized in {".", ".."}
            or normalized.endswith((".", " "))
            or stem in WINDOWS_RESERVED_NAMES
            or any(unicodedata.category(character) in {"Cc", "Cf"} for character in normalized)
        ):
            raise ValueError("ZIP filename is unsafe")
        return normalized

    @staticmethod
    def _info(filename: str) -> zipfile.ZipInfo:
        info = zipfile.ZipInfo(filename, date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o600 << 16
        info.create_system = 3
        return info


class ExportCancelledError(RuntimeError):
    pass
