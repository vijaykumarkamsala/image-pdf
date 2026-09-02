"""Deterministic image-enhancement and export contracts for Recovery 2E."""

from __future__ import annotations

from enum import StrEnum
from typing import Literal

from pydantic import Field, model_validator

from ipw.contracts.common import ContractModel, NonEmptyStr, Sha256Hex, SlugId
from ipw.contracts.version import PRODUCT_SCHEMA_VERSION


class EnhancementContractModel(ContractModel):
    schema_version: str = PRODUCT_SCHEMA_VERSION

    @model_validator(mode="after")
    def _schema_version_is_supported(self) -> EnhancementContractModel:
        if self.schema_version != PRODUCT_SCHEMA_VERSION:
            raise ValueError("unsupported product contract version")
        return self


class ImageOperationKind(StrEnum):
    ORIENTATION_NORMALIZE = "orientation_normalize"
    CROP = "crop"
    ROTATE = "rotate"
    FLIP = "flip"
    RESIZE = "resize"
    EXPOSURE_BRIGHTNESS = "exposure_brightness"
    CONTRAST = "contrast"
    HIGHLIGHTS_SHADOWS = "highlights_shadows"
    WHITE_BALANCE_TEMPERATURE = "white_balance_temperature"
    TINT = "tint"
    SATURATION_VIBRANCE = "saturation_vibrance"
    GAMMA = "gamma"
    LEVELS = "levels"
    CURVES = "curves"
    GRAYSCALE = "grayscale"
    UNSHARP_MASK = "unsharp_mask"
    NOISE_REDUCTION = "noise_reduction"
    COLOUR_PROFILE_CONVERSION = "colour_profile_conversion"
    ALPHA_BACKGROUND = "alpha_background"
    RESAMPLING_SCALE = "resampling_scale"


class CropParameters(EnhancementContractModel):
    left: float = Field(ge=0, le=1)
    top: float = Field(ge=0, le=1)
    right: float = Field(gt=0, le=1)
    bottom: float = Field(gt=0, le=1)
    aspect_preset: NonEmptyStr | None = None

    @model_validator(mode="after")
    def _positive_area(self) -> CropParameters:
        if self.right <= self.left or self.bottom <= self.top:
            raise ValueError("crop must have positive area")
        return self


class OrientationNormalizeParameters(EnhancementContractModel):
    source_orientation: int = Field(ge=2, le=8)
    apply_exactly_once: Literal[True] = True


class RotateParameters(EnhancementContractModel):
    degrees: float = Field(ge=-360, le=360)
    expand_canvas: bool = True


class FlipParameters(EnhancementContractModel):
    horizontal: bool = False
    vertical: bool = False

    @model_validator(mode="after")
    def _has_axis(self) -> FlipParameters:
        if not self.horizontal and not self.vertical:
            raise ValueError("flip must select an axis")
        return self


class ResizeMode(StrEnum):
    PIXELS = "pixels"
    PERCENT = "percent"
    PHYSICAL = "physical"


class ResamplingAlgorithm(StrEnum):
    NEAREST = "nearest"
    BILINEAR = "bilinear"
    BICUBIC = "bicubic"
    LANCZOS = "lanczos"


class ResizeParameters(EnhancementContractModel):
    mode: ResizeMode
    width: float = Field(gt=0, le=100_000)
    height: float = Field(gt=0, le=100_000)
    physical_unit: Literal["in", "mm", "cm"] | None = None
    ppi: int | None = Field(default=None, ge=1, le=9_600)
    aspect_locked: bool = True
    aspect_preset: NonEmptyStr | None = None
    fit: Literal["contain", "cover", "stretch"] = "contain"
    algorithm: ResamplingAlgorithm = ResamplingAlgorithm.LANCZOS

    @model_validator(mode="after")
    def _physical_values_match_mode(self) -> ResizeParameters:
        if self.mode is ResizeMode.PHYSICAL and (self.physical_unit is None or self.ppi is None):
            raise ValueError("physical resize requires a unit and PPI")
        if self.mode is not ResizeMode.PHYSICAL and self.physical_unit is not None:
            raise ValueError("physical unit is valid only for physical resize")
        return self


class ExposureBrightnessParameters(EnhancementContractModel):
    exposure_ev: float = Field(default=0, ge=-5, le=5)
    brightness: float = Field(default=0, ge=-100, le=100)


class ContrastParameters(EnhancementContractModel):
    amount: float = Field(default=0, ge=-100, le=100)


