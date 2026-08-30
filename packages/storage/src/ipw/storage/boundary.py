"""Storage protocols shared by production services and workers."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from ipw.contracts.product import StorageObjectRef, TraceContext


@dataclass(frozen=True)
class StoredObject:
    """Bytes fetched with their immutable storage reference."""

    ref: StorageObjectRef
    data: bytes


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
