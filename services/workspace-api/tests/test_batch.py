"""Batch processing, PRODUCT_REQUIREMENTS section 13.

The requirement that carries the most weight is section 20's: per-asset failure
isolation. A batch that stops at the first corrupt upload wastes everything
queued behind it and tells the customer nothing about which file was the
problem - and one that reports a corrupt file as *finished* is worse still,
because the bad result goes into the download.

So most of what is checked here is what happens around the failures.
"""

from __future__ import annotations

import base64
import io
import json
import threading
import urllib.error
import urllib.request
import zipfile
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from PIL import Image

from ipw.contracts.operation import OperationKind
from ipw.workspace_api.http import build_server
from ipw.workspace_api.server import MAX_BATCH_ITEMS, WorkspaceService


@pytest.fixture(scope="module")
def service() -> WorkspaceService:
    return WorkspaceService()


@pytest.fixture(scope="module")
def base_url() -> Iterator[str]:
    """A real server on an ephemeral port, for the routes to be driven properly."""
    app_root = Path(__file__).resolve().parents[3] / "apps" / "workspace"
    server = build_server(app_root, port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


def a_png(
    width: int = 400, height: int = 300, colour: tuple[int, int, int] = (200, 120, 90)
) -> str:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), colour).save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()


def items(count: int) -> list[dict[str, Any]]:
    return [{"filename": f"photo-{index}.png", "image": a_png()} for index in range(count)]


class TestItProcessesEverything:
    def test_one_configuration_reaches_every_image(self, service: WorkspaceService) -> None:
        result = service.batch_process(items(5), OperationKind.RESIZE, {"target_width": 200})
        assert result["completed"] == 5
        assert result["failed"] == 0
        assert all(entry["width"] == 200 for entry in result["results"])

    def test_a_per_image_setting_overrides_the_shared_one(self, service: WorkspaceService) -> None:
        """Section 13: "override settings for individual images".

        One photograph in a set of fifty may need a different size without the
        other forty-nine being re-run.
        """
        batch = items(3)
        batch[1]["settings"] = {"target_width": 64}
        result = service.batch_process(batch, OperationKind.RESIZE, {"target_width": 200})
        widths = [entry["width"] for entry in result["results"]]
        assert widths == [200, 64, 200]

    def test_every_result_carries_its_own_name_and_position(
        self, service: WorkspaceService
    ) -> None:
        """Without both, a customer cannot tell which of fifty files failed."""
        result = service.batch_process(items(4), OperationKind.RESIZE, {"target_width": 100})
        assert [entry["index"] for entry in result["results"]] == [0, 1, 2, 3]
        assert [entry["filename"] for entry in result["results"]] == [
            f"photo-{index}.png" for index in range(4)
        ]


class TestFailureIsolation:
    """One bad file must not cost the other forty-nine."""

    def test_a_corrupt_file_does_not_stop_the_batch(self, service: WorkspaceService) -> None:
        batch = items(4)
        batch.insert(2, {"filename": "broken.png", "image": base64.b64encode(b"junk").decode()})
        result = service.batch_process(batch, OperationKind.RESIZE, {"target_width": 200})
        assert result["completed"] == 4
        assert result["failed"] == 1

    def test_a_corrupt_file_is_reported_as_failed_not_finished(
        self, service: WorkspaceService
    ) -> None:
        """The bug this pins put random bytes into the download.

        `process` refuses a bad file by returning `ok: false` rather than
        raising, so treating "did not raise" as success marked a file of junk as
        completed - a worse failure than the one it was hiding, because it is
        silent.
        """
        result = service.batch_process(
            [{"filename": "broken.png", "image": base64.b64encode(b"junk").decode()}],
            OperationKind.RESIZE,
            {"target_width": 200},
        )
        assert result["failed"] == 1
        assert result["results"][0]["status"] == "failed"
        assert "signature" in result["results"][0]["error"]

    def test_something_that_is_not_base64_fails_on_its_own(self, service: WorkspaceService) -> None:
        batch = items(2)
        batch.append({"filename": "bad.png", "image": "!!! not base64 !!!"})
        result = service.batch_process(batch, OperationKind.RESIZE, {"target_width": 200})
        assert result["completed"] == 2
        assert "base64" in result["results"][2]["error"]

    def test_the_failures_can_be_retried_on_their_own(self, service: WorkspaceService) -> None:
        """Section 13: "retry only failed or selected items"."""
        batch = items(3)
        batch.insert(1, {"filename": "broken.png", "image": base64.b64encode(b"junk").decode()})
        result = service.batch_process(batch, OperationKind.RESIZE, {"target_width": 200})
        assert result["failed_indexes"] == [1]

    def test_a_batch_where_everything_fails_still_returns_an_account(
        self, service: WorkspaceService
    ) -> None:
        broken = [
            {"filename": f"broken-{index}.png", "image": base64.b64encode(b"junk").decode()}
            for index in range(3)
        ]
        result = service.batch_process(broken, OperationKind.RESIZE, {"target_width": 200})
        assert result["ok"] is True, "a batch of failures is still a completed batch"
        assert result["completed"] == 0
        assert "All 3 image(s) failed" in result["note"]

    def test_the_note_never_buries_the_failures(self, service: WorkspaceService) -> None:
        batch = items(9)
        batch.append({"filename": "broken.png", "image": base64.b64encode(b"junk").decode()})
        result = service.batch_process(batch, OperationKind.RESIZE, {"target_width": 200})
        assert "1 failed" in result["note"]


