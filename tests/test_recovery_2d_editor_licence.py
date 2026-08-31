from __future__ import annotations

import json
from pathlib import Path


def test_fabric_is_exactly_pinned_and_commercially_reviewed(repo_root: Path) -> None:
    web_package = json.loads((repo_root / "apps" / "web" / "package.json").read_text("utf-8"))
    lock = json.loads((repo_root / "package-lock.json").read_text("utf-8"))
    register = json.loads(
        (repo_root / "data" / "licences" / "production-editor.json").read_text("utf-8")
    )

    assert web_package["dependencies"]["fabric"] == "7.4.0"
    assert lock["packages"]["node_modules/fabric"]["version"] == "7.4.0"
    assert lock["packages"]["node_modules/fabric"]["license"] == "MIT"
    component = next(item for item in register["components"] if item["component_id"] == "fabric-js")
    assert component["pinned_version"] == "7.4.0"
    assert component["licence_id"] == "MIT"
    assert component["disposition"] == "approved"
