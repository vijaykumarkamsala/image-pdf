"""Product V2 native editor-document contracts.

The native document is authoritative. Renderer state is always derived from
these models and must never be persisted as the editable source of truth.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Literal

from pydantic import Field, model_validator

from ipw.contracts.common import ContractModel, NonEmptyStr, Sha256Hex, SlugId
from ipw.contracts.version import PRODUCT_SCHEMA_VERSION

ScalarValue = str | int | float | bool | None


class EditorContractModel(ContractModel):
    """Base for Product V2 editor documents."""

    schema_version: str = PRODUCT_SCHEMA_VERSION

    @model_validator(mode="after")
    def _schema_version_is_supported(self) -> EditorContractModel:
        if self.schema_version != PRODUCT_SCHEMA_VERSION:
            raise ValueError(
                f"unsupported product contract version {self.schema_version!r}; "
                f"expected {PRODUCT_SCHEMA_VERSION}"
            )
        return self


class EditorDocumentKind(StrEnum):
    GRAPHIC = "graphic"
    PDF = "pdf"


class EditorLocationKind(StrEnum):
    DEFAULT_FILES = "default_files"
    PROJECT = "project"


class EditorDocumentLocation(EditorContractModel):
    kind: EditorLocationKind
    default_files_id: SlugId | None = None
    project_id: SlugId | None = None

    @model_validator(mode="after")
    def _location_matches_kind(self) -> EditorDocumentLocation:
        valid = (
            self.kind is EditorLocationKind.DEFAULT_FILES
            and self.default_files_id is not None
            and self.project_id is None
        ) or (
            self.kind is EditorLocationKind.PROJECT
            and self.project_id is not None
            and self.default_files_id is None
        )
        if not valid:
            raise ValueError("document location must identify exactly one location")
        return self


class ArtboardUnit(StrEnum):
    PIXELS = "px"
    MILLIMETRES = "mm"
    INCHES = "in"
    POINTS = "pt"


class ArtboardOrientation(StrEnum):
    PORTRAIT = "portrait"
    LANDSCAPE = "landscape"
    SQUARE = "square"


class IntendedUseKind(StrEnum):
    SOURCE = "source"
    DIGITAL = "digital"
    PRINT = "print"
    CUSTOM = "custom"


class IntendedUseMetadata(EditorContractModel):
    kind: IntendedUseKind
    label: NonEmptyStr
    attributes: dict[str, ScalarValue] = Field(default_factory=dict)


class ArtboardBackground(EditorContractModel):
    kind: Literal["transparent", "solid"] = "solid"
    color: str | None = "#ffffff"

    @model_validator(mode="after")
    def _color_matches_kind(self) -> ArtboardBackground:
        if self.kind == "transparent" and self.color is not None:
            raise ValueError("transparent backgrounds cannot carry a color")
        if self.kind == "solid" and not self.color:
            raise ValueError("solid backgrounds require a color")
        return self


class ArtboardRecord(EditorContractModel):
    artboard_id: SlugId
    name: NonEmptyStr
    order: int = Field(ge=0)
    width: float = Field(gt=0, le=100_000)
    height: float = Field(gt=0, le=100_000)
    unit: ArtboardUnit = ArtboardUnit.PIXELS
    orientation: ArtboardOrientation
    background: ArtboardBackground
    intended_use: IntendedUseMetadata


class LayerTransform(EditorContractModel):
    x: float = Field(ge=-1_000_000, le=1_000_000)
    y: float = Field(ge=-1_000_000, le=1_000_000)
    width: float = Field(gt=0, le=1_000_000)
    height: float = Field(gt=0, le=1_000_000)
    rotation_degrees: float = Field(default=0, ge=-360, le=360)
    scale_x: float = Field(default=1, gt=0, le=1_000)
    scale_y: float = Field(default=1, gt=0, le=1_000)
    skew_x_degrees: float = Field(default=0, ge=-89, le=89)
    skew_y_degrees: float = Field(default=0, ge=-89, le=89)
    flip_x: bool = False
    flip_y: bool = False


class CropRegion(EditorContractModel):
    left: float = Field(default=0, ge=0, le=1)
    top: float = Field(default=0, ge=0, le=1)
    right: float = Field(default=1, ge=0, le=1)
    bottom: float = Field(default=1, ge=0, le=1)

    @model_validator(mode="after")
    def _positive_region(self) -> CropRegion:
        if self.right <= self.left or self.bottom <= self.top:
            raise ValueError("crop region must have positive area")
        return self


class VisualAdjustments(EditorContractModel):
    exposure: float = Field(default=0, ge=-100, le=100)
    brightness: float = Field(default=0, ge=-100, le=100)
    contrast: float = Field(default=0, ge=-100, le=100)
    saturation: float = Field(default=0, ge=-100, le=100)
    temperature: float = Field(default=0, ge=-100, le=100)
    tint: float = Field(default=0, ge=-100, le=100)
    sharpness: float = Field(default=0, ge=0, le=100)


class AssetInstanceMode(StrEnum):
    LINKED = "linked"
    INDEPENDENT = "independent"


class SharedAssetKind(StrEnum):
    RASTER = "raster"
    VECTOR = "vector"
    BRAND = "brand"


class SharedAssetRecord(EditorContractModel):
    shared_asset_id: SlugId
    workspace_id: SlugId
    kind: SharedAssetKind
    name: NonEmptyStr
    asset_original_id: SlugId | None = None
    source_version_id: SlugId | None = None
    object_reference_id: SlugId | None = None
    preview_object_reference_id: SlugId | None = None
    linked_by_default: bool = False


class SharedStyleKind(StrEnum):
    FILL = "fill"
    STROKE = "stroke"
    TEXT = "text"
    EFFECT = "effect"
    BRAND = "brand"


class SharedStyleRecord(EditorContractModel):
    shared_style_id: SlugId
    name: NonEmptyStr
    kind: SharedStyleKind
    properties: dict[str, ScalarValue] = Field(default_factory=dict)


class MaskKind(StrEnum):
    VECTOR = "vector"
    RASTER = "raster"
    SHAPE = "shape"


class EditableMaskRecord(EditorContractModel):
    mask_id: SlugId
    artboard_id: SlugId
    name: NonEmptyStr
    kind: MaskKind
    enabled: bool = True
    inverted: bool = False
    feather: float = Field(default=0, ge=0, le=1_000)
    path_data: str | None = None
    object_reference_id: SlugId | None = None


class RasterLayerData(EditorContractModel):
    shared_asset_id: SlugId
    instance_mode: AssetInstanceMode = AssetInstanceMode.LINKED
    crop: CropRegion = Field(default_factory=CropRegion)
    adjustments: VisualAdjustments = Field(default_factory=VisualAdjustments)
    mask_ids: tuple[SlugId, ...] = ()


class VectorLayerData(EditorContractModel):
    shared_asset_id: SlugId | None = None
    sanitised_svg_object_reference_id: SlugId | None = None
    compatibility_report_id: SlugId | None = None
    path_data: str | None = None
    fill: str | None = "#3559e0"
    stroke: str | None = None
    stroke_width: float = Field(default=0, ge=0, le=10_000)
    mask_ids: tuple[SlugId, ...] = ()


class RichTextRun(EditorContractModel):
    start: int = Field(ge=0)
    end: int = Field(ge=0)
    style: dict[str, ScalarValue] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _ordered_range(self) -> RichTextRun:
        if self.end < self.start:
            raise ValueError("rich-text run end must not precede start")
        return self


class RichTextLayerData(EditorContractModel):
    text: str
    runs: tuple[RichTextRun, ...] = ()
    font_family: NonEmptyStr = "system-ui"
    font_size: float = Field(default=32, gt=0, le=2_000)
    color: NonEmptyStr = "#162033"
    text_align: Literal["left", "center", "right", "justify"] = "left"


class ShapeKind(StrEnum):
    RECTANGLE = "rectangle"
    ELLIPSE = "ellipse"
    LINE = "line"
    POLYGON = "polygon"


class ShapeLayerData(EditorContractModel):
    shape: ShapeKind
    fill: str | None = "#3559e0"
    stroke: str | None = None
    stroke_width: float = Field(default=0, ge=0, le=10_000)
    corner_radius: float = Field(default=0, ge=0, le=100_000)


class GroupLayerData(EditorContractModel):
    collapsed: bool = False


class LayerType(StrEnum):
    RASTER_IMAGE = "raster_image"
    VECTOR_SVG = "vector_svg"
    RICH_TEXT = "rich_text"
    SHAPE = "shape"
    GROUP = "group"
    TABLE = "table"
    SECTION = "section"
    LAYOUT = "layout"
    MASK = "mask"
    ADJUSTMENT = "adjustment"
    PDF_OBJECT = "pdf_object"
    INTERACTIVE_FIELD = "interactive_field"


class LayerRecord(EditorContractModel):
    layer_id: SlugId
    artboard_id: SlugId
    parent_layer_id: SlugId | None = None
    layer_type: LayerType
    name: NonEmptyStr
    order: int = Field(ge=0)
    visible: bool = True
    locked: bool = False
    opacity: float = Field(default=1, ge=0, le=1)
    blend_mode: NonEmptyStr = "normal"
    transform: LayerTransform
    shared_style_ids: tuple[SlugId, ...] = ()
    raster: RasterLayerData | None = None
    vector: VectorLayerData | None = None
    rich_text: RichTextLayerData | None = None
    shape: ShapeLayerData | None = None
    group: GroupLayerData | None = None
    extension_payload: dict[str, ScalarValue] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _content_matches_type(self) -> LayerRecord:
        content = {
            LayerType.RASTER_IMAGE: self.raster,
            LayerType.VECTOR_SVG: self.vector,
            LayerType.RICH_TEXT: self.rich_text,
            LayerType.SHAPE: self.shape,
            LayerType.GROUP: self.group,
        }
        if self.layer_type in content and content[self.layer_type] is None:
            raise ValueError(f"{self.layer_type.value} layer requires matching content")
        populated = sum(
            value is not None
            for value in (self.raster, self.vector, self.rich_text, self.shape, self.group)
        )
        if populated > 1:
            raise ValueError("a layer can carry only one built-in content payload")
        return self


class DocumentVariantRecord(EditorContractModel):
    variant_id: SlugId
    name: NonEmptyStr
    based_on_version_id: SlugId
    active: bool = False


class EditorDocumentSnapshot(EditorContractModel):
    document_id: SlugId
    revision: int = Field(ge=0)
    artboards: tuple[ArtboardRecord, ...] = Field(min_length=1)
    layers: tuple[LayerRecord, ...] = ()
    masks: tuple[EditableMaskRecord, ...] = ()
    shared_assets: tuple[SharedAssetRecord, ...] = ()
    shared_styles: tuple[SharedStyleRecord, ...] = ()
    variants: tuple[DocumentVariantRecord, ...] = ()

    @model_validator(mode="after")
    def _references_are_consistent(self) -> EditorDocumentSnapshot:
        artboard_ids = {item.artboard_id for item in self.artboards}
        layer_ids = {item.layer_id for item in self.layers}
        if len(artboard_ids) != len(self.artboards) or len(layer_ids) != len(self.layers):
            raise ValueError("artboard and layer identifiers must be unique")
        if any(layer.artboard_id not in artboard_ids for layer in self.layers):
            raise ValueError("every layer must reference an artboard in the snapshot")
        if any(
            layer.parent_layer_id is not None and layer.parent_layer_id not in layer_ids
            for layer in self.layers
        ):
            raise ValueError("parent layers must exist in the snapshot")
        if any(mask.artboard_id not in artboard_ids for mask in self.masks):
            raise ValueError("every mask must reference an artboard in the snapshot")
        return self


class EditorDocumentRecord(EditorContractModel):
    document_id: SlugId
    workspace_id: SlugId
    project_id: SlugId | None = None
    location: EditorDocumentLocation
    kind: EditorDocumentKind
    name: NonEmptyStr
    source_file_id: SlugId | None = None
    source_asset_original_id: SlugId | None = None
    source_version_id: SlugId | None = None
    current_version_id: SlugId
    current_revision: int = Field(ge=0)
    created_by_actor_id: SlugId
    created_at: NonEmptyStr
    updated_at: NonEmptyStr


class EditorOperationKind(StrEnum):
    LAYER_ADD = "layer.add"
    LAYER_UPDATE = "layer.update"
    LAYER_REMOVE = "layer.remove"
    LAYER_REORDER = "layer.reorder"
    ARTBOARD_ADD = "artboard.add"
    ARTBOARD_UPDATE = "artboard.update"
    ARTBOARD_REMOVE = "artboard.remove"
    MASK_UPDATE = "mask.update"
    DOCUMENT_RENAME = "document.rename"


class EditorMutation(EditorContractModel):
    kind: EditorOperationKind
    target_id: SlugId | None = None
    layer: LayerRecord | None = None
    artboard: ArtboardRecord | None = None
    mask: EditableMaskRecord | None = None
    transform: LayerTransform | None = None
    crop: CropRegion | None = None
    adjustments: VisualAdjustments | None = None
    properties: dict[str, ScalarValue] = Field(default_factory=dict)


class EditorOperationRecord(EditorContractModel):
    operation_id: SlugId
    document_id: SlugId
    base_revision: int = Field(ge=0)
    resulting_revision: int = Field(ge=1)
    mutation: EditorMutation
    actor_id: SlugId
    idempotency_key: SlugId
    trace_id: SlugId
    occurred_at: NonEmptyStr


class DocumentVersionKind(StrEnum):
    INITIAL = "initial"
    AUTOSAVE_CHECKPOINT = "autosave_checkpoint"
    NAMED = "named"
    RESTORE = "restore"
    SAVE_AS = "save_as"


class DocumentVersionRecord(EditorContractModel):
    document_version_id: SlugId
    document_id: SlugId
    sequence: int = Field(ge=1)
    revision: int = Field(ge=0)
    kind: DocumentVersionKind
    name: str | None = None
    based_on_version_id: SlugId | None = None
    restored_from_version_id: SlugId | None = None
    snapshot_sha256: Sha256Hex
    created_by_actor_id: SlugId
    created_at: NonEmptyStr


class DocumentReadModel(EditorContractModel):
    document: EditorDocumentRecord
    snapshot: EditorDocumentSnapshot
    versions: tuple[DocumentVersionRecord, ...]


class EditorLeaseState(StrEnum):
    ACTIVE = "active"
    GRACE = "grace"
    RELEASED = "released"
    EXPIRED = "expired"


class EditorLeaseRecord(EditorContractModel):
    lease_id: SlugId
    document_id: SlugId
    actor_id: SlugId
    actor_display_name: NonEmptyStr
    state: EditorLeaseState
    acquired_at: NonEmptyStr
    heartbeat_at: NonEmptyStr
    expires_at: NonEmptyStr
    grace_expires_at: NonEmptyStr


class EditorLeaseGrant(EditorContractModel):
    lease: EditorLeaseRecord
    lease_token: NonEmptyStr
    takeover_warning: str | None = None


class LeaseTakeoverStatus(StrEnum):
    REQUESTED = "requested"
    ACQUIRED = "acquired"


class LeaseTakeoverResult(EditorContractModel):
    status: LeaseTakeoverStatus
    current_editor: EditorLeaseRecord | None = None
    grant: EditorLeaseGrant | None = None


class ImportSourceKind(StrEnum):
    RASTER = "raster"
    SVG = "svg"
    PSD = "psd"
    AI_COMPATIBLE = "ai_compatible"


class ImportCompatibilityState(StrEnum):
    COMPATIBLE = "compatible"
    LIMITED = "limited"
    UNSUPPORTED = "unsupported"


class ImportCompatibilityReport(EditorContractModel):
    compatibility_report_id: SlugId
    source_file_id: SlugId
    source_version_id: SlugId
    source_kind: ImportSourceKind
    state: ImportCompatibilityState
    source_preserved: Literal[True] = True
    sanitisation_required: bool = False
    preserved_structures: tuple[NonEmptyStr, ...] = ()
    unsupported_structures: tuple[NonEmptyStr, ...] = ()
    warnings: tuple[NonEmptyStr, ...] = ()
    created_at: NonEmptyStr


class PreviewProvenance(EditorContractModel):
    preview_id: SlugId
    document_id: SlugId
    document_version_id: SlugId
    renderer_name: NonEmptyStr
    renderer_version: NonEmptyStr
    snapshot_sha256: Sha256Hex
    width: int = Field(ge=1)
    height: int = Field(ge=1)
    authoritative: Literal[False] = False
    created_at: NonEmptyStr


EDITOR_SCHEMA_EXPORTS: dict[str, type[ContractModel]] = {
    "artboard-record": ArtboardRecord,
    "document-read-model": DocumentReadModel,
    "document-variant-record": DocumentVariantRecord,
    "editable-mask-record": EditableMaskRecord,
    "editor-document-record": EditorDocumentRecord,
    "editor-document-snapshot": EditorDocumentSnapshot,
    "editor-lease-grant": EditorLeaseGrant,
    "editor-lease-record": EditorLeaseRecord,
    "editor-mutation": EditorMutation,
    "editor-operation-record": EditorOperationRecord,
    "import-compatibility-report": ImportCompatibilityReport,
    "layer-record": LayerRecord,
    "layer-transform": LayerTransform,
    "lease-takeover-result": LeaseTakeoverResult,
    "preview-provenance": PreviewProvenance,
    "shared-asset-record": SharedAssetRecord,
    "shared-style-record": SharedStyleRecord,
    "visual-adjustments": VisualAdjustments,
    "document-version-record": DocumentVersionRecord,
}
