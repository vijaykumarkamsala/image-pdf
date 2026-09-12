from __future__ import annotations

import pytest
from pydantic import ValidationError

from ipw.contracts.batch import (
    BatchConfirmationState,
    BatchCreateRequest,
    BatchGroupApproval,
    BatchGroupRecord,
    BatchGroupReport,
    BatchItemRecord,
    BatchItemState,
    BatchOutputSelection,
    BatchPlan,
    BatchPlanGroup,
    BatchPlanItem,
    BatchPlanRequest,
    BatchReport,
    BatchReportItem,
    BatchRunRecord,
    BatchRunState,
    BatchSubmissionItem,
)
from ipw.contracts.enhancement import (
    ExportOutputProfile,
    ExportPurpose,
    ImageExportFormat,
    MetadataPolicy,
)


def output() -> BatchOutputSelection:
    return BatchOutputSelection(
        artboard_id="artboard-001",
        filename="catalog.png",
        profile=ExportOutputProfile(
            profile_id="web-png",
            name="Web PNG",
            purpose=ExportPurpose.WEB,
            format=ImageExportFormat.PNG,
            metadata_policy=MetadataPolicy(),
        ),
    )


def item(client_item_id: str = "item-001", *, included: bool = True) -> BatchSubmissionItem:
    return BatchSubmissionItem(
        client_item_id=client_item_id,
        display_name="Catalog cover",
        document_id=f"document-{client_item_id}",
        document_version_id=f"version-{client_item_id}",
        recipe_id=f"recipe-{client_item_id}",
        recipe_version=1,
        outputs=(output(),),
        included=included,
        exclusion_reason=None if included else "Customer excluded this source",
    )


def test_batch_request_bounds_and_freezes_fifty_independent_items() -> None:
    request = BatchPlanRequest(
        name="Web catalogue",
        items=tuple(item(f"item-{index:03d}") for index in range(50)),
    )

    assert len(request.items) == 50
    assert all(value.included for value in request.items)
    with pytest.raises(ValidationError, match="at most 50"):
        BatchPlanRequest(
            name="Too many",
            items=tuple(item(f"overflow-{index:03d}") for index in range(51)),
        )


def test_batch_request_requires_unique_client_identity_and_one_included_item() -> None:
    with pytest.raises(ValidationError, match="client item ids must be unique"):
        BatchPlanRequest(name="Duplicates", items=(item(), item()))

    with pytest.raises(ValidationError, match="at least one item"):
        BatchPlanRequest(
            name="Nothing selected",
            items=(item("item-excluded", included=False),),
        )


def test_batch_request_bounds_total_outputs_and_rejects_duplicate_document_versions() -> None:
    duplicate_version = item("item-002").model_copy(
        update={"document_id": "document-item-001", "document_version_id": "version-item-001"}
    )
    with pytest.raises(ValidationError, match="document version may appear only once"):
        BatchPlanRequest(name="Duplicate source", items=(item(), duplicate_version))

    with pytest.raises(ValidationError, match="at most 200 outputs"):
        BatchPlanRequest(
            name="Unbounded fan-out",
            items=tuple(
                item(f"item-{index:03d}").model_copy(
                    update={"outputs": tuple(output() for _ in range(51))}
                )
                for index in range(4)
            ),
        )


def test_batch_exclusion_is_explicit_and_included_items_have_no_exclusion_reason() -> None:
    with pytest.raises(ValidationError, match="excluded batch items require a reason"):
        BatchSubmissionItem(
            **item().model_dump(exclude={"included", "exclusion_reason"}),
            included=False,
            exclusion_reason=None,
        )

    with pytest.raises(ValidationError, match="included batch items cannot"):
        BatchSubmissionItem(
            **item().model_dump(exclude={"included", "exclusion_reason"}),
            included=True,
            exclusion_reason="unexpected",
        )


def test_batch_contract_rejects_a_foreign_product_schema_version() -> None:
    with pytest.raises(ValidationError, match="unsupported product contract version"):
        BatchPlanRequest(schema_version="9.0.0", name="Wrong version", items=(item(),))


