BEGIN;

CREATE TABLE image_quality_requests (
  image_quality_request_id text PRIMARY KEY,
  owner_kind text NOT NULL CHECK (owner_kind IN ('actor','guest')),
  owner_scope text NOT NULL,
  workspace_id text REFERENCES workspaces(workspace_id),
  actor_id text REFERENCES actors(actor_id),
  guest_session_id text REFERENCES guest_sessions(guest_session_id),
  upload_session_id text NOT NULL REFERENCES upload_sessions(upload_session_id),
  source_version_id text NOT NULL,
  source_object_key text NOT NULL,
  source_storage_generation text NOT NULL,
  source_sha256 char(64) NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_media_type text NOT NULL CHECK (source_media_type IN ('image/jpeg','image/png','image/webp')),
  source_byte_size bigint NOT NULL CHECK (source_byte_size > 0),
  source_width integer NOT NULL CHECK (source_width > 0),
  source_height integer NOT NULL CHECK (source_height > 0),
  source_frame_count integer NOT NULL CHECK (source_frame_count > 0),
  source_bit_depth integer NOT NULL CHECK (source_bit_depth BETWEEN 1 AND 32),
  source_has_icc_profile boolean NOT NULL,
  source_colour_primaries text CHECK (source_colour_primaries IS NULL OR source_colour_primaries IN (
    'srgb','display-p3','bt2020','unknown'
  )),
  source_dynamic_range text CHECK (source_dynamic_range IS NULL OR source_dynamic_range IN (
    'sdr','hdr-pq','hdr-hlg','unknown'
  )),
  content_class text NOT NULL CHECK (content_class IN ('photo','illustration','flat-graphic')),
  strength integer NOT NULL CHECK (strength BETWEEN 1 AND 100),
  job_id text NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN (
    'queued','running','retry_wait','succeeded','failed','cancelled'
  )),
  progress_percent integer NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  output_object_key text,
  output_storage_generation text,
  output_sha256 char(64) CHECK (output_sha256 IS NULL OR output_sha256 ~ '^[0-9a-f]{64}$'),
  output_media_type text,
  output_byte_size bigint CHECK (output_byte_size IS NULL OR output_byte_size > 0),
  output_width integer CHECK (output_width IS NULL OR output_width > 0),
  output_height integer CHECK (output_height IS NULL OR output_height > 0),
  output_frame_count integer CHECK (output_frame_count IS NULL OR output_frame_count > 0),
  output_bit_depth integer CHECK (output_bit_depth IS NULL OR output_bit_depth IN (8,16)),
  output_has_icc_profile boolean,
  output_colour_policy text,
  output_colour_primaries text CHECK (output_colour_primaries IS NULL OR output_colour_primaries IN (
    'srgb','display-p3','bt2020','unknown'
  )),
  output_dynamic_range text CHECK (output_dynamic_range IS NULL OR output_dynamic_range IN (
    'sdr','hdr-pq','hdr-hlg','unknown'
  )),
  model_id text,
  model_version text,
  model_sha256 char(64) CHECK (model_sha256 IS NULL OR model_sha256 ~ '^[0-9a-f]{64}$'),
  model_usage text CHECK (model_usage IS NULL OR model_usage IN ('restore','deterministic')),
  deterministic boolean,
  processor_name text,
  processor_version text,
  output_fidelity jsonb,
  failure jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (
    (owner_kind='actor' AND owner_scope=workspace_id AND workspace_id IS NOT NULL
      AND actor_id IS NOT NULL AND guest_session_id IS NULL)
    OR
    (owner_kind='guest' AND owner_scope=guest_session_id AND workspace_id IS NULL
      AND actor_id IS NULL AND guest_session_id IS NOT NULL)
  ),
  CHECK (
    state <> 'succeeded' OR (
      output_object_key IS NOT NULL AND output_storage_generation IS NOT NULL
      AND output_sha256 IS NOT NULL AND output_media_type='image/png'
      AND output_byte_size IS NOT NULL AND output_width IS NOT NULL
      AND output_height IS NOT NULL AND output_frame_count IS NOT NULL
      AND output_bit_depth IS NOT NULL AND output_has_icc_profile IS NOT NULL
      AND output_colour_policy IS NOT NULL AND model_id IS NOT NULL
      AND model_version IS NOT NULL AND model_sha256 IS NOT NULL
      AND model_usage IS NOT NULL AND deterministic IS NOT NULL
      AND processor_name IS NOT NULL AND processor_version IS NOT NULL
      AND jsonb_typeof(output_fidelity)='object'
    )
  )
);

