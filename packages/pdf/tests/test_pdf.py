"""The PDF engine.

Two kinds of test here, and the split is deliberate.

Most of these **parse the produced file back**. A PDF is not correct because the
code that wrote it looked right; it is correct because a reader can follow its
cross-reference table to every object. A file with one bad offset opens in some
viewers and not others, which is the worst failure available - it looks like it
worked, and fails at the printer.

The rest assert the quality promise: a JPEG goes in and the same bytes come out.
"""

from __future__ import annotations

import re
import zlib
from pathlib import Path

import pytest

from ipw.pdf import (
    PAGE_SIZES,
    Fit,
    Orientation,
    PdfDocument,
    Rect,
    StandardFont,
    TextBox,
    effective_dpi,
    embed_image,
)
from ipw.pdf.objects import Name, PdfWriter, Stream, serialise

INCH = 72.0


# ------------------------------------------------------------------- helpers --


def write_jpeg(path: Path, size: tuple[int, int] = (200, 150), quality: int = 88) -> bytes:
    from PIL import Image

    image = Image.new("RGB", size)
    pixels = image.load()
    assert pixels is not None
    for y in range(size[1]):
        for x in range(size[0]):
            pixels[x, y] = ((x * 3) % 256, (y * 5) % 256, (x + y) % 256)
    image.save(path, format="JPEG", quality=quality)
    return path.read_bytes()


def write_png(path: Path, size: tuple[int, int] = (120, 90), alpha: bool = False) -> bytes:
    from PIL import Image

    image = Image.new("RGBA" if alpha else "RGB", size, (200, 40, 60, 128 if alpha else 255))
    image.save(path, format="PNG")
    return path.read_bytes()


def parse_xref(raw: bytes) -> list[int]:
    """Every in-use offset the file's own cross-reference table declares."""
    marker = re.search(rb"startxref\s+(\d+)", raw[-2048:])
    assert marker is not None, "no startxref: the file has no cross-reference table"
    start = int(marker.group(1))
    assert raw[start : start + 4] == b"xref", "startxref does not point at an xref table"
    header = re.match(rb"xref\s+(\d+)\s+(\d+)\s+", raw[start:])
    assert header is not None, "the cross-reference table has no header"
    count = int(header.group(2))
    at = start + header.end()
    offsets = []
    for index in range(count):
        entry = raw[at + index * 20 : at + (index + 1) * 20]
        if entry[17:18] == b"n":
            offsets.append(int(entry[0:10]))
    return offsets


# ----------------------------------------------------------------- primitives --


class TestSerialisation:
    def test_names_and_references(self) -> None:
        assert serialise(Name("Page")) == b"/Page"
        from ipw.pdf.objects import Reference

        assert serialise(Reference(12)) == b"12 0 R"

    def test_floats_never_use_exponent_notation(self) -> None:
        """PDF has no exponent form; '1e-05' renders as a blank page."""
        assert b"e" not in serialise(0.00001)
        assert b"e" not in serialise(1e-7)

    def test_text_escaping_survives_hostile_punctuation(self) -> None:
        """An unbalanced parenthesis in a caption is the classic corrupter."""
        out = serialise("a (b) c \\ d")
        assert out.startswith(b"(")
        assert out.endswith(b")")
        assert out.count(b"\\(") == 1
        assert out.count(b"\\)") == 1
        assert b"\\\\" in out

    def test_non_latin_text_does_not_corrupt_the_stream(self) -> None:
        """The standard fonts cannot show it; the file must still be valid."""
        out = serialise("price: 12 € and 中文")
        assert out.startswith(b"(")
        assert out.endswith(b")")

    def test_a_stream_declares_the_filter_it_actually_used(self) -> None:
        data, dictionary = Stream({}, b"x" * 4096).encoded()
        assert dictionary["Filter"] == Name("FlateDecode")
        assert zlib.decompress(data) == b"x" * 4096
        assert dictionary["Length"] == len(data)

    def test_incompressible_data_is_left_alone(self) -> None:
        """Compressing noise enlarges it; the dictionary must then not claim Flate."""
        import os

        noise = os.urandom(64)
        _, dictionary = Stream({}, noise).encoded()
        assert "Filter" not in dictionary

    def test_pre_filtered_data_is_never_recompressed(self) -> None:
        """A JPEG arrives compressed. Touching it again would cost quality or size."""
        payload = b"\xff\xd8fake jpeg bytes\xff\xd9"
        data, dictionary = Stream({}, payload, compress=False, filters=("DCTDecode",)).encoded()
        assert data == payload
        assert dictionary["Filter"] == Name("DCTDecode")

    def test_an_unwritten_reservation_is_refused(self) -> None:
        """A dangling reference might open here and fail at the printer."""
        writer = PdfWriter()
        root = writer.add({"Type": Name("Catalog")})
        writer.reserve()
        with pytest.raises(ValueError, match="reserved but never written"):
            writer.build(root)