def test_batch_submission_requires_unique_approved_groups() -> None:
    approval = BatchGroupApproval(
        group_id="group-001",
        representative_client_item_id="item-001",
        representative_preview_id="preview-001",
        confirmation_state=BatchConfirmationState.CONFIRMED,
    )
    with pytest.raises(ValidationError, match="each batch group may be approved once"):
        BatchCreateRequest(
            name="Catalog batch",
            plan_sha256="a" * 64,
            items=(item(),),
            group_approvals=(approval, approval),
        )

    with pytest.raises(
        ValidationError, match="confirmed batch items must reference included items"
    ):
        BatchCreateRequest(
            name="Catalog batch",
            plan_sha256="a" * 64,
            items=(item(),),
            group_approvals=(approval,),
            confirmed_client_item_ids=("item-not-in-batch",),
        )


def plan_item(client_item_id: str, *, included: bool = True) -> BatchPlanItem:
    return BatchPlanItem(
        client_item_id=client_item_id,
        group_id="group-001" if included else None,
        included=included,
        requires_individual_confirmation=False,
        confirmation_state=BatchConfirmationState.NOT_REQUIRED,
        exception_codes=(),
    )


def plan_group(*client_item_ids: str) -> BatchPlanGroup:
    return BatchPlanGroup(
        group_id="group-001",
        compatibility_sha256="b" * 64,
        label="PNG output",
        client_item_ids=client_item_ids,
        representative_client_item_id=client_item_ids[0],
        exception_count=0,
    )


def test_batch_plan_groups_partition_only_included_items() -> None:
    planned = BatchPlan(
        plan_sha256="a" * 64,
        name="Reviewed batch",
        items=(plan_item("item-001"), plan_item("item-002", included=False)),
        groups=(plan_group("item-001"),),
        included_count=1,
        excluded_count=1,
    )
    assert planned.groups[0].representative_client_item_id == "item-001"

    with pytest.raises(ValidationError, match="included count"):
        BatchPlan(**{**planned.model_dump(), "included_count": 2})
    invalid_items = list(planned.model_dump()["items"])
    invalid_items[1]["group_id"] = "group-001"
    with pytest.raises(ValidationError, match="excluded batch items cannot"):
        BatchPlan(**{**planned.model_dump(), "items": invalid_items})
    invalid_groups = list(planned.model_dump()["groups"])
    invalid_groups[0]["representative_client_item_id"] = "item-outside"
    with pytest.raises(ValidationError, match="representative must belong"):
        BatchPlan(**{**planned.model_dump(), "groups": invalid_groups})


def record_item(
    *, included: bool = True, state: BatchItemState = BatchItemState.QUEUED
) -> BatchItemRecord:
    return BatchItemRecord(
        batch_item_id="batch-item-001",
        batch_id="batch-001",
        client_item_id="item-001",
        position=0,
        display_name="Catalog cover",
        document_id="document-001",
        document_version_id="version-001",
        recipe_id="recipe-001",
        recipe_version=1,
        group_id="group-001" if included else None,
        included=included,
        exclusion_reason=None if included else "Excluded during review",
        requires_individual_confirmation=False,
        confirmation_state=BatchConfirmationState.NOT_REQUIRED,
        exception_codes=(),
        export_request_id="export-001" if included else None,
        job_id="job-001" if included else None,
        state=state if included else BatchItemState.EXCLUDED,
        progress_percent=0 if included else 100,
        output_count=1 if included else 0,
        succeeded_output_count=0,
        failed_output_count=0,
        cancelled_output_count=0,
        failure_code=None,
        failure_message=None,
        last_checkpoint_key=None,
        updated_at="2026-09-12T08:00:00Z",
    )


def group_record() -> BatchGroupRecord:
    return BatchGroupRecord(
        group_id="group-001",
        batch_id="batch-001",
        compatibility_sha256="b" * 64,
        label="PNG output",
        item_count=1,
        representative_item_id="batch-item-001",
        representative_preview_id="preview-001",
        exception_count=0,
    )


