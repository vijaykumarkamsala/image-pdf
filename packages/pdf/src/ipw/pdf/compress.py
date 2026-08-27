"""Making a PDF small enough to actually send.

The request is never "compress this". It is "the portal will not take anything
over 10 MB", "the court's filing system rejects it", "this bounces off their
mail server", "the client cannot download it on site". A tool that offers low,
medium and high quality makes the customer guess and re-guess; one that takes a
number in megabytes answers the question they actually have.

**Where the weight is, and why it is usually invisible.** A scanner at 600 DPI
produces images with four times the pixels of a 300 DPI print and sixteen times
those of a 150 DPI screen. Placed size is what decides whether any of that can
be seen: a 4000-pixel photograph dropped into a two-inch box on the page is
carrying 2000 DPI, and three quarters of its weight cannot be resolved by any
printer, screen or eye. Removing what cannot be seen is not a quality trade at
all - the trade only begins below the placed resolution, and this reports which
side of that line the result landed on.

**What it will not do.** It will not silently miss the target. If the smallest
honest setting still leaves the file too large, that is reported as a failure to
reach the target rather than returned as a success - because a customer who
believes their file is under the limit and finds out at the upload form has been
told something worse than nothing.
"""

from __future__ import annotations

import io
from dataclasses import dataclass, field
from typing import Any

from ipw.pdf.content import image_placements
from ipw.pdf.edit import _GraphCopier, page_body_without_xobjects
from ipw.pdf.objects import Name, PdfWriter, Reference, Stream
from ipw.pdf.reader import PdfReader

__all__ = ["CompressionReport", "Ladder", "compress", "compress_to_target"]

# Settings tried in order, best first. Each step is a real decision a person
# would recognise: keep print resolution, keep screen resolution, keep only
# enough to read on a phone.
LADDER: list[tuple[int, int]] = [
    (300, 92),
    (300, 85),
    (200, 82),
    (150, 78),
    (150, 70),
    (110, 65),
    (72, 60),
]
"""(maximum DPI at placed size, JPEG quality)."""

Ladder = list[tuple[int, int]]


@dataclass
class CompressionReport:
    original_bytes: int = 0
    final_bytes: int = 0
    images_touched: int = 0
    images_left_alone: int = 0
    dpi_limit: int = 0
    quality: int = 0
    lowest_dpi_before: int = 0
    lowest_dpi_after: int = 0
    target_bytes: int | None = None
    reached_target: bool = True
    attempts: int = 1
    notes: list[str] = field(default_factory=list)

    @property
    def saved(self) -> int:
        return max(0, self.original_bytes - self.final_bytes)

    @property
    def ratio(self) -> float:
        return self.final_bytes / self.original_bytes if self.original_bytes else 1.0


