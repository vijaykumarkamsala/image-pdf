"""The operation catalogue the application offers, described for humans.

The contract knows what an operation *is*. This knows what to call it, who it is
for, what it costs the user in waiting, and whether it can invent detail. That
second set of facts is what an interface needs and what a schema has no business
carrying.

**Standard first, always.** PRODUCT_REQUIREMENTS.md section 2 and D-007/D-009 say
the default path must be deterministic and must never silently invoke a model.
The catalogue encodes that by ordering: every group of standard operations comes
before the AI group, AI entries carry ``invents_detail`` and the interface is
required to show it. A customer who wants a model asks for one.

**Why entries carry an audience.** "All types of users" is not served by one flat
list of sixteen verbs. A textile designer looking for print output and a lecturer
straightening a scanned page are both well served, and neither should have to read
past the other's tools to find their own. The audiences are those in
PRODUCT_REQUIREMENTS.md section 3, verbatim, so the grouping tracks the product
rather than my guesses about it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from ipw.contracts.operation import ADVERTISED_OPERATIONS, FAMILY_OF, OperationKind

__all__ = ["OPERATION_CATALOGUE", "Audience", "CatalogueEntry", "Group", "catalogue_document"]


class Audience(StrEnum):
    """From PRODUCT_REQUIREMENTS.md section 3, unchanged.

    A customer is never asked to classify themselves (section 3 is explicit about
    that). These are used to *group and suggest*, never to gate.
    """

    EVERYONE = "everyone"
    PHOTO_AND_PRINT = "photo_and_print"
    BUSINESS_DOCUMENTS = "business_documents"
    EDUCATION = "education"
    DESIGN_AND_CONTENT = "design_and_content"


class Group(StrEnum):
    """How the interface stacks the work. Order is deliberate."""

    ESSENTIALS = "essentials"
    ADJUST = "adjust"
    CLEAN_UP = "clean_up"
    OUTPUT = "output"
    ENHANCE_WITH_AI = "enhance_with_ai"


GROUP_ORDER: tuple[Group, ...] = (
    Group.ESSENTIALS,
    Group.ADJUST,
    Group.CLEAN_UP,
    Group.OUTPUT,
    # Last, and visually separated. Not because it is unimportant - because a
    # customer must choose it rather than arrive in it.
    Group.ENHANCE_WITH_AI,
)

GROUP_LABELS: dict[Group, str] = {
    Group.ESSENTIALS: "Essentials",
    Group.ADJUST: "Adjust",
    Group.CLEAN_UP: "Clean up",
    Group.OUTPUT: "Output & print",
    Group.ENHANCE_WITH_AI: "Enhance with AI",
}

GROUP_NOTES: dict[Group, str] = {
    Group.ESSENTIALS: "Size, position and orientation.",
    Group.ADJUST: "Light and colour. Nothing here changes what is in the picture.",
    Group.CLEAN_UP: "Reduce noise and sharpen, without inventing detail.",
    Group.OUTPUT: "Format, quality and print size.",
    Group.ENHANCE_WITH_AI: (
        "These use a model and may reconstruct detail that was not in the original. "
        "Use them when the plain tools are not enough."
    ),
}


@dataclass(frozen=True)
class CatalogueEntry:
    """One operation, as a person meets it."""

    kind: OperationKind
    label: str
    summary: str
    group: Group
    audiences: tuple[Audience, ...] = (Audience.EVERYONE,)
    speed: str = "instant"
    """instant | fast | slow. Set from measurement, not from hope.

    POC-006 and POC-007 measured the AI paths at 2-4 seconds for a 64x64 image on
    CPU and roughly 250x the cost of a deterministic resize. Telling a customer
    'slow' before they wait is the difference between a considered choice and a
    frustrated one.
    """
    invents_detail: bool = False
    """True when the operation may produce detail that was not in the input.

    The single most important flag in this file. PRODUCT_REQUIREMENTS.md section
    10 requires a short explanation near any such control, and POC-008 makes
    invented text or identity a critical failure. The interface reads this rather
    than hard-coding a list it could forget to update.
    """
    needs_model: bool = False
    advertised: bool = True
    settings_hint: dict[str, Any] = field(default_factory=dict)

    def as_document(self) -> dict[str, Any]:
        return {
            "kind": self.kind.value,
            "label": self.label,
            "summary": self.summary,
            "group": self.group.value,
            "family": FAMILY_OF[self.kind].value,
            "audiences": [audience.value for audience in self.audiences],
            "speed": self.speed,
            "invents_detail": self.invents_detail,
            "needs_model": self.needs_model,
            "advertised": self.advertised,
            "settings_hint": self.settings_hint,
        }


OPERATION_CATALOGUE: tuple[CatalogueEntry, ...] = (
    # ---------------------------------------------------------- essentials --
    CatalogueEntry(
        kind=OperationKind.RESIZE,
        label="Resize",
        summary=(
            "Make the picture a different size - smaller for email, or a set "
            "size for printing. It tells you what you are getting before you "
            "commit to it."
        ),
        group=Group.ESSENTIALS,
        settings_hint={"algorithm": ["lanczos", "bicubic", "nearest"]},
    ),
    CatalogueEntry(
        kind=OperationKind.CROP,
        label="Crop",
        summary=(
            "Cut away the parts you do not want. Drag a box on the picture, or "
            "pick a shape such as square or A4."
        ),
        group=Group.ESSENTIALS,
    ),
    CatalogueEntry(
        kind=OperationKind.ROTATE,
        label="Rotate",
        summary=(
            "Turn the picture a quarter turn at a time. Nothing is redrawn, so "
            "it loses no quality however often you turn it."
        ),
        group=Group.ESSENTIALS,
    ),
    CatalogueEntry(
        kind=OperationKind.FLIP,
        label="Flip",
        summary="Flip the picture over, like seeing it in a mirror.",
        group=Group.ESSENTIALS,
    ),
    # -------------------------------------------------------------- adjust --
    CatalogueEntry(
        kind=OperationKind.ADJUST,
        label="Light & colour",
        summary=(
            "Make it lighter or darker, and the colours stronger or calmer. For "
            "a photograph that came out dull, dark or too blue."
        ),
        group=Group.ADJUST,
        settings_hint={
            "brightness_percent": [-100, 100],
            "contrast_percent": [-100, 100],
            "exposure_percent": [-100, 100],
            "saturation_percent": [-100, 100],
            "white_balance": ["none", "auto", "daylight", "tungsten"],
        },
    ),
    # ------------------------------------------------------------ clean up --
    CatalogueEntry(
        kind=OperationKind.SHARPEN,
        label="Sharpen",
        summary=(
            "Make edges crisper. It can only bring out detail the camera already "
            "caught - it cannot add any."
        ),
        group=Group.CLEAN_UP,
        audiences=(Audience.EVERYONE, Audience.PHOTO_AND_PRINT),
    ),
    CatalogueEntry(
        kind=OperationKind.STRAIGHTEN_PAGE,
        label="Straighten a photographed page",
        summary=(
            "You photographed the page at an angle, so it came out as a wonky "
            "four-sided shape. This finds its corners and pulls them back into a "
            "proper rectangle."
        ),
        group=Group.CLEAN_UP,
        audiences=(Audience.EVERYONE, Audience.BUSINESS_DOCUMENTS, Audience.EDUCATION),
    ),
    CatalogueEntry(
        kind=OperationKind.DOCUMENT_CLEAN,
        label="Clean up a photographed page",
        summary=(
            "Takes the lamp glare, the shadow and the yellow-brown tinge out of a "
            "photograph of paper, so the page looks white and evenly lit - like a "
            "scan rather than a snapshot."
        ),
        group=Group.CLEAN_UP,
        audiences=(Audience.EVERYONE, Audience.BUSINESS_DOCUMENTS, Audience.PHOTO_AND_PRINT),
        settings_hint={"strength_percent": [60, 80, 100], "whiten": [True, False]},
    ),
    CatalogueEntry(
        kind=OperationKind.DENOISE,
        label="Reduce noise",
        summary=(
            "Smooth away the grainy speckle you get in dim light. It softens the "
            "picture a little, and cannot put back detail that was never there."
        ),
        group=Group.CLEAN_UP,
        audiences=(Audience.EVERYONE, Audience.PHOTO_AND_PRINT),
    ),
    CatalogueEntry(
        kind=OperationKind.PRINT_READY,
        label="Make a photographed page print-ready",
        summary=(
            "Turns a photograph of a document into something that looks scanned. It "
            "straightens the page, takes out the lamp glare and the shadow, makes "
            "the paper white again, and enlarges it enough to print. Nothing is "
            "made up - the lighting is worked out from your own photograph."
        ),
        group=Group.ESSENTIALS,
        audiences=(Audience.EVERYONE, Audience.BUSINESS_DOCUMENTS, Audience.PHOTO_AND_PRINT),
        speed="slow",
        settings_hint={"scale": [1, 2, 3, 4], "material": ["text", "photo", "texture"]},
    ),
    CatalogueEntry(
        kind=OperationKind.ENLARGE,
        label="Make it bigger and sharper",
        summary=(
            "Makes the picture bigger while keeping it sharp. It works out what an "
            "ordinary enlargement would blur away and puts it back, several times "
            "over. Nothing is invented, so it stays a true picture of what you "
            "photographed - clearly better than a plain enlargement, most of all "
            "on words and printed text."
        ),
        group=Group.ESSENTIALS,
        audiences=(Audience.EVERYONE, Audience.PHOTO_AND_PRINT, Audience.DESIGN_AND_CONTENT),
        speed="slow",
        settings_hint={
            "scale": [2, 3, 4],
            "material": ["photo", "text", "texture"],
        },
    ),
    # -------------------------------------------------------------- output --
    CatalogueEntry(
        kind=OperationKind.CONVERT,
        label="Convert & export",
        summary=(
            "Save it as a different kind of file - JPEG for photographs, PNG when "
            "you need a see-through background."
        ),
        group=Group.OUTPUT,
        settings_hint={"target_media_type": ["image/png", "image/jpeg"], "quality": [1, 100]},
    ),
    # ------------------------------------------------------ enhance with AI --
    CatalogueEntry(
        kind=OperationKind.SUPER_RESOLUTION,
        label="Upscale with AI",
        summary=(
            "Makes it bigger using a model that guesses at the missing detail. "
            "Sharper than a plain enlargement - but it is inventing, so do not use "
            "it where the picture has to stay a true record."
        ),
        group=Group.ENHANCE_WITH_AI,
        audiences=(Audience.PHOTO_AND_PRINT, Audience.DESIGN_AND_CONTENT),
        speed="slow",
        invents_detail=True,
        needs_model=True,
        settings_hint={"scale": [2, 4], "mode": ["natural", "strong"]},
    ),
    CatalogueEntry(
        kind=OperationKind.AI_DENOISE,
        label="Denoise with AI",
        summary=(
            "Clean up heavy grain the plain tool cannot manage. It uses a model, so "
            "it may smooth away small real detail too."
        ),
        group=Group.ENHANCE_WITH_AI,
        audiences=(Audience.PHOTO_AND_PRINT,),
        speed="slow",
        invents_detail=True,
        needs_model=True,
        settings_hint={"noise_sigma": [15, 25, 50]},
    ),
    CatalogueEntry(
        kind=OperationKind.JPEG_ARTIFACT_REPAIR,
        label="Repair JPEG damage",
        summary=(
            "Tidy the blocky smudges in a picture that has been saved and re-saved too many times."
        ),
        group=Group.ENHANCE_WITH_AI,
        audiences=(Audience.PHOTO_AND_PRINT, Audience.DESIGN_AND_CONTENT),
        speed="slow",
        invents_detail=True,
        needs_model=True,
        advertised=False,
        settings_hint={"quality_target": [10, 20, 30, 40]},
    ),
    CatalogueEntry(
        kind=OperationKind.FACE_RESTORE,
        label="Restore faces",
        summary=(
            "Sharpen faces in an old or blurry photograph. It guesses at the detail, "
            "so check it still looks like the person. Never applied unless you ask."
        ),
        group=Group.ENHANCE_WITH_AI,
        audiences=(Audience.PHOTO_AND_PRINT,),
        speed="slow",
        invents_detail=True,
        needs_model=True,
    ),
    CatalogueEntry(
        kind=OperationKind.DAMAGE_REPAIR,
        label="Repair damage",
        summary=(
            "Fill in scratches and creases on a scanned old photograph. It is "
            "guessing at what was underneath."
        ),
        group=Group.ENHANCE_WITH_AI,
        audiences=(Audience.PHOTO_AND_PRINT,),
        speed="slow",
        invents_detail=True,
        needs_model=True,
    ),
    CatalogueEntry(
        kind=OperationKind.COLOURISE,
        label="Add colour",
        summary=(
            "Add colour to a black-and-white photograph. The colours are a guess, "
            "not a record of what was really there."
        ),
        group=Group.ENHANCE_WITH_AI,
        audiences=(Audience.PHOTO_AND_PRINT,),
        speed="slow",
        invents_detail=True,
        needs_model=True,
    ),
    CatalogueEntry(
        kind=OperationKind.BACKGROUND_REMOVE,
        label="Remove background",
        summary="Cut out the main subject and make everything behind it see-through.",
        group=Group.ENHANCE_WITH_AI,
        audiences=(Audience.DESIGN_AND_CONTENT, Audience.BUSINESS_DOCUMENTS),
        speed="slow",
        invents_detail=False,
        needs_model=True,
    ),
    CatalogueEntry(
        kind=OperationKind.BACKGROUND_REPLACE,
        label="Replace background",
        summary="Cut out the main subject and put a different background behind it.",
        group=Group.ENHANCE_WITH_AI,
        audiences=(Audience.DESIGN_AND_CONTENT,),
        speed="slow",
        invents_detail=True,
        needs_model=True,
    ),
)


def catalogue_document() -> dict[str, Any]:
    """The whole catalogue, grouped and ordered, ready for an interface."""
    groups: list[dict[str, Any]] = []
    for group in GROUP_ORDER:
        entries = [entry for entry in OPERATION_CATALOGUE if entry.group is group]
        if not entries:
            continue
        groups.append(
            {
                "id": group.value,
                "label": GROUP_LABELS[group],
                "note": GROUP_NOTES[group],
                "is_ai": group is Group.ENHANCE_WITH_AI,
                "operations": [entry.as_document() for entry in entries],
            }
        )
    return {
        "groups": groups,
        "audiences": [audience.value for audience in Audience],
        # Stated so an interface never has to infer it from a group name.
        "default_family": "standard",
    }


def _coverage_check() -> None:
    """Every advertised operation must appear, or the interface hides a feature."""
    listed = {entry.kind for entry in OPERATION_CATALOGUE}
    missing = [kind.value for kind in ADVERTISED_OPERATIONS if kind not in listed]
    if missing:
        msg = f"advertised operations missing from the catalogue: {missing}"
        raise RuntimeError(msg)


_coverage_check()
