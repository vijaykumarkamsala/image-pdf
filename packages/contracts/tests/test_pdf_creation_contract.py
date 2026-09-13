from __future__ import annotations

import pytest
from pydantic import ValidationError

from ipw.contracts.editor import (
    ArtboardBackground,
    ArtboardOrientation,
    ArtboardRecord,
    ArtboardUnit,
    EditorDocumentSnapshot,
    IntendedUseKind,
    IntendedUseMetadata,
    LayerAccessibility,
    LayerAccessibilityRole,
    PdfDocumentSettings,
    PdfPageRecord,
)
from ipw.contracts.pdf_creation import (
    PdfCreateRequest,
    PdfOutputProfile,
    PdfPreflightIssue,
    PdfPreflightReport,
    PdfPreflightSeverity,
    PdfPreflightState,
)


def pdf_artboard(artboard_id: str = "page-1", order: int = 0) -> ArtboardRecord:
    return ArtboardRecord(
        artboard_id=artboard_id,
        name=f"Page {order + 1}",
        order=order,
        width=595.2756,
        height=841.8898,
        unit=ArtboardUnit.POINTS,
        orientation=ArtboardOrientation.PORTRAIT,
        background=ArtboardBackground(kind="solid", color="#ffffff"),
        intended_use=IntendedUseMetadata(kind=IntendedUseKind.DIGITAL, label="Screen PDF"),
    )


def test_pdf_snapshot_owns_ordered_point_pages() -> None:
    page = pdf_artboard()
    snapshot = EditorDocumentSnapshot(
        document_id="document-pdf",
        revision=0,
        artboards=(page,),
        pdf_settings=PdfDocumentSettings(
            title="Native PDF",
            pages=(PdfPageRecord(artboard_id=page.artboard_id, label="1"),),
        ),
    )

    assert snapshot.pdf_settings is not None
    assert snapshot.pdf_settings.pages[0].artboard_id == page.artboard_id


@pytest.mark.parametrize(
    ("artboards", "pages", "message"),
    [
        ((pdf_artboard(),), (PdfPageRecord(artboard_id="missing", label="1"),), "every artboard"),
        (
            (pdf_artboard("page-1", 0), pdf_artboard("page-2", 1)),
            (
                PdfPageRecord(artboard_id="page-2", label="2"),
                PdfPageRecord(artboard_id="page-1", label="1"),
            ),
            "order",
        ),
    ],
)
def test_pdf_page_mapping_fails_closed(
    artboards: tuple[ArtboardRecord, ...],
    pages: tuple[PdfPageRecord, ...],
    message: str,
) -> None:
    with pytest.raises(ValidationError, match=message):
        EditorDocumentSnapshot(
            document_id="document-pdf",
            revision=0,
            artboards=artboards,
            pdf_settings=PdfDocumentSettings(title="Native PDF", pages=pages),
        )


def test_pdf_request_bounds_sources_and_accessibility_is_truthful() -> None:
    request = PdfCreateRequest(name="Lookbook", source_file_ids=("file-a", "file-b"))
    assert request.image_placement.value == "contain"

    with pytest.raises(ValidationError, match="distinct"):
        PdfCreateRequest(name="Duplicate", source_file_ids=("file-a", "file-a"))
    with pytest.raises(ValidationError):
        PdfCreateRequest(
            name="Too many", source_file_ids=tuple(f"file-{index}" for index in range(51))
        )
    with pytest.raises(ValidationError, match="alternative text"):
        LayerAccessibility(role=LayerAccessibilityRole.FIGURE)


def test_pdf_preflight_state_matches_blocking_issues() -> None:
    issue = PdfPreflightIssue(
        code="unsupported-layer",
        severity=PdfPreflightSeverity.ERROR,
        message="The selected profile cannot render this layer.",
        blocks_export=True,
    )
    with pytest.raises(ValidationError, match="state"):
        PdfPreflightReport(
            document_id="document-pdf",
            document_version_id="version-pdf",
            snapshot_sha256="a" * 64,
            profile=PdfOutputProfile(),
            state=PdfPreflightState.READY,
            page_count=1,
            issues=(issue,),
            generated_at="2026-09-12T00:00:00.000Z",
        )
