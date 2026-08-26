"""Getting a PDF under a size limit, without lying about what it cost.

Two failure modes matter more than the compression ratio.

The first is a file that comes back *larger*, which is what happens when the
original image is left in the document alongside its replacement. It looks like
a compression bug and is really a correctness bug - the same one that leaves an
unredacted scan inside a redacted file.

The second is reporting success when the target was missed. A customer who
believes their file is under the portal's limit finds out at the upload form,
having already been told it was fine.
"""

from __future__ import annotations

import io

import pytest
from PIL import Image, ImageDraw

from ipw.pdf.compress import compress, compress_to_target
from ipw.pdf.document import PdfDocument, TextBox
from ipw.pdf.objects import Name, PdfWriter, Stream
from ipw.pdf.reader import PdfReader, RawStream


def a_scanned_bundle(pages: int = 3, size: tuple[int, int] = (2550, 3300)) -> bytes:
    """Pages of 300-DPI scans placed on A4 - the shape of the real problem."""
    writer = PdfWriter()
    catalog, tree = writer.reserve(), writer.reserve()
    kids = []
    for index in range(pages):
        picture = Image.new("RGB", size, (252, 250, 246))
        draw = ImageDraw.Draw(picture)
        for y in range(200, size[1] - 300, 90):
            draw.rectangle([200, y, size[0] - 200, y + 40], fill=(40 + index, 40, 50))
        buffer = io.BytesIO()
        picture.save(buffer, format="JPEG", quality=95)
        image = writer.add(
            Stream(
                {
                    "Type": Name("XObject"),
                    "Subtype": Name("Image"),
                    "Width": size[0],
                    "Height": size[1],
                    "ColorSpace": Name("DeviceRGB"),
                    "BitsPerComponent": 8,
                },
                buffer.getvalue(),
                compress=False,
                filters=("DCTDecode",),
            )
        )
        contents = writer.add(Stream({}, b"q 595 0 0 842 0 0 cm /Im0 Do Q"))
        kids.append(
            writer.add(
                {
                    "Type": Name("Page"),
                    "Parent": tree,
                    "MediaBox": [0, 0, 595, 842],
                    "Resources": {"XObject": {"Im0": image}},
                    "Contents": contents,
                }
            )
        )
    writer.put(tree, {"Type": Name("Pages"), "Kids": kids, "Count": len(kids)})
    writer.put(catalog, {"Type": Name("Catalog"), "Pages": tree})
    return writer.build(catalog, {})


def image_objects(data: bytes) -> list[RawStream]:
    """Every image XObject in the file, referenced or not."""
    reader = PdfReader.from_bytes(data)
    found = []
    for number in range(1, 200):
        obj = reader.object(number)
        if isinstance(obj, RawStream):
            subtype = obj.dictionary.get("Subtype")
            if isinstance(subtype, Name) and subtype.value == "Image":
                found.append(obj)
    return found


class TestItActuallyGetsSmaller:
    def test_a_scanned_bundle_shrinks(self) -> None:
        source = a_scanned_bundle()
        data, report = compress(PdfReader.from_bytes(source), max_dpi=150, quality=75)
        assert len(data) < len(source) * 0.6
        assert report.images_touched == 3

    def test_the_original_images_do_not_survive_alongside_the_new_ones(self) -> None:
        """The bug that made an earlier version produce *larger* files.

        Copying a page copies the image it references, so swapping the resource
        entry afterwards leaves both in the document. Counting objects is what
        catches it; measuring the ratio only hints at it.
        """
        data, _ = compress(PdfReader.from_bytes(a_scanned_bundle()), max_dpi=150, quality=75)
        assert len(image_objects(data)) == 3, "an original image survived the replacement"

    def test_lower_settings_produce_smaller_files(self) -> None:
        source = a_scanned_bundle()
        sizes = [
            len(compress(PdfReader.from_bytes(source), max_dpi=dpi, quality=q)[0])
            for dpi, q in ((300, 90), (200, 82), (150, 75), (72, 60))
        ]
        assert sizes == sorted(sizes, reverse=True), f"not monotonic: {sizes}"

    def test_the_page_count_is_unchanged(self) -> None:
        data, _ = compress(PdfReader.from_bytes(a_scanned_bundle(4)), max_dpi=150, quality=75)
        assert len(PdfReader.from_bytes(data).pages()) == 4

    def test_the_result_still_opens(self) -> None:
        data, _ = compress(PdfReader.from_bytes(a_scanned_bundle()), max_dpi=150, quality=75)
        described = PdfReader.from_bytes(data).describe()
        assert described["page_count"] == 3
        assert described["pages"][0]["label"] == "8.26 x 11.69 in"


