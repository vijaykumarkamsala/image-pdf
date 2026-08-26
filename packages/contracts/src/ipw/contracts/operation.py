"""Operations, settings and processing variants.

Two product decisions are enforced **structurally** here rather than by
convention:

* **D-007 / D-009** - Standard Enhance and AI reconstruction are separate.
  ``OperationKind`` is mapped to a fixed :class:`OperationFamily` by
  ``FAMILY_OF``. A manifest or run cannot declare ``super_resolution`` as
  ``standard``; the validator rejects it. No adapter can promote itself.
* **Determinism** - every setting is an integer, boolean or enum. There is no
  float anywhere in a settings model, so settings canonicalise byte-identically
  on any platform.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Literal

from pydantic import Field, model_validator

from ipw.contracts.asset import MediaType
from ipw.contracts.common import ContractModel, Percent, PositiveInt, SignedPercent


class OperationFamily(StrEnum):
    """Standard (deterministic / non-generative) versus AI (may reconstruct)."""

    STANDARD = "standard"
    AI = "ai"
    INSPECTION = "inspection"


class OperationKind(StrEnum):
    NOOP = "noop"
    INSPECT_ONLY = "inspect_only"

    # -- standard enhancement (PRODUCT_REQUIREMENTS.md section 9) ----------
    RESIZE = "resize"
    CROP = "crop"
    ROTATE = "rotate"
    FLIP = "flip"
    ADJUST = "adjust"
    SHARPEN = "sharpen"
    DENOISE = "denoise"
    CONVERT = "convert"

    # -- AI enhancement (PRODUCT_REQUIREMENTS.md section 10) ---------------
    SUPER_RESOLUTION = "super_resolution"
    AI_DENOISE = "ai_denoise"
    JPEG_ARTIFACT_REPAIR = "jpeg_artifact_repair"
    FACE_RESTORE = "face_restore"
    DAMAGE_REPAIR = "damage_repair"
    COLOURISE = "colourise"
    BACKGROUND_REMOVE = "background_remove"
    BACKGROUND_REPLACE = "background_replace"


FAMILY_OF: dict[OperationKind, OperationFamily] = {
    OperationKind.NOOP: OperationFamily.INSPECTION,
    OperationKind.INSPECT_ONLY: OperationFamily.INSPECTION,
    OperationKind.RESIZE: OperationFamily.STANDARD,
    OperationKind.CROP: OperationFamily.STANDARD,
    OperationKind.ROTATE: OperationFamily.STANDARD,
    OperationKind.FLIP: OperationFamily.STANDARD,
    OperationKind.ADJUST: OperationFamily.STANDARD,
    OperationKind.SHARPEN: OperationFamily.STANDARD,
    OperationKind.DENOISE: OperationFamily.STANDARD,
    OperationKind.CONVERT: OperationFamily.STANDARD,
    OperationKind.SUPER_RESOLUTION: OperationFamily.AI,
    # Distinct from OperationKind.DENOISE on purpose. A median filter cannot
    # invent detail; a learned restoration can, and the customer is entitled to
    # know which one ran (D-007, D-009). Two names, two families, no overlap.
    OperationKind.AI_DENOISE: OperationFamily.AI,
    OperationKind.JPEG_ARTIFACT_REPAIR: OperationFamily.AI,
    OperationKind.FACE_RESTORE: OperationFamily.AI,
    OperationKind.DAMAGE_REPAIR: OperationFamily.AI,
    OperationKind.COLOURISE: OperationFamily.AI,
    OperationKind.BACKGROUND_REMOVE: OperationFamily.AI,
    OperationKind.BACKGROUND_REPLACE: OperationFamily.AI,
}


ADVERTISED_OPERATIONS: tuple[OperationKind, ...] = (
    # Standard Enhance - PRODUCT_REQUIREMENTS.md section 9.
    OperationKind.RESIZE,
    OperationKind.CROP,
    OperationKind.ROTATE,
    OperationKind.FLIP,
    OperationKind.ADJUST,
    OperationKind.SHARPEN,
    OperationKind.DENOISE,
    OperationKind.CONVERT,
    # Enhance with AI - PRODUCT_REQUIREMENTS.md section 10.
    OperationKind.SUPER_RESOLUTION,
    OperationKind.AI_DENOISE,
    OperationKind.FACE_RESTORE,
    OperationKind.DAMAGE_REPAIR,
    OperationKind.COLOURISE,
    OperationKind.BACKGROUND_REMOVE,
    OperationKind.BACKGROUND_REPLACE,
)
"""Operations the product advertises to customers.

Written out rather than derived, since POC-007 (D-057). It used to be "every kind
that is not INSPECTION", which fused two unrelated questions: what the contract
can *express*, and what the product *sells*. Under the derived rule, adding an
operation kind so that a benchmark could measure it would have advertised it to
customers and attached a D-040 fallback obligation to it - a product decision
taken as a side effect of an enum.

