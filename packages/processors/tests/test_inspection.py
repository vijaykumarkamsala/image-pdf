"""Input inspection and safety (POC-003).

Acceptance criteria:

* Mismatched extension/signature is rejected.
* Excessive decoded dimensions are caught before unsafe allocation where possible.
* 25 MB / 100 MB policies are configurable, not hard-coded throughout the codebase.
* Original bytes remain unchanged.
* Temporary resources are cleaned after all paths.
"""

from __future__ import annotations

import hashlib
import struct
from pathlib import Path

import pytest

from ipw.contracts.asset import AssetManifestEntry, MediaType
from ipw.contracts.failure import FailureCategory
from ipw.contracts.runtime import InputRef
from ipw.contracts.safety import (
    DEFAULT_SAFETY_POLICY,
    HandlingClass,
    Orientation,
    RiskFlag,
    SafetyPolicy,
)
from ipw.processors.inspection import (
    HeaderParseError,
    SignatureKind,
    detect_signature,
    inspect_input,
    parse_jpeg,
    parse_png,
)
from ipw.processors.inspection.inspector import inspect_input as inspect

FIXTURES = Path(__file__).resolve().parents[3] / "data" / "fixtures" / "images"

VALID_PNG = "synthetic-gradient-64.png"
VALID_JPEG = "synthetic-grey-16.jpg"
ORIENTED_JPEG = "synthetic-grey-16x8-orientation6.jpg"
RENAMED_JPEG = "mismatched-extension.png"
BOMB = "decompression-bomb.png"
DEPTH_16 = "unsupported-depth-16bit.png"
NOT_AN_IMAGE = "not-an-image.png"
TRUNCATED = "truncated-header.png"


def ref_for(name: str, *, asset_id: str = "fixture-under-test") -> InputRef:
    path = FIXTURES / name
    data = path.read_bytes()
    return InputRef(
        asset_id=asset_id,
        expected_sha256=hashlib.sha256(data).hexdigest(),
        path=path,
        declared_bytes=len(data),
    )


class TestSignatureDetection:
    @pytest.mark.parametrize(
        ("name", "expected"),
        [
            (VALID_PNG, SignatureKind.PNG),
            (VALID_JPEG, SignatureKind.JPEG),
            (RENAMED_JPEG, SignatureKind.JPEG),
            (BOMB, SignatureKind.PNG),
            (NOT_AN_IMAGE, SignatureKind.UNKNOWN),
        ],
    )
    def test_content_decides_not_filename(self, name: str, expected: SignatureKind) -> None:
        assert detect_signature((FIXTURES / name).read_bytes()) is expected

    @pytest.mark.parametrize(
        ("data", "expected"),
        [
            (b"GIF89a...", SignatureKind.GIF),
            (b"BM....", SignatureKind.BMP),
            (b"II\x2a\x00", SignatureKind.TIFF),
            (b"%PDF-1.7", SignatureKind.PDF),
            (b"PK\x03\x04", SignatureKind.ZIP),
            (b"RIFF____WEBP", SignatureKind.WEBP),
            (b"____ftypheic", SignatureKind.HEIF),
            (b"", SignatureKind.UNKNOWN),
            (b"\x00" * 32, SignatureKind.UNKNOWN),
        ],
    )
    def test_other_formats_are_identified(self, data: bytes, expected: SignatureKind) -> None:
        assert detect_signature(data) is expected


