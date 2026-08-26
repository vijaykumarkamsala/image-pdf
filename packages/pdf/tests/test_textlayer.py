"""Making a scan searchable, and the geometry that decides whether it is useful.

No recogniser is involved here. The words are written by hand, because the part
worth testing is not whether an engine can read a page - every engine can - but
whether the invisible text lands on the ink. If it does not, selection
highlights the wrong span, search scrolls to the wrong place, and a redaction
driven by a phrase blacks out the pixels next to the name.

The final test is the point of the whole feature: a name typed into a search box
gets removed from a scanned page, verified against the bytes.
"""

from __future__ import annotations

import io

import pytest
from PIL import Image, ImageDraw

from ipw.pdf.content import extract_text, find_text
from ipw.pdf.document import PdfDocument, TextBox
from ipw.pdf.objects import Name, PdfWriter, Stream
from ipw.pdf.reader import PdfReader
from ipw.pdf.redact import redact_phrases, verify
from ipw.pdf.textlayer import INVISIBLE, Word, add_text_layer, coverage

# The scan is 1240x1754 pixels placed on a 595x842 point page.
PIXELS = (1240, 1754)
POINTS = (595.0, 842.0)


def to_points(x0: float, y0: float, x1: float, y1: float) -> tuple[float, float, float, float]:
    """Image pixels (y down) to PDF points (y up), as an engine's output would be."""
    return (
        x0 / PIXELS[0] * POINTS[0],
        POINTS[1] - (y1 / PIXELS[1] * POINTS[1]),
        x1 / PIXELS[0] * POINTS[0],
        POINTS[1] - (y0 / PIXELS[1] * POINTS[1]),
    )


INK = {
    "Claimant": (120, 180, 340, 230),
    "Jane": (360, 180, 500, 230),
    "Doe": (520, 180, 700, 230),
    "Reference": (120, 300, 340, 350),
    "ACC-4929-8812": (360, 300, 900, 350),
}


def a_scan() -> bytes:
    """A page whose words exist only as pixels."""
    picture = Image.new("RGB", PIXELS, (252, 250, 246))
    draw = ImageDraw.Draw(picture)
    for box in INK.values():
        draw.rectangle(list(box), fill=(25, 25, 35))

    writer = PdfWriter()
    catalog, tree = writer.reserve(), writer.reserve()
    buffer = io.BytesIO()
    picture.save(buffer, format="JPEG", quality=88)
    image = writer.add(
        Stream(
            {
                "Type": Name("XObject"),
                "Subtype": Name("Image"),
                "Width": PIXELS[0],
                "Height": PIXELS[1],
                "ColorSpace": Name("DeviceRGB"),
                "BitsPerComponent": 8,
            },
            buffer.getvalue(),
            compress=False,
            filters=("DCTDecode",),
        )
    )
    contents = writer.add(Stream({}, b"q 595 0 0 842 0 0 cm /Im0 Do Q"))
    page = writer.add(
        {
            "Type": Name("Page"),
            "Parent": tree,
            "MediaBox": [0, 0, 595, 842],
            "Resources": {"XObject": {"Im0": image}},
            "Contents": contents,
        }
    )
    writer.put(tree, {"Type": Name("Pages"), "Kids": [page], "Count": 1})
    writer.put(catalog, {"Type": Name("Catalog"), "Pages": tree})
    return writer.build(catalog, {})


def recognised() -> list[Word]:
    """What an engine would hand back for that page."""
    return [Word(text, *to_points(*box)) for text, box in INK.items()]


def searchable() -> bytes:
    data, _ = add_text_layer(PdfReader.from_bytes(a_scan()), {1: recognised()})
    return data


class TestCoverage:
    def test_a_scan_is_identified_as_needing_recognition(self) -> None:
        report = coverage(PdfReader.from_bytes(a_scan()))
        assert report["pages_with_text"] == []
        assert report["pages_needing_ocr"] == [1]
        assert report["fully_searchable"] is False

    def test_a_document_that_already_has_text_is_left_alone(self) -> None:
        """Recognising a page that already has real text would be slower *and*
        less accurate than the text that is already there."""
        document = PdfDocument()
        page = document.add_page()
        page.texts.append(TextBox(text="Already real text on this page", x=72, y=700))
        report = coverage(PdfReader.from_bytes(document.render()))
        assert report["fully_searchable"] is True
        assert "needs no recognition" in report["note"]

    def test_a_mixed_bundle_names_the_dangerous_half(self) -> None:
        """A search over a mixed bundle silently misses the scanned pages."""
        report = coverage(PdfReader.from_bytes(searchable()))
        assert report["fully_searchable"] is True


