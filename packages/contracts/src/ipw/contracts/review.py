"""Blinded human review: what reviewers see, what they record, and what it means.

POC-008. The benchmark plan is explicit that objective metrics do not settle
quality (section 8.1: "A sharper but invented face may score attractively while
being unacceptable"), so the deciding instrument is a human one - and a human
instrument needs the same care about bias that a numerical one needs about
calibration.

**The central tension is blinding against traceability.** A reviewer must not be
able to infer which model produced an image, and every score must remain
attributable to an exact run, processor version and weight digest. Those pull in
opposite directions, and the resolution is two identifiers rather than one:

``ReviewItem.label``
    What the reviewer sees: ``item-07``. Carries no information. Assigned by a
    seeded shuffle so the ordering is reproducible without being guessable from
    the item itself.

``SealedEntry``
    The provenance, in a separate document the reviewer never opens. Keyed by
    label, so scores join back to runs exactly.

Deriving the visible label from the provenance - a digest of the run id, say -
would look opaque and be trivially reversible here: there are three candidates,
so an attacker with the run documents could brute-force every label in
milliseconds. The shuffle seed lives in the sealed key precisely so that the
visible half contains nothing to attack.

**Critical failures are not low scores.** Section 8.3 lists eight conditions that
fail a result outright. A changed digit on an invoice is not "3 out of 5 on text
accuracy" - it is unusable, and no amount of attractiveness elsewhere redeems it.
The aggregation therefore treats them as a separate, dominant channel rather than
folding them into a mean, because a mean is exactly the operation that would let
an appealing result outvote its own unacceptability.

**Scores are integers, and stay integers.** Sums and counts are recorded rather
than means. A mean is derived for display only. Committing a float to an artifact
that is later compared byte-for-byte invites drift that has nothing to do with
the thing being measured.
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import Field, model_validator

from ipw.contracts.asset import AssetCategory
from ipw.contracts.common import ContractModel, DigestId, NonNegInt, Sha256Hex, SlugId
from ipw.contracts.licence import Disposition
from ipw.contracts.operation import OperationKind
from ipw.contracts.version import SCHEMA_VERSION

__all__ = [
    "CRITICAL_FAILURE_GUIDANCE",
    "TIE_THRESHOLD",
    "CriticalFailure",
    "ItemVerdict",
    "ReviewDimension",
    "ReviewItem",
    "ReviewPackage",
    "ReviewScore",
    "ReviewSummary",
    "SealedEntry",
    "SealedKey",
]


class ReviewDimension(StrEnum):
    """The ten dimensions from benchmark plan section 8.2, scored 1 to 5.

    Not every dimension applies to every result - identity preservation means
    nothing on a product photograph - so a score sheet carries the dimensions it
    was asked for rather than all ten, and the aggregation never invents a score
    for a dimension nobody was shown.
    """

    OVERALL_USEFULNESS = "overall_usefulness"
    NATURAL_APPEARANCE = "natural_appearance"
    DETAIL_IMPROVEMENT = "detail_improvement"
    IDENTITY_PRESERVATION = "identity_preservation"
    TEXT_LOGO_ACCURACY = "text_logo_accuracy"
    COLOUR_FAITHFULNESS = "colour_faithfulness"
    ARTIFACT_LEVEL = "artifact_level"
    EDGE_HALO_QUALITY = "edge_halo_quality"
    TILING_SEAM_VISIBILITY = "tiling_seam_visibility"
    PREFERENCE_OVER_BASELINE = "preference_over_baseline"


class CriticalFailure(StrEnum):
    """The eight automatic failures from benchmark plan section 8.3.

    A separate channel from scores, and dominant over them.
    """

    IDENTITY_CHANGED = "identity_changed"
    TEXT_OR_LOGO_CHANGED = "text_or_logo_changed"
    CONTENT_ADDED_OR_REMOVED = "content_added_or_removed"
    SEVERE_TILING_SEAMS = "severe_tiling_seams"
    BROKEN_TRANSPARENCY = "broken_transparency"
    ORIENTATION_CORRUPTED = "orientation_corrupted"
    SILENT_COLOUR_SPACE_CONVERSION = "silent_colour_space_conversion"
    WORSE_THAN_BASELINE_UNWARNED = "worse_than_baseline_unwarned"


CRITICAL_FAILURE_GUIDANCE: dict[CriticalFailure, str] = {
    CriticalFailure.IDENTITY_CHANGED: (
        "The person is recognisably a different person, or their features have been "
        "materially altered, in Natural mode."
    ),
    CriticalFailure.TEXT_OR_LOGO_CHANGED: (
        "Any word, digit, brand name or logo differs from the original - including a "
        "digit that merely looks cleaner but reads differently."
    ),
    CriticalFailure.CONTENT_ADDED_OR_REMOVED: (
        "A person or object appears or disappears that the selected operation did not ask for."
    ),
    CriticalFailure.SEVERE_TILING_SEAMS: "Visible discontinuities where processing tiles meet.",
    CriticalFailure.BROKEN_TRANSPARENCY: (
        "Transparent regions became opaque, haloed, or filled with colour."
    ),
    CriticalFailure.ORIENTATION_CORRUPTED: (
        "The image is rotated or mirrored relative to the input."
    ),
    CriticalFailure.SILENT_COLOUR_SPACE_CONVERSION: (
        "Colours shifted as a whole in a way no setting requested."
    ),
    CriticalFailure.WORSE_THAN_BASELINE_UNWARNED: (
        "The result is visibly worse than the plain deterministic version, and nothing "
        "warned the customer it might be."
    ),
}
"""Plain-language wording shown to reviewers.

