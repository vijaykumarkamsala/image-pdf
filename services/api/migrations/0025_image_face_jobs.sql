BEGIN;

-- Retain the exact previous constraints for guarded, lossless rollback. No old
-- migration or existing PDF/Studio target expression is rewritten.
CREATE TABLE image_face_migration_backup (
  singleton boolean PRIMARY KEY CHECK (singleton),
  kind_check text NOT NULL,
  target_check text NOT NULL,
  upload_index text NOT NULL
);
INSERT INTO image_face_migration_backup
SELECT true,
  (SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conrelid='processing_jobs'::regclass AND conname='processing_jobs_kind_check'),
  (SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conrelid='processing_jobs'::regclass AND conname='processing_jobs_target_check'),
  pg_get_indexdef('processing_jobs_upload_session_unique_idx'::regclass);

CREATE TABLE face_quality_jobs (
  face_quality_job_id text PRIMARY KEY,
  job_id text NOT NULL UNIQUE REFERENCES processing_jobs(job_id) DEFERRABLE INITIALLY DEFERRED,
  operation text NOT NULL CHECK (operation IN ('candidates','compose')),
  owner_kind text NOT NULL CHECK (owner_kind IN ('actor','guest')),
  owner_scope text NOT NULL,
  workspace_id text REFERENCES workspaces(workspace_id),
  actor_id text REFERENCES actors(actor_id),
  guest_session_id text REFERENCES guest_sessions(guest_session_id),
  upload_session_id text NOT NULL REFERENCES upload_sessions(upload_session_id),
  base_image_quality_request_id text NOT NULL REFERENCES image_quality_requests(image_quality_request_id),
  source_sha256 char(64) NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  base_output_sha256 char(64) NOT NULL CHECK (base_output_sha256 ~ '^[0-9a-f]{64}$'),
  candidate_request_id text REFERENCES face_quality_jobs(face_quality_job_id),
  candidate_sha256 char(64),
  intent jsonb NOT NULL CHECK (jsonb_typeof(intent)='object'),
  release jsonb NOT NULL CHECK ((jsonb_typeof(release)='object'
    AND release->>'commercial_rights'='approved' AND release->>'quality_review'='approved'
    AND coalesce(length(release->>'rights_evidence_id'),0)>0
    AND coalesce(length(release->>'quality_evidence_id'),0)>0) IS TRUE),
  output jsonb CHECK (output IS NULL OR jsonb_typeof(output)='object'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE(face_quality_job_id,job_id),
  CHECK (
    (owner_kind='actor' AND owner_scope=workspace_id AND workspace_id IS NOT NULL
      AND actor_id IS NOT NULL AND guest_session_id IS NULL)
    OR (owner_kind='guest' AND owner_scope=guest_session_id AND guest_session_id IS NOT NULL
      AND workspace_id IS NULL AND actor_id IS NULL)
  ),
  CHECK ((intent->>'contract_version'='image-quality-face-v1'
    AND intent->'allow_reconstructed_face_detail'='true'::jsonb
    AND intent->>'source_sha256'=source_sha256
    AND intent->>'base_output_sha256'=base_output_sha256) IS TRUE),
  CHECK ((
    (operation='candidates' AND candidate_request_id IS NULL AND candidate_sha256 IS NULL
      AND intent->'candidate_count' IN ('2'::jsonb,'3'::jsonb))
    OR (operation='compose' AND candidate_request_id IS NOT NULL AND candidate_sha256 IS NOT NULL
      AND intent->>'candidate_sha256'=candidate_sha256
      AND intent->>'candidate_request_id'=candidate_request_id
      AND intent->'acknowledged_possible_identity_change'='true'::jsonb)
  ) IS TRUE)
);
CREATE TABLE face_quality_candidates (
  face_quality_job_id text NOT NULL REFERENCES face_quality_jobs(face_quality_job_id),
  candidate_sha256 char(64) NOT NULL CHECK (candidate_sha256 ~ '^[0-9a-f]{64}$'),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 2),
  stored_candidate jsonb NOT NULL CHECK (jsonb_typeof(stored_candidate)='object'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY(face_quality_job_id,candidate_sha256),
  UNIQUE(face_quality_job_id,ordinal)
);
ALTER TABLE face_quality_jobs ADD CONSTRAINT face_quality_selected_candidate_fk
  FOREIGN KEY(candidate_request_id,candidate_sha256)
  REFERENCES face_quality_candidates(face_quality_job_id,candidate_sha256);
CREATE TABLE face_quality_idempotency (
  owner_scope text NOT NULL,
  command_name text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  face_quality_job_id text NOT NULL REFERENCES face_quality_jobs(face_quality_job_id),
  PRIMARY KEY(owner_scope,command_name,idempotency_key)
);
CREATE INDEX face_quality_jobs_owner_idx ON face_quality_jobs(owner_scope,created_at DESC);
CREATE INDEX face_quality_jobs_expiry_idx ON face_quality_jobs(expires_at);
CREATE TRIGGER face_quality_candidates_append_only BEFORE UPDATE OR DELETE ON face_quality_candidates
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update();

CREATE FUNCTION guard_image_face_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE face face_quality_jobs%ROWTYPE; parent face_quality_jobs%ROWTYPE;
BEGIN
  IF NEW.face_quality_job_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO STRICT face FROM face_quality_jobs WHERE face_quality_job_id=NEW.face_quality_job_id;
  IF NEW.kind <> (CASE face.operation WHEN 'candidates' THEN 'image_face_candidates' ELSE 'image_face_compose' END)
    OR NEW.job_id<>face.job_id OR NEW.owner_kind<>face.owner_kind
    OR NEW.workspace_id IS DISTINCT FROM face.workspace_id OR NEW.actor_id IS DISTINCT FROM face.actor_id
    OR NEW.guest_session_id IS DISTINCT FROM face.guest_session_id OR NEW.upload_session_id<>face.upload_session_id THEN
    RAISE EXCEPTION 'Face job owner, operation and target must match';
  END IF;
  IF face.operation='compose' THEN
    SELECT * INTO STRICT parent FROM face_quality_jobs WHERE face_quality_job_id=face.candidate_request_id;
    IF parent.operation<>'candidates' OR parent.owner_scope<>face.owner_scope
      OR parent.upload_session_id<>face.upload_session_id OR parent.source_sha256<>face.source_sha256
      OR parent.base_output_sha256<>face.base_output_sha256 THEN
      RAISE EXCEPTION 'Face composition must belong to its immutable candidate request';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION guard_image_face_inputs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-'output') IS DISTINCT FROM (to_jsonb(OLD)-'output')
    OR OLD.output IS NOT NULL OR NEW.operation<>'compose' THEN
    RAISE EXCEPTION 'Face inputs and published output are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER face_quality_inputs_immutable BEFORE UPDATE ON face_quality_jobs
  FOR EACH ROW EXECUTE FUNCTION guard_image_face_inputs();

