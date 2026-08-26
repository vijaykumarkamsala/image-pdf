"""What must survive an edit, and what must honestly not.

A page operation builds a new document, and the obvious way to do that - a fresh
catalogue holding only /Pages - silently destroys everything else the catalogue
held. Bookmarks, form definitions, layers and the document language all live
there. The resulting file opens perfectly and is missing things nobody checks
until they need them, which is the worst kind of defect: invisible on the way
out, discovered by the customer.

The other half of this is knowing what *must* be dropped. A bookmark pointing at
a page that was just removed is a dead link; an /AcroForm listing fields whose
widgets are gone is a form that cannot be filled in. Carrying those would be
worse than losing them, so the rule is: page-dependent entries survive only when
every page does.
"""

from __future__ import annotations

from collections.abc import Callable

import pytest

from ipw.pdf.edit import merge, reorder, rotate_pages, select_pages
from ipw.pdf.objects import Name, PdfWriter, Stream
from ipw.pdf.reader import PdfReader


def _rich_document(pages: int = 3) -> bytes:
    """A document with the catalogue entries real files carry."""
    writer = PdfWriter()
    catalog, tree = writer.reserve(), writer.reserve()

    kids = []
    fields = []
    for index in range(pages):
        contents = writer.add(Stream({}, b"BT ET"))
        widget = writer.add(
            {
                "Type": Name("Annot"),
                "Subtype": Name("Widget"),
                "FT": Name("Tx"),
                "T": f"field{index}",
                "Rect": [10, 10, 200, 40],
            }
        )
        note = writer.add(
            {
                "Type": Name("Annot"),
                "Subtype": Name("Text"),
                "Contents": "a sticky note",
                "Rect": [10, 50, 30, 70],
            }
        )
        fields.append(widget)
        kids.append(
            writer.add(
                {
                    "Type": Name("Page"),
                    "Parent": tree,
                    "MediaBox": [0, 0, 300, 300],
                    "Resources": {},
                    "Contents": contents,
                    "Annots": [widget, note],
                }
            )
        )

    writer.put(tree, {"Type": Name("Pages"), "Kids": kids, "Count": len(kids)})
    outlines = writer.add({"Type": Name("Outlines"), "Count": 0})
    writer.put(
        catalog,
        {
            "Type": Name("Catalog"),
            "Pages": tree,
            "Lang": "en-GB",
            "Outlines": outlines,
            "AcroForm": {"Fields": fields},
            "OCProperties": {"OCGs": [], "D": {"Order": []}},
            "PageMode": Name("UseOutlines"),
            "Metadata": writer.add(Stream({"Type": Name("Metadata")}, b"<x:xmpmeta/>")),
        },
    )
    return writer.build(catalog, {"Title": "Original"})


def _catalog_of(data: bytes) -> dict[str, object]:
    return PdfReader.from_bytes(data).catalog


class TestSurvivesEveryOperation:
    """Entries that name no particular page survive any page operation."""

    @pytest.mark.parametrize("key", ["Lang", "OCProperties", "PageMode"])
    @pytest.mark.parametrize(
        "operation",
        [
            lambda r: select_pages(r, [0]),
            lambda r: reorder(r, [2, 1, 0]),
            lambda r: rotate_pages(r, 90, [0]),
        ],
    )
    def test_page_independent_entries_are_carried(
        self, key: str, operation: Callable[[PdfReader], bytes]
    ) -> None:
        result = operation(PdfReader.from_bytes(_rich_document(3)))
        assert key in _catalog_of(result), f"{key} was silently dropped"

    def test_the_document_language_is_preserved_exactly(self) -> None:
        """Screen readers need it, and it is one string. Losing it is careless."""
        result = select_pages(PdfReader.from_bytes(_rich_document(2)), [0])
        assert _catalog_of(result)["Lang"] == "en-GB"


