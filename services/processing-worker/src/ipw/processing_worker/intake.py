"""Recovery 2B inspection handler used behind durable job leases."""

from __future__ import annotations

from dataclasses import dataclass

from ipw.inspection import InspectionLimits, InspectionOutcome, MalwareScanner, inspect_bytes


@dataclass(frozen=True)
class InspectionWorkItem:
    job_id: str
    upload_session_id: str
    display_name: str
    expected_media_type: str
    data: bytes
    max_bytes: int
    max_pixels: int
    max_pages: int


class FileIntakeInspectionHandler:
    """Scanner-first deterministic inspection; no decode or source mutation."""

    def __init__(self, scanner: MalwareScanner) -> None:
        self._scanner = scanner

    def handle(self, item: InspectionWorkItem) -> InspectionOutcome:
        scan = self._scanner.scan(item.data)
        return inspect_bytes(
            item.data,
            display_name=item.display_name,
            expected_media_type=item.expected_media_type,
            malware_state=scan.state,
            limits=InspectionLimits(
                max_bytes=item.max_bytes,
                max_pixels=item.max_pixels,
                max_pages=item.max_pages,
            ),
        )
