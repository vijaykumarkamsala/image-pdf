"""Redaction, tested against the bytes rather than against the picture.

The characteristic failure of every redaction tool is that it looks right. A
black rectangle drawn over a name produces a page that appears redacted to
everyone who checks it visually, and a file that still contains the name for
anyone who selects the text, runs `strings`, or feeds it to a search index.
Documents have been published that way by law firms, hospitals and governments.

So almost nothing here asserts that a rectangle was drawn. The assertions are
that the words are absent from the file: absent from the extracted text, absent
from the decompressed content stream, and - where the page is a scan - absent
from the pixels.
"""

from __future__ import annotations

import io

import pytest
from PIL import Image, ImageDraw

from ipw.pdf.content import extract_text, page_content
from ipw.pdf.document import PdfDocument, TextBox
from ipw.pdf.objects import Name, PdfWriter, Stream
from ipw.pdf.reader import PdfReader
from ipw.pdf.redact import Redaction, redact, redact_phrases, verify

SECRET = "Jane Doe"  # noqa: S105 - a person's name, not a credential
ACCOUNT = "4929 8812 0031"
KEEP = "Diagnosis code Z99"


def a_record() -> bytes:
    document = PdfDocument()
    page = document.add_page()
    page.texts.append(TextBox(text=f"Patient: {SECRET}  NHS {ACCOUNT}", x=72, y=700, size=13))
    page.texts.append(TextBox(text=f"{KEEP} - this line stays", x=72, y=660, size=13))
    return document.render()


def box_over_first_line(data: bytes, *, from_x: float = 125.0) -> Redaction:
    reader = PdfReader.from_bytes(data)
    run = extract_text(reader, reader.pages()[0].dictionary)[0]
    return Redaction(page=1, left=from_x, bottom=run.y0, right=run.x1 + 2, top=run.y1)


def text_of(data: bytes) -> str:
    reader = PdfReader.from_bytes(data)
    return " ".join(
        run.text for page in reader.pages() for run in extract_text(reader, page.dictionary)
    )


def streams_of(data: bytes) -> str:
    """Every content stream, decompressed - where a 'removed' word usually hides."""
    reader = PdfReader.from_bytes(data)
    return " ".join(
        page_content(reader, page.dictionary).decode("latin-1", "replace")
        for page in reader.pages()
    )


class TestTheWordsAreGone:
    def test_the_redacted_text_is_not_in_the_extracted_text(self) -> None:
        data, _ = redact(PdfReader.from_bytes(a_record()), [box_over_first_line(a_record())])
        assert SECRET not in text_of(data)
        assert ACCOUNT not in text_of(data)

    def test_the_redacted_text_is_not_in_the_content_stream(self) -> None:
        """The check that catches a black rectangle pretending to be redaction.

        A tool that draws a box and stops passes any visual inspection and fails
        this line.
        """
        data, _ = redact(PdfReader.from_bytes(a_record()), [box_over_first_line(a_record())])
        streams = streams_of(data)
        assert SECRET not in streams
        assert ACCOUNT not in streams

    def test_the_redacted_text_is_not_anywhere_in_the_raw_file(self) -> None:
        """`strings redacted.pdf | grep` is what a journalist actually runs."""
        data, _ = redact(PdfReader.from_bytes(a_record()), [box_over_first_line(a_record())])
        assert b"Jane" not in data
        assert b"8812" not in data

    def test_neighbouring_text_survives_intact(self) -> None:
        """Removing a name must not take the rest of the document with it."""
        data, _ = redact(PdfReader.from_bytes(a_record()), [box_over_first_line(a_record())])
        assert KEEP in text_of(data)

    def test_removal_is_per_character_so_a_sentence_survives(self) -> None:
        """A name in the middle of a line leaves the line readable.

        Dropping the whole show-text operator would be far easier and would
        delete the sentence around the name, which is not what anyone means by
        redacting a name.
        """
        source = a_record()
        data, report = redact(PdfReader.from_bytes(source), [box_over_first_line(source)])
        assert "Patient:" in text_of(data), "the label before the name was removed too"
        assert report.characters_removed > 0

    def test_what_was_removed_is_reported(self) -> None:
        """A customer needs to be able to check what the box actually covered."""
        source = a_record()
        _, report = redact(PdfReader.from_bytes(source), [box_over_first_line(source)])
        assert any(SECRET in entry for entry in report.removed_text)


