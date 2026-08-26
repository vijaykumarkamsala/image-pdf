"""Manifest validation - metadata only, no image is ever decoded.

Two layers:

1. **Structural** - pydantic with ``extra="forbid"``. Pydantic's errors are
   translated field-by-field into :class:`~ipw.contracts.failure.NormalizedFailure`
   with an RFC 6901 pointer; a raw ``ValidationError`` is never surfaced.
2. **Policy** - the rules below, each with a stable
   :class:`~ipw.contracts.failure.FailureCode` that tests, reports and CI assert
   on by name.

Scope boundary (approved decision D-B1): POC-001 validates *declared* metadata.
It may stream an asset's bytes to verify SHA-256 and size - a read with no
parsing, so there is no decode-bomb surface - but it never decodes an image.
Real signature sniffing and guarded decoding are POC-003.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path, PurePosixPath
from typing import Any

from pydantic import ValidationError
from pydantic_core import ErrorDetails

from ipw.benchmark_runner.ids import manifest_id_of
from ipw.benchmark_runner.policy import DEFAULT_POLICY, ValidationPolicy
from ipw.contracts.asset import AssetManifestEntry, GroundTruthRelationship
from ipw.contracts.common import ContractModel, NonNegInt
from ipw.contracts.failure import (
    FailureCategory,
    FailureCode,
    NextAction,
    NormalizedFailure,
    Severity,
    failure,
)
from ipw.contracts.manifest import AssetManifest
from ipw.contracts.version import SCHEMA_VERSION

__all__ = [
    "ValidationReport",
    "resolve_asset_path",
    "validate_manifest_file",
    "validate_manifest_model",
]

_WINDOWS_DRIVE = re.compile(r"^[A-Za-z]:")


class ValidationReport(ContractModel):
    """Outcome of validating one manifest document."""

    ok: bool
    manifest_path: str
    manifest_id: str | None = None
    manifest_digest: str | None = None
    manifest_sha256: str | None = None
    policy_digest: str
    policy_name: str
    asset_count: NonNegInt = 0
    hashes_verified: bool = False
    failures: tuple[NormalizedFailure, ...] = ()
    warnings: tuple[NormalizedFailure, ...] = ()

    @property
    def failure_codes(self) -> tuple[str, ...]:
        return tuple(f.code.value for f in self.failures)


# ------------------------------------------------------------------ pointers --


def _escape_token(token: str) -> str:
    """RFC 6901 escaping: ``~`` becomes ``~0`` and ``/`` becomes ``~1``."""
    return token.replace("~", "~0").replace("/", "~1")


def _pointer(*parts: object) -> str:
    return "".join(f"/{_escape_token(str(part))}" for part in parts)


# -------------------------------------------------------------- path safety --


def resolve_asset_path(
    relative_path: str, asset_root: Path, pointer: str
) -> tuple[Path | None, NormalizedFailure | None]:
    """Resolve a manifest-declared path, rejecting every escape attempt.

    Defends the "path traversal in filenames" case from
    ``USER_FLOWS_AND_EDGE_CASES.md`` section 17.
    """

    def reject(reason: str) -> tuple[None, NormalizedFailure]:
        return None, failure(
            FailureCode.MANIFEST_INVALID_PATH,
            FailureCategory.INVALID_INPUT,
            f"asset path is not a safe relative path: {reason}",
            pointer=pointer,
            next_action=NextAction.CHANGE_SETTINGS,
            remediation="Use a POSIX relative path inside the asset root, with no '..' segments.",
            reason=reason,
        )

    if "\\" in relative_path:
        return reject("backslash separators are not permitted")
    if _WINDOWS_DRIVE.match(relative_path):
        return reject("drive-qualified paths are not permitted")
    if relative_path.startswith("//"):
        return reject("UNC paths are not permitted")

    pure = PurePosixPath(relative_path)
    if pure.is_absolute():
        return reject("absolute paths are not permitted")
    if any(part in {"..", ""} for part in pure.parts):
        return reject("'..' segments are not permitted")

    root = asset_root.resolve()
    candidate = (root / relative_path).resolve()
    if candidate != root and root not in candidate.parents:
        return reject("resolved path escapes the asset root")

    probe = candidate
    while probe != root and probe.parent != probe:
        if probe.is_symlink():
            return reject("symlinked paths are not permitted")
        probe = probe.parent

    return candidate, None


# ------------------------------------------------------- structural failures --


# Rights questions a human must answer. A drafted manifest leaves these null, and
# "Input should be a valid boolean" is a poor way to say "you have not answered
# this yet" to the person whose answer is actually required.
RIGHTS_QUESTIONS = {
    "permitted_benchmark_use": "whether this asset may be used in benchmarks at all",
    "public_demo_permitted": "whether results from this asset may be shown publicly",
    "contains_people": "whether the image contains identifiable people",
    "contains_sensitive_information": "whether the image contains sensitive information",
}


def _from_pydantic(error: ErrorDetails) -> NormalizedFailure:
    loc = error.get("loc", ())
    pointer = _pointer(*loc) if loc else None
    kind = str(error.get("type", ""))
    message = str(error.get("msg", "invalid value"))

    field = str(loc[-1]) if loc else ""
    if field in RIGHTS_QUESTIONS and "provenance" in [str(part) for part in loc]:
        return failure(
            FailureCode.MANIFEST_MISSING_PROVENANCE,
            FailureCategory.INVALID_INPUT,
            f"unanswered rights question: {RIGHTS_QUESTIONS[field]}",
            pointer=pointer,
            next_action=NextAction.CHANGE_SETTINGS,
            remediation="Answer true or false. This is not a formality: the answer decides "
            "which run purposes may use the asset, and the system will not guess it.",
            field=field,
        )

    if kind == "missing":
        code = FailureCode.MANIFEST_MISSING_FIELD
    elif kind == "extra_forbidden":
        code = FailureCode.MANIFEST_UNKNOWN_FIELD
        message = "unknown field; check for a typo or an unsupported extension"
    else:
        code = FailureCode.MANIFEST_SCHEMA_INVALID

    return failure(
        code,
        FailureCategory.INVALID_INPUT,
        message,
        pointer=pointer,
        next_action=NextAction.CHANGE_SETTINGS,
        pydantic_type=kind,
    )


# ------------------------------------------------------------- policy rules --


def _check_media_type(
    entry: AssetManifestEntry, index: int, policy: ValidationPolicy
) -> list[NormalizedFailure]:
    found: list[NormalizedFailure] = []
    extension = entry.declared_extension.lower()
    expected = policy.extension_media_types.get(extension)

    if expected is None:
        found.append(
            failure(
                FailureCode.MANIFEST_CONTENT_TYPE_MISMATCH,
                FailureCategory.UNSUPPORTED_FORMAT,
                f"unrecognised file extension {extension}",
                pointer=_pointer("assets", index, "declared_extension"),
                extension=extension,
            )
        )
    elif expected is not entry.declared_media_type:
        found.append(
            failure(
                FailureCode.MANIFEST_CONTENT_TYPE_MISMATCH,
                FailureCategory.INVALID_INPUT,
                f"declared extension {extension} does not match declared media type "
                f"{entry.declared_media_type.value}",
                pointer=_pointer("assets", index, "declared_media_type"),
                remediation="Correct whichever field is wrong. POC-003 additionally verifies "
                "the real file signature.",
                declared_extension=extension,
                declared_media_type=entry.declared_media_type.value,
                expected_media_type=expected.value,
            )
        )

    if entry.declared_media_type not in policy.allowed_media_types:
        allowed = ", ".join(m.value for m in policy.allowed_media_types)
        found.append(
            failure(
                FailureCode.MANIFEST_UNSUPPORTED_MEDIA_TYPE,
                FailureCategory.UNSUPPORTED_FORMAT,
                f"media type {entry.declared_media_type.value} is not in the supported set",
                pointer=_pointer("assets", index, "declared_media_type"),
                next_action=NextAction.CHANGE_SETTINGS,
                remediation=f"Supported media types are: {allowed} (open decision O-007).",
                declared_media_type=entry.declared_media_type.value,
            )
        )
    return found


def _check_limits(
    entry: AssetManifestEntry, index: int, policy: ValidationPolicy
) -> list[NormalizedFailure]:
    found: list[NormalizedFailure] = []

    if entry.declared_pixels > policy.max_declared_pixels:
        found.append(
            failure(
                FailureCode.MANIFEST_DIMENSIONS_EXCEEDED,
                FailureCategory.SAFETY_LIMIT,
                f"declared {entry.declared_width}x{entry.declared_height} = "
                f"{entry.declared_pixels} pixels exceeds the {policy.max_declared_pixels} ceiling",
                pointer=_pointer("assets", index, "declared_width"),
                next_action=NextAction.CONTACT_SUPPORT,
                remediation="Route through the professional or custom path (D-022) rather than "
                "raising the platform-wide ceiling.",
                declared_pixels=entry.declared_pixels,
                max_declared_pixels=policy.max_declared_pixels,
            )
        )

    if entry.declared_bytes > policy.max_declared_bytes:
        found.append(
            failure(
                FailureCode.MANIFEST_BYTES_EXCEEDED,
                FailureCategory.SAFETY_LIMIT,
                f"declared {entry.declared_bytes} bytes exceeds the "
                f"{policy.max_declared_bytes} ceiling",
                pointer=_pointer("assets", index, "declared_bytes"),
                next_action=NextAction.CONTACT_SUPPORT,
                remediation="Extreme inputs use the custom-processing path (D-022).",
                declared_bytes=entry.declared_bytes,
                max_declared_bytes=policy.max_declared_bytes,
            )
        )
    return found


def _check_provenance(
    entry: AssetManifestEntry, index: int, policy: ValidationPolicy
) -> list[NormalizedFailure]:
    if not policy.require_provenance:
        return []
    if entry.provenance is None:
        return [
            failure(
                FailureCode.MANIFEST_MISSING_PROVENANCE,
                FailureCategory.INVALID_INPUT,
                "asset has no provenance record; source, owner, licence and permitted use "
                "must be declared before an asset may enter a benchmark",
                pointer=_pointer("assets", index, "provenance"),
                remediation="Add a provenance block (benchmark plan section 5.3).",
                asset_id=entry.asset_id,
            )
        ]

    found: list[NormalizedFailure] = []
    if policy.require_rights_decision and not entry.provenance.permitted_benchmark_use:
        found.append(
            failure(
                FailureCode.MANIFEST_MISSING_PROVENANCE,
                FailureCategory.ENTITLEMENT_REQUIRED,
                "asset is not marked as permitted for benchmark use",
                pointer=_pointer("assets", index, "provenance", "permitted_benchmark_use"),
                next_action=NextAction.CONTACT_SUPPORT,
                remediation="Obtain and record permission, or remove the asset from the corpus.",
                asset_id=entry.asset_id,
            )
        )
    return found


def _check_ground_truth(
    entry: AssetManifestEntry, index: int, known_ids: set[str]
) -> list[NormalizedFailure]:
    found: list[NormalizedFailure] = []
    if entry.ground_truth is GroundTruthRelationship.PAIRED:
        if entry.ground_truth_asset_id is None:
            found.append(
                failure(
                    FailureCode.MANIFEST_GROUND_TRUTH_UNRESOLVED,
                    FailureCategory.INVALID_INPUT,
                    "paired asset does not name its ground-truth asset",
                    pointer=_pointer("assets", index, "ground_truth_asset_id"),
                )
            )
        elif entry.ground_truth_asset_id not in known_ids:
            found.append(
                failure(
                    FailureCode.MANIFEST_GROUND_TRUTH_UNRESOLVED,
                    FailureCategory.INVALID_INPUT,
                    f"ground-truth asset {entry.ground_truth_asset_id} is not in this manifest",
                    pointer=_pointer("assets", index, "ground_truth_asset_id"),
                    ground_truth_asset_id=entry.ground_truth_asset_id,
                )
            )
        if entry.degradation_recipe is None:
            found.append(
                failure(
                    FailureCode.MANIFEST_DEGRADATION_RECIPE_REQUIRED,
                    FailureCategory.INVALID_INPUT,
                    "a synthetically degraded asset must record its degradation recipe",
                    pointer=_pointer("assets", index, "degradation_recipe"),
                    remediation="Benchmark plan section 5.2 requires the pair to be reproducible.",
                )
            )
    return found


def _check_local_bytes(
    entry: AssetManifestEntry, index: int, policy: ValidationPolicy, asset_root: Path
) -> list[NormalizedFailure]:
    """Path safety, existence, SHA-256 and declared size for locally stored assets."""
    if entry.relative_path is None:
        return []

    pointer = _pointer("assets", index, "relative_path")
    path, path_failure = resolve_asset_path(entry.relative_path, asset_root, pointer)
    if path_failure is not None:
        return [path_failure]
    assert path is not None  # narrowed by path_failure being None

    if not path.is_file():
        return [
            failure(
                FailureCode.MANIFEST_ASSET_FILE_MISSING,
                FailureCategory.INVALID_INPUT,
                "declared asset file does not exist under the asset root",
                pointer=pointer,
                next_action=NextAction.CHANGE_SETTINGS,
                asset_id=entry.asset_id,
            )
        ]

    if not policy.verify_local_hashes:
        return []

    found: list[NormalizedFailure] = []
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
            size += len(chunk)

    actual = digest.hexdigest()
    if actual != entry.sha256:
        found.append(
            failure(
                FailureCode.MANIFEST_HASH_MISMATCH,
                FailureCategory.INVALID_INPUT,
                "asset bytes do not match the declared SHA-256",
                pointer=_pointer("assets", index, "sha256"),
                next_action=NextAction.CONTACT_SUPPORT,
                remediation="The original may have been altered. Investigate before benchmarking.",
                declared_sha256=entry.sha256,
                actual_sha256=actual,
            )
        )
    if policy.verify_local_declared_bytes and size != entry.declared_bytes:
        found.append(
            failure(
                FailureCode.MANIFEST_DECLARED_BYTES_MISMATCH,
                FailureCategory.INVALID_INPUT,
                f"declared {entry.declared_bytes} bytes but the file is {size} bytes",
                pointer=_pointer("assets", index, "declared_bytes"),
                declared_bytes=entry.declared_bytes,
                actual_bytes=size,
            )
        )
    return found


# -------------------------------------------------------------- entry points --


def validate_manifest_model(
    manifest: AssetManifest,
    *,
    policy: ValidationPolicy = DEFAULT_POLICY,
    asset_root: Path,
) -> tuple[tuple[NormalizedFailure, ...], tuple[NormalizedFailure, ...]]:
    """Apply every policy rule to an already structurally valid manifest."""
    failures: list[NormalizedFailure] = []
    warnings: list[NormalizedFailure] = []

    if manifest.schema_version.split(".")[0] != SCHEMA_VERSION.split(".")[0]:
        failures.append(
            failure(
                FailureCode.MANIFEST_SCHEMA_VERSION_UNSUPPORTED,
                FailureCategory.UNSUPPORTED_FEATURE,
                f"manifest declares schema_version {manifest.schema_version}; this runner "
                f"implements {SCHEMA_VERSION}",
                pointer=_pointer("schema_version"),
                declared=manifest.schema_version,
                supported=SCHEMA_VERSION,
            )
        )

    seen: set[str] = set()
    for index, entry in enumerate(manifest.assets):
        if entry.asset_id in seen:
            failures.append(
                failure(
                    FailureCode.MANIFEST_DUPLICATE_ASSET_ID,
                    FailureCategory.INVALID_INPUT,
                    f"asset id {entry.asset_id} appears more than once",
                    pointer=_pointer("assets", index, "asset_id"),
                    remediation="Asset ids must be unique so results map to the correct original.",
                    asset_id=entry.asset_id,
                )
            )
        seen.add(entry.asset_id)

    known_ids = set(manifest.asset_ids)
    for index, entry in enumerate(manifest.assets):
        failures.extend(_check_media_type(entry, index, policy))
        failures.extend(_check_limits(entry, index, policy))
        failures.extend(_check_provenance(entry, index, policy))
        failures.extend(_check_ground_truth(entry, index, known_ids))
        failures.extend(_check_local_bytes(entry, index, policy, asset_root))

        if entry.external_ref is not None and not policy.allow_external_refs:
            failures.append(
                failure(
                    FailureCode.MANIFEST_INVALID_PATH,
                    FailureCategory.UNSUPPORTED_FEATURE,
                    "external asset references are disabled by the active policy",
                    pointer=_pointer("assets", index, "external_ref"),
                )
            )
        if entry.provenance is not None and entry.provenance.contains_sensitive_information:
            warnings.append(
                failure(
                    FailureCode.MANIFEST_MISSING_PROVENANCE,
                    FailureCategory.INVALID_INPUT,
                    "asset is marked as containing sensitive information; handle under restricted "
                    "review and never include it in a public demo",
                    pointer=_pointer("assets", index, "provenance"),
                    severity=Severity.WARNING,
                    next_action=NextAction.NONE,
                    asset_id=entry.asset_id,
                )
            )

    return tuple(failures), tuple(warnings)


def validate_manifest_file(
    manifest_path: Path,
    *,
    policy: ValidationPolicy = DEFAULT_POLICY,
    asset_root: Path,
) -> tuple[ValidationReport, AssetManifest | None]:
    """Validate a manifest document on disk. Never decodes an image."""
    policy_digest = policy.digest()

    def report(
        failures: tuple[NormalizedFailure, ...],
        warnings: tuple[NormalizedFailure, ...] = (),
        **extra: Any,
    ) -> ValidationReport:
        return ValidationReport(
            ok=not failures,
            manifest_path=manifest_path.name,
            policy_digest=policy_digest,
            policy_name=policy.name,
            failures=failures,
            warnings=warnings,
            **extra,
        )

    if not manifest_path.is_file():
        return report(
            (
                failure(
                    FailureCode.MANIFEST_UNREADABLE,
                    FailureCategory.INVALID_INPUT,
                    "manifest file not found",
                    next_action=NextAction.CHANGE_SETTINGS,
                ),
            )
        ), None

    size = manifest_path.stat().st_size
    if size > policy.max_manifest_bytes:
        return report(
            (
                failure(
                    FailureCode.MANIFEST_FILE_TOO_LARGE,
                    FailureCategory.SAFETY_LIMIT,
                    f"manifest is {size} bytes, above the {policy.max_manifest_bytes} limit",
                    next_action=NextAction.CHANGE_SETTINGS,
                    remediation="Split the corpus across several manifests.",
                    size_bytes=size,
                ),
            )
        ), None

    raw = manifest_path.read_bytes()
    manifest_sha256 = hashlib.sha256(raw).hexdigest()

    try:
        document = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        return report(
            (
                failure(
                    FailureCode.MANIFEST_NOT_JSON,
                    FailureCategory.INVALID_INPUT,
                    f"manifest is not valid UTF-8 JSON: {type(exc).__name__}",
                    next_action=NextAction.CHANGE_SETTINGS,
                ),
            ),
            manifest_sha256=manifest_sha256,
        ), None

    try:
        manifest = AssetManifest.model_validate(document)
    except ValidationError as exc:
        return report(
            tuple(_from_pydantic(error) for error in exc.errors()),
            manifest_sha256=manifest_sha256,
        ), None

    failures, warnings = validate_manifest_model(manifest, policy=policy, asset_root=asset_root)
    manifest_json = manifest.model_dump(mode="json")

    return report(
        failures,
        warnings,
        manifest_id=manifest.manifest_id,
        manifest_digest=manifest_id_of(manifest_json),
        manifest_sha256=manifest_sha256,
        asset_count=len(manifest.assets),
        hashes_verified=policy.verify_local_hashes,
    ), manifest
