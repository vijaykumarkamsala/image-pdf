"""HTTP routes for the workspace application. Standard library only.

Thin on purpose: parse, delegate to :class:`WorkspaceService`, serialise. Every
decision that matters lives in the service, which is testable without a socket.

**Localhost unless told otherwise, in writing.** This service has no
authentication, so anything reachable beyond loopback is an image processor
anybody can run at your expense. The default is 127.0.0.1 and opening it needs
an explicit `IPW_ALLOW_PUBLIC_BIND` - see `config.py`, which refuses rather than
assumes.

Cloud Run forces the question: its proxy connects from outside the container, so
a container bound to loopback accepts nothing and looks like a broken deploy.
That is precisely when somebody types 0.0.0.0 without thinking about who else can
reach it, which is why the flag exists and why startup says what it has done.
"""

from __future__ import annotations

import http.server
import json
import socketserver
from pathlib import Path
from typing import Any

from ipw.contracts.operation import OperationKind
from ipw.workspace_api.config import Settings, load_settings
from ipw.workspace_api.server import ProcessRequest, WorkspaceService, print_plan

__all__ = ["MAX_UPLOAD_BYTES", "WorkspaceHandler", "build_server", "serve"]

MAX_UPLOAD_BYTES = 128 * 1024 * 1024
"""Refuse a body larger than this before reading it into memory.

The safety policy already refuses oversized *images* after inspection, but that
happens after the bytes are in hand. A request-level ceiling is what stops a
single upload exhausting the process, and 128 MB comfortably clears the 100 MB
professional tier while still being a ceiling.
"""