class TestLimits:
    def test_an_empty_batch_is_refused(self, service: WorkspaceService) -> None:
        with pytest.raises(ValueError, match="no images"):
            service.batch_process([], OperationKind.RESIZE, {"target_width": 200})

    def test_more_than_the_ceiling_is_refused_with_the_number(
        self, service: WorkspaceService
    ) -> None:
        """Accepting it and failing halfway would be worse than refusing."""
        too_many = [{"filename": "x.png", "image": a_png(8, 8)}] * (MAX_BATCH_ITEMS + 1)
        with pytest.raises(ValueError, match=str(MAX_BATCH_ITEMS)):
            service.batch_process(too_many, OperationKind.RESIZE, {"target_width": 4})

    def test_exactly_the_ceiling_is_accepted(self, service: WorkspaceService) -> None:
        batch = [
            {"filename": f"tiny-{index}.png", "image": a_png(16, 16)}
            for index in range(MAX_BATCH_ITEMS)
        ]
        result = service.batch_process(batch, OperationKind.RESIZE, {"target_width": 8})
        assert result["completed"] == MAX_BATCH_ITEMS


class TestZip:
    """Downloading fifty files one at a time is not a workflow."""

    @staticmethod
    def _finished(service: WorkspaceService, count: int = 3) -> list[dict[str, Any]]:
        result = service.batch_process(items(count), OperationKind.RESIZE, {"target_width": 100})
        return [entry for entry in result["results"] if entry["status"] == "completed"]

    def test_the_archive_holds_every_finished_file(self, service: WorkspaceService) -> None:
        bundle = service.batch_zip(self._finished(service, 4))
        assert bundle["files"] == 4

        archive = zipfile.ZipFile(io.BytesIO(base64.b64decode(bundle["zip"].split(",", 1)[1])))
        assert len(archive.namelist()) == 4
        assert archive.testzip() is None, "the archive is corrupt"

    def test_duplicate_names_are_kept_apart(self, service: WorkspaceService) -> None:
        """A batch drawn from several folders easily contains two `scan.jpg`.

        A ZIP that silently keeps one of them loses work without saying so.
        """
        finished = self._finished(service, 2)
        for entry in finished:
            entry["filename"] = "scan.png"

        bundle = service.batch_zip(finished)
        archive = zipfile.ZipFile(io.BytesIO(base64.b64decode(bundle["zip"].split(",", 1)[1])))
        assert sorted(archive.namelist()) == ["scan-2.png", "scan.png"]
        assert bundle["files"] == 2

    def test_a_path_in_a_name_cannot_escape_the_archive(self, service: WorkspaceService) -> None:
        """A name is a name. A ZIP that writes `../../etc/passwd` is a weapon."""
        finished = self._finished(service, 1)
        finished[0]["filename"] = "../../../evil.png"
        bundle = service.batch_zip(finished)
        archive = zipfile.ZipFile(io.BytesIO(base64.b64decode(bundle["zip"].split(",", 1)[1])))
        assert archive.namelist() == ["evil.png"]

    def test_an_empty_request_is_refused(self, service: WorkspaceService) -> None:
        with pytest.raises(ValueError, match="nothing to download"):
            service.batch_zip([])

    def test_entries_with_nothing_in_them_are_refused(self, service: WorkspaceService) -> None:
        with pytest.raises(ValueError, match="anything to save"):
            service.batch_zip([{"filename": "a.png"}, {"filename": "b.png"}])

    def test_a_pdf_can_be_bundled_too(self, service: WorkspaceService) -> None:
        from ipw.pdf.document import PdfDocument

        document = PdfDocument()
        document.add_page()
        entry = {
            "filename": "one.pdf",
            "pdf": "data:application/pdf;base64," + base64.b64encode(document.render()).decode(),
        }
        bundle = service.batch_zip([entry])
        assert bundle["files"] == 1


