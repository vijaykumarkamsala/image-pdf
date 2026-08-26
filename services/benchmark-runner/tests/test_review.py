"""Blinded review packages and score aggregation (POC-008).

Acceptance criteria:

* Reviewers cannot infer model identity from filenames/UI.
* Identity/text/logo critical failures override attractive aggregate scores.
* Results remain traceable to exact run/model versions.
"""

from __future__ import annotations

import hashlib
import io
import json
import struct
import zlib
from pathlib import Path

import pytest

from ipw.benchmark_runner.review import (
    PADDING_CHUNK,
    Submission,
    aggregate_reviews,
    attribute,
    blinded_bytes,
    build_review_package,
    load_scores,
    render_review_sheet,
    write_review_package,
)
from ipw.contracts.operation import OperationKind
from ipw.contracts.review import (
    CRITICAL_FAILURE_GUIDANCE,
    TIE_THRESHOLD,
    CriticalFailure,
    ReviewDimension,
    ReviewPackage,
    ReviewScore,
    SealedKey,
)

DIMENSIONS = (
    ReviewDimension.OVERALL_USEFULNESS,
    ReviewDimension.NATURAL_APPEARANCE,
    ReviewDimension.DETAIL_IMPROVEMENT,
    ReviewDimension.ARTIFACT_LEVEL,
)

# Base32 alphabet: digest ids may not contain 0, 1, 8 or 9.
IDS = ("c", "d", "e", "f", "g")


def make_png(path: Path, size: int, colour: tuple[int, int, int], noise: int = 0) -> bytes:
    """A PNG whose compressed size varies with `noise`, like a real output does."""
    from PIL import Image

    image = Image.new("RGB", (size, size), colour)
    pixels = image.load()
    assert pixels is not None
    for y in range(size):
        for x in range(size):
            if noise:
                jitter = ((x * 7 + y * 13) * noise) % 256
                pixels[x, y] = (jitter, (jitter * 3) % 256, (jitter * 7) % 256)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    path.write_bytes(buffer.getvalue())
    return buffer.getvalue()


@pytest.fixture
def submissions(tmp_path: Path) -> tuple[Submission, ...]:
    """Three outputs with wildly different byte sizes, as real candidates have."""
    source = tmp_path / "outputs"
    source.mkdir()
    specs = [
        ("standard-pillow", True, None, 0),  # flat: tiny file
        ("real-esrgan-x4", False, "a" * 64, 1),  # textured: large file
        ("swinir-sr-x4", False, "b" * 64, 3),  # more textured: larger still
    ]
    made: list[Submission] = []
    for index, (name, control, weights, noise) in enumerate(specs):
        path = source / f"{name}.png"
        payload = make_png(path, 64, (128, 128, 128), noise)
        made.append(
            Submission(
                output_path=path,
                output_sha256=hashlib.sha256(payload).hexdigest(),
                result_id=f"res_{IDS[index] * 32}",
                run_id=f"run_{IDS[index] * 32}",
                asset_id="fixture-asset",
                processor_name=name,
                processor_version="0.1.0",
                operation=OperationKind.SUPER_RESOLUTION,
                weights_sha256=weights,
                licence_ref=name,
                effective_disposition="approved" if control else "unknown",
                eligible_for_commercial_recommendation=control,
                is_control=control,
            )
        )
    return tuple(made)


Built = tuple[ReviewPackage, SealedKey]


@pytest.fixture
def built(submissions: tuple[Submission, ...], tmp_path: Path) -> Built:
    return build_review_package(
        submissions=submissions,
        operation=OperationKind.SUPER_RESOLUTION,
        dimensions=DIMENSIONS,
        seed="test-seed",
        created_at="2026-08-25T00:00:00+00:00",
        output_dir=tmp_path / "package",
    )


# ------------------------------------------------------------------ blinding --