class TestVerification:
    def test_verify_reports_a_phrase_that_survived(self) -> None:
        """The guard against this module quietly failing in future.

        If a change ever stops removing text, `verify` is what notices - and it
        must notice, or the feature degrades into the thing it exists to prevent.
        """
        untouched = a_record()
        assert verify(untouched, [SECRET]) == [SECRET]

    def test_verify_reports_nothing_after_a_real_redaction(self) -> None:
        source = a_record()
        data, _ = redact(PdfReader.from_bytes(source), [box_over_first_line(source)])
        assert verify(data, [SECRET, ACCOUNT]) == []

    def test_verify_still_finds_text_that_was_kept(self) -> None:
        """A verifier that reports 'clean' for everything proves nothing."""
        source = a_record()
        data, _ = redact(PdfReader.from_bytes(source), [box_over_first_line(source)])
        assert verify(data, [KEEP]) == [KEEP]

    def test_an_empty_phrase_list_is_not_an_error(self) -> None:
        assert verify(a_record(), []) == []


class TestScannedPages:
    """Where the words are pixels, only painting the pixels hides anything."""

    @staticmethod
    def _scan() -> bytes:
        page = Image.new("RGB", (850, 1100), (252, 250, 246))
        draw = ImageDraw.Draw(page)
        draw.rectangle([80, 120, 760, 180], fill=(20, 20, 30))  # the sensitive block
        draw.rectangle([80, 300, 760, 360], fill=(20, 20, 30))  # a block to keep

        writer = PdfWriter()
        catalog, tree = writer.reserve(), writer.reserve()
        buffer = io.BytesIO()
        page.save(buffer, format="JPEG", quality=90)
        image = writer.add(
            Stream(
                {
                    "Type": Name("XObject"),
                    "Subtype": Name("Image"),
                    "Width": 850,
                    "Height": 1100,
                    "ColorSpace": Name("DeviceRGB"),
                    "BitsPerComponent": 8,
                },
                buffer.getvalue(),
                compress=False,
                filters=("DCTDecode",),
            )
        )
        contents = writer.add(Stream({}, b"q 612 0 0 792 0 0 cm /Im0 Do Q"))
        leaf = writer.add(
            {
                "Type": Name("Page"),
                "Parent": tree,
                "MediaBox": [0, 0, 612, 792],
                "Resources": {"XObject": {"Im0": image}},
                "Contents": contents,
            }
        )
        writer.put(tree, {"Type": Name("Pages"), "Kids": [leaf], "Count": 1})
        writer.put(catalog, {"Type": Name("Catalog"), "Pages": tree})
        return writer.build(catalog, {})

    @staticmethod
    def _redacted() -> bytes:
        source = TestScannedPages._scan()
        # Image rows 120-180 of 1100, mapped to page points from the bottom.
        box = Redaction(
            page=1,
            left=50,
            bottom=792 * (1 - 180 / 1100),
            right=560,
            top=792 * (1 - 120 / 1100),
        )
        data, report = redact(PdfReader.from_bytes(source), [box])
        assert report.images_painted == 1
        return data

    @staticmethod
    def _pixel(data: bytes, row: int) -> tuple[int, int, int]:
        from ipw.pdf.edit import extract_images

        recovered = extract_images(PdfReader.from_bytes(data))[0]
        picture = Image.open(io.BytesIO(recovered.data)).convert("RGB")
        value = picture.getpixel((400, int(row * picture.height / 1100)))
        assert isinstance(value, tuple)
        red, green, blue = value[:3]
        return (int(red), int(green), int(blue))

    def test_the_covered_pixels_are_overwritten(self) -> None:
        assert self._pixel(self._redacted(), 150) == (0, 0, 0)

    def test_pixels_outside_the_box_are_untouched(self) -> None:
        """Painting the whole image black would 'work' and destroy the document."""
        assert self._pixel(self._redacted(), 330) != (0, 0, 0)

    def test_the_paper_is_untouched(self) -> None:
        red, green, blue = self._pixel(self._redacted(), 600)
        assert red > 200
        assert green > 200
        assert blue > 200