class HighlightsShadowsParameters(EnhancementContractModel):
    highlights: float = Field(default=0, ge=-100, le=100)
    shadows: float = Field(default=0, ge=-100, le=100)


class WhiteBalanceParameters(EnhancementContractModel):
    temperature_kelvin: int = Field(default=6_500, ge=2_000, le=12_000)


class TintParameters(EnhancementContractModel):
    amount: float = Field(default=0, ge=-100, le=100)


class SaturationVibranceParameters(EnhancementContractModel):
    saturation: float = Field(default=0, ge=-100, le=100)
    vibrance: float = Field(default=0, ge=-100, le=100)


class GammaParameters(EnhancementContractModel):
    gamma: float = Field(default=1, ge=0.1, le=5)


class LevelsParameters(EnhancementContractModel):
    black: int = Field(default=0, ge=0, le=254)
    white: int = Field(default=255, ge=1, le=255)
    midpoint: float = Field(default=1, ge=0.1, le=5)

    @model_validator(mode="after")
    def _range_is_ordered(self) -> LevelsParameters:
        if self.white <= self.black:
            raise ValueError("white level must exceed black level")
        return self


class CurvePoint(EnhancementContractModel):
    input: float = Field(ge=0, le=1)
    output: float = Field(ge=0, le=1)


class CurvesParameters(EnhancementContractModel):
    channel: Literal["rgb", "red", "green", "blue"] = "rgb"
    points: tuple[CurvePoint, ...] = (
        CurvePoint(input=0, output=0),
        CurvePoint(input=1, output=1),
    )

    @model_validator(mode="after")
    def _points_are_editable_and_ordered(self) -> CurvesParameters:
        if len(self.points) < 2 or len(self.points) > 32:
            raise ValueError("curves require 2 to 32 control points")
        inputs = [point.input for point in self.points]
        if inputs != sorted(inputs) or len(set(inputs)) != len(inputs):
            raise ValueError("curve inputs must be strictly increasing")
        if inputs[0] != 0 or inputs[-1] != 1:
            raise ValueError("curves must include 0 and 1 endpoints")
        return self


class GrayscaleParameters(EnhancementContractModel):
    method: Literal["luminance", "average"] = "luminance"


class UnsharpMaskParameters(EnhancementContractModel):
    radius: float = Field(default=1, ge=0.1, le=50)
    amount: float = Field(default=100, ge=0, le=500)
    threshold: int = Field(default=3, ge=0, le=255)


class NoiseReductionParameters(EnhancementContractModel):
    strength: int = Field(default=20, ge=0, le=100)
    preserve_edges: int = Field(default=70, ge=0, le=100)


class ColourProfileConversionParameters(EnhancementContractModel):
    target_profile: Literal["preserve", "srgb", "display-p3"] = "srgb"
    rendering_intent: Literal["perceptual", "relative_colorimetric"] = "perceptual"
    black_point_compensation: bool = True


class AlphaBackgroundParameters(EnhancementContractModel):
    behavior: Literal["preserve", "flatten"] = "preserve"
    background: str | None = None

    @model_validator(mode="after")
    def _background_matches_behavior(self) -> AlphaBackgroundParameters:
        if self.behavior == "flatten" and not self.background:
            raise ValueError("flattening alpha requires a background colour")
        if self.behavior == "preserve" and self.background is not None:
            raise ValueError("preserved alpha cannot carry a background colour")
        return self


class ResamplingScaleParameters(EnhancementContractModel):
    scale: Literal[2, 4]
    algorithm: ResamplingAlgorithm = ResamplingAlgorithm.LANCZOS
    label: Literal["Standard resampling (not AI reconstruction)"] = (
        "Standard resampling (not AI reconstruction)"
    )


OperationParameters = (
    OrientationNormalizeParameters
    | CropParameters
    | RotateParameters
    | FlipParameters
    | ResizeParameters
    | ExposureBrightnessParameters
    | ContrastParameters
    | HighlightsShadowsParameters
    | WhiteBalanceParameters
    | TintParameters
    | SaturationVibranceParameters
    | GammaParameters
    | LevelsParameters
    | CurvesParameters
    | GrayscaleParameters
    | UnsharpMaskParameters
    | NoiseReductionParameters
    | ColourProfileConversionParameters
    | AlphaBackgroundParameters
    | ResamplingScaleParameters
)


