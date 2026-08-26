"""Serve the browser lab locally. Zero dependencies.

The lab must be served over ``http://localhost`` rather than opened as a
``file://`` URL. Not a preference: ``crypto.subtle`` is only available in a secure
context, and without it the lab cannot compute the content-addressed identifier
that makes a browser result comparable with a server result. ``file://`` is not a
secure context, so the lab would load and then fail at the one thing it exists to
do.

``http.server`` from the standard library is enough. A dev server framework would
add a dependency, and dependencies here are licence-register entries.

    python tools/serve_browser_lab.py            # build reminder, then serve
    python tools/serve_browser_lab.py --port 8080
"""

from __future__ import annotations

import argparse
import http.server
import socketserver
import sys
import webbrowser
from functools import partial
from pathlib import Path


def repo_root_from_here() -> Path:
    return Path(__file__).resolve().parents[1]


def lab_root(repo_root: Path) -> Path:
    return repo_root / "apps" / "browser-lab"


class LabRequestHandler(http.server.SimpleHTTPRequestHandler):
    """Static handler with the headers a module-based lab needs."""

    def end_headers(self) -> None:
        # Modules and workers are fetched with CORS semantics even same-origin in
        # some configurations; being explicit avoids a confusing failure.
        self.send_header("Cache-Control", "no-store")
        # Cross-origin isolation. Not required today, but it is what a future
        # SharedArrayBuffer or WASM-threads experiment would need, and setting it
        # now means the lab's measurements stay comparable if that arrives.
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        super().end_headers()

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - stdlib signature
        # Quieter than the default, and deliberately never logs a request body.
        sys.stderr.write(f"  {format % args}\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Serve the browser lab over localhost.")
    parser.add_argument("--port", type=int, default=8173)
    parser.add_argument("--no-open", action="store_true", help="do not open a browser window")
    parser.add_argument("--repo-root", type=Path, default=repo_root_from_here())
    args = parser.parse_args(argv)

    root = lab_root(args.repo_root)
    if not (root / "index.html").is_file():
        sys.stderr.write(f"browser lab not found at {root}\n")
        return 1

    built = root / "public" / "dist" / "apps" / "browser-lab" / "src" / "main.js"
    if not built.is_file():
        sys.stderr.write(
            "The lab has not been built. TypeScript does not run in a browser.\n"
            "  npm install\n"
            "  npm run build --workspace ipw-browser-lab\n"
        )
        return 1

    handler = partial(LabRequestHandler, directory=str(root))
    url = f"http://localhost:{args.port}/"

    with socketserver.TCPServer(("127.0.0.1", args.port), handler) as server:
        sys.stdout.write(f"browser lab: {url}\n")
        sys.stdout.write("bound to 127.0.0.1 only; nothing is exposed to the network\n")
        sys.stdout.write("Ctrl+C to stop\n\n")
        if not args.no_open:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            sys.stdout.write("\nstopped\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
