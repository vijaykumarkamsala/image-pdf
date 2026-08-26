"""Build blinded review packages and aggregate the scores that come back.

POC-008. Two operations, deliberately separated by a sealed document:

``build_review_package``
    Takes processed outputs, strips everything that identifies their producer,
    shuffles them under a seed, and writes a directory a reviewer can open plus a
    sealed key they cannot.

``aggregate_reviews``
    Takes score sheets back and produces verdicts - with critical failures
    dominant over scores, and disagreements flagged rather than averaged away.

**What blinding has to defeat.** Not just filenames. Every channel that
correlates with the producer:

============================  =========================================
channel                       how it is closed
============================  =========================================
filename                      opaque ``item-NN`` labels
directory layout              one flat directory, no per-model folders
ordering                      keyed shuffle; the seed lives in the sealed key
file size                     re-encoded, then padded to a common size
image metadata                re-encoded with no ancillary chunks carried over
============================  =========================================

File size is the one that would have quietly defeated the whole exercise. On a
real comparison the deterministic control wrote 2,630 bytes and the two models
wrote 83,125 and 87,651 - so any file browser showing a size column would have
told the reviewer which item was the baseline before they looked at a single
image. Padding is cheap and closes it.

**What blinding cannot defeat, and should not pretend to.** The images differ,
and that is the point. A reviewer can see that one item is soft and another is
sharp, and on a two-model comparison they may well guess which is the
deterministic control. What they cannot do is tell Real-ESRGAN from SwinIR, which
is the comparison that matters, and they cannot map any item to a run. The
residual channel is recorded in the package rather than left for someone to
discover.

**No score is derived from a model name.** Nothing in this module reads the
processor identity while building the reviewable half; the provenance goes
straight into the sealed key and is not consulted again until the scores are in.
"""

from __future__ import annotations

import hashlib
import json
import struct
import zlib
from dataclasses import dataclass, field
from pathlib import Path

from ipw.benchmark_runner.ids import digest_id
from ipw.contracts.asset import AssetCategory
from ipw.contracts.operation import OperationKind
from ipw.contracts.review import (
    CRITICAL_FAILURE_GUIDANCE,
    TIE_THRESHOLD,
    CriticalFailure,
    ItemVerdict,
    ReviewDimension,
    ReviewItem,
    ReviewPackage,
    ReviewScore,
    ReviewSummary,
    SealedEntry,
    SealedKey,
)

__all__ = [
    "PACKAGE_FILE",
    "PADDING_CHUNK",
    "REVIEW_INSTRUCTIONS",
    "SCORES_FILE",
    "SEALED_KEY_FILE",
    "SUMMARY_FILE",
    "ProducerVerdict",
    "Submission",
    "aggregate_reviews",
    "attribute",
    "blinded_bytes",
    "build_review_package",
    "load_scores",
    "write_review_package",
]

PACKAGE_FILE = "review-package.json"
SEALED_KEY_FILE = "sealed-key.json"
SCORES_FILE = "scores.json"
SUMMARY_FILE = "review-summary.json"

PADDING_CHUNK = b"ipWd"
"""A private, ancillary PNG chunk used to equalise file sizes.

Lowercase first byte means ancillary (a decoder may ignore it); lowercase second
byte means private (it is ours, and no public specification claims it). Every PNG
decoder skips it, so the image a reviewer sees is unaffected.
"""

REVIEW_INSTRUCTIONS = """\
Score each item from 1 (unusable) to 5 (excellent) on the dimensions listed for
it. Skip a dimension only if it genuinely does not apply to the material.

Raise a critical failure whenever one applies, regardless of how good the image
looks otherwise. A critical failure is not a low score - it means the result
cannot be shipped at all, and it overrides every other judgement about that item.

You are not told which system produced any item, and item numbers carry no
meaning. Please do not try to work it out; the value of this review depends on it.
"""