class TestSurvivesWhenEveryPageDoes:
    """Bookmarks and forms point at pages, so they need every page present."""

    @pytest.mark.parametrize("key", ["Outlines", "AcroForm"])
    def test_carried_through_a_reorder(self, key: str) -> None:
        """A reorder keeps every page, so nothing a bookmark points at is gone.

        Bookmarks reference page *objects*, which are copied, so they follow
        their page to its new position rather than pointing at a position.
        """
        result = reorder(PdfReader.from_bytes(_rich_document(3)), [2, 0, 1])
        assert key in _catalog_of(result), f"{key} was lost by a reorder"

    @pytest.mark.parametrize("key", ["Outlines", "AcroForm"])
    def test_carried_through_a_rotate(self, key: str) -> None:
        result = rotate_pages(PdfReader.from_bytes(_rich_document(3)), 90, [1])
        assert key in _catalog_of(result), f"{key} was lost by a rotate"

    @pytest.mark.parametrize("key", ["Outlines", "AcroForm"])
    def test_dropped_by_a_split_rather_than_left_dangling(self, key: str) -> None:
        """A bookmark to a removed page is a dead link.

        Carrying it would produce a document that looks complete and misbehaves,
        which is worse than one that is honestly smaller.
        """
        result = select_pages(PdfReader.from_bytes(_rich_document(3)), [0])
        assert key not in _catalog_of(result)


class TestOrphanedWidgets:
    def test_a_split_removes_form_widgets_along_with_the_form(self) -> None:
        """A widget without its /AcroForm draws as a box nobody can type into.

        Leaving it is the worst outcome: the page looks like it has a working
        field, and the customer finds out otherwise while filling it in.
        """
        result = select_pages(PdfReader.from_bytes(_rich_document(3)), [0])
        reader = PdfReader.from_bytes(result)
        annots = reader.resolve(reader.pages()[0].dictionary.get("Annots")) or []
        subtypes = {
            reader.resolve(a).get("Subtype").value
            for a in annots
            if isinstance(reader.resolve(a), dict)
        }
        assert "Widget" not in subtypes, "an orphaned form widget was left behind"

    def test_other_annotations_are_kept(self) -> None:
        """A sticky note does not depend on the form and must not be collateral."""
        result = select_pages(PdfReader.from_bytes(_rich_document(3)), [0])
        reader = PdfReader.from_bytes(result)
        annots = reader.resolve(reader.pages()[0].dictionary.get("Annots")) or []
        subtypes = {
            reader.resolve(a).get("Subtype").value
            for a in annots
            if isinstance(reader.resolve(a), dict)
        }
        assert "Text" in subtypes, "a comment was removed along with the form fields"

    def test_a_reorder_keeps_the_widgets_because_it_keeps_the_form(self) -> None:
        result = reorder(PdfReader.from_bytes(_rich_document(2)), [1, 0])
        reader = PdfReader.from_bytes(result)
        annots = reader.resolve(reader.pages()[0].dictionary.get("Annots")) or []
        subtypes = {
            reader.resolve(a).get("Subtype").value
            for a in annots
            if isinstance(reader.resolve(a), dict)
        }
        assert "Widget" in subtypes


class TestNeverCarried:
    def test_the_originals_metadata_is_not_copied_onto_a_new_document(self) -> None:
        """XMP describes the original: its title, producer and creation date.

        Copying it onto a document with different pages would be a confident,
        machine-readable claim that is no longer true.
        """
        result = select_pages(PdfReader.from_bytes(_rich_document(3)), [0])
        assert "Metadata" not in _catalog_of(result)


class TestMerge:
    def test_merging_two_documents_does_not_pick_one_set_of_bookmarks(self) -> None:
        """Two outline trees cannot be carried by choosing one and discarding
        the other, so a merge carries neither rather than silently losing half.
        """
        merged = merge(
            [PdfReader.from_bytes(_rich_document(2)), PdfReader.from_bytes(_rich_document(2))]
        )
        catalog = _catalog_of(merged)
        assert "Outlines" not in catalog
        assert len(PdfReader.from_bytes(merged).pages()) == 4