class TestBlinding:
    """Acceptance: reviewers cannot infer model identity from filenames or UI."""

    def test_no_filename_names_a_producer(self, built: Built, tmp_path: Path) -> None:
        package, _ = built
        names = " ".join(item.relative_path for item in package.items).lower()
        for producer in ("pillow", "esrgan", "swinir", "standard", "control"):
            assert producer not in names

    def test_labels_carry_no_ordering_information(self, built: Built) -> None:
        """The shuffle must actually move things.

        Submissions are sorted by a stable key before shuffling, so if the shuffle
        were a no-op the control - first alphabetically by asset then result id -
        would land on item-01 every time.
        """
        _, key = built
        labels = {entry.processor_name: entry.label for entry in key.entries}
        assert labels != {
            "standard-pillow": "item-01",
            "real-esrgan-x4": "item-02",
            "swinir-sr-x4": "item-03",
        }

    def test_every_blinded_file_is_the_same_size(self, built: Built, tmp_path: Path) -> None:
        """The leak that would have defeated the whole exercise.

        The three source images compress to very different sizes; a file browser
        showing a size column would identify the deterministic control instantly.
        """
        sizes = {path.stat().st_size for path in (tmp_path / "package").glob("*.png")}
        assert len(sizes) == 1, f"blinded items differ in size: {sorted(sizes)}"

    def test_the_source_files_really_did_differ(self, submissions: tuple[Submission, ...]) -> None:
        """Otherwise the previous test would pass for the wrong reason."""
        sizes = {submission.output_path.stat().st_size for submission in submissions}
        assert len(sizes) == len(submissions), "the fixture is not exercising size blinding"

    def test_blinded_images_still_decode(self, built: Built, tmp_path: Path) -> None:
        from PIL import Image

        for path in sorted((tmp_path / "package").glob("*.png")):
            with Image.open(path) as image:
                image.load()
                assert image.size == (64, 64)

    def test_the_package_document_names_no_producer(self, built: Built) -> None:
        package, _ = built
        serialised = json.dumps(package.model_dump(mode="json")).lower()
        for producer in ("pillow", "esrgan", "swinir"):
            assert producer not in serialised

    def test_the_review_sheet_names_no_producer(self, built: Built) -> None:
        package, _ = built
        sheet = render_review_sheet(package).lower()
        for producer in ("pillow", "esrgan", "swinir"):
            assert producer not in sheet

    def test_identifying_metadata_is_stripped(self, tmp_path: Path) -> None:
        """A tEXt chunk naming the encoder must not survive into the package."""
        from PIL import Image, PngImagePlugin

        info = PngImagePlugin.PngInfo()
        info.add_text("Software", "real-esrgan 0.3.0")
        path = tmp_path / "tagged.png"
        Image.new("RGB", (32, 32), (10, 20, 30)).save(path, pnginfo=info)
        assert b"real-esrgan" in path.read_bytes()

        blinded = blinded_bytes(path.read_bytes(), len(path.read_bytes()) + 4096)
        assert b"real-esrgan" not in blinded
        assert b"Software" not in blinded

    def test_padding_uses_a_private_ancillary_chunk(self, built: Built, tmp_path: Path) -> None:
        """Ancillary and private, so every decoder ignores it."""
        data = sorted((tmp_path / "package").glob("*.png"))[0].read_bytes()
        assert PADDING_CHUNK in data
        # Lowercase first byte = ancillary; lowercase second = private.
        assert PADDING_CHUNK[0:1].islower()
        assert PADDING_CHUNK[1:2].islower()

    def test_padding_is_refused_when_it_cannot_fit(self, tmp_path: Path) -> None:
        path = tmp_path / "big.png"
        payload = make_png(path, 64, (0, 0, 0), noise=5)
        with pytest.raises(ValueError, match="cannot pad"):
            blinded_bytes(payload, 10)


