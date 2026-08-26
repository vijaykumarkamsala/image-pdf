"""Apply the safety policy to a real file and assign a handling class.

Order matters here, and it is the order the acceptance criteria imply:

1. **Signature** - what the bytes say, never what the filename claims.
2. **Header parse** - bounded read, no pixel buffer.
3. **Limits** - pixels, bytes, working memory, expansion ratio. This is where an
   oversized image is refused, *before* anything is allocated.
4. **Classification** - standard, professional, extreme/custom or invalid.
5. **Hash** - streamed over the whole file, so the original's digest is recorded
   without ever holding it in memory.

The original is opened read-only and its digest is verified afterwards. Nothing
here writes, and nothing creates a temporary file.
"""

from __future__ import annotations

from ipw.contracts.asset import AssetManifestEntry, MediaType
from ipw.contracts.failure import (
    FailureCategory,
    FailureCode,
    NextAction,
    NormalizedFailure,
    Severity,
    failure,
)
from ipw.contracts.runtime import InputRef
from ipw.contracts.safety import (
    DEFAULT_SAFETY_POLICY,
    HandlingClass,
    InspectionResult,
    Orientation,
    RiskFlag,
    SafetyPolicy,
)
from ipw.processors.inspection.headers import (
    HeaderParseError,
    ImageHeader,
    SignatureKind,
    detect_signature,
    parse_header,
)

__all__ = ["MEDIA_TYPE_OF_SIGNATURE", "inspect_input"]

MEDIA_TYPE_OF_SIGNATURE: dict[SignatureKind, MediaType] = {
    SignatureKind.PNG: MediaType.PNG,
    SignatureKind.JPEG: MediaType.JPEG,
    SignatureKind.GIF: MediaType.GIF,
    SignatureKind.BMP: MediaType.BMP,
    SignatureKind.TIFF: MediaType.TIFF,
    SignatureKind.WEBP: MediaType.WEBP,
    SignatureKind.HEIF: MediaType.HEIC,
}

_EXTENSION_OF_MEDIA_TYPE: dict[MediaType, tuple[str, ...]] = {
    MediaType.PNG: (".png",),
    MediaType.JPEG: (".jpg", ".jpeg"),
    MediaType.GIF: (".gif",),
    MediaType.BMP: (".bmp",),
    MediaType.TIFF: (".tif", ".tiff"),
    MediaType.WEBP: (".webp",),
    MediaType.HEIC: (".heic",),
    MediaType.AVIF: (".avif",),
}


def _invalid(
    ref: InputRef,
    sha256: str,
    reason: NormalizedFailure,
    *,
    flags: tuple[RiskFlag, ...] = (),
    compressed_bytes: int = 0,
    header_bytes_read: int = 0,
) -> InspectionResult:
    return InspectionResult(
        asset_id=ref.asset_id,
        sha256=sha256,
        decision=HandlingClass.INVALID,
        compressed_bytes=compressed_bytes,
        risk_flags=flags,
        failure=reason,
        header_bytes_read=header_bytes_read,
        pixels_decoded=False,
        inspected_without_decoding=False,
    )


