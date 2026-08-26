"""The PDF routes, driven over a real socket the way the browser drives them.

Testing the service object alone would leave the layer most likely to break
untouched: base64 decoding, JSON coercion, dispatch, and the mapping from a
raised ValueError to a 400 with a sentence a human can act on. Those are the
parts a customer meets first when something goes wrong.

The documents here are generated rather than loaded from a corpus, so the suite
runs anywhere. Behaviour against real Illustrator output is covered separately.
"""

from __future__ import annotations

import base64
import json
import re
import threading
import urllib.error
import urllib.request
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from ipw.pdf.document import PageSize, PdfDocument, TextBox
from ipw.workspace_api.http import build_server

APP_ROOT = Path(__file__).resolve().parents[3] / "apps" / "workspace"


@pytest.fixture(scope="module")
def base_url() -> Iterator[str]:
    server = build_server(APP_ROOT, port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


def post(base: str, route: str, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    request = urllib.request.Request(  # noqa: S310 - localhost, built above
        base + route,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


def a_pdf(pages: int = 6) -> dict[str, str]:
    document = PdfDocument(title="Test")
    for index in range(pages):
        page = document.add_page()
        page.texts.append(TextBox(text=f"page {index + 1}", x=72, y=72))
    return {
        "pdf": "data:application/pdf;base64," + base64.b64encode(document.render()).decode("ascii"),
        "filename": "test.pdf",
    }


class TestInspect:
    def test_reports_the_document_and_what_can_be_done_to_it(self, base_url: str) -> None:
        status, body = post(base_url, "/api/pdf/inspect", a_pdf(6))
        assert status == 200
        assert body["ok"] is True
        assert body["document"]["page_count"] == 6
        assert body["capabilities"]["supported"]["merge"] is True

    def test_states_the_limits_without_being_asked(self, base_url: str) -> None:
        """A customer should learn the boundary from the screen, not by failing.

        PRODUCT_REQUIREMENTS section 19 allows editing existing content "only
        when technically supported, with honest limitations". A capability list
        that only listed capabilities would meet the letter and miss the point.
        """
        _, body = post(base_url, "/api/pdf/inspect", a_pdf(2))
        assert "edit_existing_text" in body["capabilities"]["not_supported"]
        assert "edit_existing_vector_artwork" in body["capabilities"]["not_supported"]

    def test_a_damaged_file_is_explained_not_crashed_on(self, base_url: str) -> None:
        status, body = post(
            base_url,
            "/api/pdf/inspect",
            {"pdf": base64.b64encode(b"not a pdf at all").decode(), "filename": "x.pdf"},
        )
        assert status == 200
        assert body["ok"] is False
        assert "PDF" in body["error"]


class TestEdit:
    @pytest.mark.parametrize(
        ("payload", "expected_pages"),
        [
            ({"operation": "split", "pages": [1, 2]}, 2),
            ({"operation": "delete_pages", "pages": [1]}, 5),
            ({"operation": "rotate", "pages": [1], "degrees": 90}, 6),
            ({"operation": "stamp", "pages": [1], "text": "DRAFT"}, 6),
            ({"operation": "reorder", "order": [6, 5, 4, 3, 2, 1]}, 6),
        ],
    )
    def test_each_operation_returns_a_document_that_reopens(
        self, base_url: str, payload: dict[str, Any], expected_pages: int
    ) -> None:
        status, body = post(base_url, "/api/pdf/edit", {"documents": [a_pdf(6)], **payload})
        assert status == 200, body
        assert body["page_count"] == expected_pages

        # The result must survive a round trip, not merely be returned.
        status, again = post(
            base_url, "/api/pdf/inspect", {"pdf": body["pdf"], "filename": "again.pdf"}
        )
        assert again["ok"] is True
        assert again["document"]["page_count"] == expected_pages

    def test_merging_joins_both_documents(self, base_url: str) -> None:
        status, body = post(
            base_url,
            "/api/pdf/edit",
            {"documents": [a_pdf(3), a_pdf(4)], "operation": "merge"},
        )
        assert status == 200, body
        assert body["page_count"] == 7

    def test_page_numbers_are_one_based_because_that_is_what_people_see(
        self, base_url: str
    ) -> None:
        """Page 1 must mean the first page, not the second.

        An off-by-one here is invisible in testing and obvious to a customer who
        asked for page 1 and got page 2, so it is pinned rather than assumed.
        """
        _, body = post(
            base_url, "/api/pdf/edit", {"documents": [a_pdf(6)], "operation": "split", "pages": [1]}
        )
        assert body["page_count"] == 1
        _, whole = post(
            base_url,
            "/api/pdf/edit",
            {"documents": [a_pdf(6)], "operation": "delete_pages", "pages": [6]},
        )
        assert whole["page_count"] == 5


class TestRefusals:
    """Every refusal must name what is wrong and be a 400, not a 500.

    A 500 says the server broke; a 400 says the request was wrong. Confusing the
    two sends a customer to support for something they could have fixed.
    """

    @pytest.mark.parametrize(
        ("payload", "fragment"),
        [
            ({"operation": "split", "pages": [99]}, "does not exist"),
            ({"operation": "frobnicate"}, "unknown PDF operation"),
            ({"operation": "delete_pages", "pages": [1, 2, 3, 4, 5, 6]}, "every page"),
            ({"operation": "stamp", "text": "   "}, "needs some text"),
            ({"operation": "merge"}, "at least two"),
            ({"operation": "rotate", "pages": [1], "degrees": 45}, "multiple of 90"),
            ({"operation": "split", "pages": ["banana"]}, "not a page number"),
        ],
    )
    def test_bad_requests_are_explained(
        self, base_url: str, payload: dict[str, Any], fragment: str
    ) -> None:
        status, body = post(base_url, "/api/pdf/edit", {"documents": [a_pdf(6)], **payload})
        assert status == 400, body
        assert fragment in body["error"], body["error"]
        assert "Traceback" not in body["error"]

    def test_a_request_with_no_document_is_refused(self, base_url: str) -> None:
        status, body = post(base_url, "/api/pdf/edit", {"documents": [], "operation": "split"})
        assert status == 400
        assert "no PDF" in body["error"]


class TestSizeHonesty:
    def test_splitting_returns_a_proportionally_smaller_file(self, base_url: str) -> None:
        """The bug this pins shipped nothing but correct output.

        Copying a page follows its references, and a page references its parent,
        whose /Kids lists every other page - so a four-page split of a 20.9 MB
        document came back at 20.8 MB. Every assertion about page counts passed.
        """
        document = a_pdf(20)
        original = len(base64.b64decode(document["pdf"].split(",", 1)[1]))
        _, body = post(
            base_url, "/api/pdf/edit", {"documents": [document], "operation": "split", "pages": [1]}
        )
        assert body["bytes"] < original * 0.30, body["note"]

    def test_the_note_explains_the_size_change(self, base_url: str) -> None:
        _, body = post(
            base_url,
            "/api/pdf/edit",
            {"documents": [a_pdf(8)], "operation": "split", "pages": [1, 2]},
        )
        assert "quality" in body["note"].lower()
        assert "MB" in body["note"]


class TestStampGeometry:
    """Where the watermark lands, which no page count can check.

    The first version of this scaled the font from the page's shorter side and
    put "SAMPLE" at 501pt on a 1288pt-wide page: 1563pt of glyphs starting at
    x=-197, entirely off the left edge. Every page-count assertion still passed,
    which is exactly why the position needs its own test.
    """

    @staticmethod
    def _placement(text: str, width_pt: float, height_pt: float) -> tuple[float, float, float]:
        from ipw.pdf.reader import PdfReader
        from ipw.workspace_api.server import _stamp_stream

        document = PdfDocument()
        document.add_page(size=PageSize("test", width_pt, height_pt))
        stream = _stamp_stream(text, PdfReader.from_bytes(document.render()), [0]).decode("latin-1")

        # A stream that does not match is a failure worth naming here rather
        # than an AttributeError on None three lines later.
        font = re.search(r"Helvetica ([\d.]+) Tf", stream)
        position = re.search(r"1 0 0 1 ([-\d.]+) ([-\d.]+) Tm", stream)
        assert font is not None, f"no font operator in the stamp: {stream[:120]}"
        assert position is not None, f"no text matrix in the stamp: {stream[:120]}"

        size = float(font.group(1))
        x, y = (float(value) for value in position.groups())
        return size, x, y

    @pytest.mark.parametrize(
        "text", ["X", "DRAFT", "SAMPLE", "CONFIDENTIAL - DO NOT PRINT", "A" * 40]
    )
    @pytest.mark.parametrize(
        ("width", "height"), [(1288, 1520), (595, 842), (842, 595), (200, 200)]
    )
    def test_the_stamp_stays_on_the_page(self, text: str, width: float, height: float) -> None:
        from ipw.pdf.document import StandardFont, text_width

        size, x, y = self._placement(text, width, height)
        span = text_width(text, size, StandardFont.HELVETICA)

        assert x >= 0, f"stamp starts {abs(x):.0f}pt off the left edge"
        assert x + span <= width + 1, f"stamp runs {x + span - width:.0f}pt past the right edge"
        assert 0 <= y <= height, "stamp is above or below the page"
        # Readability is judged against the page, not an absolute point size:
        # a stamp spanning most of its page reads the same at any page size.
        # Very short text hits the height cap first - a lone letter set to 70%
        # of the width would be taller than the page - so either bound counts.
        assert span >= width * 0.4 or size >= height * 0.45, (
            f"stamp is too small for its page: {span:.0f}pt of glyphs at "
            f"{size:.0f}pt on a {width:.0f}x{height:.0f}pt page"
        )

    def test_a_longer_stamp_is_set_smaller_not_wider(self) -> None:
        short, _, _ = self._placement("DRAFT", 595, 842)
        long, _, _ = self._placement("CONFIDENTIAL - DO NOT DISTRIBUTE", 595, 842)
        assert long < short, "the font must shrink as the text grows, or it overflows"

    def test_brackets_in_the_text_cannot_break_the_content_stream(self) -> None:
        """`(` and `)` delimit PDF strings; unescaped, they corrupt the page."""
        from ipw.pdf.reader import PdfReader
        from ipw.workspace_api.server import _stamp_stream

        document = PdfDocument()
        document.add_page()
        reader = PdfReader.from_bytes(document.render())
        stream = _stamp_stream(r"DRAFT (v2) \ final", reader, [0]).decode("latin-1")

        body = stream[stream.index("Tm ") + 3 : stream.index(" Tj")]
        assert body.startswith("(")
        assert body.endswith(")")
        # Every interior parenthesis must be escaped, or a reader stops early.
        assert r"\(" in body
        assert r"\)" in body


class TestThumbnails:
    """Previews only where one honestly exists, and small enough to send."""

    @staticmethod
    def _scan(pages: int = 3) -> dict[str, str]:
        """A document whose every page is one full-page image, like a scan."""
        import io

        from PIL import Image

        from ipw.pdf.objects import Name, PdfWriter, Stream

        writer = PdfWriter()
        catalog, tree = writer.reserve(), writer.reserve()
        kids = []
        for index in range(pages):
            picture = Image.new("RGB", (850, 1100), (250, 248 - index, 240))
            buffer = io.BytesIO()
            picture.save(buffer, format="JPEG", quality=85)
            embedded = writer.add(
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
            kids.append(
                writer.add(
                    {
                        "Type": Name("Page"),
                        "Parent": tree,
                        "MediaBox": [0, 0, 612, 792],
                        "Resources": {"XObject": {"Im0": embedded}},
                        "Contents": contents,
                    }
                )
            )
        writer.put(tree, {"Type": Name("Pages"), "Kids": kids, "Count": len(kids)})
        writer.put(catalog, {"Type": Name("Catalog"), "Pages": tree})
        return {
            "pdf": "data:application/pdf;base64,"
            + base64.b64encode(writer.build(catalog, {})).decode("ascii"),
            "filename": "scan.pdf",
        }

    def test_a_scanned_page_gets_a_preview(self, base_url: str) -> None:
        status, body = post(base_url, "/api/pdf/thumbnails", self._scan(3))
        assert status == 200, body
        assert set(body["thumbnails"]) == {"1", "2", "3"}
        assert all(v.startswith("data:image/jpeg;base64,") for v in body["thumbnails"].values())

    def test_previews_are_downsized_not_the_originals(self, base_url: str) -> None:
        """The whole reason this route exists.

        Sending the images at their original resolution works on a two-page
        document and sends hundreds of megabytes for a hundred-page scan.
        """
        scan = self._scan(3)
        original = len(base64.b64decode(scan["pdf"].split(",", 1)[1]))
        _, body = post(base_url, "/api/pdf/thumbnails", scan)
        assert body["bytes"] < original / 4, "previews are not meaningfully smaller"

    def test_a_vector_page_gets_no_preview_and_is_told_why(self, base_url: str) -> None:
        """A guessed preview that differs from the print is worse than none."""
        status, body = post(base_url, "/api/pdf/thumbnails", a_pdf(4))
        assert status == 200
        assert body["thumbnails"] == {}
        assert "vector" in body["note"]

    def test_a_damaged_file_is_refused_with_a_reason(self, base_url: str) -> None:
        status, body = post(
            base_url, "/api/pdf/thumbnails", {"pdf": base64.b64encode(b"junk").decode()}
        )
        assert status == 400
        assert "PDF" in body["error"]


class TestRedactRoutes:
    """Redaction over HTTP, judged by whether the words are gone from the bytes."""

    @staticmethod
    def _bundle(pages: int = 4) -> dict[str, str]:
        document = PdfDocument(title="Bundle")
        for index in range(pages):
            page = document.add_page()
            page.texts.append(TextBox(text=f"Page {index + 1}", x=72, y=740))
            page.texts.append(TextBox(text="Claimant: Jane Doe of 14 Elm Road", x=72, y=700))
            page.texts.append(TextBox(text="This paragraph survives.", x=72, y=660))
        return {
            "pdf": "data:application/pdf;base64,"
            + base64.b64encode(document.render()).decode("ascii"),
            "filename": "bundle.pdf",
        }

    def test_search_reports_where_a_phrase_appears(self, base_url: str) -> None:
        status, body = post(base_url, "/api/pdf/search", {**self._bundle(), "phrase": "Jane Doe"})
        assert status == 200, body
        assert body["count"] == 4
        assert body["pages"] == [1, 2, 3, 4]

    def test_search_changes_nothing(self, base_url: str) -> None:
        """Looking must never be the same action as removing."""
        document = self._bundle()
        post(base_url, "/api/pdf/search", {**document, "phrase": "Jane Doe"})
        _, again = post(base_url, "/api/pdf/search", {**document, "phrase": "Jane Doe"})
        assert again["count"] == 4

    def test_search_says_so_when_a_phrase_is_absent(self, base_url: str) -> None:
        """And points at the reason it is usually absent: the page is a scan."""
        _, body = post(base_url, "/api/pdf/search", {**self._bundle(), "phrase": "nowhere"})
        assert body["count"] == 0
        assert "scan" in body["note"]

    def test_redaction_removes_the_words_from_the_returned_file(self, base_url: str) -> None:
        from ipw.pdf.redact import verify

        status, body = post(
            base_url, "/api/pdf/redact", {**self._bundle(), "phrases": ["Jane Doe"]}
        )
        assert status == 200, body
        data = base64.b64decode(body["pdf"].split(",", 1)[1])
        assert verify(data, ["Jane Doe"]) == []
        assert b"Jane" not in data

    def test_the_response_reports_its_own_verification(self, base_url: str) -> None:
        """The API must not merely do it - it must say whether it checked.

        A caller integrating this needs a machine-readable answer to 'is this
        file safe to release', not a sentence of prose to parse.
        """
        _, body = post(base_url, "/api/pdf/redact", {**self._bundle(), "phrases": ["Jane Doe"]})
        assert body["verified"] is True
        assert body["still_present"] == []
        assert body["characters_removed"] > 0

    def test_surrounding_text_survives(self, base_url: str) -> None:
        _, body = post(base_url, "/api/pdf/redact", {**self._bundle(), "phrases": ["Jane Doe"]})
        _, found = post(
            base_url, "/api/pdf/search", {"pdf": body["pdf"], "phrase": "This paragraph survives."}
        )
        assert found["count"] == 4

    def test_a_drawn_area_is_accepted_too(self, base_url: str) -> None:
        """Scans have no text to search, so an area is the only way in."""
        status, body = post(
            base_url,
            "/api/pdf/redact",
            {
                **self._bundle(1),
                "areas": [{"page": 1, "left": 60, "bottom": 690, "right": 400, "top": 715}],
            },
        )
        assert status == 200, body
        assert body["areas_redacted"] == 1
        assert b"Jane" not in base64.b64decode(body["pdf"].split(",", 1)[1])

    def test_nothing_matching_is_reported_rather_than_implied(self, base_url: str) -> None:
        """The most dangerous outcome to get wrong in the interface."""
        _, body = post(
            base_url, "/api/pdf/redact", {**self._bundle(), "phrases": ["not in this file"]}
        )
        assert body["areas_redacted"] == 0
        assert "Nothing matched" in body["note"]

    def test_asking_for_neither_words_nor_an_area_is_refused(self, base_url: str) -> None:
        status, body = post(base_url, "/api/pdf/redact", self._bundle())
        assert status == 400
        assert "words" in body["error"]

    def test_an_empty_search_phrase_is_refused(self, base_url: str) -> None:
        status, body = post(base_url, "/api/pdf/search", {**self._bundle(), "phrase": "   "})
        assert status == 400
        assert "type the words" in body["error"].lower()


class TestCompressRoute:
    """Getting under a limit over HTTP, and being told the truth about it."""

    @staticmethod
    def _scan(pages: int = 2) -> dict[str, str]:
        """Pages of 300-DPI scans on A4 - the shape of the real problem.

        Built here rather than imported from the pdf package's tests: test
        directories are not importable across workspaces, and a shared fixture
        module would couple two suites that are meant to be able to run alone.
        """
        import io

        from PIL import Image, ImageDraw

        from ipw.pdf.objects import Name, PdfWriter, Stream

        writer = PdfWriter()
        catalog, tree = writer.reserve(), writer.reserve()
        kids = []
        for index in range(pages):
            picture = Image.new("RGB", (2550, 3300), (252, 250, 246))
            draw = ImageDraw.Draw(picture)
            for y in range(200, 3000, 90):
                draw.rectangle([200, y, 2350, y + 40], fill=(40 + index, 40, 50))
            buffer = io.BytesIO()
            picture.save(buffer, format="JPEG", quality=95)
            image = writer.add(
                Stream(
                    {
                        "Type": Name("XObject"),
                        "Subtype": Name("Image"),
                        "Width": 2550,
                        "Height": 3300,
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
        return {
            "pdf": "data:application/pdf;base64,"
            + base64.b64encode(writer.build(catalog, {})).decode("ascii"),
            "filename": "scan.pdf",
        }

    def test_a_generous_limit_is_met_gently(self, base_url: str) -> None:
        document = self._scan()
        original = len(base64.b64decode(document["pdf"].split(",", 1)[1]))
        status, body = post(
            base_url, "/api/pdf/compress", {**document, "target_mb": original / 1_000_000 * 0.8}
        )
        assert status == 200, body
        assert body["reached_target"] is True
        assert body["bytes"] <= original * 0.8

    def test_an_impossible_limit_is_reported_as_a_miss(self, base_url: str) -> None:
        """The response must be machine-readable, not a sentence to parse.

        A caller integrating this needs to know whether to offer the file or to
        suggest splitting it, without reading prose.
        """
        status, body = post(base_url, "/api/pdf/compress", {**self._scan(), "target_mb": 0.001})
        assert status == 200, body
        assert body["reached_target"] is False
        assert "COULD NOT" in body["note"]

    def test_the_result_is_a_working_document(self, base_url: str) -> None:
        _, body = post(base_url, "/api/pdf/compress", {**self._scan(3), "target_mb": 1})
        _, reopened = post(
            base_url, "/api/pdf/inspect", {"pdf": body["pdf"], "filename": "smaller.pdf"}
        )
        assert reopened["ok"] is True
        assert reopened["document"]["page_count"] == 3

    def test_it_reports_the_resolution_it_landed_on(self, base_url: str) -> None:
        """DPI at printed size is what says whether the saving cost anything."""
        _, body = post(base_url, "/api/pdf/compress", {**self._scan(), "target_mb": 0.5})
        assert body["dpi_before"] > 0
        assert body["dpi_after"] > 0
        assert body["dpi_after"] <= body["dpi_before"]

    def test_explicit_settings_work_without_a_target(self, base_url: str) -> None:
        status, body = post(
            base_url, "/api/pdf/compress", {**self._scan(), "max_dpi": 100, "quality": 60}
        )
        assert status == 200, body
        assert body["percent_smaller"] > 0

    def test_a_limit_of_zero_is_refused(self, base_url: str) -> None:
        status, body = post(base_url, "/api/pdf/compress", {**self._scan(), "target_mb": 0})
        assert status == 400
        assert "greater than zero" in body["error"]

    def test_a_damaged_file_is_refused_with_a_reason(self, base_url: str) -> None:
        status, body = post(
            base_url,
            "/api/pdf/compress",
            {"pdf": base64.b64encode(b"not a pdf").decode(), "target_mb": 1},
        )
        assert status == 400
        assert "PDF" in body["error"]


class TestCoverageAndOcrRoutes:
    """Whether a document can be searched, and making it so if it cannot."""

    @staticmethod
    def _scanned_letter() -> dict[str, str]:
        """A letter rendered to pixels - words that no search can reach."""
        import io

        from PIL import Image, ImageDraw, ImageFont

        from ipw.pdf.objects import Name, PdfWriter, Stream

        picture = Image.new("RGB", (1700, 2200), (253, 251, 247))
        draw = ImageDraw.Draw(picture)
        font: Any
        try:
            font = ImageFont.truetype("arial.ttf", 40)
        except OSError:  # pragma: no cover - depends on the host's fonts
            font = ImageFont.load_default()
        for text, y in (
            ("Patient: Jane Doe", 300),
            ("NHS Number: 4929 8812 0031", 380),
            ("This paragraph must survive.", 600),
        ):
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
                    "Width": 1700,
                    "Height": 2200,
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
        return {
            "pdf": "data:application/pdf;base64,"
            + base64.b64encode(writer.build(catalog, {})).decode("ascii"),
            "filename": "letter.pdf",
        }

    @staticmethod
    def _real_text(pages: int = 3) -> dict[str, str]:
        """Pages carrying sentences, not just a page number.

        A page whose only text is "page 1" is deliberately *not* counted as
        searchable - producers stamp numbers and footers over scans, and
        counting those would report a bundle of scans as fully searchable and
        skip the recognition it needs.
        """
        document = PdfDocument(title="Readable")
        for index in range(pages):
            page = document.add_page()
            page.texts.append(
                TextBox(text=f"This page carries a real sentence, number {index + 1}.", x=72, y=700)
            )
        return {
            "pdf": "data:application/pdf;base64,"
            + base64.b64encode(document.render()).decode("ascii"),
            "filename": "readable.pdf",
        }

    def test_coverage_identifies_a_document_that_can_be_searched(self, base_url: str) -> None:
        status, body = post(base_url, "/api/pdf/coverage", self._real_text(3))
        assert status == 200, body
        assert body["fully_searchable"] is True
        assert body["pages_needing_ocr"] == []

    def test_coverage_identifies_a_scan(self, base_url: str) -> None:
        """The answer behind every 'why did the search find nothing?'"""
        status, body = post(base_url, "/api/pdf/coverage", self._scanned_letter())
        assert status == 200, body
        assert body["fully_searchable"] is False
        assert body["pages_needing_ocr"] == [1]

    def test_coverage_refuses_a_damaged_file_with_a_reason(self, base_url: str) -> None:
        status, body = post(
            base_url, "/api/pdf/coverage", {"pdf": base64.b64encode(b"not a pdf").decode()}
        )
        assert status == 400
        assert "PDF" in body["error"]

    def test_availability_is_reported_before_anything_is_offered(self, base_url: str) -> None:
        """The interface must know whether recognition can run before it offers it."""
        import json as _json
        import urllib.request as _request

        with _request.urlopen(f"{base_url}/api/ocr-availability", timeout=60) as response:  # noqa: S310
            body = _json.loads(response.read())
        assert isinstance(body["available"], bool)
        if not body["available"]:
            assert body["reason"]

    def test_recognition_makes_a_scan_searchable(self, base_url: str) -> None:
        from ipw.pdf.ocr import locate

        if locate() is None:
            pytest.skip("the Tesseract binary is not installed on this machine")

        status, body = post(base_url, "/api/pdf/ocr", self._scanned_letter())
        assert status == 200, body
        assert body["available"] is True
        assert body["changed"] is True
        assert body["words"] > 5
        assert body["coverage_before"]["fully_searchable"] is False
        assert body["coverage_after"]["fully_searchable"] is True

    def test_the_result_can_then_be_searched_and_redacted(self, base_url: str) -> None:
        """The point of the whole feature, over HTTP."""
        from ipw.pdf.ocr import locate

        if locate() is None:
            pytest.skip("the Tesseract binary is not installed on this machine")

        _, recognised = post(base_url, "/api/pdf/ocr", self._scanned_letter())
        _, found = post(
            base_url, "/api/pdf/search", {"pdf": recognised["pdf"], "phrase": "Jane Doe"}
        )
        assert found["count"] >= 1

        _, redacted = post(
            base_url, "/api/pdf/redact", {"pdf": recognised["pdf"], "phrases": ["Jane Doe"]}
        )
        assert redacted["verified"] is True
        assert redacted["images_painted"] == 1, "the pixels on the scan were not overwritten"

    def test_a_document_with_nothing_to_recognise_is_reported_not_changed(
        self, base_url: str
    ) -> None:
        from ipw.pdf.ocr import locate

        if locate() is None:
            pytest.skip("the Tesseract binary is not installed on this machine")

        status, body = post(base_url, "/api/pdf/ocr", self._real_text(2))
        assert status == 200, body
        assert body["changed"] is False
        assert body["words"] == 0
