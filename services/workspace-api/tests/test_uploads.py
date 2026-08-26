"""The upload path, which exists so large files never come through the API.

Today an image travels as base64 inside a JSON body: a third more bytes than the
file, and a ceiling well below the hundred-megabyte professional tier. A signed
URL removes this service from the path - the browser writes to the bucket and
sends back only a name.

These run against `LocalStorage`, which is a real implementation of the same
protocol rather than a stub, so the whole flow is exercised with no bucket and no
credentials. The signature itself is covered in `test_storage.py`.
"""

from __future__ import annotations

import json
import threading
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from ipw.workspace_api.http import build_server

APP_ROOT = Path(__file__).resolve().parents[3] / "apps" / "workspace"


@pytest.fixture(scope="module")
def base_url(tmp_path_factory: pytest.TempPathFactory) -> Iterator[str]:
    """A server with no bucket configured, so LocalStorage is in use."""
    import os

    previous = os.environ.get("IPW_BUCKET")
    os.environ["IPW_BUCKET"] = ""
    server = build_server(APP_ROOT, port=0, repo_root=tmp_path_factory.mktemp("root"))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()
        if previous is None:
            os.environ.pop("IPW_BUCKET", None)
        else:
            os.environ["IPW_BUCKET"] = previous


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


class TestSigning:
    def test_it_hands_back_somewhere_to_put_the_file(self, base_url: str) -> None:
        status, body = post(
            base_url, "/api/uploads/sign", {"filename": "a.png", "content_type": "image/png"}
        )
        assert status == 200, body
        assert body["method"] == "PUT"
        assert body["object"]
        assert body["headers"]["Content-Type"] == "image/png"

    def test_the_url_addresses_the_port_this_server_actually_bound(self, base_url: str) -> None:
        """The bug this pins: the URL was built from the *configured* port.

        A server on an ephemeral port - a test, or Cloud Run choosing PORT -
        then signed a URL addressing whatever else was listening on 8770. The
        symptom was a 501 from a completely different process.
        """
        _, body = post(
            base_url, "/api/uploads/sign", {"filename": "a.png", "content_type": "image/png"}
        )
        assert urllib.parse.urlparse(body["url"]).netloc == urllib.parse.urlparse(base_url).netloc

    def test_two_signings_of_one_name_give_two_objects(self, base_url: str) -> None:
        first = post(
            base_url, "/api/uploads/sign", {"filename": "scan.jpg", "content_type": "image/jpeg"}
        )[1]
        second = post(
            base_url, "/api/uploads/sign", {"filename": "scan.jpg", "content_type": "image/jpeg"}
        )[1]
        assert first["object"] != second["object"]

    @pytest.mark.parametrize("kind", ["image/jpeg", "image/png", "application/pdf"])
    def test_the_types_this_workspace_processes_are_allowed(self, base_url: str, kind: str) -> None:
        status, _ = post(base_url, "/api/uploads/sign", {"filename": "f", "content_type": kind})
        assert status == 200

    @pytest.mark.parametrize(
        "kind", ["application/x-msdownload", "text/html", "application/zip", "video/mp4"]
    )
    def test_anything_else_is_refused_before_a_url_exists(self, base_url: str, kind: str) -> None:
        """A signed URL is a capability. Handing one out for a type nothing here
        can process means paying to store something nobody can use."""
        status, body = post(base_url, "/api/uploads/sign", {"filename": "f", "content_type": kind})
        assert status == 400
        assert "not a type this workspace accepts" in body["error"]

    def test_a_missing_filename_is_refused(self, base_url: str) -> None:
        status, body = post(base_url, "/api/uploads/sign", {"content_type": "image/png"})
        assert status == 400
        assert "filename is required" in body["error"]