_PARAMETER_MODELS: dict[ImageOperationKind, type[EnhancementContractModel]] = {
    ImageOperationKind.ORIENTATION_NORMALIZE: OrientationNormalizeParameters,
    ImageOperationKind.CROP: CropParameters,
    ImageOperationKind.ROTATE: RotateParameters,
    ImageOperationKind.FLIP: FlipParameters,
    ImageOperationKind.RESIZE: ResizeParameters,
    ImageOperationKind.EXPOSURE_BRIGHTNESS: ExposureBrightnessParameters,
    ImageOperationKind.CONTRAST: ContrastParameters,
    ImageOperationKind.HIGHLIGHTS_SHADOWS: HighlightsShadowsParameters,
    ImageOperationKind.WHITE_BALANCE_TEMPERATURE: WhiteBalanceParameters,
    ImageOperationKind.TINT: TintParameters,
    ImageOperationKind.SATURATION_VIBRANCE: SaturationVibranceParameters,
    ImageOperationKind.GAMMA: GammaParameters,
    ImageOperationKind.LEVELS: LevelsParameters,
    ImageOperationKind.CURVES: CurvesParameters,
    ImageOperationKind.GRAYSCALE: GrayscaleParameters,
    ImageOperationKind.UNSHARP_MASK: UnsharpMaskParameters,
    ImageOperationKind.NOISE_REDUCTION: NoiseReductionParameters,
    ImageOperationKind.COLOUR_PROFILE_CONVERSION: ColourProfileConversionParameters,
    ImageOperationKind.ALPHA_BACKGROUND: AlphaBackgroundParameters,
    ImageOperationKind.RESAMPLING_SCALE: ResamplingScaleParameters,
}


class ImageOperation(EnhancementContractModel):
    operation_id: SlugId
    kind: ImageOperationKind
    order: int = Field(ge=0)
    enabled: bool = True
    parameters: OperationParameters

    @model_validator(mode="before")
    @classmethod
    def _parse_parameters_for_kind(cls, value: object) -> object:
        if not isinstance(value, dict):
            return value
        kind = ImageOperationKind(value.get("kind"))
        parsed = dict(value)
        parsed["parameters"] = _PARAMETER_MODELS[kind].model_validate(value.get("parameters"))
        return parsed

    @model_validator(mode="after")
    def _parameters_match_kind(self) -> ImageOperation:
        if not isinstance(self.parameters, _PARAMETER_MODELS[self.kind]):
            raise ValueError("operation parameters do not match the operation kind")
        return self


class ProcessingRecipeRecord(EnhancementContractModel):
    recipe_id: SlugId
    workspace_id: SlugId
    document_id: SlugId
    version: int = Field(ge=1)
    name: NonEmptyStr
    operations: tuple[ImageOperation, ...]
    deterministic: Literal[True] = True
    created_by_actor_id: SlugId
    created_at: NonEmptyStr
    updated_at: NonEmptyStr

    @model_validator(mode="after")
    def _operation_order_is_unique(self) -> ProcessingRecipeRecord:
        orders = [operation.order for operation in self.operations]
        identifiers = [operation.operation_id for operation in self.operations]
        if len(orders) != len(set(orders)) or len(identifiers) != len(set(identifiers)):
            raise ValueError("recipe operations require unique identifiers and order")
        return self


class IntendedOutcome(StrEnum):
    DIGITAL = "digital"
    ARCHIVAL = "archival"
    PRESENTATION = "presentation"
    CUSTOM = "custom"


class RecommendationEvidenceKind(StrEnum):
    MEASURED = "measured"
    HEURISTIC = "heuristic"


class RecommendationTargetKind(StrEnum):
    PROCESSING_OPERATION = "processing_operation"
    METADATA_POLICY = "metadata_policy"
    OUTPUT_WARNING = "output_warning"


class RecommendationEvidence(EnhancementContractModel):
    kind: RecommendationEvidenceKind
    explanation: NonEmptyStr


class SafeRecommendation(EnhancementContractModel):
    recommendation_id: SlugId
    title: NonEmptyStr
    explanation: NonEmptyStr
    evidence: tuple[RecommendationEvidence, ...]
    target_kind: RecommendationTargetKind
    operation: ImageOperation | None = None
    metadata_policy: MetadataPolicy | None = None
    state: Literal["proposed", "accepted", "declined"] = "proposed"

    @model_validator(mode="after")
    def _target_has_matching_action(self) -> SafeRecommendation:
        processing = self.target_kind is RecommendationTargetKind.PROCESSING_OPERATION
        metadata = self.target_kind is RecommendationTargetKind.METADATA_POLICY
        if processing != (self.operation is not None):
            raise ValueError("processing recommendation requires exactly one operation")
        if metadata != (self.metadata_policy is not None):
            raise ValueError("metadata recommendation requires exactly one metadata policy")
        return self