class TestReproducibility:
    def test_the_same_seed_gives_the_same_ordering(
        self, submissions: tuple[Submission, ...], tmp_path: Path
    ) -> None:
        def order(directory: str) -> dict[str, str]:
            _, key = build_review_package(
                submissions=submissions,
                operation=OperationKind.SUPER_RESOLUTION,
                dimensions=DIMENSIONS,
                seed="fixed",
                created_at="2026-08-25T00:00:00+00:00",
                output_dir=tmp_path / directory,
            )
            return {entry.processor_name: entry.label for entry in key.entries}

        assert order("a") == order("b")

    def test_a_different_seed_gives_a_different_ordering(
        self, submissions: tuple[Submission, ...], tmp_path: Path
    ) -> None:
        orders = []
        for seed in ("alpha", "beta", "gamma", "delta"):
            _, key = build_review_package(
                submissions=submissions,
                operation=OperationKind.SUPER_RESOLUTION,
                dimensions=DIMENSIONS,
                seed=seed,
                created_at="2026-08-25T00:00:00+00:00",
                output_dir=tmp_path / seed,
            )
            orders.append(tuple(entry.processor_name for entry in key.entries))
        assert len(set(orders)) > 1, "the seed does not affect the ordering"

    def test_a_seed_is_required(self, submissions: tuple[Submission, ...], tmp_path: Path) -> None:
        with pytest.raises(ValueError, match="shuffle seed is required"):
            build_review_package(
                submissions=submissions,
                operation=OperationKind.SUPER_RESOLUTION,
                dimensions=DIMENSIONS,
                seed="",
                created_at="2026-08-25T00:00:00+00:00",
                output_dir=tmp_path / "none",
            )

    def test_the_seed_is_recorded_in_the_sealed_half_only(self, built: Built) -> None:
        package, key = built
        assert key.shuffle_seed == "test-seed"
        assert "test-seed" not in json.dumps(package.model_dump(mode="json"))


class TestPackageRefusals:
    def test_no_submissions(self, tmp_path: Path) -> None:
        with pytest.raises(ValueError, match="at least one submission"):
            build_review_package(
                submissions=(),
                operation=OperationKind.SUPER_RESOLUTION,
                dimensions=DIMENSIONS,
                seed="s",
                created_at="t",
                output_dir=tmp_path / "x",
            )

    def test_mixed_operations(self, submissions: tuple[Submission, ...], tmp_path: Path) -> None:
        """Reviewers cannot compare a denoise against a super-resolution."""
        with pytest.raises(ValueError, match="share the package operation"):
            build_review_package(
                submissions=submissions,
                operation=OperationKind.AI_DENOISE,
                dimensions=DIMENSIONS,
                seed="s",
                created_at="t",
                output_dir=tmp_path / "x",
            )

    def test_no_dimensions(self, submissions: tuple[Submission, ...], tmp_path: Path) -> None:
        with pytest.raises(ValueError, match="at least one dimension"):
            build_review_package(
                submissions=submissions,
                operation=OperationKind.SUPER_RESOLUTION,
                dimensions=(),
                seed="s",
                created_at="t",
                output_dir=tmp_path / "x",
            )


# ---------------------------------------------------------------- aggregate ---


def score(
    label: str,
    reviewer: str,
    overall: int,
    *,
    failures: tuple[CriticalFailure, ...] = (),
    others: int = 4,
) -> ReviewScore:
    return ReviewScore(
        label=label,
        reviewer_id=reviewer,
        scores={
            ReviewDimension.OVERALL_USEFULNESS: overall,
            ReviewDimension.NATURAL_APPEARANCE: others,
            ReviewDimension.DETAIL_IMPROVEMENT: others,
            ReviewDimension.ARTIFACT_LEVEL: others,
        },
        critical_failures=failures,
    )


