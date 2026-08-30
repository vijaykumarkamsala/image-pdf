from __future__ import annotations

import struct

from ipw.inspection import DeterministicMalwareScanner
from ipw.processing_worker import FileIntakeInspectionHandler, InspectionWorkItem


def work(data: bytes) -> InspectionWorkItem:
    return InspectionWorkItem(
        job_id="job-001",
        upload_session_id="upload-001",
        display_name="source.png",
        expected_media_type="image/png",
        data=data,
        max_bytes=1024,
        max_pixels=10_000,
        max_pages=10,
    )


def test_worker_inspects_a_private_source_without_mutating_it() -> None:
    data = (
        b"\x89PNG\r\n\x1a\n"
        + struct.pack(">I4sIIBBBBB", 13, b"IHDR", 2, 3, 8, 2, 0, 0, 0)
        + b"\x00\x00\x00\x00"
    )
    before = bytes(data)

    result = FileIntakeInspectionHandler(DeterministicMalwareScanner()).handle(work(data))

    assert result.accepted
    assert result.facts is not None
    assert result.facts.width == 2
    assert data == before
