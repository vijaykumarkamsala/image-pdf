BEGIN;

CREATE TABLE pdf_export_requests (
  pdf_export_request_id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),
  actor_id text NOT NULL REFERENCES actors(actor_id),
  document_id text NOT NULL REFERENCES editor_documents(document_id),
  document_version_id text NOT NULL REFERENCES document_versions(document_version_id),
  snapshot_sha256 char(64) NOT NULL CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  profile jsonb NOT NULL CHECK (jsonb_typeof(profile) = 'object'),
  preflight jsonb NOT NULL CHECK (jsonb_typeof(preflight) = 'object'),
  job_id text NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN (
    'queued','running','succeeded','failed','cancellation_requested','cancelled'
  )),
  failure_code text,
  failure_message text CHECK (failure_message IS NULL OR char_length(failure_message) <= 1000),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (workspace_id, pdf_export_request_id),
  FOREIGN KEY (workspace_id, actor_id)
    REFERENCES memberships(workspace_id, actor_id),
  FOREIGN KEY (workspace_id, document_id)
    REFERENCES editor_documents(workspace_id, document_id),
  FOREIGN KEY (document_id, document_version_id)
    REFERENCES document_versions(document_id, document_version_id)
);

CREATE TABLE pdf_export_results (
  pdf_export_result_id text PRIMARY KEY,
  pdf_export_request_id text NOT NULL UNIQUE REFERENCES pdf_export_requests(pdf_export_request_id),
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),
  document_id text NOT NULL REFERENCES editor_documents(document_id),
  document_version_id text NOT NULL REFERENCES document_versions(document_version_id),
  filename text NOT NULL CHECK (char_length(filename) BETWEEN 5 AND 240),
  media_type text NOT NULL DEFAULT 'application/pdf' CHECK (media_type = 'application/pdf'),
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  page_count integer NOT NULL CHECK (page_count BETWEEN 1 AND 500),
  renderer jsonb NOT NULL CHECK (jsonb_typeof(renderer) = 'object'),
  object_reference_id text NOT NULL REFERENCES object_references(object_reference_id),
  created_at timestamptz NOT NULL,
  UNIQUE (workspace_id, pdf_export_result_id),
  FOREIGN KEY (workspace_id, pdf_export_request_id)
    REFERENCES pdf_export_requests(workspace_id, pdf_export_request_id),
  FOREIGN KEY (workspace_id, document_id)
    REFERENCES editor_documents(workspace_id, document_id),
  FOREIGN KEY (document_id, document_version_id)
    REFERENCES document_versions(document_id, document_version_id),
  FOREIGN KEY (workspace_id, object_reference_id)
    REFERENCES object_references(workspace_id, object_reference_id)
);

CREATE TABLE pdf_export_idempotency_records (
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),
  idempotency_key text NOT NULL,
  command_name text NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  resource_id text NOT NULL,
  response_body jsonb NOT NULL CHECK (jsonb_typeof(response_body) = 'object'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, idempotency_key)
);

ALTER TABLE processing_jobs
  DROP CONSTRAINT processing_jobs_kind_check,
  DROP CONSTRAINT processing_jobs_target_check,
  ADD COLUMN pdf_export_request_id text,
  ADD CONSTRAINT processing_jobs_kind_check CHECK (kind IN (
    'file_intake_inspection','preview_generation','image_export','pdf_export','export_bundle'
  )),
  ADD CONSTRAINT processing_jobs_target_check CHECK (
    (kind = 'file_intake_inspection' AND upload_session_id IS NOT NULL
      AND document_id IS NULL AND export_request_id IS NULL AND pdf_export_request_id IS NULL
      AND bundle_id IS NULL)
    OR
    (kind = 'preview_generation' AND upload_session_id IS NULL
      AND document_id IS NOT NULL AND export_request_id IS NULL AND pdf_export_request_id IS NULL
      AND bundle_id IS NULL AND owner_kind = 'actor')
    OR
    (kind = 'image_export' AND upload_session_id IS NULL
      AND document_id IS NOT NULL AND export_request_id IS NOT NULL AND pdf_export_request_id IS NULL
      AND bundle_id IS NULL AND owner_kind = 'actor')
    OR
    (kind = 'pdf_export' AND upload_session_id IS NULL
      AND document_id IS NOT NULL AND export_request_id IS NULL AND pdf_export_request_id IS NOT NULL
      AND bundle_id IS NULL AND owner_kind = 'actor')
    OR
    (kind = 'export_bundle' AND upload_session_id IS NULL
      AND document_id IS NULL AND export_request_id IS NOT NULL AND pdf_export_request_id IS NULL
      AND bundle_id IS NOT NULL AND owner_kind = 'actor')
  ),
  ADD CONSTRAINT processing_jobs_workspace_pdf_export_fk
    FOREIGN KEY (workspace_id, pdf_export_request_id)
    REFERENCES pdf_export_requests(workspace_id, pdf_export_request_id)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE pdf_export_requests
  ADD CONSTRAINT pdf_export_requests_workspace_job_fk
    FOREIGN KEY (workspace_id, job_id)
    REFERENCES processing_jobs(workspace_id, job_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX pdf_export_requests_workspace_document_idx
  ON pdf_export_requests(workspace_id, document_id, updated_at DESC);

CREATE TRIGGER pdf_export_results_append_only
BEFORE UPDATE OR DELETE ON pdf_export_results
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update();

INSERT INTO schema_migrations(version) VALUES ('0021_native_pdf_creation');
COMMIT;