class TestAnnotations:
    def test_an_annotation_under_a_box_is_removed(self) -> None:
        """A comment carries its own text, entirely outside the content stream.

        Leaving it is the same failure as leaving the words: invisible on the
        page, plainly there in the file.
        """
        writer = PdfWriter()
        catalog, tree = writer.reserve(), writer.reserve()
        note = writer.add(
            {
                "Type": Name("Annot"),
                "Subtype": Name("Text"),
                "Contents": "internal note: do not disclose",
                "Rect": [100, 690, 200, 720],
            }
        )
        contents = writer.add(Stream({}, b"BT ET"))
        page = writer.add(
            {
                "Type": Name("Page"),
                "Parent": tree,
                "MediaBox": [0, 0, 612, 792],
                "Resources": {},
                "Contents": contents,
                "Annots": [note],
            }
        )
        writer.put(tree, {"Type": Name("Pages"), "Kids": [page], "Count": 1})
        writer.put(catalog, {"Type": Name("Catalog"), "Pages": tree})

        data, report = redact(
            PdfReader.from_bytes(writer.build(catalog, {})),
            [Redaction(page=1, left=90, bottom=680, right=210, top=730)],
        )
        assert report.annotations_removed == 1
        assert b"do not disclose" not in data

    def test_an_annotation_elsewhere_is_kept(self) -> None:
        writer = PdfWriter()
        catalog, tree = writer.reserve(), writer.reserve()
        note = writer.add(
            {
                "Type": Name("Annot"),
                "Subtype": Name("Text"),
                "Contents": "a harmless comment",
                "Rect": [100, 100, 200, 130],
            }
        )
        contents = writer.add(Stream({}, b"BT ET"))
        page = writer.add(
            {
                "Type": Name("Page"),
                "Parent": tree,
                "MediaBox": [0, 0, 612, 792],
                "Resources": {},
                "Contents": contents,
                "Annots": [note],
            }
        )
        writer.put(tree, {"Type": Name("Pages"), "Kids": [page], "Count": 1})
        writer.put(catalog, {"Type": Name("Catalog"), "Pages": tree})

        data, report = redact(
            PdfReader.from_bytes(writer.build(catalog, {})),
            [Redaction(page=1, left=400, bottom=600, right=500, top=700)],
        )
        assert report.annotations_removed == 0
        assert b"a harmless comment" in data


class TestNoRecoverableHistory:
    def test_the_result_carries_no_previous_revision(self) -> None:
        """Appending a redaction leaves the original page recoverable.

        Several of the published redaction failures were undone exactly that
        way - not by selecting the text, but by reading the revision underneath.
        Rebuilding rather than appending is what closes it.
        """
        source = a_record()
        data, _ = redact(PdfReader.from_bytes(source), [box_over_first_line(source)])
        assert b"/Prev" not in data
        assert data.count(b"%%EOF") == 1, "more than one revision is present"


class TestMultiplePagesAndBoxes:
    @staticmethod
    def _two_pages() -> bytes:
        document = PdfDocument()
        for index in range(2):
            page = document.add_page()
            page.texts.append(TextBox(text=f"SECRET-{index}", x=72, y=700, size=14))
            page.texts.append(TextBox(text=f"public-{index}", x=72, y=600, size=14))
        return document.render()

    def test_only_the_named_page_is_touched(self) -> None:
        source = self._two_pages()
        data, _ = redact(
            PdfReader.from_bytes(source),
            [Redaction(page=1, left=60, bottom=690, right=300, top=720)],
        )
        text = text_of(data)
        assert "SECRET-0" not in text
        assert "SECRET-1" in text, "a redaction on page 1 reached page 2"

    def test_several_boxes_on_several_pages(self) -> None:
        source = self._two_pages()
        data, _ = redact(
            PdfReader.from_bytes(source),
            [
                Redaction(page=1, left=60, bottom=690, right=300, top=720),
                Redaction(page=2, left=60, bottom=690, right=300, top=720),
            ],
        )
        text = text_of(data)
        assert "SECRET-0" not in text
        assert "SECRET-1" not in text
        assert "public-0" in text
        assert "public-1" in text

    def test_the_page_count_is_unchanged(self) -> None:
        source = self._two_pages()
        data, _ = redact(
            PdfReader.from_bytes(source),
            [Redaction(page=1, left=60, bottom=690, right=300, top=720)],
        )
        assert len(PdfReader.from_bytes(data).pages()) == 2


