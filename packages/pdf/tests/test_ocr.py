"""Recognition, and the two things it is easy to get wrong.

The recognition itself is Tesseract's problem, not this repository's, so almost
nothing here tests whether it can read letters. What is tested is everything
around it: that a missing binary is *reported* rather than crashed on, that a
recognised box lands where the ink is, and that the whole pipeline ends with a
name being removable from a scan by typing it.

Every test that needs the engine skips cleanly without it, so the suite still
means something on a machine that has not installed it.
"""

from __future__ import annotations

import io
from typing import Any

import pytest
from PIL import Image, ImageDraw, ImageFont

from ipw.pdf.content import extract_text, find_text
from ipw.pdf.objects import Name, PdfWriter, Stream
from ipw.pdf.ocr import MIN_CONFIDENCE, TesseractEngine, availability, locate, recognise
from ipw.pdf.reader import PdfReader
from ipw.pdf.redact import redact_phrases, verify
from ipw.pdf.textlayer import add_text_layer, coverage

needs_engine = pytest.mark.skipif(
    locate() is None, reason="the Tesseract binary is not installed on this machine"
)

LINES = [
    ("MEDICAL RECORD - CONFIDENTIAL", 160),
    ("Patient: Jane Doe", 300),
    ("NHS Number: 4929 8812 0031", 370),
    ("Address: 14 Elm Road, Coventry", 440),
    ("Consultant: Dr A Patel", 560),
    ("This paragraph must survive.", 700),
]


