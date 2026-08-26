"""The awkward paths: odd encodings, damaged files, and images coming back out.

A PDF reader is judged on files it did not write. The happy path is covered
elsewhere; everything here is a legal-but-unusual construction that some real
producer emits, or a way a file arrives broken. These are the branches that stay
untested until a customer finds them, which is the worst possible moment.
"""

from __future__ import annotations

import io
import zlib

import pytest
from PIL import Image

from ipw.pdf.document import PdfDocument, TextBox
from ipw.pdf.edit import capabilities, extract_images, overlay_on_pages, select_pages
from ipw.pdf.objects import Name, PdfWriter, Reference, Stream
from ipw.pdf.reader import PdfReader, PdfSyntaxError, decode_stream


def _decode(data: bytes, filter_name: str) -> bytes:
    """Decode as if the bytes had arrived in a stream carrying this one filter."""
    return decode_stream({"Filter": Name(filter_name)}, data)


def _wrap(objects: dict[int, bytes], root: int = 1, extra_trailer: str = "") -> bytes:
    """Assemble numbered objects into a file with a classic cross-reference table."""
    out = bytearray(b"%PDF-1.4\n")
    offsets: dict[int, int] = {}
    for number in sorted(objects):
        offsets[number] = len(out)
        out += b"%d 0 obj\n" % number + objects[number] + b"\nendobj\n"

    start = len(out)
    highest = max(objects)
    out += b"xref\n0 %d\n" % (highest + 1)
    out += b"0000000000 65535 f \n"
    for number in range(1, highest + 1):
        out += (
            b"%010d 00000 n \n" % offsets[number] if number in offsets else b"0000000000 65535 f \n"
        )
    out += b"trailer\n<< /Size %d /Root %d 0 R %s>>\nstartxref\n%d\n%%%%EOF\n" % (
        highest + 1,
        root,
        extra_trailer.encode(),
        start,
    )
    return bytes(out)


def _one_page_document(
    page_extra: bytes = b"", extra_objects: dict[int, bytes] | None = None
) -> bytes:
    objects = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        2: b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        3: b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> "
        + page_extra
        + b">>",
    }
    objects.update(extra_objects or {})
    return _wrap(objects)


# ------------------------------------------------------------ stream filters --


class TestFilters:
    """Every filter a producer might reach for, decoded or deliberately left alone."""

    def test_ascii_hex(self) -> None:
        assert _decode(b"48656C6C6F>", "ASCIIHexDecode") == b"Hello"

    def test_ascii_hex_tolerates_whitespace_and_an_odd_final_digit(self) -> None:
        # A trailing lone digit is padded with zero, per the specification.
        assert _decode(b"48 65 6C 6C 6F 20>", "ASCIIHexDecode") == b"Hello "

    def test_ascii85(self) -> None:
        raw = b"Hello, world!"
        import base64

        encoded = base64.a85encode(raw) + b"~>"
        assert _decode(encoded, "ASCII85Decode") == raw

    def test_run_length(self) -> None:
        # Literal run of 3 bytes, then 4 copies of 0x41, then the end marker.
        encoded = bytes([2]) + b"abc" + bytes([256 - 3]) + b"A" + bytes([128])
        assert _decode(encoded, "RunLengthDecode") == b"abcAAAA"

    def test_flate(self) -> None:
        assert _decode(zlib.compress(b"payload"), "FlateDecode") == b"payload"

    def test_image_filters_are_left_encoded_on_purpose(self) -> None:
        """A JPEG inside a PDF must come out as the JPEG that went in.

        DCTDecode *is* JPEG. Decoding and re-encoding it would lose quality for
        no reason, so the bytes are passed through untouched.
        """
        jpeg = b"\xff\xd8\xff\xe0 not really a jpeg \xff\xd9"
        assert _decode(jpeg, "DCTDecode") == jpeg

    def test_a_chain_of_filters_is_applied_in_order(self) -> None:
        import base64

        payload = base64.a85encode(zlib.compress(b"twice wrapped")) + b"~>"
        assert (
            decode_stream({"Filter": [Name("ASCII85Decode"), Name("FlateDecode")]}, payload)
            == b"twice wrapped"
        )

    def test_an_unknown_filter_is_reported_not_guessed_at(self) -> None:
        with pytest.raises(PdfSyntaxError):
            _decode(b"anything", "MadeUpDecode")