-- Bind processing and face records bidirectionally, without a second queue.
ALTER TABLE processing_jobs ADD COLUMN face_quality_job_id text,
  ADD CONSTRAINT processing_jobs_face_target_fk FOREIGN KEY(face_quality_job_id,job_id)
    REFERENCES face_quality_jobs(face_quality_job_id,job_id) DEFERRABLE INITIALLY DEFERRED;
CREATE CONSTRAINT TRIGGER processing_jobs_face_guard AFTER INSERT OR UPDATE ON processing_jobs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_image_face_job();
-- Keep the exact existing upload uniqueness policy for every older job kind.
-- Only isolated face targets are excluded, so several candidates/reviews can
-- belong to the same immutable source without changing ordinary job semantics.
DO $$
DECLARE old_predicate text;
BEGIN
  SELECT pg_get_expr(indpred,indrelid) INTO STRICT old_predicate FROM pg_index
    WHERE indexrelid='processing_jobs_upload_session_unique_idx'::regclass;
  DROP INDEX processing_jobs_upload_session_unique_idx;
  EXECUTE format('CREATE UNIQUE INDEX processing_jobs_upload_session_unique_idx ON processing_jobs(upload_session_id) WHERE face_quality_job_id IS NULL AND (%s)',old_predicate);
END $$;
DO $$
DECLARE old_target text; old_kind text;
BEGIN
  SELECT pg_get_expr(conbin,conrelid) INTO STRICT old_target FROM pg_constraint
    WHERE conrelid='processing_jobs'::regclass AND conname='processing_jobs_target_check';
  SELECT pg_get_expr(conbin,conrelid) INTO STRICT old_kind FROM pg_constraint
    WHERE conrelid='processing_jobs'::regclass AND conname='processing_jobs_kind_check';
  ALTER TABLE processing_jobs DROP CONSTRAINT processing_jobs_kind_check,
    DROP CONSTRAINT processing_jobs_target_check;
  EXECUTE format('ALTER TABLE processing_jobs ADD CONSTRAINT processing_jobs_kind_check CHECK ((%s) OR kind IN (''image_face_candidates'',''image_face_compose''))',old_kind);
  EXECUTE format('ALTER TABLE processing_jobs ADD CONSTRAINT processing_jobs_target_check CHECK ((face_quality_job_id IS NULL AND (%s)) OR (kind IN (''image_face_candidates'',''image_face_compose'') AND face_quality_job_id IS NOT NULL AND upload_session_id IS NOT NULL AND document_id IS NULL AND export_request_id IS NULL AND pdf_export_request_id IS NULL AND bundle_id IS NULL AND image_quality_request_id IS NULL))',old_target);
END $$;
INSERT INTO schema_migrations(version) VALUES ('0025_image_face_jobs');
COMMIT;
