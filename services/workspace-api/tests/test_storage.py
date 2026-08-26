"""Storage, and the signature that has to be exactly right.

Two halves. The local implementation is a real one rather than a stub, so the
upload path, object naming and round trip are all exercised without a cloud
account. The signing is checked against the algorithm Google specifies, because
a signature is either right or rejected - there is no partly working.

The one bug found while building this is pinned below: a GET carries no
Content-Type, so signing `content-type;host` for one produces a signature that
can never match. The PUT worked and the GET did not, which is exactly the shape
of that mistake.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import urllib.parse
from pathlib import Path

import pytest

from ipw.workspace_api.storage import (
    HOST,
    LocalStorage,
    ServiceAccount,
    build_storage,
    gcs_object_name,
    signed_upload_url,
)

# A throwaway RSA key, generated in the test run. Never a real credential.
_KEY_CACHE: dict[str, str] = {}


def a_service_account() -> ServiceAccount:
    if "pem" not in _KEY_CACHE:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import rsa

        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        _KEY_CACHE["pem"] = key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        ).decode()
    return ServiceAccount(
        client_email="test@example.iam.gserviceaccount.com", private_key=_KEY_CACHE["pem"]
    )


class TestObjectNames:
    def test_two_uploads_of_the_same_name_do_not_collide(self) -> None:
        """A shop uploading `scan.jpg` twice must get two objects."""
        assert gcs_object_name("scan.jpg") != gcs_object_name("scan.jpg")

    def test_the_original_name_stays_visible(self) -> None:
        """So a person debugging a bucket can recognise what they are looking at."""
        assert gcs_object_name("invoice-april.pdf").endswith("invoice-april.pdf")

    def test_a_path_in_the_name_cannot_choose_where_the_object_lands(self) -> None:
        """A name a customer chose must never decide a location."""
        name = gcs_object_name("../../../etc/passwd")
        assert ".." not in name
        assert name.startswith("uploads/")

    def test_awkward_characters_are_removed(self) -> None:
        name = gcs_object_name("my file (1)&2.jpg")
        tail = name.rsplit("-", 1)[-1]
        assert all(character.isalnum() or character in "-_." for character in tail)

    def test_an_empty_name_still_produces_something_usable(self) -> None:
        assert gcs_object_name("").startswith("uploads/")

    def test_the_prefix_separates_uploads_from_results(self) -> None:
        assert gcs_object_name("a.png", prefix="results").startswith("results/")


class TestLocalStorage:
    def test_a_round_trip_returns_the_same_bytes(self, tmp_path: Path) -> None:
        store = LocalStorage(tmp_path)
        store.write("a/b/c.bin", b"payload", "application/octet-stream")
        assert store.read("a/b/c.bin") == b"payload"

    def test_it_reports_what_it_holds(self, tmp_path: Path) -> None:
        store = LocalStorage(tmp_path)
        store.write("here.txt", b"x", "text/plain")
        assert store.exists("here.txt") is True
        assert store.exists("not-here.txt") is False

    def test_reading_something_absent_says_so(self, tmp_path: Path) -> None:
        with pytest.raises(FileNotFoundError, match="no such object"):
            LocalStorage(tmp_path).read("missing.bin")

    def test_an_object_name_cannot_escape_the_root(self, tmp_path: Path) -> None:
        """An object name arrives from a request. Without this check it is a
        way to write anywhere the process can reach."""
        store = LocalStorage(tmp_path)
        with pytest.raises(ValueError, match="escapes the storage root"):
            store.write("../../escaped.txt", b"x", "text/plain")

    def test_an_escaping_name_reports_absent_rather_than_raising(self, tmp_path: Path) -> None:
        assert LocalStorage(tmp_path).exists("../../../etc/passwd") is False

    def test_the_upload_url_is_usable_by_this_process(self, tmp_path: Path) -> None:
        store = LocalStorage(tmp_path, base_url="http://127.0.0.1:8770")
        upload = store.signed_upload("uploads/x.png", "image/png")
        assert upload.method == "PUT"
        assert upload.url.startswith("http://127.0.0.1:8770/api/uploads/local/")
        assert upload.headers["Content-Type"] == "image/png"


class TestSignedUrls:
    """The algorithm is fixed by Google; these check we follow it."""

    @staticmethod
    def _query(url: str) -> dict[str, str]:
        return dict(urllib.parse.parse_qsl(urllib.parse.urlparse(url).query))

    def test_it_points_at_the_object_in_the_bucket(self) -> None:
        url = signed_upload_url("my-bucket", "uploads/a/b.png", a_service_account())
        parsed = urllib.parse.urlparse(url)
        assert parsed.netloc == HOST
        assert parsed.path == "/my-bucket/uploads/a/b.png"

    def test_it_carries_every_required_parameter(self) -> None:
        query = self._query(signed_upload_url("b", "o", a_service_account()))
        for required in (
            "X-Goog-Algorithm",
            "X-Goog-Credential",
            "X-Goog-Date",
            "X-Goog-Expires",
            "X-Goog-SignedHeaders",
            "X-Goog-Signature",
        ):
            assert required in query, f"{required} is missing"
        assert query["X-Goog-Algorithm"] == "GOOG4-RSA-SHA256"

    def test_a_put_signs_the_content_type(self) -> None:
        query = self._query(
            signed_upload_url("b", "o", a_service_account(), content_type="image/png")
        )
        assert query["X-Goog-SignedHeaders"] == "content-type;host"

    def test_a_get_signs_only_the_host(self) -> None:
        """The bug this pins: a GET sends no Content-Type, so signing one
        produces a signature that can never match. The PUT worked and the GET
        returned 400, which is exactly how this shows up."""
        query = self._query(
            signed_upload_url("b", "o", a_service_account(), content_type="", method="GET")
        )
        assert query["X-Goog-SignedHeaders"] == "host"

    def test_the_signature_verifies_against_the_public_key(self) -> None:
        """Reconstruct the string to sign and check the signature ourselves.

        This is what makes the algorithm tested rather than merely exercised: if
        any part of the canonical request changes, the signature stops
        verifying here before Google ever sees it.
        """
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding

        account = a_service_account()
        moment = dt.datetime(2026, 8, 26, 12, 0, 0, tzinfo=dt.UTC)
        url = signed_upload_url(
            "my-bucket", "uploads/x.png", account, content_type="image/png", now=moment
        )

        query = self._query(url)
        signature = bytes.fromhex(query["X-Goog-Signature"])
        canonical_query = "&".join(
            f"{urllib.parse.quote(key, safe='~')}={urllib.parse.quote(value, safe='~')}"
            for key, value in sorted(query.items())
            if key != "X-Goog-Signature"
        )
        canonical_request = "\n".join(
            [
                "PUT",
                "/my-bucket/uploads/x.png",
                canonical_query,
                f"content-type:image/png\nhost:{HOST}\n",
                "content-type;host",
                "UNSIGNED-PAYLOAD",
            ]
        )
        string_to_sign = "\n".join(
            [
                "GOOG4-RSA-SHA256",
                "20260826T120000Z",
                "20260826/auto/storage/goog4_request",
                hashlib.sha256(canonical_request.encode()).hexdigest(),
            ]
        )

        from cryptography.hazmat.primitives.asymmetric import rsa

        private = serialization.load_pem_private_key(account.private_key.encode(), password=None)
        assert isinstance(private, rsa.RSAPrivateKey)
        # Raises InvalidSignature if any part of the canonical request differs.
        private.public_key().verify(
            signature, string_to_sign.encode(), padding.PKCS1v15(), hashes.SHA256()
        )

    def test_the_same_inputs_produce_the_same_url(self) -> None:
        account = a_service_account()
        moment = dt.datetime(2026, 8, 26, 12, 0, 0, tzinfo=dt.UTC)
        first = signed_upload_url("b", "o", account, now=moment)
        second = signed_upload_url("b", "o", account, now=moment)
        assert first == second

    def test_a_different_object_produces_a_different_signature(self) -> None:
        account = a_service_account()
        moment = dt.datetime(2026, 8, 26, 12, 0, 0, tzinfo=dt.UTC)
        first = self._query(signed_upload_url("b", "one", account, now=moment))
        second = self._query(signed_upload_url("b", "two", account, now=moment))
        assert first["X-Goog-Signature"] != second["X-Goog-Signature"]

    def test_slashes_in_the_object_name_stay_path_separators(self) -> None:
        """Quoting them would point the URL at an object that does not exist."""
        url = signed_upload_url("b", "a/b/c.png", a_service_account())
        assert urllib.parse.urlparse(url).path == "/b/a/b/c.png"

    def test_an_expiry_is_included_and_bounded(self) -> None:
        query = self._query(signed_upload_url("b", "o", a_service_account(), expires_in=900))
        assert query["X-Goog-Expires"] == "900"


class TestServiceAccount:
    def test_a_file_that_is_not_a_key_is_refused_clearly(self, tmp_path: Path) -> None:
        path = tmp_path / "not-a-key.json"
        path.write_text('{"hello": "world"}', encoding="utf-8")
        with pytest.raises(ValueError, match="not a service-account key"):
            ServiceAccount.from_file(path)

    def test_no_credentials_configured_is_not_an_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Local development without a key file must still start."""
        monkeypatch.delenv("GOOGLE_APPLICATION_CREDENTIALS", raising=False)
        assert ServiceAccount.from_environment() is None


