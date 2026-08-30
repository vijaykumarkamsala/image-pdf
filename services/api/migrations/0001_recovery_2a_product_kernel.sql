BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE actors (
  actor_id text PRIMARY KEY,
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL
);

CREATE TABLE identity_references (
  identity_id text PRIMARY KEY,
  actor_id text NOT NULL REFERENCES actors(actor_id),
  provider text NOT NULL CHECK (provider IN ('local_test', 'oidc')),
  provider_subject text NOT NULL,
  UNIQUE (provider, provider_subject)
);

CREATE TABLE workspaces (
  workspace_id text PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  personal_for_actor_id text UNIQUE REFERENCES actors(actor_id),
  home_region text,
  created_at timestamptz NOT NULL
);

CREATE TABLE memberships (
  membership_id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),
  actor_id text NOT NULL REFERENCES actors(actor_id),
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at timestamptz NOT NULL,
  UNIQUE (workspace_id, actor_id)
);

CREATE TABLE permission_grants (
  grant_id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),
  actor_id text NOT NULL REFERENCES actors(actor_id),
  permission text NOT NULL,
  allowed boolean NOT NULL,
  UNIQUE (workspace_id, actor_id, permission)
);

CREATE TABLE workspace_project_policies (
  workspace_id text PRIMARY KEY REFERENCES workspaces(workspace_id),
  allow_collections boolean NOT NULL DEFAULT true,
  allow_subprojects boolean NOT NULL DEFAULT true
);

CREATE TABLE default_files_locations (
  default_files_id text PRIMARY KEY,
  workspace_id text NOT NULL UNIQUE REFERENCES workspaces(workspace_id),
  name text NOT NULL DEFAULT 'Default Files' CHECK (name = 'Default Files')
);

CREATE TABLE collections (
  collection_id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL
);

CREATE TABLE projects (
  project_id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  parent_project_id text REFERENCES projects(project_id),
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL
);

CREATE TABLE collection_projects (
  collection_id text NOT NULL REFERENCES collections(collection_id),
  project_id text NOT NULL REFERENCES projects(project_id),
  PRIMARY KEY (collection_id, project_id)
);

CREATE TABLE object_references (
  object_reference_id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),
  object_key text NOT NULL,
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  media_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  created_at timestamptz NOT NULL,
  UNIQUE (workspace_id, object_key)
);

CREATE TABLE asset_originals (
  asset_original_id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),
  object_reference_id text NOT NULL REFERENCES object_references(object_reference_id),
  original_filename text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE source_versions (
  source_version_id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),
  asset_original_id text NOT NULL REFERENCES asset_originals(asset_original_id),
  object_reference_id text NOT NULL REFERENCES object_references(object_reference_id),
  sequence integer NOT NULL CHECK (sequence >= 1),
  previous_source_version_id text REFERENCES source_versions(source_version_id),
  created_at timestamptz NOT NULL,
  UNIQUE (asset_original_id, sequence)
);

CREATE TABLE workspace_files (
  file_id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),
  asset_original_id text NOT NULL REFERENCES asset_originals(asset_original_id),
  current_source_version_id text NOT NULL REFERENCES source_versions(source_version_id),
  display_name text NOT NULL,
  canonical_location_kind text NOT NULL CHECK (canonical_location_kind IN ('default_files', 'project')),
  default_files_id text REFERENCES default_files_locations(default_files_id),
  project_id text REFERENCES projects(project_id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (
    (canonical_location_kind = 'default_files' AND default_files_id IS NOT NULL AND project_id IS NULL)
    OR
    (canonical_location_kind = 'project' AND project_id IS NOT NULL AND default_files_id IS NULL)
  )
);

CREATE TABLE reusable_file_references (
  reference_id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),
  file_id text NOT NULL REFERENCES workspace_files(file_id),
  owner_kind text NOT NULL CHECK (owner_kind IN ('project', 'document')),
  owner_id text NOT NULL,
  purpose text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (workspace_id, file_id, owner_kind, owner_id, purpose)
);

CREATE TABLE audit_events (
  audit_event_id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),
  actor_id text NOT NULL REFERENCES actors(actor_id),
  action text NOT NULL,
  resource_kind text NOT NULL,
  resource_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  trace_id text NOT NULL
);

CREATE TABLE usage_events (
  usage_event_id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),
  actor_id text NOT NULL REFERENCES actors(actor_id),
  event_kind text NOT NULL,
  customer_amount numeric(18, 2) NOT NULL DEFAULT 0 CHECK (customer_amount = 0),
  credit_debit integer NOT NULL DEFAULT 0 CHECK (credit_debit = 0),
  currency char(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  occurred_at timestamptz NOT NULL
);

CREATE TABLE usage_admin_dimensions (
  usage_event_id text PRIMARY KEY REFERENCES usage_events(usage_event_id),
  dimensions jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE idempotency_records (
  actor_id text NOT NULL REFERENCES actors(actor_id),
  idempotency_key text NOT NULL,
  command_name text NOT NULL,
  request_hash char(64) NOT NULL,
  response_status integer NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (actor_id, idempotency_key)
);

CREATE INDEX projects_workspace_idx ON projects(workspace_id, archived);
CREATE INDEX files_workspace_location_idx ON workspace_files(workspace_id, canonical_location_kind);
CREATE INDEX refs_workspace_owner_idx ON reusable_file_references(workspace_id, owner_kind, owner_id);
CREATE INDEX audit_workspace_time_idx ON audit_events(workspace_id, occurred_at DESC);
CREATE INDEX usage_workspace_time_idx ON usage_events(workspace_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION reject_immutable_row_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER asset_originals_immutable
BEFORE UPDATE OR DELETE ON asset_originals
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update();

CREATE TRIGGER source_versions_immutable
BEFORE UPDATE OR DELETE ON source_versions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update();

CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update();

CREATE TRIGGER usage_events_append_only
BEFORE UPDATE OR DELETE ON usage_events
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update();

INSERT INTO schema_migrations(version) VALUES ('0001_recovery_2a_product_kernel');
COMMIT;