class RecommendationSet(EnhancementContractModel):
    recommendation_set_id: SlugId
    workspace_id: SlugId
    document_id: SlugId
    document_version_id: SlugId
    intended_outcome: IntendedOutcome | None = None
    intended_outcome_required: bool = False
    source_facts_summary: tuple[NonEmptyStr, ...]
    recommendations: tuple[SafeRecommendation, ...]
    no_correction_needed: bool = False
    created_at: NonEmptyStr


class ComparisonMode(StrEnum):
    ORIGINAL = "original"
    CURRENT = "current"
    RECOMMENDED = "recommended"
    SPLIT = "split"
    SIDE_BY_SIDE = "side_by_side"


class HistogramSummary(EnhancementContractModel):
    red: tuple[int, ...] = Field(min_length=16, max_length=256)
    green: tuple[int, ...] = Field(min_length=16, max_length=256)
    blue: tuple[int, ...] = Field(min_length=16, max_length=256)
    shadow_clipping: bool
    highlight_clipping: bool


class EnhancementPreview(EnhancementContractModel):
    preview_id: SlugId
    document_id: SlugId
    document_version_id: SlugId
    recipe_id: SlugId
    recipe_version: int = Field(ge=1)
    mode: ComparisonMode
    proxy: Literal[True] = True
    quality_label: Literal["Interactive proxy; final output is rendered by a durable worker"] = (
        "Interactive proxy; final output is rendered by a durable worker"
    )
    width: int = Field(ge=1)
    height: int = Field(ge=1)
    histogram: HistogramSummary | None = None
    created_at: NonEmptyStr


class ImageExportFormat(StrEnum):
    JPEG = "jpeg"
    PNG = "png"
    WEBP = "webp"
    TIFF = "tiff"


class ExportPurpose(StrEnum):
    ARCHIVAL_DERIVATIVE = "archival_derivative"
    WEB = "web"
    EMAIL = "email"
    SOCIAL = "social"
    PRESENTATION = "presentation"
    HIGH_RESOLUTION_DIGITAL = "high_resolution_digital"
    CUSTOM = "custom"


class MetadataPolicy(EnhancementContractModel):
    preserve_copyright: bool = True
    preserve_description: bool = False
    preserve_capture_time: bool = False
    preserve_camera: bool = False
    preserve_location: Literal[False] = False
    remove_embedded_thumbnails: Literal[True] = True


class ExportOutputProfile(EnhancementContractModel):
    profile_id: SlugId
    name: NonEmptyStr
    purpose: ExportPurpose
    format: ImageExportFormat
    width: int | None = Field(default=None, ge=1, le=100_000)
    height: int | None = Field(default=None, ge=1, le=100_000)
    percentage: float | None = Field(default=None, gt=0, le=1_000)
    physical_width: float | None = Field(default=None, gt=0, le=100_000)
    physical_height: float | None = Field(default=None, gt=0, le=100_000)
    physical_unit: Literal["in", "mm", "cm"] | None = None
    ppi: int | None = Field(default=None, ge=1, le=9_600)
    fit: Literal["contain", "cover", "stretch"] = "contain"
    quality: int | None = Field(default=None, ge=1, le=100)
    lossless: bool = False
    resampling_algorithm: ResamplingAlgorithm = ResamplingAlgorithm.LANCZOS
    colour_profile: Literal["preserve", "srgb", "display-p3"] = "srgb"
    bit_depth: Literal[8, 16] = 8
    alpha_behavior: Literal["preserve", "flatten"] = "preserve"
    background: str | None = None
    metadata_policy: MetadataPolicy = Field(default_factory=MetadataPolicy)
    chroma_subsampling: Literal["4:4:4", "4:2:2", "4:2:0"] | None = None
    filename_template: NonEmptyStr = "{document}-{artboard}-{profile}"
    collision_behavior: Literal["suffix", "fail"] = "suffix"

    @model_validator(mode="after")
    def _capabilities_match_format(self) -> ExportOutputProfile:
        if self.format is ImageExportFormat.JPEG and self.alpha_behavior != "flatten":
            raise ValueError("JPEG requires alpha flattening")
        if self.alpha_behavior == "flatten" and not self.background:
            raise ValueError("alpha flattening requires a background")
        if self.bit_depth == 16 and self.format not in {
            ImageExportFormat.PNG,
            ImageExportFormat.TIFF,
        }:
            raise ValueError("16-bit output is supported only for PNG and TIFF")
        if self.chroma_subsampling is not None and self.format is not ImageExportFormat.JPEG:
            raise ValueError("chroma subsampling applies only to JPEG")
        size_modes = sum(
            value
            for value in (
                self.width is not None or self.height is not None,
                self.percentage is not None,
                self.physical_width is not None or self.physical_height is not None,
            )
        )
        if size_modes > 1:
            raise ValueError("an output profile may select only one sizing mode")
        if (self.physical_width is not None or self.physical_height is not None) and (
            self.physical_unit is None or self.ppi is None
        ):
            raise ValueError("physical output requires unit and PPI")
        return self