class TestRefusals:
    def test_no_areas_is_refused(self) -> None:
        with pytest.raises(ValueError, match="no areas"):
            redact(PdfReader.from_bytes(a_record()), [])

    def test_a_page_that_does_not_exist_is_refused(self) -> None:
        with pytest.raises(ValueError, match="does not exist"):
            redact(
                PdfReader.from_bytes(a_record()),
                [Redaction(page=9, left=0, bottom=0, right=10, top=10)],
            )

    def test_a_reversed_rectangle_is_accepted_rather_than_missing_the_target(self) -> None:
        """Dragging up-and-left is how half of people draw a box.

        Treating that as an empty rectangle would silently redact nothing, which
        is the most dangerous possible response.
        """
        source = a_record()
        reader = PdfReader.from_bytes(source)
        run = extract_text(reader, reader.pages()[0].dictionary)[0]
        reversed_box = Redaction(page=1, left=run.x1 + 2, bottom=run.y1, right=125, top=run.y0)
        data, report = redact(PdfReader.from_bytes(source), [reversed_box])
        assert report.characters_removed > 0
        assert SECRET not in text_of(data)


class TestHonestLimits:
    def test_a_page_with_drawn_artwork_is_reported(self) -> None:
        """Vector art is not removed, and the caller is told rather than left to assume."""
        writer = PdfWriter()
        catalog, tree = writer.reserve(), writer.reserve()
        contents = writer.add(Stream({}, b"0 0 0 RG 100 100 m 300 300 l S"))
        page = writer.add(
            {
                "Type": Name("Page"),
                "Parent": tree,
                "MediaBox": [0, 0, 612, 792],
                "Resources": {},
                "Contents": contents,
            }
        )
        writer.put(tree, {"Type": Name("Pages"), "Kids": [page], "Count": 1})
        writer.put(catalog, {"Type": Name("Catalog"), "Pages": tree})

        _, report = redact(
            PdfReader.from_bytes(writer.build(catalog, {})),
            [Redaction(page=1, left=90, bottom=90, right=320, top=320)],
        )
        assert report.pages_with_vector_art == [1]