@dataclass(frozen=True)
class Submission:
    """One processed output offered for review, with its provenance attached.

    The two halves are separated the moment this is consumed: everything a
    reviewer may see goes into the package, everything else into the sealed key.
    """

    output_path: Path
    output_sha256: str
    result_id: str
    run_id: str
    asset_id: str
    processor_name: str
    processor_version: str
    operation: OperationKind
    category: AssetCategory = AssetCategory.SYNTHETIC_FIXTURE
    weights_sha256: str | None = None
    licence_ref: str | None = None
    effective_disposition: str = "unknown"
    eligible_for_commercial_recommendation: bool = False
    is_control: bool = False


# ------------------------------------------------------------------ blinding --


def _png_chunks(data: bytes) -> list[tuple[bytes, bytes]]:
    """Split a PNG into (type, payload) chunks, signature excluded."""
    if data[:8] != bytes((0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)):
        msg = "not a PNG; review packages re-encode every item to PNG before blinding"
        raise ValueError(msg)
    chunks: list[tuple[bytes, bytes]] = []
    offset = 8
    while offset < len(data):
        (length,) = struct.unpack(">I", data[offset : offset + 4])
        tag = data[offset + 4 : offset + 8]
        payload = data[offset + 8 : offset + 8 + length]
        chunks.append((tag, payload))
        offset += 12 + length
    return chunks


def _encode_png(chunks: list[tuple[bytes, bytes]]) -> bytes:
    out = bytearray(bytes((0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)))
    for tag, payload in chunks:
        out += struct.pack(">I", len(payload))
        out += tag + payload
        out += struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
    return bytes(out)


def blinded_bytes(data: bytes, target_size: int) -> bytes:
    """Strip identifying metadata and pad to ``target_size``.

    Keeps only the chunks a decoder needs - header, palette, transparency, image
    data, end - and drops text, timestamps and colour-profile chunks, any of which
    could name an encoder. Then pads with a private chunk so every item in a
    package is the same size on disk.

    Padding is not cosmetic. Without it the deterministic control is identifiable
    from a directory listing, and the review is unblinded before it starts.
    """
    keep = {b"IHDR", b"PLTE", b"tRNS", b"IDAT", b"IEND"}
    chunks = [(tag, payload) for tag, payload in _png_chunks(data) if tag in keep]

    stripped = _encode_png(chunks)
    shortfall = target_size - len(stripped)
    if shortfall < 12:
        # 12 bytes is the minimum a chunk costs. A caller that computed the target
        # from the largest item can always afford it; one that did not should be
        # told rather than handed an unpadded file that looks padded.
        msg = (
            f"cannot pad to {target_size} bytes: the stripped image is already "
            f"{len(stripped)} and a padding chunk costs at least 12 bytes"
        )
        raise ValueError(msg)

    # The padding chunk goes immediately before IEND, which must remain last.
    padded = [*chunks[:-1], (PADDING_CHUNK, b"\0" * (shortfall - 12)), chunks[-1]]
    return _encode_png(padded)


def _reencode_to_png(path: Path) -> bytes:
    """Decode and re-encode, so no encoder-specific structure survives.

    An output that will not decode is refused here with its path named. Letting
    the imaging library's own error escape would report "cannot identify image
    file" from inside a review builder, which says nothing about which candidate
    produced it or why a review package was being built from it.
    """
    import io

    from PIL import Image, UnidentifiedImageError

    try:
        with Image.open(path) as handle:
            handle.load()
            image = handle.convert("RGBA" if handle.mode in ("RGBA", "LA", "P") else "RGB")
    except (UnidentifiedImageError, OSError) as exc:
        msg = (
            f"{path} is not a decodable image, so it cannot be blinded for review. "
            "Review packages are built from processor outputs; check that the "
            "comparison retained a real image for every candidate."
        )
        raise ValueError(msg) from exc

    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True, compress_level=6)
    return buffer.getvalue()


# ------------------------------------------------------------------ shuffling --


def _shuffled(labels: list[str], seed: str) -> list[str]:
    """Deterministic, seed-keyed ordering.

    ``random`` is banned repository-wide (a benchmark whose ordering depends on
    ambient state is not reproducible), and it is not needed: sorting by
    ``sha256(seed || key)`` is a permutation that is reproducible from the seed
    and unguessable without it.
    """
    return sorted(labels, key=lambda key: hashlib.sha256(f"{seed}\x00{key}".encode()).digest())


