"""Turning a photograph of a document back into a document.

A phone photograph of a piece of paper is not a scan. It carries the room with
it: the lamp above as a bright patch, the warmth of that lamp across the page,
the photographer's own shadow down one edge, and paper that reads brown rather
than white. Every one of those is *illumination*, not content, and the job here
is to divide it back out.

**Why division rather than brightness or contrast.** Raising brightness lifts
the shadowed corner and blows out the lit one, because the two differ by a
factor, not by an offset. What a camera records is roughly ``reflectance x
illumination``: the ink and paper are the reflectance, the lamp is the
illumination. Estimate the second and divide, and the page comes back flat -
one operation that removes the shadow, the colour cast and the lamp's gradient
together, because they were always the same thing.

**Estimating the light without the ink.** The illumination varies slowly across
the page; the writing is small and dark. Taking a local maximum over a window
wider than any pen stroke erases the ink and leaves the paper, and blurring that
gives a smooth field. It is done on a downscaled copy because the field is
smooth by definition - there is nothing in it that needs full resolution - and
that is what makes this fast enough to be interactive on a twelve-megapixel
photograph.

**Pillow only, deliberately.** This is array arithmetic and numpy would express
it more directly, but ``standard/`` is the deterministic control in the
benchmark and a test holds it to being a plain imaging pipeline. That constraint
is worth more than the convenience: ``ImageMath`` does per-channel division
perfectly well, percentiles come out of a histogram exactly, and the operation
ends up needing nothing this package did not already have.

**What cannot be recovered, and is not pretended.** Where a specular highlight
has clipped - the lamp's own reflection, every channel at 255 - the ink under it
was not recorded. No amount of arithmetic returns it. The gradient *around* the
highlight is corrected and the clipped core is left alone rather than
hallucinated into plausible-looking paper, and the report says how much of the
page was lost that way, because a document with words missing should say so.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

__all__ = ["DocumentReport", "clean_document"]

# How far down to work when estimating the light.
#
# The illumination field is smooth, so resolution buys nothing; the cost is
# entirely in the maximum filter, which is the difference between a fraction of
# a second and half a minute on a phone photograph.
FIELD_WORKING_EDGE = 320

# The local maximum window, as a fraction of the working image's short edge.
#
# It must comfortably exceed the widest pen stroke after downscaling, or the ink
# leaks into the estimate and comes back as a grey ghost where the writing was.
FIELD_WINDOW_FRACTION = 0.06

# Below this the field is treated as darkness rather than dim paper. Dividing by
# a near-zero level turns sensor noise into confetti.
FIELD_FLOOR = 24.0

# At or above this in every channel, a pixel has clipped and holds no detail.
CLIPPED = 250

# Where paper ends and ink begins, after the light has been divided out.
#
# Anything above PAPER_FLOOR is page and goes to pure white; anything below
# INK_CEILING is a pen stroke and is deepened. Between them the value is pulled
# toward whichever it is nearer, along a curve rather than a step - a threshold
# turns a grey stroke into a hole and loses the shape of the handwriting, which
# on a prescription is the part that matters.
PAPER_FLOOR = 235
INK_CEILING = 60
INK_DEEPEN = 0.55


@dataclass(frozen=True)
class DocumentReport:
    """What was found and what was done, in terms a person can check."""

    paper_before: tuple[int, int, int]
    paper_after: tuple[int, int, int]
    evenness_before: float
    evenness_after: float
    clipped_percent: float
    warnings: tuple[str, ...]

    def as_record(self) -> dict[str, Any]:
        return {
            "paper_before": list(self.paper_before),
            "paper_after": list(self.paper_after),
            "evenness_before": round(self.evenness_before, 1),
            "evenness_after": round(self.evenness_after, 1),
            "clipped_percent": round(self.clipped_percent, 2),
            "warnings": list(self.warnings),
        }


def _percentile(plane: Any, fraction: float) -> float:
    """A percentile from the histogram, since Pillow has none.

    Exact for 8-bit data: the histogram *is* the distribution, so walking its
    cumulative total is not an approximation of anything.
    """
    histogram = plane.histogram()
    total = sum(histogram)
    if not total:
        return 0.0
    target = total * fraction
    running = 0
    for level, count in enumerate(histogram):
        running += count
        if running >= target:
            return float(level)
    return 255.0


def _field_for(plane: Any, image_module: Any, filter_module: Any) -> Any:
    """One channel's illumination: the page as the lamp lit it, ink removed."""
    width, height = plane.size
    scale = max(width, height) / FIELD_WORKING_EDGE
    small = (max(8, int(width / scale)), max(8, int(height / scale)))

    working = plane.resize(small, image_module.Resampling.BILINEAR)

    # Dilate away the ink. MaxFilter needs an odd window.
    window = max(3, int(min(small) * FIELD_WINDOW_FRACTION) | 1)
    paper = working.filter(filter_module.MaxFilter(window))

    # Then smooth, so the field is the lamp rather than the brightest speck.
    paper = paper.filter(filter_module.GaussianBlur(window / 2))

    return paper.resize((width, height), image_module.Resampling.BILINEAR)


def _luminance_of(fields: list[Any], image_module: Any) -> Any:
    """One grey field from three, for reporting how even the light was."""
    return image_module.merge("RGB", fields).convert("L")


