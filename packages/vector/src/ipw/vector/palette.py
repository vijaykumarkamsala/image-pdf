"""Deciding which colours a picture is actually made of.

Vectorising means drawing filled shapes, and a shape has one colour. A photo has
tens of thousands, so some of them have to go. Which ones, and how many, is not
a detail - it is the whole difference between a logo that comes back crisp and a
logo that comes back with a halo of nine nearly-identical greys around every
edge, one shape per grey.

Three shapes of that problem, because three different jobs arrive:

**Line art.** A scan, a sketch, a signature, an inked drawing. One ink colour on
one background. The only real question is where the boundary between them sits,
and the answer is chosen from the image rather than assumed, because a scan of
white paper is not white.

**Flat colour.** A logo, a label, a sign, a pattern to be screen printed or cut
from vinyl. A small, deliberate set of colours, and each one becomes a screen, a
knife path or a thread. Getting the *count* right matters more than getting each
colour perfectly: a printer quoted for four colours does not want six.

**Photographic.** A posterised approximation. Honest about what it is - nobody
should expect a photograph to survive this - but genuinely useful for stencils,
engraving and single-colour reproduction.

Determinism matters here as much as anywhere else in this repository. Median-cut
is used rather than k-means because it makes the same decision every time from
the same pixels, with no seed to record and no run-to-run drift to explain.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PIL import Image

__all__ = ["Layer", "separate"]


@dataclass(frozen=True)
class Layer:
    """One colour and the pixels that belong to it."""

    colour: tuple[int, int, int]
    mask: np.ndarray
    """Boolean, same shape as the image."""

    pixels: int
    """How many pixels this colour covers, for ordering and for reporting."""


def separate(
    image: Image.Image,
    *,
    mode: str,
    colours: int,
    threshold: int | None = None,
    ignore_background: bool = True,
) -> list[Layer]:
    """Split an image into flat colour layers, largest first.

    Largest first because that is paint order: the biggest area is nearly always
    the background, and a renderer that draws it last would cover everything
    else. Sorting here means neither renderer has to know that.
    """
    rgb = image.convert("RGB")
    if mode == "line_art":
        layers = _two_tone(rgb, threshold)
    elif mode in ("flat_colour", "photographic"):
        layers = _quantised(rgb, colours)
    else:
        msg = f"unknown mode {mode!r}; expected line_art, flat_colour or photographic"
        raise ValueError(msg)

    layers.sort(key=lambda layer: layer.pixels, reverse=True)
    if ignore_background and len(layers) > 1:
        # The background is left as absent rather than drawn. A vector file with
        # a transparent background drops onto any surface - a shirt, a sign, a
        # slide - while one carrying an opaque white rectangle has to be edited
        # first, every time.
        return layers[1:]
    return layers


def _two_tone(rgb: Image.Image, threshold: int | None) -> list[Layer]:
    """Ink and paper, split at a threshold chosen from the image itself."""
    grey = np.asarray(rgb.convert("L"), dtype=np.uint8)
    cut = otsu(grey) if threshold is None else int(threshold)

    dark = grey <= cut
    light = ~dark

    dark_pixels = int(dark.sum())
    light_pixels = int(light.sum())
    return [
        Layer(_mean_colour(rgb, dark), dark, dark_pixels),
        Layer(_mean_colour(rgb, light), light, light_pixels),
    ]


def otsu(grey: np.ndarray) -> int:
    """The threshold that best separates a greyscale image into two groups.

    Otsu's method: try every cut and keep the one that maximises the variance
    *between* the two groups. It is chosen over a fixed value like 128 because a
    fixed value has no idea what it is looking at - a pencil sketch on cream
    paper is entirely above 128, and would threshold to a blank page.
    """
    counts = np.bincount(grey.reshape(-1), minlength=256).astype(np.float64)
    total = counts.sum()
    if total == 0:
        return 128

    levels = np.arange(256, dtype=np.float64)
    weight_below = np.cumsum(counts)
    weight_above = total - weight_below

    sum_below = np.cumsum(counts * levels)
    sum_total = sum_below[-1]

    # Where either side is empty the split is meaningless, not merely poor, so
    # those cuts are excluded rather than allowed to produce a divide-by-zero
    # and an arbitrary winner.
    valid = (weight_below > 0) & (weight_above > 0)
    if not valid.any():
        return 128

    mean_below = np.divide(sum_below, weight_below, out=np.zeros(256), where=weight_below > 0)
    mean_above = np.divide(
        sum_total - sum_below, weight_above, out=np.zeros(256), where=weight_above > 0
    )
    between = weight_below * weight_above * (mean_below - mean_above) ** 2
    between[~valid] = -1.0
    return int(np.argmax(between))


def _quantised(rgb: Image.Image, colours: int) -> list[Layer]:
    """Reduce to `colours` flat colours and return one layer per colour."""
    count = max(2, min(int(colours), 64))

    # MEDIANCUT rather than the default: it is deterministic, so the same image
    # always separates the same way. A customer who re-runs a job to change one
    # setting should not get a different set of screens back.
    reduced = rgb.quantize(colors=count, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    indices = np.asarray(reduced, dtype=np.uint8)
    palette = reduced.getpalette() or []

    layers: list[Layer] = []
    for index in np.unique(indices):
        mask = indices == index
        pixels = int(mask.sum())
        if pixels == 0:
            continue
        base = int(index) * 3
        colour = (palette[base], palette[base + 1], palette[base + 2])
        layers.append(Layer(colour, mask, pixels))
    return layers


def _mean_colour(rgb: Image.Image, mask: np.ndarray) -> tuple[int, int, int]:
    """The average colour of the pixels under a mask.

    Averaging rather than using pure black and white: the ink in a scan is not
    black, and reproducing it as black changes the artwork. Someone who wants
    pure black can say so downstream; nobody can recover the original tone once
    it has been discarded here.
    """
    if not mask.any():
        return (0, 0, 0)
    data = np.asarray(rgb, dtype=np.float64)
    picked = data[mask]
    red, green, blue = picked.mean(axis=0)
    return (round(red), round(green), round(blue))
