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

    color_helpers = next(
        item for item in register["components"] if item["component_id"] == "csstools-color-helpers"
    )
    locked_color_helpers = lock["packages"]["node_modules/@csstools/color-helpers"]
    assert locked_color_helpers["version"] == "5.1.0"
    assert locked_color_helpers["license"] == "MIT-0"
    assert locked_color_helpers["integrity"].startswith("sha512-")
    assert color_helpers["pinned_version"] == "5.1.0"
    assert color_helpers["licence_id"] == "MIT-0"
    assert color_helpers["disposition"] == "approved"

    reviewed_optional = {
        "expand-template": ("2.0.3", "(MIT OR WTFPL)"),
        "rc-node": ("1.2.8", "(BSD-2-Clause OR MIT OR Apache-2.0)"),
    }
    for component_id, (version, licence) in reviewed_optional.items():
        package_name = "rc" if component_id == "rc-node" else component_id
        locked = lock["packages"][f"node_modules/{package_name}"]
        recorded = next(
            item for item in register["components"] if item["component_id"] == component_id
        )
        assert locked["version"] == version
        assert locked["license"] == licence
        assert locked["integrity"].startswith("sha512-")
        assert recorded["pinned_version"] == version
        assert recorded["licence_id"] == licence
        assert recorded["disposition"] == "approved"
