"""Run the Image & PDF Workspace locally.

    python tools/serve_workspace.py
    python tools/serve_workspace.py --port 9000 --no-browser

Serves the application and its API from one origin on localhost. Zero
dependencies beyond what the benchmark already uses: the server is
``http.server`` and the interface is plain ES modules, so there is nothing to
install and nothing to build before it runs.
"""

from __future__ import annotations

import argparse
import sys
import webbrowser
from pathlib import Path


def repo_root_from_here() -> Path:
    return Path(__file__).resolve().parents[1]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Serve the Image & PDF Workspace.")
    parser.add_argument("--port", type=int, default=8770)
    parser.add_argument("--no-browser", action="store_true", help="do not open a browser")
    args = parser.parse_args(argv)

    root = repo_root_from_here()
    for candidate in (
        root / "services" / "workspace-api" / "src",
        root / "packages" / "contracts" / "src",
        root / "packages" / "processors" / "src",
        root / "services" / "benchmark-runner" / "src",
    ):
        if str(candidate) not in sys.path:
            sys.path.insert(0, str(candidate))

    from ipw.workspace_api.http import serve

    app_root = root / "apps" / "workspace"
    if not (app_root / "index.html").is_file():
        sys.stderr.write(f"application files are missing from {app_root}\n")
        return 1

    if not args.no_browser:
        webbrowser.open(f"http://127.0.0.1:{args.port}/")
    try:
        serve(app_root, port=args.port, repo_root=root)
    except KeyboardInterrupt:
        sys.stdout.write("\nstopped\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
