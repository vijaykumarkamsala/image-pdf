"""Numbering pages, and numbering them across a whole bundle.

Stamping puts the same words on every page. Numbering puts a *different* mark on
each one, and carries the count forward from one document to the next - which is
the difference between a watermark and a reference someone can cite.

**Why the count has to cross documents.** A disclosure bundle is sixty separate
files that a court, a client or an opponent refers to as one thing: "see
ABC-000412". If each file restarts at one there are sixty page 412s and the
reference means nothing. So :func:`number_pages` returns the number it stopped
at, and a batch feeds that into the next document. That single return value is
the entire feature; everything else here is placement.

**Nothing underneath is touched.** The numbers are appended as their own content
stream inside a `q`/`Q` pair, exactly as stamping is, so a page's artwork is
never rewritten and a bundle can be numbered without any risk to what it holds.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ipw.pdf.document import StandardFont, text_width
from ipw.pdf.edit import _GraphCopier, _page_body
from ipw.pdf.objects import Name, PdfWriter, Reference, Stream
from ipw.pdf.reader import PdfReader

__all__ = ["POSITIONS", "Numbering", "number_pages"]

# Where the mark sits, as a fraction of the page and which way it grows from.
# Bottom-right is the convention for legal numbering, so it is the default.
POSITIONS = {
    "bottom-right": ("right", "bottom"),
    "bottom-left": ("left", "bottom"),
    "bottom-centre": ("centre", "bottom"),
    "top-right": ("right", "top"),
    "top-left": ("left", "top"),
    "top-centre": ("centre", "top"),
}


@dataclass(frozen=True)
class Numbering:
    """How the mark should look and where it should sit."""

    prefix: str = ""
    """Text before the number, e.g. `ABC-`. Empty for a plain page number."""

    start: int = 1
    digits: int = 6
    """Zero padding. Six is the legal convention: ABC-000001 sorts correctly as
    text, which a bare number does not once a bundle passes ten pages."""

    position: str = "bottom-right"
    size: float = 9.0
    margin: float = 24.0
    colour: tuple[float, float, float] = (0.15, 0.15, 0.2)
    font: StandardFont = StandardFont.HELVETICA

    def label(self, number: int) -> str:
        return (
            f"{self.prefix}{number:0{max(self.digits, 1)}d}"
            if self.digits
            else (f"{self.prefix}{number}")
        )


def number_pages(
    reader: PdfReader,
    settings: Numbering | None = None,
    *,
    keep_private_data: bool = False,
) -> tuple[bytes, dict[str, Any]]:
    """Mark every page with its own number, and say where the count reached.

    The returned `next_number` is what makes a bundle work: the caller feeds it
    into the following document so the sequence runs unbroken across sixty files
    the way a citation expects.
    """
    options = settings or Numbering()
    if options.position not in POSITIONS:
        msg = f"unknown position {options.position!r}; available: {sorted(POSITIONS)}"
        raise ValueError(msg)
    if options.start < 0:
        msg = "numbering cannot start below zero"
        raise ValueError(msg)

    pages = reader.pages()
    writer = PdfWriter()
    catalog, tree = writer.reserve(), writer.reserve()
    copier = _GraphCopier(writer)

    font_ref = writer.add(
        {
            "Type": Name("Font"),
            "Subtype": Name("Type1"),
            "BaseFont": Name(options.font.value),
            "Encoding": Name("WinAnsiEncoding"),
        }
    )

    refs: list[Reference] = []
    first_label = ""
    last_label = ""
    number = options.start

    for index, page in enumerate(pages):
        body = _page_body(page.dictionary, keep_private_data=keep_private_data)

        # Resources are resolved into a plain dictionary so the font can be added
        # to this page without editing an object other pages share.
        resources = reader.resolve(body.get("Resources"))
        resources = dict(resources) if isinstance(resources, dict) else {}
        fonts = reader.resolve(resources.get("Font"))
        resources["Font"] = dict(fonts) if isinstance(fonts, dict) else {}
        body["Resources"] = resources

        copied = copier.copy(reader, body)
        if not isinstance(copied, dict):
            continue
        copied["Type"] = Name("Page")
        copied["Parent"] = tree

        _attach_font(copied, writer, font_ref)

        label = options.label(number)
        if index == 0:
            first_label = label
        last_label = label

        described = reader.describe()["pages"][index]
        width = described["width_inches"] * 72.0
        height = described["height_inches"] * 72.0
        mark = writer.add(Stream({}, _mark(label, options, width, height)))
        copied["Contents"] = _appended(copied.get("Contents"), mark)

        refs.append(writer.add(copied))
        number += 1

    writer.put(tree, {"Type": Name("Pages"), "Kids": refs, "Count": len(refs)})
    writer.put(catalog, {"Type": Name("Catalog"), "Pages": tree})
    data = writer.build(catalog, {"Producer": "Image & PDF Workspace"})

    return data, {
        "pages_numbered": len(refs),
        "first": first_label,
        "last": last_label,
        # The whole point of the feature: where the next document picks up.
        "next_number": number,
        "note": (
            f"{len(refs)} page(s) numbered {first_label} to {last_label}. "
            f"The next document continues at {options.label(number)}."
            if refs
            else "This document has no pages to number."
        ),
    }


def _mark(label: str, options: Numbering, width: float, height: float) -> bytes:
    """One page's number, placed and drawn.

    Positioned from the page's own measured box rather than an assumed A4, so a
    bundle of mixed sizes - a scan, a plan, a letter - is marked consistently at
    the same distance from each page's own edge.
    """
    horizontal, vertical = POSITIONS[options.position]
    span = text_width(label, options.size, options.font)

    if horizontal == "right":
        x = width - options.margin - span
    elif horizontal == "centre":
        x = (width - span) / 2.0
    else:
        x = options.margin

    y = options.margin if vertical == "bottom" else height - options.margin - options.size

    red, green, blue = options.colour
    escaped = label.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    return (
        f"q {red:.3f} {green:.3f} {blue:.3f} rg BT /IpwNum {options.size:.2f} Tf "
        f"1 0 0 1 {x:.2f} {y:.2f} Tm ({escaped}) Tj ET Q"
    ).encode("latin-1", "replace")


def _attach_font(copied: dict[str, Any], writer: PdfWriter, font_ref: Reference) -> None:
    resources = copied.get("Resources")
    if isinstance(resources, Reference):
        resources = writer.get(resources)
    if not isinstance(resources, dict):
        return
    fonts = resources.get("Font")
    if isinstance(fonts, Reference):
        fonts = writer.get(fonts)
    if not isinstance(fonts, dict):
        fonts = {}
        resources["Font"] = fonts
    fonts["IpwNum"] = font_ref


def _appended(existing: Any, mark: Reference) -> Any:
    """Draw the number after whatever the page already draws.

    Appending rather than replacing, for the same reason stamping does: the page
    is the document, and a number that overwrote it would be a spectacular way
    to ruin a bundle.
    """
    if existing is None:
        return mark
    if isinstance(existing, list):
        return [*existing, mark]
    return [existing, mark]