class ExportOutputState(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class ExportOutputRecord(EnhancementContractModel):
    output_id: SlugId
    export_request_id: SlugId
    artboard_id: SlugId
    profile: ExportOutputProfile
    state: ExportOutputState
    progress_percent: int = Field(ge=0, le=100)
    filename: NonEmptyStr
    object_reference_id: SlugId | None = None
    sha256: Sha256Hex | None = None
    byte_size: int | None = Field(default=None, ge=1)
    width: int | None = Field(default=None, ge=1)
    height: int | None = Field(default=None, ge=1)
    media_type: str | None = None
    failure_code: str | None = None
    failure_message: str | None = None
    completed_at: str | None = None


class OutputSizeEstimate(EnhancementContractModel):
    minimum_bytes: int = Field(ge=0)
    maximum_bytes: int = Field(ge=0)
    explanation: NonEmptyStr

    @model_validator(mode="after")
    def _ordered_range(self) -> OutputSizeEstimate:
        if self.maximum_bytes < self.minimum_bytes:
            raise ValueError("estimated size range is invalid")
        return self


class ImageExportRequestRecord(EnhancementContractModel):
    export_request_id: SlugId
    workspace_id: SlugId
    document_id: SlugId
    document_version_id: SlugId
    recipe_id: SlugId
    recipe_version: int = Field(ge=1)
    job_id: SlugId
    outputs: tuple[ExportOutputRecord, ...] = Field(min_length=1, max_length=64)
    state: Literal["queued", "running", "partially_completed", "completed", "failed", "cancelled"]
    estimated_size: OutputSizeEstimate
    zero_charge: Literal[True] = True
    created_by_actor_id: SlugId
    created_at: NonEmptyStr
    updated_at: NonEmptyStr


class ExportProvenance(EnhancementContractModel):
    provenance_id: SlugId
    output_id: SlugId
    workspace_id: SlugId
    document_id: SlugId
    document_version_id: SlugId
    source_version_ids: tuple[SlugId, ...]
    recipe_id: SlugId
    recipe_version: int = Field(ge=1)
    processor_name: NonEmptyStr
    processor_version: NonEmptyStr
    deterministic: bool
    parameters_sha256: Sha256Hex
    output_sha256: Sha256Hex
    metadata_policy: MetadataPolicy
    trace_id: SlugId
    job_id: SlugId
    created_at: NonEmptyStr


class ZipManifestItem(EnhancementContractModel):
    output_id: SlugId
    filename: NonEmptyStr
    sha256: Sha256Hex
    byte_size: int = Field(ge=1)


class ExportZipBundle(EnhancementContractModel):
    bundle_id: SlugId
    workspace_id: SlugId
    export_request_id: SlugId
    job_id: SlugId
    state: ExportOutputState
    items: tuple[ZipManifestItem, ...]
    object_reference_id: SlugId | None = None
    sha256: Sha256Hex | None = None
    byte_size: int | None = Field(default=None, ge=1)
    expires_at: NonEmptyStr
    created_at: NonEmptyStr


ENHANCEMENT_SCHEMA_EXPORTS: dict[str, type[ContractModel]] = {
    "alpha-background-parameters": AlphaBackgroundParameters,
    "colour-profile-conversion-parameters": ColourProfileConversionParameters,
    "curves-parameters": CurvesParameters,
    "enhancement-preview": EnhancementPreview,
    "export-output-profile": ExportOutputProfile,
    "export-output-record": ExportOutputRecord,
    "export-provenance": ExportProvenance,
    "export-zip-bundle": ExportZipBundle,
    "histogram-summary": HistogramSummary,
    "image-export-request-record": ImageExportRequestRecord,
    "image-operation": ImageOperation,
    "metadata-policy": MetadataPolicy,
    "output-size-estimate": OutputSizeEstimate,
    "processing-recipe-record": ProcessingRecipeRecord,
    "recommendation-set": RecommendationSet,
    "safe-recommendation": SafeRecommendation,
    "zip-manifest-item": ZipManifestItem,
}
