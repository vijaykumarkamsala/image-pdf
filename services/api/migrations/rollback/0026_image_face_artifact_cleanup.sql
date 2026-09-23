BEGIN;
LOCK TABLE face_quality_jobs,face_quality_artifact_cleanup IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM face_quality_jobs) THEN
    RAISE EXCEPTION 'Face jobs exist; artifact cleanup rollback refuses to discard lifecycle state';
  END IF;
END $$;
DROP TRIGGER face_quality_artifact_cleanup_seed ON face_quality_jobs;
DROP FUNCTION seed_face_quality_artifact_cleanup();
DROP TABLE face_quality_artifact_cleanup;
DELETE FROM schema_migrations WHERE version='0026_image_face_artifact_cleanup';
COMMIT;