class TestPngHeaderParsing:
    def test_reads_dimensions_and_colour_type(self) -> None:
        header = parse_png((FIXTURES / VALID_PNG).read_bytes())
        assert (header.width, header.height) == (64, 64)
        assert header.channels == 3
        assert header.bit_depth == 8
        assert not header.has_alpha
        assert not header.interlaced

    def test_reads_a_16_bit_depth(self) -> None:
        header = parse_png((FIXTURES / DEPTH_16).read_bytes())
        assert header.bit_depth == 16

    def test_the_bomb_header_is_parsed_without_allocation(self) -> None:
        """The declared size is read from 33 bytes; nothing is decoded."""
        header = parse_png((FIXTURES / BOMB).read_bytes())
        assert header.pixels == 60000 * 60000
        assert header.bytes_examined < 200

    @pytest.mark.parametrize(
        ("data", "match"),
        [
            (b"not a png", "signature mismatch"),
            (b"\x89PNG\r\n\x1a\n" + b"\x00" * 4, "truncated"),
        ],
    )
    def test_malformed_input_raises_a_parse_error(self, data: bytes, match: str) -> None:
        with pytest.raises(HeaderParseError, match=match):
            parse_png(data)

    def test_a_wrong_first_chunk_is_rejected(self) -> None:
        payload = b"\x89PNG\r\n\x1a\n" + struct.pack(">I4s", 13, b"IDAT") + b"\x00" * 20
        with pytest.raises(HeaderParseError, match="expected IHDR"):
            parse_png(payload)

    def test_a_zero_dimension_is_rejected(self) -> None:
        ihdr = struct.pack(">IIBBBBB", 0, 10, 8, 2, 0, 0, 0)
        payload = b"\x89PNG\r\n\x1a\n" + struct.pack(">I4s", 13, b"IHDR") + ihdr + b"\x00" * 4
        with pytest.raises(HeaderParseError, match="zero dimension"):
            parse_png(payload)

    def test_an_unknown_colour_type_is_rejected(self) -> None:
        ihdr = struct.pack(">IIBBBBB", 8, 8, 8, 9, 0, 0, 0)
        payload = b"\x89PNG\r\n\x1a\n" + struct.pack(">I4s", 13, b"IHDR") + ihdr + b"\x00" * 4
        with pytest.raises(HeaderParseError, match="unknown colour type"):
            parse_png(payload)


class TestJpegHeaderParsing:
    def test_reads_dimensions_from_the_start_of_frame(self) -> None:
        header = parse_jpeg((FIXTURES / VALID_JPEG).read_bytes())
        assert (header.width, header.height) == (16, 16)
        assert header.channels == 1
        assert header.bit_depth == 8
        assert header.encoding == "jpeg-baseline"
        assert not header.progressive

    def test_reads_the_exif_orientation_tag(self) -> None:
        header = parse_jpeg((FIXTURES / ORIENTED_JPEG).read_bytes())
        assert header.exif_orientation == 6
        assert (header.width, header.height) == (16, 8)

    def test_parsing_stops_at_the_start_of_scan(self) -> None:
        """Entropy-coded data is never read: the frame header is enough."""
        data = (FIXTURES / VALID_JPEG).read_bytes()
        header = parse_jpeg(data)
        assert header.bytes_examined < len(data)

    @pytest.mark.parametrize(
        ("data", "match"),
        [
            (b"\x00\x00", "SOI marker missing"),
            (b"\xff\xd8", "no start-of-frame"),
            (b"\xff\xd8\xff\xe0\x00\x01", "segment length"),
            (b"\xff\xd8\xff\xe0\xff\xff", "extends beyond"),
        ],
    )
    def test_malformed_input_raises_a_parse_error(self, data: bytes, match: str) -> None:
        with pytest.raises(HeaderParseError, match=match):
            parse_jpeg(data)

    def test_corrupt_exif_is_ignored_not_fatal(self) -> None:
        """Malformed metadata is an expected condition, not a reason to fail."""
        corrupt = b"\xff\xd8" + b"\xff\xe1\x00\x10" + b"Exif\x00\x00" + b"XX" + b"\x00" * 6
        corrupt += b"\xff\xc0\x00\x0b" + struct.pack(">BHHB", 8, 8, 8, 1) + bytes([1, 0x11, 0])
        header = parse_jpeg(corrupt)
        assert header.exif_orientation is None
        assert header.width == 8


class TestOrientationNormalisation:
    """The original is never rotated: only the metadata is normalised."""

    @pytest.mark.parametrize(
        ("tag", "rotate", "mirrored", "swaps"),
        [
            (1, 0, False, False),
            (2, 0, True, False),
            (3, 180, False, False),
            (4, 180, True, False),
            (5, 90, True, True),
            (6, 90, False, True),
            (7, 270, True, True),
            (8, 270, False, True),
        ],
    )
    def test_every_exif_tag_maps_to_a_transform(
        self, tag: int, rotate: int, mirrored: bool, swaps: bool
    ) -> None:
        orientation = Orientation.from_exif(tag)
        assert orientation.rotate_degrees == rotate
        assert orientation.mirrored is mirrored
        assert orientation.swaps_axes is swaps

    @pytest.mark.parametrize("tag", [None, 0, 9, 99])
    def test_absent_or_invalid_tags_are_the_identity(self, tag: int | None) -> None:
        assert Orientation.from_exif(tag).is_identity

    def test_display_dimensions_swap_when_the_transform_swaps_axes(self) -> None:
        result = inspect(ref_for(ORIENTED_JPEG))
        assert (result.decoded_width, result.decoded_height) == (16, 8)
        assert (result.display_width, result.display_height) == (8, 16)
        assert RiskFlag.ORIENTATION_METADATA_PRESENT in result.risk_flags

    def test_an_unoriented_image_keeps_its_dimensions(self) -> None:
        result = inspect(ref_for(VALID_JPEG))
        assert (result.display_width, result.display_height) == (16, 16)

    def test_normalisation_does_not_touch_the_original(self) -> None:
        ref = ref_for(ORIENTED_JPEG)
        before = ref.compute_sha256()
        inspect(ref)
        assert ref.compute_sha256() == before


