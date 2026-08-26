"""Manifest validation: the example manifest passes, every negative fixture fails precisely.

Acceptance criteria 2 and 3.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from ipw.benchmark_runner.policy import DEFAULT_POLICY, ValidationPolicy, load_policy
from ipw.benchmark_runner.validation import (
    resolve_asset_path,
    validate_manifest_file,
)
from ipw.contracts.failure import FailureCategory, NextAction, Severity

# Each negative fixture and the exact failure code it must produce.
NEGATIVE_CASES: dict[str, str] = {
    "content-type-mismatch.json": "MANIFEST.CONTENT_TYPE_MISMATCH",
    "dimensions-exceeded.json": "MANIFEST.DIMENSIONS_EXCEEDED",
    "missing-provenance.json": "MANIFEST.MISSING_PROVENANCE",
    "path-traversal.json": "MANIFEST.INVALID_PATH",
    "duplicate-asset-id.json": "MANIFEST.DUPLICATE_ASSET_ID",
    "hash-mismatch.json": "MANIFEST.HASH_MISMATCH",
    "unsupported-media-type.json": "MANIFEST.UNSUPPORTED_MEDIA_TYPE",
    "bytes-exceeded.json": "MANIFEST.BYTES_EXCEEDED",
    "unknown-field.json": "MANIFEST.UNKNOWN_FIELD",
    "ground-truth-unresolved.json": "MANIFEST.GROUND_TRUTH_UNRESOLVED",
}

# Fixtures whose failure set is exactly one code. 'unknown-field' is excluded
# because a rejected asset also empties the assets tuple, which trips its
# min_length rule; 'ground-truth-unresolved' deliberately trips two rules.
EXACT_SINGLE_CODE = set(NEGATIVE_CASES) - {"unknown-field.json", "ground-truth-unresolved.json"}


class TestExampleManifest:
    def test_validates_successfully(self, example_manifest_path: Path, repo_root: Path) -> None:
        report, manifest = validate_manifest_file(
            example_manifest_path, policy=DEFAULT_POLICY, asset_root=repo_root
        )
        assert report.ok, f"unexpected failures: {report.failure_codes}"
        assert manifest is not None
        assert report.failures == ()

    def test_records_provenance_anchors(self, example_manifest_path: Path, repo_root: Path) -> None:
        report, _ = validate_manifest_file(
            example_manifest_path, policy=DEFAULT_POLICY, asset_root=repo_root
        )
        assert report.manifest_id == "example-corpus"
        assert report.manifest_digest is not None
        assert report.manifest_digest.startswith("mfst_")
        assert report.manifest_sha256 is not None
        assert report.policy_digest.startswith("pol_")
        assert report.asset_count == 2
        assert report.hashes_verified is True

    def test_digest_is_independent_of_file_formatting(
        self, example_manifest_path: Path, repo_root: Path, tmp_path: Path
    ) -> None:
        """Reformatting a manifest must not change its content digest."""
        original, _ = validate_manifest_file(
            example_manifest_path, policy=DEFAULT_POLICY, asset_root=repo_root
        )
        document = json.loads(example_manifest_path.read_text(encoding="utf-8"))
        reformatted = tmp_path / "reformatted.json"
        reformatted.write_text(json.dumps(document, indent=8), encoding="utf-8")

        other, _ = validate_manifest_file(reformatted, policy=DEFAULT_POLICY, asset_root=repo_root)
        assert other.manifest_digest == original.manifest_digest
        assert other.manifest_sha256 != original.manifest_sha256


class TestNegativeFixtures:
    @pytest.mark.parametrize(("filename", "expected_code"), sorted(NEGATIVE_CASES.items()))
    def test_produces_expected_code(
        self, invalid_manifest_dir: Path, repo_root: Path, filename: str, expected_code: str
    ) -> None:
        report, _ = validate_manifest_file(
            invalid_manifest_dir / filename, policy=DEFAULT_POLICY, asset_root=repo_root
        )
        assert not report.ok
        assert expected_code in report.failure_codes, (
            f"{filename} produced {report.failure_codes}, expected {expected_code}"
        )

    @pytest.mark.parametrize("filename", sorted(EXACT_SINGLE_CODE))
    def test_produces_exactly_one_failure(
        self, invalid_manifest_dir: Path, repo_root: Path, filename: str
    ) -> None:
        report, _ = validate_manifest_file(
            invalid_manifest_dir / filename, policy=DEFAULT_POLICY, asset_root=repo_root
        )
        assert len(report.failures) == 1, (
            f"{filename} should isolate one rule, got {report.failure_codes}"
        )

    def test_paired_asset_needs_a_degradation_recipe(
        self, invalid_manifest_dir: Path, repo_root: Path
    ) -> None:
        report, _ = validate_manifest_file(
            invalid_manifest_dir / "ground-truth-unresolved.json",
            policy=DEFAULT_POLICY,
            asset_root=repo_root,
        )
        assert "MANIFEST.DEGRADATION_RECIPE_REQUIRED" in report.failure_codes


class TestNormalizedFailureShape:
    def test_every_failure_is_actionable(self, invalid_manifest_dir: Path, repo_root: Path) -> None:
        """USER_FLOWS section 18: every failure states what the caller can do next."""
        for filename in sorted(NEGATIVE_CASES):
            report, _ = validate_manifest_file(
                invalid_manifest_dir / filename, policy=DEFAULT_POLICY, asset_root=repo_root
            )
            for item in report.failures:
                assert item.message, f"{filename}: failure {item.code} has no message"
                assert isinstance(item.category, FailureCategory)
                assert isinstance(item.next_action, NextAction)
                assert item.severity is Severity.ERROR

    def test_pointers_are_rfc6901(self, invalid_manifest_dir: Path, repo_root: Path) -> None:
        report, _ = validate_manifest_file(
            invalid_manifest_dir / "content-type-mismatch.json",
            policy=DEFAULT_POLICY,
            asset_root=repo_root,
        )
        pointer = report.failures[0].pointer
        assert pointer == "/assets/0/declared_media_type"

    def test_failures_never_leak_absolute_paths(
        self, invalid_manifest_dir: Path, repo_root: Path
    ) -> None:
        """AGENTS.md: do not log sensitive paths."""
        for filename in sorted(NEGATIVE_CASES):
            report, _ = validate_manifest_file(
                invalid_manifest_dir / filename, policy=DEFAULT_POLICY, asset_root=repo_root
            )
            blob = json.dumps(report.model_dump(mode="json"))
            assert str(repo_root) not in blob, f"{filename} leaked the repository path"


class TestPathSafety:
    @pytest.mark.parametrize(
        "candidate",
        [
            "../escape.png",
            "a/../../escape.png",
            "/etc/passwd",
            "//server/share/x.png",
            r"C:\Windows\system.ini",
            r"assets\windows.png",
        ],
    )
    def test_hostile_paths_are_rejected(self, candidate: str, repo_root: Path) -> None:
        path, failure = resolve_asset_path(candidate, repo_root, "/p")
        assert path is None
        assert failure is not None
        assert failure.code.value == "MANIFEST.INVALID_PATH"
        assert failure.category is FailureCategory.INVALID_INPUT

    def test_safe_relative_path_is_accepted(self, repo_root: Path) -> None:
        path, failure = resolve_asset_path(
            "data/fixtures/images/synthetic-gradient-64.png", repo_root, "/p"
        )
        assert failure is None
        assert path is not None
        assert path.is_file()


class TestPolicyIsConfigurable:
    """POC-003 requires size policies to be configurable, not hard-coded."""

    def test_tightened_pixel_ceiling_rejects_a_previously_valid_manifest(
        self, example_manifest_path: Path, repo_root: Path
    ) -> None:
        strict = DEFAULT_POLICY.model_copy(update={"max_declared_pixels": 1000})
        report, _ = validate_manifest_file(
            example_manifest_path, policy=strict, asset_root=repo_root
        )
        assert "MANIFEST.DIMENSIONS_EXCEEDED" in report.failure_codes

    def test_widened_media_type_allowlist_accepts_tiff(
        self, invalid_manifest_dir: Path, repo_root: Path
    ) -> None:
        from ipw.contracts.asset import MediaType

        relaxed = DEFAULT_POLICY.model_copy(
            update={"allowed_media_types": (MediaType.JPEG, MediaType.PNG, MediaType.TIFF)}
        )
        report, _ = validate_manifest_file(
            invalid_manifest_dir / "unsupported-media-type.json",
            policy=relaxed,
            asset_root=repo_root,
        )
        assert report.ok

    def test_policy_digest_changes_with_the_policy(self) -> None:
        tightened = DEFAULT_POLICY.model_copy(update={"max_declared_pixels": 1000})
        assert tightened.digest() != DEFAULT_POLICY.digest()

    def test_policy_loads_from_json(self, tmp_path: Path) -> None:
        path = tmp_path / "policy.json"
        payload = DEFAULT_POLICY.model_dump(mode="json")
        payload["name"] = "strict"
        payload["max_declared_pixels"] = 999
        path.write_text(json.dumps(payload), encoding="utf-8")

        loaded = load_policy(path)
        assert loaded.name == "strict"
        assert loaded.max_declared_pixels == 999
        assert load_policy(None) is DEFAULT_POLICY


class TestDocumentLevelFailures:
    def test_missing_file(self, tmp_path: Path, repo_root: Path) -> None:
        report, manifest = validate_manifest_file(
            tmp_path / "nope.json", policy=DEFAULT_POLICY, asset_root=repo_root
        )
        assert manifest is None
        assert report.failure_codes == ("MANIFEST.UNREADABLE",)

    def test_not_json(self, tmp_path: Path, repo_root: Path) -> None:
        path = tmp_path / "bad.json"
        path.write_text("{not json", encoding="utf-8")
        report, manifest = validate_manifest_file(path, policy=DEFAULT_POLICY, asset_root=repo_root)
        assert manifest is None
        assert report.failure_codes == ("MANIFEST.NOT_JSON",)

    def test_oversized_manifest_is_rejected_before_parsing(
        self, tmp_path: Path, repo_root: Path
    ) -> None:
        path = tmp_path / "huge.json"
        path.write_text("[" + "0," * 5000 + "0]", encoding="utf-8")
        tiny: ValidationPolicy = DEFAULT_POLICY.model_copy(update={"max_manifest_bytes": 16})
        report, manifest = validate_manifest_file(path, policy=tiny, asset_root=repo_root)
        assert manifest is None
        assert report.failure_codes == ("MANIFEST.FILE_TOO_LARGE",)

    def test_unsupported_major_schema_version(
        self, example_manifest_path: Path, tmp_path: Path, repo_root: Path
    ) -> None:
        document = json.loads(example_manifest_path.read_text(encoding="utf-8"))
        document["schema_version"] = "9.0.0"
        path = tmp_path / "future.json"
        path.write_text(json.dumps(document), encoding="utf-8")

        report, _ = validate_manifest_file(path, policy=DEFAULT_POLICY, asset_root=repo_root)
        assert "MANIFEST.SCHEMA_VERSION_UNSUPPORTED" in report.failure_codes

    def test_missing_required_field_maps_to_missing_field(
        self, example_manifest_path: Path, tmp_path: Path, repo_root: Path
    ) -> None:
        document = json.loads(example_manifest_path.read_text(encoding="utf-8"))
        del document["assets"][0]["sha256"]
        path = tmp_path / "incomplete.json"
        path.write_text(json.dumps(document), encoding="utf-8")

        report, manifest = validate_manifest_file(path, policy=DEFAULT_POLICY, asset_root=repo_root)
        assert manifest is None
        assert "MANIFEST.MISSING_FIELD" in report.failure_codes

    def test_hash_verification_can_be_disabled(
        self, invalid_manifest_dir: Path, repo_root: Path
    ) -> None:
        relaxed = DEFAULT_POLICY.model_copy(
            update={"verify_local_hashes": False, "verify_local_declared_bytes": False}
        )
        report, _ = validate_manifest_file(
            invalid_manifest_dir / "hash-mismatch.json", policy=relaxed, asset_root=repo_root
        )
        assert report.ok
        assert report.hashes_verified is False

    def test_declared_byte_count_is_checked(
        self, example_manifest_path: Path, tmp_path: Path, repo_root: Path
    ) -> None:
        document = json.loads(example_manifest_path.read_text(encoding="utf-8"))
        document["assets"][0]["declared_bytes"] = 999
        path = tmp_path / "wrong-size.json"
        path.write_text(json.dumps(document), encoding="utf-8")

        report, _ = validate_manifest_file(path, policy=DEFAULT_POLICY, asset_root=repo_root)
        assert "MANIFEST.DECLARED_BYTES_MISMATCH" in report.failure_codes

    def test_missing_asset_file_is_reported(
        self, example_manifest_path: Path, tmp_path: Path, repo_root: Path
    ) -> None:
        document = json.loads(example_manifest_path.read_text(encoding="utf-8"))
        document["assets"][0]["relative_path"] = "data/fixtures/images/absent.png"
        path = tmp_path / "absent.json"
        path.write_text(json.dumps(document), encoding="utf-8")

        report, _ = validate_manifest_file(path, policy=DEFAULT_POLICY, asset_root=repo_root)
        assert "MANIFEST.ASSET_FILE_MISSING" in report.failure_codes


class TestWarnings:
    def test_sensitive_content_raises_a_warning_not_a_failure(
        self, example_manifest_path: Path, tmp_path: Path, repo_root: Path
    ) -> None:
        document = json.loads(example_manifest_path.read_text(encoding="utf-8"))
        document["assets"][0]["provenance"]["contains_sensitive_information"] = True
        path = tmp_path / "sensitive.json"
        path.write_text(json.dumps(document), encoding="utf-8")

        report, _ = validate_manifest_file(path, policy=DEFAULT_POLICY, asset_root=repo_root)
        assert report.ok, "sensitive content is a warning, not a validation failure"
        assert len(report.warnings) == 1
        assert report.warnings[0].severity is Severity.WARNING

    def test_asset_not_permitted_for_benchmark_use_is_blocked(
        self, example_manifest_path: Path, tmp_path: Path, repo_root: Path
    ) -> None:
        document = json.loads(example_manifest_path.read_text(encoding="utf-8"))
        document["assets"][0]["provenance"]["permitted_benchmark_use"] = False
        path = tmp_path / "not-permitted.json"
        path.write_text(json.dumps(document), encoding="utf-8")

        report, _ = validate_manifest_file(path, policy=DEFAULT_POLICY, asset_root=repo_root)
        assert "MANIFEST.MISSING_PROVENANCE" in report.failure_codes
        offending = next(f for f in report.failures if f.pointer and "permitted" in f.pointer)
        assert offending.category is FailureCategory.ENTITLEMENT_REQUIRED