class TestRedactByPhrase:
    """The way the work is actually done: remove every instance, everywhere.

    Nobody redacting a two-hundred page bundle draws two hundred rectangles.
    Redactions get missed not through technical failure but because page 147 was
    scrolled past, and that is the failure this addresses.
    """

    @staticmethod
    def _bundle(pages: int = 8) -> bytes:
        document = PdfDocument()
        for index in range(pages):
            page = document.add_page()
            page.texts.append(TextBox(text=f"Bundle page {index + 1}", x=72, y=740, size=11))
            page.texts.append(TextBox(text=f"Claimant: {SECRET} of 14 Elm Road", x=72, y=700))
            page.texts.append(TextBox(text=f"Ref {ACCOUNT} filed by {SECRET}", x=72, y=660))
            page.texts.append(TextBox(text="This paragraph survives.", x=72, y=620))
        return document.render()

    def test_every_occurrence_on_every_page_is_removed(self) -> None:
        source = self._bundle()
        data, _, boxes = redact_phrases(PdfReader.from_bytes(source), [SECRET])
        assert len(boxes) == 16, "two per page across eight pages"
        assert verify(data, [SECRET]) == []

    def test_unrelated_text_survives_on_every_page(self) -> None:
        source = self._bundle()
        data, _, _ = redact_phrases(PdfReader.from_bytes(source), [SECRET])
        text = text_of(data)
        assert text.count("This paragraph survives.") == 8

    def test_several_phrases_at_once(self) -> None:
        source = self._bundle()
        data, _, _ = redact_phrases(PdfReader.from_bytes(source), [SECRET, ACCOUNT, "14 Elm Road"])
        assert verify(data, [SECRET, ACCOUNT, "14 Elm Road"]) == []

    def test_finding_nothing_is_reported_rather_than_implied(self) -> None:
        """The most dangerous outcome to get wrong.

        A customer who assumes a name was removed because the tool did not
        complain is worse off than before they started, so an empty result is
        returned explicitly with no boxes.
        """
        source = self._bundle()
        data, report, boxes = redact_phrases(
            PdfReader.from_bytes(source), ["a name that is not in this document"]
        )
        assert boxes == []
        assert report.characters_removed == 0
        assert len(PdfReader.from_bytes(data).pages()) == 8

    def test_matching_ignores_case_by_default(self) -> None:
        source = self._bundle()
        _, _, boxes = redact_phrases(PdfReader.from_bytes(source), ["jane doe"])
        assert len(boxes) == 16

    def test_case_can_be_made_to_matter(self) -> None:
        source = self._bundle()
        _, _, boxes = redact_phrases(PdfReader.from_bytes(source), ["jane doe"], ignore_case=False)
        assert boxes == []

    def test_it_can_be_limited_to_named_pages(self) -> None:
        source = self._bundle()
        data, _, boxes = redact_phrases(PdfReader.from_bytes(source), [SECRET], pages=[1, 2])
        assert len(boxes) == 4
        # Still present on the pages that were not selected.
        assert verify(data, [SECRET]) == [SECRET]

    def test_an_empty_phrase_list_is_refused(self) -> None:
        with pytest.raises(ValueError, match="no phrases"):
            redact_phrases(PdfReader.from_bytes(self._bundle()), ["  "])

    def test_a_page_that_does_not_exist_is_refused(self) -> None:
        with pytest.raises(ValueError, match="does not exist"):
            redact_phrases(PdfReader.from_bytes(self._bundle()), [SECRET], pages=[99])


class TestNoOrphanedOriginals:
    """The bug this class exists for shipped, passed every other test, and leaked.

    Copying a page copies the image it references. Swapping the resource entry
    afterwards leaves the original in the file: unreferenced, invisible in every
    viewer, and readable by anything that walks objects instead of pages. The
    scan tests all passed, because they asked the page for its image and got the
    painted one.

    So this walks every object in the file, which is what an adversary does.
    """

    @staticmethod
    def _image_objects(data: bytes) -> list[tuple[int, int, bytes]]:
        """Every image XObject in the file, referenced or not."""
        from ipw.pdf.reader import RawStream

        reader = PdfReader.from_bytes(data)
        found: list[tuple[int, int, bytes]] = []
        for number in range(1, 200):
            obj = reader.object(number)
            if not isinstance(obj, RawStream):
                continue
            subtype = obj.dictionary.get("Subtype")
            if isinstance(subtype, Name) and subtype.value == "Image":
                found.append(
                    (
                        int(obj.dictionary.get("Width") or 0),
                        int(obj.dictionary.get("Height") or 0),
                        obj.decoded(),
                    )
                )
        return found

    def test_no_object_in_the_file_still_holds_the_original_pixels(self) -> None:
        data = TestScannedPages._redacted()  # noqa: SLF001 - shared fixture, by design
        images = self._image_objects(data)
        assert images, "no image objects found at all - the test is not looking properly"

        for width, height, payload in images:
            try:
                picture = Image.open(io.BytesIO(payload)).convert("RGB")
            except OSError:
                picture = Image.frombytes("RGB", (width, height), payload[: width * height * 3])
            sample = picture.getpixel((400, int(150 * picture.height / 1100)))
            assert sample == (0, 0, 0), (
                f"an image object in the redacted file still holds the original pixels "
                f"at the redacted row: {sample}"
            )

    def test_the_file_carries_exactly_one_copy_of_each_image(self) -> None:
        """Two copies means one of them is the version nobody meant to ship."""
        assert len(self._image_objects(TestScannedPages._redacted())) == 1  # noqa: SLF001

    def test_redacting_a_scan_does_not_make_the_file_larger(self) -> None:
        """A file that grows is the symptom that gave the leak away."""
        source = TestScannedPages._scan()  # noqa: SLF001 - shared fixture, by design
        redacted = TestScannedPages._redacted()  # noqa: SLF001
        assert len(redacted) <= len(source)


