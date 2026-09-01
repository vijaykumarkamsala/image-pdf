BEGIN;

ALTER TABLE processing_jobs
  DROP CONSTRAINT processing_jobs_kind_check,
  DROP CONSTRAINT processing_jobs_upload_session_id_key,
  ALTER COLUMN upload_session_id DROP NOT NULL,
  ADD COLUMN document_id text REFERENCES editor_documents(document_id),
  ADD CONSTRAINT processing_jobs_kind_check CHECK (kind IN (
    'file_intake_inspection', 'preview_generation'
  )),
  ADD CONSTRAINT processing_jobs_target_check CHECK (
    (kind = 'file_intake_inspection' AND upload_session_id IS NOT NULL AND document_id IS NULL)
    OR
    (kind = 'preview_generation' AND upload_session_id IS NULL AND document_id IS NOT NULL
      AND owner_kind = 'actor')
  );

CREATE UNIQUE INDEX processing_jobs_upload_session_unique_idx
  ON processing_jobs(upload_session_id) WHERE upload_session_id IS NOT NULL;
CREATE INDEX processing_jobs_document_idx
  ON processing_jobs(workspace_id, document_id, updated_at DESC)
  WHERE document_id IS NOT NULL;

ALTER TABLE editor_documents
  ADD COLUMN preview_state text NOT NULL DEFAULT 'not_required'
    CHECK (preview_state IN ('not_required','preparing','ready','failed','cancelled')),
  ADD COLUMN preview_job_id text,
  ADD COLUMN current_preview_id text;

CREATE TABLE preview_provenance (
  preview_id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES editor_documents(document_id),
  document_version_id text REFERENCES document_versions(document_version_id),
  source_version_id text NOT NULL REFERENCES source_versions(source_version_id),
  object_reference_id text NOT NULL REFERENCES object_references(object_reference_id),
  job_id text NOT NULL REFERENCES processing_jobs(job_id),
  trace_id text NOT NULL,
  processor_name text NOT NULL,
  processor_version text NOT NULL,
  zoom_level text NOT NULL CHECK (zoom_level IN ('workspace','thumbnail')),
  source_sha256 char(64) NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 4096),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 4096),
  colour_decision text NOT NULL,
  metadata_decision text NOT NULL,
  authoritative boolean NOT NULL DEFAULT false CHECK (NOT authoritative),
  created_at timestamptz NOT NULL,
  UNIQUE (document_id, source_version_id, zoom_level, sha256)
);

ALTER TABLE editor_documents
  ADD CONSTRAINT editor_documents_preview_job_fk
  FOREIGN KEY (preview_job_id) REFERENCES processing_jobs(job_id)
  DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT editor_documents_current_preview_fk
  FOREIGN KEY (current_preview_id) REFERENCES preview_provenance(preview_id)
  DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT editor_documents_preview_shape CHECK (
    (preview_state = 'not_required' AND preview_job_id IS NULL AND current_preview_id IS NULL)
    OR (preview_state = 'preparing' AND preview_job_id IS NOT NULL AND current_preview_id IS NULL)
    OR (preview_state = 'ready' AND preview_job_id IS NOT NULL AND current_preview_id IS NOT NULL)
    OR (preview_state IN ('failed','cancelled') AND preview_job_id IS NOT NULL AND current_preview_id IS NULL)
  );

CREATE INDEX preview_provenance_document_level_idx
  ON preview_provenance(document_id, zoom_level, created_at DESC);

CREATE TRIGGER preview_provenance_append_only
BEFORE UPDATE OR DELETE ON preview_provenance
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update();

INSERT INTO schema_migrations(version) VALUES ('0016_recovery_2d_preview_jobs');
COMMIT;
