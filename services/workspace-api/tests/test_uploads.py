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
