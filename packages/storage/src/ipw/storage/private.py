"""Executable private-object adapters for production intake workers."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from google.api_core.exceptions import PreconditionFailed
from google.cloud import storage

from ipw.storage.boundary import ObjectZone, PrivateObjectRef


@dataclass(frozen=True)
class PrivateObjectSnapshot:
    ref: PrivateObjectRef
    generation: str
    media_type: str
    data: bytes


class WorkerObjectReader(Protocol):
    def read(
        self,
        ref: PrivateObjectRef,
        *,
        generation: str,
        max_bytes: int,
    ) -> PrivateObjectSnapshot: ...


class IntakePrivateObjectStore(WorkerObjectReader, Protocol):
    def promote(
        self,
        source: PrivateObjectRef,
        *,
        source_generation: str,
        sha256: str,
        max_bytes: int,
    ) -> PrivateObjectRef: ...

    def delete(self, ref: PrivateObjectRef, *, generation: str | None = None) -> None: ...


class PreviewPrivateObjectStore(WorkerObjectReader, Protocol):
    def write_derivative(
        self,
        ref: PrivateObjectRef,
        *,
        data: bytes,
        media_type: str,
        sha256: str,
    ) -> PrivateObjectSnapshot: ...


class WorkerPrivateObjectStore(IntakePrivateObjectStore, PreviewPrivateObjectStore, Protocol):
    """Complete worker storage capability implemented by production adapters."""


def _immutable_key(owner_scope: str, sha256: str) -> str:
    if not sha256 or len(sha256) != 64 or any(char not in "0123456789abcdef" for char in sha256):
        raise ValueError("invalid SHA-256")
    return f"immutable/{owner_scope}/{sha256}"


class GcsWorkerPrivateObjectStore:
    """ADC-backed GCS adapter with generation-bound reads and no-overwrite promotion."""

    def __init__(self, bucket: str, client: Any | None = None) -> None:
        if not bucket or len(bucket) > 222:
            raise ValueError("invalid private GCS bucket")
        self._client = client or storage.Client()
        self._bucket = self._client.bucket(bucket)

    def read(
        self,
        ref: PrivateObjectRef,
        *,
        generation: str,
        max_bytes: int,
    ) -> PrivateObjectSnapshot:
        requested_generation = int(generation) if generation else None
        blob = self._bucket.blob(ref.object_key, generation=requested_generation)
        blob.reload(if_generation_match=requested_generation, timeout=30)
        if blob.size is None or blob.size > max_bytes:
            raise ValueError("private object exceeds its authorised read limit")
        data = blob.download_as_bytes(
            if_generation_match=int(blob.generation),
            checksum="crc32c",
            timeout=60,
        )
        if len(data) != blob.size:
            raise RuntimeError("private object changed during read")
        return PrivateObjectSnapshot(
            ref=ref,
            generation=str(blob.generation),
            media_type=blob.content_type or "application/octet-stream",
            data=data,
        )

    def promote(
        self,
        source: PrivateObjectRef,
        *,
        source_generation: str,
        sha256: str,
        max_bytes: int,
    ) -> PrivateObjectRef:
        target_key = _immutable_key(source.owner_scope, sha256)
        source_blob = self._bucket.blob(source.object_key, generation=int(source_generation))
        try:
            target = self._bucket.copy_blob(
                source_blob,
                self._bucket,
                target_key,
                if_generation_match=0,
                if_source_generation_match=int(source_generation),
                timeout=60,
            )
            target.metadata = {
                **(target.metadata or {}),
                "ipw-sha256": sha256,
                "ipw-zone": "immutable",
            }
            target.patch(if_generation_match=target.generation, timeout=30)
        except PreconditionFailed:
            target = self._bucket.blob(target_key)
            target.reload(timeout=30)
            if target.size is None or target.size > max_bytes:
                raise RuntimeError("existing immutable object has invalid size") from None
            existing = target.download_as_bytes(
                if_generation_match=target.generation,
                checksum="crc32c",
                timeout=60,
            )
            if hashlib.sha256(existing).hexdigest() != sha256:
                raise RuntimeError("immutable object collision") from None
        return PrivateObjectRef(
            source.owner_scope, target_key, ObjectZone.IMMUTABLE, str(target.generation)
        )

    def delete(self, ref: PrivateObjectRef, *, generation: str | None = None) -> None:
        blob = self._bucket.blob(ref.object_key, generation=int(generation) if generation else None)
        blob.delete(if_generation_match=int(generation) if generation else None, timeout=30)

    def write_derivative(
        self,
        ref: PrivateObjectRef,
        *,
        data: bytes,
        media_type: str,
        sha256: str,
    ) -> PrivateObjectSnapshot:
        _validate_derivative(ref, data, sha256)
        blob = self._bucket.blob(ref.object_key)
        try:
            blob.upload_from_string(
                data,
                content_type=media_type,
                if_generation_match=0,
                checksum="crc32c",
                timeout=60,
            )
            blob.metadata = {"ipw-sha256": sha256, "ipw-zone": "derivative"}
            blob.patch(if_generation_match=blob.generation, timeout=30)
        except PreconditionFailed:
            blob.reload(timeout=30)
            existing = blob.download_as_bytes(
                if_generation_match=blob.generation,
                checksum="crc32c",
                timeout=60,
            )
            if hashlib.sha256(existing).hexdigest() != sha256:
                raise RuntimeError("derivative object collision") from None
            data = existing
        return PrivateObjectSnapshot(ref, str(blob.generation), media_type, data)


class LocalWorkerPrivateObjectStore:
    """Explicit development/test adapter constrained below one private root."""

    def __init__(self, root: Path) -> None:
        self._root = root.resolve()

    def read(
        self,
        ref: PrivateObjectRef,
        *,
        generation: str,
        max_bytes: int,
    ) -> PrivateObjectSnapshot:
        path = self._path(ref)
        data = path.read_bytes()
        if len(data) > max_bytes:
            raise ValueError("private object exceeds its authorised read limit")
        digest = hashlib.sha256(data).hexdigest()
        if generation and generation != digest:
            raise RuntimeError("local object generation changed")
        return PrivateObjectSnapshot(ref, digest, "application/octet-stream", data)

    def promote(
        self,
        source: PrivateObjectRef,
        *,
        source_generation: str,
        sha256: str,
        max_bytes: int,
    ) -> PrivateObjectRef:
        snapshot = self.read(source, generation=source_generation, max_bytes=max_bytes)
        if hashlib.sha256(snapshot.data).hexdigest() != sha256:
            raise RuntimeError("promotion digest mismatch")
        target = PrivateObjectRef(
            source.owner_scope,
            _immutable_key(source.owner_scope, sha256),
            ObjectZone.IMMUTABLE,
            sha256,
        )
        path = self._path(target)
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() != sha256:
            raise RuntimeError("immutable object collision")
        if not path.exists():
            path.write_bytes(snapshot.data)
        return target

    def delete(self, ref: PrivateObjectRef, *, generation: str | None = None) -> None:
        path = self._path(ref)
        if (
            generation
            and path.exists()
            and hashlib.sha256(path.read_bytes()).hexdigest() != generation
        ):
            raise RuntimeError("local object generation changed")
        path.unlink(missing_ok=True)

    def write_derivative(
        self,
        ref: PrivateObjectRef,
        *,
        data: bytes,
        media_type: str,
        sha256: str,
    ) -> PrivateObjectSnapshot:
        _validate_derivative(ref, data, sha256)
        path = self._path(ref)
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            existing = path.read_bytes()
            if hashlib.sha256(existing).hexdigest() != sha256:
                raise RuntimeError("derivative object collision")
            data = existing
        else:
            path.write_bytes(data)
        return PrivateObjectSnapshot(ref, sha256, media_type, data)

    def _path(self, ref: PrivateObjectRef) -> Path:
        if ".." in ref.object_key.split("/") or not ref.object_key.startswith(
            ("quarantine/", "immutable/", "derivative/")
        ):
            raise ValueError("invalid private object key")
        path = (self._root / ref.object_key).resolve()
        if self._root not in path.parents:
            raise ValueError("private object path escaped storage root")
        return path


def _validate_derivative(ref: PrivateObjectRef, data: bytes, sha256: str) -> None:
    if ref.zone is not ObjectZone.DERIVATIVE or not ref.object_key.startswith(
        f"derivative/{ref.owner_scope}/"
    ):
        raise ValueError("invalid derivative object reference")
    if len(data) > 16 * 1024 * 1024:
        raise ValueError("derivative exceeds the bounded object limit")
    if hashlib.sha256(data).hexdigest() != sha256:
        raise ValueError("derivative digest mismatch")
