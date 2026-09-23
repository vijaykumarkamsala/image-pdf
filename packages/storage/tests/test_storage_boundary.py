from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

import pytest
from google.api_core.exceptions import NotFound, PreconditionFailed

from ipw.contracts.product import StorageObjectRef, TraceContext
from ipw.storage import (
    GcsWorkerPrivateObjectStore,
    LocalWorkerPrivateObjectStore,
    ObjectZone,
    PrivateObjectRef,
    StoredObject,
    UploadWriteResult,
)


class FakeBlob:
    def __init__(self, key: str, data: bytes = b"payload", generation: int = 17) -> None:
        self.key = key
        self.data = data
        self.size: int | None = len(data)
        self.generation = generation
        self.content_type: str | None = "image/png"
        self.metadata: dict[str, str] | None = None
        self.requested_generation: int | None = None
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.fail_upload = False
        self.fail_delete_not_found = False

    def reload(self, **kwargs: Any) -> None:
        self.calls.append(("reload", kwargs))

    def download_as_bytes(self, **kwargs: Any) -> bytes:
        self.calls.append(("download", kwargs))
        return self.data

    def download_to_filename(self, filename: str, **kwargs: Any) -> None:
        self.calls.append(("download-file", kwargs))
        Path(filename).write_bytes(self.data)

    def patch(self, **kwargs: Any) -> None:
        self.calls.append(("patch", kwargs))

    def delete(self, **kwargs: Any) -> None:
        self.calls.append(("delete", kwargs))
        if self.fail_delete_not_found:
            raise NotFound("already removed")  # type: ignore[no-untyped-call]

    def upload_from_string(self, data: bytes, **kwargs: Any) -> None:
        self.calls.append(("upload", kwargs))
        if self.fail_upload:
            raise PreconditionFailed("already exists")  # type: ignore[no-untyped-call]
        self.data = data
        self.size = len(data)
        self.generation = 29
        self.content_type = kwargs.get("content_type")

    def upload_from_filename(self, filename: str, **kwargs: Any) -> None:
        self.calls.append(("upload-file", kwargs))
        if self.fail_upload:
            raise PreconditionFailed("already exists")  # type: ignore[no-untyped-call]
        self.data = Path(filename).read_bytes()
        self.size = len(self.data)
        self.generation = 31
        self.content_type = kwargs.get("content_type")


class FakeBucket:
    def __init__(self) -> None:
        self.blobs: dict[str, FakeBlob] = {}
        self.fail_copy = False
        self.copy_kwargs: dict[str, Any] | None = None

    def blob(self, key: str, generation: int | None = None) -> FakeBlob:
        blob = self.blobs.setdefault(key, FakeBlob(key))
        blob.requested_generation = generation
        return blob

    def copy_blob(
        self,
        source: FakeBlob,
        _target_bucket: FakeBucket,
        target_key: str,
        **kwargs: Any,
    ) -> FakeBlob:
        self.copy_kwargs = kwargs
        if self.fail_copy:
            raise PreconditionFailed("already exists")  # type: ignore[no-untyped-call]
        target = FakeBlob(target_key, source.data, generation=23)
        self.blobs[target_key] = target
        return target


class FakeClient:
    def __init__(self) -> None:
        self.private_bucket = FakeBucket()
        self.bucket_name: str | None = None

    def bucket(self, name: str) -> FakeBucket:
        self.bucket_name = name
        return self.private_bucket


def test_stored_object_keeps_bytes_outside_metadata_contract() -> None:
    ref = StorageObjectRef(
        storage_id="primary-store",
        object_name="originals/a.png",
        sha256="1" * 64,
        media_type="image/png",
        byte_size=3,
    )
    stored = StoredObject(ref=ref, data=b"abc")

    assert stored.ref.object_name == "originals/a.png"
    assert stored.data == b"abc"
    assert TraceContext(trace_id="trace-001").trace_id == "trace-001"