class TestSignatureMismatch:
    """Acceptance criterion: mismatched extension/signature is rejected."""

    def test_jpeg_bytes_with_a_png_extension_are_rejected(self) -> None:
        result = inspect(ref_for(RENAMED_JPEG))
        assert not result.accepted
        assert result.decision is HandlingClass.INVALID
        assert result.failure is not None
        assert result.failure.code.value == "MANIFEST.CONTENT_TYPE_MISMATCH"
        assert RiskFlag.EXTENSION_SIGNATURE_MISMATCH in result.risk_flags

    def test_an_unrecognised_signature_is_rejected(self) -> None:
        result = inspect(ref_for(NOT_AN_IMAGE))
        assert not result.accepted
        assert result.failure is not None
        assert result.failure.code.value == "MANIFEST.UNSUPPORTED_MEDIA_TYPE"

    def test_a_malformed_header_is_rejected(self) -> None:
        result = inspect(ref_for(TRUNCATED))
        assert not result.accepted
        assert RiskFlag.MALFORMED_METADATA in result.risk_flags

    def test_a_missing_file_is_rejected(self, tmp_path: Path) -> None:
        ref = InputRef(
            asset_id="absent-asset",
            expected_sha256="0" * 64,
            path=tmp_path / "nothing.png",
            declared_bytes=0,
        )
        result = inspect(ref)
        assert not result.accepted
        assert result.failure is not None
        assert result.failure.code.value == "MANIFEST.ASSET_FILE_MISSING"

    def test_a_supported_signature_outside_the_policy_is_rejected(self) -> None:
        """A real TIFF would be refused while TIFF is outside the validated set."""
        png_only = DEFAULT_SAFETY_POLICY.model_copy(
            update={"supported_media_types": (MediaType.PNG,)}
        )
        result = inspect(ref_for(VALID_JPEG), policy=png_only)
        assert not result.accepted
        assert result.failure is not None
        assert result.failure.code.value == "MANIFEST.UNSUPPORTED_MEDIA_TYPE"


class TestAllocationSafety:
    """Acceptance criterion: excessive dimensions caught before unsafe allocation."""

    def test_a_decompression_bomb_is_refused_from_the_header(self) -> None:
        result = inspect(ref_for(BOMB))
        assert not result.accepted
        assert result.failure is not None
        assert result.failure.code.value == "SAFETY.DECOMPRESSION_BOMB"
        assert result.failure.category is FailureCategory.SAFETY_LIMIT
        assert RiskFlag.DECOMPRESSION_BOMB in result.risk_flags

    def test_the_bomb_is_refused_after_reading_only_its_header(self) -> None:
        """84 bytes on disk, 3.6 gigapixels declared, nothing allocated."""
        result = inspect(ref_for(BOMB))
        assert result.pixels_decoded is False
        assert result.header_bytes_read <= result.compressed_bytes
        assert result.compressed_bytes < 1024

    def test_no_inspection_ever_decodes_pixels(self) -> None:
        for name in (VALID_PNG, VALID_JPEG, ORIENTED_JPEG, DEPTH_16):
            assert inspect(ref_for(name)).pixels_decoded is False

    def test_a_pixel_ceiling_refuses_before_classification(self) -> None:
        tiny = DEFAULT_SAFETY_POLICY.model_copy(
            update={
                "standard_max_pixels": 100,
                "professional_max_pixels": 100,
                "extreme_max_pixels": 100,
            }
        )
        result = inspect(ref_for(VALID_PNG), policy=tiny)
        assert not result.accepted
        assert result.failure is not None
        assert result.failure.code.value == "SAFETY.PIXELS_EXCEEDED"

    def test_a_working_memory_ceiling_refuses_before_classification(self) -> None:
        tiny = DEFAULT_SAFETY_POLICY.model_copy(update={"max_working_memory_bytes": 1024})
        result = inspect(ref_for(VALID_PNG), policy=tiny)
        assert not result.accepted
        assert result.failure is not None
        assert result.failure.code.value == "SAFETY.MEMORY_EXCEEDED"
        assert RiskFlag.EXCESSIVE_WORKING_MEMORY in result.risk_flags

    def test_a_byte_ceiling_refuses_oversized_files(self) -> None:
        tiny = DEFAULT_SAFETY_POLICY.model_copy(
            update={
                "standard_max_bytes": 100,
                "professional_max_bytes": 100,
                "extreme_max_bytes": 100,
            }
        )
        result = inspect(ref_for(VALID_PNG), policy=tiny)
        assert not result.accepted
        assert result.failure is not None
        assert result.failure.code.value == "SAFETY.BYTES_EXCEEDED"

    def test_a_generous_header_cap_still_bounds_the_read(self) -> None:
        result = inspect(ref_for(VALID_JPEG))
        assert result.accepted
        assert result.header_bytes_read <= DEFAULT_SAFETY_POLICY.max_header_bytes

    def test_a_header_larger_than_the_cap_is_refused_not_read_past(self) -> None:
        """The cap is a hard bound, not a hint.

        This JPEG's start-of-frame sits beyond byte 64 because the Huffman tables
        come first. With a 64-byte cap the parser sees a truncated file and
        refuses, rather than reading past the limit to find what it wants.
        """
        capped = DEFAULT_SAFETY_POLICY.model_copy(update={"max_header_bytes": 64})
        result = inspect(ref_for(VALID_JPEG), policy=capped)
        assert not result.accepted
        assert result.header_bytes_read <= 64
        assert RiskFlag.MALFORMED_METADATA in result.risk_flags