def compress(
    reader: PdfReader,
    *,
    max_dpi: int = 200,
    quality: int = 82,
    keep_private_data: bool = False,
) -> tuple[bytes, CompressionReport]:
    """Rebuild the document with its images no larger than they need to be."""
    from PIL import Image

    report = CompressionReport(original_bytes=len(reader.data), dpi_limit=max_dpi, quality=quality)

    writer = PdfWriter()
    catalog, tree = writer.reserve(), writer.reserve()
    copier = _GraphCopier(writer)

    refs: list[Reference] = []
    for page in reader.pages():
        placements = image_placements(reader, page.dictionary)
        replacements: dict[str, tuple[bytes, int, int]] = {}

        for name, (stream, ctm) in placements.items():
            width = int(stream.dictionary.get("Width") or 0)
            height = int(stream.dictionary.get("Height") or 0)
            if width <= 0 or height <= 0:
                continue

            # The image is drawn into the unit square, so the matrix's scale is
            # its placed size in points. Points are 1/72 inch, hence DPI.
            placed_width = abs(ctm[0]) or abs(ctm[2]) or 1.0
            placed_height = abs(ctm[3]) or abs(ctm[1]) or 1.0
            dpi_x = width / (placed_width / 72.0)
            dpi_y = height / (placed_height / 72.0)
            current = int(min(dpi_x, dpi_y))
            report.lowest_dpi_before = (
                current if report.lowest_dpi_before == 0 else min(report.lowest_dpi_before, current)
            )

            try:
                picture = Image.open(io.BytesIO(stream.decoded()))
                picture.load()
            except Exception:  # noqa: BLE001 - an unreadable image is left exactly as it is
                report.images_left_alone += 1
                continue

            scale = min(1.0, max_dpi / current) if current > 0 else 1.0
            target_size = (
                max(1, int(picture.width * scale)),
                max(1, int(picture.height * scale)),
            )
            sized = (
                picture.resize(target_size, Image.Resampling.LANCZOS)
                if scale < 1.0
                else picture.copy()
            )

            has_alpha = sized.mode in ("RGBA", "LA", "P")
            if has_alpha:
                # JPEG cannot carry transparency, and flattening it onto white
                # would change the artwork rather than merely compress it.
                report.images_left_alone += 1
                continue

            buffer = io.BytesIO()
            sized.convert("RGB").save(
                buffer, format="JPEG", quality=quality, optimize=True, progressive=True
            )
            candidate = buffer.getvalue()

            if len(candidate) >= len(stream.data) and scale >= 1.0:
                # Re-encoding made it bigger, which happens with flat artwork
                # and small images. Spending a lossy generation to grow the file
                # is the worst of both outcomes.
                report.images_left_alone += 1
                continue

            # The *resized* dimensions, not the original's. Declaring the old
            # size alongside the new pixels leaves the page dictionary
            # contradicting the JPEG inside it, and reports a resolution that
            # was not delivered.
            replacements[name] = (candidate, sized.width, sized.height)
            report.images_touched += 1
            after = int(
                min(sized.width / (placed_width / 72.0), sized.height / (placed_height / 72.0))
            )
            report.lowest_dpi_after = (
                after if report.lowest_dpi_after == 0 else min(report.lowest_dpi_after, after)
            )

        # Drop the originals before copying, or the file ends up carrying both
        # the old image and the new one - which is why an early version of this
        # made every file larger.
        body = page_body_without_xobjects(
            reader,
            page.dictionary,
            set(replacements),
            keep_private_data=keep_private_data,
        )
        copied = copier.copy(reader, body)
        if not isinstance(copied, dict):
            continue
        copied["Type"] = Name("Page")
        copied["Parent"] = tree
        _swap_images(copied, replacements, writer)
        refs.append(writer.add(copied))

    writer.put(tree, {"Type": Name("Pages"), "Kids": refs, "Count": len(refs)})
    writer.put(catalog, {"Type": Name("Catalog"), "Pages": tree})
    data = writer.build(catalog, {"Producer": "Image & PDF Workspace"})

    report.final_bytes = len(data)
    report.notes = _notes(report)
    return data, report


def compress_to_target(
    reader: PdfReader,
    target_bytes: int,
    *,
    keep_private_data: bool = False,
    ladder: Ladder | None = None,
) -> tuple[bytes, CompressionReport]:
    """Get under a size limit, using the gentlest setting that manages it.

    Walks from best quality downward and stops at the first setting that fits,
    rather than jumping straight to the smallest. A file that needed only a mild
    reduction should not come back looking like a fax because the limit was
    generous.

    If nothing on the ladder fits, the smallest result is returned with
    `reached_target` false. Reporting the miss is the whole point: a customer who
    believes the file is under the limit and discovers otherwise at the upload
    form has been actively misled.
    """
    if target_bytes <= 0:
        msg = "the target size must be greater than zero"
        raise ValueError(msg)

    steps = ladder or LADDER
    best: tuple[bytes, CompressionReport] | None = None

    for attempt, (dpi, quality) in enumerate(steps, start=1):
        data, report = compress(
            reader, max_dpi=dpi, quality=quality, keep_private_data=keep_private_data
        )
        report.target_bytes = target_bytes
        report.attempts = attempt

        if best is None or len(data) < best[0].__len__():
            best = (data, report)

        if len(data) <= target_bytes:
            report.reached_target = True
            report.notes = _notes(report)
            return data, report

    data, report = best if best else (reader.data, CompressionReport())
    report.target_bytes = target_bytes
    report.reached_target = False
    report.notes = _notes(report)
    return data, report