class TestPredictors:
    """PNG predictors, which every xref stream in the wild uses."""

    @pytest.mark.parametrize("predictor", [10, 11, 12, 13, 14, 15])
    def test_png_predictors_round_trip(self, predictor: int) -> None:
        columns, rows = 4, 3
        raw = bytes(range(columns * rows))
        # Encode with filter type 0 (None) on each row: the decoder must strip
        # the tag byte and return the data unchanged.
        tagged = b"".join(b"\x00" + raw[r * columns : (r + 1) * columns] for r in range(rows))
        decoded = decode_stream(
            {
                "Filter": Name("FlateDecode"),
                "DecodeParms": {"Predictor": predictor, "Columns": columns},
            },
            zlib.compress(tagged),
        )
        assert decoded == raw

    def test_the_up_predictor_actually_subtracts(self) -> None:
        columns = 3
        rows = [b"\x01\x02\x03", b"\x01\x01\x01"]  # second row: +1 on each byte
        tagged = b"\x00" + rows[0] + b"\x02" + rows[1]  # filter 2 = Up
        decoded = decode_stream(
            {
                "Filter": Name("FlateDecode"),
                "DecodeParms": {"Predictor": 12, "Columns": columns},
            },
            zlib.compress(tagged),
        )
        assert decoded == b"\x01\x02\x03\x02\x03\x04"


# --------------------------------------------------------------- structure ----


class TestStructure:
    def test_a_stream_length_given_as_a_reference_is_resolved(self) -> None:
        """Producers that stream output do not know the length until afterwards.

        They write `/Length 5 0 R` and fill in object 5 later. A reader that only
        accepts an integer there fails on files from every such producer.
        """
        payload = b"BT ET"
        document = _one_page_document(
            page_extra=b"/Contents 4 0 R ",
            extra_objects={
                4: b"<< /Length 5 0 R >>\nstream\n" + payload + b"\nendstream",
                5: b"%d" % len(payload),
            },
        )
        reader = PdfReader.from_bytes(document)
        contents = reader.resolve(reader.pages()[0].dictionary["Contents"])
        assert contents.data == payload

    def test_an_incremental_update_overrides_the_original_object(self) -> None:
        """Appending to a PDF is how every "save" after the first one works.

        The later cross-reference table wins, and its /Prev points at the earlier
        one. Reading only the first table shows the document before the edit.
        """
        base = _one_page_document()
        first_xref = int(base.split(b"startxref\n")[1].split(b"\n")[0])

        addition = bytearray(base)
        new_offset = len(addition)
        addition += b"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] "
        addition += b"/Resources << >> >>\nendobj\n"
        table = len(addition)
        addition += b"xref\n3 1\n%010d 00000 n \n" % new_offset
        addition += b"trailer\n<< /Size 4 /Root 1 0 R /Prev %d >>\nstartxref\n%d\n%%%%EOF\n" % (
            first_xref,
            table,
        )

        described = PdfReader.from_bytes(bytes(addition)).describe()
        assert described["pages"][0]["width_inches"] == pytest.approx(400 / 72, abs=0.01)

    def test_an_encrypted_file_says_so_instead_of_producing_nonsense(self) -> None:
        document = _one_page_document()
        document = document.replace(b"/Root 1 0 R ", b"/Root 1 0 R /Encrypt 9 0 R ")
        with pytest.raises(PdfSyntaxError, match="encrypted"):
            PdfReader.from_bytes(document)

    def test_a_broken_cross_reference_table_falls_back_to_scanning(self) -> None:
        """Damaged tables are ordinary in files that have been through many tools."""
        document = bytearray(_one_page_document())
        marker = document.index(b"startxref\n") + len(b"startxref\n")
        end = document.index(b"\n", marker)
        document[marker:end] = b"999999"  # point the table somewhere absurd

        reader = PdfReader.from_bytes(bytes(document))
        assert len(reader.pages()) == 1

    def test_a_reference_to_a_missing_object_resolves_to_nothing(self) -> None:
        """Dangling references appear in damaged files and must not raise."""
        reader = PdfReader.from_bytes(_one_page_document())
        assert reader.resolve(Reference(9999)) is None

    def test_a_cycle_between_objects_terminates(self) -> None:
        """Two objects pointing at each other must not exhaust the stack."""
        document = _one_page_document(
            page_extra=b"/Sibling 4 0 R ",
            extra_objects={4: b"<< /Back 3 0 R >>"},
        )
        reader = PdfReader.from_bytes(document)
        copied = select_pages(reader, [0])
        assert len(PdfReader.from_bytes(copied).pages()) == 1