def test_private_object_reference_does_not_claim_public_access() -> None:
    ref = PrivateObjectRef(
        owner_scope="workspace-001",
        object_key="quarantine/workspace-001/upload-001",
        zone=ObjectZone.QUARANTINE,
    )
    result = UploadWriteResult(ref=ref, bytes_received=128)

    assert result.ref.zone == ObjectZone.QUARANTINE
    assert not hasattr(result.ref, "url")


def test_gcs_worker_read_is_generation_bound_and_size_limited() -> None:
    client = FakeClient()
    source = PrivateObjectRef(
        "workspace-001", "quarantine/workspace-001/upload-001", ObjectZone.QUARANTINE
    )
    blob = FakeBlob(source.object_key, b"safe bytes")
    client.private_bucket.blobs[source.object_key] = blob
    store = GcsWorkerPrivateObjectStore("private-bucket", client)

    snapshot = store.read(source, generation="17", max_bytes=100)

    assert client.bucket_name == "private-bucket"
    assert snapshot.data == b"safe bytes"
    assert snapshot.generation == "17"
    assert blob.requested_generation == 17
    assert blob.calls == [
        ("reload", {"if_generation_match": 17, "timeout": 30}),
        ("download", {"if_generation_match": 17, "checksum": "crc32c", "timeout": 60}),
    ]

    blob.size = 101
    with pytest.raises(ValueError, match="authorised read limit"):
        store.read(source, generation="17", max_bytes=100)
    blob.size = len(blob.data) + 1
    with pytest.raises(RuntimeError, match="changed during read"):
        store.read(source, generation="17", max_bytes=100)


def test_gcs_worker_promotion_is_conditional_idempotent_and_private() -> None:
    client = FakeClient()
    source = PrivateObjectRef(
        "workspace-001", "quarantine/workspace-001/upload-001", ObjectZone.QUARANTINE
    )
    data = b"verified original"
    digest = hashlib.sha256(data).hexdigest()
    client.private_bucket.blobs[source.object_key] = FakeBlob(source.object_key, data)
    store = GcsWorkerPrivateObjectStore("private-bucket", client)

    target = store.promote(source, source_generation="17", sha256=digest, max_bytes=100)

    assert target == PrivateObjectRef(
        "workspace-001", f"immutable/workspace-001/{digest}", ObjectZone.IMMUTABLE, "23"
    )
    assert client.private_bucket.copy_kwargs == {
        "if_generation_match": 0,
        "if_source_generation_match": 17,
        "timeout": 60,
    }
    target_blob = client.private_bucket.blobs[target.object_key]
    assert target_blob.metadata == {"ipw-sha256": digest, "ipw-zone": "immutable"}
    assert target_blob.calls == [("patch", {"if_generation_match": 23, "timeout": 30})]

    client.private_bucket.fail_copy = True
    assert store.promote(source, source_generation="17", sha256=digest, max_bytes=100) == target
    target_blob.size = 101
    with pytest.raises(RuntimeError, match="invalid size"):
        store.promote(source, source_generation="17", sha256=digest, max_bytes=100)
    target_blob.size = len(data)
    target_blob.data = b"different"
    with pytest.raises(RuntimeError, match="collision"):
        store.promote(source, source_generation="17", sha256=digest, max_bytes=100)

    store.delete(source, generation="17")
    assert client.private_bucket.blobs[source.object_key].calls[-1] == (
        "delete",
        {"if_generation_match": 17, "timeout": 30},
    )
    store.delete(source)
    assert client.private_bucket.blobs[source.object_key].calls[-1] == (
        "delete",
        {"if_generation_match": None, "timeout": 30},
    )
    blob = client.private_bucket.blobs[source.object_key]
    blob.fail_delete_not_found = True
    store.delete(source, generation="17")


