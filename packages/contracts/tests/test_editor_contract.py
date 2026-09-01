from __future__ import annotations

from typing import Any, cast

import pytest
from pydantic import ValidationError

from ipw.contracts.editor import (
    ArtboardBackground,
    ArtboardOrientation,
    ArtboardRecord,
    ArtboardUnit,
    EditableMaskRecord,
    EditorDocumentSnapshot,
    IntendedUseKind,
    IntendedUseMetadata,
    LayerRecord,
    LayerTransform,
    LayerType,
    MaskKind,
    PreviewProvenance,
    RichTextLayerData,
    RichTextRun,
    ShapeKind,
    ShapeLayerData,
    ShapePoint,
    VectorLayerData,
)


def artboard() -> ArtboardRecord:
    return ArtboardRecord(
        artboard_id="artboard-main",
        name="Main artboard",
        order=0,
        width=1200,
        height=800,
        unit=ArtboardUnit.PIXELS,
        orientation=ArtboardOrientation.LANDSCAPE,
        background=ArtboardBackground(kind="solid", color="#ffffff"),
        intended_use=IntendedUseMetadata(kind=IntendedUseKind.DIGITAL, label="Digital graphic"),
    )


def test_native_snapshot_keeps_renderer_independent_layer_state() -> None:
    layer = LayerRecord(
        layer_id="layer-shape",
        artboard_id="artboard-main",
        layer_type=LayerType.SHAPE,
        name="Blue rectangle",
        order=0,
        transform=LayerTransform(x=40, y=60, width=320, height=180),
        shape=ShapeLayerData(shape=ShapeKind.RECTANGLE, fill="#3559e0"),
    )
    snapshot = EditorDocumentSnapshot(
        document_id="document-001",
        revision=3,
        artboards=(artboard(),),
        layers=(layer,),
    )

    assert snapshot.layers[0].transform.x == 40
    assert "fabric" not in snapshot.model_dump_json().lower()


def test_layer_content_and_snapshot_references_fail_closed() -> None:
    with pytest.raises(ValidationError, match="requires matching content"):
        LayerRecord(
            layer_id="layer-invalid",
            artboard_id="artboard-main",
            layer_type=LayerType.SHAPE,
            name="Invalid",
            order=0,
            transform=LayerTransform(x=0, y=0, width=10, height=10),
        )

    invalid_layer = LayerRecord(
        layer_id="layer-orphan",
        artboard_id="artboard-missing",
        layer_type=LayerType.SHAPE,
        name="Orphan",
        order=0,
        transform=LayerTransform(x=0, y=0, width=10, height=10),
        shape=ShapeLayerData(shape=ShapeKind.ELLIPSE),
    )
    with pytest.raises(ValidationError, match="reference an artboard"):
        EditorDocumentSnapshot(
            document_id="document-invalid",
            revision=0,
            artboards=(artboard(),),
            layers=(invalid_layer,),
        )


def test_preview_contract_cannot_become_authoritative() -> None:
    with pytest.raises(ValidationError):
        PreviewProvenance(
            preview_id="preview-001",
            document_id="document-001",
            document_version_id="version-001",
            source_version_id="source-version-001",
            object_reference_id="object-reference-001",
            job_id="job-001",
            trace_id="trace-001",
            processor_name="pillow",
            processor_version="12.0.0",
            zoom_level="workspace",
            source_sha256="a" * 64,
            sha256="b" * 64,
            width=600,
            height=400,
            colour_decision="converted to sRGB",
            metadata_decision="source metadata omitted",
            authoritative=cast(Any, True),
            created_at="2026-08-31T00:00:00.000Z",
        )


def test_native_semantics_reject_misleading_geometry_and_ranges() -> None:
    with pytest.raises(ValidationError, match="orientation"):
        ArtboardRecord(**{**artboard().model_dump(), "orientation": ArtboardOrientation.PORTRAIT})
    with pytest.raises(ValidationError, match="exactly two"):
        ShapeLayerData(shape=ShapeKind.LINE, points=(ShapePoint(x=0, y=0),))
    with pytest.raises(ValidationError, match="unsupported commands"):
        VectorLayerData(path_data='<script>alert("x")</script>')
    with pytest.raises(ValidationError, match="non-overlapping"):
        RichTextLayerData(
            text="Native text",
            runs=(RichTextRun(start=0, end=6), RichTextRun(start=4, end=8)),
        )
    with pytest.raises(ValidationError, match="inside the target"):
        EditableMaskRecord(
            mask_id="mask-bounds",
            artboard_id="artboard-main",
            name="Outside",
            kind=MaskKind.SHAPE,
            path_data="rect(0.5,0.5,0.8,0.8)",
        )
