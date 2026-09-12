BEGIN;

-- Batch configuration is frozen at submission. Execution remains in the
-- existing per-document export jobs, so each item keeps independent leases,
-- checkpoints, retries, provenance, output state and usage evidence.
CREATE TABLE batch_runs (
  batch_id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),
  actor_id text NOT NULL REFERENCES actors(actor_id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  plan_sha256 char(64) NOT NULL CHECK (plan_sha256 ~ '^[0-9a-f]{64}$'),
  cancellation_requested_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (workspace_id, batch_id),
  FOREIGN KEY (workspace_id, actor_id)
    REFERENCES memberships(workspace_id, actor_id)
);

CREATE TABLE batch_groups (
  group_id text NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),
  batch_id text NOT NULL REFERENCES batch_runs(batch_id),
  position integer NOT NULL CHECK (position BETWEEN 0 AND 49),
  compatibility_sha256 char(64) NOT NULL CHECK (compatibility_sha256 ~ '^[0-9a-f]{64}$'),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 200),
  representative_item_id text NOT NULL,
  representative_preview_id text NOT NULL,
  exception_count integer NOT NULL CHECK (exception_count BETWEEN 0 AND 50),
  UNIQUE (workspace_id, batch_id, group_id),
  UNIQUE (batch_id, position),
  FOREIGN KEY (workspace_id, batch_id)
    REFERENCES batch_runs(workspace_id, batch_id)
);

CREATE TABLE batch_items (
  batch_item_id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),
  batch_id text NOT NULL REFERENCES batch_runs(batch_id),
  client_item_id text NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 49),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 300),
  document_id text NOT NULL REFERENCES editor_documents(document_id),
  document_version_id text NOT NULL REFERENCES document_versions(document_version_id),
  recipe_id text NOT NULL,
  recipe_version integer NOT NULL CHECK (recipe_version > 0),
  group_id text,
  included boolean NOT NULL,
  exclusion_reason text CHECK (exclusion_reason IS NULL OR char_length(exclusion_reason) BETWEEN 1 AND 500),
  requires_individual_confirmation boolean NOT NULL,
  confirmation_state text NOT NULL CHECK (confirmation_state IN ('not_required','confirmed')),
  exception_codes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(exception_codes) = 'array'),
  export_request_id text UNIQUE REFERENCES image_export_requests(export_request_id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (workspace_id, batch_id, batch_item_id),
  UNIQUE (batch_id, client_item_id),
  UNIQUE (batch_id, position),
  FOREIGN KEY (workspace_id, batch_id)
    REFERENCES batch_runs(workspace_id, batch_id),
  FOREIGN KEY (workspace_id, document_id)
    REFERENCES editor_documents(workspace_id, document_id),
  FOREIGN KEY (document_id, document_version_id)
    REFERENCES document_versions(document_id, document_version_id),
  FOREIGN KEY (workspace_id, document_id, recipe_id, recipe_version)
    REFERENCES processing_recipes(workspace_id, document_id, recipe_id, version),
  FOREIGN KEY (workspace_id, batch_id, group_id)
    REFERENCES batch_groups(workspace_id, batch_id, group_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, document_id, document_version_id, recipe_id,
               recipe_version, export_request_id)
    REFERENCES image_export_requests(workspace_id, document_id,
               document_version_id, recipe_id, recipe_version,
               export_request_id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (
    (included AND group_id IS NOT NULL AND export_request_id IS NOT NULL
      AND exclusion_reason IS NULL
      AND confirmation_state = CASE
        WHEN requires_individual_confirmation THEN 'confirmed'
        ELSE 'not_required'
      END)
    OR
    (NOT included AND group_id IS NULL AND export_request_id IS NULL
      AND exclusion_reason IS NOT NULL AND confirmation_state = 'not_required'
      AND NOT requires_individual_confirmation)
  )
);

ALTER TABLE enhancement_previews
  ADD CONSTRAINT enhancement_previews_workspace_preview_key
    UNIQUE (workspace_id, preview_id);

ALTER TABLE batch_groups
  ADD CONSTRAINT batch_groups_representative_item_fk
    FOREIGN KEY (workspace_id, batch_id, representative_item_id)
    REFERENCES batch_items(workspace_id, batch_id, batch_item_id)
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT batch_groups_representative_preview_fk
    FOREIGN KEY (workspace_id, representative_preview_id)
    REFERENCES enhancement_previews(workspace_id, preview_id),
  ADD CONSTRAINT batch_groups_representative_unique
    UNIQUE (batch_id, representative_item_id),
  ADD CONSTRAINT batch_groups_preview_unique
    UNIQUE (batch_id, representative_preview_id);

ALTER TABLE processing_jobs
  ADD COLUMN batch_id text,
  ADD COLUMN batch_item_id text,
  ADD CONSTRAINT processing_jobs_batch_pair_check CHECK (
    (batch_id IS NULL AND batch_item_id IS NULL)
    OR
    (kind = 'image_export' AND batch_id IS NOT NULL AND batch_item_id IS NOT NULL)
  ),
  ADD CONSTRAINT processing_jobs_workspace_batch_item_fk
    FOREIGN KEY (workspace_id, batch_id, batch_item_id)
    REFERENCES batch_items(workspace_id, batch_id, batch_item_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX batch_runs_workspace_idx
  ON batch_runs(workspace_id, updated_at DESC, batch_id DESC);
CREATE INDEX batch_items_batch_state_idx
  ON batch_items(workspace_id, batch_id, included, position);
CREATE INDEX batch_items_export_idx
  ON batch_items(workspace_id, export_request_id)
  WHERE export_request_id IS NOT NULL;
CREATE INDEX processing_jobs_batch_idx
  ON processing_jobs(workspace_id, batch_id, batch_item_id, updated_at DESC)
  WHERE batch_id IS NOT NULL;

CREATE TRIGGER batch_groups_append_only
BEFORE UPDATE OR DELETE ON batch_groups
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update();

CREATE TRIGGER batch_items_append_only
BEFORE UPDATE OR DELETE ON batch_items
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update();

INSERT INTO schema_migrations(version) VALUES ('0020_batch_processing');
COMMIT;