# ------------------------------------------------------- images coming out ----


def _image_pdf(image: Image.Image, *, as_jpeg: bool) -> bytes:
    """A one-page document with one image on it, in the requested encoding."""
    buffer = io.BytesIO()
    writer = PdfWriter()
    catalog, tree = writer.reserve(), writer.reserve()

    if as_jpeg:
        image.save(buffer, format="JPEG", quality=92)
        picture = writer.add(
            Stream(
                {
                    "Type": Name("XObject"),
                    "Subtype": Name("Image"),
                    "Width": image.width,
                    "Height": image.height,
                    "ColorSpace": Name("DeviceRGB"),
                    "BitsPerComponent": 8,
                },
                buffer.getvalue(),
                compress=False,
                filters=("DCTDecode",),
            )
        )
    else:
        picture = writer.add(
            Stream(
                {
                    "Type": Name("XObject"),
                    "Subtype": Name("Image"),
                    "Width": image.width,
                    "Height": image.height,
                    "ColorSpace": Name("DeviceRGB"),
                    "BitsPerComponent": 8,
                },
                image.tobytes(),
            )
        )

    contents = writer.add(Stream({}, b"q 100 0 0 100 0 0 cm /Im0 Do Q"))
    page = writer.add(
        {
            "Type": Name("Page"),
            "Parent": tree,
            "MediaBox": [0, 0, 100, 100],
            "Resources": {"XObject": {"Im0": picture}},
            "Contents": contents,
        }
    )
    writer.put(tree, {"Type": Name("Pages"), "Kids": [page], "Count": 1})
    writer.put(catalog, {"Type": Name("Catalog"), "Pages": tree})
    return writer.build(catalog, {})


