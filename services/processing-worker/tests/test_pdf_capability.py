from __future__ import annotations

import hashlib
from io import BytesIO

import pytest
from pypdf import PdfWriter
from pypdf.generic import ArrayObject, DictionaryObject, NameObject

from ipw.contracts.pdf_management import (
    PdfCapabilityAnalysis,
    PdfCapabilityAnalysisState,
    PdfCapabilityClassification,
    PdfFeature,
    PdfFeatureState,
    PdfOpeningMode,
)
from ipw.processing_worker import pdf_capability
from ipw.processing_worker.pdf_capability import finding_map, inspect_pdf_capabilities


def pdf_bytes(
    *,
    javascript: bool = False,
    password: str | None = None,
    signed: bool = False,
    benign_open_action: bool = False,
) -> bytes:
    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    if javascript:
        writer.add_js("app.alert('disabled')")
    if signed:
        signature = DictionaryObject({NameObject("/FT"): NameObject("/Sig")})
        writer._root_object[NameObject("/AcroForm")] = DictionaryObject(  # noqa: SLF001
            {NameObject("/Fields"): ArrayObject([signature])}
        )
    if benign_open_action:
        writer._root_object[NameObject("/OpenAction")] = ArrayObject(  # noqa: SLF001
            [page.indirect_reference, NameObject("/Fit")]
        )
    if password:
        writer.encrypt(password)
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


def structured_pdf_bytes() -> bytes:
    writer = PdfWriter()
    first = writer.add_blank_page(width=612, height=792)
    writer.add_blank_page(width=792, height=612)
    root = writer._root_object  # noqa: SLF001 - creates structural security fixture
    root[NameObject("/Perms")] = DictionaryObject()
    root[NameObject("/AcroForm")] = DictionaryObject({NameObject("/Fields"): ArrayObject()})
    root[NameObject("/OCProperties")] = DictionaryObject({NameObject("/OCGs"): ArrayObject()})
    root[NameObject("/StructTreeRoot")] = DictionaryObject()
    root[NameObject("/Names")] = DictionaryObject(
        {NameObject("/EmbeddedFiles"): DictionaryObject()}
    )
    first[NameObject("/Annots")] = ArrayObject(
        [DictionaryObject({NameObject("/Type"): NameObject("/Annot")})]
    )
    first[NameObject("/Resources")] = DictionaryObject(
        {
            NameObject("/Font"): DictionaryObject(
                {NameObject("/F1"): DictionaryObject({NameObject("/Type"): NameObject("/Font")})}
            ),
            NameObject("/XObject"): DictionaryObject(
                {
                    NameObject("/Im1"): DictionaryObject(
                        {NameObject("/Subtype"): NameObject("/Image")}
                    )
                }
            ),
        }
    )
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


def inspect(data: bytes) -> PdfCapabilityAnalysis:
    return inspect_pdf_capabilities(data, source_sha256=hashlib.sha256(data).hexdigest())


def test_plain_pdf_receives_truthful_page_management_only_report() -> None:
    analysis = inspect(pdf_bytes())
    findings = finding_map(analysis)

    assert analysis.analysis_state is PdfCapabilityAnalysisState.COMPLETE
    assert analysis.classification is PdfCapabilityClassification.PAGE_MANAGEMENT_ONLY
    assert analysis.opening_mode is PdfOpeningMode.SAFE_VIEW
    assert analysis.page_count == 1
    assert findings[PdfFeature.ENCRYPTION].state is PdfFeatureState.ABSENT
    assert findings[PdfFeature.ACTIVE_CONTENT].state is PdfFeatureState.ABSENT
    assert findings[PdfFeature.TEXT].state is PdfFeatureState.UNKNOWN


def test_benign_open_destination_is_not_misclassified_as_active_code() -> None:
    analysis = inspect(pdf_bytes(benign_open_action=True))
    findings = finding_map(analysis)

    assert analysis.classification is PdfCapabilityClassification.PAGE_MANAGEMENT_ONLY
    assert findings[PdfFeature.ACTIVE_CONTENT].state is PdfFeatureState.ABSENT


