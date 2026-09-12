BEGIN;

ALTER TABLE source_inspection_facts
  ADD COLUMN orientation integer CHECK (orientation IS NULL OR orientation BETWEEN 1 AND 8),
  ADD COLUMN has_alpha boolean,
  ADD COLUMN bit_depth integer CHECK (bit_depth IS NULL OR bit_depth > 0),
  ADD COLUMN has_icc_profile boolean,
  ADD COLUMN sensitive_metadata jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(sensitive_metadata) = 'array');

-- Recovery 2D made inspection evidence immutable. This migration performs the
-- one controlled enrichment from the already-bound upload facts, then restores
-- the append-only guard before any Recovery 2E tables are exposed.
ALTER TABLE source_inspection_facts DISABLE TRIGGER source_inspection_facts_append_only;
UPDATE source_inspection_facts facts
SET orientation = NULLIF(upload.source_facts->>'orientation', '')::integer,
    has_alpha = NULLIF(upload.source_facts->>'has_alpha', '')::boolean,
    bit_depth = NULLIF(upload.source_facts->>'bit_depth', '')::integer,
    has_icc_profile = NULLIF(upload.source_facts->>'has_icc_profile', '')::boolean,
    sensitive_metadata = COALESCE(upload.source_facts->'sensitive_metadata', '[]'::jsonb)
FROM upload_sessions upload
WHERE upload.source_version_id = facts.source_version_id
  AND upload.source_facts IS NOT NULL;
ALTER TABLE source_inspection_facts ENABLE TRIGGER source_inspection_facts_append_only;

CREATE TABLE processing_recipes (
  recipe_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),
  document_id text NOT NULL REFERENCES editor_documents(document_id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  operations jsonb NOT NULL,
  deterministic boolean NOT NULL DEFAULT true CHECK (deterministic),
  created_by_actor_id text NOT NULL REFERENCES actors(actor_id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (recipe_id, version),
  CHECK (jsonb_typeof(operations) = 'array')
);

CREATE UNIQUE INDEX processing_recipes_current_name_idx
  ON processing_recipes(workspace_id, document_id, recipe_id, version DESC);

CREATE TABLE recommendation_sets (
  recommendation_set_id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),
  document_id text NOT NULL REFERENCES editor_documents(document_id),
  document_version_id text NOT NULL REFERENCES document_versions(document_version_id),
  intended_outcome text,
  intended_outcome_required boolean NOT NULL DEFAULT false,
  source_facts_summary jsonb NOT NULL,
  recommendations jsonb NOT NULL,
  no_correction_needed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  UNIQUE (workspace_id, document_id, document_version_id, intended_outcome),
  CHECK (jsonb_typeof(source_facts_summary) = 'array'),
  CHECK (jsonb_typeof(recommendations) = 'array')
);

CREATE TABLE image_export_requests (
  export_request_id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),
  actor_id text NOT NULL REFERENCES actors(actor_id),
  document_id text NOT NULL REFERENCES editor_documents(document_id),
  document_version_id text NOT NULL REFERENCES document_versions(document_version_id),
  recipe_id text NOT NULL,
  recipe_version integer NOT NULL,
  job_id text NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN (
    'queued','running','partially_completed','completed','failed','cancelled'
  )),
  estimated_min_bytes bigint NOT NULL CHECK (estimated_min_bytes >= 0),
  estimated_max_bytes bigint NOT NULL CHECK (estimated_max_bytes >= estimated_min_bytes),
  estimate_explanation text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (recipe_id, recipe_version) REFERENCES processing_recipes(recipe_id, version)
);

CREATE TABLE image_export_outputs (
  output_id text PRIMARY KEY,
  export_request_id text NOT NULL REFERENCES image_export_requests(export_request_id),
  artboard_id text NOT NULL,
  profile jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','running','succeeded','failed','cancelled')),
  progress_percent integer NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  filename text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 512),
  object_reference_id text REFERENCES object_references(object_reference_id),
  sha256 char(64) CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint CHECK (byte_size IS NULL OR byte_size > 0),
  width integer CHECK (width IS NULL OR width > 0),
  height integer CHECK (height IS NULL OR height > 0),
  media_type text,
  failure_code text,
  failure_message text,
  completed_at timestamptz,
  UNIQUE (export_request_id, artboard_id, filename),
  CHECK (jsonb_typeof(profile) = 'object'),
  CHECK (
    (state = 'succeeded' AND object_reference_id IS NOT NULL AND sha256 IS NOT NULL
      AND byte_size IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL
      AND media_type IS NOT NULL AND completed_at IS NOT NULL)
    OR state <> 'succeeded'
  )
);