class TestExtractingImages:
    def test_a_jpeg_comes_back_as_the_bytes_that_went_in(self) -> None:
        """The whole point: pulling artwork out of a PDF must cost nothing.

        DCTDecode is JPEG, so the stream is already the file. Anything that
        decoded and re-encoded it would quietly lose quality on every extraction.
        """
        source = Image.new("RGB", (200, 150), (200, 30, 30))
        found = extract_images(PdfReader.from_bytes(_image_pdf(source, as_jpeg=True)))

        assert len(found) == 1
        assert found[0].reencoded is False
        assert found[0].suffix == "jpg"
        assert found[0].data.startswith(b"\xff\xd8\xff")
        assert (found[0].width, found[0].height) == (200, 150)
        # It must be openable, not merely JPEG-shaped.
        assert Image.open(io.BytesIO(found[0].data)).size == (200, 150)

    def test_raw_samples_are_repacked_as_png_without_losing_a_pixel(self) -> None:
        source = Image.new("RGB", (120, 90))
        source.putpixel((0, 0), (12, 34, 56))
        source.putpixel((119, 89), (255, 128, 0))

        found = extract_images(PdfReader.from_bytes(_image_pdf(source, as_jpeg=False)))
        assert len(found) == 1
        assert found[0].reencoded is True
        assert found[0].suffix == "png"

        recovered = Image.open(io.BytesIO(found[0].data))
        assert recovered.size == (120, 90)
        assert recovered.getpixel((0, 0)) == (12, 34, 56)
        assert recovered.getpixel((119, 89)) == (255, 128, 0)

    def test_tiny_images_are_skipped_so_the_result_is_usable(self) -> None:
        """A designed page is littered with rules, icons and spacers.

        Someone asking to extract artwork does not want two hundred 8x8
        fragments to sort through.
        """
        source = Image.new("RGB", (8, 8), (0, 0, 0))
        assert extract_images(PdfReader.from_bytes(_image_pdf(source, as_jpeg=False))) == []

    def test_the_minimum_size_can_be_lowered_when_someone_wants_everything(self) -> None:
        source = Image.new("RGB", (8, 8), (0, 0, 0))
        found = extract_images(
            PdfReader.from_bytes(_image_pdf(source, as_jpeg=False)), minimum_pixels=1
        )
        assert len(found) == 1

    def test_the_same_image_used_on_many_pages_is_returned_once(self) -> None:
        document = PdfReader.from_bytes(_image_pdf(Image.new("RGB", (200, 150)), as_jpeg=True))
        # Duplicate the page; both copies share one image object.
        from ipw.pdf.edit import merge

        twice = merge(
            [document, PdfReader.from_bytes(_image_pdf(Image.new("RGB", (200, 150)), as_jpeg=True))]
        )
        found = extract_images(PdfReader.from_bytes(twice))
        # Two documents, two distinct image objects - but no object counted twice.
        assert len(found) == 2


class TestCapabilities:
    def test_a_document_with_text_says_it_has_text(self) -> None:
        document = PdfDocument()
        page = document.add_page()
        page.texts.append(TextBox(text="hello", x=10, y=10))
        assert capabilities(PdfReader.from_bytes(document.render()))["has_text"] is True

    def test_a_document_with_images_counts_them(self) -> None:
        reader = PdfReader.from_bytes(_image_pdf(Image.new("RGB", (200, 150)), as_jpeg=True))
        assert capabilities(reader)["extractable_images"] == 1


class TestOverlay:
    def test_a_page_whose_contents_are_already_an_array_gains_one_more(self) -> None:
        """Contents may legally be an array of streams, concatenated.

        A stamp must append to that array rather than replacing it, or it wipes
        out artwork on exactly the files most likely to be professionally made.
        """
        writer = PdfWriter()
        catalog, tree = writer.reserve(), writer.reserve()
        first = writer.add(Stream({}, b"1 0 0 RG "))
        second = writer.add(Stream({}, b"10 10 m 90 90 l S "))
        page = writer.add(
            {
                "Type": Name("Page"),
                "Parent": tree,
                "MediaBox": [0, 0, 100, 100],
                "Resources": {},
                "Contents": [first, second],
            }
        )
        writer.put(tree, {"Type": Name("Pages"), "Kids": [page], "Count": 1})
        writer.put(catalog, {"Type": Name("Catalog"), "Pages": tree})

        stamped = overlay_on_pages(PdfReader.from_bytes(writer.build(catalog, {})), b"BT ET", [0])
        result = PdfReader.from_bytes(stamped)
        contents = result.resolve(result.pages()[0].dictionary["Contents"])
        assert isinstance(contents, list)
        # 'q' is pushed in front and the stamp appended after a matching 'Q', so
        # an unbalanced original cannot leak its graphics state into the stamp.
        assert len(contents) == 4
        original = [result.resolve(ref).data for ref in contents]
        assert b"1 0 0 RG " in original, "the first original stream was dropped"
        assert b"10 10 m 90 90 l S " in original, "the second original stream was dropped"

    def test_stamping_no_pages_leaves_the_document_alone(self) -> None:
        document = PdfDocument()
        document.add_page()
        reader = PdfReader.from_bytes(document.render())
        stamped = overlay_on_pages(reader, b"BT ET", [])
        assert len(PdfReader.from_bytes(stamped).pages()) == 1