Written out because a reviewer deciding whether something is a "material face
change" needs a sentence, not an enum member. Ambiguous criteria produce
inconsistent reviews, and inconsistent reviews are worse than none - they look
like data.
"""

TIE_THRESHOLD = 2
"""Overall-usefulness gap that triggers a third review.

Two reviewers scoring 4 and 5 disagree about polish. Two scoring 2 and 4 disagree
about whether the result is usable, which is a different kind of disagreement and
the one a third opinion exists to settle. Any disagreement about a *critical
failure* triggers a third review regardless of the gap, because that channel is
not a matter of degree.
"""


class ReviewItem(ContractModel):
    """One image placed in front of a reviewer. Carries no provenance at all."""

    label: SlugId = Field(
        description="Opaque handle such as 'item-07'. Must not encode the processor, "
        "the run, or the position of the item in the underlying result set."
    )
    relative_path: str = Field(description="Path within the review package directory.")
    operation: OperationKind
    category: AssetCategory
    dimensions: tuple[ReviewDimension, ...] = Field(
        description="The dimensions this item is to be scored on. A dimension that does "
        "not apply to the material is omitted rather than scored neutrally."
    )

    @model_validator(mode="after")
    def _dimensions_are_requested(self) -> ReviewItem:
        if not self.dimensions:
            msg = f"review item {self.label} requests no dimensions; there is nothing to score"
            raise ValueError(msg)
        if len(set(self.dimensions)) != len(self.dimensions):
            msg = f"review item {self.label} repeats a dimension"
            raise ValueError(msg)
        return self


class ReviewPackage(ContractModel):
    """What a reviewer receives: images, labels, and the questions to answer."""

    schema_version: str = Field(default=SCHEMA_VERSION, pattern=r"^\d+\.\d+\.\d+$")
    package_id: DigestId
    operation: OperationKind
    created_at: str
    items: tuple[ReviewItem, ...]
    critical_failures: tuple[CriticalFailure, ...] = Field(
        default=tuple(CriticalFailure),
        description="The failure conditions reviewers may raise. All eight, always: a "
        "package that offered a subset would be deciding in advance which failures are "
        "possible.",
    )
    instructions: str = ""

    @model_validator(mode="after")
    def _labels_are_unique(self) -> ReviewPackage:
        labels = [item.label for item in self.items]
        if len(set(labels)) != len(labels):
            msg = "review item labels must be unique within a package"
            raise ValueError(msg)
        return self

    @property
    def labels(self) -> tuple[str, ...]:
        return tuple(item.label for item in self.items)


class SealedEntry(ContractModel):
    """The provenance of one item. Never shown to a reviewer before scoring."""

    label: SlugId
    result_id: DigestId
    run_id: DigestId
    asset_id: SlugId
    processor_name: SlugId
    processor_version: str
    weights_sha256: Sha256Hex | None = None
    licence_ref: str | None = None
    effective_disposition: Disposition = Disposition.UNKNOWN
    eligible_for_commercial_recommendation: bool = False
    is_control: bool = False
    output_sha256: Sha256Hex = Field(
        description="Digest of the processor's output. The review copy is re-encoded and "
        "padded for blinding, so its bytes differ; this is what ties a score to the "
        "measured result."
    )


class SealedKey(ContractModel):
    """The mapping from labels back to runs. Opened only after scores are in."""

    schema_version: str = Field(default=SCHEMA_VERSION, pattern=r"^\d+\.\d+\.\d+$")
    package_id: DigestId
    shuffle_seed: str = Field(
        description="The seed that produced the label ordering. Recorded so the package "
        "is reproducible, and sealed so the ordering cannot be predicted from the "
        "package alone."
    )
    entries: tuple[SealedEntry, ...]

    def for_label(self, label: str) -> SealedEntry | None:
        return next((entry for entry in self.entries if entry.label == label), None)


class ReviewScore(ContractModel):
    """One reviewer's assessment of one item."""

    label: SlugId
    reviewer_id: SlugId
    scores: dict[ReviewDimension, int] = Field(default_factory=dict)
    critical_failures: tuple[CriticalFailure, ...] = ()
    notes: str = ""

    @model_validator(mode="after")
    def _scores_are_in_range(self) -> ReviewScore:
        for dimension, value in self.scores.items():
            if not 1 <= value <= 5:
                msg = (
                    f"{self.reviewer_id} scored {self.label} {value} on "
                    f"{dimension.value}; the scale is 1 to 5"
                )
                raise ValueError(msg)
        return self