class TestBatchRoutes:
    """The same behaviour over HTTP, where the interface actually meets it."""

    @staticmethod
    def post(base: str, route: str, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        request = urllib.request.Request(  # noqa: S310 - localhost, built above
            base + route,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=300) as response:  # noqa: S310
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def test_a_batch_runs_over_the_wire(self, base_url: str) -> None:
        status, body = self.post(
            base_url,
            "/api/batch",
            {"operation": "resize", "settings": {"target_width": 120}, "items": items(4)},
        )
        assert status == 200, body
        assert body["completed"] == 4

    def test_a_corrupt_item_is_isolated_over_the_wire(self, base_url: str) -> None:
        batch = items(3)
        batch.insert(1, {"filename": "broken.png", "image": base64.b64encode(b"junk").decode()})
        _, body = self.post(
            base_url,
            "/api/batch",
            {"operation": "resize", "settings": {"target_width": 120}, "items": batch},
        )
        assert body["completed"] == 3
        assert body["failed_indexes"] == [1]

    def test_an_unknown_operation_is_named_in_the_error(self, base_url: str) -> None:
        status, body = self.post(
            base_url, "/api/batch", {"operation": "enhance_my_vibes", "items": items(1)}
        )
        assert status == 400
        assert "enhance_my_vibes" in body["error"]

    def test_items_must_be_a_list(self, base_url: str) -> None:
        status, body = self.post(
            base_url, "/api/batch", {"operation": "resize", "items": "not a list"}
        )
        assert status == 400
        assert "list" in body["error"]

    def test_the_ceiling_is_enforced_over_the_wire(self, base_url: str) -> None:
        status, body = self.post(
            base_url,
            "/api/batch",
            {"operation": "resize", "settings": {"target_width": 8}, "items": items(51)},
        )
        assert status == 400
        assert str(MAX_BATCH_ITEMS) in body["error"]

    def test_the_archive_route_returns_a_real_zip(self, base_url: str) -> None:
        _, batch = self.post(
            base_url,
            "/api/batch",
            {"operation": "resize", "settings": {"target_width": 80}, "items": items(3)},
        )
        finished = [
            {"filename": entry["filename"], "image": entry["image"]}
            for entry in batch["results"]
            if entry["status"] == "completed"
        ]
        status, bundle = self.post(base_url, "/api/batch/zip", {"files": finished})
        assert status == 200, bundle

        archive = zipfile.ZipFile(io.BytesIO(base64.b64decode(bundle["zip"].split(",", 1)[1])))
        assert archive.testzip() is None
        assert len(archive.namelist()) == 3

    def test_an_empty_archive_request_is_refused(self, base_url: str) -> None:
        status, body = self.post(base_url, "/api/batch/zip", {"files": []})
        assert status == 400
        assert "nothing to download" in body["error"]


def a_scanned_pdf(number: int = 0) -> str:
    """A one-page scan: a picture of words, as a folder of case files arrives."""
    from PIL import ImageDraw, ImageFont

    from ipw.pdf.objects import Name, PdfWriter, Stream

    picture = Image.new("RGB", (1700, 2200), (253, 251, 247))
    draw = ImageDraw.Draw(picture)
    font: Any
    try:
        font = ImageFont.truetype("arial.ttf", 40)
    except OSError:  # pragma: no cover - depends on the host fonts
        font = ImageFont.load_default()
    for text, y in (
        (f"CASE FILE {number:03d}", 160),
        ("Claimant: Jane Doe", 300),
        ("This line must survive.", 500),
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
    return "data:application/pdf;base64," + base64.b64encode(writer.build(catalog, {})).decode()


def documents(count: int) -> list[dict[str, Any]]:
    return [
        {"filename": f"case-{index:03d}.pdf", "pdf": a_scanned_pdf(index)} for index in range(count)
    ]


class TestDocumentBatch:
    """A folder of documents, which is the shape the work actually arrives in.

    A disclosure bundle is not a file. Sixty scans that all have to be under a
    portal limit, or a name that has to come out of every one of them - doing
    that a document at a time is where things get missed, not because anything
    fails but because file forty-one was the one nobody re-checked.
    """

    def test_compression_runs_over_the_whole_folder(self, service: WorkspaceService) -> None:
        result = service.batch_pdf(documents(4), "compress", {"target_mb": 0.4})
        assert result["completed"] == 4
        assert all(entry["reached_target"] for entry in result["results"])

    def test_a_corrupt_document_does_not_stop_the_folder(self, service: WorkspaceService) -> None:
        batch = documents(3)
        batch.insert(1, {"filename": "corrupt.pdf", "pdf": base64.b64encode(b"junk").decode()})
        result = service.batch_pdf(batch, "compress", {"target_mb": 1})
        assert result["completed"] == 3
        assert result["failed_indexes"] == [1]
        assert "not a PDF" in result["results"][1]["error"]

    def test_the_note_says_documents_not_images(self, service: WorkspaceService) -> None:
        """A small wrongness that tells the reader the message was written for
        something else and not thought about for their case."""
        result = service.batch_pdf(documents(2), "compress", {"target_mb": 1})
        assert "document(s)" in result["note"]

    def test_rotation_runs_over_the_folder(self, service: WorkspaceService) -> None:
        result = service.batch_pdf(documents(3), "rotate", {"degrees": 90})
        assert result["completed"] == 3
        assert all(entry["page_count"] == 1 for entry in result["results"])

    def test_a_stamp_reaches_every_document(self, service: WorkspaceService) -> None:
        result = service.batch_pdf(documents(3), "stamp", {"text": "DRAFT"})
        assert result["completed"] == 3

    def test_a_stamp_with_no_words_fails_per_document(self, service: WorkspaceService) -> None:
        result = service.batch_pdf(documents(2), "stamp", {"text": "   "})
        assert result["failed"] == 2
        assert "needs some text" in result["results"][0]["error"]

    def test_searchable_check_reports_which_need_recognition(
        self, service: WorkspaceService
    ) -> None:
        result = service.batch_pdf(documents(3), "searchable_check", {})
        assert result["completed"] == 3
        assert all(entry["pages_needing_ocr"] == [1] for entry in result["results"])

    def test_redaction_without_words_is_refused_per_document(
        self, service: WorkspaceService
    ) -> None:
        result = service.batch_pdf(documents(2), "redact", {"phrases": []})
        assert result["failed"] == 2
        assert "words to remove" in result["results"][0]["error"]

    def test_an_unknown_operation_names_what_is_available(self, service: WorkspaceService) -> None:
        result = service.batch_pdf(documents(1), "frobnicate", {})
        assert result["failed"] == 1
        assert "compress" in result["results"][0]["error"]

    def test_an_empty_folder_is_refused(self, service: WorkspaceService) -> None:
        with pytest.raises(ValueError, match="no documents"):
            service.batch_pdf([], "compress", {"target_mb": 1})

    def test_the_ceiling_applies_to_documents_too(self, service: WorkspaceService) -> None:
        one = documents(1)[0]
        with pytest.raises(ValueError, match=str(MAX_BATCH_ITEMS)):
            service.batch_pdf([one] * (MAX_BATCH_ITEMS + 1), "compress", {"target_mb": 1})


class TestTheLegalWorkflow:
    """Recognise a folder of scans, then take a name out of all of them."""

    def test_recognise_then_redact_across_a_folder(self, service: WorkspaceService) -> None:
        from ipw.pdf.ocr import locate

        if locate() is None:
            pytest.skip("the Tesseract binary is not installed on this machine")

        recognised = service.batch_pdf(documents(3), "ocr", {})
        assert recognised["completed"] == 3

        searchable = [
            {"filename": entry["filename"], "pdf": entry["pdf"]} for entry in recognised["results"]
        ]
        redacted = service.batch_pdf(searchable, "redact", {"phrases": ["Jane Doe"]})

        assert redacted["completed"] == 3
        assert all(entry["verified"] for entry in redacted["results"]), (
            "a document came back marked redacted without the words actually being gone"
        )
        assert all(entry["areas_redacted"] >= 1 for entry in redacted["results"])

    def test_the_kept_text_survives_across_the_folder(self, service: WorkspaceService) -> None:
        from ipw.pdf.ocr import locate
        from ipw.pdf.redact import verify

        if locate() is None:
            pytest.skip("the Tesseract binary is not installed on this machine")

        recognised = service.batch_pdf(documents(2), "ocr", {})
        searchable = [
            {"filename": entry["filename"], "pdf": entry["pdf"]} for entry in recognised["results"]
        ]
        redacted = service.batch_pdf(searchable, "redact", {"phrases": ["Jane Doe"]})

        for entry in redacted["results"]:
            data = base64.b64decode(entry["pdf"].split(",", 1)[1])
            assert verify(data, ["Jane Doe"]) == []
            assert verify(data, ["survive"]) == ["survive"]