class TestTheRoundTrip:
    @staticmethod
    def _upload(base: str, payload: bytes, kind: str = "image/png") -> str:
        _, signed = post(base, "/api/uploads/sign", {"filename": "x.png", "content_type": kind})
        request = urllib.request.Request(  # noqa: S310 - localhost
            signed["url"], data=payload, method="PUT", headers=signed["headers"]
        )
        with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310
            assert response.status == 200
        return str(signed["object"])

    def test_what_was_uploaded_can_be_read_back(self, base_url: str) -> None:
        payload = bytes(range(256)) * 40
        name = self._upload(base_url, payload)

        url = base_url + "/api/downloads/local/" + urllib.parse.quote(name)
        with urllib.request.urlopen(url, timeout=60) as response:  # noqa: S310
            assert response.read() == payload

    def test_an_object_that_does_not_exist_is_a_404(self, base_url: str) -> None:
        url = base_url + "/api/downloads/local/nothing/here.bin"
        with pytest.raises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(url, timeout=60)  # noqa: S310
        assert caught.value.code == 404

    def test_a_put_to_an_unknown_route_is_a_404(self, base_url: str) -> None:
        request = urllib.request.Request(  # noqa: S310 - localhost
            base_url + "/api/something-else", data=b"x", method="PUT"
        )
        with pytest.raises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request, timeout=60)  # noqa: S310
        assert caught.value.code == 404

    def test_an_upload_path_cannot_escape_the_storage_root(self, base_url: str) -> None:
        """The name is in the URL, so it is attacker-controlled."""
        request = urllib.request.Request(  # noqa: S310 - localhost
            base_url + "/api/uploads/local/" + urllib.parse.quote("../../escaped.txt"),
            data=b"x",
            method="PUT",
        )
        with pytest.raises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request, timeout=60)  # noqa: S310
        assert caught.value.code == 400


class TestProcessingByObjectName:
    """The reason all of this exists: bytes stop travelling through the API."""

    @staticmethod
    def _uploaded_png(base: str, width: int = 400, height: int = 300) -> str:
        import io

        from PIL import Image

        buffer = io.BytesIO()
        Image.new("RGB", (width, height), (180, 90, 60)).save(buffer, format="PNG")
        raw = buffer.getvalue()

        _, signed = post(
            base, "/api/uploads/sign", {"filename": "sheet.png", "content_type": "image/png"}
        )
        request = urllib.request.Request(  # noqa: S310 - localhost
            signed["url"], data=raw, method="PUT", headers=signed["headers"]
        )
        with urllib.request.urlopen(request, timeout=60):  # noqa: S310
            pass
        return str(signed["object"])

    def test_an_image_can_be_processed_by_name_alone(self, base_url: str) -> None:
        name = self._uploaded_png(base_url, 800, 600)
        status, body = post(
            base_url,
            "/api/process",
            {"object": name, "operation": "resize", "settings": {"target_width": 200}},
        )
        assert status == 200, body
        assert body["width"] == 200

    def test_the_request_carries_no_image_data(self, base_url: str) -> None:
        """A name is a few dozen bytes whatever the file weighs. This is the
        whole point: the request size stops depending on the upload size."""
        name = self._uploaded_png(base_url, 1200, 900)
        body = {"object": name, "operation": "resize", "settings": {"target_width": 100}}
        assert len(json.dumps(body)) < 300

    def test_inspection_works_by_name_too(self, base_url: str) -> None:
        name = self._uploaded_png(base_url, 640, 480)
        status, body = post(base_url, "/api/inspect", {"object": name, "filename": "sheet.png"})
        assert status == 200, body
        assert (body["width"], body["height"]) == (640, 480)

    def test_inline_base64_still_works(self, base_url: str) -> None:
        """Both paths are supported: small inline cases did not have to change."""
        import base64
        import io

        from PIL import Image

        buffer = io.BytesIO()
        Image.new("RGB", (64, 48), (10, 20, 30)).save(buffer, format="PNG")
        inline = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()

        status, body = post(
            base_url,
            "/api/process",
            {"image": inline, "operation": "resize", "settings": {"target_width": 32}},
        )
        assert status == 200, body
        assert body["width"] == 32

    def test_an_object_that_does_not_exist_is_the_callers_mistake(self, base_url: str) -> None:
        """It arrived as a 500 with a raw HTTPError until both storage backends
        were made to fail the same way - our fault, reported for their error."""
        status, body = post(
            base_url,
            "/api/process",
            {
                "object": "uploads/nothing/here.png",
                "operation": "resize",
                "settings": {"target_width": 10},
            },
        )
        assert status == 400
        assert "no uploaded file" in body["error"]

    def test_an_empty_object_name_falls_back_to_inline(self, base_url: str) -> None:
        """An absent name must not be read as 'fetch the object called nothing'."""
        status, body = post(
            base_url,
            "/api/process",
            {"object": "", "image": "", "operation": "resize", "settings": {"target_width": 10}},
        )
        assert status == 400
        assert "no image was supplied" in body["error"]