def test_batch_item_and_run_records_enforce_execution_identity() -> None:
    queued = record_item()
    excluded = record_item(included=False)
    assert excluded.state == BatchItemState.EXCLUDED
    with pytest.raises(ValidationError, match="output counts exceed"):
        BatchItemRecord(**{**queued.model_dump(), "failed_output_count": 2})
    with pytest.raises(ValidationError, match="require group, export and job"):
        BatchItemRecord(**{**queued.model_dump(), "job_id": None})

    run = BatchRunRecord(
        batch_id="batch-001",
        workspace_id="workspace-001",
        name="Run",
        plan_sha256="a" * 64,
        state=BatchRunState.QUEUED,
        items=(queued,),
        groups=(group_record(),),
        item_count=1,
        included_count=1,
        excluded_count=0,
        queued_count=1,
        running_count=0,
        succeeded_count=0,
        failed_count=0,
        cancelled_count=0,
        cancellation_requested=False,
        created_by_actor_id="actor-001",
        created_at="2026-09-12T08:00:00Z",
        updated_at="2026-09-12T08:00:00Z",
    )
    assert run.zero_charge is True
    broken_group = {**group_record().model_dump(), "item_count": 2}
    with pytest.raises(ValidationError, match="group item count"):
        BatchRunRecord(**{**run.model_dump(), "groups": [broken_group]})


def test_batch_report_reconciles_group_and_file_outcomes() -> None:
    item_report = BatchReportItem(
        batch_item_id="batch-item-001",
        client_item_id="item-001",
        group_id="group-001",
        display_name="Catalog cover",
        state=BatchItemState.SUCCEEDED,
        exception_codes=(),
        outputs=(),
    )
    group_report = BatchGroupReport(
        group_id="group-001",
        label="PNG output",
        compatibility_sha256="b" * 64,
        representative_item_id="batch-item-001",
        representative_preview_id="preview-001",
        item_count=1,
        queued_count=0,
        running_count=0,
        succeeded_count=1,
        failed_count=0,
        cancelled_count=0,
        exception_count=0,
    )
    report = BatchReport(
        batch_id="batch-001",
        workspace_id="workspace-001",
        name="Run report",
        state=BatchRunState.COMPLETED,
        item_count=1,
        queued_count=0,
        running_count=0,
        succeeded_count=1,
        failed_count=0,
        cancelled_count=0,
        excluded_count=0,
        groups=(group_report,),
        items=(item_report,),
        generated_at="2026-09-12T08:01:00Z",
    )
    assert report.groups[0].succeeded_count == 1
    wrong_group = {
        **group_report.model_dump(),
        "succeeded_count": 0,
        "failed_count": 1,
    }
    with pytest.raises(ValidationError, match="group state does not match"):
        BatchReport(**{**report.model_dump(), "groups": [wrong_group]})


def test_batch_create_approval_identity_is_unambiguous() -> None:
    items = (item("item-001"), item("item-002"))
    approvals = (
        BatchGroupApproval(
            group_id="group-001",
            representative_client_item_id="item-001",
            representative_preview_id="preview-001",
            confirmation_state=BatchConfirmationState.CONFIRMED,
        ),
        BatchGroupApproval(
            group_id="group-002",
            representative_client_item_id="item-002",
            representative_preview_id="preview-002",
            confirmation_state=BatchConfirmationState.CONFIRMED,
        ),
    )
    base = {
        "name": "Approved groups",
        "plan_sha256": "a" * 64,
        "items": items,
        "group_approvals": approvals,
    }
    assert len(BatchCreateRequest.model_validate(base).group_approvals) == 2

    duplicate_representative = approvals[1].model_copy(
        update={"representative_client_item_id": "item-001"}
    )
    with pytest.raises(ValidationError, match="representative item may approve"):
        BatchCreateRequest.model_validate(
            {**base, "group_approvals": (approvals[0], duplicate_representative)}
        )
    duplicate_preview = approvals[1].model_copy(update={"representative_preview_id": "preview-001"})
    with pytest.raises(ValidationError, match="representative preview may approve"):
        BatchCreateRequest.model_validate(
            {**base, "group_approvals": (approvals[0], duplicate_preview)}
        )
    with pytest.raises(ValidationError, match="risky batch item may be confirmed once"):
        BatchCreateRequest.model_validate(
            {**base, "confirmed_client_item_ids": ("item-001", "item-001")}
        )
    foreign_representative = approvals[1].model_copy(
        update={"representative_client_item_id": "item-foreign"}
    )
    with pytest.raises(ValidationError, match="representatives must reference included"):
        BatchCreateRequest.model_validate(
            {**base, "group_approvals": (approvals[0], foreign_representative)}
        )


