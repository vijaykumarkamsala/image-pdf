import json
import tomllib
from pathlib import Path

from ipw.contracts.licence import Disposition
from ipw.licence_registry import load_release_register


def test_native_pdf_runtime_is_exactly_pinned_and_commercially_approved(repo_root: Path) -> None:
    project = tomllib.loads(
        (repo_root / "services" / "processing-worker" / "pyproject.toml").read_text("utf-8")
    )
    dependencies = set(project["project"]["dependencies"])
    assert "reportlab==5.0.1" in dependencies
    assert "pypdf==6.18.1" in dependencies

    register = load_release_register(repo_root)
    expected = {
        "reportlab": "5.0.1",
        "pypdf": "6.18.1",
        "pillow": "12.3.0",
    }
    for component_id, version in expected.items():
        component = register.get(component_id)
        assert component is not None
        assert component.disposition is Disposition.APPROVED
        assert component.pinned_version == version
        assert component.supply_chain_gaps() == ()
        assert register.effective_disposition(component_id) is Disposition.APPROVED

    editor_register = json.loads(
        (repo_root / "data" / "licences" / "production-editor.json").read_text("utf-8")
    )
    font = next(
        component
        for component in editor_register["components"]
        if component["component_id"] == "aileron-ipw-standard"
    )
    assert font["disposition"] == "approved"
    assert font["licence_id"] == "CC0-1.0"
    assert font["pinned_version"] == "0.102-pillow-12.3.0-subset"