def _classify(
    header: ImageHeader, compressed_bytes: int, working_memory: int, policy: SafetyPolicy
) -> tuple[HandlingClass, NormalizedFailure | None]:
    """Assign a tier, or refuse when every tier's ceiling is exceeded.

    D-022: an oversized professional image gets an actionable custom path rather
    than a blunt rejection. Hard ceilings still exist above that.
    """
    pixels = header.pixels

    if working_memory > policy.max_working_memory_bytes:
        return HandlingClass.INVALID, failure(
            FailureCode.SAFETY_MEMORY_EXCEEDED,
            FailureCategory.SAFETY_LIMIT,
            f"estimated working memory {working_memory} bytes exceeds the "
            f"{policy.max_working_memory_bytes} ceiling",
            next_action=NextAction.CONTACT_SUPPORT,
            remediation="Refused before allocation. Supply a smaller source, or use the "
            "custom-processing path.",
            estimated_working_memory_bytes=working_memory,
            ceiling=policy.max_working_memory_bytes,
        )

    if pixels > policy.extreme_max_pixels:
        return HandlingClass.INVALID, failure(
            FailureCode.SAFETY_PIXELS_EXCEEDED,
            FailureCategory.SAFETY_LIMIT,
            f"{header.width}x{header.height} = {pixels} pixels exceeds the hard ceiling of "
            f"{policy.extreme_max_pixels}",
            next_action=NextAction.CONTACT_SUPPORT,
            remediation="Detected from the header before any pixel buffer was allocated.",
            decoded_pixels=pixels,
            ceiling=policy.extreme_max_pixels,
        )

    if compressed_bytes > policy.extreme_max_bytes:
        return HandlingClass.INVALID, failure(
            FailureCode.SAFETY_BYTES_EXCEEDED,
            FailureCategory.SAFETY_LIMIT,
            f"{compressed_bytes} bytes exceeds the hard ceiling of {policy.extreme_max_bytes}",
            next_action=NextAction.CONTACT_SUPPORT,
            compressed_bytes=compressed_bytes,
            ceiling=policy.extreme_max_bytes,
        )

    if pixels <= policy.standard_max_pixels and compressed_bytes <= policy.standard_max_bytes:
        return HandlingClass.STANDARD, None
    if (
        pixels <= policy.professional_max_pixels
        and compressed_bytes <= policy.professional_max_bytes
    ):
        return HandlingClass.PROFESSIONAL, None
    return HandlingClass.EXTREME_CUSTOM, None


def _encoding_risks(
    header: ImageHeader, policy: SafetyPolicy
) -> tuple[list[RiskFlag], list[NormalizedFailure]]:
    """Risks that come from the encoding itself, rather than from its size."""
    flags: list[RiskFlag] = []
    warnings: list[NormalizedFailure] = []

    if header.bit_depth not in policy.supported_bit_depths:
        flags.append(RiskFlag.UNSUPPORTED_BIT_DEPTH)
        warnings.append(
            failure(
                FailureCode.PROCESSOR_SETTINGS_UNSUPPORTED,
                FailureCategory.UNSUPPORTED_FORMAT,
                f"bit depth {header.bit_depth} is outside the validated set "
                f"{list(policy.supported_bit_depths)}; conversion would be lossy and must be "
                f"disclosed",
                severity=Severity.WARNING,
                next_action=NextAction.CHANGE_SETTINGS,
                bit_depth=header.bit_depth,
            )
        )

    if header.channels not in policy.supported_channel_counts:
        flags.append(RiskFlag.UNSUPPORTED_CHANNEL_COUNT)
        warnings.append(
            failure(
                FailureCode.PROCESSOR_SETTINGS_UNSUPPORTED,
                FailureCategory.UNSUPPORTED_FORMAT,
                f"{header.channels} channels is outside the validated set "
                f"{list(policy.supported_channel_counts)}",
                severity=Severity.WARNING,
                next_action=NextAction.CHANGE_SETTINGS,
                channels=header.channels,
            )
        )

    if header.has_alpha:
        flags.append(RiskFlag.TRANSPARENCY_PRESENT)
    if header.animated:
        flags.append(RiskFlag.ANIMATED_CONTENT)
    if header.interlaced:
        flags.append(RiskFlag.INTERLACED)
    if header.progressive:
        flags.append(RiskFlag.PROGRESSIVE)
    if header.colour_profile == "embedded-icc":
        flags.append(RiskFlag.UNSUPPORTED_COLOUR_PROFILE)
    if any("exceeds the available bytes" in note for note in header.notes):
        flags.append(RiskFlag.TRUNCATED)

    return flags, warnings


def _declared_mismatches(
    header: ImageHeader,
    detected: MediaType,
    entry: AssetManifestEntry,
) -> list[NormalizedFailure]:
    """Cross-check what the manifest declared against what the bytes actually say.

    Closes the loop between POC-001 (declared metadata) and POC-003 (real bytes):
    a manifest that lies about its own corpus is now detectable.
    """
    found: list[NormalizedFailure] = []

    if entry.declared_media_type is not detected:
        found.append(
            failure(
                FailureCode.MANIFEST_CONTENT_TYPE_MISMATCH,
                FailureCategory.INVALID_INPUT,
                f"manifest declares {entry.declared_media_type.value} but the bytes are "
                f"{detected.value}",
                next_action=NextAction.CHANGE_SETTINGS,
                declared=entry.declared_media_type.value,
                detected=detected.value,
            )
        )

    for label, declared, actual in (
        ("width", entry.declared_width, header.width),
        ("height", entry.declared_height, header.height),
        ("channels", entry.declared_channels, header.channels),
        ("bit_depth", entry.declared_bit_depth, header.bit_depth),
    ):
        if declared != actual:
            found.append(
                failure(
                    FailureCode.MANIFEST_DECLARED_BYTES_MISMATCH,
                    FailureCategory.INVALID_INPUT,
                    f"manifest declares {label} {declared} but the header says {actual}",
                    next_action=NextAction.CHANGE_SETTINGS,
                    field=label,
                    declared=declared,
                    detected=actual,
                )
            )
    return found


