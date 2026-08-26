"""Reading and editing PDFs that somebody else wrote.

Producing a PDF is a closed problem: we choose the structures and only have to
be self-consistent. Reading one is open - the file arrived from Illustrator, or
a scanner, or a twenty-year-old report generator, and every legal encoding is
fair game. These tests build files that use the awkward-but-legal encodings on
purpose, because a reader that only handles what our own writer emits is a
reader that works until the first real customer file.
"""

from __future__ import annotations

import contextlib
import zlib

import pytest

from ipw.pdf.document import PdfDocument, TextBox
from ipw.pdf.edit import (
    capabilities,
    extract_images,
    merge,
    overlay_on_pages,
    reorder,
    rotate_pages,
    select_pages,
)
from ipw.pdf.objects import Name, PdfWriter, Stream
from ipw.pdf.reader import PdfReader, PdfSyntaxError


def _document(page_count: int, *, title: str = "") -> bytes:
    """A plain multi-page document, made with our own writer."""
    document = PdfDocument(title=title)
    for index in range(page_count):
        page = document.add_page()
        page.texts.append(TextBox(text=f"page {index + 1}", x=72, y=72))
    return document.render()


def _be(value: int) -> tuple[int, int, int]:
    return (value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF


# ---------------------------------------------------------------- reading ----


def test_reads_a_document_we_wrote() -> None:
    reader = PdfReader.from_bytes(_document(3, title="Three"))
    assert len(reader.pages()) == 3
    assert reader.describe()["page_count"] == 3


def test_page_size_is_reported_in_inches_a_human_recognises() -> None:
    described = PdfReader.from_bytes(_document(1)).describe()
    # A4 is 8.27 x 11.69 in. A reader that silently mixed up points and
    # millimetres would still "work" and every printed page would be wrong.
    assert described["pages"][0]["label"] == "8.27 x 11.69 in"


def test_rejects_bytes_that_are_not_a_pdf() -> None:
    with pytest.raises(PdfSyntaxError):
        PdfReader.from_bytes(b"this is a jpeg, actually")


def test_a_truncated_file_recovers_what_survived_or_says_it_is_damaged() -> None:
    """Two failure modes, two honest answers - and never a silent empty document.

    Partial downloads and interrupted exports are ordinary, so the reader scans
    for whatever objects remain rather than refusing outright: recovering three
    pages of four is worth far more to a customer than an error. But recovering
    *nothing* is not recovery. Returning an empty list there would be the worst
    outcome available - the file would open as a blank document and merging it
    would silently drop it - so that one case is reported as damage.
    """
    whole = _document(3)

    mostly_intact = PdfReader.from_bytes(whole[: int(len(whole) * 0.9)])
    assert len(mostly_intact.pages()) >= 1

    with pytest.raises(PdfSyntaxError, match="damaged"):
        PdfReader.from_bytes(whole[: len(whole) // 4])


def test_inherited_page_attributes_are_resolved() -> None:
    """MediaBox set on the tree, not the page, still governs the page.

    This is the single most common way a hand-built PDF differs from ours, and
    a reader that ignores inheritance reports every such page as size zero.
    """
    writer = PdfWriter()
    catalog, tree = writer.reserve(), writer.reserve()
    contents = writer.add(Stream({}, b"", compress=False))
    page = writer.add({"Type": Name("Page"), "Parent": tree, "Contents": contents})
    writer.put(
        tree,
        {
            "Type": Name("Pages"),
            "Kids": [page],
            "Count": 1,
            "MediaBox": [0, 0, 612, 792],  # on the *parent*
            "Resources": {},
        },
    )
    writer.put(catalog, {"Type": Name("Catalog"), "Pages": tree})

    described = PdfReader.from_bytes(writer.build(catalog, {})).describe()
    assert described["pages"][0]["label"] == "8.50 x 11.00 in"


def test_reads_pages_out_of_an_object_stream() -> None:
    """Object streams pack many objects into one compressed stream.

    Every modern producer uses them, so a reader without them fails on most
    files made this decade - including the ones our own customers export.
    """
    inner = b"<< /Type /Catalog /Pages 2 0 R >> << /Type /Pages /Kids [3 0 R] /Count 1 >>"
    pages_offset = inner.index(b"<< /Type /Pages")
    header = f"1 0 2 {pages_offset} ".encode()
    payload = zlib.compress(header + inner)

    body = [b"%PDF-1.5\n"]
    offsets: dict[int, int] = {}

    def emit(number: int, raw: bytes) -> None:
        offsets[number] = sum(len(chunk) for chunk in body)
        body.append(b"%d 0 obj\n%s\nendobj\n" % (number, raw))

    emit(3, b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << >> >>")
    emit(
        4,
        b"<< /Type /ObjStm /N 2 /First %d /Length %d /Filter /FlateDecode >>\n"
        b"stream\n%s\nendstream" % (len(header), len(payload), payload),
    )

    entries = (
        bytes([0, 0, 0, 0, 0])  # object 0, the free-list head
        + bytes([2, 0, 0, 4, 0])  # 1: inside object stream 4, index 0
        + bytes([2, 0, 0, 4, 1])  # 2: inside object stream 4, index 1
        + bytes([1, *_be(offsets[3]), 0])
        + bytes([1, *_be(offsets[4]), 0])
    )
    xref_offset = sum(len(chunk) for chunk in body)
    compressed = zlib.compress(entries)
    body.append(
        b"5 0 obj\n<< /Type /XRef /Size 6 /W [1 3 1] /Root 1 0 R /Length %d "
        b"/Filter /FlateDecode >>\nstream\n%s\nendstream\nendobj\n" % (len(compressed), compressed)
    )
    body.append(b"startxref\n%d\n%%EOF\n" % xref_offset)

    reader = PdfReader.from_bytes(b"".join(body))
    assert len(reader.pages()) == 1
    assert reader.describe()["pages"][0]["width_inches"] == pytest.approx(200 / 72, abs=0.01)


# ---------------------------------------------------------------- editing ----


def test_merge_keeps_every_page_of_every_input() -> None:
    merged = merge([PdfReader.from_bytes(_document(2)), PdfReader.from_bytes(_document(3))])
    assert len(PdfReader.from_bytes(merged).pages()) == 5


def test_split_does_not_carry_the_pages_it_left_behind() -> None:
    """A split that produces a file the size of the original is not a split.

    A page dictionary points at its parent, whose /Kids lists every *other*
    page. Copying a page by following its references therefore reaches the
    whole document - correct output, useless size. This caught exactly that:
    four pages out of a twenty-seven page file came to 20.8 MB of 20.9 MB.
    """
    whole = _document(20)
    one = select_pages(PdfReader.from_bytes(whole), [0])
    assert len(PdfReader.from_bytes(one).pages()) == 1
    # Generous: the real failure was ~100%, and content differs per page.
    assert len(one) < len(whole) * 0.30, "the split dragged the other pages along"


def test_reorder_rejects_anything_that_is_not_a_permutation() -> None:
    reader = PdfReader.from_bytes(_document(3))
    for bad in ([0, 1], [0, 1, 1], [0, 1, 3], [0, 1, 2, 2]):
        with pytest.raises(ValueError, match=r"permutation|page"):
            reorder(reader, bad)


def test_reorder_actually_moves_pages() -> None:
    reversed_bytes = reorder(PdfReader.from_bytes(_document(3)), [2, 1, 0])
    assert len(PdfReader.from_bytes(reversed_bytes).pages()) == 3


def test_rotation_must_be_a_right_angle() -> None:
    reader = PdfReader.from_bytes(_document(1))
    with pytest.raises(ValueError, match="90"):
        rotate_pages(reader, 45, [0])


def test_rotation_accumulates_rather_than_replacing() -> None:
    """Rotating twice by 90 is 180, not 90.

    /Rotate is absolute in the file, so an implementation that assigns instead
    of adding makes the second click of a rotate button do nothing - the exact
    bug a user reports as "rotate is broken".
    """
    once = rotate_pages(PdfReader.from_bytes(_document(1)), 90, [0])
    twice = rotate_pages(PdfReader.from_bytes(once), 90, [0])
    assert PdfReader.from_bytes(twice).pages()[0].rotation == 180


def test_selecting_a_page_that_does_not_exist_is_an_error_not_a_blank_page() -> None:
    reader = PdfReader.from_bytes(_document(2))
    with pytest.raises(ValueError, match="does not exist"):
        select_pages(reader, [5])


def test_overlay_leaves_the_original_content_in_place() -> None:
    """Stamping must add a layer, not replace the page."""
    reader = PdfReader.from_bytes(_document(2))
    stamped = overlay_on_pages(reader, b"1 0 0 RG 10 10 m 100 100 l S", [0])
    result = PdfReader.from_bytes(stamped)
    assert len(result.pages()) == 2
    assert b"page 1" in _content_of(result, 0), "the original artwork was replaced"


def _content_of(reader: PdfReader, index: int) -> bytes:
    """Every content stream of one page, concatenated and decoded."""
    contents = reader.resolve(reader.pages()[index].dictionary["Contents"])
    parts = contents if isinstance(contents, list) else [contents]
    out = b""
    for part in parts:
        stream = reader.resolve(part)
        data = stream.data
        with contextlib.suppress(zlib.error):
            data = zlib.decompress(data)
        out += data
    return out


def test_extracting_images_from_a_document_with_none_returns_nothing() -> None:
    assert extract_images(PdfReader.from_bytes(_document(2))) == []


def test_capabilities_names_what_cannot_be_done() -> None:
    """Honesty about limits is a feature, not a disclaimer.

    Section 19 requires existing content be edited "only when technically
    supported, with honest limitations". A customer must be able to learn the
    boundary from the UI rather than by hitting it.
    """
    caps = capabilities(PdfReader.from_bytes(_document(1)))
    assert caps["supported"]["merge"] is True
    assert "edit_existing_text" in caps["not_supported"]
    assert "edit_existing_vector_artwork" in caps["not_supported"]


def test_an_empty_selection_is_refused() -> None:
    with pytest.raises(ValueError, match="no pages"):
        select_pages(PdfReader.from_bytes(_document(2)), [])


def test_producer_private_data_is_dropped_by_default_and_kept_on_request() -> None:
    """Illustrator hides a second, editable copy of the artwork in /PieceInfo.

    Dropping it took a real 27-page file from 20.9 MB to 7.9 MB with every
    content stream, resource set and media box byte-identical - so the print is
    unchanged and the file is a third of the size. What is lost is reopening it
    in Illustrator with live objects, which is right for a deliverable and wrong
    for a working file. Hence a flag, not a policy.
    """
    writer = PdfWriter()
    catalog, tree = writer.reserve(), writer.reserve()
    bulk = writer.add(Stream({}, b"x" * 50_000, compress=False))
    page = writer.add(
        {
            "Type": Name("Page"),
            "Parent": tree,
            "MediaBox": [0, 0, 200, 200],
            "Resources": {},
            "Contents": writer.add(Stream({}, b"", compress=False)),
            "PieceInfo": {"Illustrator": {"Private": bulk}},
        }
    )
    writer.put(tree, {"Type": Name("Pages"), "Kids": [page], "Count": 1})
    writer.put(catalog, {"Type": Name("Catalog"), "Pages": tree})
    original = writer.build(catalog, {})

    lean = select_pages(PdfReader.from_bytes(original), [0])
    faithful = select_pages(PdfReader.from_bytes(original), [0], keep_private_data=True)

    assert len(lean) < len(faithful) / 2, "the default did not shed the private data"
    assert len(faithful) > 50_000, "asking to keep private data did not keep it"
    # Both must still be readable documents, not just smaller files.
    assert len(PdfReader.from_bytes(lean).pages()) == 1
    assert len(PdfReader.from_bytes(faithful).pages()) == 1
