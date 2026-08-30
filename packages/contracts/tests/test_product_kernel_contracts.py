from __future__ import annotations

import pytest
from pydantic import ValidationError

from ipw.contracts.product_kernel import (
    AssetOriginalRecord,
    FileLocationKind,
    FileLocationRef,
    SourceVersionRecord,
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
