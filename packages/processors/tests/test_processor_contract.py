"""Processor contract conformance, boundary guards and original preservation.

Acceptance criteria 5 and 6.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from ipw.benchmark_runner.conformance import (
    CONFORMANCE_CHECKS,
    assert_processor_conforms,
    make_probe_asset,
)
from ipw.contracts.failure import FailureCategory
from ipw.contracts.measurement import Estimate
from ipw.contracts.operation import (
    FAMILY_OF,
    AnySettings,
    NoopSettings,
    Operation,
    OperationFamily,
    ProcessingVariant,
)
from ipw.contracts.processor import Processor, Support
from ipw.contracts.runtime import InputRef, RunContext, workspace
from ipw.processors.base import (
    guarded_estimate,
    guarded_inspect,
    guarded_process,
    guarded_supports,
)
from ipw.processors.fake import FakeBehaviour, FakeProcessor

NOOP = Operation.build(NoopSettings(), ProcessingVariant.ORIGINAL_CONTROL)


class TestConformanceSuite:
    def test_well_behaved_processor_conforms(self, tmp_path: Path) -> None:
        ran = assert_processor_conforms(FakeProcessor, tmp_path)
        assert ran == CONFORMANCE_CHECKS

    def test_suite_covers_every_declared_check(self) -> None:
        assert len(set(CONFORMANCE_CHECKS)) == len(CONFORMANCE_CHECKS)
        assert "process_preserves_original" in CONFORMANCE_CHECKS
        assert "cancellation_honoured" in CONFORMANCE_CHECKS

    def test_a_processor_that_lies_about_support_is_caught(self, tmp_path: Path) -> None:
        """A processor claiming to reject everything but still succeeding must fail."""

        class LyingProcessor(FakeProcessor):
            def supports(self, operation: Operation, settings: object) -> Support:
                from ipw.contracts.failure import FailureCode, failure

                return Support.no(
                    failure(
                        FailureCode.PROCESSOR_OPERATION_UNSUPPORTED,
                        FailureCategory.UNSUPPORTED_FEATURE,
                        "claims to be unsupported",
                    )
                )

        with pytest.raises(AssertionError, match="supports\\(\\) rejected"):
            assert_processor_conforms(LyingProcessor, tmp_path)


class TestOriginalPreservation:
    def test_a_hostile_processor_that_mutates_the_original_is_detected(
        self, tmp_path: Path, ctx: RunContext
    ) -> None:
        """D-006 is enforced by the guard, not by trusting the adapter."""
        ref = make_probe_asset(tmp_path / "assets")
        processor = FakeProcessor(behaviour=FakeBehaviour.MUTATES_ORIGINAL)

        with workspace(ctx.temp_root, "t") as ws:
            outcome = guarded_process(processor, ref, NOOP, NOOP.settings, ws, ctx)

        assert not outcome.succeeded
        assert outcome.failure is not None
        assert outcome.failure.code.value == "SAFETY.ORIGINAL_MUTATED"
        assert outcome.failure.next_action.value == "contact_support"

    def test_a_well_behaved_processor_leaves_the_original_intact(
        self, tmp_path: Path, ctx: RunContext
    ) -> None:
        ref = make_probe_asset(tmp_path / "assets")
        before = ref.compute_sha256()

        with workspace(ctx.temp_root, "t") as ws:
            guarded_process(FakeProcessor(), ref, NOOP, NOOP.settings, ws, ctx)

        assert ref.compute_sha256() == before

    def test_input_ref_exposes_no_writable_handle(self, tmp_path: Path) -> None:
        ref = make_probe_asset(tmp_path / "assets")
        public = {name for name in dir(ref) if not name.startswith("_")}
        assert "path" not in public, "InputRef must not expose a path attribute"
        assert {"open_readonly", "read_bytes", "compute_sha256"} <= public

    def test_input_ref_repr_does_not_leak_the_path(self, tmp_path: Path) -> None:
        ref = make_probe_asset(tmp_path / "assets")
        assert str(tmp_path) not in repr(ref)

    def test_read_ceiling_blocks_an_oversized_in_memory_read(self, tmp_path: Path) -> None:
        from ipw.contracts.runtime import InputRef

        probe = make_probe_asset(tmp_path / "assets")
        tiny = InputRef(
            asset_id="tiny-ceiling",
            expected_sha256=probe.expected_sha256,
            path=tmp_path / "assets" / "probe.png",
            declared_bytes=probe.declared_bytes,
            max_read_bytes=4,
        )
        with pytest.raises(ValueError, match="ceiling"):
            tiny.read_bytes()


class TestBoundaryNormalisation:
    def test_an_exception_never_escapes_process(self, tmp_path: Path, ctx: RunContext) -> None:
        ref = make_probe_asset(tmp_path / "assets")
        processor = FakeProcessor(behaviour=FakeBehaviour.RAISES_EXCEPTION)

        with workspace(ctx.temp_root, "t") as ws:
            outcome = guarded_process(processor, ref, NOOP, NOOP.settings, ws, ctx)

        assert not outcome.succeeded
        assert outcome.failure is not None
        assert outcome.failure.code.value == "PROCESSOR.INTERNAL_ERROR"
        assert outcome.failure.category is FailureCategory.PERMANENT_PROCESSING

    def test_an_exception_never_escapes_inspect(self, tmp_path: Path, ctx: RunContext) -> None:
        ref = make_probe_asset(tmp_path / "assets")
        result = guarded_inspect(FakeProcessor(behaviour=FakeBehaviour.RAISES_EXCEPTION), ref, ctx)

        assert not result.accepted
        assert result.failure is not None
        assert result.failure.code.value == "PROCESSOR.INTERNAL_ERROR"

    def test_a_broken_estimator_degrades_instead_of_raising(
        self, tmp_path: Path, ctx: RunContext
    ) -> None:
        class BrokenEstimator(FakeProcessor):
            def estimate(
                self,
                ref: InputRef,
                operation: Operation,
                settings: AnySettings,
                ctx: RunContext,
            ) -> Estimate:
                msg = "estimator exploded"
                raise RuntimeError(msg)

        ref = make_probe_asset(tmp_path / "assets")
        estimate = guarded_estimate(BrokenEstimator(), ref, NOOP, NOOP.settings, ctx)
        assert estimate.estimated_duration_ns == 0
        assert estimate.notes is not None

    def test_a_broken_supports_is_reported_not_raised(self) -> None:
        class BrokenSupports(FakeProcessor):
            def supports(self, operation: Operation, settings: object) -> Support:
                msg = "supports exploded"
                raise RuntimeError(msg)

        supported, failure = guarded_supports(BrokenSupports(), NOOP, NOOP.settings)
        assert supported is False
        assert failure is not None
        assert failure.code.value == "PROCESSOR.INTERNAL_ERROR"

    def test_an_unreadable_original_is_reported_as_invalid_input(
        self, tmp_path: Path, ctx: RunContext
    ) -> None:
        """Regression: the pre/post hash check reads from disk and can raise OSError.

        Caught by the conformance suite during POC-001. Before the fix, a missing
        original escaped guarded_process as a FileNotFoundError - which would have
        aborted a whole batch instead of isolating one item.
        """
        missing = InputRef(
            asset_id="absent-asset",
            expected_sha256="0" * 64,
            path=tmp_path / "nowhere" / "absent.bin",
            declared_bytes=0,
        )
        with workspace(ctx.temp_root, "t") as ws:
            outcome = guarded_process(FakeProcessor(), missing, NOOP, NOOP.settings, ws, ctx)

        assert not outcome.succeeded
        assert outcome.failure is not None
        assert outcome.failure.code.value == "MANIFEST.ASSET_FILE_MISSING"
        assert outcome.failure.category is FailureCategory.INVALID_INPUT

        inspection = guarded_inspect(FakeProcessor(), missing, ctx)
        assert not inspection.accepted
        assert inspection.failure is not None
        assert inspection.failure.code.value == "MANIFEST.ASSET_FILE_MISSING"

    def test_failure_messages_carry_no_exception_payload(
        self, tmp_path: Path, ctx: RunContext
    ) -> None:
        """Only the exception type is recorded, never its message or a traceback."""
        ref = make_probe_asset(tmp_path / "assets")
        with workspace(ctx.temp_root, "t") as ws:
            outcome = guarded_process(
                FakeProcessor(behaviour=FakeBehaviour.RAISES_EXCEPTION),
                ref,
                NOOP,
                NOOP.settings,
                ws,
                ctx,
            )
        assert outcome.failure is not None
        assert "configured to raise" not in outcome.failure.message
        assert outcome.failure.context["exception_type"] == "RuntimeError"


class TestCancellation:
    def test_a_cancelled_context_prevents_success(self, tmp_path: Path, ctx: RunContext) -> None:
        ref = make_probe_asset(tmp_path / "assets")
        ctx.cancellation.cancel()

        with workspace(ctx.temp_root, "t") as ws:
            outcome = guarded_process(FakeProcessor(), ref, NOOP, NOOP.settings, ws, ctx)

        assert not outcome.succeeded
        assert outcome.failure is not None
        assert outcome.failure.category is FailureCategory.CANCELLED
        assert outcome.failure.retryable is True

    def test_a_slow_processor_observes_the_token(self, tmp_path: Path, ctx: RunContext) -> None:
        ref = make_probe_asset(tmp_path / "assets")
        processor = FakeProcessor(behaviour=FakeBehaviour.SLOW_CANCELLABLE)
        ctx.cancellation.cancel()

        with workspace(ctx.temp_root, "t") as ws:
            outcome = guarded_process(processor, ref, NOOP, NOOP.settings, ws, ctx)

        assert outcome.failure is not None
        assert outcome.failure.code.value == "PROCESSOR.CANCELLED"


class TestSafetyDecision:
    def test_inspection_can_reject_before_any_work(self, tmp_path: Path, ctx: RunContext) -> None:
        ref = make_probe_asset(tmp_path / "assets")
        result = guarded_inspect(
            FakeProcessor(behaviour=FakeBehaviour.SAFETY_LIMIT_AT_INSPECT), ref, ctx
        )

        assert not result.accepted
        assert result.failure is not None
        assert result.failure.category is FailureCategory.SAFETY_LIMIT
        assert "excessive_pixels" in [flag.value for flag in result.risk_flags]

    def test_poc_001_never_decodes_an_image(self, tmp_path: Path, ctx: RunContext) -> None:
        ref = make_probe_asset(tmp_path / "assets")
        result = guarded_inspect(FakeProcessor(), ref, ctx)
        assert result.inspected_without_decoding is True, (
            "POC-001 validates declared metadata only; decoding arrives in POC-003"
        )


class TestFakeProcessorScope:
    """The reference implementation must stay inside the standard family."""

    def test_the_fake_processor_declares_no_ai_operation(self) -> None:
        identity = FakeProcessor().describe()
        assert identity.family is OperationFamily.STANDARD
        assert all(FAMILY_OF[k] is not OperationFamily.AI for k in identity.supported_operations)

    def test_the_fake_processor_satisfies_the_protocol(self) -> None:
        assert isinstance(FakeProcessor(), Processor)

    def test_identity_is_stable_between_calls(self) -> None:
        processor = FakeProcessor()
        assert processor.describe() == processor.describe()
