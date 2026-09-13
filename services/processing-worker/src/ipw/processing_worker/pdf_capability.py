"""Strict, non-rendering capability inspection for immutable imported PDFs."""

from __future__ import annotations

import hashlib
import re
from io import BytesIO
from typing import Any

import pypdf
from pypdf import PdfReader
from pypdf.errors import PdfReadError
from pypdf.generic import ArrayObject, DictionaryObject, IndirectObject, NameObject

from ipw.contracts.pdf_management import (
    PdfCapabilityAnalysis,
    PdfCapabilityAnalysisState,
    PdfCapabilityClassification,
    PdfFeature,
    PdfFeatureFinding,
    PdfFeatureState,
    PdfInspectorIdentity,
    PdfOpeningMode,
    PdfOperation,
    PdfOperationAvailability,
    PdfOperationState,
)

PDF_CAPABILITY_INSPECTOR_VERSION = "1.0.0"
PINNED_PYPDF_VERSION = "6.18.1"
MAX_OBJECT_VISITS = 20_000

_ACTIVE_KEYS = {
    "/JS",
    "/JavaScript",
    "/Launch",
    "/RichMedia",
}
_ACTIVE_ACTIONS = {"/GoToR", "/ImportData", "/JavaScript", "/Launch", "/SubmitForm"}


class PdfObjectLimitError(ValueError):
    """Raised when a PDF object graph exceeds the bounded inspection budget."""


def inspect_pdf_capabilities(
    data: bytes,
    *,
    source_sha256: str,
    page_limit: int = 500,
) -> PdfCapabilityAnalysis:
    """Inspect a PDF without rendering content or executing embedded actions."""

    if pypdf.__version__ != PINNED_PYPDF_VERSION:
        raise RuntimeError("the imported-PDF inspector requires the pinned pypdf version")
    if hashlib.sha256(data).hexdigest() != source_sha256:
        raise ValueError("PDF capability input no longer matches its immutable source digest")
    version = _pdf_version(data)
    inspector = _inspector_identity()
    try:
        reader = PdfReader(BytesIO(data), strict=True)
        if reader.is_encrypted:
            return _encrypted_analysis(source_sha256, version, inspector)
        page_count = len(reader.pages)
        if page_count < 1:
            raise PdfReadError("PDF page tree contains no pages")
        if page_count > page_limit:
            raise PdfObjectLimitError("PDF page count exceeds the configured intake limit")
        evidence = _scan_reader(reader)
        return _analysis_from_evidence(
            source_sha256=source_sha256,
            version=version,
            page_count=page_count,
            evidence=evidence,
            inspector=inspector,
        )
    except (PdfReadError, PdfObjectLimitError, RecursionError, TypeError, ValueError) as error:
        return _unreadable_analysis(source_sha256, version, inspector, str(error))


def _pdf_version(data: bytes) -> str | None:
    match = re.match(rb"%PDF-(1\.[0-9])(?:\r|\n)", data[:16])
    return match.group(1).decode("ascii") if match else None


def _inspector_identity() -> PdfInspectorIdentity:
    return PdfInspectorIdentity(
        name="IPW strict imported-PDF capability inspector",
        version=PDF_CAPABILITY_INSPECTOR_VERSION,
        library_name="pypdf",
        library_version=pypdf.__version__,
        max_object_visits=MAX_OBJECT_VISITS,
    )


def _encrypted_analysis(
    source_sha256: str,
    version: str | None,
    inspector: PdfInspectorIdentity,
) -> PdfCapabilityAnalysis:
    findings = _findings(
        {
            PdfFeature.ENCRYPTION: (
                PdfFeatureState.PRESENT,
                "The document is encrypted; no password was used during intake.",
            ),
            PdfFeature.DOCUMENT_PERMISSIONS: (
                PdfFeatureState.RESTRICTED,
                "Permissions remain unavailable until an authorised credential is supplied.",
            ),
        },
        default=(
            PdfFeatureState.UNKNOWN,
            "This feature cannot be inspected without an authorised password.",
        ),
    )
    return PdfCapabilityAnalysis(
        source_sha256=source_sha256,
        pdf_version=version,
        page_count=None,
        analysis_state=PdfCapabilityAnalysisState.RESTRICTED,
        classification=PdfCapabilityClassification.VIEW_ONLY,
        opening_mode=PdfOpeningMode.CREDENTIAL_REQUIRED,
        original_protected=True,
        findings=findings,
        operations=_operations("encrypted"),
        compatibility_notes=(
            "The encrypted original remains immutable and private.",
            "Unlock is not attempted automatically and password bypass is not supported.",
        ),
        inspector=inspector,
    )