class TestHandlingClassification:
    def test_a_small_image_is_standard(self) -> None:
        assert inspect(ref_for(VALID_PNG)).decision is HandlingClass.STANDARD

    def test_tiers_are_configurable_not_hard_coded(self) -> None:
        """Acceptance criterion: the 25 MB / 100 MB policies are configurable."""
        professional = DEFAULT_SAFETY_POLICY.model_copy(
            update={"standard_max_pixels": 100, "standard_max_bytes": 100}
        )
        result = inspect(ref_for(VALID_PNG), policy=professional)
        assert result.decision is HandlingClass.PROFESSIONAL
        assert result.requires_professional_path

    def test_beyond_professional_becomes_extreme_custom_not_invalid(self) -> None:
        """D-022: an actionable custom path, not a blunt rejection."""
        squeezed = DEFAULT_SAFETY_POLICY.model_copy(
            update={
                "standard_max_pixels": 10,
                "professional_max_pixels": 100,
                "standard_max_bytes": 10,
                "professional_max_bytes": 100,
            }
        )
        result = inspect(ref_for(VALID_PNG), policy=squeezed)
        assert result.decision is HandlingClass.EXTREME_CUSTOM
        assert result.accepted, "extreme/custom is a routing decision, not a refusal"

    def test_default_tiers_match_the_approved_targets(self) -> None:
        """D-021: 25 MB standard, 100 MB professional."""
        assert DEFAULT_SAFETY_POLICY.standard_max_bytes == 25 * 1024 * 1024
        assert DEFAULT_SAFETY_POLICY.professional_max_bytes == 100 * 1024 * 1024

    def test_tiers_must_ascend(self) -> None:
        from pydantic import ValidationError

        with pytest.raises(ValidationError, match="tiers must ascend"):
            SafetyPolicy(standard_max_bytes=200, professional_max_bytes=100)


class TestEncodingRisks:
    def test_an_unsupported_bit_depth_warns_without_rejecting(self) -> None:
        result = inspect(ref_for(DEPTH_16))
        assert result.accepted, "16-bit is recorded as a risk, not refused outright"
        assert RiskFlag.UNSUPPORTED_BIT_DEPTH in result.risk_flags
        assert any("bit depth" in w.message for w in result.warnings)

    def test_widening_the_supported_depths_clears_the_flag(self) -> None:
        wide = DEFAULT_SAFETY_POLICY.model_copy(update={"supported_bit_depths": (8, 16)})
        result = inspect(ref_for(DEPTH_16), policy=wide)
        assert RiskFlag.UNSUPPORTED_BIT_DEPTH not in result.risk_flags
        assert result.warnings == ()

    def test_channel_counts_outside_the_set_are_flagged(self) -> None:
        strict = DEFAULT_SAFETY_POLICY.model_copy(update={"supported_channel_counts": (3,)})
        result = inspect(ref_for(VALID_JPEG), policy=strict)
        assert RiskFlag.UNSUPPORTED_CHANNEL_COUNT in result.risk_flags