def inspect_input(
    ref: InputRef,
    *,
    policy: SafetyPolicy = DEFAULT_SAFETY_POLICY,
    entry: AssetManifestEntry | None = None,
) -> InspectionResult:
    """Inspect a real file and assign a handling class. Never decodes pixels.

    ``entry`` enables the declared-versus-detected cross-check. Without it the
    inspection still runs; it simply has nothing to compare against.
    """
    if not ref.exists:
        return _invalid(
            ref,
            "0" * 64,
            failure(
                FailureCode.MANIFEST_ASSET_FILE_MISSING,
                FailureCategory.INVALID_INPUT,
                "asset file does not exist",
                next_action=NextAction.CHANGE_SETTINGS,
                asset_id=ref.asset_id,
            ),
        )

    compressed_bytes = ref.size_bytes
    sha256 = ref.compute_sha256()

    # A bounded read: enough for any header, never the whole file.
    with ref.open_readonly() as handle:
        head = handle.read(min(policy.max_header_bytes, compressed_bytes))

    # -- 1. signature ------------------------------------------------------
    kind = detect_signature(head)
    if kind is SignatureKind.UNKNOWN:
        return _invalid(
            ref,
            sha256,
            failure(
                FailureCode.MANIFEST_UNSUPPORTED_MEDIA_TYPE,
                FailureCategory.UNSUPPORTED_FORMAT,
                "file signature is not recognised as a supported image format",
                next_action=NextAction.CHANGE_SETTINGS,
                remediation="Content is identified by its bytes, never by its filename.",
                asset_id=ref.asset_id,
            ),
            compressed_bytes=compressed_bytes,
            header_bytes_read=len(head),
        )

    detected = MEDIA_TYPE_OF_SIGNATURE[kind]
    flags: list[RiskFlag] = []
    warnings: list[NormalizedFailure] = []

    # -- 2. extension versus signature ------------------------------------
    expected_extensions = _EXTENSION_OF_MEDIA_TYPE.get(detected, ())
    if ref.suffix and expected_extensions and ref.suffix not in expected_extensions:
        return _invalid(
            ref,
            sha256,
            failure(
                FailureCode.MANIFEST_CONTENT_TYPE_MISMATCH,
                FailureCategory.INVALID_INPUT,
                f"file extension {ref.suffix} does not match the detected format {detected.value}",
                next_action=NextAction.CHANGE_SETTINGS,
                remediation="A renamed file is a classic upload attack; the signature wins.",
                extension=ref.suffix,
                detected=detected.value,
            ),
            flags=(RiskFlag.EXTENSION_SIGNATURE_MISMATCH,),
            compressed_bytes=compressed_bytes,
            header_bytes_read=len(head),
        )

    if detected not in policy.supported_media_types:
        return _invalid(
            ref,
            sha256,
            failure(
                FailureCode.MANIFEST_UNSUPPORTED_MEDIA_TYPE,
                FailureCategory.UNSUPPORTED_FORMAT,
                f"{detected.value} is not in the validated media type set",
                next_action=NextAction.CHANGE_SETTINGS,
                remediation=f"Supported: {[m.value for m in policy.supported_media_types]} "
                f"(open decision O-007).",
                detected=detected.value,
            ),
            flags=(RiskFlag.UNSUPPORTED_ENCODING,),
            compressed_bytes=compressed_bytes,
            header_bytes_read=len(head),
        )

    # -- 3. header parse, still nothing allocated --------------------------
    try:
        header = parse_header(kind, head)
    except HeaderParseError as exc:
        return _invalid(
            ref,
            sha256,
            failure(
                FailureCode.MANIFEST_SCHEMA_INVALID,
                FailureCategory.INVALID_INPUT,
                f"header could not be parsed: {exc}",
                next_action=NextAction.CHANGE_SETTINGS,
                remediation="The file is malformed or truncated.",
                asset_id=ref.asset_id,
            ),
            flags=(RiskFlag.MALFORMED_METADATA,),
            compressed_bytes=compressed_bytes,
            header_bytes_read=len(head),
        )

    pixels = header.pixels
    working_memory = policy.estimate_working_memory(pixels, header.channels, header.bit_depth)
    decoded_bytes = pixels * header.channels * policy.bytes_per_sample(header.bit_depth)
    expansion_ratio = decoded_bytes // compressed_bytes if compressed_bytes else 0

    encoding_flags, encoding_warnings = _encoding_risks(header, policy)
    flags.extend(encoding_flags)
    warnings.extend(encoding_warnings)

    # -- 4. decompression bomb --------------------------------------------
    if (
        pixels >= policy.decompression_bomb_min_pixels
        and expansion_ratio >= policy.decompression_bomb_ratio
    ):
        flags.append(RiskFlag.DECOMPRESSION_BOMB)
        return _invalid(
            ref,
            sha256,
            failure(
                FailureCode.SAFETY_DECOMPRESSION_BOMB,
                FailureCategory.SAFETY_LIMIT,
                f"decompression bomb: {compressed_bytes} compressed bytes declare {pixels} "
                f"pixels, an expansion of {expansion_ratio}x",
                next_action=NextAction.CONTACT_SUPPORT,
                remediation="Rejected from the header. No pixel buffer was allocated.",
                compressed_bytes=compressed_bytes,
                decoded_pixels=pixels,
                expansion_ratio=expansion_ratio,
            ),
            flags=tuple(flags),
            compressed_bytes=compressed_bytes,
            header_bytes_read=header.bytes_examined,
        )

    # -- 5. tier classification -------------------------------------------
    decision, limit_failure = _classify(header, compressed_bytes, working_memory, policy)
    if limit_failure is not None:
        flags.append(
            RiskFlag.EXCESSIVE_WORKING_MEMORY
            if limit_failure.code is FailureCode.SAFETY_MEMORY_EXCEEDED
            else RiskFlag.EXCESSIVE_BYTES
            if limit_failure.code is FailureCode.SAFETY_BYTES_EXCEEDED
            else RiskFlag.EXCESSIVE_PIXELS
        )
        return _invalid(
            ref,
            sha256,
            limit_failure,
            flags=tuple(flags),
            compressed_bytes=compressed_bytes,
            header_bytes_read=header.bytes_examined,
        )

    # -- 6. orientation, normalised as metadata only ----------------------
    orientation = Orientation.from_exif(header.exif_orientation)
    if header.exif_orientation is not None and not orientation.is_identity:
        flags.append(RiskFlag.ORIENTATION_METADATA_PRESENT)
    display_width, display_height = (
        (header.height, header.width) if orientation.swaps_axes else (header.width, header.height)
    )

    # -- 7. declared versus detected --------------------------------------
    if entry is not None and policy.verify_declared_metadata:
        mismatches = _declared_mismatches(header, detected, entry)
        if mismatches:
            flags.append(RiskFlag.DECLARED_METADATA_MISMATCH)
            return _invalid(
                ref,
                sha256,
                mismatches[0],
                flags=tuple(flags),
                compressed_bytes=compressed_bytes,
                header_bytes_read=header.bytes_examined,
            )

    return InspectionResult(
        asset_id=ref.asset_id,
        sha256=sha256,
        decision=decision,
        detected_media_type=detected,
        detected_encoding=header.encoding,
        decoded_width=header.width,
        decoded_height=header.height,
        display_width=display_width,
        display_height=display_height,
        decoded_channels=header.channels,
        decoded_bit_depth=header.bit_depth,
        has_alpha=header.has_alpha,
        orientation=orientation,
        colour_profile=header.colour_profile,
        compressed_bytes=compressed_bytes,
        decoded_pixels=pixels,
        estimated_working_memory_bytes=working_memory,
        expansion_ratio=expansion_ratio,
        risk_flags=tuple(dict.fromkeys(flags)),
        failure=None,
        warnings=tuple(warnings),
        header_bytes_read=header.bytes_examined,
        pixels_decoded=False,
        inspected_without_decoding=False,
    )