class TestCriticalFailuresOverrideScores:
    """Acceptance: critical failures override attractive aggregate scores."""

    def test_a_perfect_score_still_fails(self, built: Built) -> None:
        package, _ = built
        label = package.labels[0]
        summary = aggregate_reviews(
            package,
            (
                score(label, "reviewer-a", 5, others=5),
                score(
                    label,
                    "reviewer-b",
                    5,
                    others=5,
                    failures=(CriticalFailure.TEXT_OR_LOGO_CHANGED,),
                ),
            ),
        )
        verdict = summary.verdicts[0]
        assert verdict.mean_score == 5.0, "the fixture must be the best-scoring item"
        assert verdict.failed is True
        assert CriticalFailure.TEXT_OR_LOGO_CHANGED in verdict.critical_failures

    def test_one_reviewer_is_enough_to_fail_an_item(self, built: Built) -> None:
        """A second opinion that the image is attractive does not make a changed
        digit acceptable."""
        package, _ = built
        label = package.labels[0]
        summary = aggregate_reviews(
            package,
            (
                score(label, "reviewer-a", 5),
                score(label, "reviewer-b", 5, failures=(CriticalFailure.IDENTITY_CHANGED,)),
            ),
        )
        assert summary.failed_labels == (label,)

    def test_the_failed_item_can_be_the_highest_scoring_one(self, built: Built) -> None:
        package, _ = built
        first, second = package.labels[0], package.labels[1]
        summary = aggregate_reviews(
            package,
            (
                score(first, "reviewer-a", 5, others=5),
                score(
                    first, "reviewer-b", 5, others=5, failures=(CriticalFailure.IDENTITY_CHANGED,)
                ),
                score(second, "reviewer-a", 2, others=2),
                score(second, "reviewer-b", 2, others=2),
            ),
        )
        by_label = {verdict.label: verdict for verdict in summary.verdicts}
        best, worst = by_label[first].mean_score, by_label[second].mean_score
        assert best is not None
        assert worst is not None
        assert best > worst
        assert by_label[first].failed
        assert not by_label[second].failed

    def test_every_documented_failure_is_selectable(self) -> None:
        """Guidance exists for all eight, so a reviewer knows what each means."""
        assert set(CRITICAL_FAILURE_GUIDANCE) == set(CriticalFailure)
        assert all(text.strip() for text in CRITICAL_FAILURE_GUIDANCE.values())


class TestThirdReview:
    def test_a_single_reviewer_is_not_enough(self, built: Built) -> None:
        package, _ = built
        label = package.labels[0]
        summary = aggregate_reviews(package, (score(label, "reviewer-a", 4),))
        assert summary.verdicts[0].needs_third_review
        assert "fewer than two" in summary.verdicts[0].third_review_reason

    def test_agreement_needs_no_third_review(self, built: Built) -> None:
        package, _ = built
        label = package.labels[0]
        summary = aggregate_reviews(
            package, (score(label, "reviewer-a", 4), score(label, "reviewer-b", 4))
        )
        assert not summary.verdicts[0].needs_third_review

    def test_a_gap_at_the_threshold_triggers_one(self, built: Built) -> None:
        package, _ = built
        label = package.labels[0]
        summary = aggregate_reviews(
            package,
            (
                score(label, "reviewer-a", 2),
                score(label, "reviewer-b", 2 + TIE_THRESHOLD),
            ),
        )
        assert summary.verdicts[0].needs_third_review
        assert "differ by" in summary.verdicts[0].third_review_reason

    def test_a_gap_below_the_threshold_does_not(self, built: Built) -> None:
        package, _ = built
        label = package.labels[0]
        summary = aggregate_reviews(
            package,
            (score(label, "reviewer-a", 4), score(label, "reviewer-b", 4 + TIE_THRESHOLD - 1)),
        )
        assert not summary.verdicts[0].needs_third_review

    def test_disagreement_about_a_critical_failure_always_triggers_one(self, built: Built) -> None:
        """Not a matter of degree: identical scores, one failure raised."""
        package, _ = built
        label = package.labels[0]
        summary = aggregate_reviews(
            package,
            (
                score(label, "reviewer-a", 4),
                score(label, "reviewer-b", 4, failures=(CriticalFailure.BROKEN_TRANSPARENCY,)),
            ),
        )
        verdict = summary.verdicts[0]
        assert verdict.needs_third_review
        assert "critical failure" in verdict.third_review_reason

    def test_a_third_review_settles_it(self, built: Built) -> None:
        package, _ = built
        label = package.labels[0]
        summary = aggregate_reviews(
            package,
            (
                score(label, "reviewer-a", 2),
                score(label, "reviewer-b", 5),
                score(label, "reviewer-c", 3),
            ),
        )
        assert summary.verdicts[0].reviewer_count == 3
        assert not summary.verdicts[0].needs_third_review


