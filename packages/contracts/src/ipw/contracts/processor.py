"""The internal processor contract.

AGENTS.md "Interface Direction" requires every processor to converge on::

    inspect(input)                       -> metadata and safety decision
    estimate(input, operation, settings) -> time/cost/memory estimate
    process(input, operation, settings)  -> result and measured metrics

This module is that contract. Benchmark orchestration depends only on this
Protocol, never on Real-ESRGAN, SwinIR or an external vendor.

Design decisions, and why
-------------------------
* **Protocol, not a base class.** A POC-006 adapter wrapping vendor code must not
  be forced to inherit from our tree. Conformance is proved by
  ``ipw.benchmark_runner.conformance``, not by inheritance.
* **``process`` returns an outcome; it never raises across the boundary.**
  ``ipw.processors.base`` normalises anything that escapes. This is what makes
  "one failed input must not fail an entire batch" structurally true.
* **``supports`` is separate from ``process``.** Orchestration can skip an
  unsupported combination with a clean normalised failure instead of discovering
  it via a crash mid-batch.
* **Cancellation and workspace are in the signature from day one**, so Gate D
  ("safe cancellation and timeouts", isolated temporary storage) does not require
  rewriting every adapter later.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from pydantic import Field, model_validator

from ipw.contracts.common import (
    ContractModel,
    NonEmptyStr,
    NonNegInt,
    SafeInt,
    Sha256Hex,
    SlugId,
)
from ipw.contracts.failure import NormalizedFailure
from ipw.contracts.measurement import Estimate, Measurement
from ipw.contracts.operation import (
    AnySettings,
    Operation,
    OperationFamily,
    OperationKind,
)
from ipw.contracts.runtime import InputRef, RunContext, Workspace
from ipw.contracts.safety import InspectionResult

# ------------------------------------------------------------------ identity --


class RuntimeIdentity(ContractModel):
    """Exact runtime a processor executes in.

    Recorded per AGENTS.md reproducibility rules: "Runtime and dependency
    versions". Two results are only comparable when this matches or the
    difference is stated.
    """

    language: NonEmptyStr = "python"
    language_version: NonEmptyStr
    framework: str | None = None
    framework_version: str | None = None
    container_image: str | None = None
    container_digest: Sha256Hex | None = None
    dependency_lock_digest: str | None = Field(
        default=None, description="Digest of the pinned dependency set actually installed."
    )


class WeightsIdentity(ContractModel):
    """Exact model weights. Never optional for an AI processor."""

    name: NonEmptyStr
    sha256: Sha256Hex
    source_url: NonEmptyStr
    pinned_version: str | None = None
    pinned_commit: str | None = None
    licence_ref: SlugId | None = None


class ProcessorIdentity(ContractModel):
    """Everything needed to reproduce and to licence-check a processor."""

    name: SlugId
    version: NonEmptyStr
    family: OperationFamily
    runtime: RuntimeIdentity
    weights: WeightsIdentity | None = None

    precision: str = Field(default="na", pattern=r"^(fp32|fp16|bf16|int8|na)$")
    tile_size: SafeInt | None = None
    tile_overlap: SafeInt | None = None

    requires_network: bool = Field(
        default=False,
        description="Gate B requires inference-time network access to be disabled unless "
        "explicitly required. POC-001 records the declaration; POC-006 enforces it.",
    )
    deterministic_output: bool = Field(
        default=False,
        description="False means output may vary between identical runs. Such results must be "
        "labelled nondeterministic in every report (AGENTS.md reproducibility rules).",
    )
    supported_operations: tuple[OperationKind, ...] = Field(min_length=1)
    licence_ref: SlugId | None = None

    @model_validator(mode="after")
    def _ai_requires_weights(self) -> ProcessorIdentity:
        if self.family is OperationFamily.AI and self.weights is None:
            msg = "an AI processor must declare its weights identity, including a weight hash"
            raise ValueError(msg)
        return self


# ------------------------------------------------------------------ outcomes --


class Support(ContractModel):
    """Whether a processor accepts an operation and settings combination."""

    supported: bool
    failure: NormalizedFailure | None = None

    @model_validator(mode="after")
    def _consistent(self) -> Support:
        if self.supported and self.failure is not None:
            msg = "a supported combination must not carry a failure"
            raise ValueError(msg)
        if not self.supported and self.failure is None:
            msg = "an unsupported combination must explain itself with a normalised failure"
            raise ValueError(msg)
        return self

    @classmethod
    def ok(cls) -> Support:
        return cls(supported=True, failure=None)

    @classmethod
    def no(cls, failure: NormalizedFailure) -> Support:
        return cls(supported=False, failure=failure)


class OutputArtifact(ContractModel):
    """A derivative produced by processing. Never an original."""

    relative_path: NonEmptyStr = Field(description="Path relative to the workspace or output root.")
    sha256: Sha256Hex
    bytes_written: NonNegInt
    media_type: str
    width: SafeInt | None = None
    height: SafeInt | None = None
    is_preview: bool = Field(
        default=False,
        description="True unless the output explicitly qualifies as a final result. Browser "
        "output is a preview unless explicitly eligible (AGENTS.md product invariants).",
    )


class ProcessOutcome(ContractModel):
    """The result of one ``process`` call. Success and failure are both normal."""

    succeeded: bool
    output: OutputArtifact | None = None
    measurement: Measurement = Measurement()
    failure: NormalizedFailure | None = None
    nondeterministic: bool = False
    notes: str | None = None

    @model_validator(mode="after")
    def _consistent(self) -> ProcessOutcome:
        if self.succeeded and self.failure is not None:
            msg = "a successful outcome must not carry a failure"
            raise ValueError(msg)
        if not self.succeeded and self.failure is None:
            msg = "a failed outcome must carry a normalised failure"
            raise ValueError(msg)
        return self

    @classmethod
    def success(
        cls,
        output: OutputArtifact | None,
        measurement: Measurement,
        *,
        nondeterministic: bool = False,
        notes: str | None = None,
    ) -> ProcessOutcome:
        return cls(
            succeeded=True,
            output=output,
            measurement=measurement,
            failure=None,
            nondeterministic=nondeterministic,
            notes=notes,
        )

    @classmethod
    def failed(
        cls, failure: NormalizedFailure, measurement: Measurement | None = None
    ) -> ProcessOutcome:
        return cls(
            succeeded=False,
            output=None,
            measurement=measurement or Measurement(),
            failure=failure,
            nondeterministic=False,
            notes=None,
        )


# ------------------------------------------------------------------ protocol --


@runtime_checkable
class Processor(Protocol):
    """The one contract every standard, AI and external-provider adapter implements."""

    def describe(self) -> ProcessorIdentity:
        """Return the processor's full reproducibility and licence identity."""
        ...

    def supports(self, operation: Operation, settings: AnySettings) -> Support:
        """Report whether this combination can be processed, without processing it."""
        ...

    def inspect(self, ref: InputRef, ctx: RunContext) -> InspectionResult:
        """Return input metadata and a safety decision. Must not modify the input."""
        ...

    def estimate(
        self, ref: InputRef, operation: Operation, settings: AnySettings, ctx: RunContext
    ) -> Estimate:
        """Predict duration, memory and cost. Must not process the input."""
        ...

    def process(
        self,
        ref: InputRef,
        operation: Operation,
        settings: AnySettings,
        ws: Workspace,
        ctx: RunContext,
    ) -> ProcessOutcome:
        """Produce a derivative and its measurements.

        Implementations write only inside ``ws`` and must treat ``ref`` as
        read-only. Raising is tolerated - ``ipw.processors.base`` normalises it -
        but returning a failed :class:`ProcessOutcome` is preferred.
        """
        ...
