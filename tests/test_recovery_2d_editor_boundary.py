"""Recovery 2D native-document and browser-renderer boundary guards."""

from __future__ import annotations

from pathlib import Path


def test_fabric_is_isolated_to_the_replaceable_renderer_adapter(repo_root: Path) -> None:
    editor_root = repo_root / "apps" / "web" / "src" / "editor"
    fabric_imports = [
        path.relative_to(repo_root).as_posix()
        for path in editor_root.rglob("*.ts*")
        if 'from "fabric"' in path.read_text(encoding="utf-8")
    ]
    assert fabric_imports == ["apps/web/src/editor/renderer/FabricEditorRenderer.ts"]


def test_native_document_authority_contains_no_fabric_serialization(repo_root: Path) -> None:
    authoritative = [
        repo_root / "packages" / "contracts" / "src" / "ipw" / "contracts" / "editor.py",
        repo_root / "services" / "api" / "src" / "domains" / "documents" / "document-model.ts",
        repo_root / "services" / "api" / "migrations" / "0014_recovery_2d_native_documents.sql",
    ]
    forbidden = ("fabric", "tojson()", "canvas_json", "canvasjson")
    offenders = [
        path.relative_to(repo_root).as_posix()
        for path in authoritative
        if any(token in path.read_text(encoding="utf-8").lower() for token in forbidden)
    ]
    assert offenders == []


def test_editor_runtime_does_not_cross_deferred_or_poc_boundaries(repo_root: Path) -> None:
    roots = [
        repo_root / "apps" / "web" / "src" / "editor",
        repo_root / "services" / "api" / "src" / "domains" / "documents",
    ]
    forbidden = (
        "apps/workspace-legacy",
        "apps/browser-lab",
        "services/benchmark-runner",
        "ipw.benchmark_runner",
        "ipw.processors",
        "custom-pdf",
        "model-weight",
    )
    offenders: list[str] = []
    for root in roots:
        for path in root.rglob("*"):
            if path.is_file() and path.suffix in {".ts", ".tsx"}:
                body = path.read_text(encoding="utf-8").lower()
                if any(token in body for token in forbidden):
                    offenders.append(path.relative_to(repo_root).as_posix())
    assert offenders == []