class TestMissingAndUnknown:
    def test_unscored_items_are_reported_not_dropped(self, built: Built) -> None:
        """A missing item and an unobjectionable one must not look identical."""
        package, _ = built
        label = package.labels[0]
        summary = aggregate_reviews(
            package, (score(label, "reviewer-a", 4), score(label, "reviewer-b", 4))
        )
        assert set(summary.unscored_labels) == set(package.labels[1:])

    def test_scores_for_unknown_labels_are_reported(self, built: Built) -> None:
        package, _ = built
        summary = aggregate_reviews(package, (score("item-99", "reviewer-a", 4),))
        assert summary.unknown_labels == ("item-99",)

    def test_an_unknown_label_is_not_averaged_in(self, built: Built) -> None:
        package, _ = built
        summary = aggregate_reviews(package, (score("item-99", "reviewer-a", 5),))
        assert summary.verdicts == ()


class TestNoFloatIsStored:
    def test_the_summary_holds_sums_and_counts(self, built: Built) -> None:
        """Means are derived for display; a committed artifact holds no float."""
        package, _ = built
        label = package.labels[0]
        summary = aggregate_reviews(
            package, (score(label, "reviewer-a", 4), score(label, "reviewer-b", 4))
        )
        serialised = json.dumps(summary.model_dump(mode="json"))
        document = json.loads(serialised)
        for verdict in document["verdicts"]:
            assert isinstance(verdict["score_sum"], int)
            assert isinstance(verdict["score_count"], int)
            assert "mean_score" not in verdict

    def test_the_mean_is_available_but_derived(self, built: Built) -> None:
        package, _ = built
        label = package.labels[0]
        summary = aggregate_reviews(
            package, (score(label, "reviewer-a", 4), score(label, "reviewer-b", 4))
        )
        assert summary.verdicts[0].mean_score == 4.0


# ------------------------------------------------------------- traceability ---


class TestTraceability:
    """Acceptance: results remain traceable to exact run/model versions."""

    def test_every_item_maps_back_to_a_run(self, built: Built) -> None:
        package, key = built
        for label in package.labels:
            entry = key.for_label(label)
            assert entry is not None
            assert entry.run_id.startswith("run_")
            assert entry.result_id.startswith("res_")
            assert entry.processor_version

    def test_weight_digests_survive_into_the_key(self, built: Built) -> None:
        _, key = built
        digests = {entry.processor_name: entry.weights_sha256 for entry in key.entries}
        assert digests["real-esrgan-x4"] == "a" * 64
        assert digests["swinir-sr-x4"] == "b" * 64
        assert digests["standard-pillow"] is None

    def test_licence_standing_survives_into_the_key(self, built: Built) -> None:
        """A research-only result must not be laundered by passing through review."""
        _, key = built
        for entry in key.entries:
            if entry.processor_name == "standard-pillow":
                assert entry.eligible_for_commercial_recommendation
            else:
                assert not entry.eligible_for_commercial_recommendation

    def test_attribution_joins_verdicts_to_producers(self, built: Built) -> None:
        package, key = built
        scores = []
        for index, label in enumerate(package.labels):
            failures = (CriticalFailure.IDENTITY_CHANGED,) if index == 0 else ()
            scores += [
                score(label, "reviewer-a", 4, failures=failures),
                score(label, "reviewer-b", 4, failures=failures),
            ]
        summary = aggregate_reviews(package, tuple(scores))
        attributed = attribute(summary, key)

        assert set(attributed) == {"standard-pillow", "real-esrgan-x4", "swinir-sr-x4"}
        failing = [name for name, record in attributed.items() if record.failed_items]
        assert len(failing) == 1
        target = key.for_label(package.labels[0])
        assert target is not None
        assert failing == [target.processor_name]

    def test_attribution_refuses_a_key_from_another_package(
        self, built: Built, submissions: tuple[Submission, ...], tmp_path: Path
    ) -> None:
        package, _ = built
        _, other_key = build_review_package(
            submissions=submissions,
            operation=OperationKind.SUPER_RESOLUTION,
            dimensions=DIMENSIONS,
            seed="a-different-seed",
            created_at="2026-08-25T01:00:00+00:00",
            output_dir=tmp_path / "other",
        )
        summary = aggregate_reviews(package, (score(package.labels[0], "reviewer-a", 4),))
        with pytest.raises(ValueError, match="different reviews"):
            attribute(summary, other_key)


