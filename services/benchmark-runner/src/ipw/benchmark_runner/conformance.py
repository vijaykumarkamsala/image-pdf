"""Reusable processor-contract conformance suite.

This module is the durable deliverable of POC-001. When POC-006 adds the first
real adapter, its test file is three lines::

    from ipw.benchmark_runner.conformance import assert_processor_conforms

    def test_real_esrgan_conforms(tmp_path):
        assert_processor_conforms(lambda: RealEsrganAdapter(...), tmp_path)

Every check below expresses a product invariant, not a style preference:

======================================  ==================================================
``identity_complete``                   AGENTS.md reproducibility rules
``identity_stable``                     the same processor must describe itself identically
``ai_declares_weights``                 no AI processor without a pinned weight hash
``supports_agrees_with_process``        no crash-to-discover-unsupported
``rejects_foreign_settings``            settings and operation cannot disagree
``inspect_preserves_original``          D-006
``process_preserves_original``          D-006
``exceptions_never_escape``             one failure must not fail a batch
``workspace_removed_on_all_paths``      AGENTS.md temporary-artifact rule
``cancellation_honoured``               Gate D
``deterministic_output_is_repeatable``  benchmark comparability
``successful_output_is_measured``       a result with no measurement cannot be compared
======================================  ==================================================
"""

from __future__ import annotations

import struct
import zlib
from collections.abc import Callable
from pathlib import Path

from ipw.contracts.operation import (
    AnySettings,
    NoopSettings,
    Operation,
    OperationFamily,
    OperationKind,
    ProcessingVariant,
    SuperResolutionSettings,
)
from ipw.contracts.processor import Processor
from ipw.contracts.runtime import InputRef, RunContext, workspace
from ipw.processors.base import guarded_inspect, guarded_process, guarded_supports

__all__ = ["CONFORMANCE_CHECKS", "assert_processor_conforms", "make_probe_asset"]

ProcessorFactory = Callable[[], Processor]

CONFORMANCE_CHECKS: tuple[str, ...] = (
    "identity_complete",
    "identity_stable",
    "ai_declares_weights",
    "supports_agrees_with_process",
    "rejects_foreign_settings",
    "inspect_preserves_original",
    "process_preserves_original",
    "exceptions_never_escape",
    "workspace_removed_on_all_paths",
    "cancellation_honoured",
    "deterministic_output_is_repeatable",
    "successful_output_is_measured",
)

# The eight bytes every PNG starts with. Spelled as octets rather than an
# escaped literal so the constant is legible and survives any tooling that
# rewrites backslashes.
PNG_SIGNATURE = bytes((0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))


