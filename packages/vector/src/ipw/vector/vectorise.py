"""Raster in, real vector artwork out.

**Why this matters across every industry, not one.** A vector has no resolution:
it is a description of shapes, so it is exactly as sharp on a business card as
on the side of a lorry. That single property is what a dozen unrelated trades
are all actually asking for when they send a blurry PNG and ask for it "in high
quality":

  a sign-writer who needs a cut path for the vinyl plotter;
  a workshop sending a profile to a laser or waterjet, which can only follow
      paths and cannot read pixels at all;
  an embroiderer whose digitising software needs closed shapes to fill;
  a screen printer who needs one separation per colour;
  a machinist tracing a scanned drawing back into CAD;
  a marketing team with a logo that exists only as a 400-pixel JPEG from 2011;
  an architect recovering a scanned floor plan;
  a teacher who wants a diagram that stays crisp on a projector.

Upscaling cannot do this. An upscaler produces more pixels, and more pixels are
still pixels: a cutter cannot follow them, and enlarging further still softens.
Tracing produces the shape itself, and there is no "further" to go.

**What this honestly cannot do.** It reproduces *shapes*, so it suits artwork
made of shapes - logos, line drawings, plans, labels, patterns, lettering. A
photograph of a face has no shapes in it, only a continuous gradient, and
vectorising one produces a posterised approximation that is useful for a stencil
or an engraving and useless as a photograph. The report says which of these
happened, in those terms, rather than returning something odd without comment.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from PIL import Image

from ipw.vector.palette import separate
from ipw.vector.render import Shape, to_pdf_operators, to_svg
from ipw.vector.simplify import fit_path
from ipw.vector.trace import area, trace_mask

__all__ = ["Settings", "VectorResult", "vectorise"]

# Above this, tracing is slow and the extra pixels buy nothing: the shapes are
# already described to well under a pixel of the original. The image is scaled
# down to trace and the result scaled back up, which is free - a vector has no
# resolution, so nothing is lost by describing it from a smaller grid.
MAX_TRACE_PIXELS = 4_000_000


@dataclass(frozen=True)
class Settings:
    """Everything the customer can choose, in units they can reason about."""

    mode: str = "flat_colour"
    """line_art, flat_colour or photographic."""

    colours: int = 8
    """How many colours to keep. One screen, knife or thread per colour."""

    detail: float = 1.0
    """How far, in pixels of the original, the outline may stray. Lower is
    tighter and heavier."""

    smoothness: float = 25.0
    """Bends gentler than this many degrees become curves. Zero keeps every
    corner sharp, which is right for plans, barcodes and pixel art."""

    despeckle: int = 8
    """Drop shapes smaller than this many pixels of area. Scanner grain and
    JPEG mosquito noise otherwise become thousands of real, cuttable specks."""

    threshold: int | None = None
    """Ink/paper cut for line art. Chosen from the image when not given."""

    keep_background: bool = False
    """Draw the largest colour as a filled rectangle rather than leaving it
    transparent."""

    clean: int = 0
    """Smooth away speckle before tracing, in pixels. A median filter, chosen
    because it removes specks while leaving edges where they are - a blur would
    move every boundary in the picture, which is the one thing a cut path must
    not do. Worth turning up for a scan or a photograph, where it removes grain
    that would otherwise be traced as thousands of real shapes; zero for artwork
    that is already flat."""


@dataclass
class VectorResult:
    svg: str
    width: int
    height: int
    shapes: list[Shape]
    report: dict[str, Any] = field(default_factory=dict)

    def pdf_operators(self, height_points: float, scale: float) -> bytes:
        return to_pdf_operators(self.shapes, height_points, scale=scale)


def vectorise(image: Image.Image, settings: Settings | None = None) -> VectorResult:
    """Trace an image into filled vector shapes."""
    options = settings or Settings()
    started = time.perf_counter()

    source_width, source_height = image.size
    working, scale = _fit_for_tracing(image)
    if options.clean > 0:
        from PIL import ImageFilter

        radius = max(1, min(int(options.clean), 5))
        working = working.filter(ImageFilter.MedianFilter(size=2 * radius + 1))

    layers = separate(
        working,
        mode=options.mode,
        colours=options.colours,
        threshold=options.threshold,
        ignore_background=not options.keep_background,
    )

    shapes: list[Shape] = []
    segments_total = 0
    dropped = 0

    for layer in layers:
        paths: list[tuple[Any, list[Any]]] = []
        for loop in trace_mask(layer.mask):
            # Area is in the *working* grid, so the threshold is compared there
            # too. Comparing a scaled-down area against a full-size threshold
            # would silently discard more on large images than on small ones.
            if abs(area(loop)) < options.despeckle:
                dropped += 1
                continue

            points = [(float(x) * scale, float(y) * scale) for x, y in loop]
            start, fitted = fit_path(
                points, smoothness=options.smoothness, tolerance=options.detail
            )
            paths.append((start, fitted))
            segments_total += len(fitted)

        if paths:
            shapes.append(Shape(layer.colour, paths))

    svg = to_svg(
        shapes,
        source_width,
        source_height,
        background=None,
    )

    return VectorResult(
        svg=svg,
        width=source_width,
        height=source_height,
        shapes=shapes,
        report=_report(
            options=options,
            shapes=shapes,
            segments=segments_total,
            dropped=dropped,
            svg_bytes=len(svg.encode("utf-8")),
            traced_at=(working.width, working.height),
            source=(source_width, source_height),
            seconds=time.perf_counter() - started,
        ),
    )


def _fit_for_tracing(image: Image.Image) -> tuple[Image.Image, float]:
    """Trace at a sane size; return the image and the scale back to full size.

    Downscaling before tracing is not a compromise. The output is a vector, so
    it is described in the original image's coordinates either way - only the
    grid the outlines are *measured* on gets coarser, and beyond a few million
    pixels that grid is already finer than any real edge in the picture.
    """
    pixels = image.width * image.height
    if pixels <= MAX_TRACE_PIXELS:
        return image, 1.0

    factor = (MAX_TRACE_PIXELS / pixels) ** 0.5
    size = (max(1, int(image.width * factor)), max(1, int(image.height * factor)))
    # LANCZOS rather than NEAREST: the point is to find where edges are, and
    # nearest-neighbour moves them by up to half a pixel at this scale.
    return image.resize(size, Image.Resampling.LANCZOS), image.width / size[0]


def _report(
    *,
    options: Settings,
    shapes: list[Shape],
    segments: int,
    dropped: int,
    svg_bytes: int,
    traced_at: tuple[int, int],
    source: tuple[int, int],
    seconds: float,
) -> dict[str, Any]:
    paths = sum(len(shape.paths) for shape in shapes)
    colours = [
        {
            "hex": f"#{shape.colour[0]:02x}{shape.colour[1]:02x}{shape.colour[2]:02x}",
            "paths": len(shape.paths),
        }
        for shape in shapes
    ]
    return {
        "mode": options.mode,
        "cleaned": options.clean,
        "colours": len(shapes),
        "palette": colours,
        "paths": paths,
        "segments": segments,
        "specks_dropped": dropped,
        "svg_bytes": svg_bytes,
        "traced_at": {"width": traced_at[0], "height": traced_at[1]},
        "source": {"width": source[0], "height": source[1]},
        "downscaled_to_trace": traced_at != source,
        "seconds": round(seconds, 3),
        "resolution_note": (
            "This is now a description of shapes, not pixels. It is exactly as "
            "sharp at any size - a business card or a billboard - and a cutter, "
            "plotter or engraver can follow it directly."
        ),
        "suitability": _suitability(options.mode, len(shapes), paths, segments),
    }


def _suitability(mode: str, colours: int, paths: int, segments: int) -> str:
    """Say plainly whether this image was a good candidate.

    A photograph traces into thousands of stacked blobs. That result is not a
    failure - it is a usable stencil or engraving - but calling it a vectorised
    photograph would be a lie, and the customer would find out at the machine.
    """
    if mode == "photographic" or (colours > 12 and paths > 400):
        return (
            "This looks like a photograph rather than artwork. What comes back is a "
            "posterised approximation: good for a stencil, an engraving or a "
            "single-colour print, and not a substitute for the photo itself."
        )
    if paths > 2000 or segments > 40_000:
        return (
            "This traced into a very large number of shapes, which usually means "
            "scanner grain or JPEG noise is being followed as if it were artwork. "
            "Raising 'ignore specks' or reducing the colour count will simplify it."
        )
    if paths == 0:
        return (
            "Almost nothing was found to trace. If the artwork is pale, set the "
            "ink threshold manually rather than letting it be chosen automatically."
        )

    # **A single-colour logo is the best case, not the empty one.**
    #
    # This used to read `colours <= 1 and paths <= 2`, which is the exact
    # signature of a one-colour mark on white - a black wordmark, a stencil, a
    # cutting file. That is the ideal input for tracing, and it was being told
    # that almost nothing had been found, which sends somebody adjusting an ink
    # threshold that was already right. "Nothing was traced" means no paths came
    # back; anything else found artwork.
    if colours <= 1 and segments >= 4:
        return (
            "Good candidate: a single-colour shape, which is exactly what a cutter, "
            "vinyl plotter, engraver or embroidery machine wants - one path, no "
            "colour separation needed."
        )
    return (
        "Good candidate: this traced into a clean set of shapes that will hold up "
        "at any size, and can be cut, engraved, embroidered or separated for print."
    )