# -------------------------------------------------------------------- build ----


def build_review_package(
    *,
    submissions: tuple[Submission, ...],
    operation: OperationKind,
    dimensions: tuple[ReviewDimension, ...],
    seed: str,
    created_at: str,
    output_dir: Path,
) -> tuple[ReviewPackage, SealedKey]:
    """Write a blinded package and its sealed key.

    The reviewable half is written to ``output_dir``; the sealed key is returned
    for the caller to store elsewhere. Writing both into the same directory would
    make the blinding one careless double-click deep.
    """
    if not submissions:
        msg = "a review package needs at least one submission"
        raise ValueError(msg)
    if not seed:
        msg = "a shuffle seed is required; without one the ordering is not reproducible"
        raise ValueError(msg)
    if not dimensions:
        msg = "a review package must request at least one dimension"
        raise ValueError(msg)

    mismatched = {s.operation for s in submissions if s.operation is not operation}
    if mismatched:
        msg = (
            f"every submission must share the package operation {operation.value}; found "
            f"{sorted(k.value for k in mismatched)}. Reviewers cannot compare different work."
        )
        raise ValueError(msg)

    # Order by a stable natural key first, so the shuffle is the only source of
    # ordering and the input order cannot leak through it.
    ordered = sorted(submissions, key=lambda s: (s.asset_id, s.result_id))
    positions = _shuffled([f"{s.asset_id}\x00{s.result_id}" for s in ordered], seed)
    slot_of = {key: index for index, key in enumerate(positions)}

    width = max(2, len(str(len(ordered))))
    encoded: dict[str, bytes] = {}
    for submission in ordered:
        encoded[submission.result_id] = _reencode_to_png(submission.output_path)

    # One size for every item in the package, computed from the largest.
    target = max(len(payload) for payload in encoded.values()) + 12

    output_dir.mkdir(parents=True, exist_ok=True)
    items: list[ReviewItem] = []
    entries: list[SealedEntry] = []

    for submission in ordered:
        slot = slot_of[f"{submission.asset_id}\x00{submission.result_id}"]
        label = f"item-{slot + 1:0{width}d}"
        filename = f"{label}.png"
        (output_dir / filename).write_bytes(blinded_bytes(encoded[submission.result_id], target))

        items.append(
            ReviewItem(
                label=label,
                relative_path=filename,
                operation=submission.operation,
                category=submission.category,
                dimensions=dimensions,
            )
        )
        entries.append(
            SealedEntry(
                label=label,
                result_id=submission.result_id,
                run_id=submission.run_id,
                asset_id=submission.asset_id,
                processor_name=submission.processor_name,
                processor_version=submission.processor_version,
                weights_sha256=submission.weights_sha256,
                licence_ref=submission.licence_ref,
                effective_disposition=submission.effective_disposition,  # type: ignore[arg-type]
                eligible_for_commercial_recommendation=(
                    submission.eligible_for_commercial_recommendation
                ),
                is_control=submission.is_control,
                output_sha256=submission.output_sha256,
            )
        )

    items.sort(key=lambda item: item.label)
    entries.sort(key=lambda entry: entry.label)

    # The package id covers the reviewable half only. Deriving it from provenance
    # would put the thing being hidden inside the thing being handed over.
    package_id = digest_id(
        "report",
        {
            "review_package": {
                "operation": operation.value,
                "labels": [item.label for item in items],
                "dimensions": [dimension.value for dimension in dimensions],
                "created_at": created_at,
            }
        },
    )

    package = ReviewPackage(
        package_id=package_id,
        operation=operation,
        created_at=created_at,
        items=tuple(items),
        instructions=REVIEW_INSTRUCTIONS,
    )
    key = SealedKey(package_id=package_id, shuffle_seed=seed, entries=tuple(entries))
    return package, key


