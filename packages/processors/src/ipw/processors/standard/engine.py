"""The imaging-engine seam.

``StandardProcessor`` implements the whole processor contract - identity,
support checks, inspection, estimation, normalised failures, measurement - and
delegates only the actual pixel work to an :class:`ImageEngine`. Pillow and
libvips therefore differ in one small, comparable surface rather than in two
parallel processor implementations, which is what makes their benchmark results
attributable to the *engine* rather than to incidental differences in plumbing.

Every operation here is **non-generative** (D-009). Standard Enhance resizes,
crops, adjusts and sharpens; it never invents detail that was not in the source.
"""

from __future__ import annotations

from typing import Any, Literal, Protocol, TypeVar, runtime_checkable

__all__ = ["EngineError", "EngineImage", "ImageEngine", "ImageT", "ResampleFilter"]

ResampleFilter = Literal["bicubic", "lanczos", "nearest"]


class EngineError(RuntimeError):
    """The engine could not carry out the operation.

    Raised across the engine seam only. ``StandardProcessor`` converts it into a
    :class:`~ipw.contracts.failure.NormalizedFailure`, so nothing escapes the
    processor boundary (AGENTS.md: one failed input must not fail a batch).
    """


@runtime_checkable
class EngineImage(Protocol):
    """An opaque in-memory image owned by an engine."""

    @property
    def width(self) -> int: ...

    @property
    def height(self) -> int: ...

    @property
    def bands(self) -> int:
        """Channel count, including alpha when present."""
        ...

    @property
    def has_alpha(self) -> bool: ...


ImageT = TypeVar("ImageT", bound=EngineImage)
"""The concrete image type an engine works with.

Invariant, because it appears in both parameter and return position: an engine
that accepts only its own image type is not substitutable for one accepting any
image, and pretending otherwise would let a libvips image reach Pillow's
resize. The type parameter keeps each engine internally consistent while the
processor stays generic over both.
"""


@runtime_checkable
class ImageEngine(Protocol[ImageT]):
    """Pixel operations, implemented once per imaging library.

    Implementations must be **deterministic**: the same input, operation and
    settings must produce byte-identical output for a pinned library version.
    Where that cannot be guaranteed, ``deterministic`` reports ``False`` and every
    result is labelled accordingly (AGENTS.md reproducibility rules).
    """

    @property
    def name(self) -> str:
        """Engine identifier, e.g. ``'pillow'``."""
        ...

    @property
    def version(self) -> str:
        """Exact library version, recorded in the processor identity."""
        ...

    @property
    def available(self) -> bool:
        """Whether the underlying library can actually run on this host."""
        ...

    @property
    def deterministic(self) -> bool: ...

    # -- lifecycle --------------------------------------------------------
    def load(self, path: str) -> ImageT:
        """Decode an image. The source file is opened read-only and never written."""
        ...

    def save(
        self, image: ImageT, path: str, media_type: str, quality: int, *, optimise: bool
    ) -> None: ...

    # -- geometry ---------------------------------------------------------
    def resize(
        self, image: ImageT, width: int, height: int, resample: ResampleFilter
    ) -> ImageT: ...

    def crop(self, image: ImageT, x: int, y: int, width: int, height: int) -> ImageT: ...

    def rotate(self, image: ImageT, degrees: int) -> ImageT:
        """Rotate clockwise by 90, 180 or 270 degrees. Lossless, no resampling."""
        ...

    def flip(self, image: ImageT, axis: Literal["horizontal", "vertical"]) -> ImageT: ...

    # -- tone and colour --------------------------------------------------
    def adjust(
        self,
        image: ImageT,
        *,
        brightness_percent: int,
        contrast_percent: int,
        saturation_percent: int,
        exposure_percent: int,
        white_balance: str,
    ) -> ImageT:
        """Apply tone and colour adjustments.

        Percentages are signed deltas in [-100, 100], where 0 is no change. Integer
        inputs keep the settings free of floats so they canonicalise identically
        on any platform.
        """
        ...

    # -- detail -----------------------------------------------------------
    def print_ready(
        self,
        image: ImageT,
        *,
        scale: int,
        material: str,
        whiten: bool,
        keep_ink_colour: bool,
    ) -> ImageT:
        """Clean the lighting, then enlarge. One step, because the order matters."""
        ...

    def straighten_page(self, image: ImageT, corners: Any | None) -> ImageT:
        """Flatten a page photographed at an angle into a rectangle."""
        ...

    def enlarge(self, image: ImageT, *, scale: int, material: str, iterations: int) -> ImageT:
        """Enlarge by back-projection: better than a resize, invents nothing."""
        ...

    def clean_document(
        self, image: ImageT, *, strength_percent: int, whiten: bool, keep_ink_colour: bool
    ) -> ImageT:
        """Divide out the lighting on a photograph of a page."""
        ...

    def sharpen(self, image: ImageT, amount_percent: int, radius_x100: int) -> ImageT:
        """Unsharp mask. Enhances existing edges; invents nothing."""
        ...

    def denoise(self, image: ImageT, strength_percent: int) -> ImageT:
        """Classical noise reduction. Median or comparable, never generative."""
        ...

    # -- format -----------------------------------------------------------
    def flatten_alpha(self, image: ImageT, background: str) -> ImageT:
        """Composite onto an opaque background.

        Required before writing an image with alpha to a format that has none;
        ``USER_FLOWS_AND_EDGE_CASES.md`` section 5 requires this to be an explicit
        choice rather than a silent loss of transparency.
        """
        ...
