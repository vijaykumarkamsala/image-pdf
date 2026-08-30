from __future__ import annotations

from ipw.contracts.product import StorageObjectRef, TraceContext
from ipw.storage import StoredObject


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