def _unreadable_analysis(
    source_sha256: str,
    version: str | None,
    inspector: PdfInspectorIdentity,
    detail: str,
) -> PdfCapabilityAnalysis:
    safe_detail = _safe_parse_detail(detail)
    findings = _findings(
        {
            PdfFeature.ENCRYPTION: (
                PdfFeatureState.UNKNOWN,
                "Encryption could not be established from the unreadable structure.",
            ),
            PdfFeature.DOCUMENT_PERMISSIONS: (
                PdfFeatureState.UNKNOWN,
                "Document permissions could not be inspected safely.",
            ),
        },
        default=(
            PdfFeatureState.UNKNOWN,
            "This feature could not be verified from the unreadable PDF structure.",
        ),
    )
    return PdfCapabilityAnalysis(
        source_sha256=source_sha256,
        pdf_version=version,
        page_count=None,
        analysis_state=PdfCapabilityAnalysisState.UNREADABLE,
        classification=PdfCapabilityClassification.VIEW_ONLY,
        opening_mode=PdfOpeningMode.RESTRICTED_SAFE_VIEW,
        original_protected=True,
        findings=findings,
        operations=_operations("unreadable"),
        compatibility_notes=(
            "The original was preserved, but strict structural inspection could not complete.",
            f"Safe parser result: {safe_detail}",
            "No rendering or PDF mutation is allowed from this report.",
        ),
        inspector=inspector,
    )


def _safe_parse_detail(detail: str) -> str:
    collapsed = " ".join(detail.split())
    collapsed = re.sub(r"(?:[A-Za-z]:)?[/\\][^\s]+", "[path removed]", collapsed)
    return (collapsed or "unsupported or malformed PDF structure")[:240]


def _scan_reader(reader: PdfReader) -> dict[str, bool]:
    evidence = {
        "active": False,
        "attachments": False,
        "permissions": False,
        "signatures": False,
        "forms": False,
        "xfa": False,
        "annotations": False,
        "layers": False,
        "tags": False,
        "fonts": False,
        "images": False,
        "mixed_page_sizes": False,
    }
    root = reader.trailer.get("/Root")
    root_object = _resolve(root)
    if isinstance(root_object, DictionaryObject):
        evidence["forms"] = "/AcroForm" in root_object
        evidence["permissions"] = "/Perms" in root_object
        evidence["layers"] = "/OCProperties" in root_object
        evidence["tags"] = "/StructTreeRoot" in root_object or _marked(root_object.get("/MarkInfo"))
        names = _resolve(root_object.get("/Names"))
        if isinstance(names, DictionaryObject):
            evidence["attachments"] = "/EmbeddedFiles" in names
            evidence["active"] = "/JavaScript" in names
    page_sizes: set[tuple[int, int]] = set()
    for page in reader.pages:
        page_sizes.add(
            (round(float(page.mediabox.width) * 1000), round(float(page.mediabox.height) * 1000))
        )
        annotations = _resolve(page.get("/Annots"))
        evidence["annotations"] |= isinstance(annotations, ArrayObject) and bool(annotations)
        resources = _resolve(page.get("/Resources"))
        if isinstance(resources, DictionaryObject):
            fonts = _resolve(resources.get("/Font"))
            evidence["fonts"] |= isinstance(fonts, DictionaryObject) and bool(fonts)
            xobjects = _resolve(resources.get("/XObject"))
            if isinstance(xobjects, DictionaryObject):
                for value in xobjects.values():
                    resolved = _resolve(value)
                    evidence["images"] |= (
                        isinstance(resolved, DictionaryObject)
                        and str(resolved.get("/Subtype")) == "/Image"
                    )
    evidence["mixed_page_sizes"] = len(page_sizes) > 1
    _walk_objects(root_object, evidence)
    return evidence