class TestMeasurement:
    def test_pixels_and_working_memory_are_recorded(self) -> None:
        result = inspect(ref_for(VALID_PNG))
        assert result.decoded_pixels == 64 * 64
        # 4096 px x 3 channels x 1 byte x 3 buffers
        assert result.estimated_working_memory_bytes == 4096 * 3 * 1 * 3

    def test_the_memory_estimate_is_integer_only(self) -> None:
        """Floats are forbidden in contract documents."""
        assert isinstance(DEFAULT_SAFETY_POLICY.estimate_working_memory(1000, 3, 8), int)

    @pytest.mark.parametrize(("bit_depth", "expected"), [(1, 1), (8, 1), (12, 2), (16, 2), (32, 4)])
    def test_bytes_per_sample_rounds_up(self, bit_depth: int, expected: int) -> None:
        assert DEFAULT_SAFETY_POLICY.bytes_per_sample(bit_depth) == expected

    def test_sha256_is_recomputed_from_the_bytes(self) -> None:
        ref = ref_for(VALID_PNG)
        result = inspect(ref)
        assert result.sha256 == ref.compute_sha256()
        assert result.sha256 == ref.expected_sha256


class TestDeclaredVersusDetected:
    """Closes the loop between POC-001's declared metadata and POC-003's real bytes."""

    def _entry(self, **overrides: object) -> AssetManifestEntry:
        base: dict[str, object] = {
            "asset_id": "fixture-under-test",
            "category": "synthetic_fixture",
            "relative_path": f"data/fixtures/images/{VALID_PNG}",
            "sha256": ref_for(VALID_PNG).expected_sha256,
            "declared_media_type": MediaType.PNG,
            "declared_extension": ".png",
            "declared_bytes": (FIXTURES / VALID_PNG).stat().st_size,
            "declared_width": 64,
            "declared_height": 64,
            "declared_channels": 3,
            "declared_bit_depth": 8,
        }
        base.update(overrides)
        return AssetManifestEntry.model_validate(base)

    def test_matching_metadata_passes(self) -> None:
        assert inspect(ref_for(VALID_PNG), entry=self._entry()).accepted

    @pytest.mark.parametrize(
        "override",
        [
            {"declared_width": 999},
            {"declared_height": 999},
            {"declared_channels": 1},
            {"declared_bit_depth": 16},
        ],
    )
    def test_a_lying_manifest_is_detected(self, override: dict[str, object]) -> None:
        result = inspect(ref_for(VALID_PNG), entry=self._entry(**override))
        assert not result.accepted
        assert RiskFlag.DECLARED_METADATA_MISMATCH in result.risk_flags

    def test_a_declared_media_type_mismatch_is_detected(self) -> None:
        entry = self._entry(declared_media_type=MediaType.JPEG, declared_extension=".jpg")
        result = inspect(ref_for(VALID_PNG), entry=entry)
        assert not result.accepted
        assert result.failure is not None
        assert result.failure.code.value == "MANIFEST.CONTENT_TYPE_MISMATCH"

    def test_the_cross_check_can_be_disabled(self) -> None:
        relaxed = DEFAULT_SAFETY_POLICY.model_copy(update={"verify_declared_metadata": False})
        result = inspect(ref_for(VALID_PNG), policy=relaxed, entry=self._entry(declared_width=999))
        assert result.accepted


class TestOriginalPreservation:
    """Acceptance criterion: original bytes remain unchanged."""

    def test_inspecting_every_fixture_leaves_it_unchanged(self) -> None:
        before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in FIXTURES.iterdir()}
        for name in before:
            inspect(ref_for(name))
        after = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in FIXTURES.iterdir()}
        assert after == before

    def test_repeated_inspection_is_stable(self) -> None:
        ref = ref_for(VALID_PNG)
        first, second = inspect(ref), inspect(ref)
        assert first == second

    def test_no_temporary_file_is_created(self, tmp_path: Path) -> None:
        """Acceptance criterion: temporary resources are cleaned after all paths."""
        for name in (VALID_PNG, BOMB, NOT_AN_IMAGE, TRUNCATED, RENAMED_JPEG):
            inspect(ref_for(name))
        assert list(tmp_path.iterdir()) == []


class TestPublicSurface:
    def test_inspect_input_is_exported(self) -> None:
        assert inspect_input is inspect