def test_javascript_pdf_is_preserved_but_forced_into_restricted_safe_view() -> None:
    analysis = inspect(pdf_bytes(javascript=True))
    findings = finding_map(analysis)

    assert analysis.classification is PdfCapabilityClassification.VIEW_ONLY
    assert analysis.opening_mode is PdfOpeningMode.RESTRICTED_SAFE_VIEW
    assert findings[PdfFeature.ACTIVE_CONTENT].state is PdfFeatureState.PRESENT
    assert any("cannot execute" in note.lower() for note in analysis.compatibility_notes)


def test_encrypted_pdf_is_not_decrypted_during_intake() -> None:
    analysis = inspect(pdf_bytes(password="authorised-secret"))  # noqa: S106
    findings = finding_map(analysis)

    assert analysis.analysis_state is PdfCapabilityAnalysisState.RESTRICTED
    assert analysis.classification is PdfCapabilityClassification.VIEW_ONLY
    assert analysis.opening_mode is PdfOpeningMode.CREDENTIAL_REQUIRED
    assert analysis.page_count is None
    assert findings[PdfFeature.ENCRYPTION].state is PdfFeatureState.PRESENT


def test_signed_pdf_is_view_only_and_requires_an_unsigned_derivative() -> None:
    analysis = inspect(pdf_bytes(signed=True))
    findings = finding_map(analysis)

    assert analysis.classification is PdfCapabilityClassification.VIEW_ONLY
    assert analysis.opening_mode is PdfOpeningMode.RESTRICTED_SAFE_VIEW
    assert findings[PdfFeature.DIGITAL_SIGNATURES].state is PdfFeatureState.PRESENT
    assert any("unsigned derivative" in note.lower() for note in analysis.compatibility_notes)


def test_required_structural_features_are_reported_without_rendering() -> None:
    analysis = inspect(structured_pdf_bytes())
    findings = finding_map(analysis)

    for feature in (
        PdfFeature.DOCUMENT_PERMISSIONS,
        PdfFeature.FONTS,
        PdfFeature.IMAGES,
        PdfFeature.FORMS,
        PdfFeature.ANNOTATIONS,
        PdfFeature.OPTIONAL_CONTENT_LAYERS,
        PdfFeature.TAGS,
        PdfFeature.ATTACHMENTS,
        PdfFeature.MIXED_PAGE_SIZES,
    ):
        assert findings[feature].state is PdfFeatureState.PRESENT
    assert findings[PdfFeature.TEXT].state is PdfFeatureState.UNKNOWN
    assert findings[PdfFeature.VECTOR_CONTENT].state is PdfFeatureState.UNKNOWN
    assert analysis.classification is PdfCapabilityClassification.VIEW_ONLY


def test_unreadable_pdf_stays_view_only_and_digest_mismatch_fails_closed() -> None:
    data = b"%PDF-1.7\n%%EOF"
    analysis = inspect(data)
    assert analysis.analysis_state is PdfCapabilityAnalysisState.UNREADABLE
    assert analysis.classification is PdfCapabilityClassification.VIEW_ONLY
    assert analysis.opening_mode is PdfOpeningMode.RESTRICTED_SAFE_VIEW

    with pytest.raises(ValueError, match="digest"):
        inspect_pdf_capabilities(data, source_sha256="0" * 64)


def test_structural_object_budget_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    data = pdf_bytes()
    monkeypatch.setattr(pdf_capability, "MAX_OBJECT_VISITS", 1)
    analysis = inspect(data)

    assert analysis.analysis_state is PdfCapabilityAnalysisState.UNREADABLE
    assert analysis.classification is PdfCapabilityClassification.VIEW_ONLY
    assert "budget" in " ".join(analysis.compatibility_notes).lower()