CREATE TABLE export_provenance (
  provenance_id text PRIMARY KEY,
  output_id text NOT NULL UNIQUE REFERENCES image_export_outputs(output_id),
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),
  document_id text NOT NULL REFERENCES editor_documents(document_id),
  document_version_id text NOT NULL REFERENCES document_versions(document_version_id),
  source_version_ids jsonb NOT NULL,
  recipe_id text NOT NULL,
  recipe_version integer NOT NULL,
  processor_name text NOT NULL,
  processor_version text NOT NULL,
  deterministic boolean NOT NULL,
  parameters_sha256 char(64) NOT NULL CHECK (parameters_sha256 ~ '^[0-9a-f]{64}$'),
  output_sha256 char(64) NOT NULL CHECK (output_sha256 ~ '^[0-9a-f]{64}$'),
  metadata_policy jsonb NOT NULL,
  metadata_verified boolean NOT NULL,
  trace_id text NOT NULL,
  job_id text NOT NULL,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (recipe_id, recipe_version) REFERENCES processing_recipes(recipe_id, version),
  CHECK (jsonb_typeof(source_version_ids) = 'array'),
  CHECK (jsonb_typeof(metadata_policy) = 'object')
);

CREATE TABLE export_bundles (
  bundle_id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),
  export_request_id text NOT NULL REFERENCES image_export_requests(export_request_id),
  job_id text NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('queued','running','succeeded','failed','cancelled')),
  items jsonb NOT NULL,
  object_reference_id text REFERENCES object_references(object_reference_id),
  sha256 char(64) CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint CHECK (byte_size IS NULL OR byte_size > 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  CHECK (jsonb_typeof(items) = 'array')
);

CREATE TABLE export_idempotency_records (
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),
  idempotency_key text NOT NULL,
  command_name text NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  resource_id text NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, idempotency_key)
);

ALTER TABLE processing_jobs
  DROP CONSTRAINT processing_jobs_kind_check,
  DROP CONSTRAINT processing_jobs_target_check,
  ADD COLUMN export_request_id text REFERENCES image_export_requests(export_request_id),
  ADD COLUMN bundle_id text REFERENCES export_bundles(bundle_id),
  ADD CONSTRAINT processing_jobs_kind_check CHECK (kind IN (
    'file_intake_inspection','preview_generation','image_export','export_bundle'
  )),
  ADD CONSTRAINT processing_jobs_target_check CHECK (
    (kind = 'file_intake_inspection' AND upload_session_id IS NOT NULL
      AND document_id IS NULL AND export_request_id IS NULL AND bundle_id IS NULL)
    OR
    (kind = 'preview_generation' AND upload_session_id IS NULL
      AND document_id IS NOT NULL AND export_request_id IS NULL AND bundle_id IS NULL
      AND owner_kind = 'actor')
    OR
    (kind = 'image_export' AND upload_session_id IS NULL
      AND document_id IS NOT NULL AND export_request_id IS NOT NULL AND bundle_id IS NULL
      AND owner_kind = 'actor')
    OR
    (kind = 'export_bundle' AND upload_session_id IS NULL
      AND document_id IS NULL AND export_request_id IS NOT NULL AND bundle_id IS NOT NULL
      AND owner_kind = 'actor')
  );

ALTER TABLE image_export_requests
  ADD CONSTRAINT image_export_requests_job_fk FOREIGN KEY (job_id)
  REFERENCES processing_jobs(job_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE export_bundles
  ADD CONSTRAINT export_bundles_job_fk FOREIGN KEY (job_id)
  REFERENCES processing_jobs(job_id) DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX image_export_requests_workspace_idx
  ON image_export_requests(workspace_id, updated_at DESC);
CREATE INDEX image_export_outputs_request_idx
  ON image_export_outputs(export_request_id, state, output_id);
CREATE INDEX export_bundles_request_idx
  ON export_bundles(export_request_id, created_at DESC);

CREATE TRIGGER processing_recipes_append_only
BEFORE UPDATE OR DELETE ON processing_recipes
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update();

CREATE TRIGGER recommendation_sets_append_only
BEFORE UPDATE OR DELETE ON recommendation_sets
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update();

CREATE TRIGGER export_provenance_append_only
BEFORE UPDATE OR DELETE ON export_provenance
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update();

INSERT INTO schema_migrations(version) VALUES ('0018_recovery_2e_enhancement_exports');
COMMIT;