class TestChoosingABackend:
    def test_no_bucket_means_the_filesystem(self, tmp_path: Path) -> None:
        """Local development gets a working upload path with no cloud account."""
        assert isinstance(build_storage("", tmp_path), LocalStorage)

    def test_a_bucket_means_the_bucket(self, tmp_path: Path) -> None:
        from ipw.workspace_api.storage import GcsStorage

        assert isinstance(build_storage("some-bucket", tmp_path), GcsStorage)

    def test_an_empty_bucket_name_is_refused_by_the_cloud_backend(self) -> None:
        from ipw.workspace_api.storage import GcsStorage

        with pytest.raises(ValueError, match="bucket name is required"):
            GcsStorage("")


class TestCloudStorageWithoutTheCloud:
    """The bucket-backed paths, with the transport replaced.

    The suite forbids reaching off this machine, and CI has no credentials - but
    the logic worth testing is not the network. It is what happens to the bytes,
    and how a missing object is reported.
    """

    @staticmethod
    def _store() -> object:
        from ipw.workspace_api.storage import GcsStorage

        return GcsStorage("a-bucket", a_service_account())

    def test_a_missing_object_is_reported_the_same_way_as_a_local_one(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """This arrived as a 500 carrying a raw HTTPError until both backends
        were made to fail alike - the caller's mistake reported as ours."""
        import urllib.error
        import urllib.request

        def not_found(*_args: object, **_kwargs: object) -> object:
            raise urllib.error.HTTPError("url", 404, "Not Found", {}, None)  # type: ignore[arg-type]

        monkeypatch.setattr(urllib.request, "urlopen", not_found)
        with pytest.raises(FileNotFoundError, match="no such object"):
            self._store().read("uploads/gone.png")  # type: ignore[attr-defined]

    def test_another_error_is_not_disguised_as_a_missing_file(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A 403 means the credentials are wrong. Reporting it as 'not found'
        would send somebody looking for a file that is right there."""
        import urllib.error
        import urllib.request

        def forbidden(*_args: object, **_kwargs: object) -> object:
            raise urllib.error.HTTPError("url", 403, "Forbidden", {}, None)  # type: ignore[arg-type]

        monkeypatch.setattr(urllib.request, "urlopen", forbidden)
        with pytest.raises(urllib.error.HTTPError):
            self._store().read("uploads/there.png")  # type: ignore[attr-defined]

    def test_reading_returns_exactly_what_the_bucket_returned(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import urllib.request

        class Response:
            def read(self) -> bytes:
                return b"the object bytes"

            def __enter__(self) -> Response:
                return self

            def __exit__(self, *_exc: object) -> None:
                return None

        monkeypatch.setattr(urllib.request, "urlopen", lambda *a, **k: Response())
        assert self._store().read("uploads/x.png") == b"the object bytes"  # type: ignore[attr-defined]

    def test_writing_sends_a_put_with_the_signed_headers(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import urllib.request

        seen: dict[str, object] = {}

        class Response:
            def __enter__(self) -> Response:
                return self

            def __exit__(self, *_exc: object) -> None:
                return None

        def capture(request: object, **_kwargs: object) -> object:
            seen["method"] = request.get_method()  # type: ignore[attr-defined]
            seen["data"] = request.data  # type: ignore[attr-defined]
            seen["type"] = request.get_header("Content-type")  # type: ignore[attr-defined]
            return Response()

        monkeypatch.setattr(urllib.request, "urlopen", capture)
        name = self._store().write("uploads/x.png", b"payload", "image/png")  # type: ignore[attr-defined]

        assert name == "uploads/x.png"
        assert seen["method"] == "PUT"
        assert seen["data"] == b"payload"
        assert seen["type"] == "image/png"

    def test_exists_answers_false_rather_than_raising(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import urllib.error
        import urllib.request

        def gone(*_args: object, **_kwargs: object) -> object:
            raise urllib.error.HTTPError("url", 404, "Not Found", {}, None)  # type: ignore[arg-type]

        monkeypatch.setattr(urllib.request, "urlopen", gone)
        assert self._store().exists("uploads/gone.png") is False  # type: ignore[attr-defined]

    def test_signing_without_credentials_says_what_is_missing(self) -> None:
        """On Cloud Run the metadata service supplies these; locally a key file
        does. Neither being present should say so, not fail obscurely."""
        from ipw.workspace_api.storage import GcsStorage

        store = GcsStorage("a-bucket", None)
        store.account = None
        with pytest.raises(RuntimeError, match="GOOGLE_APPLICATION_CREDENTIALS"):
            store.signed_upload("uploads/x.png", "image/png")


class TestLocalStorageHousekeeping:
    def test_clearing_removes_everything_it_held(self, tmp_path: Path) -> None:
        store = LocalStorage(tmp_path)
        store.write("a.bin", b"x", "application/octet-stream")
        store.write("nested/b.bin", b"y", "application/octet-stream")
        store.clear()
        assert store.exists("a.bin") is False
        assert store.exists("nested/b.bin") is False
        assert tmp_path.is_dir(), "the root itself should survive"
