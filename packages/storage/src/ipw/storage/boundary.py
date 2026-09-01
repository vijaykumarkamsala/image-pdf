"""Storage protocols shared by production services and workers."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import BinaryIO, Protocol

from ipw.contracts.product import StorageObjectRef, TraceContext


@dataclass(frozen=True)
class StoredObject:
    """Bytes fetched with their immutable storage reference."""

    ref: StorageObjectRef
    data: bytes


class ObjectZone(StrEnum):
    """Private lifecycle zone; neither value implies public readability."""

    QUARANTINE = "quarantine"
    IMMUTABLE = "immutable"
    DERIVATIVE = "derivative"


@dataclass(frozen=True)
class PrivateObjectRef:
    """Internal object locator which must never cross the customer API boundary."""

    owner_scope: str
    object_key: str
    zone: ObjectZone


@dataclass(frozen=True)
class UploadWriteResult:
    """Observed write position returned by a resumable private upload."""

    ref: PrivateObjectRef
    bytes_received: int


class ObjectReader(Protocol):
    """Read object bytes through an authorised boundary."""

    def read(self, ref: StorageObjectRef, trace: TraceContext) -> StoredObject: ...


class ObjectWriter(Protocol):
    """Write derivative bytes and return a storage reference."""

    def write(
        self,
        *,
        object_name: str,
        data: bytes,
        media_type: str,
        trace: TraceContext,
    ) -> StorageObjectRef: ...


class QuarantineStore(Protocol):
    """Private, resumable storage used before any source is trusted."""

    def create(self, *, owner_scope: str, object_key: str) -> PrivateObjectRef: ...

    def append(
        self,
        ref: PrivateObjectRef,
        stream: BinaryIO,
        *,
        expected_offset: int,
        max_bytes: int,
    ) -> UploadWriteResult: ...

    def delete(self, ref: PrivateObjectRef) -> None: ...


class ImmutableOriginalStore(Protocol):
    """Promote a verified quarantine object without overwriting existing bytes."""

    def promote(
        self,
        source: PrivateObjectRef,
        *,
        owner_scope: str,
        sha256: str,
    ) -> PrivateObjectRef: ...
