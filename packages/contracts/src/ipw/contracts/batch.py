"""Durable cross-file batch planning, execution, and reporting contracts."""

from __future__ import annotations

from enum import StrEnum
from typing import Literal

from pydantic import Field, model_validator

from ipw.contracts.common import ContractModel, NonEmptyStr, Sha256Hex, SlugId
from ipw.contracts.enhancement import ExportOutputProfile
from ipw.contracts.version import PRODUCT_SCHEMA_VERSION

BATCH_OUTPUT_LIMIT = 200


class BatchContractModel(ContractModel):
    """Base for the additive Product V2 batch contract line."""

    schema_version: str = PRODUCT_SCHEMA_VERSION

    @model_validator(mode="after")
    def _schema_version_is_supported(self) -> BatchContractModel:
        if self.schema_version != PRODUCT_SCHEMA_VERSION:
            raise ValueError(
                f"unsupported product contract version {self.schema_version!r}; "
                f"expected {PRODUCT_SCHEMA_VERSION}"
            )
        return self


class BatchRunState(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    PARTIALLY_COMPLETED = "partially_completed"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class BatchItemState(StrEnum):
    EXCLUDED = "excluded"
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class BatchConfirmationState(StrEnum):
    PENDING = "pending"
    NOT_REQUIRED = "not_required"
    CONFIRMED = "confirmed"


class BatchOutputSelection(BatchContractModel):
    artboard_id: SlugId
    profile: ExportOutputProfile
    filename: NonEmptyStr


class BatchSubmissionItem(BatchContractModel):
    client_item_id: SlugId
    display_name: NonEmptyStr
    document_id: SlugId
    document_version_id: SlugId
    recipe_id: SlugId
    recipe_version: int = Field(ge=1)
    outputs: tuple[BatchOutputSelection, ...] = Field(min_length=1, max_length=64)
    included: bool = True
    exclusion_reason: str | None = Field(default=None, max_length=500)

    @model_validator(mode="after")
    def _exclusion_is_explicit(self) -> BatchSubmissionItem:
        if self.included and self.exclusion_reason is not None:
            raise ValueError("included batch items cannot have an exclusion reason")
        if not self.included and not (self.exclusion_reason or "").strip():
            raise ValueError("excluded batch items require a reason")
        return self


class BatchPlanRequest(BatchContractModel):
    name: NonEmptyStr
    items: tuple[BatchSubmissionItem, ...] = Field(min_length=1, max_length=50)

    @model_validator(mode="after")
    def _items_are_unique_and_executable(self) -> BatchPlanRequest:
        identities = [item.client_item_id for item in self.items]
        if len(set(identities)) != len(identities):
            raise ValueError("batch client item ids must be unique")
        versions = [(item.document_id, item.document_version_id) for item in self.items]
        if len(set(versions)) != len(versions):
            raise ValueError("a document version may appear only once in a batch")
        if not any(item.included for item in self.items):
            raise ValueError("a batch must include at least one item")
        output_count = sum(len(item.outputs) for item in self.items if item.included)
        if output_count > BATCH_OUTPUT_LIMIT:
            raise ValueError(f"a batch may create at most {BATCH_OUTPUT_LIMIT} outputs")
        return self


class BatchGroupApproval(BatchContractModel):
    group_id: SlugId
    representative_client_item_id: SlugId
    representative_preview_id: SlugId
    confirmation_state: Literal[BatchConfirmationState.CONFIRMED]


class BatchCreateRequest(BatchPlanRequest):
    plan_sha256: Sha256Hex
    group_approvals: tuple[BatchGroupApproval, ...] = Field(min_length=1, max_length=50)
    confirmed_client_item_ids: tuple[SlugId, ...] = Field(default=(), max_length=50)

    @model_validator(mode="after")
    def _groups_are_unique(self) -> BatchCreateRequest:
        group_ids = [approval.group_id for approval in self.group_approvals]
        if len(set(group_ids)) != len(group_ids):
            raise ValueError("each batch group may be approved once")
        representatives = [
            approval.representative_client_item_id for approval in self.group_approvals
        ]
        if len(set(representatives)) != len(representatives):
            raise ValueError("each representative item may approve one batch group")
        preview_ids = [approval.representative_preview_id for approval in self.group_approvals]
        if len(set(preview_ids)) != len(preview_ids):
            raise ValueError("each representative preview may approve one batch group")
        if len(set(self.confirmed_client_item_ids)) != len(self.confirmed_client_item_ids):
            raise ValueError("each risky batch item may be confirmed once")
        included_ids = {item.client_item_id for item in self.items if item.included}
        if any(item_id not in included_ids for item_id in self.confirmed_client_item_ids):
            raise ValueError("confirmed batch items must reference included items")
        if any(item_id not in included_ids for item_id in representatives):
            raise ValueError("batch group representatives must reference included items")
        return self


class BatchPlanItem(BatchContractModel):
    client_item_id: SlugId
    group_id: SlugId | None
    included: bool
    requires_individual_confirmation: bool
    confirmation_state: BatchConfirmationState
    exception_codes: tuple[SlugId, ...] = Field(max_length=16)


class BatchPlanGroup(BatchContractModel):
    group_id: SlugId
    compatibility_sha256: Sha256Hex
    label: NonEmptyStr
    client_item_ids: tuple[SlugId, ...] = Field(min_length=1, max_length=50)
    representative_client_item_id: SlugId
    representative_preview_id: SlugId | None = None
    exception_count: int = Field(ge=0)


class BatchPlan(BatchContractModel):
    plan_sha256: Sha256Hex
    name: NonEmptyStr
    items: tuple[BatchPlanItem, ...] = Field(min_length=1, max_length=50)
    groups: tuple[BatchPlanGroup, ...] = Field(min_length=1, max_length=50)
    included_count: int = Field(ge=1, le=50)
    excluded_count: int = Field(ge=0, le=49)

    @model_validator(mode="after")
    def _counts_and_groups_match(self) -> BatchPlan:
        included = [item for item in self.items if item.included]
        if self.included_count != len(included):
            raise ValueError("batch plan included count does not match its items")
        if self.excluded_count != len(self.items) - len(included):
            raise ValueError("batch plan excluded count does not match its items")
        item_ids = [item.client_item_id for item in self.items]
        if len(set(item_ids)) != len(item_ids):
            raise ValueError("batch plan item ids must be unique")
        group_ids = {group.group_id for group in self.groups}
        if len(group_ids) != len(self.groups):
            raise ValueError("batch plan group ids must be unique")
        if any(item.included and item.group_id not in group_ids for item in self.items):
            raise ValueError("every included batch item must reference a plan group")
        if any(not item.included and item.group_id is not None for item in self.items):
            raise ValueError("excluded batch items cannot reference a plan group")
        grouped_ids = [item_id for group in self.groups for item_id in group.client_item_ids]
        included_ids = [item.client_item_id for item in included]
        if len(set(grouped_ids)) != len(grouped_ids) or set(grouped_ids) != set(included_ids):
            raise ValueError("batch groups must partition the included items exactly once")
        for group in self.groups:
            if group.representative_client_item_id not in group.client_item_ids:
                raise ValueError("a batch group representative must belong to its group")
        return self


class BatchGroupRecord(BatchContractModel):
    group_id: SlugId
    batch_id: SlugId
    compatibility_sha256: Sha256Hex
    label: NonEmptyStr
    item_count: int = Field(ge=1, le=50)
    representative_item_id: SlugId
    representative_preview_id: SlugId
    exception_count: int = Field(ge=0)


class BatchItemRecord(BatchContractModel):
    batch_item_id: SlugId
    batch_id: SlugId
    client_item_id: SlugId
    position: int = Field(ge=0, le=49)
    display_name: NonEmptyStr
    document_id: SlugId
    document_version_id: SlugId
    recipe_id: SlugId
    recipe_version: int = Field(ge=1)
    group_id: SlugId | None
    included: bool
    exclusion_reason: str | None
    requires_individual_confirmation: bool
    confirmation_state: BatchConfirmationState
    exception_codes: tuple[SlugId, ...] = Field(max_length=16)
    export_request_id: SlugId | None
    job_id: SlugId | None
    state: BatchItemState
    progress_percent: int = Field(ge=0, le=100)
    output_count: int = Field(ge=0, le=64)
    succeeded_output_count: int = Field(ge=0, le=64)
    failed_output_count: int = Field(ge=0, le=64)
    cancelled_output_count: int = Field(ge=0, le=64)
    failure_code: str | None
    failure_message: str | None
    last_checkpoint_key: str | None
    updated_at: NonEmptyStr

    @model_validator(mode="after")
    def _execution_identity_and_counts_match(self) -> BatchItemRecord:
        terminal_outputs = (
            self.succeeded_output_count + self.failed_output_count + self.cancelled_output_count
        )
        if terminal_outputs > self.output_count:
            raise ValueError("batch item output counts exceed its output count")
        if self.included:
            if self.state == BatchItemState.EXCLUDED:
                raise ValueError("included batch items cannot have excluded state")
            if self.group_id is None or self.export_request_id is None or self.job_id is None:
                raise ValueError("included batch items require group, export and job identity")
            if self.exclusion_reason is not None:
                raise ValueError("included batch items cannot have an exclusion reason")
            expected = (
                BatchConfirmationState.CONFIRMED
                if self.requires_individual_confirmation
                else BatchConfirmationState.NOT_REQUIRED
            )
            if self.confirmation_state != expected:
                raise ValueError("batch item confirmation does not match its exceptions")
        else:
            if self.state != BatchItemState.EXCLUDED:
                raise ValueError("excluded batch items require excluded state")
            if (
                self.group_id is not None
                or self.export_request_id is not None
                or self.job_id is not None
            ):
                raise ValueError("excluded batch items cannot have execution identity")
            if not (self.exclusion_reason or "").strip():
                raise ValueError("excluded batch items require a reason")
            if (
                self.requires_individual_confirmation
                or self.confirmation_state != BatchConfirmationState.NOT_REQUIRED
            ):
                raise ValueError("excluded batch items cannot require confirmation")
            if self.output_count != 0 or terminal_outputs != 0:
                raise ValueError("excluded batch items cannot contain outputs")
        return self


class BatchRunRecord(BatchContractModel):
    batch_id: SlugId
    workspace_id: SlugId
    name: NonEmptyStr
    plan_sha256: Sha256Hex
    state: BatchRunState
    items: tuple[BatchItemRecord, ...] = Field(min_length=1, max_length=50)
    groups: tuple[BatchGroupRecord, ...] = Field(min_length=1, max_length=50)
    item_count: int = Field(ge=1, le=50)
    included_count: int = Field(ge=1, le=50)
    excluded_count: int = Field(ge=0, le=49)
    queued_count: int = Field(ge=0, le=50)
    running_count: int = Field(ge=0, le=50)
    succeeded_count: int = Field(ge=0, le=50)
    failed_count: int = Field(ge=0, le=50)
    cancelled_count: int = Field(ge=0, le=50)
    cancellation_requested: bool
    zero_charge: Literal[True] = True
    created_by_actor_id: SlugId
    created_at: NonEmptyStr
    updated_at: NonEmptyStr

    @model_validator(mode="after")
    def _summary_matches_items(self) -> BatchRunRecord:
        counts = {
            "excluded": self.excluded_count,
            "queued": self.queued_count,
            "running": self.running_count,
            "succeeded": self.succeeded_count,
            "failed": self.failed_count,
            "cancelled": self.cancelled_count,
        }
        if self.item_count != len(self.items):
            raise ValueError("batch item count does not match its items")
        if self.included_count != sum(item.included for item in self.items):
            raise ValueError("batch included count does not match its items")
        if any(
            counts[state] != sum(item.state == state for item in self.items) for state in counts
        ):
            raise ValueError("batch state counts do not match its items")
        if sum(counts.values()) != self.item_count:
            raise ValueError("batch state counts must account for every item")
        if self.excluded_count != self.item_count - self.included_count:
            raise ValueError("batch included and excluded counts must account for every item")
        if any(item.batch_id != self.batch_id for item in self.items):
            raise ValueError("batch items must reference their containing batch")
        group_ids = [group.group_id for group in self.groups]
        if len(set(group_ids)) != len(group_ids):
            raise ValueError("batch group ids must be unique")
        if any(group.batch_id != self.batch_id for group in self.groups):
            raise ValueError("batch groups must reference their containing batch")
        for group in self.groups:
            group_items = [item for item in self.items if item.group_id == group.group_id]
            if len(group_items) != group.item_count:
                raise ValueError("batch group item count does not match its items")
            if group.representative_item_id not in {item.batch_item_id for item in group_items}:
                raise ValueError("batch group representative must belong to its group")
        if sum(group.item_count for group in self.groups) != self.included_count:
            raise ValueError("batch groups must account for every included item")
        return self


class BatchOutputReport(BatchContractModel):
    output_id: SlugId
    filename: NonEmptyStr
    state: Literal["queued", "running", "succeeded", "failed", "cancelled"]
    sha256: Sha256Hex | None
    byte_size: int | None = Field(default=None, ge=1)
    failure_code: str | None
    failure_message: str | None


class BatchGroupReport(BatchContractModel):
    group_id: SlugId
    label: NonEmptyStr
    compatibility_sha256: Sha256Hex
    representative_item_id: SlugId
    representative_preview_id: SlugId
    item_count: int = Field(ge=1, le=50)
    queued_count: int = Field(ge=0, le=50)
    running_count: int = Field(ge=0, le=50)
    succeeded_count: int = Field(ge=0, le=50)
    failed_count: int = Field(ge=0, le=50)
    cancelled_count: int = Field(ge=0, le=50)
    exception_count: int = Field(ge=0, le=50)

    @model_validator(mode="after")
    def _state_counts_match(self) -> BatchGroupReport:
        state_count = (
            self.queued_count
            + self.running_count
            + self.succeeded_count
            + self.failed_count
            + self.cancelled_count
        )
        if state_count != self.item_count:
            raise ValueError("batch group state counts must account for every item")
        if self.exception_count > self.item_count:
            raise ValueError("batch group exceptions cannot exceed its item count")
        return self


class BatchReportItem(BatchContractModel):
    batch_item_id: SlugId
    client_item_id: SlugId
    group_id: SlugId | None
    display_name: NonEmptyStr
    state: BatchItemState
    exception_codes: tuple[SlugId, ...] = Field(max_length=16)
    outputs: tuple[BatchOutputReport, ...] = Field(max_length=64)


class BatchReport(BatchContractModel):
    batch_id: SlugId
    workspace_id: SlugId
    name: NonEmptyStr
    state: BatchRunState
    item_count: int = Field(ge=1, le=50)
    queued_count: int = Field(ge=0, le=50)
    running_count: int = Field(ge=0, le=50)
    succeeded_count: int = Field(ge=0, le=50)
    failed_count: int = Field(ge=0, le=50)
    cancelled_count: int = Field(ge=0, le=50)
    excluded_count: int = Field(ge=0, le=49)
    groups: tuple[BatchGroupReport, ...] = Field(min_length=1, max_length=50)
    items: tuple[BatchReportItem, ...] = Field(min_length=1, max_length=50)
    generated_at: NonEmptyStr

    @model_validator(mode="after")
    def _report_counts_and_groups_match(self) -> BatchReport:
        counts = {
            "excluded": self.excluded_count,
            "queued": self.queued_count,
            "running": self.running_count,
            "succeeded": self.succeeded_count,
            "failed": self.failed_count,
            "cancelled": self.cancelled_count,
        }
        if self.item_count != len(self.items):
            raise ValueError("batch report item count does not match its items")
        if any(
            counts[state] != sum(item.state == state for item in self.items) for state in counts
        ):
            raise ValueError("batch report state counts do not match its items")
        if sum(group.item_count for group in self.groups) != self.item_count - self.excluded_count:
            raise ValueError("batch report groups must account for every included item")
        group_ids = {group.group_id for group in self.groups}
        if len(group_ids) != len(self.groups):
            raise ValueError("batch report group ids must be unique")
        if any(
            (
                item.group_id not in group_ids
                if item.state != BatchItemState.EXCLUDED
                else item.group_id is not None
            )
            for item in self.items
        ):
            raise ValueError("batch report items must reference their included group")
        for group in self.groups:
            group_items = [item for item in self.items if item.group_id == group.group_id]
            group_counts = {
                "queued": group.queued_count,
                "running": group.running_count,
                "succeeded": group.succeeded_count,
                "failed": group.failed_count,
                "cancelled": group.cancelled_count,
            }
            if group.item_count != len(group_items) or any(
                count != sum(item.state == state for item in group_items)
                for state, count in group_counts.items()
            ):
                raise ValueError("batch report group state does not match its items")
            if group.exception_count != sum(bool(item.exception_codes) for item in group_items):
                raise ValueError("batch report group exceptions do not match its items")
        return self


BATCH_SCHEMA_EXPORTS: dict[str, type[ContractModel]] = {
    "batch-create-request": BatchCreateRequest,
    "batch-group-approval": BatchGroupApproval,
    "batch-group-record": BatchGroupRecord,
    "batch-group-report": BatchGroupReport,
    "batch-item-record": BatchItemRecord,
    "batch-output-report": BatchOutputReport,
    "batch-output-selection": BatchOutputSelection,
    "batch-plan": BatchPlan,
    "batch-plan-group": BatchPlanGroup,
    "batch-plan-item": BatchPlanItem,
    "batch-plan-request": BatchPlanRequest,
    "batch-report": BatchReport,
    "batch-report-item": BatchReportItem,
    "batch-run-record": BatchRunRecord,
    "batch-submission-item": BatchSubmissionItem,
}