def _walk_objects(root: Any, evidence: dict[str, bool]) -> None:
    pending: list[Any] = [root]
    indirect_seen: set[tuple[int, int]] = set()
    direct_seen: set[int] = set()
    visits = 0
    while pending:
        current = pending.pop()
        if isinstance(current, IndirectObject):
            indirect_identity = (current.idnum, current.generation)
            if indirect_identity in indirect_seen:
                continue
            indirect_seen.add(indirect_identity)
            current = current.get_object()
        elif isinstance(current, (DictionaryObject, ArrayObject)):
            direct_identity = id(current)
            if direct_identity in direct_seen:
                continue
            direct_seen.add(direct_identity)
        else:
            continue
        visits += 1
        if visits > MAX_OBJECT_VISITS:
            raise PdfObjectLimitError("PDF object graph exceeds the safe inspection budget")
        if isinstance(current, DictionaryObject):
            keys = {str(key) for key in current}
            evidence["active"] |= (
                bool(keys & _ACTIVE_KEYS) or str(current.get("/S")) in _ACTIVE_ACTIONS
            )
            evidence["attachments"] |= (
                "/EmbeddedFiles" in keys or "/EmbeddedFile" in keys or "/EF" in keys
            )
            evidence["signatures"] |= (
                str(current.get("/FT")) == "/Sig"
                or str(current.get("/Type")) == "/Sig"
                or "/DocMDP" in keys
            )
            evidence["permissions"] |= bool(keys & {"/Perms", "/UR3", "/DocMDP"})
            evidence["forms"] |= "/AcroForm" in keys or "/Fields" in keys
            evidence["xfa"] |= "/XFA" in keys
            evidence["annotations"] |= str(current.get("/Type")) == "/Annot" or "/Annots" in keys
            evidence["layers"] |= "/OCProperties" in keys or "/OCGs" in keys
            evidence["tags"] |= "/StructTreeRoot" in keys or "/StructParents" in keys
            evidence["fonts"] |= str(current.get("/Type")) == "/Font" or "/Font" in keys
            evidence["images"] |= str(current.get("/Subtype")) == "/Image"
            pending.extend(current.values())
        else:
            pending.extend(current)


def _resolve(value: Any) -> Any:
    return value.get_object() if isinstance(value, IndirectObject) else value


def _marked(value: Any) -> bool:
    resolved = _resolve(value)
    return isinstance(resolved, DictionaryObject) and bool(
        resolved.get(NameObject("/Marked"), False)
    )


def _analysis_from_evidence(
    *,
    source_sha256: str,
    version: str | None,
    page_count: int,
    evidence: dict[str, bool],
    inspector: PdfInspectorIdentity,
) -> PdfCapabilityAnalysis:
    restricted = evidence["active"] or evidence["attachments"] or evidence["xfa"]
    signed = evidence["signatures"]
    force_view_only = restricted or signed
    classification = (
        PdfCapabilityClassification.VIEW_ONLY
        if force_view_only
        else PdfCapabilityClassification.PAGE_MANAGEMENT_ONLY
    )
    opening_mode = (
        PdfOpeningMode.RESTRICTED_SAFE_VIEW if restricted or signed else PdfOpeningMode.SAFE_VIEW
    )

    def present(key: str, yes: str, no: str) -> tuple[PdfFeatureState, str]:
        return (
            PdfFeatureState.PRESENT if evidence[key] else PdfFeatureState.ABSENT,
            yes if evidence[key] else no,
        )

    mapping: dict[PdfFeature, tuple[PdfFeatureState, str]] = {
        PdfFeature.ENCRYPTION: (PdfFeatureState.ABSENT, "No PDF encryption dictionary is active."),
        PdfFeature.DOCUMENT_PERMISSIONS: present(
            "permissions",
            "Document permission or certification structures are present.",
            "No document permission structure was found.",
        ),
        PdfFeature.DIGITAL_SIGNATURES: present(
            "signatures",
            "Digital signature or certification structures are present.",
            "No digital signature or certification structure was found.",
        ),
        PdfFeature.FONTS: present(
            "fonts",
            "Font resource dictionaries are present; exact font rights and "
            "editability are not yet approved.",
            "No font resource dictionary was found.",
        ),
        PdfFeature.TEXT: (
            PdfFeatureState.UNKNOWN,
            "Content streams were not decoded during bounded safe inspection, "
            "so editable text is not claimed.",
        ),
        PdfFeature.IMAGES: present(
            "images",
            "Image XObjects are present.",
            "No image XObject was found in the inspected object graph.",
        ),
        PdfFeature.VECTOR_CONTENT: (
            PdfFeatureState.UNKNOWN,
            "Content streams were not decoded during bounded safe inspection, "
            "so vector editability is not claimed.",
        ),
        PdfFeature.FORMS: present(
            "forms",
            "Interactive form structures are present.",
            "No interactive form structure was found.",
        ),
        PdfFeature.ANNOTATIONS: present(
            "annotations",
            "Annotation structures are present.",
            "No annotation structure was found.",
        ),
        PdfFeature.OPTIONAL_CONTENT_LAYERS: present(
            "layers",
            "Optional-content layer structures are present.",
            "No optional-content layer structure was found.",
        ),
        PdfFeature.TAGS: present(
            "tags",
            "Tagged-document structures are present.",
            "No tagged-document structure was found.",
        ),
        PdfFeature.ATTACHMENTS: present(
            "attachments",
            "Embedded-file or attachment structures are present and remain disabled.",
            "No attachment structure was found.",
        ),
        PdfFeature.ACTIVE_CONTENT: present(
            "active",
            "Active actions are present and remain disabled in restricted safe view.",
            "No supported active-action marker was found in the inspected object graph.",
        ),
        PdfFeature.MIXED_PAGE_SIZES: present(
            "mixed_page_sizes",
            "The document contains more than one page size.",
            "All inspected pages use one page size.",
        ),
    }
    notes = [
        "The original PDF remains immutable; this report does not rewrite or render it.",
        "Imported object editing and page rewriting remain disabled until the "
        "production PDF-engine benchmark is approved.",
    ]
    if signed:
        notes.append(
            "Signature or certification evidence protects the original; any future "
            "edit must create a clearly labelled unsigned derivative."
        )
    if evidence["xfa"]:
        notes.append("Dynamic XFA form content is unsupported and remains disabled.")
    if restricted:
        notes.append("Active or embedded content forces restricted safe view and cannot execute.")
    return PdfCapabilityAnalysis(
        source_sha256=source_sha256,
        pdf_version=version,
        page_count=page_count,
        analysis_state=PdfCapabilityAnalysisState.COMPLETE,
        classification=classification,
        opening_mode=opening_mode,
        original_protected=True,
        findings=_findings(mapping),
        operations=_operations("restricted" if force_view_only else "safe"),
        compatibility_notes=tuple(notes),
        inspector=inspector,
    )


