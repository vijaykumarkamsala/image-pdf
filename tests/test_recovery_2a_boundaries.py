"""Recovery 2A product-kernel boundary and migration guards."""

from __future__ import annotations

import json
from pathlib import Path


def test_product_runtime_does_not_import_visual_or_poc_evidence(repo_root: Path) -> None:
    roots = [repo_root / "apps" / "web" / "src", repo_root / "services" / "api" / "src"]
    forbidden = (
        "visual-reference",
        "PRODUCT_V2_VISUAL_REFERENCE",
        "apps/workspace-legacy",
        "apps/browser-lab",
        "services/benchmark-runner",
        "ipw.benchmark_runner",
        "ipw.processors",
    )
    offenders: list[str] = []
    for root in roots:
        for path in root.rglob("*"):
            if path.is_file() and path.suffix in {".ts", ".tsx", ".css"}:
                body = path.read_text(encoding="utf-8")
                if any(token in body for token in forbidden):
                    offenders.append(path.relative_to(repo_root).as_posix())
    assert offenders == []


def test_customer_runtime_dependencies_are_production_scoped(repo_root: Path) -> None:
    api = json.loads((repo_root / "services" / "api" / "package.json").read_text(encoding="utf-8"))
    web = json.loads((repo_root / "apps" / "web" / "package.json").read_text(encoding="utf-8"))
    assert "pg" in api["dependencies"]
    assert "pg-mem" not in api.get("dependencies", {})
    assert "pg-mem" not in api.get("devDependencies", {})
    assert "@playwright/test" not in web["dependencies"]
    assert "@axe-core/playwright" not in web["dependencies"]
    assert "react-router-dom" in web["dependencies"]


def test_migration_keeps_identity_location_and_references_separate(repo_root: Path) -> None:
    migration = (
        repo_root / "services" / "api" / "migrations" / "0001_recovery_2a_product_kernel.sql"
    ).read_text(encoding="utf-8")
    asset_block = migration.split("CREATE TABLE asset_originals", 1)[1].split("CREATE TABLE", 1)[0]
    source_block = migration.split("CREATE TABLE source_versions", 1)[1].split("CREATE TABLE", 1)[0]
    file_block = migration.split("CREATE TABLE workspace_files", 1)[1].split("CREATE TABLE", 1)[0]
    assert "project_id" not in asset_block
    assert "default_files_id" not in asset_block
    assert "project_id" not in source_block
    assert "canonical_location_kind" in file_block
    assert "CREATE TABLE reusable_file_references" in migration
    assert "asset_originals_immutable" in migration
    assert "source_versions_immutable" in migration


def test_migration_is_bounded_and_zero_charge(repo_root: Path) -> None:
    migration = (
        (repo_root / "services" / "api" / "migrations" / "0001_recovery_2a_product_kernel.sql")
        .read_text(encoding="utf-8")
        .lower()
    )
    assert "customer_amount = 0" in migration
    assert "credit_debit = 0" in migration
    assert "create table usage_admin_dimensions" in migration
    for forbidden in ("esign", "payment", "invoice", "pdf_editor", "image_editor", "model_weight"):
        assert forbidden not in migration


def test_no_native_mobile_workspace_was_created(repo_root: Path) -> None:
    assert not (repo_root / "apps" / "mobile").exists()
    assert not (repo_root / "apps" / "android").exists()
    assert not (repo_root / "apps" / "ios").exists()