def a_scanned_letter(width: int = 1700, height: int = 2200) -> bytes:
    """A letter rendered to pixels and embedded as a JPEG - a scan, in effect."""
    picture = Image.new("RGB", (width, height), (253, 251, 247))
    draw = ImageDraw.Draw(picture)
    font: Any
    try:
        font = ImageFont.truetype("arial.ttf", 40)
    except OSError:  # pragma: no cover - depends on the host's fonts
        font = ImageFont.load_default()
    for text, y in LINES:
        draw.text((150, y), text, fill=(18, 18, 24), font=font)

    buffer = io.BytesIO()
    picture.save(buffer, format="JPEG", quality=92)

    writer = PdfWriter()
    catalog, tree = writer.reserve(), writer.reserve()
    image = writer.add(
        Stream(
            {
                "Type": Name("XObject"),
                "Subtype": Name("Image"),
                "Width": width,
                "Height": height,
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


class TestAvailability:
    def test_it_reports_rather_than_assumes(self) -> None:
        """An interface that offers what the host cannot do fails at the worst moment."""
        status = availability()
        assert isinstance(status["available"], bool)
        if not status["available"]:
            assert status["reason"], "an absent engine must come with a reason"

    def test_a_missing_binary_is_a_message_not_a_crash(self) -> None:
        status = availability(TesseractEngine(binary="definitely-not-installed-anywhere"))
        assert status["available"] is False
        assert "not installed" in status["reason"]

    def test_recognition_refuses_clearly_when_the_engine_is_absent(self) -> None:
        with pytest.raises(RuntimeError, match="not installed"):
            recognise(
                PdfReader.from_bytes(a_scanned_letter()),
                engine=TesseractEngine(binary="definitely-not-installed-anywhere"),
            )

    @needs_engine
    def test_the_licence_standing_travels_with_the_answer(self) -> None:
        """The engine is `review_required`, and saying so is the point of D-038.

        Usable here with its output marked; not cleared for commercial reliance
        until the licence and the training data have actually been reviewed.
        """
        status = availability()
        assert "review_required" in status["licence_note"]


@needs_engine
class TestRecognition:
    def test_a_scan_is_read_into_words(self) -> None:
        words, report = recognise(PdfReader.from_bytes(a_scanned_letter()))
        assert report["words"] > 10
        assert report["pages_read"] == [1]
        assert words[1]

    def test_the_words_are_the_words_on_the_page(self) -> None:
        words, _ = recognise(PdfReader.from_bytes(a_scanned_letter()))
        recognised = " ".join(word.text for word in words[1])
        assert "Jane" in recognised
        assert "Doe" in recognised

    def test_boxes_land_inside_the_page(self) -> None:
        """A box outside the page means the matrix mapping is wrong.

        Assuming the image fills the page would put every word somewhere else on
        any document whose scan is inset, rotated or placed at a margin.
        """
        words, _ = recognise(PdfReader.from_bytes(a_scanned_letter()))
        for word in words[1]:
            assert 0 <= word.left < word.right <= 595 + 1
            assert 0 <= word.bottom < word.top <= 842 + 1

    def test_words_land_in_reading_order_down_the_page(self) -> None:
        """The first line must come out above the last one.

        PDF's y axis runs upward and an image's runs down; getting that backwards
        produces a page of correctly recognised text, upside down.
        """
        words, _ = recognise(PdfReader.from_bytes(a_scanned_letter()))
        top_line = next(w for w in words[1] if "MEDICAL" in w.text)
        bottom_line = next(w for w in words[1] if "survive" in w.text)
        assert top_line.bottom > bottom_line.top, "the page came out inverted"

    def test_a_page_with_no_image_is_skipped_not_failed(self) -> None:
        from ipw.pdf.document import PdfDocument, TextBox

        document = PdfDocument()
        page = document.add_page()
        page.texts.append(TextBox(text="real text, no scan", x=72, y=700))
        words, report = recognise(PdfReader.from_bytes(document.render()))
        assert words == {}
        assert report["pages_skipped"] == [1]

    def test_a_page_that_does_not_exist_is_refused(self) -> None:
        with pytest.raises(ValueError, match="does not exist"):
            recognise(PdfReader.from_bytes(a_scanned_letter()), pages=[9])

    def test_low_confidence_words_are_dropped(self) -> None:
        """A wrong word in a searchable layer is worse than a gap.

        A gap means a search finds nothing; a wrong word means a search lands on
        a page that does not contain it.
        """
        words, _ = recognise(PdfReader.from_bytes(a_scanned_letter()))
        assert all(word.confidence >= MIN_CONFIDENCE / 100.0 for word in words[1])


@needs_engine
class TestTheWholePipeline:
    """Scan in, searchable and redactable out."""

    @staticmethod
    def _searchable() -> bytes:
        source = a_scanned_letter()
        words, _ = recognise(PdfReader.from_bytes(source))
        data, _ = add_text_layer(PdfReader.from_bytes(source), words)
        return data

    def test_a_scan_becomes_searchable(self) -> None:
        before = coverage(PdfReader.from_bytes(a_scanned_letter()))
        after = coverage(PdfReader.from_bytes(self._searchable()))
        assert before["fully_searchable"] is False
        assert after["fully_searchable"] is True

    def test_the_text_can_be_read_back(self) -> None:
        reader = PdfReader.from_bytes(self._searchable())
        text = " ".join(run.text for run in extract_text(reader, reader.pages()[0].dictionary))
        assert "Jane" in text

    @pytest.mark.parametrize("phrase", ["Jane Doe", "14 Elm Road"])
    def test_a_phrase_can_be_found(self, phrase: str) -> None:
        reader = PdfReader.from_bytes(self._searchable())
        assert find_text(reader, reader.pages()[0].dictionary, phrase)

    def test_a_name_can_be_redacted_from_the_scan_by_typing_it(self) -> None:
        """What the whole feature is for.

        Before: a rectangle drawn by hand on every page it appears on. After: the
        name typed once, removed everywhere, with the pixels underneath painted
        over so it is gone rather than covered.
        """
        data, report, boxes = redact_phrases(PdfReader.from_bytes(self._searchable()), ["Jane Doe"])
        assert boxes, "the name was not found in the recognised text"
        assert verify(data, ["Jane Doe"]) == []
        assert report.images_painted == 1, "the pixels on the scan were not overwritten"

    def test_the_rest_of_the_letter_survives(self) -> None:
        data, _, _ = redact_phrases(PdfReader.from_bytes(self._searchable()), ["Jane Doe"])
        assert verify(data, ["survive"]) == ["survive"]
