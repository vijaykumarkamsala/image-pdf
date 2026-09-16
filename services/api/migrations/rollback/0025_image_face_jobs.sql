BEGIN;
LOCK TABLE processing_jobs,face_quality_jobs IN ACCESS EXCLUSIVE MODE;
DO $$
DECLARE previous image_face_migration_backup%ROWTYPE;
BEGIN
  IF EXISTS(SELECT 1 FROM face_quality_jobs) OR EXISTS(SELECT 1 FROM processing_jobs WHERE face_quality_job_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Face jobs exist; rollback refuses to delete customer work';
  END IF;
  IF EXISTS(SELECT 1 FROM schema_migrations WHERE version>'0025_image_face_jobs') THEN
    RAISE EXCEPTION 'A later migration exists; roll it back first';
  END IF;
  SELECT * INTO STRICT previous FROM image_face_migration_backup;
  DROP TRIGGER processing_jobs_face_guard ON processing_jobs;
  ALTER TABLE processing_jobs DROP CONSTRAINT processing_jobs_face_target_fk,
    DROP CONSTRAINT processing_jobs_kind_check,DROP CONSTRAINT processing_jobs_target_check;
  EXECUTE 'ALTER TABLE processing_jobs ADD CONSTRAINT processing_jobs_kind_check ' || previous.kind_check;
  EXECUTE 'ALTER TABLE processing_jobs ADD CONSTRAINT processing_jobs_target_check ' || previous.target_check;
  DROP INDEX processing_jobs_upload_session_unique_idx;
  ALTER TABLE processing_jobs DROP COLUMN face_quality_job_id;
  EXECUTE previous.upload_index;
END $$;
DROP TABLE face_quality_idempotency;
ALTER TABLE face_quality_jobs DROP CONSTRAINT face_quality_selected_candidate_fk;
DROP TABLE face_quality_candidates;
DROP TABLE face_quality_jobs;
DROP FUNCTION guard_image_face_job();
DROP FUNCTION guard_image_face_inputs();
DROP TABLE image_face_migration_backup;
DELETE FROM schema_migrations WHERE version='0025_image_face_jobs';
COMMIT;