def test_gcs_worker_derivative_write_is_conditional_and_idempotent() -> None:
    client = FakeClient()
    store = GcsWorkerPrivateObjectStore("private-bucket", client)
    data = b"preview-png"
    digest = hashlib.sha256(data).hexdigest()
    ref = PrivateObjectRef(
        "workspace-001",
        "derivative/workspace-001/source-001/job-001/workspace.png",
        ObjectZone.DERIVATIVE,
    )

    first = store.write_derivative(ref, data=data, media_type="image/png", sha256=digest)

    blob = client.private_bucket.blobs[ref.object_key]
    assert first.data == data
    assert first.generation == "29"
    assert blob.metadata == {"ipw-sha256": digest, "ipw-zone": "derivative"}
    assert blob.calls[0] == (
        "upload",
        {
            "content_type": "image/png",
            "if_generation_match": 0,
            "checksum": "crc32c",
            "timeout": 60,
        },
    )
    blob.fail_upload = True
    second = store.write_derivative(ref, data=data, media_type="image/png", sha256=digest)
    assert second.data == data
    blob.data = b"collision"
    with pytest.raises(RuntimeError, match="collision"):
        store.write_derivative(ref, data=data, media_type="image/png", sha256=digest)


def test_gcs_worker_streams_generation_bound_sources_and_file_derivatives(
    tmp_path: Path,
) -> None:
    client = FakeClient()
    source_data = b"large-source" * 8192
    source = PrivateObjectRef(
        "workspace-large",
        "immutable/workspace-large/source-digest",
        ObjectZone.IMMUTABLE,
    )
    source_blob = FakeBlob(source.object_key, source_data, generation=41)
    client.private_bucket.blobs[source.object_key] = source_blob
    store = GcsWorkerPrivateObjectStore("private-bucket", client)

    destination = tmp_path / "scratch" / "source.image"
    materialized = store.materialize(
        source,
        generation="41",
        destination=destination,
        max_bytes=len(source_data),
    )

    assert materialized.path == destination
    assert materialized.byte_size == len(source_data)
    assert materialized.sha256 == hashlib.sha256(source_data).hexdigest()
    assert source_blob.requested_generation == 41
    assert source_blob.calls == [
        ("reload", {"if_generation_match": 41, "timeout": 30}),
        (
            "download-file",
            {"if_generation_match": 41, "checksum": "crc32c", "timeout": 900},
        ),
    ]

    output = tmp_path / "scratch" / "result.png"
    output_data = b"large-output" * 16_384
    output.write_bytes(output_data)
    output_digest = hashlib.sha256(output_data).hexdigest()
    derivative = PrivateObjectRef(
        "workspace-large",
        "derivative/workspace-large/image-quality/request/result.png",
        ObjectZone.DERIVATIVE,
    )
    stored = store.write_derivative_file(
        derivative,
        source=output,
        media_type="image/png",
        sha256=output_digest,
        max_bytes=len(output_data),
    )

    output_blob = client.private_bucket.blobs[derivative.object_key]
    assert stored.data == b""
    assert stored.generation == "31"
    assert output_blob.data == output_data
    assert output_blob.calls == [
        (
            "upload-file",
            {
                "content_type": "image/png",
                "if_generation_match": 0,
                "checksum": "crc32c",
                "timeout": 900,
            },
        ),
        ("patch", {"if_generation_match": 31, "timeout": 30}),
    ]


def test_worker_storage_rejects_invalid_configuration_and_digest() -> None:
    with pytest.raises(ValueError, match="invalid private GCS bucket"):
        GcsWorkerPrivateObjectStore("", FakeClient())
    source = PrivateObjectRef(
        "workspace-001", "quarantine/workspace-001/upload-001", ObjectZone.QUARANTINE
    )
    with pytest.raises(ValueError, match="invalid SHA-256"):
        GcsWorkerPrivateObjectStore("private-bucket", FakeClient()).promote(
            source,
            source_generation="17",
            sha256="not-a-digest",
            max_bytes=100,
        )


