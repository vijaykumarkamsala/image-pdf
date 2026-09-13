"""Static guards for the Recovery 2E corrective migration and contract line."""

from __future__ import annotations

from pathlib import Path


def test_corrective_migration_preserves_success_and_binds_relationships(repo_root: Path) -> None:
    migration = (
        repo_root
        / "services"
        / "api"
        / "migrations"
        / "0019_recovery_2e_production_correctness.sql"
    ).read_text(encoding="utf-8")

    assert "SET state='failed'" not in migration
    assert "output-verification-required" not in migration
    assert "DISABLE TRIGGER export_provenance_append_only" in migration
    assert "ENABLE TRIGGER export_provenance_append_only" in migration
    assert "image_export_outputs_workspace_request_fk" in migration
    assert "export_provenance_workspace_request_output_fk" in migration
    assert "recommendation_sets_workspace_document_fk" in migration
    assert "FOREIGN KEY (workspace_id, recommendation_set_id)" in migration
    assert "FOREIGN KEY (workspace_id, export_request_id, output_id)" in migration
    assert "CHECK (request_kind = 'enhancement_preview')" in migration


def test_product_contract_line_includes_batch_contracts(repo_root: Path) -> None:
    version = (
        repo_root / "packages" / "contracts" / "src" / "ipw" / "contracts" / "version.py"
    ).read_text(encoding="utf-8")

    assert 'PRODUCT_SCHEMA_VERSION = "1.22.0"' in version
    assert (
        repo_root / "packages" / "schemas" / "product-v1" / "batch-run-record.schema.json"
    ).is_file()