def _evenness(field: Any) -> float:
    """How much the lighting varies across the page, relative to its own level.

    The number that says whether there was a problem at all: a scan is a few
    percent, a photograph under a desk lamp is forty or more.
    """
    low, high = _percentile(field, 0.05), _percentile(field, 0.95)
    middle = max(1.0, _percentile(field, 0.5))
    return (high - low) / middle * 100.0


def _ink_curve(level: int) -> int:
    """Paper to white, ink deeper, and the shape of the stroke kept between."""
    if level >= PAPER_FLOOR:
        return 255
    if level <= INK_CEILING:
        return max(0, int(level * INK_DEEPEN))
    span = (level - INK_CEILING) / float(PAPER_FLOOR - INK_CEILING)
    floor = int(INK_CEILING * INK_DEEPEN)
    return int(floor + span * span * (255 - floor))


def clean_document(
    image: Any,
    *,
    whiten: bool = True,
    strength_percent: int = 100,
    keep_ink_colour: bool = True,
    lift_ink: bool = True,
) -> tuple[Any, DocumentReport]:
    """Flatten the lighting on a photographed page, and report what changed.

    ``strength_percent`` blends between the original and the fully corrected
    result. Full strength is right for a document; something less is right for a
    photograph of an object where the lighting is part of the picture.

    ``keep_ink_colour`` preserves a blue pen as blue. Turning it off drives the
    page to neutral, which is what a copier does and what a fax-like archive
    wants.
    """
    from PIL import Image, ImageChops, ImageFilter, ImageMath

    strength = max(0, min(int(strength_percent), 100)) / 100.0
    rgb = image.convert("RGB")
    planes = list(rgb.split())
    fields = [_field_for(plane, Image, ImageFilter) for plane in planes]

    paper_before = tuple(int(_percentile(field, 0.5)) for field in fields)
    evenness_before = _evenness(_luminance_of(fields, Image))

    # Where every channel has clipped there is nothing under the highlight to
    # restore. Built as a mask so those pixels can be put back untouched.
    near_white = [plane.point(lambda level: 255 if level >= CLIPPED else 0) for plane in planes]
    clipped = ImageChops.multiply(ImageChops.multiply(near_white[0], near_white[1]), near_white[2])
    clipped_percent = clipped.histogram()[255] / float(rgb.width * rgb.height) * 100.0

    target = 255.0 if whiten else max(1.0, sum(paper_before) / 3.0)

    # Dividing each channel by its *own* field is what removes the colour cast:
    # a warm lamp raises red more than blue, so the paper only comes back neutral
    # if each channel is normalised against the paper as that channel saw it. A
    # single shared field would flatten the shadow and leave the page brown.
    # The floor is applied to the field itself rather than inside the
    # expression: ImageMath's min and max take images, not scalars, and pushing
    # a constant through them fails at run time rather than at import. `convert`
    # clamps the result, so the division cannot overflow the channel either.
    floored = [field.point(lambda level: max(level, int(FIELD_FLOOR))) for field in fields]
    corrected_planes = [
        ImageMath.unsafe_eval(
            "convert(float(a) * target / float(b), 'L')",
            a=plane,
            b=field,
            target=target,
        )
        for plane, field in zip(planes, floored, strict=True)
    ]

    corrected = Image.merge("RGB", corrected_planes)

    # Dividing the light out evens the page but leaves it grey-ish, because the
    # paper's own reflectance is not 100%. The curve finishes the job: page to
    # white, ink deeper, stroke shape intact. Measured on the prescription this
    # was built for, paper went 247 to 251 and the writing darkened with it.
    if lift_ink:
        corrected = corrected.point(_ink_curve)

    if not keep_ink_colour:
        corrected = corrected.convert("L").convert("RGB")

    # **The burnt-out core is rendered as paper, and the report says it was
    # lost.**
    #
    # An earlier version put the original pixels back, reasoning that
    # preserving them was more honest than replacing them. On a real page it is
    # the opposite: those pixels are 255 in every channel, they carry no
    # information whatsoever, and once the paper around them has been corrected
    # to white they stand out as a coloured blob - the lamp's own tint, now the
    # most conspicuous thing on an otherwise clean page.
    #
    # Neither choice recovers anything, because there is nothing to recover. So
    # the choice is only what to *display*, and blank paper is both less
    # misleading than a pink smear and less likely to be mistaken for content.
    # What carries the truth is the warning, which names the percentage lost and
    # says to photograph it again without the lamp behind you.
    if whiten:
        blank = Image.new("RGB", rgb.size, (255, 255, 255))
        corrected = Image.composite(blank, corrected, clipped)

    if strength < 1.0:
        corrected = Image.blend(rgb, corrected, strength)

    after_fields = [_field_for(plane, Image, ImageFilter) for plane in corrected.split()]
    paper_after = tuple(int(_percentile(field, 0.5)) for field in after_fields)
    evenness_after = _evenness(_luminance_of(after_fields, Image))

    warnings: list[str] = []
    if clipped_percent >= 0.5:
        warnings.append(
            f"{clipped_percent:.1f}% of the page was burnt out by a reflection. Whatever "
            f"was written there was not captured by the camera and cannot be recovered - "
            f"photograph it again without the lamp behind you to get those words back."
        )
    if evenness_before < 12:
        warnings.append("The lighting was already even, so there was little to correct here.")

    return corrected, DocumentReport(
        paper_before=paper_before,  # type: ignore[arg-type]
        paper_after=paper_after,  # type: ignore[arg-type]
        evenness_before=evenness_before,
        evenness_after=evenness_after,
        clipped_percent=clipped_percent,
        warnings=tuple(warnings),
    )
