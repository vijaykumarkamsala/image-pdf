"""Commercial licence dispositions and purpose-based gating.

The gate binds to **what a run is for**, not to whether a model was downloaded
(decision D-038). Evaluating a model in order to decide whether to pursue a
licence is normal internal research use; requiring clearance first would mean
negotiating terms for models of unmeasured quality.

.. list-table:: Gate matrix (D-038)
   :header-rows: 1

   * - Disposition
     - local_research
     - internal_benchmark
     - public_demo
     - staging
     - production
   * - ``approved``
     - yes
     - yes
     - yes
     - yes
     - yes
   * - ``review_required``
     - yes
     - yes, marked
     - no
     - no
     - no
   * - ``non_commercial``
     - yes
     - yes, reference-only
     - no
     - no
     - no
   * - ``unknown``
     - yes
     - yes, marked
     - no
     - no
     - no
   * - ``blocked``
     - no
     - no
     - no
     - no
     - no

Two things this module does **not** relax:

* **Gate B (D-039)** — official source, pinned version, verified weight hash and
  a disabled inference-time network are required at *every* purpose level,
  including ``local_research``. Loading a pickled checkpoint is arbitrary code
  execution on a developer machine; that risk is identical before and after
  shipping. :meth:`LicenceDisposition.supply_chain_gaps` reports what is missing.
* **Dependency inheritance** — a component is never more permissive than the
  least permissive component it executes. A permissively licensed wrapper does
  not launder a restrictive weight (AGENTS.md: "Do not assume a wrapper licence
  covers bundled/downloaded weights").
"""

from __future__ import annotations

from collections.abc import Iterable
from enum import StrEnum

from pydantic import Field, model_validator

from ipw.contracts.common import ContractModel, NonEmptyStr, Sha256Hex, SlugId
from ipw.contracts.failure import NormalizedFailure

__all__ = [
    "COMMERCIAL_PURPOSES",
    "ComponentKind",
    "Disposition",
    "GateDecision",
    "LicenceDisposition",
    "RunPurpose",
    "WeightFormat",
    "is_permitted",
    "least_permissive",
]


class ComponentKind(StrEnum):
    """What is being licensed. Each is reviewed separately, never together."""

    CODE = "code"
    WEIGHTS = "weights"
    DEPENDENCY = "dependency"
    DATASET = "dataset"
    SERVICE = "service"


class Disposition(StrEnum):
    """Commercial standing of one component.

    ``UNKNOWN`` is the default and is deliberately *not* a synonym for "probably
    fine": it permits research but blocks every commercial purpose.
    """

    APPROVED = "approved"
    REVIEW_REQUIRED = "review_required"
    NON_COMMERCIAL = "non_commercial"
    UNKNOWN = "unknown"
    BLOCKED = "blocked"


class RunPurpose(StrEnum):
    """What a run is for. This is the axis the gate turns on (D-038)."""

    LOCAL_RESEARCH = "local_research"
    """Developer machine, rights-cleared inputs, outputs never leave the repository."""

    INTERNAL_BENCHMARK = "internal_benchmark"
    """Recorded results feeding the POC report. Seen internally only."""

    PUBLIC_DEMO = "public_demo"
    """Outputs shown outside the company. Commercial use begins here."""

    STAGING = "staging"
    """Deployed and processing real inputs."""

    PRODUCTION = "production"
    """Customer-facing and commercial."""


COMMERCIAL_PURPOSES: frozenset[RunPurpose] = frozenset(
    {RunPurpose.PUBLIC_DEMO, RunPurpose.STAGING, RunPurpose.PRODUCTION}
)
"""Purposes that constitute commercial use and therefore require ``approved``."""

RESEARCH_PURPOSES: frozenset[RunPurpose] = frozenset(
    {RunPurpose.LOCAL_RESEARCH, RunPurpose.INTERNAL_BENCHMARK}
)

_PERMISSIVENESS: dict[Disposition, int] = {
    Disposition.BLOCKED: 0,
    Disposition.UNKNOWN: 1,
    Disposition.NON_COMMERCIAL: 2,
    Disposition.REVIEW_REQUIRED: 3,
    Disposition.APPROVED: 4,
}


def least_permissive(dispositions: Iterable[Disposition]) -> Disposition:
    """Return the most restrictive disposition in an iterable.

    Used for dependency inheritance: a component executing a blocked dependency is
    itself blocked, no matter what its own licence says. An empty iterable yields
    ``UNKNOWN`` — the absence of information is never treated as approval.
    """
    items = list(dispositions)
    if not items:
        return Disposition.UNKNOWN
    return min(items, key=_PERMISSIVENESS.__getitem__)


def is_permitted(disposition: Disposition, purpose: RunPurpose) -> bool:
    """Apply the D-038 gate matrix."""
    if disposition is Disposition.BLOCKED:
        return False
    if purpose in COMMERCIAL_PURPOSES:
        return disposition is Disposition.APPROVED
    return True


class WeightFormat(StrEnum):
    """Serialisation format of a weight file.

    ``PICKLE`` covers ``.pth``/``.pt``/``.ckpt``: loading one executes arbitrary
    code. Permitted only inside an isolated container with no network (D-039).

    ``TRAINEDDATA`` is Tesseract's own container - an indexed bundle of a
    character set, dictionaries and LSTM weights. It is listed separately rather
    than folded into ``NOT_APPLICABLE`` because it *is* a weight file and its
    provenance matters exactly as much as any other model's; and separately from
    ``PICKLE`` because parsing one does not execute code, so it does not carry
    that format's isolation requirement.
    """

    SAFETENSORS = "safetensors"
    ONNX = "onnx"
    PICKLE = "pickle"
    TRAINEDDATA = "traineddata"
    NOT_APPLICABLE = "not_applicable"


