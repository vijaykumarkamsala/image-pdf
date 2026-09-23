BEGIN;

CREATE TABLE face_quality_artifact_cleanup (
  face_quality_job_id text PRIMARY KEY REFERENCES face_quality_jobs(face_quality_job_id),
  lease_owner text,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CHECK (completed_at IS NULL OR (lease_owner IS NULL AND lease_expires_at IS NULL))
);

INSERT INTO face_quality_artifact_cleanup(face_quality_job_id,created_at,updated_at)
SELECT face_quality_job_id,created_at,created_at FROM face_quality_jobs;

CREATE FUNCTION seed_face_quality_artifact_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO face_quality_artifact_cleanup(face_quality_job_id,created_at,updated_at)
  VALUES(NEW.face_quality_job_id,NEW.created_at,NEW.created_at);
  RETURN NEW;
END;
$$;

CREATE TRIGGER face_quality_artifact_cleanup_seed
  AFTER INSERT ON face_quality_jobs
  FOR EACH ROW EXECUTE FUNCTION seed_face_quality_artifact_cleanup();

CREATE INDEX face_quality_artifact_cleanup_claim_idx
  ON face_quality_artifact_cleanup(completed_at,lease_expires_at,created_at);

INSERT INTO schema_migrations(version) VALUES ('0026_image_face_artifact_cleanup');
COMMIT;