class TestNothingIsLeftBehindInTheFile:
    """The redacted words must be absent from the bytes, not merely unreferenced.

    A page can render perfectly, extraction can find nothing, and `verify` can
    pass, while the original text sits in the file as an object nothing points
    at. That is how documents get released with the name still in them: the
    reviewer looks at the page, and the recipient runs `qpdf --qdf`.

    It happened here. `Contents` was replaced with the cleaned stream *after*
    the page was copied, so the copy pulled the original stream into the output
    first. The images had already been fixed the same way - dropped before the
    copy - and the text had not.

    So these tests read every object and decompress every stream, which is the
    only check that distinguishes "removed" from "hidden".
    """

    @staticmethod
    def _contract() -> bytes:
        writer = PdfWriter()
        catalog, tree = writer.reserve(), writer.reserve()
        font = writer.add(
            {"Type": Name("Font"), "Subtype": Name("Type1"), "BaseFont": Name("Helvetica")}
        )
        body = (
            b"BT /F1 12 Tf 72 720 Td (SUPPLY AGREEMENT) Tj ET\n"
            b"BT /F1 11 Tf 72 690 Td (Between Acme Textiles Ltd and Jane Doe) Tj ET\n"
            b"BT /F1 11 Tf 72 660 Td (Signed at Coimbatore) Tj ET"
        )
        contents = writer.add(Stream({}, body))
        leaf = writer.add(
            {
                "Type": Name("Page"),
                "Parent": tree,
                "MediaBox": [0, 0, 595, 842],
                "Resources": {"Font": {"F1": font}},
                "Contents": contents,
            }
        )
        writer.put(tree, {"Type": Name("Pages"), "Kids": [leaf], "Count": 1})
        writer.put(catalog, {"Type": Name("Catalog"), "Pages": tree})
        return writer.build(catalog, {})

    @staticmethod
    def _everything_readable(payload: bytes) -> str:
        """Raw bytes plus the contents of every stream that will decompress.

        Text hidden in a deflate stream is still in the document, and a check
        that only reads the raw bytes passes a file that still carries the name.
        """
        import re
        import zlib

        found = [payload.decode("latin-1", errors="replace")]
        for match in re.finditer(rb"stream\r?\n(.*?)\r?\nendstream", payload, re.S):
            try:
                found.append(zlib.decompress(match.group(1)).decode("latin-1", errors="replace"))
            except zlib.error:
                continue
        return "\n".join(found)

    def test_the_phrase_is_absent_from_every_stream_in_the_file(self) -> None:
        source = self._contract()
        assert "Jane Doe" in self._everything_readable(source), "the fixture must contain it first"

        redacted, _ = redact_phrases(PdfReader.from_bytes(source), ["Jane Doe"])[:2]

        readable = self._everything_readable(redacted)
        assert "Jane Doe" not in readable, "the redacted name is still recoverable from the file"
        assert "Jane" not in readable
        assert "Doe" not in readable

    def test_the_rest_of_the_document_survives(self) -> None:
        """A redaction that removed everything would pass the test above."""
        redacted, _ = redact_phrases(PdfReader.from_bytes(self._contract()), ["Jane Doe"])[:2]

        readable = self._everything_readable(redacted)
        assert "SUPPLY AGREEMENT" in readable
        assert "Coimbatore" in readable

    def test_no_orphaned_content_stream_is_carried_over(self) -> None:
        """The specific shape of the bug: two content streams in the output, the
        page pointing at the clean one and the original left behind."""
        import re

        redacted, _ = redact_phrases(PdfReader.from_bytes(self._contract()), ["Jane Doe"])[:2]

        streams = re.findall(rb"stream\r?\n(.*?)\r?\nendstream", redacted, re.S)
        assert len(streams) == 1, (
            f"{len(streams)} streams in a one-page document; the original was copied "
            f"in before being replaced"
        )