class LicenceDisposition(ContractModel):
    """One reviewed component: its commercial standing and its supply chain."""

    component_id: SlugId
    display_name: NonEmptyStr
    kind: ComponentKind
    disposition: Disposition = Disposition.UNKNOWN

    reference_only: bool = Field(
        default=False,
        description="Executable for research comparison but never eligible for a commercial "
        "recommendation, regardless of disposition. SUPIR is the motivating case.",
    )

    # -- commercial review ------------------------------------------------
    licence_id: str | None = Field(
        default=None, description="SPDX identifier where one exists, e.g. 'BSD-3-Clause'."
    )
    licence_text_url: str | None = None
    required_notices: tuple[str, ...] = ()
    commercial_permission_reference: str | None = Field(
        default=None,
        description="Where written commercial permission is recorded, when the licence itself "
        "does not grant it.",
    )

    # -- Gate B: supply chain, required at every purpose level (D-039) -----
    official_source: str | None = Field(
        default=None, description="Official repository or vendor URL. Never a mirror."
    )
    pinned_version: str | None = Field(
        default=None, description="Exact released version, tag or commit SHA."
    )
    weights_sha256: Sha256Hex | None = None
    weight_format: WeightFormat = WeightFormat.NOT_APPLICABLE
    download_requires_terms_acceptance: bool = Field(
        default=False,
        description="True for gated downloads. Accepting the terms IS entering the licence, so "
        "what was accepted must be recorded in accepted_terms_reference.",
    )
    accepted_terms_reference: str | None = None
    network_disabled_at_inference: bool = Field(
        default=True,
        description="Gate B requires inference-time network access to be disabled unless the "
        "operation explicitly needs it.",
    )

    # -- dependency inheritance -------------------------------------------
    depends_on: tuple[SlugId, ...] = Field(
        default=(),
        description="Component ids whose dispositions this component inherits. A component is "
        "never more permissive than the least permissive component it executes.",
    )

    # -- audit ------------------------------------------------------------
    reviewed_by: str | None = None
    reviewed_on: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    evidence: str | None = Field(
        default=None, description="Where the reviewer read the terms. Auditable, not hearsay."
    )
    notes: str | None = None

    @model_validator(mode="after")
    def _approved_requires_evidence(self) -> LicenceDisposition:
        if self.disposition is Disposition.APPROVED and not (self.licence_id or self.evidence):
            msg = (
                f"{self.component_id}: an 'approved' disposition requires a licence_id or "
                f"recorded evidence. Approval must be auditable, never asserted."
            )
            raise ValueError(msg)
        if self.download_requires_terms_acceptance and not self.accepted_terms_reference:
            msg = (
                f"{self.component_id}: the download is gated behind terms acceptance, so "
                f"accepted_terms_reference must record exactly what was accepted (D-039)."
            )
            raise ValueError(msg)
        return self

    # -- queries ----------------------------------------------------------

    def supply_chain_gaps(self) -> tuple[str, ...]:
        """Missing Gate B requirements. Empty means the component may be executed.

        Applies at **every** purpose level, including local research: this is
        about arbitrary code execution on a developer machine, not commerce.
        """
        gaps: list[str] = []
        if not self.official_source:
            gaps.append("official_source is not recorded")

        # A dataset is registered for the *restrictions it propagates*, never
        # because anything here executes it. Nothing downloads it, unpickles it or
        # gives it network access, so the execution-shaped requirements below are a
        # category error when applied to one - "pin the version you execute" has no
        # answer for a component that is never executed (D-058, POC-007).
        #
        # This was invisible until POC-007 registered two datasets whose pages
        # state no edition. The datasets already recorded passed Gate B only
        # because a plausible year had been typed into the field, which is not a
        # supply-chain control - it is a habit that looks like one.
        #
        # The restriction a dataset carries still propagates in full: its
        # disposition flows through Gate A inheritance exactly as before, which is
        # the entire reason datasets are in the register.
        if self.kind is ComponentKind.DATASET:
            return tuple(gaps)

        if not self.pinned_version:
            gaps.append("pinned_version is not recorded")
        if self.kind is ComponentKind.WEIGHTS:
            if not self.weights_sha256:
                gaps.append("weights_sha256 is not recorded")
            if self.weight_format is WeightFormat.NOT_APPLICABLE:
                gaps.append("weight_format is not declared")
        if not self.network_disabled_at_inference:
            gaps.append("inference-time network access is not disabled")
        return tuple(gaps)

    def is_permitted_for(self, purpose: RunPurpose) -> bool:
        """Whether this component alone permits ``purpose``. Ignores dependencies."""
        if self.reference_only and purpose in COMMERCIAL_PURPOSES:
            return False
        return is_permitted(self.disposition, purpose)

    @property
    def is_commercially_eligible(self) -> bool:
        return self.disposition is Disposition.APPROVED and not self.reference_only


class GateDecision(ContractModel):
    """Outcome of applying the gates for one purpose.

    Recorded on every run. ``markings`` travel with the results, which is what
    makes it impossible for a reference-only run to be quietly re-presented as a
    production recommendation.
    """

    purpose: RunPurpose
    permitted: bool
    effective_disposition: Disposition
    reference_only: bool = False
    markings: tuple[str, ...] = ()
    failures: tuple[NormalizedFailure, ...] = ()
    warnings: tuple[NormalizedFailure, ...] = ()

    @property
    def eligible_for_commercial_recommendation(self) -> bool:
        return (
            self.permitted
            and not self.reference_only
            and self.effective_disposition is Disposition.APPROVED
        )
