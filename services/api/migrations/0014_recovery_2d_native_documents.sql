BEGIN;

CREATE TABLE editor_documents (
  document_id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),
  project_id text REFERENCES projects(project_id),
  location_kind text NOT NULL CHECK (location_kind IN ('default_files', 'project')),
  default_files_id text REFERENCES default_files_locations(default_files_id),
  kind text NOT NULL CHECK (kind IN ('graphic', 'pdf')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  source_file_id text REFERENCES workspace_files(file_id),
  source_asset_original_id text REFERENCES asset_originals(asset_original_id),
  source_version_id text REFERENCES source_versions(source_version_id),
  current_version_id text NOT NULL,
  current_revision integer NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
  current_snapshot jsonb NOT NULL,
  history_cursor bigint NOT NULL DEFAULT 0 CHECK (history_cursor >= 0),
  created_by_actor_id text NOT NULL REFERENCES actors(actor_id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (
    (location_kind = 'default_files' AND default_files_id IS NOT NULL AND project_id IS NULL)
    OR
    (location_kind = 'project' AND project_id IS NOT NULL AND default_files_id IS NULL)
  ),
  CHECK (
    (source_file_id IS NULL AND source_asset_original_id IS NULL AND source_version_id IS NULL)
    OR
    (source_file_id IS NOT NULL AND source_asset_original_id IS NOT NULL AND source_version_id IS NOT NULL)
  )
);

CREATE TABLE document_versions (
  document_version_id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES editor_documents(document_id),
  sequence integer NOT NULL CHECK (sequence >= 1),
  revision integer NOT NULL CHECK (revision >= 0),
  kind text NOT NULL CHECK (kind IN ('initial', 'autosave_checkpoint', 'named', 'restore', 'save_as')),
  name text,
  based_on_version_id text REFERENCES document_versions(document_version_id),
  restored_from_version_id text REFERENCES document_versions(document_version_id),
  snapshot_sha256 char(64) NOT NULL CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  snapshot jsonb NOT NULL,
  created_by_actor_id text NOT NULL REFERENCES actors(actor_id),
  created_at timestamptz NOT NULL,
  UNIQUE (document_id, sequence)
);

ALTER TABLE editor_documents
  ADD CONSTRAINT editor_documents_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES document_versions(document_version_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE document_operations (
  operation_id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES editor_documents(document_id),
  base_revision integer NOT NULL CHECK (base_revision >= 0),
  resulting_revision integer NOT NULL CHECK (resulting_revision = base_revision + 1),
  mutation jsonb NOT NULL,
  actor_id text NOT NULL REFERENCES actors(actor_id),
  idempotency_key text NOT NULL,
  trace_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE (document_id, resulting_revision)
);

CREATE TABLE document_history_entries (
  history_entry_id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES editor_documents(document_id),
  history_position bigint NOT NULL CHECK (history_position >= 1),
  operation_id text NOT NULL REFERENCES document_operations(operation_id),
  before_snapshot jsonb NOT NULL,
  after_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (document_id, history_position)
);

CREATE TABLE document_leases (
  document_id text PRIMARY KEY REFERENCES editor_documents(document_id),
  lease_id text NOT NULL UNIQUE,
  actor_id text NOT NULL REFERENCES actors(actor_id),
  actor_display_name text NOT NULL,
  state text NOT NULL CHECK (state IN ('active', 'grace', 'released', 'expired')),
  token_hash char(64) NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  acquired_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  grace_expires_at timestamptz NOT NULL,
  takeover_requested_by_actor_id text REFERENCES actors(actor_id),
  takeover_requested_at timestamptz
);

CREATE TABLE import_compatibility_reports (
  compatibility_report_id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),
  document_id text REFERENCES editor_documents(document_id),
  source_file_id text NOT NULL REFERENCES workspace_files(file_id),
  source_version_id text NOT NULL REFERENCES source_versions(source_version_id),
  source_kind text NOT NULL CHECK (source_kind IN ('raster', 'svg', 'psd', 'ai_compatible')),
  state text NOT NULL CHECK (state IN ('compatible', 'limited', 'unsupported')),
  source_preserved boolean NOT NULL DEFAULT true CHECK (source_preserved),
  sanitisation_required boolean NOT NULL DEFAULT false,
  preserved_structures jsonb NOT NULL DEFAULT '[]'::jsonb,
  unsupported_structures jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL
);

CREATE INDEX editor_documents_workspace_updated_idx
  ON editor_documents(workspace_id, updated_at DESC);
CREATE INDEX document_versions_document_sequence_idx
  ON document_versions(document_id, sequence DESC);
CREATE INDEX document_operations_document_revision_idx
  ON document_operations(document_id, resulting_revision);
CREATE INDEX document_history_document_position_idx
  ON document_history_entries(document_id, history_position DESC);
CREATE INDEX compatibility_reports_document_idx
  ON import_compatibility_reports(document_id, created_at DESC);

CREATE TRIGGER document_versions_append_only
BEFORE UPDATE OR DELETE ON document_versions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update();

CREATE TRIGGER document_operations_append_only
BEFORE UPDATE OR DELETE ON document_operations
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update();

CREATE TRIGGER import_compatibility_reports_append_only
BEFORE UPDATE OR DELETE ON import_compatibility_reports
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update();

INSERT INTO schema_migrations(version) VALUES ('0014_recovery_2d_native_documents');
COMMIT;
