"""Page-level operations on existing PDFs: merge, split, reorder, rotate, extract.

These are the operations almost every customer needs and almost nobody can do
without paying for something. A student combining scanned pages, an analyst
pulling four pages out of a sixty-page report, a designer reordering a print
run - all the same handful of verbs, none of which requires understanding what is
*drawn* on a page.

**The technique is copying the object graph, not rendering.** A PDF page is a
dictionary that references its content stream, which references fonts and images,
which reference more. Copy that graph into a new document with the references
renumbered and the page arrives intact - every vector path, every embedded font,
every image, at full quality, because nothing was ever decoded. This is why merge
and split are lossless in a way that "export to image and back" never is.

**What is honestly out of reach.** Re-flowing someone else's text, or editing
vector artwork placed by Illustrator, needs the semantics of the content stream
and usually the font programme too. PRODUCT_REQUIREMENTS.md section 19 asks for
existing content to be edited "only when technically supported, with honest
limitations", and :func:`capabilities` reports exactly which of these operations
apply to a given file rather than letting a customer discover the boundary by
hitting it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ipw.pdf.objects import Name, PdfWriter, Reference, Stream
from ipw.pdf.reader import IMAGE_FILTERS, PdfReader, PdfSyntaxError, RawStream

__all__ = [
    "ExtractedImage",
    "PageRef",
    "capabilities",
    "extract_images",
    "merge",
    "overlay_on_pages",
    "page_body_without_xobjects",
    "reorder",
    "rotate_pages",
    "select_pages",
]


@dataclass(frozen=True)
class PageRef:
    """One page of one source document."""

    reader: PdfReader
    index: int
    """Zero-based."""


@dataclass(frozen=True)
class ExtractedImage:
    """An image recovered from inside a PDF, in its original encoding."""

    data: bytes
    width: int
    height: int
    suffix: str
    page_number: int
    reencoded: bool
    """False when the bytes are the original JPEG, straight out of the file."""


# `Parent` must never be followed. Getting this wrong is silent and expensive:
# a page points at its page-tree node, whose `Kids` lists every *other* page, so
# copying one page by following its references reaches the entire document.
# Splitting four pages out of a twenty-seven page file produced 20.8 MB of the
# original 20.9 MB until this was found. It worked, and it was useless.
_NEVER_COPIED = ("Parent", "Kids", "Count")

# Private data the producer left behind for its own benefit. `PieceInfo` is the
# big one: Illustrator stores a complete second copy of the artwork there so it
# can reopen the PDF with live, editable objects. `Thumb` is a cached preview.
#
# Dropping both is measurable and safe - on a real 27-page Illustrator file it
# took 20.9 MB to 7.9 MB with all twenty-seven content streams, resource sets
# and media boxes byte-identical, so the print is unchanged. What is lost is the
# ability to reopen the file in Illustrator and edit the original objects.
#
# That is the right default for a deliverable and the wrong one for a working
# file, so it is a choice rather than a policy: `keep_private_data=True` keeps
# everything at full size.
_PRIVATE_TO_PRODUCER = ("PieceInfo", "Thumb", "LastModified")


# Catalogue entries carried into a derived document.
#
# A new document needs a new catalogue, and building a fresh one containing only
# /Pages is the obvious way to do that. It is also how a split silently destroys
# the bookmarks of a sixty-page report: the result opens perfectly and is missing
# something nobody checks until they need it.
#
# These entries do not name individual pages, so they survive any page operation.
_CATALOG_ALWAYS = ("Lang", "ViewerPreferences", "PageLayout", "PageMode", "OCProperties")

# These do name pages. A bookmark pointing at a page that was just removed is a
# dead link, and an /AcroForm listing fields whose widgets are gone is a form
# that cannot be filled in - both worse than a clean absence. So they are carried
# only when every page of a single source document is still present, which
# covers reorder, rotate and stamp, and never covers a split.
_CATALOG_IF_ALL_PAGES_KEPT = ("Outlines", "AcroForm", "Names", "PageLabels")

# Never carried. /Metadata is XMP describing the *original* - its title, its
# producer, the date it was made. Copying it onto a document with different
# pages would be a confident, machine-readable lie.
_CATALOG_NEVER = ("Metadata",)


def _carry_catalog(
    copier: _GraphCopier,
    readers: list[PdfReader],
    *,
    all_pages_kept: bool,
) -> tuple[dict[str, Any], list[str]]:
    """Copy what the new catalogue should inherit, and report what it did not.

    Only a single source can contribute: merging two documents that each have
    bookmarks would need those outline trees combined, and picking one at random
    would quietly discard the other.
    """
    if len(readers) != 1:
        return {}, []

    source = readers[0].catalog
    carried: dict[str, Any] = {}
    dropped: list[str] = []

    for key in _CATALOG_ALWAYS:
        if key in source:
            carried[key] = copier.copy(readers[0], source[key])

    for key in _CATALOG_IF_ALL_PAGES_KEPT:
        if key not in source:
            continue
        if all_pages_kept:
            carried[key] = copier.copy(readers[0], source[key])
        else:
            dropped.append(key)

    dropped.extend(key for key in _CATALOG_NEVER if key in source)
    return carried, dropped


def _strip_orphaned_widgets(page: dict[str, Any], reader: PdfReader) -> None:
    """Remove form widgets whose /AcroForm is not coming with them.

    A widget without its form definition draws as an empty box that cannot be
    typed into. Leaving it is worse than removing it: the page looks like it has
    a working field.
    """
    annots = reader.resolve(page.get("Annots"))
    if not isinstance(annots, list):
        return
    kept = []
    for entry in annots:
        resolved = reader.resolve(entry)
        subtype = resolved.get("Subtype") if isinstance(resolved, dict) else None
        if isinstance(subtype, Name) and subtype.value == "Widget":
            continue
        kept.append(entry)
    if kept:
        page["Annots"] = kept
    else:
        page.pop("Annots", None)


def _page_body(page: dict[str, Any], *, keep_private_data: bool = False) -> dict[str, Any]:
    """The page, ready to be copied into a new document."""
    drop = set(_NEVER_COPIED)
    if not keep_private_data:
        drop |= set(_PRIVATE_TO_PRODUCER)
    return {key: value for key, value in page.items() if key not in drop}


def page_body_without_xobjects(
    reader: PdfReader,
    page_dictionary: dict[str, Any],
    names: set[str],
    *,
    keep_private_data: bool = False,
) -> dict[str, Any]:
    """A page body with the named XObjects taken out before it is copied.

    Removing them *before* the copy is the whole point. A caller replacing an
    image - to redact it, or to shrink it - naturally copies the page and then
    swaps the entry in its resources, which leaves the original object in the
    finished file: unreferenced, invisible in any viewer, and readable by
    anything that walks objects instead of pages.

    In compression that surfaces as a file that grew. In redaction it is the
    original, unredacted scan sitting in a document certified as safe to
    release, which is the precise failure the feature exists to prevent.

    Resources and the XObject dictionary are resolved into plain dictionaries
    here, so the copier inlines them rather than following a reference back to
    the shared original.
    """
    body = _page_body(page_dictionary, keep_private_data=keep_private_data)
    if not names:
        return body

    resources = reader.resolve(body.get("Resources"))
    resources = dict(resources) if isinstance(resources, dict) else {}
    xobjects = reader.resolve(resources.get("XObject"))
    xobjects = dict(xobjects) if isinstance(xobjects, dict) else {}

    for name in names:
        xobjects.pop(name, None)

    resources["XObject"] = xobjects
    body["Resources"] = resources
    return body


class _GraphCopier:
    """Copies objects from source documents into one writer, renumbering as it goes.

    Each source needs its own identity map: object 12 in one file has nothing to
    do with object 12 in another, and a shared map would silently splice two
    documents together.
    """

    def __init__(self, writer: PdfWriter) -> None:
        self.writer = writer
        self._maps: dict[int, dict[int, Reference]] = {}

    def copy(self, reader: PdfReader, value: Any) -> Any:
        mapping = self._maps.setdefault(id(reader), {})
        return self._copy(reader, value, mapping)

    def _copy(self, reader: PdfReader, value: Any, mapping: dict[int, Reference]) -> Any:
        if isinstance(value, Reference):
            if value.number in mapping:
                return mapping[value.number]
            # Reserved before the target is copied, so a cycle - a page pointing
            # at its parent, which points back - terminates instead of recursing
            # until the stack gives out.
            placeholder = self.writer.reserve()
            mapping[value.number] = placeholder
            resolved = reader.object(value.number)
            self.writer.put(placeholder, self._copy(reader, resolved, mapping))
            return placeholder

        if isinstance(value, RawStream):
            return Stream(
                self._copy(reader, value.dictionary, mapping),
                value.data,
                compress=False,
                # Filters are carried over with the bytes. Decoding and
                # recompressing would be slower, larger, and - for a DCTDecode
                # image - lossy.
                filters=_filters_of(value.dictionary),
            )

        if isinstance(value, dict):
            return {key: self._copy(reader, item, mapping) for key, item in value.items()}
        if isinstance(value, list):
            return [self._copy(reader, item, mapping) for item in value]
        return value


def _filters_of(dictionary: dict[str, Any]) -> tuple[str, ...]:
    entry = dictionary.get("Filter")
    if entry is None:
        return ()
    if isinstance(entry, Name):
        return (entry.value,)
    if isinstance(entry, list):
        return tuple(item.value for item in entry if isinstance(item, Name))
    return ()


def _assemble(pages: list[PageRef], title: str = "", *, keep_private_data: bool = False) -> bytes:
    """Build one document from pages taken from any number of sources."""
    if not pages:
        msg = "no pages were selected"
        raise ValueError(msg)

    writer = PdfWriter()
    catalog = writer.reserve()
    tree = writer.reserve()
    copier = _GraphCopier(writer)

    # PdfReader is a mutable dataclass and so unhashable; dedupe by identity,
    # which is the right comparison anyway - two readers over the same bytes are
    # still two documents.
    readers: list[PdfReader] = []
    for item in pages:
        if not any(item.reader is known for known in readers):
            readers.append(item.reader)
    all_pages_kept = len(readers) == 1 and {item.index for item in pages} == set(
        range(len(readers[0].pages()))
    )

    page_refs: list[Reference] = []
    for item in pages:
        source_pages = item.reader.pages()
        if not 0 <= item.index < len(source_pages):
            msg = f"page {item.index + 1} does not exist in a source with {len(source_pages)} pages"
            raise ValueError(msg)

        original = _page_body(
            source_pages[item.index].dictionary, keep_private_data=keep_private_data
        )
        if not all_pages_kept:
            _strip_orphaned_widgets(original, item.reader)
        copied = copier.copy(item.reader, original)
        if not isinstance(copied, dict):
            msg = f"page {item.index + 1} did not copy as a dictionary"
            raise PdfSyntaxError(msg)

        # The new document owns the page now, so its parent is our tree.
        copied["Type"] = Name("Page")
        copied["Parent"] = tree
        # Inherited attributes were merged in by the reader; keeping /Kids would
        # make a leaf look like a branch.
        page_refs.append(writer.add(copied))

    writer.put(tree, {"Type": Name("Pages"), "Kids": page_refs, "Count": len(page_refs)})
    carried, _ = _carry_catalog(copier, readers, all_pages_kept=all_pages_kept)
    writer.put(catalog, {"Type": Name("Catalog"), "Pages": tree, **carried})

    info: dict[str, Any] = {"Producer": "Image & PDF Workspace"}
    if title:
        info["Title"] = title
    return writer.build(catalog, info)


# ------------------------------------------------------------------ verbs ----


def merge(readers: list[PdfReader], title: str = "", *, keep_private_data: bool = False) -> bytes:
    """Join documents end to end, losslessly."""
    pages: list[PageRef] = []
    for reader in readers:
        pages.extend(PageRef(reader, index) for index in range(len(reader.pages())))
    return _assemble(pages, title, keep_private_data=keep_private_data)


def select_pages(
    reader: PdfReader,
    indices: list[int],
    title: str = "",
    *,
    keep_private_data: bool = False,
) -> bytes:
    """Keep these pages, in this order. Splitting, extracting and deleting.

    One verb rather than three: "delete page 4" is "select everything except 4",
    and a single implementation cannot disagree with itself about what a page is.
    """
    return _assemble(
        [PageRef(reader, index) for index in indices],
        title,
        keep_private_data=keep_private_data,
    )


def reorder(
    reader: PdfReader,
    order: list[int],
    title: str = "",
    *,
    keep_private_data: bool = False,
) -> bytes:
    """Rebuild with pages in the given order.

    Every page must appear exactly once - this is a permutation, not a
    selection. Rejecting a list that drops a page is worth the strictness: a
    reorder that silently loses page 12 of a print run is discovered at the
    printer.
    """
    expected = set(range(len(reader.pages())))
    if set(order) != expected or len(order) != len(expected):
        missing = sorted(expected - set(order))
        msg = (
            f"a reorder must list every page exactly once; "
            f"{len(order)} given for {len(expected)} pages"
            + (f", missing {[m + 1 for m in missing]}" if missing else "")
        )
        raise ValueError(msg)
    return select_pages(reader, order, title, keep_private_data=keep_private_data)


def rotate_pages(
    reader: PdfReader,
    degrees: int,
    pages: list[int] | None = None,
    title: str = "",
    *,
    keep_private_data: bool = False,
) -> bytes:
    """Rotate pages by a multiple of 90 degrees.

    Rotation is a page attribute, not a transformation of the content, so this
    costs nothing and loses nothing - which is why a scanned document that came
    out sideways can be fixed without touching a pixel.
    """
    if degrees % 90:
        msg = f"rotation must be a multiple of 90 degrees, got {degrees}"
        raise ValueError(msg)

    total = len(reader.pages())
    chosen = set(range(total) if pages is None else pages)

    writer = PdfWriter()
    catalog = writer.reserve()
    tree = writer.reserve()
    copier = _GraphCopier(writer)

    refs: list[Reference] = []
    for index, page in enumerate(reader.pages()):
        body = _page_body(page.dictionary, keep_private_data=keep_private_data)
        copied = copier.copy(reader, body)
        if not isinstance(copied, dict):
            continue
        copied["Type"] = Name("Page")
        copied["Parent"] = tree
        if index in chosen:
            copied["Rotate"] = (page.rotation + degrees) % 360
        refs.append(writer.add(copied))

    writer.put(tree, {"Type": Name("Pages"), "Kids": refs, "Count": len(refs)})
    # Every page is present, so bookmarks and form fields come across intact.
    carried, _ = _carry_catalog(copier, [reader], all_pages_kept=True)
    writer.put(catalog, {"Type": Name("Catalog"), "Pages": tree, **carried})
    info: dict[str, Any] = {"Producer": "Image & PDF Workspace"}
    if title:
        info["Title"] = title
    return writer.build(catalog, info)


def overlay_on_pages(
    reader: PdfReader,
    content: bytes,
    pages: list[int] | None = None,
    title: str = "",
    *,
    keep_private_data: bool = False,
) -> bytes:
    """Draw over existing pages without disturbing what is already there.

    The new operators are appended as a *second* content stream, wrapped so the
    graphics state is saved first. PDF allows a page's ``/Contents`` to be an
    array of streams that are concatenated, so the original is never rewritten -
    which means a stamp, a page number or a watermark cannot corrupt artwork it
    does not understand.
    """
    total = len(reader.pages())
    chosen = set(range(total) if pages is None else pages)

    writer = PdfWriter()
    catalog = writer.reserve()
    tree = writer.reserve()
    copier = _GraphCopier(writer)

    refs: list[Reference] = []
    for index, page in enumerate(reader.pages()):
        body = _page_body(page.dictionary, keep_private_data=keep_private_data)
        copied = copier.copy(reader, body)
        if not isinstance(copied, dict):
            continue
        copied["Type"] = Name("Page")
        copied["Parent"] = tree

        if index in chosen:
            existing = copied.get("Contents")
            streams = existing if isinstance(existing, list) else ([existing] if existing else [])
            # 'q' before the original guarantees an unbalanced source stream
            # cannot leak its transform into the overlay.
            streams = [
                writer.add(Stream({}, b"q\n")),
                *streams,
                writer.add(Stream({}, b"Q\nq\n" + content + b"\nQ\n")),
            ]
            copied["Contents"] = streams

        refs.append(writer.add(copied))

    writer.put(tree, {"Type": Name("Pages"), "Kids": refs, "Count": len(refs)})
    # Every page is present, so bookmarks and form fields come across intact.
    carried, _ = _carry_catalog(copier, [reader], all_pages_kept=True)
    writer.put(catalog, {"Type": Name("Catalog"), "Pages": tree, **carried})
    info: dict[str, Any] = {"Producer": "Image & PDF Workspace"}
    if title:
        info["Title"] = title
    return writer.build(catalog, info)


# --------------------------------------------------------------- extraction --


def extract_images(reader: PdfReader, minimum_pixels: int = 10_000) -> list[ExtractedImage]:
    """Recover the images placed inside a PDF, in their original encoding.

    A JPEG comes out as the same bytes that went in, because ``DCTDecode`` is
    JPEG - so pulling artwork out of a supplied PDF costs nothing. Anything
    stored raw is re-packed as PNG, which is lossless.

    ``minimum_pixels`` skips the icons, rules and spacer images that litter a
    designed document; a customer asking to extract artwork does not want two
    hundred 8x8 fragments.
    """
    found: list[ExtractedImage] = []
    seen: set[int] = set()

    for page in reader.pages():
        resources = reader.resolve(page.dictionary.get("Resources"))
        if not isinstance(resources, dict):
            continue
        xobjects = reader.resolve(resources.get("XObject"))
        if not isinstance(xobjects, dict):
            continue

        for entry in xobjects.values():
            if isinstance(entry, Reference):
                if entry.number in seen:
                    continue
                seen.add(entry.number)
            stream = reader.resolve(entry)
            if not isinstance(stream, RawStream):
                continue

            dictionary = stream.dictionary
            subtype = dictionary.get("Subtype")
            if not (isinstance(subtype, Name) and subtype.value == "Image"):
                continue

            width = int(reader.resolve(dictionary.get("Width")) or 0)
            height = int(reader.resolve(dictionary.get("Height")) or 0)
            if width * height < minimum_pixels:
                continue

            filters = _filters_of(dictionary)
            if filters and filters[-1] == "DCTDecode":
                found.append(ExtractedImage(stream.data, width, height, "jpg", page.number, False))
                continue
            if filters and filters[-1] in IMAGE_FILTERS:
                # JPX, JBIG2 and CCITT need decoders this package does not carry.
                # Skipping is better than emitting a file that will not open.
                continue

            rebuilt = _to_png(reader, stream, width, height)
            if rebuilt is not None:
                found.append(ExtractedImage(rebuilt, width, height, "png", page.number, True))

    return found


def _to_png(reader: PdfReader, stream: RawStream, width: int, height: int) -> bytes | None:
    """Re-pack raw sample data as PNG. Lossless; the pixels are unchanged."""
    import io

    try:
        payload = stream.decoded()
    except PdfSyntaxError:
        return None

    dictionary = stream.dictionary
    bits = int(reader.resolve(dictionary.get("BitsPerComponent")) or 8)
    space = reader.resolve(dictionary.get("ColorSpace"))
    space_name = space.value if isinstance(space, Name) else None
    mode = {"DeviceRGB": "RGB", "DeviceGray": "L", "DeviceCMYK": "CMYK"}.get(space_name or "")
    if mode is None or bits != 8:
        return None

    expected = width * height * len(mode)
    if len(payload) < expected:
        return None

    from PIL import Image

    image = Image.frombytes(mode, (width, height), payload[:expected])
    if mode == "CMYK":
        image = image.convert("RGB")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


# ------------------------------------------------------------ capabilities --


def capabilities(reader: PdfReader) -> dict[str, Any]:
    """What can honestly be done to this particular file.

    Reported before a customer tries, so the boundary of "editable" is something
    they are told rather than something they discover.
    """
    pages = reader.pages()
    images = extract_images(reader)
    has_text = False
    for page in pages[:8]:
        resources = reader.resolve(page.dictionary.get("Resources"))
        if isinstance(resources, dict) and reader.resolve(resources.get("Font")):
            has_text = True
            break

    return {
        "page_count": len(pages),
        "supported": {
            "merge": True,
            "split": True,
            "reorder": True,
            "rotate": True,
            "delete_pages": True,
            "add_content_over_pages": True,
            "extract_images": bool(images),
        },
        "not_supported": {
            "edit_existing_text": (
                "Text already in a PDF is positioned glyph by glyph and often uses a "
                "font embedded in the file. Rewriting it needs the original document, "
                "not the PDF."
            ),
            "edit_existing_vector_artwork": (
                "Vector artwork can be moved as a whole page but not reshaped. Ask the "
                "designer for the source file to change the drawing itself."
            ),
            "render_page_preview": (
                "Showing a page as a picture needs a full PDF renderer, which this does "
                "not include yet. Page sizes, counts and embedded images are read "
                "directly instead."
            ),
        },
        "extractable_images": len(images),
        "has_text": has_text,
    }
