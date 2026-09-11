from __future__ import annotations

from typing import Any, cast

import pytest
from pydantic import ValidationError

from ipw.contracts.editor import (
    ArtboardBackground,
    ArtboardOrientation,
    ArtboardRecord,
    ArtboardUnit,
    CropRegion,
    EditableMaskRecord,
    EditorDocumentLocation,
    EditorDocumentSnapshot,
    EditorLocationKind,
    GroupLayerData,
    IntendedUseKind,
    IntendedUseMetadata,
    LayerRecord,
    LayerTransform,
    LayerType,
    MaskKind,
    PreviewProvenance,
    RasterLayerData,
    RichTextLayerData,
    RichTextRun,
    ShapeKind,
    ShapeLayerData,
    ShapePoint,
    SharedAssetKind,
    SharedAssetRecord,
    SharedStyleKind,
    SharedStyleRecord,
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


def test_editor_contract_fail_closed_boundaries_are_executable() -> None:
    invalid_calls = (
        lambda: EditorDocumentLocation(kind=EditorLocationKind.PROJECT),
        lambda: ArtboardBackground(kind="transparent", color="#ffffff"),
        lambda: ArtboardBackground(kind="solid", color=None),
        lambda: CropRegion(left=0.8, right=0.2),
        lambda: EditableMaskRecord(
            mask_id="mask-invalid-path",
            artboard_id="artboard-main",
            name="Invalid path",
            kind=MaskKind.SHAPE,
            path_data="M 0 0",
        ),
        lambda: EditableMaskRecord(
            mask_id="mask-object",
            artboard_id="artboard-main",
            name="Object-backed shape",
            kind=MaskKind.SHAPE,
            path_data="rect(0,0,1,1)",
            object_reference_id="object-mask",
        ),
        lambda: RichTextRun(start=2, end=1),
        lambda: RichTextLayerData(text="short", runs=(RichTextRun(start=0, end=6),)),
        lambda: ShapeLayerData(
            shape=ShapeKind.RECTANGLE,
            points=(ShapePoint(x=0, y=0), ShapePoint(x=1, y=1)),
        ),
        lambda: ShapeLayerData(
            shape=ShapeKind.POLYGON,
            points=(ShapePoint(x=0, y=0), ShapePoint(x=1, y=1)),
        ),
        lambda: LayerRecord(
            layer_id="layer-overloaded",
            artboard_id="artboard-main",
            layer_type=LayerType.SHAPE,
            name="Overloaded",
            order=0,
            transform=LayerTransform(x=0, y=0, width=10, height=10),
            shape=ShapeLayerData(shape=ShapeKind.RECTANGLE),
            group=GroupLayerData(),
        ),
        lambda: IntendedUseMetadata(
            schema_version="1.18.0", kind=IntendedUseKind.DIGITAL, label="Old"
        ),
    )
    for call in invalid_calls:
        with pytest.raises(ValidationError):
            call()

    assert VectorLayerData(path_data="M0 0 L1 1").path_data == "M0 0 L1 1"


def test_snapshot_reference_integrity_rejects_every_unrelated_record() -> None:
    shape = ShapeLayerData(shape=ShapeKind.RECTANGLE)

    def layer(layer_id: str, order: int, **values: Any) -> LayerRecord:
        return LayerRecord(
            layer_id=layer_id,
            artboard_id=values.pop("artboard_id", "artboard-main"),
            parent_layer_id=values.pop("parent_layer_id", None),
            layer_type=values.pop("layer_type", LayerType.SHAPE),
            name=layer_id,
            order=order,
            transform=LayerTransform(x=0, y=0, width=10, height=10),
            shape=values.pop("shape", shape),
            **values,
        )

    group = layer("group-main", 0, layer_type=LayerType.GROUP, shape=None, group=GroupLayerData())
    child = layer("child", 0, parent_layer_id="group-main")
    valid = EditorDocumentSnapshot(
        document_id="document-valid",
        revision=1,
        artboards=(artboard(),),
        layers=(group, child),
    )
    assert len(valid.layers) == 2

    cases: list[dict[str, Any]] = [
        {"artboards": (artboard(), artboard())},
        {
            "artboards": (
                artboard(),
                ArtboardRecord(**{**artboard().model_dump(), "artboard_id": "artboard-two"}),
            ),
            "layers": (),
        },
        {"layers": (layer("duplicate", 0), layer("duplicate", 1))},
        {"layers": (layer("first", 0), layer("second", 0))},
        {"layers": (layer("orphan-parent", 0, parent_layer_id="missing"),)},
        {
            "layers": (
                layer("plain-parent", 0),
                layer("plain-child", 0, parent_layer_id="plain-parent"),
            )
        },
        {"layers": (layer("unsupported-blend", 0, blend_mode="difference"),)},
        {"layers": (layer("missing-style", 0, shared_style_ids=("style-missing",)),)},
        {
            "layers": (
                layer(
                    "missing-raster",
                    0,
                    layer_type=LayerType.RASTER_IMAGE,
                    shape=None,
                    raster=RasterLayerData(shared_asset_id="asset-missing"),
                ),
            )
        },
        {
            "layers": (),
            "masks": (
                EditableMaskRecord(
                    mask_id="mask-unattached",
                    artboard_id="artboard-main",
                    name="Unattached",
                    kind=MaskKind.SHAPE,
                    path_data="rect(0,0,1,1)",
                ),
            ),
        },
        {
            "layers": (
                layer(
                    "missing-vector",
                    0,
                    layer_type=LayerType.VECTOR_SVG,
                    shape=None,
                    vector=VectorLayerData(shared_asset_id="asset-missing"),
                ),
            )
        },
        {
            "layers": (),
            "masks": (
                EditableMaskRecord(
                    mask_id="mask-other-artboard",
                    artboard_id="artboard-missing",
                    name="Other artboard",
                    kind=MaskKind.SHAPE,
                    path_data="rect(0,0,1,1)",
                ),
            ),
        },
    ]
    for values in cases:
        payload = {
            "document_id": "document-invalid",
            "revision": 1,
            "artboards": (artboard(),),
            "layers": (),
            **values,
        }
        with pytest.raises(ValidationError):
            EditorDocumentSnapshot(**payload)

    shared_asset = SharedAssetRecord(
        shared_asset_id="asset-main",
        workspace_id="workspace-main",
        kind=SharedAssetKind.RASTER,
        name="Raster",
    )
    shared_style = SharedStyleRecord(
        shared_style_id="style-main", name="Fill", kind=SharedStyleKind.FILL
    )
    referenced = layer("referenced", 0, shared_style_ids=("style-main",))
    snapshot_with_shared_records = EditorDocumentSnapshot(
        document_id="document-shared",
        revision=1,
        artboards=(artboard(),),
        layers=(referenced,),
        shared_assets=(shared_asset,),
        shared_styles=(shared_style,),
    )
    assert snapshot_with_shared_records.shared_styles == (shared_style,)

    raster = layer(
        "raster-with-mask",
        0,
        layer_type=LayerType.RASTER_IMAGE,
        shape=None,
        raster=RasterLayerData(shared_asset_id="asset-main", mask_ids=("mask-main",)),
    )
    mask = EditableMaskRecord(
        mask_id="mask-main",
        artboard_id="artboard-main",
        name="Attached",
        kind=MaskKind.SHAPE,
        path_data="ellipse(0,0,1,1)",
    )
    attached = EditorDocumentSnapshot(
        document_id="document-attached",
        revision=1,
        artboards=(artboard(),),
        layers=(raster,),
        masks=(mask,),
        shared_assets=(shared_asset,),
    )
    assert attached.masks == (mask,)

    assert (
        EditorDocumentLocation(
            kind=EditorLocationKind.DEFAULT_FILES, default_files_id="default-files-main"
        ).project_id
        is None
    )
    assert RichTextLayerData(text="valid", runs=(RichTextRun(start=0, end=5),)).runs[0].end == 5
    assert (
        EditableMaskRecord(
            mask_id="mask-vector",
            artboard_id="artboard-main",
            name="Vector",
            kind=MaskKind.VECTOR,
        ).path_data
        is None
    )