def _tiny_png(width: int = 16, height: int = 16) -> bytes:
    """A deterministic 16x16 RGB PNG, built from the standard library.

    Written by hand rather than with Pillow so this suite stays importable
    wherever the contract is - the benchmark runner must not acquire an imaging
    dependency just to describe what a processor owes its caller.

    The gradient is not uniform on purpose. A flat image would make several
    checks below pass without doing anything: a resize of one colour is that
    colour, and a "deterministic output" assertion over a constant is free.
    """
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # per-scanline filter type: None
        for x in range(width):
            raw += bytes(((x * 16) % 256, (y * 16) % 256, ((x + y) * 8) % 256))

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    return (
        PNG_SIGNATURE
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


PROBE_BYTES = _tiny_png()
"""The probe asset is a real, decodable image.

It was a short ASCII string until POC-006, which was a defect rather than a
simplification: every image processor refused it at inspection, so the
*successful* half of the contract - deterministic bytes, populated measurement,
workspace removal after a real write - was only ever asserted vacuously. The
suite reported eleven passing checks while exercising the failure paths alone.
"""


def make_probe_asset(directory: Path, name: str = "probe.png") -> InputRef:
    """Write the probe image and return a read-only reference to it."""
    import hashlib

    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    path.write_bytes(PROBE_BYTES)
    return InputRef(
        asset_id="conformance-probe",
        expected_sha256=hashlib.sha256(PROBE_BYTES).hexdigest(),
        path=path,
        declared_bytes=len(PROBE_BYTES),
    )


def _supported_operation(processor: Processor) -> Operation | None:
    """Build an operation the processor claims to support, preferring a cheap one."""
    identity = processor.describe()
    for kind in (OperationKind.NOOP, OperationKind.INSPECT_ONLY):
        if kind in identity.supported_operations:
            return Operation.build(NoopSettings(), ProcessingVariant.ORIGINAL_CONTROL)
    if OperationKind.SUPER_RESOLUTION in identity.supported_operations:
        # Ask rather than assume. Super-resolution weights are trained at one
        # native scale, and presenting a resized x4 result as x2 is exactly the
        # misreporting the benchmark plan forbids - so the suite negotiates the
        # scale the processor actually implements instead of guessing x2.
        for scale in (2, 4):
            candidate = Operation.build(
                SuperResolutionSettings(scale=scale), ProcessingVariant.AI_NATURAL
            )
            accepted, _ = guarded_supports(processor, candidate, candidate.settings)
            if accepted:
                return candidate
        return Operation.build(SuperResolutionSettings(scale=2), ProcessingVariant.AI_NATURAL)
    return None


def assert_processor_conforms(factory: ProcessorFactory, tmp_dir: Path) -> tuple[str, ...]:
    """Run every conformance check. Raises ``AssertionError`` on the first violation.

    Returns the names of the checks that ran, so a caller can assert coverage.
    """
    passed: list[str] = []
    processor = factory()

    # ------------------------------------------------------------ identity --
    identity = processor.describe()
    assert identity.name, "processor identity must have a name"
    assert identity.version, "processor identity must have a version"
    assert identity.supported_operations, "processor must declare at least one operation"
    assert identity.runtime.language_version, "runtime language version must be recorded"
    passed.append("identity_complete")

    assert processor.describe() == identity, (
        "describe() must be stable: a processor that reports different identities between "
        "calls cannot produce comparable benchmark results"
    )
    passed.append("identity_stable")

    if identity.family is OperationFamily.AI:
        assert identity.weights is not None, "an AI processor must declare its weights"
        assert identity.weights.sha256, "an AI processor must record its weight hash"
    passed.append("ai_declares_weights")

    # --------------------------------------------------------------- setup --
    ref = make_probe_asset(tmp_dir / "assets")
    ctx = RunContext.create(temp_root=tmp_dir / "tmp", deterministic=True)
    operation = _supported_operation(processor)
    assert operation is not None, (
        "conformance needs an operation the processor supports; declare noop, inspect_only "
        "or super_resolution, or extend _supported_operation"
    )

    # -------------------------------------------- supports agrees with process --
    supported, support_failure = guarded_supports(processor, operation, operation.settings)
    if not supported:
        assert support_failure is not None, "an unsupported combination must explain itself"
        with workspace(ctx.temp_root, "conf") as ws:
            outcome = guarded_process(processor, ref, operation, operation.settings, ws, ctx)
        assert not outcome.succeeded, (
            "process() succeeded for a combination supports() rejected; the two must agree"
        )
    passed.append("supports_agrees_with_process")

    foreign: AnySettings = (
        SuperResolutionSettings(scale=4)
        if operation.kind is not OperationKind.SUPER_RESOLUTION
        else NoopSettings()
    )
    mismatch, mismatch_failure = guarded_supports(processor, operation, foreign)
    assert not mismatch, "settings that do not match the operation must be rejected"
    assert mismatch_failure is not None, "a rejection must carry a normalised failure"
    passed.append("rejects_foreign_settings")

    # ------------------------------------------------ original preservation --
    before = ref.compute_sha256()
    guarded_inspect(processor, ref, ctx)
    assert ref.compute_sha256() == before, "inspect() must not modify the original"
    passed.append("inspect_preserves_original")

    with workspace(ctx.temp_root, "conf") as ws:
        first = guarded_process(processor, ref, operation, operation.settings, ws, ctx)
    assert ref.compute_sha256() == before, "process() must not modify the original"
    passed.append("process_preserves_original")

    # ------------------------------------------------ exception containment --
    missing = InputRef(
        asset_id="conformance-missing",
        expected_sha256="0" * 64,
        path=tmp_dir / "assets" / "does-not-exist.bin",
        declared_bytes=0,
    )
    with workspace(ctx.temp_root, "conf") as ws:
        hostile = guarded_process(processor, missing, operation, operation.settings, ws, ctx)
    assert not hostile.succeeded, "processing a missing input must not report success"
    assert hostile.failure is not None, "a failed outcome must carry a normalised failure"
    passed.append("exceptions_never_escape")

    # ------------------------------------------------------- workspace life --
    captured: list[Path] = []
    with workspace(ctx.temp_root, "conf") as ws:
        captured.append(ws.root)
        guarded_process(processor, ref, operation, operation.settings, ws, ctx)
    assert not captured[0].exists(), "the workspace must be removed after a successful call"

    try:
        with workspace(ctx.temp_root, "conf") as ws:
            captured.append(ws.root)
            msg = "deliberate failure inside a workspace"
            raise RuntimeError(msg)
    except RuntimeError:
        pass
    assert not captured[1].exists(), "the workspace must be removed after an exception"
    passed.append("workspace_removed_on_all_paths")

    # -------------------------------------------------------- cancellation --
    cancel_ctx = RunContext.create(temp_root=tmp_dir / "tmp-cancel", deterministic=True)
    cancel_ctx.cancellation.cancel()
    with workspace(cancel_ctx.temp_root, "conf") as ws:
        cancelled = guarded_process(processor, ref, operation, operation.settings, ws, cancel_ctx)
    assert not cancelled.succeeded, "a cancelled call must not report success"
    passed.append("cancellation_honoured")

    # --------------------------------------------------------- determinism --
    if identity.deterministic_output and first.succeeded:
        with workspace(ctx.temp_root, "conf") as ws:
            second = guarded_process(processor, ref, operation, operation.settings, ws, ctx)
        assert second.succeeded, "a deterministic processor must succeed repeatably"
        assert first.output is not None
        assert second.output is not None
        assert first.output.sha256 == second.output.sha256, (
            "a processor declaring deterministic_output must produce identical bytes for "
            "identical input and settings"
        )
    passed.append("deterministic_output_is_repeatable")

    # ---------------------------------------------------------- measurement --
    # Only meaningful when the probe was actually processed. Before POC-006 the
    # probe was not a decodable image, so this branch never ran for any real
    # processor and the suite was quietly grading only failure behaviour.
    if first.succeeded:
        assert first.output is not None, "a successful outcome must carry its output"
        assert len(first.output.sha256) == 64, "the output must be identified by digest"
        assert first.output.bytes_written > 0, "a successful outcome must have written bytes"
        assert first.output.media_type, "the output media type must be recorded"
        timing = first.measurement.timing
        assert timing.total_ns >= 0, "timing must be recorded"
        assert timing.total_ns >= timing.inference_ns, (
            "total elapsed time cannot be smaller than the inference it contains"
        )
        assert first.measurement.input_bytes > 0, "input size must be recorded for comparison"
    passed.append("successful_output_is_measured")

    assert tuple(passed) == CONFORMANCE_CHECKS, (
        f"conformance check list drifted: ran {passed}, expected {list(CONFORMANCE_CHECKS)}"
    )
    return tuple(passed)