# ------------------------------------------------------------------ structure --


class TestFileStructure:
    @pytest.fixture
    def document(self, tmp_path: Path) -> bytes:
        write_jpeg(tmp_path / "a.jpg")
        write_png(tmp_path / "b.png")
        doc = PdfDocument(title="Structure", author="tests")
        doc.add_image_page(tmp_path / "a.jpg", size="a4", margin=24)
        doc.add_image_page(tmp_path / "b.png", size="letter")
        page = doc.add_page("a3", orientation=Orientation.LANDSCAPE, background=(1, 1, 0.9))
        page.texts.append(TextBox("hello", 100, 100, font=StandardFont.TIMES_BOLD))
        page.rects.append(Rect(10, 10, 100, 50, fill=(1, 0, 0), stroke=(0, 0, 1)))
        doc.add_page_numbers()
        return doc.render()

    def test_it_is_a_pdf(self, document: bytes) -> None:
        assert document.startswith(b"%PDF-1.7")
        assert document.rstrip().endswith(b"%%EOF")

    def test_it_declares_itself_binary(self, document: bytes) -> None:
        """Without the high-byte comment, text-mode transfer mangles the streams."""
        assert document[9:14].startswith(b"%\xe2\xe3\xcf\xd3")

    def test_every_xref_offset_lands_on_its_object(self, document: bytes) -> None:
        """What a reader actually does. One wrong offset breaks the file."""
        for index, offset in enumerate(parse_xref(document), start=1):
            head = document[offset : offset + 40]
            assert re.match(rb"\s*%d 0 obj" % index, head), (
                f"object {index} is not at offset {offset}: {head[:20]!r}"
            )

    def test_no_reference_dangles(self, document: bytes) -> None:
        declared = {int(m.group(1)) for m in re.finditer(rb"(?m)^(\d+) 0 obj", document)}
        referenced = {int(m.group(1)) for m in re.finditer(rb"(\d+) 0 R", document)}
        assert referenced - declared == set()

    def test_the_catalogue_and_page_tree_exist(self, document: bytes) -> None:
        assert b"/Type /Catalog" in document
        assert b"/Type /Pages" in document
        assert document.count(b"/Type /Page\n") + document.count(b"/Type /Page ") >= 3

    def test_metadata_is_written(self, document: bytes) -> None:
        assert b"/Producer" in document
        assert b"Structure" in document

    def test_an_empty_document_is_refused(self) -> None:
        with pytest.raises(ValueError, match="at least one page"):
            PdfDocument().render()


# -------------------------------------------------------- the quality promise --