This is the set D-040 applies to: every advertised operation must retain at least
one approved candidate, so a licence negotiation is always an upgrade rather than
a rescue.

**Deliberately absent:** ``jpeg_artifact_repair``. SwinIR implements it and
POC-007 benchmarks it, but PRODUCT_REQUIREMENTS.md section 10 does not name it as
a capability. Measuring something is not the same as promising it. Whether it
becomes an advertised operation is O-015, for the product owner.

``noop`` and ``inspect_only`` are internal plumbing and are excluded, as before.
"""

EXPRESSIBLE_OPERATIONS: tuple[OperationKind, ...] = tuple(
    kind for kind, family in FAMILY_OF.items() if family is not OperationFamily.INSPECTION
)
"""Every operation the contract can express, advertised or not.

The old meaning of ``ADVERTISED_OPERATIONS``, kept under an honest name. A
benchmark may run anything in here; only the advertised subset carries a D-040
fallback obligation.
"""


class ProcessingVariant(StrEnum):
    """The processing variants from benchmark plan section 7."""

    ORIGINAL_CONTROL = "original_control"
    STANDARD_BROWSER_PREVIEW = "standard_browser_preview"
    STANDARD_SERVER_AUTHORITATIVE = "standard_server_authoritative"
    AI_NATURAL = "ai_natural"
    AI_STRONG = "ai_strong"
    AI_TASK_SPECIFIC = "ai_task_specific"


class ProcessingRoute(StrEnum):
    """Where the work ran. Customer-facing wording is applied by the UI, not here."""

    BROWSER_LOCAL = "browser_local"
    CLOUD_CPU = "cloud_cpu"
    CLOUD_GPU = "cloud_gpu"
    NOT_APPLICABLE = "not_applicable"


# ------------------------------------------------------------------ settings --


class NoopSettings(ContractModel):
    kind: Literal[OperationKind.NOOP] = OperationKind.NOOP


class InspectOnlySettings(ContractModel):
    kind: Literal[OperationKind.INSPECT_ONLY] = OperationKind.INSPECT_ONLY


class ResizeSettings(ContractModel):
    kind: Literal[OperationKind.RESIZE] = OperationKind.RESIZE
    algorithm: Literal["bicubic", "lanczos", "nearest"] = "lanczos"
    target_width: PositiveInt | None = None
    target_height: PositiveInt | None = None
    scale_numerator: PositiveInt | None = None
    scale_denominator: PositiveInt | None = None
    preserve_aspect_ratio: bool = True

    @model_validator(mode="after")
    def _target_or_scale(self) -> ResizeSettings:
        has_target = self.target_width is not None or self.target_height is not None
        has_scale = self.scale_numerator is not None and self.scale_denominator is not None
        if has_target == has_scale:
            msg = "specify either target dimensions or a rational scale, not both"
            raise ValueError(msg)
        return self


class CropSettings(ContractModel):
    kind: Literal[OperationKind.CROP] = OperationKind.CROP
    x: int = Field(ge=0)
    y: int = Field(ge=0)
    width: PositiveInt
    height: PositiveInt


class RotateSettings(ContractModel):
    kind: Literal[OperationKind.ROTATE] = OperationKind.ROTATE
    degrees: Literal[90, 180, 270]
    expand: bool = True


class FlipSettings(ContractModel):
    kind: Literal[OperationKind.FLIP] = OperationKind.FLIP
    axis: Literal["horizontal", "vertical"]


class AdjustSettings(ContractModel):
    kind: Literal[OperationKind.ADJUST] = OperationKind.ADJUST
    brightness_percent: SignedPercent = 0
    contrast_percent: SignedPercent = 0
    saturation_percent: SignedPercent = 0
    exposure_percent: SignedPercent = 0
    white_balance: Literal["none", "auto", "daylight", "tungsten"] = "none"


class SharpenSettings(ContractModel):
    kind: Literal[OperationKind.SHARPEN] = OperationKind.SHARPEN
    amount_percent: Percent = 50
    radius_x100: PositiveInt = 100


class DenoiseSettings(ContractModel):
    kind: Literal[OperationKind.DENOISE] = OperationKind.DENOISE
    strength_percent: Percent = 30


class ConvertSettings(ContractModel):
    kind: Literal[OperationKind.CONVERT] = OperationKind.CONVERT
    target_media_type: MediaType
    quality: Percent = 90
    flatten_background: str | None = Field(
        default=None,
        pattern=r"^#[0-9a-f]{6}$",
        description="Required when converting transparency to a format without alpha.",
    )


class SuperResolutionSettings(ContractModel):
    kind: Literal[OperationKind.SUPER_RESOLUTION] = OperationKind.SUPER_RESOLUTION
    scale: Literal[2, 4]
    mode: Literal["natural", "strong"] = "natural"
    native_scale: bool = Field(
        default=True,
        description="True when the model natively produces this scale. Benchmark plan section 7 "
        "forbids presenting post-resized output as equivalent to a native scale.",
    )


class AiDenoiseSettings(ContractModel):
    """Learned denoising. Distinct from DenoiseSettings, which is a median filter.

    ``noise_sigma`` is the noise level the weights were *trained* for, not a
    strength dial. SwinIR publishes separate checkpoints for sigma 15, 25 and 50,
    and an adapter must refuse a level it has no weights for rather than
    substituting the nearest one - the same rule as native scale for
    super-resolution (benchmark plan section 7).
    """

    kind: Literal[OperationKind.AI_DENOISE] = OperationKind.AI_DENOISE
    noise_sigma: Literal[15, 25, 50] = 15
    mode: Literal["natural", "strong"] = "natural"


class JpegArtifactRepairSettings(ContractModel):
    """Learned JPEG compression-artifact reduction.

    ``quality_target`` is the JPEG quality the weights were trained against, in the
    same sense as ``noise_sigma`` above: a property of the checkpoint, not a knob.
    """

    kind: Literal[OperationKind.JPEG_ARTIFACT_REPAIR] = OperationKind.JPEG_ARTIFACT_REPAIR
    quality_target: Literal[10, 20, 30, 40] = 10


class FaceRestoreSettings(ContractModel):
    kind: Literal[OperationKind.FACE_RESTORE] = OperationKind.FACE_RESTORE
    mode: Literal["natural", "strong"] = "natural"
    fidelity_percent: Percent = 70
    apply_to_all_faces: bool = True


class DamageRepairSettings(ContractModel):
    kind: Literal[OperationKind.DAMAGE_REPAIR] = OperationKind.DAMAGE_REPAIR
    targets: tuple[Literal["scratch", "fold", "stain", "tear"], ...] = ("scratch",)
    strength_percent: Percent = 50


class ColouriseSettings(ContractModel):
    kind: Literal[OperationKind.COLOURISE] = OperationKind.COLOURISE
    saturation_percent: Percent = 50
    disclose_estimated_colour: Literal[True] = Field(
        default=True,
        description="D-010: colourisation must always be described as estimated colour, "
        "never as historical fact. The literal type makes disabling it impossible.",
    )


class BackgroundRemoveSettings(ContractModel):
    kind: Literal[OperationKind.BACKGROUND_REMOVE] = OperationKind.BACKGROUND_REMOVE
    return_mask: bool = True
    feather_px: int = Field(default=0, ge=0, le=64)


class BackgroundReplaceSettings(ContractModel):
    kind: Literal[OperationKind.BACKGROUND_REPLACE] = OperationKind.BACKGROUND_REPLACE
    mode: Literal["solid", "image", "generated"]
    solid_colour: str | None = Field(default=None, pattern=r"^#[0-9a-f]{6}$")


AnySettings = Annotated[
    NoopSettings
    | InspectOnlySettings
    | ResizeSettings
    | CropSettings
    | RotateSettings
    | FlipSettings
    | AdjustSettings
    | SharpenSettings
    | DenoiseSettings
    | ConvertSettings
    | SuperResolutionSettings
    | FaceRestoreSettings
    | DamageRepairSettings
    | ColouriseSettings
    | AiDenoiseSettings
    | JpegArtifactRepairSettings
    | BackgroundRemoveSettings
    | BackgroundReplaceSettings,
    Field(discriminator="kind"),
]


class Operation(ContractModel):
    """A fully specified unit of work: what to do, how, and under which variant."""

    kind: OperationKind
    family: OperationFamily
    variant: ProcessingVariant
    route: ProcessingRoute = ProcessingRoute.NOT_APPLICABLE
    settings: AnySettings

    @model_validator(mode="after")
    def _consistent(self) -> Operation:
        if self.settings.kind != self.kind:
            msg = (
                f"settings.kind {self.settings.kind.value} does not match "
                f"operation kind {self.kind.value}"
            )
            raise ValueError(msg)
        expected = FAMILY_OF[self.kind]
        if self.family is not expected:
            msg = (
                f"operation {self.kind.value} belongs to family {expected.value}, "
                f"not {self.family.value}. Standard Enhance must never silently "
                f"invoke AI (D-007, D-009)."
            )
            raise ValueError(msg)
        return self

    @classmethod
    def build(
        cls,
        settings: AnySettings,
        variant: ProcessingVariant,
        route: ProcessingRoute = ProcessingRoute.NOT_APPLICABLE,
    ) -> Operation:
        """Construct an operation with its family derived, never asserted."""
        return cls(
            kind=settings.kind,
            family=FAMILY_OF[settings.kind],
            variant=variant,
            route=route,
            settings=settings,
        )