class TestResolution:
    def test_it_reports_the_resolution_before_and_after(self) -> None:
        """DPI at placed size is the number that decides whether this hurt.

        Reducing a 600 DPI scan to 300 costs nothing anyone can see; reducing it
        to 72 costs a great deal, and the difference must be visible in the
        report rather than inferred from the file size.
        """
        _, report = compress(PdfReader.from_bytes(a_scanned_bundle()), max_dpi=150, quality=75)
        assert report.lowest_dpi_before > report.lowest_dpi_after
        assert report.lowest_dpi_after <= 150

    def test_an_image_already_below_the_limit_is_not_upscaled(self) -> None:
        """Compression must never make an image bigger to meet a DPI 'limit'."""
        source = a_scanned_bundle(1, size=(300, 420))
        data, _ = compress(PdfReader.from_bytes(source), max_dpi=600, quality=90)
        for image in image_objects(data):
            assert int(image.dictionary["Width"] or 0) <= 300

    def test_a_document_with_no_images_still_works(self) -> None:
        document = PdfDocument()
        page = document.add_page()
        page.texts.append(TextBox(text="text only", x=72, y=700))
        data, report = compress(PdfReader.from_bytes(document.render()))
        assert report.images_touched == 0
        assert len(PdfReader.from_bytes(data).pages()) == 1


class TestTargetSize:
    def test_it_reaches_a_generous_target_with_the_gentlest_setting(self) -> None:
        """A file needing a mild reduction should not come back looking like a fax."""
        source = a_scanned_bundle()
        data, report = compress_to_target(PdfReader.from_bytes(source), int(len(source) * 0.75))
        assert report.reached_target
        assert len(data) <= len(source) * 0.75
        assert report.attempts <= 2, "it jumped further down the ladder than it needed to"

    def test_it_walks_further_down_for_a_tight_target(self) -> None:
        source = a_scanned_bundle()
        data, report = compress_to_target(PdfReader.from_bytes(source), 700_000)
        assert report.reached_target
        assert len(data) <= 700_000

    def test_an_impossible_target_is_reported_as_a_miss(self) -> None:
        """The failure that matters most.

        Returning the smallest attempt and calling it success sends someone to
        an upload form believing a thing that is not true.
        """
        data, report = compress_to_target(PdfReader.from_bytes(a_scanned_bundle()), 1_000)
        assert report.reached_target is False
        assert len(data) > 1_000
        assert any("COULD NOT" in note for note in report.notes)

    def test_a_missed_target_still_returns_the_smallest_attempt(self) -> None:
        """Useless output would be worse than a large file."""
        source = a_scanned_bundle()
        data, _ = compress_to_target(PdfReader.from_bytes(source), 1_000)
        assert len(data) < len(source)
        assert len(PdfReader.from_bytes(data).pages()) == 3

    def test_a_target_of_zero_is_refused(self) -> None:
        with pytest.raises(ValueError, match="greater than zero"):
            compress_to_target(PdfReader.from_bytes(a_scanned_bundle()), 0)

    def test_the_size_in_the_message_is_the_size_that_was_asked_for(self) -> None:
        """A 50 KB limit reported as '0.1 MB' is a different number.

        Especially in the sentence explaining that the number could not be met.
        """
        _, report = compress_to_target(PdfReader.from_bytes(a_scanned_bundle()), 50_000)
        assert any("50 KB" in note for note in report.notes)


class TestHonestReporting:
    def test_it_says_when_the_saving_came_from_private_data(self) -> None:
        """A 62% saving with no image touched is surprising enough to explain."""
        writer = PdfWriter()
        catalog, tree = writer.reserve(), writer.reserve()
        bulk = writer.add(Stream({}, b"x" * 200_000, compress=False))
        contents = writer.add(Stream({}, b"BT ET"))
        page = writer.add(
            {
                "Type": Name("Page"),
                "Parent": tree,
                "MediaBox": [0, 0, 595, 842],
                "Resources": {},
                "Contents": contents,
                "PieceInfo": {"Illustrator": {"Private": bulk}},
            }
        )
        writer.put(tree, {"Type": Name("Pages"), "Kids": [page], "Count": 1})
        writer.put(catalog, {"Type": Name("Catalog"), "Pages": tree})

        _, report = compress(PdfReader.from_bytes(writer.build(catalog, {})))
        assert report.images_touched == 0
        assert any("private working copy" in note for note in report.notes)

    def test_the_ratio_and_saving_agree_with_the_bytes(self) -> None:
        source = a_scanned_bundle()
        data, report = compress(PdfReader.from_bytes(source), max_dpi=150, quality=75)
        assert report.original_bytes == len(source)
        assert report.final_bytes == len(data)
        assert report.saved == len(source) - len(data)
