BEGIN;

ALTER TABLE object_references
  ADD COLUMN storage_generation text,
  ADD CONSTRAINT object_references_storage_generation_shape
    CHECK (storage_generation IS NULL OR char_length(storage_generation) BETWEEN 1 AND 256);

ALTER TABLE upload_sessions
  ADD COLUMN immutable_provider_generation text,
  ADD CONSTRAINT upload_sessions_immutable_generation_shape
    CHECK (immutable_provider_generation IS NULL OR char_length(immutable_provider_generation) BETWEEN 1 AND 256);

CREATE TABLE source_inspection_facts (
  source_version_id text PRIMARY KEY REFERENCES source_versions(source_version_id),
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),
  asset_original_id text NOT NULL REFERENCES asset_originals(asset_original_id),
  object_reference_id text NOT NULL REFERENCES object_references(object_reference_id),
  source_sha256 char(64) NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  storage_generation text NOT NULL CHECK (char_length(storage_generation) BETWEEN 1 AND 256),
  media_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  width integer CHECK (width IS NULL OR width > 0),
  height integer CHECK (height IS NULL OR height > 0),
  malware_scan_state text NOT NULL CHECK (malware_scan_state = 'clean'),
  inspection_schema_version text NOT NULL,
  inspected_at timestamptz NOT NULL,
  CHECK ((width IS NULL) = (height IS NULL))
);

CREATE INDEX source_inspection_facts_identity_idx
  ON source_inspection_facts(workspace_id, asset_original_id, object_reference_id);

CREATE TRIGGER source_inspection_facts_append_only
BEFORE UPDATE OR DELETE ON source_inspection_facts
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update();

ALTER TABLE preview_provenance
  ADD COLUMN source_width integer CHECK (source_width IS NULL OR source_width > 0),
  ADD COLUMN source_height integer CHECK (source_height IS NULL OR source_height > 0),
  ADD COLUMN source_storage_generation text
    CHECK (source_storage_generation IS NULL OR char_length(source_storage_generation) BETWEEN 1 AND 256),
  ADD CONSTRAINT preview_provenance_source_facts_shape CHECK (
    (source_width IS NULL AND source_height IS NULL AND source_storage_generation IS NULL)
    OR
    (source_width IS NOT NULL AND source_height IS NOT NULL AND source_storage_generation IS NOT NULL)
  );

INSERT INTO schema_migrations(version) VALUES ('0017_recovery_2d_acceptance_integrity');
COMMIT;