CREATE TABLE image_quality_provenance (
  image_quality_request_id text PRIMARY KEY
    REFERENCES image_quality_requests(image_quality_request_id),
  source_version_id text NOT NULL,
  source_sha256 char(64) NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  output_sha256 char(64) NOT NULL CHECK (output_sha256 ~ '^[0-9a-f]{64}$'),
  model_id text NOT NULL,
  model_version text NOT NULL,
  model_sha256 char(64) NOT NULL CHECK (model_sha256 ~ '^[0-9a-f]{64}$'),
  model_usage text NOT NULL CHECK (model_usage IN ('restore','deterministic')),
  deterministic boolean NOT NULL,
  processor_name text NOT NULL,
  processor_version text NOT NULL,
  parameters jsonb NOT NULL CHECK (jsonb_typeof(parameters)='object'),
  colour_policy text NOT NULL,
  trace_id text NOT NULL,
  job_id text NOT NULL,
  created_at timestamptz NOT NULL,
  CHECK (
    (model_usage='restore' AND NOT deterministic)
    OR (model_usage='deterministic' AND deterministic)
  )
);

CREATE TABLE image_quality_idempotency (
  owner_scope text NOT NULL,
  idempotency_key text NOT NULL,
  command_name text NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  image_quality_request_id text NOT NULL REFERENCES image_quality_requests(image_quality_request_id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (owner_scope,idempotency_key)
);

ALTER TABLE processing_jobs
  DROP CONSTRAINT processing_jobs_kind_check,
  DROP CONSTRAINT processing_jobs_target_check,
  ADD COLUMN image_quality_request_id text,
  ADD CONSTRAINT processing_jobs_kind_check CHECK (kind IN (
    'file_intake_inspection','preview_generation','image_export','pdf_export',
    'export_bundle','image_quality_restore'
  )),
  ADD CONSTRAINT processing_jobs_target_check CHECK (
    (kind='file_intake_inspection' AND upload_session_id IS NOT NULL
      AND document_id IS NULL AND export_request_id IS NULL
      AND pdf_export_request_id IS NULL AND bundle_id IS NULL
      AND image_quality_request_id IS NULL)
    OR
    (kind='preview_generation' AND upload_session_id IS NULL
      AND document_id IS NOT NULL AND export_request_id IS NULL
      AND pdf_export_request_id IS NULL AND bundle_id IS NULL
      AND image_quality_request_id IS NULL AND owner_kind='actor')
    OR
    (kind='image_export' AND upload_session_id IS NULL
      AND document_id IS NOT NULL AND export_request_id IS NOT NULL
      AND pdf_export_request_id IS NULL AND bundle_id IS NULL
      AND image_quality_request_id IS NULL AND owner_kind='actor')
    OR
    (kind='pdf_export' AND upload_session_id IS NULL
      AND document_id IS NOT NULL AND export_request_id IS NULL
      AND pdf_export_request_id IS NOT NULL AND bundle_id IS NULL
      AND image_quality_request_id IS NULL AND owner_kind='actor')
    OR
    (kind='export_bundle' AND upload_session_id IS NULL
      AND document_id IS NULL AND export_request_id IS NOT NULL
      AND pdf_export_request_id IS NULL AND bundle_id IS NOT NULL
      AND image_quality_request_id IS NULL AND owner_kind='actor')
    OR
    (kind='image_quality_restore' AND upload_session_id IS NOT NULL
      AND document_id IS NULL AND export_request_id IS NULL
      AND pdf_export_request_id IS NULL AND bundle_id IS NULL
      AND image_quality_request_id IS NOT NULL)
  ),
  ADD CONSTRAINT processing_jobs_image_quality_request_fk
    FOREIGN KEY (image_quality_request_id)
    REFERENCES image_quality_requests(image_quality_request_id)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE image_quality_requests
  ADD CONSTRAINT image_quality_requests_job_fk FOREIGN KEY (job_id)
    REFERENCES processing_jobs(job_id) DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX image_quality_requests_owner_idx
  ON image_quality_requests(owner_scope,updated_at DESC);
CREATE INDEX image_quality_requests_expiry_idx
  ON image_quality_requests(expires_at) WHERE owner_kind='guest';

CREATE TRIGGER image_quality_provenance_append_only
BEFORE UPDATE OR DELETE ON image_quality_provenance
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update();

INSERT INTO schema_migrations(version) VALUES ('0024_image_quality_jobs');
COMMIT;