class ItemVerdict(ContractModel):
    """What the reviews add up to for one item, and whether that is settled."""

    label: SlugId
    reviewer_count: NonNegInt
    score_sum: NonNegInt = Field(
        description="Sum of every dimension score from every reviewer. Stored with "
        "score_count instead of a mean so the artifact holds no float."
    )
    score_count: NonNegInt
    overall_scores: tuple[int, ...] = Field(
        default=(),
        description="Each reviewer's overall_usefulness score, in reviewer order. The "
        "tie rule reads this rather than the aggregate.",
    )
    critical_failures: tuple[CriticalFailure, ...] = ()
    failed: bool = Field(
        default=False,
        description="True when any reviewer raised any critical failure. Independent of "
        "the scores, and dominant over them.",
    )
    needs_third_review: bool = False
    third_review_reason: str = ""

    @property
    def mean_score(self) -> float | None:
        """Derived for display. Never stored, never compared, never an identity."""
        if not self.score_count:
            return None
        return self.score_sum / self.score_count


class ReviewSummary(ContractModel):
    """Aggregated verdicts, grouped the way a decision needs them."""

    schema_version: str = Field(default=SCHEMA_VERSION, pattern=r"^\d+\.\d+\.\d+$")
    package_id: DigestId
    operation: OperationKind
    verdicts: tuple[ItemVerdict, ...]
    unscored_labels: tuple[str, ...] = Field(
        default=(),
        description="Items in the package that no reviewer scored. Reported rather than "
        "dropped: a silently missing item looks identical to an item nobody objected to.",
    )
    unknown_labels: tuple[str, ...] = Field(
        default=(),
        description="Scores submitted for labels not in the package. Almost always a "
        "transcription error, and never something to average in quietly.",
    )

    @property
    def failed_labels(self) -> tuple[str, ...]:
        return tuple(verdict.label for verdict in self.verdicts if verdict.failed)

    @property
    def labels_needing_a_third_review(self) -> tuple[str, ...]:
        return tuple(verdict.label for verdict in self.verdicts if verdict.needs_third_review)