class TestTheLayerIsInvisible:
    def test_the_text_is_written_in_invisible_render_mode(self) -> None:
        """Anything else would print the recognised words over the scan."""
        from ipw.pdf.content import page_content

        reader = PdfReader.from_bytes(searchable())
        stream = page_content(reader, reader.pages()[0].dictionary).decode("latin-1")
        assert f"{INVISIBLE} Tr" in stream

    def test_the_original_content_is_kept(self) -> None:
        """The scan *is* the page. A layer that replaced it would be a disaster."""
        from ipw.pdf.edit import extract_images

        images = extract_images(PdfReader.from_bytes(searchable()))
        assert len(images) == 1
        assert (images[0].width, images[0].height) == PIXELS

    def test_the_page_size_is_unchanged(self) -> None:
        described = PdfReader.from_bytes(searchable()).describe()
        assert described["pages"][0]["width_inches"] == pytest.approx(595 / 72, abs=0.01)


class TestGeometry:
    """Where the invisible words sit. The whole feature turns on this."""

    @pytest.mark.parametrize("word", ["Claimant", "Jane", "Doe", "ACC-4929-8812"])
    def test_each_word_lands_on_its_ink(self, word: str) -> None:
        reader = PdfReader.from_bytes(searchable())
        expected = to_points(*INK[word])
        found = find_text(reader, reader.pages()[0].dictionary, word)
        assert len(found) == 1, f"{word!r} was not found once"

        left, _, right, _ = found[0]
        assert left == pytest.approx(expected[0], abs=0.5)
        assert right == pytest.approx(expected[2], abs=0.5)

    def test_the_words_come_back_in_reading_order(self) -> None:
        reader = PdfReader.from_bytes(searchable())
        runs = [run.text for run in extract_text(reader, reader.pages()[0].dictionary)]
        assert runs == list(INK)


class TestPhrasesAcrossWords:
    """The failure that made this feature useless until it was found.

    A text layer writes one operator per recognised word, with no space
    characters anywhere - the gaps are positioning. Matching on encoded
    characters alone turns "Claimant Jane Doe" into "ClaimantJaneDoe", so
    searching for someone's full name finds nothing, on exactly the documents
    where finding it matters most. Word breaks are inferred from position.
    """

    @pytest.mark.parametrize("phrase", ["Jane Doe", "Claimant Jane Doe", "Reference ACC-4929-8812"])
    def test_a_phrase_spanning_words_is_found(self, phrase: str) -> None:
        reader = PdfReader.from_bytes(searchable())
        assert len(find_text(reader, reader.pages()[0].dictionary, phrase)) == 1

    def test_a_phrase_spanning_a_line_break_is_found(self) -> None:
        reader = PdfReader.from_bytes(searchable())
        assert find_text(reader, reader.pages()[0].dictionary, "Doe Reference")

    def test_words_are_not_run_together(self) -> None:
        """The bug in the other direction: a search must not match across a gap
        that a reader would see as a space."""
        reader = PdfReader.from_bytes(searchable())
        assert find_text(reader, reader.pages()[0].dictionary, "ClaimantJane") == []

    def test_a_phrase_that_is_not_there_is_not_found(self) -> None:
        reader = PdfReader.from_bytes(searchable())
        assert find_text(reader, reader.pages()[0].dictionary, "Smith") == []


class TestTheWholePoint:
    def test_a_name_can_be_redacted_from_a_scan_by_typing_it(self) -> None:
        """What all of this was for.

        Before the text layer, hiding a name on a scanned page meant drawing a
        rectangle on every page it appeared on. After it, the name is typed once
        and removed everywhere - and the pixels underneath are overwritten, so
        it is gone rather than covered.
        """
        data, _, boxes = redact_phrases(PdfReader.from_bytes(searchable()), ["Jane Doe"])
        assert len(boxes) == 1
        assert verify(data, ["Jane Doe"]) == []
        assert b"Jane" not in data

    def test_the_pixels_under_the_name_are_overwritten_too(self) -> None:
        """Removing the text layer alone would leave the name visible on the scan."""
        from ipw.pdf.edit import extract_images

        data, report, _ = redact_phrases(PdfReader.from_bytes(searchable()), ["Jane Doe"])
        assert report.images_painted == 1

        recovered = extract_images(PdfReader.from_bytes(data))[0]
        picture = Image.open(io.BytesIO(recovered.data)).convert("RGB")
        # The middle of the "Jane" ink block, in image pixels.
        sample = picture.getpixel((430, 205))
        assert sample == (0, 0, 0), f"the name is still legible on the scan: {sample}"

    def test_other_text_on_the_page_survives(self) -> None:
        data, _, _ = redact_phrases(PdfReader.from_bytes(searchable()), ["Jane Doe"])
        assert verify(data, ["ACC-4929-8812"]) == ["ACC-4929-8812"]