def write_review_package(
    package: ReviewPackage, key: SealedKey, output_dir: Path, key_path: Path
) -> tuple[Path, Path, Path]:
    """Write the package, its reviewer sheet, and the sealed key elsewhere."""
    output_dir.mkdir(parents=True, exist_ok=True)
    key_path.parent.mkdir(parents=True, exist_ok=True)

    package_path = output_dir / PACKAGE_FILE
    package_path.write_text(
        json.dumps(package.model_dump(mode="json"), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    key_path.write_text(
        json.dumps(key.model_dump(mode="json"), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    sheet_path = output_dir / "REVIEW.md"
    sheet_path.write_text(render_review_sheet(package), encoding="utf-8", newline="\n")
    return package_path, key_path, sheet_path


def render_review_sheet(package: ReviewPackage) -> str:
    """The human-facing instructions and score sheet."""
    lines = [
        f"# Blinded review - {package.operation.value}",
        "",
        f"Package `{package.package_id}`, {len(package.items)} items.",
        "",
        package.instructions,
        "## Dimensions",
        "",
        "Score 1 (unusable) to 5 (excellent).",
        "",
    ]
    seen: list[ReviewDimension] = []
    for item in package.items:
        for dimension in item.dimensions:
            if dimension not in seen:
                seen.append(dimension)
    lines += [f"- `{dimension.value}`" for dimension in seen]

    lines += [
        "",
        "## Critical failures",
        "",
        "Raise any that apply. A critical failure overrides every score.",
        "",
    ]
    for failure in package.critical_failures:
        lines.append(f"- **`{failure.value}`** - {CRITICAL_FAILURE_GUIDANCE[failure]}")

    lines += ["", "## Items", "", "| item | file |", "| --- | --- |"]
    lines += [f"| `{item.label}` | `{item.relative_path}` |" for item in package.items]
    lines += [
        "",
        "Record scores in a JSON file shaped like:",
        "",
        "```json",
        json.dumps(
            [
                {
                    "label": package.items[0].label,
                    "reviewer_id": "reviewer-a",
                    "scores": {package.items[0].dimensions[0].value: 4},
                    "critical_failures": [],
                    "notes": "",
                }
            ],
            indent=2,
        ),
        "```",
        "",
    ]
    return "\n".join(lines)


# ---------------------------------------------------------------- aggregate ----


def load_scores(path: Path) -> tuple[ReviewScore, ...]:
    """Read a score file, validating every entry through the contract."""
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        msg = f"{path.name} must contain a list of score objects"
        raise ValueError(msg)
    return tuple(ReviewScore.model_validate(entry) for entry in raw)


def aggregate_reviews(package: ReviewPackage, scores: tuple[ReviewScore, ...]) -> ReviewSummary:
    """Combine score sheets into per-item verdicts.

    Three rules, and the first two are the reason this is not a spreadsheet:

    **A critical failure fails the item.** Not "reduces its average" - fails it.
    One reviewer raising one failure is enough, because the failure conditions are
    about whether the result is usable at all, and a second opinion that the image
    is attractive does not make a changed digit acceptable.

    **Disagreement is surfaced, not resolved by averaging.** Two reviewers who
    disagree about a critical failure, or whose overall scores differ by the tie
    threshold or more, mark the item as needing a third review. Averaging 2 and 4
    into 3 would manufacture a consensus that does not exist.

    **Items nobody scored are reported.** A missing item and an unobjectionable
    item look identical in an aggregate that silently drops absences.
    """
    by_label: dict[str, list[ReviewScore]] = {label: [] for label in package.labels}
    unknown: list[str] = []
    for score in scores:
        if score.label in by_label:
            by_label[score.label].append(score)
        else:
            unknown.append(score.label)

    verdicts: list[ItemVerdict] = []
    unscored: list[str] = []

    for label in package.labels:
        submitted = sorted(by_label[label], key=lambda s: s.reviewer_id)
        if not submitted:
            unscored.append(label)
            continue

        failures: list[CriticalFailure] = []
        for score in submitted:
            for failure in score.critical_failures:
                if failure not in failures:
                    failures.append(failure)

        overall = tuple(
            score.scores[ReviewDimension.OVERALL_USEFULNESS]
            for score in submitted
            if ReviewDimension.OVERALL_USEFULNESS in score.scores
        )

        needs_third, reason = _needs_third_review(submitted, overall)

        verdicts.append(
            ItemVerdict(
                label=label,
                reviewer_count=len(submitted),
                score_sum=sum(sum(score.scores.values()) for score in submitted),
                score_count=sum(len(score.scores) for score in submitted),
                overall_scores=overall,
                critical_failures=tuple(failures),
                failed=bool(failures),
                needs_third_review=needs_third,
                third_review_reason=reason,
            )
        )

    return ReviewSummary(
        package_id=package.package_id,
        operation=package.operation,
        verdicts=tuple(verdicts),
        unscored_labels=tuple(unscored),
        unknown_labels=tuple(sorted(set(unknown))),
    )


def _needs_third_review(submitted: list[ReviewScore], overall: tuple[int, ...]) -> tuple[bool, str]:
    """Whether the reviewers disagree in a way a third opinion should settle."""
    if len(submitted) < 2:
        return True, "fewer than two reviewers scored this item"
    if len(submitted) > 2:
        return False, ""

    raised = [set(score.critical_failures) for score in submitted]
    if raised[0] != raised[1]:
        only_one = raised[0].symmetric_difference(raised[1])
        return True, (
            "reviewers disagree about a critical failure: "
            + ", ".join(sorted(failure.value for failure in only_one))
        )

    if len(overall) == 2 and abs(overall[0] - overall[1]) >= TIE_THRESHOLD:
        return True, (
            f"overall scores differ by {abs(overall[0] - overall[1])} "
            f"({overall[0]} and {overall[1]}), at or above the threshold of {TIE_THRESHOLD}"
        )
    return False, ""


@dataclass
class ProducerVerdict:
    """Everything one producer's items amounted to, once the key is opened."""

    processor_name: str
    processor_version: str
    weights_sha256: str | None
    licence_ref: str | None
    effective_disposition: str
    eligible_for_commercial_recommendation: bool
    is_control: bool
    items: list[str] = field(default_factory=list)
    failed_items: list[str] = field(default_factory=list)
    score_sum: int = 0
    score_count: int = 0

    @property
    def mean_score(self) -> float | None:
        """Derived for display only, like every other mean in this module."""
        return self.score_sum / self.score_count if self.score_count else None

    def as_document(self) -> dict[str, object]:
        return {
            "processor_name": self.processor_name,
            "processor_version": self.processor_version,
            "weights_sha256": self.weights_sha256,
            "licence_ref": self.licence_ref,
            "effective_disposition": self.effective_disposition,
            "eligible_for_commercial_recommendation": (self.eligible_for_commercial_recommendation),
            "is_control": self.is_control,
            "items": list(self.items),
            "failed_items": list(self.failed_items),
            "score_sum": self.score_sum,
            "score_count": self.score_count,
        }


def attribute(summary: ReviewSummary, key: SealedKey) -> dict[str, ProducerVerdict]:
    """Join verdicts back to their producers. Run only after scoring is complete.

    Refuses a key from a different package. Attributing scores to the wrong run
    would be worse than not attributing them at all: the result would look
    authoritative and be wrong.

    The licence standing travels with the attribution, so a research-only model
    cannot be laundered into a recommendation by having been reviewed well.
    """
    if summary.package_id != key.package_id:
        msg = (
            f"sealed key is for package {key.package_id}, summary is for "
            f"{summary.package_id}. These are different reviews."
        )
        raise ValueError(msg)

    attributed: dict[str, ProducerVerdict] = {}
    for verdict in summary.verdicts:
        entry = key.for_label(verdict.label)
        if entry is None:
            continue
        record = attributed.setdefault(
            entry.processor_name,
            ProducerVerdict(
                processor_name=entry.processor_name,
                processor_version=entry.processor_version,
                weights_sha256=entry.weights_sha256,
                licence_ref=entry.licence_ref,
                effective_disposition=entry.effective_disposition.value,
                eligible_for_commercial_recommendation=(
                    entry.eligible_for_commercial_recommendation
                ),
                is_control=entry.is_control,
            ),
        )
        record.items.append(verdict.label)
        if verdict.failed:
            record.failed_items.append(verdict.label)
        record.score_sum += verdict.score_sum
        record.score_count += verdict.score_count

    return attributed
