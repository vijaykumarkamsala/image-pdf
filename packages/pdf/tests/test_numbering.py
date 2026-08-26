"""Page and Bates numbering, and the one property that makes it useful.

Stamping puts the same words on every page. Numbering puts a different mark on
each, and carries the count from one document into the next. That last part is
the whole feature: a disclosure bundle is sixty files that a court refers to as
one thing, and if each file restarts at one there are sixty page 412s and a
citation means nothing.
"""

from __future__ import annotations

import pytest

from ipw.pdf.content import extract_text, find_text
from ipw.pdf.document import PdfDocument, TextBox
from ipw.pdf.numbering import POSITIONS, Numbering, number_pages
from ipw.pdf.reader import PdfReader


def a_document(pages: int = 3, title: str = "Doc") -> bytes:
    document = PdfDocument()
    for index in range(pages):
        page = document.add_page()
        page.texts.append(TextBox(text=f"{title} content page {index + 1}", x=72, y=700))
    return document.render()


def text_on(data: bytes, page: int = 0) -> list[str]:
    reader = PdfReader.from_bytes(data)
    return [run.text for run in extract_text(reader, reader.pages()[page].dictionary)]


class TestOneDocument:
    def test_every_page_gets_its_own_number(self) -> None:
        _, report = number_pages(PdfReader.from_bytes(a_document(4)), Numbering(prefix="ABC-"))
        assert report["pages_numbered"] == 4
        assert report["first"] == "ABC-000001"
        assert report["last"] == "ABC-000004"

    def test_the_numbers_are_really_on_the_pages(self) -> None:
        data, _ = number_pages(PdfReader.from_bytes(a_document(3)), Numbering(prefix="ABC-"))
        reader = PdfReader.from_bytes(data)
        for index, expected in enumerate(["ABC-000001", "ABC-000002", "ABC-000003"]):
            assert find_text(reader, reader.pages()[index].dictionary, expected), (
                f"page {index + 1} does not carry {expected}"
            )

    def test_the_existing_content_survives(self) -> None:
        """A number that overwrote the page would be a spectacular way to ruin a bundle."""
        data, _ = number_pages(PdfReader.from_bytes(a_document(2, "Claim")))
        assert "Claim content page 1" in text_on(data)

    def test_a_plain_page_number_needs_no_prefix(self) -> None:
        _, report = number_pages(PdfReader.from_bytes(a_document(2)), Numbering(digits=0))
        assert report["first"] == "1"

    def test_padding_makes_a_bundle_sort_as_text(self) -> None:
        """A bare number sorts 1, 10, 11, 2 - which is why six digits is the convention."""
        _, report = number_pages(
            PdfReader.from_bytes(a_document(2)), Numbering(prefix="X", digits=6)
        )
        assert report["first"] == "X000001"

    def test_it_can_start_anywhere(self) -> None:
        _, report = number_pages(PdfReader.from_bytes(a_document(3)), Numbering(start=500))
        assert report["first"] == "000500"
        assert report["last"] == "000502"

    @pytest.mark.parametrize("position", sorted(POSITIONS))
    def test_every_position_produces_a_readable_mark(self, position: str) -> None:
        data, _ = number_pages(
            PdfReader.from_bytes(a_document(1)), Numbering(prefix="P-", position=position)
        )
        reader = PdfReader.from_bytes(data)
        assert find_text(reader, reader.pages()[0].dictionary, "P-000001")

    def test_the_mark_sits_inside_the_page(self) -> None:
        """A number placed off the sheet is worse than none: it prints as nothing
        and a reader assumes the bundle was never numbered."""
        data, _ = number_pages(
            PdfReader.from_bytes(a_document(1)), Numbering(prefix="ABC-", position="bottom-right")
        )
        reader = PdfReader.from_bytes(data)
        page = reader.describe()["pages"][0]
        width = page["width_inches"] * 72
        height = page["height_inches"] * 72

        left, bottom, right, top = find_text(reader, reader.pages()[0].dictionary, "ABC-000001")[0]
        assert 0 <= left < right <= width
        assert 0 <= bottom < top <= height

    def test_an_unknown_position_is_refused_with_the_options(self) -> None:
        with pytest.raises(ValueError, match="bottom-right"):
            number_pages(PdfReader.from_bytes(a_document(1)), Numbering(position="middle-ish"))

    def test_a_negative_start_is_refused(self) -> None:
        with pytest.raises(ValueError, match="below zero"):
            number_pages(PdfReader.from_bytes(a_document(1)), Numbering(start=-5))


class TestAcrossABundle:
    """The count crossing documents is the entire point of the feature."""

    def test_the_count_continues_into_the_next_document(self) -> None:
        _, report_one = number_pages(
            PdfReader.from_bytes(a_document(4)), Numbering(prefix="ABC-", start=1)
        )
        assert report_one["last"] == "ABC-000004"

        _, report_two = number_pages(
            PdfReader.from_bytes(a_document(3)),
            Numbering(prefix="ABC-", start=report_one["next_number"]),
        )
        assert report_two["first"] == "ABC-000005"
        assert report_two["last"] == "ABC-000007"

    def test_next_number_is_one_past_the_last_used(self) -> None:
        """Off by one here silently duplicates or skips a reference in a bundle."""
        _, report = number_pages(PdfReader.from_bytes(a_document(5)), Numbering(start=10))
        assert report["last"] == "000014"
        assert report["next_number"] == 15

    def test_a_three_file_bundle_runs_unbroken(self) -> None:
        number = 1
        seen: list[tuple[str, str]] = []
        for pages in (4, 3, 5):
            _, report = number_pages(
                PdfReader.from_bytes(a_document(pages)), Numbering(prefix="ABC-", start=number)
            )
            seen.append((report["first"], report["last"]))
            number = report["next_number"]

        assert seen == [
            ("ABC-000001", "ABC-000004"),
            ("ABC-000005", "ABC-000007"),
            ("ABC-000008", "ABC-000012"),
        ]

    def test_the_note_says_where_the_next_document_picks_up(self) -> None:
        _, report = number_pages(PdfReader.from_bytes(a_document(3)), Numbering(prefix="ABC-"))
        assert "continues at ABC-000004" in report["note"]


class TestMixedPageSizes:
    def test_each_page_is_marked_from_its_own_edge(self) -> None:
        """A bundle holds a scan, a plan and a letter. Positioning from an
        assumed A4 would put the mark off two of them."""
        from ipw.pdf.document import PageSize

        document = PdfDocument()
        for size in (PageSize("a4", 595, 842), PageSize("wide", 1200, 400)):
            page = document.add_page(size=size)
            page.texts.append(TextBox(text="content", x=72, y=100))

        data, _ = number_pages(PdfReader.from_bytes(document.render()), Numbering(prefix="M-"))
        reader = PdfReader.from_bytes(data)

        for index in range(2):
            described = reader.describe()["pages"][index]
            width = described["width_inches"] * 72
            found = find_text(reader, reader.pages()[index].dictionary, f"M-00000{index + 1}")
            assert found, f"page {index + 1} was not marked"
            # Bottom-right: the mark's right edge sits near this page's own right edge.
            assert width - found[0][2] < 40, "the mark was placed from the wrong page width"