class TestResultDelivery:
    """How a finished file comes back, and why it depends on size."""

    @staticmethod
    def _service(tmp_path: Path) -> Any:
        import os

        from ipw.workspace_api.server import WorkspaceService

        previous = os.environ.get("IPW_BUCKET")
        os.environ["IPW_BUCKET"] = ""
        try:
            service = WorkspaceService(repo_root=tmp_path)
            service.set_base_url("http://127.0.0.1:1")
            return service
        finally:
            if previous is None:
                os.environ.pop("IPW_BUCKET", None)
            else:
                os.environ["IPW_BUCKET"] = previous

    def test_a_small_result_rides_back_in_the_response(self, tmp_path: Path) -> None:
        """A thumbnail inline is one round trip instead of three - the browser
        paints it immediately rather than waiting on a second request."""
        delivered = self._service(tmp_path).deliver(b"x" * 500, "small.png", "image/png")
        assert delivered["delivery"] == "inline"
        assert delivered["image"].startswith("data:image/png;base64,")
        assert "download_url" not in delivered

    def test_a_large_result_is_stored_and_linked(self, tmp_path: Path) -> None:
        from ipw.workspace_api.server import INLINE_RESULT_LIMIT

        payload = b"y" * (INLINE_RESULT_LIMIT + 1)
        delivered = self._service(tmp_path).deliver(payload, "big.png", "image/png")

        assert delivered["delivery"] == "stored"
        assert delivered["object"].startswith("results/")
        assert delivered["download_url"]

    def test_a_large_result_carries_no_image_data_at_all(self, tmp_path: Path) -> None:
        """The point of storing it. Base64 costs a third again on top of a file
        that was already too big to send."""
        from ipw.workspace_api.server import INLINE_RESULT_LIMIT

        delivered = self._service(tmp_path).deliver(
            b"z" * (INLINE_RESULT_LIMIT + 1), "big.png", "image/png"
        )
        assert "image" not in delivered

    def test_the_stored_bytes_are_the_result(self, tmp_path: Path) -> None:
        from ipw.workspace_api.server import INLINE_RESULT_LIMIT

        service = self._service(tmp_path)
        payload = bytes(range(256)) * (INLINE_RESULT_LIMIT // 256 + 1)
        delivered = service.deliver(payload, "big.bin", "application/octet-stream")
        assert service.storage().read(delivered["object"]) == payload

    def test_the_size_is_reported_either_way(self, tmp_path: Path) -> None:
        """A caller should not have to know which path it took to learn the size."""
        from ipw.workspace_api.server import INLINE_RESULT_LIMIT

        service = self._service(tmp_path)
        assert service.deliver(b"a" * 10, "s.png", "image/png")["bytes"] == 10

        big = INLINE_RESULT_LIMIT + 5
        assert service.deliver(b"b" * big, "l.png", "image/png")["bytes"] == big

    def test_results_are_kept_apart_from_uploads(self, tmp_path: Path) -> None:
        """So a bucket lifecycle rule can expire one and not the other."""
        from ipw.workspace_api.server import INLINE_RESULT_LIMIT

        delivered = self._service(tmp_path).deliver(
            b"c" * (INLINE_RESULT_LIMIT + 1), "x.png", "image/png"
        )
        assert delivered["object"].startswith("results/")
        assert not delivered["object"].startswith("uploads/")

    def test_exactly_at_the_limit_stays_inline(self, tmp_path: Path) -> None:
        """The boundary is a real decision, so it should be pinned rather than
        left to whichever comparison somebody wrote."""
        from ipw.workspace_api.server import INLINE_RESULT_LIMIT

        delivered = self._service(tmp_path).deliver(
            b"d" * INLINE_RESULT_LIMIT, "edge.png", "image/png"
        )
        assert delivered["delivery"] == "inline"
