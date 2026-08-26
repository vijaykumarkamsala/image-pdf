"""Normalised failure taxonomy.

``docs/USER_FLOWS_AND_EDGE_CASES.md`` section 18 requires every failure to be
normalised into an actionable category, and every response to indicate whether
the customer can change settings, retry, use an alternate route, wait, purchase
capacity or contact support. That requirement is encoded in the type: a
:class:`NormalizedFailure` cannot be constructed without a category and a next
action.

Nothing in the benchmark foundation raises a bare exception across the processor
boundary. ``ipw.processors.base`` converts anything that escapes an adapter into
a ``PERMANENT_PROCESSING`` failure, which is what makes "one failed input must
not fail an entire batch" structurally true rather than aspirational.
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import Field

from ipw.contracts.common import ContractModel, NonEmptyStr


class FailureCategory(StrEnum):
    """The ten normalised categories from USER_FLOWS_AND_EDGE_CASES.md section 18."""

    INVALID_INPUT = "invalid_input"
    UNSUPPORTED_FORMAT = "unsupported_format"
    UNSUPPORTED_FEATURE = "unsupported_feature"
    SAFETY_LIMIT = "safety_limit"
    ENTITLEMENT_REQUIRED = "entitlement_required"
    QUEUE_CAPACITY = "queue_capacity"
    PROCESSOR_UNAVAILABLE = "processor_unavailable"
    PROCESSOR_QUALITY_FAILURE = "processor_quality_failure"
    TEMPORARY_INFRASTRUCTURE = "temporary_infrastructure"
    PERMANENT_PROCESSING = "permanent_processing"
    CANCELLED = "cancelled"


class NextAction(StrEnum):
    """What the caller (ultimately, the customer) can do about a failure."""

    CHANGE_SETTINGS = "change_settings"
    RETRY = "retry"
    ALTERNATE_ROUTE = "alternate_route"
    WAIT = "wait"
    PURCHASE_CAPACITY = "purchase_capacity"
    CONTACT_SUPPORT = "contact_support"
    NONE = "none"


class Severity(StrEnum):
    ERROR = "error"
    WARNING = "warning"


class FailureCode(StrEnum):
    """Stable failure codes.

    Codes are namespaced by the subsystem that raises them and are part of the
    public contract: tests, reports and (later) the browser lab assert on these
    exact strings, so a code is never renamed, only deprecated.
    """

    # -- manifest structure -----------------------------------------------
    MANIFEST_UNREADABLE = "MANIFEST.UNREADABLE"
    MANIFEST_FILE_TOO_LARGE = "MANIFEST.FILE_TOO_LARGE"
    MANIFEST_NOT_JSON = "MANIFEST.NOT_JSON"
    MANIFEST_SCHEMA_INVALID = "MANIFEST.SCHEMA_INVALID"
    MANIFEST_UNKNOWN_FIELD = "MANIFEST.UNKNOWN_FIELD"
    MANIFEST_MISSING_FIELD = "MANIFEST.MISSING_FIELD"
    MANIFEST_SCHEMA_VERSION_UNSUPPORTED = "MANIFEST.SCHEMA_VERSION_UNSUPPORTED"

    # -- manifest policy --------------------------------------------------
    MANIFEST_DUPLICATE_ASSET_ID = "MANIFEST.DUPLICATE_ASSET_ID"
    MANIFEST_CONTENT_TYPE_MISMATCH = "MANIFEST.CONTENT_TYPE_MISMATCH"
    MANIFEST_UNSUPPORTED_MEDIA_TYPE = "MANIFEST.UNSUPPORTED_MEDIA_TYPE"
    MANIFEST_DIMENSIONS_EXCEEDED = "MANIFEST.DIMENSIONS_EXCEEDED"
    MANIFEST_BYTES_EXCEEDED = "MANIFEST.BYTES_EXCEEDED"
    MANIFEST_MISSING_PROVENANCE = "MANIFEST.MISSING_PROVENANCE"
    MANIFEST_INVALID_PATH = "MANIFEST.INVALID_PATH"
    MANIFEST_ASSET_FILE_MISSING = "MANIFEST.ASSET_FILE_MISSING"
    MANIFEST_HASH_MISMATCH = "MANIFEST.HASH_MISMATCH"
    MANIFEST_DECLARED_BYTES_MISMATCH = "MANIFEST.DECLARED_BYTES_MISMATCH"
    MANIFEST_GROUND_TRUTH_UNRESOLVED = "MANIFEST.GROUND_TRUTH_UNRESOLVED"
    MANIFEST_DEGRADATION_RECIPE_REQUIRED = "MANIFEST.DEGRADATION_RECIPE_REQUIRED"

    # -- processing -------------------------------------------------------
    PROCESSOR_OPERATION_UNSUPPORTED = "PROCESSOR.OPERATION_UNSUPPORTED"
    PROCESSOR_SETTINGS_UNSUPPORTED = "PROCESSOR.SETTINGS_UNSUPPORTED"
    PROCESSOR_UNAVAILABLE = "PROCESSOR.UNAVAILABLE"
    PROCESSOR_INTERNAL_ERROR = "PROCESSOR.INTERNAL_ERROR"
    PROCESSOR_TIMEOUT = "PROCESSOR.TIMEOUT"
    PROCESSOR_CANCELLED = "PROCESSOR.CANCELLED"
    PROCESSOR_QUALITY_GATE_FAILED = "PROCESSOR.QUALITY_GATE_FAILED"

    # -- safety -----------------------------------------------------------
    SAFETY_PIXELS_EXCEEDED = "SAFETY.PIXELS_EXCEEDED"
    SAFETY_BYTES_EXCEEDED = "SAFETY.BYTES_EXCEEDED"
    SAFETY_DECOMPRESSION_BOMB = "SAFETY.DECOMPRESSION_BOMB"
    SAFETY_MEMORY_EXCEEDED = "SAFETY.MEMORY_EXCEEDED"
    SAFETY_ORIGINAL_MUTATED = "SAFETY.ORIGINAL_MUTATED"

    # -- licence and rights gates (POC-002) --------------------------------
    LICENCE_NOT_APPROVED = "LICENCE.NOT_APPROVED"
    LICENCE_BLOCKED = "LICENCE.BLOCKED"
    LICENCE_REFERENCE_ONLY = "LICENCE.REFERENCE_ONLY"
    LICENCE_COMPONENT_NOT_REGISTERED = "LICENCE.COMPONENT_NOT_REGISTERED"
    LICENCE_SUPPLY_CHAIN_INCOMPLETE = "LICENCE.SUPPLY_CHAIN_INCOMPLETE"
    LICENCE_DEPENDENCY_CYCLE = "LICENCE.DEPENDENCY_CYCLE"
    LICENCE_DEPENDENCY_NOT_REGISTERED = "LICENCE.DEPENDENCY_NOT_REGISTERED"
    LICENCE_NO_APPROVED_FALLBACK = "LICENCE.NO_APPROVED_FALLBACK"
    LICENCE_UNKNOWN_DISPOSITION = "LICENCE.UNKNOWN_DISPOSITION"

    RIGHTS_BENCHMARK_USE_NOT_PERMITTED = "RIGHTS.BENCHMARK_USE_NOT_PERMITTED"
    RIGHTS_PUBLIC_DEMO_NOT_PERMITTED = "RIGHTS.PUBLIC_DEMO_NOT_PERMITTED"
    RIGHTS_SENSITIVE_CONTENT = "RIGHTS.SENSITIVE_CONTENT"
    RIGHTS_PROVENANCE_MISSING = "RIGHTS.PROVENANCE_MISSING"


class NormalizedFailure(ContractModel):
    """A machine-actionable failure.

    ``message`` is safe to log and to show: it must never contain image bytes,
    absolute paths, credentials or personal metadata (AGENTS.md security rules).
    Use ``pointer`` to locate the offending field and ``context`` for redacted,
    scalar-only detail.
    """

    code: FailureCode
    category: FailureCategory
    severity: Severity = Severity.ERROR
    retryable: bool
    next_action: NextAction
    message: NonEmptyStr
    pointer: str | None = Field(
        default=None,
        description="RFC 6901 JSON Pointer to the offending field, when applicable.",
    )
    context: dict[str, str | int | bool] = Field(
        default_factory=dict,
        description="Redacted scalar detail. Never contains bytes, paths or personal data.",
    )
    remediation: str | None = Field(
        default=None, description="Short operator-facing hint on how to resolve the failure."
    )


def failure(
    code: FailureCode,
    category: FailureCategory,
    message: str,
    *,
    retryable: bool = False,
    next_action: NextAction = NextAction.CHANGE_SETTINGS,
    pointer: str | None = None,
    severity: Severity = Severity.ERROR,
    remediation: str | None = None,
    **context: str | int | bool,
) -> NormalizedFailure:
    """Construct a :class:`NormalizedFailure` with keyword context."""
    return NormalizedFailure(
        code=code,
        category=category,
        severity=severity,
        retryable=retryable,
        next_action=next_action,
        message=message,
        pointer=pointer,
        context=dict(context),
        remediation=remediation,
    )
