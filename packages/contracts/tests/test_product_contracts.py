from __future__ import annotations

import pytest
from pydantic import ValidationError

from ipw.contracts.failure import FailureCategory, NextAction
from ipw.contracts.licence import Disposition, RunPurpose
from ipw.contracts.operation import OperationKind
from ipw.contracts.product import (
    AssetOriginal,
    ExportRequest,
    JobKind,
    LicenceReleaseGate,
    ProcessingJob,
    ProcessorFacts,
    ProductError,
    Project,
    ProjectNodeKind,
    StorageObjectRef,
    TraceContext,
    WorkspaceReference,
)
from ipw.contracts.version import SCHEMA_VERSION

SHA = "0" * 64


def storage_ref() -> StorageObjectRef:
    return StorageObjectRef(
        storage_id="primary-store",
        object_name="originals/workspace/source.png",
        sha256=SHA,
        media_type="image/png",
        byte_size=1024,
        region="us-central1",
    )


def trace() -> TraceContext:
    return TraceContext(
        trace_id="trace-0001",
        request_id="request-001",
        idempotency_key="idem-0001",
    )


def test_product_documents_reject_unsupported_versions() -> None:
    with pytest.raises(ValidationError, match="unsupported contract version"):
        WorkspaceReference(
            schema_version="99.0.0",
            workspace_id="workspace-001",
        )


def test_workspace_project_and_asset_contracts_are_versioned() -> None:
    workspace = WorkspaceReference(workspace_id="workspace-001", home_region="us-central1")
    project = Project(
        project_id="project-001",
        workspace_id=workspace.workspace_id,
        kind=ProjectNodeKind.PROJECT,
        name="Default files",
    )
    asset = AssetOriginal(
        asset_id="asset-001",
        workspace_id=workspace.workspace_id,
        project_id=project.project_id,
        original=storage_ref(),
        filename="source.png",
        detected_media_type="image/png",
    )

    assert workspace.schema_version == SCHEMA_VERSION
    assert project.workspace_id == workspace.workspace_id
    assert asset.original.object_name == "originals/workspace/source.png"


def test_processing_export_and_gate_contracts_carry_trace_and_idempotency() -> None:
    job = ProcessingJob(
        job_id="job-0001",
        workspace_id="workspace-001",
        kind=JobKind.PROCESS,
        trace=trace(),
        idempotency_key="idem-0001",
        source_refs=("source-001",),
        operation=OperationKind.RESIZE,
    )
    request = ExportRequest(
        export_request_id="export-001",
        workspace_id="workspace-001",
        document_version_id="document-001",
        trace=trace(),
        profile_id="profile-001",
        requested_formats=("png", "pdf"),
        idempotency_key="idem-0002",
    )
    error = ProductError(
        code="policy-denied",
        category=FailureCategory.ENTITLEMENT_REQUIRED,
        message="Release gate did not permit this operation.",
        next_action=NextAction.CONTACT_SUPPORT,
        trace=trace(),
    )
    gate = LicenceReleaseGate(
        gate_id="gate-001",
        purpose=RunPurpose.PRODUCTION,
        component_ids=("processor-001",),
        permitted=False,
        effective_disposition=Disposition.UNKNOWN,
        blockers=(error,),
    )

    assert job.trace.trace_id == "trace-0001"
    assert request.idempotency_key == "idem-0002"
    assert gate.blockers[0].code == "policy-denied"


def test_processor_facts_are_operation_and_licence_aware() -> None:
    facts = ProcessorFacts(
        processor_id="fake-processor",
        version="0.1.0",
        supports_operations=(OperationKind.RESIZE,),
        commercial_disposition=Disposition.APPROVED,
    )

    assert facts.deterministic is True
    assert facts.requires_gpu is False
    assert facts.supports_operations == (OperationKind.RESIZE,)