class WorkspaceHandler(http.server.SimpleHTTPRequestHandler):
    """Serves the application and its API from one origin."""

    service: WorkspaceService
    app_root: Path

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - stdlib signature
        # One tidy line per request. The default writes a timestamp nobody reads.
        self.log_date_time_string()
        print(f"  {self.command} {self.path.split('?')[0]} -> {args[1] if len(args) > 1 else ''}")

    # ------------------------------------------------------------------ GET --

    def do_GET(self) -> None:
        route = self.path.split("?")[0]
        if route == "/api/catalogue":
            self._json(200, self.service.catalogue())
            return
        if route == "/api/ocr-availability":
            self._json(200, self.service.ocr_availability())
            return
        if route == "/api/health":
            # Cloud Run reads this, and so does a person wondering which
            # environment they are actually looking at. A misconfiguration
            # should be visible from outside, not only in a log nobody opened.
            settings = load_settings()
            self._json(
                200,
                {
                    "ok": True,
                    "service": "workspace-api",
                    "environment": settings.environment,
                    "warnings": settings.warnings(),
                },
            )
            return
        super().do_GET()

    # ----------------------------------------------------------------- POST --

    def do_POST(self) -> None:
        route = self.path.split("?")[0]
        try:
            body = self._read_body()
        except ValueError as exc:
            self._json(413, {"ok": False, "error": str(exc)})
            return

        try:
            payload = json.loads(body) if body else {}
        except json.JSONDecodeError:
            self._json(400, {"ok": False, "error": "request body is not valid JSON"})
            return

        try:
            if route == "/api/inspect":
                self._json(200, self._inspect(payload))
            elif route == "/api/process":
                self._json(200, self._process(payload))
            elif route == "/api/batch":
                self._json(200, self._batch(payload))
            elif route == "/api/batch/pdf":
                self._json(200, self._batch_pdf(payload))
            elif route == "/api/batch/zip":
                self._json(200, self._batch_zip(payload))
            elif route == "/api/print-plan":
                self._json(200, self._print_plan(payload))
            elif route == "/api/pdf":
                self._json(200, self._pdf(payload))
            elif route == "/api/pdf/inspect":
                self._json(200, self._pdf_inspect(payload))
            elif route == "/api/pdf/edit":
                self._json(200, self._pdf_edit(payload))
            elif route == "/api/pdf/thumbnails":
                self._json(200, self._pdf_thumbnails(payload))
            elif route == "/api/vectorise":
                self._json(200, self._vectorise(payload))
            elif route == "/api/pdf/search":
                self._json(200, self._pdf_search(payload))
            elif route == "/api/pdf/redact":
                self._json(200, self._pdf_redact(payload))
            elif route == "/api/pdf/compress":
                self._json(200, self._pdf_compress(payload))
            elif route == "/api/pdf/ocr":
                self._json(200, self._pdf_ocr(payload))
            elif route == "/api/pdf/number":
                self._json(200, self._pdf_number(payload))
            elif route == "/api/pdf/coverage":
                self._json(200, self.service.pdf_coverage(_decode_pdf(payload.get("pdf", ""))))
            else:
                self._json(404, {"ok": False, "error": f"no route {route}"})
        except ValueError as exc:
            # A malformed request is the caller's problem and gets a 400 with the
            # contract's own message, which is more useful than "bad request".
            self._json(400, {"ok": False, "error": str(exc)})
        except Exception as exc:  # noqa: BLE001 - a server must not die on one request
            self._json(500, {"ok": False, "error": f"{type(exc).__name__}: {exc}"})

    # ------------------------------------------------------------- handlers --

    def _inspect(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self.service.inspect(
            _decode_image(payload.get("image", "")), str(payload.get("filename", "upload"))
        )

    def _pdf_inspect(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self.service.pdf_inspect(
            _decode_pdf(payload.get("pdf", "")), str(payload.get("filename", "document.pdf"))
        )

    def _pdf_number(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self.service.pdf_number(
            _decode_pdf(payload.get("pdf", "")),
            prefix=str(payload.get("prefix", "")),
            start=int(payload.get("start", 1) or 1),
            digits=int(payload.get("digits", 6) or 0),
            position=str(payload.get("position", "bottom-right")),
            size=float(payload.get("size", 9) or 9),
        )

    def _pdf_ocr(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self.service.pdf_ocr(
            _decode_pdf(payload.get("pdf", "")),
            pages=_int_list(payload.get("pages")),
            language=str(payload.get("language", "eng") or "eng"),
        )

    def _pdf_compress(self, payload: dict[str, Any]) -> dict[str, Any]:
        target = payload.get("target_mb")
        return self.service.pdf_compress(
            _decode_pdf(payload.get("pdf", "")),
            target_mb=None if target in (None, "") else float(target),
            max_dpi=int(payload.get("max_dpi", 200) or 200),
            quality=int(payload.get("quality", 82) or 82),
            keep_private_data=bool(payload.get("keep_private_data", False)),
        )

    def _pdf_search(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self.service.pdf_search(
            _decode_pdf(payload.get("pdf", "")),
            str(payload.get("phrase", "")),
            ignore_case=bool(payload.get("ignore_case", True)),
        )

    def _pdf_redact(self, payload: dict[str, Any]) -> dict[str, Any]:
        phrases = payload.get("phrases") or []
        if not isinstance(phrases, list):
            msg = "phrases must be a list"
            raise ValueError(msg)
        areas = payload.get("areas") or []
        if not isinstance(areas, list):
            msg = "areas must be a list"
            raise ValueError(msg)
        return self.service.pdf_redact(
            _decode_pdf(payload.get("pdf", "")),
            phrases=[str(phrase) for phrase in phrases],
            areas=areas,
            pages=_int_list(payload.get("pages")),
            ignore_case=bool(payload.get("ignore_case", True)),
        )

    def _vectorise(self, payload: dict[str, Any]) -> dict[str, Any]:
        threshold = payload.get("threshold")
        return self.service.vectorise(
            _decode_image(payload.get("image", "")),
            str(payload.get("filename", "image")),
            mode=str(payload.get("mode", "flat_colour")),
            colours=int(payload.get("colours", 8) or 8),
            detail=float(payload.get("detail", 1.0) or 1.0),
            smoothness=float(payload.get("smoothness", 25.0) or 0.0),
            despeckle=int(payload.get("despeckle", 8) or 0),
            threshold=None if threshold in (None, "") else int(threshold),
            keep_background=bool(payload.get("keep_background", False)),
            clean=int(payload.get("clean", 0) or 0),
            also_pdf=bool(payload.get("also_pdf", False)),
            page_size=payload.get("page_size") or None,
        )

    def _pdf_thumbnails(self, payload: dict[str, Any]) -> dict[str, Any]:
        edge = max(64, min(int(payload.get("edge", 240) or 240), 480))
        return self.service.pdf_thumbnails(_decode_pdf(payload.get("pdf", "")), edge)

    def _pdf_edit(self, payload: dict[str, Any]) -> dict[str, Any]:
        raw = payload.get("documents") or []
        if not isinstance(raw, list):
            msg = "documents must be a list"
            raise ValueError(msg)
        documents = [
            (_decode_pdf(str(item.get("pdf", ""))), str(item.get("filename", "document.pdf")))
            for item in raw
            if isinstance(item, dict)
        ]
        return self.service.pdf_edit(
            str(payload.get("operation", "")),
            documents,
            pages=_int_list(payload.get("pages")),
            order=_int_list(payload.get("order")),
            degrees=int(payload.get("degrees", 0) or 0),
            text=str(payload.get("text", "")),
            title=str(payload.get("title", "")),
            keep_private_data=bool(payload.get("keep_private_data", False)),
        )

    def _process(self, payload: dict[str, Any]) -> dict[str, Any]:
        raw_kind = str(payload.get("operation", ""))
        try:
            kind = OperationKind(raw_kind)
        except ValueError:
            msg = f"unknown operation {raw_kind!r}"
            raise ValueError(msg) from None

        return self.service.process(
            ProcessRequest(
                kind=kind,
                settings=dict(payload.get("settings") or {}),
                image_bytes=_decode_image(payload.get("image", "")),
                filename=str(payload.get("filename", "upload")),
            )
        )

    def _batch(self, payload: dict[str, Any]) -> dict[str, Any]:
        raw_kind = str(payload.get("operation", ""))
        try:
            kind = OperationKind(raw_kind)
        except ValueError:
            msg = f"unknown operation {raw_kind!r}"
            raise ValueError(msg) from None

        items = payload.get("items") or []
        if not isinstance(items, list):
            msg = "items must be a list"
            raise ValueError(msg)

        return self.service.batch_process(
            [item for item in items if isinstance(item, dict)],
            kind,
            dict(payload.get("settings") or {}),
        )

    def _batch_pdf(self, payload: dict[str, Any]) -> dict[str, Any]:
        items = payload.get("items") or []
        if not isinstance(items, list):
            msg = "items must be a list"
            raise ValueError(msg)
        return self.service.batch_pdf(
            [item for item in items if isinstance(item, dict)],
            str(payload.get("operation", "")),
            dict(payload.get("settings") or {}),
        )

    def _batch_zip(self, payload: dict[str, Any]) -> dict[str, Any]:
        entries = payload.get("files") or []
        if not isinstance(entries, list):
            msg = "files must be a list"
            raise ValueError(msg)
        return self.service.batch_zip([item for item in entries if isinstance(item, dict)])

    def _print_plan(self, payload: dict[str, Any]) -> dict[str, Any]:
        return print_plan(
            int(payload.get("width", 0)),
            int(payload.get("height", 0)),
            float(payload.get("target_inches", 0) or 0),
            int(payload.get("dpi", 300)),
        )

    def _pdf(self, payload: dict[str, Any]) -> dict[str, Any]:
        entries = payload.get("images") or []
        if not isinstance(entries, list):
            msg = "images must be a list"
            raise ValueError(msg)
        images = [
            (_decode_image(str(item.get("image", ""))), str(item.get("filename", "image")))
            for item in entries
        ]
        return self.service.to_pdf(
            images,
            page_size=payload.get("page_size") or None,
            orientation=str(payload.get("orientation", "portrait")),
            margin_mm=float(payload.get("margin_mm", 0) or 0),
            title=str(payload.get("title", "")),
            page_numbers=bool(payload.get("page_numbers")),
        )

    # --------------------------------------------------------------- plumbing --

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_UPLOAD_BYTES:
            msg = f"upload exceeds {MAX_UPLOAD_BYTES // (1024 * 1024)} MB"
            raise ValueError(msg)
        return self.rfile.read(length) if length else b""

    def _json(self, status: int, document: dict[str, Any]) -> None:
        body = json.dumps(document).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        # No caching: every response describes a specific upload.
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def _decode_image(value: str) -> bytes:
    """Accept a data URL or bare base64, and refuse anything else clearly."""
    import base64
    import binascii

    if not value:
        msg = "no image was supplied"
        raise ValueError(msg)
    if value.startswith("data:"):
        _, _, value = value.partition(",")
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        msg = "image is not valid base64"
        raise ValueError(msg) from None


def _decode_pdf(value: str) -> bytes:
    """Accept a data URL or bare base64, and refuse anything else clearly."""
    import base64
    import binascii

    if not value:
        msg = "no PDF was supplied"
        raise ValueError(msg)
    if value.startswith("data:"):
        _, _, value = value.partition(",")
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        msg = "PDF is not valid base64"
        raise ValueError(msg) from None


def _int_list(value: Any) -> list[int] | None:
    """Page numbers from JSON, where "3" and 3 both arrive and both mean three."""
    if value is None:
        return None
    if not isinstance(value, list):
        msg = "page numbers must be a list"
        raise ValueError(msg)
    out: list[int] = []
    for item in value:
        try:
            out.append(int(item))
        except (TypeError, ValueError):
            msg = f"{item!r} is not a page number"
            raise ValueError(msg) from None
    return out


class _ThreadedServer(socketserver.ThreadingTCPServer):
    """One thread per request, so a slow AI call does not block the interface.

    An upscale takes seconds. Without threading the catalogue request that draws
    the progress state would queue behind it, and the application would appear
    frozen at precisely the moment it most needs to look alive.
    """

    daemon_threads = True
    allow_reuse_address = True


def build_server(
    app_root: Path,
    port: int = 8770,
    repo_root: Path | None = None,
    host: str = "127.0.0.1",
) -> _ThreadedServer:
    """Build the server without starting it.

    Separated from :func:`serve` so tests can drive the real routes over a real
    socket on an ephemeral port. Testing the service object alone would leave
    the part most likely to break - decoding, dispatch and error mapping -
    entirely unexercised.
    """
    service = WorkspaceService(repo_root)

    handler = type(
        "BoundWorkspaceHandler",
        (WorkspaceHandler,),
        {"service": service, "app_root": app_root},
    )

    def factory(*args: Any, **kwargs: Any) -> Any:
        # The handler class is built at run time so the service can be bound to
        # it; its exact type is not expressible here without a cast that would
        # claim more than is known.
        return handler(*args, directory=str(app_root), **kwargs)

    return _ThreadedServer((host, port), factory)


def serve(
    app_root: Path,
    port: int | None = None,
    repo_root: Path | None = None,
    settings: Settings | None = None,
) -> None:
    """Serve the application, locally or in a container.

    The banner prints what the configuration actually is rather than what it was
    asked for. A deployment that is quietly listening to the world should say so
    on its first line of output, not in a setting somebody has to go and read.
    """
    chosen = settings or load_settings()
    bind_port = port if port is not None else chosen.port

    with build_server(app_root, bind_port, repo_root, host=chosen.host) as httpd:
        actual = httpd.server_address[1]
        shown = "127.0.0.1" if chosen.host in ("0.0.0.0", "::") else chosen.host  # noqa: S104
        print(f"Image & PDF Workspace [{chosen.environment}]  ->  http://{shown}:{actual}/")
        print(f"  serving {app_root}")
        print(f"  listening on {chosen.host}:{actual}")
        for warning in chosen.warnings():
            print(f"  WARNING: {warning}")
        print("  Ctrl+C to stop")
        httpd.serve_forever()
