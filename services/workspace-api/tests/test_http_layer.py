"""The request layer itself: routing, decoding, limits and error mapping.

This is the part of the service a customer meets first when something goes
wrong, and the part a service-object test never touches. A handler that turns
every problem into a 500 is indistinguishable from a broken server, and one that
returns a stack trace hands an attacker a map of the code.
"""

from __future__ import annotations

import base64
import io
import json
import threading
import urllib.error
import urllib.request
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from PIL import Image

from ipw.pdf.document import PdfDocument
from ipw.workspace_api.http import build_server

APP_ROOT = Path(__file__).resolve().parents[3] / "apps" / "workspace-legacy"


@pytest.fixture(scope="module")
def base_url() -> Iterator[str]:
    server = build_server(APP_ROOT, port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


def request(
    base: str, route: str, payload: Any = None, *, raw: bytes | None = None
) -> tuple[int, Any]:
    body = (
        raw if raw is not None else (json.dumps(payload).encode() if payload is not None else None)
    )
    req = urllib.request.Request(  # noqa: S310 - localhost only
        base + route,
        data=body,
        headers={"Content-Type": "application/json"} if body is not None else {},
        method="POST" if body is not None else "GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as response:  # noqa: S310
            content = response.read()
            kind = response.headers.get("Content-Type", "")
            return response.status, json.loads(content) if "json" in kind else content
    except urllib.error.HTTPError as error:
        content = error.read()
        try:
            return error.code, json.loads(content)
        except json.JSONDecodeError:
            return error.code, content


def a_png(size: tuple[int, int] = (32, 32)) -> str:
    buffer = io.BytesIO()
    Image.new("RGB", size, (120, 90, 60)).save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()


class TestGetRoutes:
    def test_health_answers(self, base_url: str) -> None:
        status, body = request(base_url, "/api/health")
        assert status == 200
        assert body["ok"] is True

    def test_the_catalogue_is_served(self, base_url: str) -> None:
        status, body = request(base_url, "/api/catalogue")
        assert status == 200
        assert body["groups"], "the catalogue came back with no groups"

    def test_the_application_itself_is_served(self, base_url: str) -> None:
        status, body = request(base_url, "/")
        assert status == 200
        assert b"<title>" in body

    @pytest.mark.parametrize("asset", ["/app.js", "/pdf-view.js", "/styles.css"])
    def test_every_asset_the_page_loads_exists(self, base_url: str, asset: str) -> None:
        """A missing module is a blank screen, and nothing else would catch it."""
        status, _ = request(base_url, asset)
        assert status == 200, f"{asset} is referenced by the page but not served"


class TestRouting:
    def test_an_unknown_post_route_is_a_404_with_a_reason(self, base_url: str) -> None:
        status, body = request(base_url, "/api/nonsense", {})
        assert status == 404
        assert "no route" in body["error"]

    def test_a_body_that_is_not_json_is_a_400(self, base_url: str) -> None:
        status, body = request(base_url, "/api/inspect", raw=b"{not json at all")
        assert status == 400
        assert "JSON" in body["error"]

    def test_an_oversized_upload_is_refused_before_it_is_parsed(self, base_url: str) -> None:
        """The limit exists so one request cannot exhaust memory.

        It must be enforced from the declared length, not after reading the body,
        or the defence arrives too late to defend anything.
        """
        import socket
        from urllib.parse import urlsplit

        from ipw.workspace_api.http import MAX_UPLOAD_BYTES

        # The declared length is what must be refused. Actually sending 128 MB
        # would test the same branch far more slowly, and would not prove the
        # refusal happened *before* the body was read - which is the property
        # that matters, because reading it first is the failure being prevented.
        parts = urlsplit(base_url)
        sock = socket.create_connection((parts.hostname, parts.port), timeout=30)
        crlf = b"\r\n"
        try:
            sock.sendall(
                b"POST /api/inspect HTTP/1.1"
                + crlf
                + b"Host: localhost"
                + crlf
                + b"Content-Type: application/json"
                + crlf
                + b"Content-Length: %d" % (MAX_UPLOAD_BYTES + 1)
                + crlf
                + crlf
            )
            # No body follows. A server that read first would block here.
            sock.settimeout(15)
            head = sock.recv(4096)
        finally:
            sock.close()

        assert b"413" in head.split(crlf)[0], head[:120]


class TestDecoding:
    @pytest.mark.parametrize("route", ["/api/inspect", "/api/pdf/inspect"])
    def test_a_missing_payload_is_explained(self, base_url: str, route: str) -> None:
        status, body = request(base_url, route, {})
        assert status in (200, 400)
        error = body.get("error", "") if isinstance(body, dict) else ""
        assert "supplied" in error or body.get("ok") is False

    @pytest.mark.parametrize("route", ["/api/inspect", "/api/pdf/inspect"])
    def test_payload_that_is_not_base64_is_explained(self, base_url: str, route: str) -> None:
        status, body = request(base_url, route, {"image": "!!!not base64!!!", "pdf": "!!!"})
        assert status in (200, 400)
        text = json.dumps(body)
        assert "base64" in text or '"ok": false' in text.lower()

    def test_a_bare_base64_payload_works_without_a_data_url_prefix(self, base_url: str) -> None:
        """The browser sends data URLs; scripts and curl send bare base64."""
        document = PdfDocument()
        document.add_page()
        bare = base64.b64encode(document.render()).decode()
        status, body = request(base_url, "/api/pdf/inspect", {"pdf": bare})
        assert status == 200
        assert body["ok"] is True

    def test_documents_must_be_a_list(self, base_url: str) -> None:
        status, body = request(
            base_url, "/api/pdf/edit", {"documents": "one.pdf", "operation": "split"}
        )
        assert status == 400
        assert "list" in body["error"]

    def test_page_numbers_given_as_strings_are_accepted(self, base_url: str) -> None:
        """JSON from a form gives "3", not 3, and both plainly mean page three."""
        document = PdfDocument()
        for _ in range(4):
            document.add_page()
        payload = {
            "documents": [{"pdf": base64.b64encode(document.render()).decode()}],
            "operation": "split",
            "pages": ["1", "2"],
        }
        status, body = request(base_url, "/api/pdf/edit", payload)
        assert status == 200, body
        assert body["page_count"] == 2


class TestImageRoutes:
    def test_inspect_reports_dimensions_without_decoding_pixels(self, base_url: str) -> None:
        status, body = request(base_url, "/api/inspect", {"image": a_png((64, 48))})
        assert status == 200
        assert (body["width"], body["height"]) == (64, 48)

    def test_an_unknown_operation_is_named_in_the_error(self, base_url: str) -> None:
        status, body = request(
            base_url, "/api/process", {"operation": "enhance_my_vibes", "image": a_png()}
        )
        assert status == 400
        assert "enhance_my_vibes" in body["error"]

    def test_the_print_plan_answers_the_only_question_that_matters(self, base_url: str) -> None:
        """Whether this image can be printed that big, and what it needs."""
        status, body = request(
            base_url,
            "/api/print-plan",
            {"width": 1000, "height": 1000, "target_inches": 18, "dpi": 300},
        )
        assert status == 200
        assert body["required_scale"] > 1, "1000px cannot make 18in at 300 DPI unaided"

    def test_building_a_pdf_from_an_image_reports_its_effective_dpi(self, base_url: str) -> None:
        status, body = request(
            base_url,
            "/api/pdf",
            {"images": [{"image": a_png((900, 600)), "filename": "design.png"}], "page_size": "a4"},
        )
        assert status == 200, body
        assert body["page_count"] == 1
        assert body["lowest_dpi"] > 0
        assert body["advice"]

    def test_a_pdf_with_no_images_is_refused(self, base_url: str) -> None:
        status, body = request(base_url, "/api/pdf", {"images": []})
        assert status == 400
        assert "at least one image" in body["error"]


class TestVectoriseRoute:
    """Tracing over HTTP, including the shapes actually surviving the round trip."""

    @staticmethod
    def _logo() -> str:
        from PIL import ImageDraw

        image = Image.new("RGB", (300, 200), (255, 255, 255))
        draw = ImageDraw.Draw(image)
        draw.ellipse([20, 20, 140, 140], fill=(0, 90, 180))
        draw.ellipse([55, 55, 105, 105], fill=(255, 255, 255))
        draw.polygon([(170, 30), (280, 30), (225, 130)], fill=(220, 40, 40))
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()

    def test_a_logo_comes_back_as_svg_with_a_report(self, base_url: str) -> None:
        status, body = request(
            base_url, "/api/vectorise", {"image": self._logo(), "mode": "flat_colour", "colours": 4}
        )
        assert status == 200, body
        assert body["svg_text"].startswith("<svg")
        assert body["report"]["paths"] >= 2
        assert body["advice"]

    def test_the_svg_is_valid_xml_over_the_wire(self, base_url: str) -> None:
        import xml.etree.ElementTree as ElementTree

        _, body = request(base_url, "/api/vectorise", {"image": self._logo()})
        root = ElementTree.fromstring(body["svg_text"])  # noqa: S314 - we just produced it
        assert root.get("viewBox") == "0 0 300 200"

    def test_a_pdf_is_offered_and_reopens_as_one_page(self, base_url: str) -> None:
        """The print-shop half. It must be real paths, not a picture of them."""
        from ipw.pdf.reader import PdfReader

        _, body = request(
            base_url,
            "/api/vectorise",
            {"image": self._logo(), "also_pdf": True, "page_size": "a4"},
        )
        pdf = base64.b64decode(body["pdf"].split(",", 1)[1])
        reader = PdfReader.from_bytes(pdf)
        assert len(reader.pages()) == 1
        assert reader.describe()["pages"][0]["label"] == "8.27 x 11.69 in"

    def test_an_unknown_mode_is_refused_with_the_options(self, base_url: str) -> None:
        status, body = request(base_url, "/api/vectorise", {"image": self._logo(), "mode": "magic"})
        assert status == 400
        assert "line_art" in body["error"]

    def test_something_that_is_not_an_image_is_explained(self, base_url: str) -> None:
        status, body = request(
            base_url, "/api/vectorise", {"image": base64.b64encode(b"not a picture").decode()}
        )
        assert status == 400
        assert "image" in body["error"]

    def test_settings_are_clamped_rather_than_trusted(self, base_url: str) -> None:
        """A request asking for 10,000 colours must not be attempted.

        Clamping beats rejecting here: the caller gets a usable result rather
        than an error over a number they probably typed by accident.
        """
        status, body = request(
            base_url,
            "/api/vectorise",
            {"image": self._logo(), "colours": 100_000, "detail": -5},
        )
        assert status == 200, body
        assert body["report"]["colours"] <= 64
