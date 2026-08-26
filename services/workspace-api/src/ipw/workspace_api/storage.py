"""Where files live, and how a browser reaches them without going through us.

**The point of this module is that large files never touch the API.** Today an
image travels as base64 inside a JSON body, which costs a third more bytes than
the file itself and runs into Cloud Run's request size limit long before the
hundred-megabyte professional tier is reached. A signed URL removes the API from
the path entirely: the browser uploads straight to the bucket, and sends us only
the name of the object it wrote.

That single change also makes the service stateless, because nothing is held in
a container that may be replaced between two requests.

**Signing is implemented here rather than taken from `google-cloud-storage`.**
The official client would add seventeen packages - protobuf, requests, urllib3
and the rest - to sign a URL. V4 signing is a deterministic, well-specified
algorithm; it needs RSA-SHA256 and nothing else, and `cryptography` alone brings
that in one package. It is also the right kind of algorithm to implement
yourself: a mistake produces a signature Google rejects outright, so it fails
loudly at the first request rather than quietly doing the wrong thing.

**Local development needs no cloud.** `LocalStorage` puts objects in a directory
and hands back ordinary URLs served by this same process, so the whole upload
path can be exercised, and tested, with no bucket and no credentials.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import shutil
import urllib.parse
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

__all__ = [
    "LocalStorage",
    "SignedUpload",
    "Storage",
    "gcs_object_name",
    "signed_upload_url",
]

# How long an upload URL stays usable. Long enough for a slow connection to send
# a hundred megabytes, short enough that a leaked link is not a lasting problem.
UPLOAD_TTL_SECONDS = 15 * 60
DOWNLOAD_TTL_SECONDS = 60 * 60

HOST = "storage.googleapis.com"


@dataclass(frozen=True)
class SignedUpload:
    """Everything the browser needs to put a file somewhere we can find it."""

    url: str
    method: str
    object_name: str
    expires_in: int
    headers: dict[str, str]


class Storage(Protocol):
    """What the service needs from a place to keep files.

    Narrow on purpose: an upload URL, a download URL, and the ability to read
    and write bytes server-side. Anything wider would make the local
    implementation a pretence rather than a real substitute.
    """

    def signed_upload(self, object_name: str, content_type: str) -> SignedUpload: ...

    def signed_download(self, object_name: str) -> str: ...

    def read(self, object_name: str) -> bytes: ...

    def write(self, object_name: str, data: bytes, content_type: str) -> str: ...

    def exists(self, object_name: str) -> bool: ...


def gcs_object_name(filename: str, prefix: str = "uploads") -> str:
    """A unique, safe object name that keeps the original name visible.

    The random component is what makes it safe: two people uploading `scan.jpg`
    must not collide, and a name a customer chose must never decide where a byte
    lands. The original is preserved as a suffix only so a bucket is readable by
    a human debugging it - nothing reads it back.
    """
    clean = Path(filename).name.replace("\\", "_").replace("/", "_")
    clean = "".join(character for character in clean if character.isalnum() or character in "-_.")
    clean = clean[-60:] or "file"
    stamp = dt.datetime.now(tz=dt.UTC).strftime("%Y/%m/%d")
    return f"{prefix}/{stamp}/{uuid.uuid4().hex}-{clean}"


# ------------------------------------------------------------------ local ----


class LocalStorage:
    """Files in a directory, for development and for tests.

    A real implementation of the same protocol rather than a stub: the upload
    path, the object naming and the round trip are all exercised, so the only
    thing untested locally is the signature itself.
    """

    def __init__(self, root: Path, base_url: str = "") -> None:
        self.root = root
        self.base_url = base_url.rstrip("/")
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, object_name: str) -> Path:
        # An object name arrives from a request. Resolving it and checking it is
        # still under the root is what stops `../../etc/passwd` from being a
        # valid place to write.
        candidate = (self.root / object_name).resolve()
        if not candidate.is_relative_to(self.root.resolve()):
            msg = f"object name escapes the storage root: {object_name!r}"
            raise ValueError(msg)
        return candidate

    def signed_upload(self, object_name: str, content_type: str) -> SignedUpload:
        return SignedUpload(
            url=f"{self.base_url}/api/uploads/local/{urllib.parse.quote(object_name)}",
            method="PUT",
            object_name=object_name,
            expires_in=UPLOAD_TTL_SECONDS,
            headers={"Content-Type": content_type},
        )

    def signed_download(self, object_name: str) -> str:
        return f"{self.base_url}/api/downloads/local/{urllib.parse.quote(object_name)}"

    def read(self, object_name: str) -> bytes:
        path = self._path(object_name)
        if not path.is_file():
            msg = f"no such object: {object_name}"
            raise FileNotFoundError(msg)
        return path.read_bytes()

    def write(self, object_name: str, data: bytes, content_type: str) -> str:
        del content_type  # a filesystem has nowhere to put it
        path = self._path(object_name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return object_name

    def exists(self, object_name: str) -> bool:
        try:
            return self._path(object_name).is_file()
        except ValueError:
            return False

    def clear(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)
        self.root.mkdir(parents=True, exist_ok=True)


# -------------------------------------------------------------------- GCS ----


@dataclass(frozen=True)
class ServiceAccount:
    """The parts of a service-account key that signing needs."""

    client_email: str
    private_key: str

    @classmethod
    def from_file(cls, path: str | Path) -> ServiceAccount:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        email = data.get("client_email")
        key = data.get("private_key")
        if not email or not key:
            msg = f"{path} is not a service-account key: it has no client_email or private_key"
            raise ValueError(msg)
        return cls(client_email=email, private_key=key)

    @classmethod
    def from_environment(cls) -> ServiceAccount | None:
        path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
        if not path or not Path(path).is_file():
            return None
        return cls.from_file(path)


def signed_upload_url(
    bucket: str,
    object_name: str,
    account: ServiceAccount,
    *,
    content_type: str = "application/octet-stream",
    method: str = "PUT",
    expires_in: int = UPLOAD_TTL_SECONDS,
    now: dt.datetime | None = None,
) -> str:
    """A V4 signed URL, built by hand.

    The algorithm is fixed by Google and reproduced here in the order it
    specifies: a canonical request, a string to sign derived from its digest,
    and an RSA-SHA256 signature over that string. Every step is deterministic,
    which is why this is testable without a network and why a mistake shows up
    as a rejected request rather than as something subtly wrong.
    """
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding, rsa

    moment = now or dt.datetime.now(tz=dt.UTC)
    timestamp = moment.strftime("%Y%m%dT%H%M%SZ")
    datestamp = moment.strftime("%Y%m%d")

    scope = f"{datestamp}/auto/storage/goog4_request"
    credential = f"{account.client_email}/{scope}"

    # The path is quoted but the separators are not: an object name contains
    # slashes and they are part of the path, not characters in a segment.
    canonical_path = "/" + bucket + "/" + urllib.parse.quote(object_name, safe="/~")

    # Sign exactly the headers the request will send, and no others.
    #
    # A GET carries no Content-Type. Signing `content-type;host` for one anyway
    # produces a signature that can never match, and Google answers 400 with a
    # message about the signature rather than about the header - which sends you
    # looking at the key. The PUT worked and the GET did not, which is precisely
    # the shape of this mistake.
    if content_type:
        signed_headers = "content-type;host"
        canonical_headers = f"content-type:{content_type}\nhost:{HOST}\n"
    else:
        signed_headers = "host"
        canonical_headers = f"host:{HOST}\n"

    query = {
        "X-Goog-Algorithm": "GOOG4-RSA-SHA256",
        "X-Goog-Credential": credential,
        "X-Goog-Date": timestamp,
        "X-Goog-Expires": str(expires_in),
        "X-Goog-SignedHeaders": signed_headers,
    }
    canonical_query = "&".join(
        f"{urllib.parse.quote(key, safe='~')}={urllib.parse.quote(value, safe='~')}"
        for key, value in sorted(query.items())
    )

    canonical_request = "\n".join(
        [
            method,
            canonical_path,
            canonical_query,
            canonical_headers,
            signed_headers,
            "UNSIGNED-PAYLOAD",
        ]
    )

    string_to_sign = "\n".join(
        [
            "GOOG4-RSA-SHA256",
            timestamp,
            scope,
            hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
        ]
    )

    key = serialization.load_pem_private_key(account.private_key.encode("utf-8"), password=None)
    if not isinstance(key, rsa.RSAPrivateKey):
        msg = "the service-account key is not an RSA key; V4 signing needs one"
        raise TypeError(msg)

    signature = key.sign(string_to_sign.encode("utf-8"), padding.PKCS1v15(), hashes.SHA256()).hex()

    return f"https://{HOST}{canonical_path}?{canonical_query}&X-Goog-Signature={signature}"


class GcsStorage:
    """A Google Cloud Storage bucket.

    Reading and writing server-side go through the JSON API with a bearer token,
    so the only credential handling here is obtaining that token. Uploads and
    downloads by the browser never come through this process at all - that is
    the entire point.
    """

    def __init__(self, bucket: str, account: ServiceAccount | None = None) -> None:
        if not bucket:
            msg = "a bucket name is required"
            raise ValueError(msg)
        self.bucket = bucket
        self.account = account or ServiceAccount.from_environment()

    def _require_account(self) -> ServiceAccount:
        if self.account is None:
            msg = (
                "no service-account credentials are available for signing. Set "
                "GOOGLE_APPLICATION_CREDENTIALS locally, or run somewhere the metadata "
                "service provides them."
            )
            raise RuntimeError(msg)
        return self.account

    def signed_upload(self, object_name: str, content_type: str) -> SignedUpload:
        url = signed_upload_url(
            self.bucket,
            object_name,
            self._require_account(),
            content_type=content_type,
            method="PUT",
        )
        return SignedUpload(
            url=url,
            method="PUT",
            object_name=object_name,
            expires_in=UPLOAD_TTL_SECONDS,
            headers={"Content-Type": content_type},
        )

    def signed_download(self, object_name: str) -> str:
        return signed_upload_url(
            self.bucket,
            object_name,
            self._require_account(),
            content_type="",
            method="GET",
            expires_in=DOWNLOAD_TTL_SECONDS,
        )

    def read(self, object_name: str) -> bytes:
        import urllib.error
        import urllib.request

        url = self.signed_download(object_name)
        try:
            with urllib.request.urlopen(url, timeout=120) as response:  # noqa: S310
                payload: bytes = response.read()
                return payload
        except urllib.error.HTTPError as exc:
            # Both backends must fail the same way. Letting urllib's exception
            # escape made "that upload does not exist" arrive as a 500 carrying
            # a raw HTTPError - the caller's mistake reported as our fault, and
            # with none of the information they needed.
            if exc.code == 404:
                message = f"no such object: {object_name}"
                raise FileNotFoundError(message) from exc
            raise

    def write(self, object_name: str, data: bytes, content_type: str) -> str:
        import urllib.request

        signed = self.signed_upload(object_name, content_type)
        request = urllib.request.Request(  # noqa: S310
            signed.url, data=data, method="PUT", headers=signed.headers
        )
        with urllib.request.urlopen(request, timeout=300):  # noqa: S310
            return object_name

    def exists(self, object_name: str) -> bool:
        import urllib.error
        import urllib.request

        try:
            request = urllib.request.Request(  # noqa: S310
                self.signed_download(object_name), method="HEAD"
            )
            with urllib.request.urlopen(request, timeout=30):  # noqa: S310
                return True
        except urllib.error.HTTPError:
            return False


def build_storage(bucket: str, local_root: Path, base_url: str = "") -> Storage:
    """The bucket when one is configured, the filesystem when not.

    Local development gets a working upload path with no cloud account at all,
    which keeps the whole flow exercisable and testable rather than something
    only production ever runs.
    """
    if bucket:
        return GcsStorage(bucket)
    return LocalStorage(local_root, base_url)