def _swap_images(
    copied: dict[str, Any],
    replacements: dict[str, tuple[bytes, int, int]],
    writer: PdfWriter,
) -> None:
    if not replacements:
        return
    resources = copied.get("Resources")
    if isinstance(resources, Reference):
        resources = writer.get(resources)
    if not isinstance(resources, dict):
        return
    xobjects = resources.get("XObject")
    if isinstance(xobjects, Reference):
        xobjects = writer.get(xobjects)
    if not isinstance(xobjects, dict):
        xobjects = {}
        resources["XObject"] = xobjects

    for name, (data, width, height) in replacements.items():
        # DCTDecode: the JPEG goes in as the JPEG, with no second re-encoding.
        xobjects[name] = writer.add(
            Stream(
                {
                    "Type": Name("XObject"),
                    "Subtype": Name("Image"),
                    "Width": width,
                    "Height": height,
                    "ColorSpace": Name("DeviceRGB"),
                    "BitsPerComponent": 8,
                },
                data,
                compress=False,
                filters=("DCTDecode",),
            )
        )


def _notes(report: CompressionReport) -> list[str]:
    """Plain sentences about what happened, including any bad news."""
    notes: list[str] = []

    if report.original_bytes:
        notes.append(
            f"{_size(report.final_bytes)} from "
            f"{_size(report.original_bytes)} - "
            f"{100 - report.ratio * 100:.0f}% smaller."
        )

    if report.images_touched:
        notes.append(
            f"{report.images_touched} image(s) were reduced to at most {report.dpi_limit} DPI "
            f"at the size they are printed."
        )
        if report.lowest_dpi_after >= 300:
            notes.append("Still above 300 DPI everywhere: fine for print.")
        elif report.lowest_dpi_after >= 150:
            notes.append(
                f"The weakest image is now {report.lowest_dpi_after} DPI - good for fabric, "
                "banners and screen, and soft for fine detail."
            )
        elif report.lowest_dpi_after > 0:
            notes.append(
                f"The weakest image is now {report.lowest_dpi_after} DPI, which will look soft "
                "in print. Keep the original if you may need to print this."
            )

    if report.images_left_alone:
        notes.append(
            f"{report.images_left_alone} image(s) were left untouched - either they carry "
            "transparency, or re-encoding would have made them larger."
        )

    if not report.images_touched and report.saved > report.original_bytes * 0.05:
        # The file shrank without a single image being re-encoded, which is
        # surprising enough to need explaining rather than leaving as a
        # suspiciously good number.
        notes.append(
            "No image needed reducing - the saving is the design program's private working "
            "copy of the artwork, which is left out. What prints is identical."
        )
    elif not report.images_touched and not report.images_left_alone:
        notes.append("This document has no images to reduce; its size is text and vector artwork.")

    if report.target_bytes is not None and not report.reached_target:
        notes.append(
            f"COULD NOT reach {_size(report.target_bytes)}. The smallest honest result is "
            f"{_size(report.final_bytes)}. Splitting the document into parts will do what "
            "compressing it alone cannot."
        )

    return notes


def _size(value: int) -> str:
    """Megabytes, unless that would round a real limit to something else.

    A 500 KB limit printed as "0.5 MB" is fine; a 50 KB limit printed as "0.1 MB"
    is a different number from the one the customer typed, in a sentence
    explaining that the number could not be met.
    """
    if value < 1_000_000:
        return f"{value / 1_000:.0f} KB"
    return f"{value / 1_000_000:.1f} MB"