class TestJpegPassesThroughUntouched:
    """The single most consequential behaviour in this package.

    Re-encoding costs a second lossy generation. On flat colour and hard line
    work - a textile print - that shows as ringing along every edge.
    """

    def test_the_source_bytes_appear_verbatim(self, tmp_path: Path) -> None:
        source = write_jpeg(tmp_path / "a.jpg", (300, 200))
        doc = PdfDocument()
        doc.add_image_page(tmp_path / "a.jpg")
        out = doc.render()

        middle = source[len(source) // 2 : len(source) // 2 + 600]
        assert middle in out, "the JPEG was altered on the way into the PDF"

    def test_it_is_declared_as_dctdecode(self, tmp_path: Path) -> None:
        write_jpeg(tmp_path / "a.jpg")
        doc = PdfDocument()
        doc.add_image_page(tmp_path / "a.jpg")
        assert b"DCTDecode" in doc.render()

    def test_the_embedder_reports_that_it_did_not_re_encode(self, tmp_path: Path) -> None:
        write_jpeg(tmp_path / "a.jpg")
        assert embed_image(tmp_path / "a.jpg").reencoded is False

    def test_the_overhead_is_structure_only(self, tmp_path: Path) -> None:
        """A one-image PDF should be the JPEG plus a page of scaffolding."""
        source = write_jpeg(tmp_path / "a.jpg", (600, 400))
        doc = PdfDocument()
        doc.add_image_page(tmp_path / "a.jpg")
        overhead = len(doc.render()) - len(source)
        assert 0 < overhead < 3000, f"unexpected overhead: {overhead} bytes"

    def test_dimensions_are_read_from_the_frame_header(self, tmp_path: Path) -> None:
        write_jpeg(tmp_path / "a.jpg", (321, 213))
        image = embed_image(tmp_path / "a.jpg")
        assert (image.width, image.height) == (321, 213)

    def test_a_progressive_jpeg_is_still_passed_through(self, tmp_path: Path) -> None:
        """Nine of the corpus files are progressive; SOF2 must be recognised."""
        from PIL import Image

        path = tmp_path / "p.jpg"
        Image.new("RGB", (150, 100), (30, 90, 200)).save(path, format="JPEG", progressive=True)
        image = embed_image(path)
        assert image.reencoded is False
        assert (image.width, image.height) == (150, 100)


class TestPngHandling:
    def test_a_png_is_re_packed_losslessly(self, tmp_path: Path) -> None:
        """PDF cannot carry PNG directly; the pixels still survive intact."""
        write_png(tmp_path / "b.png", (64, 48))
        image = embed_image(tmp_path / "b.png")
        assert image.reencoded is True
        assert (image.width, image.height) == (64, 48)
        assert image.colour_space == "DeviceRGB"

    def test_transparency_becomes_a_soft_mask(self, tmp_path: Path) -> None:
        """Flattening onto white would destroy the cut-out a designer needs."""
        write_png(tmp_path / "t.png", alpha=True)
        image = embed_image(tmp_path / "t.png")
        assert image.smask is not None

    def test_an_opaque_png_gets_no_pointless_mask(self, tmp_path: Path) -> None:
        write_png(tmp_path / "o.png", alpha=False)
        assert embed_image(tmp_path / "o.png").smask is None

    def test_a_soft_mask_reaches_the_file(self, tmp_path: Path) -> None:
        write_png(tmp_path / "t.png", alpha=True)
        doc = PdfDocument()
        doc.add_image_page(tmp_path / "t.png")
        assert b"/SMask" in doc.render()


# --------------------------------------------------------------- print sizing --


class TestPageSizes:
    def test_iso_sizes_are_exact(self) -> None:
        """A4 is 210x297mm. Rounding to '595 x 842' is visibly wrong when trimmed."""
        a4 = PAGE_SIZES["a4"]
        assert a4.width == pytest.approx(595.2756, abs=0.001)
        assert a4.height == pytest.approx(841.8898, abs=0.001)

    def test_us_sizes_are_exact(self) -> None:
        assert PAGE_SIZES["letter"].width == 8.5 * INCH
        assert PAGE_SIZES["tabloid"].height == 17 * INCH

    def test_orientation_swaps_only_when_needed(self) -> None:
        a4 = PAGE_SIZES["a4"]
        assert a4.oriented(Orientation.PORTRAIT) is a4
        landscape = a4.oriented(Orientation.LANDSCAPE)
        assert landscape.width > landscape.height
        assert landscape.oriented(Orientation.LANDSCAPE).width == landscape.width

    def test_the_media_box_matches_the_page(self, tmp_path: Path) -> None:
        doc = PdfDocument()
        doc.add_page("a4")
        assert b"/MediaBox [0 0 595.2756 841.8898]" in doc.render()


class TestEffectiveDpi:
    """The number that decides whether a print is worth running."""

    def test_it_is_derived_from_the_placement(self, tmp_path: Path) -> None:
        write_jpeg(tmp_path / "a.jpg", (3000, 3000))
        image = embed_image(tmp_path / "a.jpg")
        assert effective_dpi(image, 10 * INCH, 10 * INCH) == 300
        assert effective_dpi(image, 20 * INCH, 20 * INCH) == 150

    def test_the_same_image_is_fine_small_and_poor_large(self, tmp_path: Path) -> None:
        write_jpeg(tmp_path / "a.jpg", (1000, 1000))
        image = embed_image(tmp_path / "a.jpg")
        assert effective_dpi(image, 2 * INCH, 2 * INCH) >= 300
        assert effective_dpi(image, 18 * INCH, 18 * INCH) < 100

    def test_the_worse_axis_wins(self, tmp_path: Path) -> None:
        """A placement is only as good as its weakest direction."""
        write_jpeg(tmp_path / "a.jpg", (1200, 300))
        image = embed_image(tmp_path / "a.jpg")
        assert effective_dpi(image, 4 * INCH, 4 * INCH) == 75

    def test_a_zero_placement_does_not_divide_by_zero(self, tmp_path: Path) -> None:
        write_jpeg(tmp_path / "a.jpg")
        assert effective_dpi(embed_image(tmp_path / "a.jpg"), 0, 0) == 0

    def test_a_page_reports_the_dpi_of_what_it_holds(self, tmp_path: Path) -> None:
        write_jpeg(tmp_path / "a.jpg", (2480, 3508))
        doc = PdfDocument()
        page = doc.add_image_page(tmp_path / "a.jpg", size="a4", margin=0)
        assert page.dpi_of_images()[0] == pytest.approx(300, abs=3)


# ---------------------------------------------------------------- page layout --


class TestFitting:
    def test_contain_keeps_the_whole_image(self, tmp_path: Path) -> None:
        write_jpeg(tmp_path / "wide.jpg", (400, 100))
        doc = PdfDocument()
        page = doc.add_image_page(tmp_path / "wide.jpg", size="a4", fit=Fit.CONTAIN)
        placed = page.images[0]
        assert placed.width <= page.size.width + 0.01
        assert placed.height <= page.size.height + 0.01

    def test_cover_fills_the_page(self, tmp_path: Path) -> None:
        write_jpeg(tmp_path / "wide.jpg", (400, 100))
        doc = PdfDocument()
        page = doc.add_image_page(tmp_path / "wide.jpg", size="a4", fit=Fit.COVER)
        placed = page.images[0]
        assert placed.width >= page.size.width - 0.01
        assert placed.height >= page.size.height - 0.01

    def test_contain_preserves_the_aspect_ratio(self, tmp_path: Path) -> None:
        write_jpeg(tmp_path / "a.jpg", (300, 200))
        doc = PdfDocument()
        page = doc.add_image_page(tmp_path / "a.jpg", size="a4", fit=Fit.CONTAIN)
        placed = page.images[0]
        assert placed.width / placed.height == pytest.approx(1.5, abs=0.01)

    def test_stretch_does_not(self, tmp_path: Path) -> None:
        write_jpeg(tmp_path / "a.jpg", (300, 200))
        doc = PdfDocument()
        page = doc.add_image_page(tmp_path / "a.jpg", size="a4", fit=Fit.STRETCH, margin=0)
        placed = page.images[0]
        assert placed.width == pytest.approx(page.size.width)
        assert placed.height == pytest.approx(page.size.height)

    def test_the_image_is_centred_inside_the_margin(self, tmp_path: Path) -> None:
        write_jpeg(tmp_path / "a.jpg", (100, 100))
        doc = PdfDocument()
        page = doc.add_image_page(tmp_path / "a.jpg", size="a4", margin=36)
        placed = page.images[0]
        left = placed.x
        right = page.size.width - (placed.x + placed.width)
        assert left == pytest.approx(right, abs=0.01)

    def test_an_impossible_margin_is_refused(self, tmp_path: Path) -> None:
        write_jpeg(tmp_path / "a.jpg")
        doc = PdfDocument()
        page = doc.add_page("a5")
        with pytest.raises(ValueError, match="leaves no room"):
            page.place_image(embed_image(tmp_path / "a.jpg"), margin=500)

    def test_a_page_with_no_size_matches_the_image(self, tmp_path: Path) -> None:
        """Forcing a square design onto A4 adds bands nobody asked for."""
        write_jpeg(tmp_path / "sq.jpg", (800, 800))
        doc = PdfDocument()
        page = doc.add_image_page(tmp_path / "sq.jpg")
        assert page.size.width == pytest.approx(page.size.height)


class TestPageManagement:
    """PRODUCT_REQUIREMENTS section 19: add, delete, duplicate and reorder."""

    def _doc(self, tmp_path: Path) -> PdfDocument:
        doc = PdfDocument()
        for index in range(4):
            page = doc.add_page("a4")
            page.texts.append(TextBox(f"page-{index}", 50, 50))
        return doc

    def test_reorder(self, tmp_path: Path) -> None:
        doc = self._doc(tmp_path)
        doc.move_page(0, 2)
        assert [p.texts[0].text for p in doc.pages] == [
            "page-1",
            "page-2",
            "page-0",
            "page-3",
        ]

    def test_duplicate_is_independent(self, tmp_path: Path) -> None:
        doc = self._doc(tmp_path)
        copy = doc.duplicate_page(0)
        copy.texts[0].text = "changed"
        assert doc.pages[0].texts[0].text == "page-0"
        assert len(doc.pages) == 5

    def test_delete(self, tmp_path: Path) -> None:
        doc = self._doc(tmp_path)
        doc.delete_page(1)
        assert [p.texts[0].text for p in doc.pages] == ["page-0", "page-2", "page-3"]

    def test_page_numbers_can_skip_a_cover(self, tmp_path: Path) -> None:
        doc = self._doc(tmp_path)
        doc.add_page_numbers(skip_first=True)
        assert len(doc.pages[0].texts) == 1
        assert doc.pages[1].texts[-1].text == "2"

    def test_a_repeated_image_is_stored_once(self, tmp_path: Path) -> None:
        """A logo on thirty pages should not be thirty copies."""
        source = write_jpeg(tmp_path / "logo.jpg", (400, 400))
        doc = PdfDocument()
        image = embed_image(tmp_path / "logo.jpg")
        for _ in range(8):
            page = doc.add_page("a4")
            page.place_image(image, margin=100)
        out = doc.render()
        assert len(out) < len(source) * 2, "the image was embedded more than once"
        assert out.count(b"DCTDecode") == 1


class TestContentStream:
    def test_text_reaches_the_file(self, tmp_path: Path) -> None:
        doc = PdfDocument()
        page = doc.add_page("a4")
        page.texts.append(TextBox("Findable text", 72, 700))
        out = doc.render()
        assert b"/Type /Font" in out
        assert b"Helvetica" in out

    def test_only_the_fonts_used_are_embedded(self, tmp_path: Path) -> None:
        doc = PdfDocument()
        page = doc.add_page("a4")
        page.texts.append(TextBox("times", 10, 10, font=StandardFont.TIMES))
        out = doc.render()
        assert b"Times-Roman" in out
        assert b"Courier" not in out

    def test_a_filled_and_stroked_rect_uses_the_right_operator(self, tmp_path: Path) -> None:
        doc = PdfDocument()
        page = doc.add_page("a4")
        page.rects.append(Rect(0, 0, 10, 10, fill=(1, 0, 0), stroke=(0, 0, 1)))
        stream = doc._content(page, {})  # noqa: SLF001 - the operators are the behaviour
        assert b" re\nB\n" in stream

    def test_a_fill_only_rect_uses_f(self, tmp_path: Path) -> None:
        doc = PdfDocument()
        page = doc.add_page("a4")
        page.rects.append(Rect(0, 0, 10, 10, fill=(1, 0, 0)))
        assert b" re\nf\n" in doc._content(page, {})  # noqa: SLF001

    def test_rotation_emits_a_matrix(self, tmp_path: Path) -> None:
        write_jpeg(tmp_path / "a.jpg")
        doc = PdfDocument()
        page = doc.add_page("a4")
        page.place_image(embed_image(tmp_path / "a.jpg"), rotation=90)
        stream = doc._content(page, {id(page.images[0].image): "Im0"})  # noqa: SLF001
        assert stream.count(b" cm\n") >= 3, "a rotated placement needs a composed matrix"

    def test_graphics_state_is_balanced(self, tmp_path: Path) -> None:
        """Unbalanced q/Q leaks a transform onto everything drawn after it."""
        write_jpeg(tmp_path / "a.jpg")
        doc = PdfDocument()
        page = doc.add_page("a4", background=(1, 1, 1))
        page.place_image(embed_image(tmp_path / "a.jpg"), margin=20)
        page.rects.append(Rect(0, 0, 5, 5, fill=(0, 0, 0)))
        stream = doc._content(page, {id(page.images[0].image): "Im0"})  # noqa: SLF001
        assert stream.count(b"q\n") + stream.count(b"q ") == stream.count(b"Q\n") + stream.count(
            b" Q "
        )