def _findings(
    values: dict[PdfFeature, tuple[PdfFeatureState, str]],
    *,
    default: tuple[PdfFeatureState, str] | None = None,
) -> tuple[PdfFeatureFinding, ...]:
    return tuple(
        PdfFeatureFinding(
            feature=feature,
            state=values.get(
                feature, default or (PdfFeatureState.UNKNOWN, "This feature was not inspected.")
            )[0],
            summary=values.get(
                feature, default or (PdfFeatureState.UNKNOWN, "This feature was not inspected.")
            )[1],
        )
        for feature in PdfFeature
    )


def _operations(reason: str) -> tuple[PdfOperationAvailability, ...]:
    explanations = {
        "encrypted": (
            "An authorised password is required before document contents or "
            "permissions can be inspected."
        ),
        "unreadable": (
            "Strict structural inspection did not complete, so no content operation is safe."
        ),
        "restricted": (
            "Active, embedded or unsupported dynamic content requires restricted safe handling."
        ),
        "safe": "This first imported-PDF slice exposes verified capability evidence only.",
    }
    blocked = reason in {"encrypted", "unreadable", "restricted"}
    items: list[PdfOperationAvailability] = []
    for operation in PdfOperation:
        if operation is PdfOperation.VIEW_CAPABILITY_REPORT:
            items.append(
                PdfOperationAvailability(
                    operation=operation,
                    state=PdfOperationState.AVAILABLE,
                    creates_derivative=False,
                    reason="The immutable-source capability report is available.",
                )
            )
            continue
        state = PdfOperationState.BLOCKED if blocked else PdfOperationState.NOT_RELEASED
        operation_reason = explanations[reason]
        if operation is PdfOperation.UNLOCK_WITH_PASSWORD and reason == "encrypted":
            state = PdfOperationState.NOT_RELEASED
            operation_reason = (
                "Authorised password unlock will require a separately approved "
                "decrypted-derivative workflow."
            )
        items.append(
            PdfOperationAvailability(
                operation=operation,
                state=state,
                creates_derivative=operation not in {PdfOperation.DOWNLOAD_ORIGINAL},
                reason=operation_reason,
            )
        )
    return tuple(items)


def finding_map(analysis: PdfCapabilityAnalysis) -> dict[PdfFeature, PdfFeatureFinding]:
    """Return findings by feature for trusted internal tests and adapters."""

    return {finding.feature: finding for finding in analysis.findings}
