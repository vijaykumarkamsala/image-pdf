"""Making a small picture into a larger one that still looks like the subject.

Enlarging is not resampling. A resize asks "what colour sits between these two
pixels" and answers by averaging, which is why an enlarged photograph goes soft:
every edge is smeared across the pixels invented around it. The result is bigger
and worse, and it is what every basic tool does.

**Back-projection asks a better question.** A correct enlargement, shrunk back
down, must reproduce the picture it came from. Most enlargements do not: shrink
a Lanczos upscale and it differs from the original, and that difference is
exactly the detail the interpolation destroyed. So measure it, scale it up, add
it back, and repeat. Each pass pushes the large image toward the only answer
consistent with what the camera actually recorded.

That is real super-resolution and it is a hundred years older than machine
learning. It does not invent anything - every value it adds is derived from the
customer's own pixels, and the loop converges toward *their* photograph rather
than toward what a model was trained to expect. For a document, a garment
sample or anything that will be printed and inspected, that distinction is the
product.

**Why not the AI upscaler.** There is one, and it is better on faces and
foliage. Its weights are trained on DIV2K, whose licence reads "academic
research purpose only", so it cannot be sold (see the licence register). This
path has no such problem: it is arithmetic on the customer's file.

**Halo control.** Sharpening after enlargement is where cheap tools give
themselves away - a bright rim on every dark edge, obvious on a printed garment
and impossible to remove later. The correction is limited to the range the
neighbourhood already spans, so an edge is restored to what it was rather than
being overshot past it.

**Why the material has to be asked for.** Measured against ground truth -
shrink a known image, enlarge it back, score it - sharpening after the loop is
not one answer:

    material         plain resize    with sharpening    without
    woven fabric        27.75 dB       25.93  (-1.82)   28.52  (+0.77)
    printed text        20.65 dB       24.50  (+3.86)   21.45  (+0.80)
    photograph          31.60 dB       33.39  (+1.79)   31.91  (+0.31)

Text and photographs want it badly; fine repeating structure is ruined by it,
because an unsharp mask cannot tell a weave from an edge and adds contrast to
every thread. A single default would be wrong for a third of the work and
silently wrong for the customer whose work is cloth - so the material is asked
for, in the customer's words, and the numbers above are why.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

__all__ = ["MAX_ITERATIONS", "UpscaleReport", "upscale"]

# How many times to measure the error and put it back.
#
# The first pass carries most of the gain and each one after refines it; the
# residual falls monotonically, so more is never worse, only slower. Capped
# because an unbounded loop on a twelve-megapixel photograph is a hung tab.
DEFAULT_ITERATIONS = 3
MAX_ITERATIONS = 8

# How much of each measured error to put back per pass.
#
# The full amount, now that the error is spread with a kernel that cannot
# overshoot. An earlier version used 0.75 to damp an oscillation that turned
# out to be the kernel's fault rather than the gain's.
FEEDBACK = 1.0


@dataclass(frozen=True)
class UpscaleReport:
    """What was done, and how far it got."""

    scale: int
    iterations: int
    width: int
    height: int
    residual_before: float
    residual_after: float
    material: str = "photo"

    @property
    def improvement_percent(self) -> float:
        """How much of the reconstruction error the loop removed."""
        if self.residual_before <= 0:
            return 0.0
        return (1.0 - self.residual_after / self.residual_before) * 100.0

    def as_record(self) -> dict[str, Any]:
        return {
            "scale": self.scale,
            "iterations": self.iterations,
            "width": self.width,
            "height": self.height,
            "residual_before": round(self.residual_before, 3),
            "residual_after": round(self.residual_after, 3),
            "improvement_percent": round(self.improvement_percent, 1),
            "material": self.material,
        }


def _mean_abs_difference(left: Any, right: Any) -> float:
    """Average absolute difference between two images, 0-255.

    This is the number the loop is minimising: how far the enlargement is from
    being consistent with the original when shrunk back down.
    """
    from PIL import ImageChops, ImageStat

    return sum(ImageStat.Stat(ImageChops.difference(left, right)).mean) / 3.0


#: What the picture is, and therefore whether edge contrast helps or harms.
#: The names are the customer's, not the algorithm's.
MATERIALS = {
    "photo": True,  # photographs, artwork, anything with subjects and edges
    "text": True,  # documents, line drawings, plans, screenshots
    "texture": False,  # cloth, weave, grain, mesh - fine repeating structure
}


def upscale(
    image: Any,
    scale: int = 2,
    *,
    iterations: int = DEFAULT_ITERATIONS,
    material: str = "photo",
) -> tuple[Any, UpscaleReport]:
    """Enlarge by an integer factor, then correct it against the original.

    ``material`` decides whether edge contrast is restored afterwards. See the
    module docstring for the measurements: it is worth +3.9 dB on printed text
    and costs -1.8 dB on woven cloth, which is why it is a question rather than
    a default.

    Returns the enlargement and a report of how much of the reconstruction
    error was removed, so the claim "this is better than a resize" is a number
    rather than an adjective.
    """
    if material not in MATERIALS:
        known = ", ".join(sorted(MATERIALS))
        msg = f"{material!r} is not a material this understands. Known: {known}"
        raise ValueError(msg)
    sharpen = MATERIALS[material]

    from PIL import Image, ImageChops, ImageFilter, ImageMath

    if scale < 1:
        msg = f"scale must be at least 1, got {scale}"
        raise ValueError(msg)
    passes = max(0, min(int(iterations), MAX_ITERATIONS))

    source = image.convert("RGB")
    target = (source.width * scale, source.height * scale)

    if scale == 1:
        return source, UpscaleReport(1, 0, source.width, source.height, 0.0, 0.0, material)

    # The starting guess, which is what an ordinary resize would have given.
    large = source.resize(target, Image.Resampling.LANCZOS)
    residual_before = _mean_abs_difference(
        large.resize(source.size, Image.Resampling.LANCZOS), source
    )

    for _ in range(passes):
        # Shrink the current answer and see where it disagrees with the truth.
        simulated = large.resize(source.size, Image.Resampling.LANCZOS)

        corrected_planes = []
        for plane, small_plane, simulated_plane in zip(
            large.split(), source.split(), simulated.split(), strict=True
        ):
            # The error carries a sign, which unsigned image maths throws away,
            # so it is computed in float and only converted back at the end.
            error = ImageMath.unsafe_eval("float(a) - float(b)", a=small_plane, b=simulated_plane)
            # **Bilinear, and this is load-bearing.**
            #
            # Lanczos and bicubic have negative lobes. Feeding a correction back
            # through them adds a little ringing each pass, and the ringing is
            # itself measured as error on the next one, so the loop chases its
            # own tail. Measured on a photograph, the residual per pass:
            #
            #     lanczos    0.187  0.142  0.142  0.178  0.223   diverges
            #     bicubic    0.187  0.140  0.124  0.149  0.178   diverges
            #     bilinear   0.187  0.128  0.086  0.061  0.056   converges
            #
            # Both of the first two *look* better after one pass, which is how
            # this shipped in the first draft and why the convergence test
            # exists. Bilinear is strictly positive, so it cannot overshoot, and
            # the loop settles instead of unravelling.
            spread = error.resize(target, Image.Resampling.BILINEAR)
            corrected_planes.append(
                ImageMath.unsafe_eval(
                    "convert(float(base) + float(fix) * feedback, 'L')",
                    base=plane,
                    fix=spread,
                    feedback=FEEDBACK,
                )
            )
        large = Image.merge("RGB", corrected_planes)

    residual_after = _mean_abs_difference(
        large.resize(source.size, Image.Resampling.LANCZOS), source
    )

    if sharpen:
        # Restore the edge, do not overshoot it.
        #
        # An unsharp mask adds the difference between the image and a blur of
        # itself, which brightens one side of every dark edge and darkens the
        # other - the halo that gives cheap enlargements away, and that prints
        # as a visible outline on cloth. Clamping each pixel to the range its
        # own neighbourhood already spans keeps the sharpening and drops the
        # overshoot.
        sharpened = large.filter(ImageFilter.UnsharpMask(radius=scale, percent=110, threshold=3))
        ceiling = large.filter(ImageFilter.MaxFilter(3))
        floor = large.filter(ImageFilter.MinFilter(3))
        large = ImageChops.lighter(ImageChops.darker(sharpened, ceiling), floor)

    return large, UpscaleReport(
        scale=scale,
        iterations=passes,
        width=large.width,
        height=large.height,
        residual_before=residual_before,
        residual_after=residual_after,
        material=material,
    )