def test_batch_plan_rejects_ambiguous_group_membership() -> None:
    first = plan_item("item-001")
    second = plan_item("item-002").model_copy(update={"group_id": "group-002"})
    first_group = plan_group("item-001")
    second_group = plan_group("item-002").model_copy(
        update={"group_id": "group-002", "compatibility_sha256": "c" * 64}
    )
    base = BatchPlan(
        plan_sha256="a" * 64,
        name="Two groups",
        items=(first, second),
        groups=(first_group, second_group),
        included_count=2,
        excluded_count=0,
    )
    with pytest.raises(ValidationError, match="excluded count"):
        BatchPlan(**{**base.model_dump(), "excluded_count": 1})
    duplicate_items = [first.model_dump(), {**second.model_dump(), "client_item_id": "item-001"}]
    with pytest.raises(ValidationError, match="plan item ids must be unique"):
        BatchPlan(**{**base.model_dump(), "items": duplicate_items})
    duplicate_groups = [
        first_group.model_dump(),
        {**second_group.model_dump(), "group_id": "group-001"},
    ]
    with pytest.raises(ValidationError, match="plan group ids must be unique"):
        BatchPlan(**{**base.model_dump(), "groups": duplicate_groups})
    missing_group = [{**first.model_dump(), "group_id": "group-missing"}, second.model_dump()]
    with pytest.raises(ValidationError, match="must reference a plan group"):
        BatchPlan(**{**base.model_dump(), "items": missing_group})
    duplicate_membership = [
        first_group.model_dump(),
        {**second_group.model_dump(), "client_item_ids": ["item-001", "item-002"]},
    ]
    with pytest.raises(ValidationError, match="partition the included items"):
        BatchPlan(**{**base.model_dump(), "groups": duplicate_membership})


@pytest.mark.parametrize(
    ("updates", "message"),
    [
        ({"state": BatchItemState.EXCLUDED}, "included batch items cannot have excluded state"),
        ({"exclusion_reason": "Unexpected"}, "cannot have an exclusion reason"),
        (
            {
                "requires_individual_confirmation": True,
                "confirmation_state": BatchConfirmationState.NOT_REQUIRED,
            },
            "confirmation does not match",
        ),
    ],
)
def test_included_batch_item_state_is_consistent(updates: dict[str, object], message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        BatchItemRecord(**{**record_item().model_dump(), **updates})


@pytest.mark.parametrize(
    ("updates", "message"),
    [
        ({"state": BatchItemState.CANCELLED}, "require excluded state"),
        ({"job_id": "job-unexpected"}, "cannot have execution identity"),
        ({"exclusion_reason": None}, "require a reason"),
        ({"requires_individual_confirmation": True}, "cannot require confirmation"),
        ({"output_count": 1}, "cannot contain outputs"),
    ],
)
def test_excluded_batch_item_state_is_consistent(updates: dict[str, object], message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        BatchItemRecord(**{**record_item(included=False).model_dump(), **updates})


def test_group_report_counts_and_exceptions_are_bounded() -> None:
    valid = BatchGroupReport(
        group_id="group-001",
        label="PNG output",
        compatibility_sha256="b" * 64,
        representative_item_id="batch-item-001",
        representative_preview_id="preview-001",
        item_count=1,
        queued_count=1,
        running_count=0,
        succeeded_count=0,
        failed_count=0,
        cancelled_count=0,
        exception_count=0,
    )
    with pytest.raises(ValidationError, match="state counts"):
        BatchGroupReport(**{**valid.model_dump(), "queued_count": 0})
    with pytest.raises(ValidationError, match="exceptions cannot exceed"):
        BatchGroupReport(**{**valid.model_dump(), "exception_count": 2})