def test_local_worker_storage_preserves_generation_and_no_overwrite(tmp_path: Path) -> None:
    store = LocalWorkerPrivateObjectStore(tmp_path)
    source = PrivateObjectRef(
        "workspace-001", "quarantine/workspace-001/upload-001", ObjectZone.QUARANTINE
    )
    source_path = tmp_path / source.object_key
    source_path.parent.mkdir(parents=True)
    source_path.write_bytes(b"local original")
    digest = hashlib.sha256(b"local original").hexdigest()

    assert store.read(source, generation=digest, max_bytes=100).data == b"local original"
    with pytest.raises(ValueError, match="authorised read limit"):
        store.read(source, generation=digest, max_bytes=1)
    with pytest.raises(RuntimeError, match="generation changed"):
        store.read(source, generation="0" * 64, max_bytes=100)
    with pytest.raises(RuntimeError, match="promotion digest mismatch"):
        store.promote(source, source_generation=digest, sha256="0" * 64, max_bytes=100)

    target = store.promote(source, source_generation=digest, sha256=digest, max_bytes=100)
    assert target.generation == digest
    assert (tmp_path / target.object_key).read_bytes() == b"local original"
    assert store.promote(source, source_generation=digest, sha256=digest, max_bytes=100) == target
    (tmp_path / target.object_key).write_bytes(b"collision")
    with pytest.raises(RuntimeError, match="collision"):
        store.promote(source, source_generation=digest, sha256=digest, max_bytes=100)

    with pytest.raises(RuntimeError, match="generation changed"):
        store.delete(source, generation="0" * 64)
    store.delete(source, generation=digest)
    assert not source_path.exists()
    store.delete(source)

    invalid = PrivateObjectRef("workspace-001", "../outside", ObjectZone.QUARANTINE)
    with pytest.raises(ValueError, match="invalid private object key"):
        store.read(invalid, generation=digest, max_bytes=100)


def test_local_worker_storage_writes_digest_bound_derivatives(tmp_path: Path) -> None:
    store = LocalWorkerPrivateObjectStore(tmp_path)
    data = b"bounded-preview"
    digest = hashlib.sha256(data).hexdigest()
    ref = PrivateObjectRef(
        "workspace-preview",
        "derivative/workspace-preview/source-preview/job-preview/workspace.png",
        ObjectZone.DERIVATIVE,
    )

    first = store.write_derivative(ref, data=data, media_type="image/png", sha256=digest)
    second = store.write_derivative(ref, data=data, media_type="image/png", sha256=digest)

    assert first.data == second.data == data
    assert first.generation == second.generation == digest
    different = b"different-preview"
    with pytest.raises(RuntimeError, match="collision"):
        store.write_derivative(
            ref,
            data=different,
            media_type="image/png",
            sha256=hashlib.sha256(different).hexdigest(),
        )


def test_local_worker_storage_streams_large_sources_and_derivatives(tmp_path: Path) -> None:
    store = LocalWorkerPrivateObjectStore(tmp_path / "objects")
    source = PrivateObjectRef(
        "workspace-large",
        "immutable/workspace-large/source-digest",
        ObjectZone.IMMUTABLE,
    )
    source_path = tmp_path / "objects" / source.object_key
    source_path.parent.mkdir(parents=True)
    source_path.write_bytes(b"large-source" * 1024)
    digest = hashlib.sha256(source_path.read_bytes()).hexdigest()
    materialized = store.materialize(
        source,
        generation=digest,
        destination=tmp_path / "scratch" / "source.bin",
        max_bytes=32 * 1024,
    )
    assert materialized.byte_size == source_path.stat().st_size
    assert materialized.sha256 == digest
    assert materialized.path.read_bytes() == source_path.read_bytes()

    output = tmp_path / "scratch" / "result.png"
    output.write_bytes(b"large-output" * 2048)
    output_digest = hashlib.sha256(output.read_bytes()).hexdigest()
    derivative = PrivateObjectRef(
        "workspace-large",
        "derivative/workspace-large/image-quality/request/result.png",
        ObjectZone.DERIVATIVE,
    )
    stored = store.write_derivative_file(
        derivative,
        source=output,
        media_type="image/png",
        sha256=output_digest,
        max_bytes=64 * 1024,
    )
    assert stored.data == b""
    assert stored.generation == output_digest
    assert (tmp_path / "objects" / derivative.object_key).read_bytes() == output.read_bytes()