class TestRoundTrip:
    def test_the_written_package_reloads(self, built: Built, tmp_path: Path) -> None:
        package, key = built
        package_path, key_path, sheet_path = write_review_package(
            package, key, tmp_path / "package", tmp_path / "sealed" / "sealed-key.json"
        )
        reloaded = ReviewPackage.model_validate_json(package_path.read_text(encoding="utf-8"))
        assert reloaded.labels == package.labels
        reloaded_key = SealedKey.model_validate_json(key_path.read_text(encoding="utf-8"))
        assert reloaded_key.package_id == package.package_id
        assert sheet_path.read_text(encoding="utf-8").startswith("# Blinded review")

    def test_the_sealed_key_is_written_outside_the_package(
        self, built: Built, tmp_path: Path
    ) -> None:
        package, key = built
        out = tmp_path / "package"
        _, key_path, _ = write_review_package(package, key, out, tmp_path / "sealed" / "k.json")
        assert out not in key_path.parents
        assert not list(out.glob("*sealed*"))

    def test_scores_load_through_the_contract(self, tmp_path: Path) -> None:
        path = tmp_path / "scores.json"
        path.write_text(
            json.dumps(
                [
                    {
                        "label": "item-01",
                        "reviewer_id": "reviewer-a",
                        "scores": {"overall_usefulness": 4},
                        "critical_failures": ["broken_transparency"],
                    }
                ]
            ),
            encoding="utf-8",
        )
        loaded = load_scores(path)
        assert loaded[0].critical_failures == (CriticalFailure.BROKEN_TRANSPARENCY,)

    def test_an_out_of_range_score_is_refused_on_load(self, tmp_path: Path) -> None:
        path = tmp_path / "scores.json"
        path.write_text(
            json.dumps(
                [
                    {
                        "label": "item-01",
                        "reviewer_id": "reviewer-a",
                        "scores": {"overall_usefulness": 9},
                    }
                ]
            ),
            encoding="utf-8",
        )
        with pytest.raises(ValueError, match="scale is 1 to 5"):
            load_scores(path)

    def test_a_score_file_that_is_not_a_list_is_refused(self, tmp_path: Path) -> None:
        path = tmp_path / "scores.json"
        path.write_text(json.dumps({"label": "item-01"}), encoding="utf-8")
        with pytest.raises(ValueError, match="must contain a list"):
            load_scores(path)


class TestPngHandling:
    def test_a_non_png_is_refused(self) -> None:
        with pytest.raises(ValueError, match="not a PNG"):
            blinded_bytes(b"\xff\xd8\xff\xe0 jpeg header", 4096)

    def test_the_padded_file_is_structurally_valid(self, tmp_path: Path) -> None:
        """Walk the chunks: every length and CRC must still be right."""
        path = tmp_path / "image.png"
        payload = make_png(path, 32, (5, 5, 5), noise=2)
        padded = blinded_bytes(payload, len(payload) + 2048)

        offset, seen = 8, []
        while offset < len(padded):
            (length,) = struct.unpack(">I", padded[offset : offset + 4])
            tag = padded[offset + 4 : offset + 8]
            body = padded[offset + 8 : offset + 8 + length]
            (stored_crc,) = struct.unpack(">I", padded[offset + 8 + length : offset + 12 + length])
            assert stored_crc == zlib.crc32(tag + body) & 0xFFFFFFFF, f"bad CRC on {tag!r}"
            seen.append(tag)
            offset += 12 + length
        assert seen[0] == b"IHDR"
        assert seen[-1] == b"IEND"
        assert PADDING_CHUNK in seen