class TestRefusals:
    def test_no_words_is_refused(self) -> None:
        with pytest.raises(ValueError, match="no recognised words"):
            add_text_layer(PdfReader.from_bytes(a_scan()), {})

    def test_a_page_that_does_not_exist_is_refused(self) -> None:
        with pytest.raises(ValueError, match="does not exist"):
            add_text_layer(PdfReader.from_bytes(a_scan()), {9: recognised()})

    def test_empty_words_are_skipped_rather_than_written(self) -> None:
        data, report = add_text_layer(
            PdfReader.from_bytes(a_scan()),
            {1: [Word("   ", 10, 10, 50, 30), Word("real", 60, 10, 100, 30)]},
        )
        assert report["words_written"] == 1
        assert len(PdfReader.from_bytes(data).pages()) == 1


class TestCoverageWording:
    """Every mix of page types gets a sentence that is true of it.

    Collapsing "text or scan" into two cases produced a confidently wrong
    statement on an ordinary document: a 27-page design file with one photo was
    reported as "all 27 pages are scans", which would send someone to recognise
    26 pages containing no words at all.
    """

    @staticmethod
    def _note(total: int, searchable: int, scanned: int) -> str:
        from ipw.pdf.textlayer import _coverage_note

        return _coverage_note(total, searchable, scanned)

    def test_all_searchable(self) -> None:
        assert "needs no recognition" in self._note(4, 4, 0)

    def test_all_scans(self) -> None:
        assert "All 4 page(s) are scans" in self._note(4, 0, 4)

    def test_nothing_but_artwork(self) -> None:
        note = self._note(3, 0, 0)
        assert "None of the 3 page(s) contain words" in note
        assert "nothing for recognition to read" in note

    def test_a_scan_among_artwork_does_not_claim_the_artwork_is_scanned(self) -> None:
        """The 27-page case, in miniature."""
        note = self._note(27, 0, 1)
        assert "1 are scans" in note
        assert "26 hold no words at all" in note
        assert "All 27" not in note

    def test_a_mixed_bundle_names_the_danger(self) -> None:
        note = self._note(5, 2, 3)
        assert "silently miss" in note

    def test_no_pages_at_all(self) -> None:
        assert self._note(0, 0, 0) == "This document has no pages."


class TestPagesWithoutResources:
    def test_a_page_with_no_font_dictionary_gains_one(self) -> None:
        """A scan's page usually has no /Font at all - it draws one image.

        Adding a text layer has to create the font dictionary rather than assume
        it exists, or the recognised words reference a font that is not there
        and every viewer draws nothing.
        """
        writer = PdfWriter()
        catalog, tree = writer.reserve(), writer.reserve()
        contents = writer.add(Stream({}, b"BT ET"))
        page = writer.add(
            {
                "Type": Name("Page"),
                "Parent": tree,
                "MediaBox": [0, 0, 595, 842],
                "Resources": {},
                "Contents": contents,
            }
        )
        writer.put(tree, {"Type": Name("Pages"), "Kids": [page], "Count": 1})
        writer.put(catalog, {"Type": Name("Catalog"), "Pages": tree})

        data, report = add_text_layer(
            PdfReader.from_bytes(writer.build(catalog, {})),
            {1: [Word("hello", 100, 700, 160, 720)]},
        )
        assert report["words_written"] == 1

        reader = PdfReader.from_bytes(data)
        found = find_text(reader, reader.pages()[0].dictionary, "hello")
        assert found, "the word was written but cannot be read back"

    def test_a_page_with_no_contents_gets_the_layer_as_its_contents(self) -> None:
        writer = PdfWriter()
        catalog, tree = writer.reserve(), writer.reserve()
        page = writer.add(
            {
                "Type": Name("Page"),
                "Parent": tree,
                "MediaBox": [0, 0, 595, 842],
                "Resources": {},
            }
        )
        writer.put(tree, {"Type": Name("Pages"), "Kids": [page], "Count": 1})
        writer.put(catalog, {"Type": Name("Catalog"), "Pages": tree})

        data, _ = add_text_layer(
            PdfReader.from_bytes(writer.build(catalog, {})),
            {1: [Word("solo", 100, 700, 150, 720)]},
        )
        reader = PdfReader.from_bytes(data)
        assert find_text(reader, reader.pages()[0].dictionary, "solo")

    def test_a_zero_sized_word_is_skipped_rather_than_dividing_by_zero(self) -> None:
        data, report = add_text_layer(
            PdfReader.from_bytes(a_scan()),
            {1: [Word("flat", 100, 700, 100, 700), Word("real", 200, 700, 260, 720)]},
        )
        assert report["words_written"] == 2
        reader = PdfReader.from_bytes(data)
        assert find_text(reader, reader.pages()[0].dictionary, "real")
