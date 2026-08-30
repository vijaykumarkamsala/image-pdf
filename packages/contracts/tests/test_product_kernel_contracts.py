from __future__ import annotations

import pytest
from pydantic import ValidationError

from ipw.contracts.product_kernel import (
    AssetOriginalRecord,
    FileLocationKind,
    FileLocationRef,
    GuestSessionRecord,
    MalwareScanState,
    SourceFacts,
    SourceVersionRecord,
    UploadConstraints,
    UploadOwnerKind,
    UploadSessionRecord,
    UploadSessionState,
    UsageEvent,
    WorkspaceFile,
)
from ipw.contracts.version import PRODUCT_SCHEMA_VERSION


def test_product_kernel_has_independent_version_line() -> None:
    event = UsageEvent(
        usage_event_id="usage-001",
        workspace_id="workspace-001",
        actor_id="actor-001",
        event_kind="project.created",
        occurred_at="2026-08-30T00:00:00.000Z",
    )
    assert event.schema_version == PRODUCT_SCHEMA_VERSION
    with pytest.raises(ValidationError, match="unsupported product contract version"):
        UsageEvent(
            schema_version="2.0.0",
            usage_event_id="usage-002",
            workspace_id="workspace-001",
            actor_id="actor-001",
            event_kind="project.created",
            occurred_at="2026-08-30T00:00:00.000Z",
        )


def test_zero_charge_fields_cannot_be_changed() -> None:
    with pytest.raises(ValidationError):
        UsageEvent(
            usage_event_id="usage-001",
            workspace_id="workspace-001",
            actor_id="actor-001",
            event_kind="file.registered",
            customer_amount="1.00",  # type: ignore[arg-type]
            occurred_at="2026-08-30T00:00:00.000Z",
        )


def test_canonical_location_is_separate_from_asset_identity() -> None:
    original = AssetOriginalRecord(
        asset_original_id="asset-001",
        workspace_id="workspace-001",
        object_reference_id="object-001",
        original_filename="source.png",
        created_at="2026-08-30T00:00:00.000Z",
    )
    source = SourceVersionRecord(
        source_version_id="source-001",
        workspace_id="workspace-001",
        asset_original_id=original.asset_original_id,
        object_reference_id="object-001",
        sequence=1,
        created_at="2026-08-30T00:00:00.000Z",
    )
    workspace_file = WorkspaceFile(
        file_id="file-001",
        workspace_id="workspace-001",
        asset_original_id=original.asset_original_id,
        current_source_version_id=source.source_version_id,
        display_name="source.png",
        canonical_location=FileLocationRef(
            kind=FileLocationKind.DEFAULT_FILES,
            default_files_id="default-files-001",
        ),
    )

    moved = workspace_file.model_copy(
        update={
            "canonical_location": FileLocationRef(
                kind=FileLocationKind.PROJECT,
                project_id="project-001",
            )
        }
    )
    assert moved.asset_original_id == workspace_file.asset_original_id
    assert moved.current_source_version_id == workspace_file.current_source_version_id
    assert original.object_reference_id == source.object_reference_id


def test_location_rejects_mixed_targets() -> None:
    with pytest.raises(ValidationError, match="exactly one"):
        FileLocationRef(
            kind=FileLocationKind.PROJECT,
            project_id="project-001",
            default_files_id="default-files-001",
        )


def test_upload_owner_boundary_is_exactly_one() -> None:
    values = {
        "upload_session_id": "upload-001",
        "display_name": "source.png",
        "expected_media_type": "image/png",
        "expected_byte_size": 67,
        "bytes_received": 0,
        "state": UploadSessionState.INITIATED,
        "constraints": UploadConstraints(
            allowed_media_types=("image/png", "application/pdf"),
            max_bytes=10_000,
            max_pixels=1_000_000,
            max_pages=20,
        ),
        "created_at": "2026-08-30T00:00:00.000Z",
        "expires_at": "2026-08-30T00:15:00.000Z",
        "updated_at": "2026-08-30T00:00:00.000Z",
    }
    actor_upload = UploadSessionRecord(
        **values,
        owner_kind=UploadOwnerKind.ACTOR,
        workspace_id="workspace-001",
        actor_id="actor-001",
    )
    assert actor_upload.guest_session_id is None

    with pytest.raises(ValidationError, match="exactly one owner"):
        UploadSessionRecord(
            **values,
            owner_kind=UploadOwnerKind.GUEST,
            workspace_id="workspace-001",
            guest_session_id="guest-001",
        )


def test_source_facts_are_server_derived_and_nonempty() -> None:
    facts = SourceFacts(
        sha256="a" * 64,
        detected_media_type="image/png",
        byte_size=67,
        width=1,
        height=1,
        megapixels_milli=0,
        frame_count=1,
        has_alpha=True,
        bit_depth=8,
        malware_scan_state=MalwareScanState.CLEAN,
    )
    assert facts.detected_media_type == "image/png"
    assert facts.byte_size == 67


def test_guest_contract_never_contains_a_persisted_token() -> None:
    guest = GuestSessionRecord(
        guest_session_id="guest-001",
        expires_at="2026-08-30T01:00:00.000Z",
    )
    assert "token" not in guest.model_dump()
