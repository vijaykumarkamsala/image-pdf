from __future__ import annotations

from ipw.contracts.product import StorageObjectRef, TraceContext
from ipw.storage import ObjectZone, PrivateObjectRef, StoredObject, UploadWriteResult


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
