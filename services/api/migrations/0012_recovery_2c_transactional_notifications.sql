BEGIN;

CREATE OR REPLACE FUNCTION insert_workspace_notification(
  target_workspace_id text,
  target_source_key text,
  target_kind text,
  target_title text,
  target_message text,
  target_resource_kind text,
  target_resource_id text,
  target_occurred_at timestamptz
) RETURNS void AS $$
BEGIN
  IF target_workspace_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO notifications(
    notification_id,workspace_id,source_key,kind,title,message,
    resource_kind,resource_id,occurred_at
  ) VALUES (
    'notification-' || md5(target_workspace_id || ':' || target_source_key),
    target_workspace_id,target_source_key,target_kind,target_title,target_message,
    target_resource_kind,target_resource_id,target_occurred_at
  )
  ON CONFLICT (workspace_id,source_key) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION project_upload_notification() RETURNS trigger AS $$
DECLARE
  job_attempt integer := 0;
BEGIN
  IF NEW.workspace_id IS NULL OR OLD.state = NEW.state THEN
    RETURN NEW;
  END IF;

  IF NEW.job_id IS NOT NULL THEN
    SELECT attempt INTO job_attempt FROM processing_jobs WHERE job_id = NEW.job_id;
    job_attempt := coalesce(job_attempt, 0);
  END IF;

  IF NEW.state = 'ready' THEN
    PERFORM insert_workspace_notification(
      NEW.workspace_id,'upload:' || NEW.upload_session_id || ':ready:' || job_attempt,
      'upload_accepted','File accepted',NEW.display_name,
      'upload_session',NEW.upload_session_id,NEW.updated_at
    );
  ELSIF NEW.state = 'rejected' THEN
    PERFORM insert_workspace_notification(
      NEW.workspace_id,'upload:' || NEW.upload_session_id || ':rejected:' || job_attempt,
      'upload_rejected','File not accepted',coalesce(NEW.failure->>'message',NEW.display_name),
      'upload_session',NEW.upload_session_id,NEW.updated_at
    );
  ELSIF NEW.state = 'expired' THEN
    PERFORM insert_workspace_notification(
      NEW.workspace_id,'upload:' || NEW.upload_session_id || ':expired',
      'source_cleanup_required','Temporary source expired',NEW.display_name,
      'upload_session',NEW.upload_session_id,NEW.updated_at
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION project_job_notification() RETURNS trigger AS $$
BEGIN
  IF NEW.workspace_id IS NULL OR OLD.state = NEW.state THEN
    RETURN NEW;
  END IF;

  IF NEW.state = 'succeeded' THEN
    PERFORM insert_workspace_notification(
      NEW.workspace_id,'job:' || NEW.job_id || ':completed:' || NEW.attempt,
      'job_completed','Job completed','The file check finished successfully.',
      'processing_job',NEW.job_id,NEW.updated_at
    );
    IF NEW.attempt > 1 THEN
      PERFORM insert_workspace_notification(
        NEW.workspace_id,'job:' || NEW.job_id || ':retry-completed:' || NEW.attempt,
        'retry_completed','Retry completed','The retried job finished successfully.',
        'processing_job',NEW.job_id,NEW.updated_at
      );
    END IF;
  ELSIF NEW.state = 'failed' THEN
    PERFORM insert_workspace_notification(
      NEW.workspace_id,'job:' || NEW.job_id || ':failed:' || NEW.attempt,
      'job_failed','Job could not finish',coalesce(NEW.failure->>'message','Review the job timeline.'),
      'processing_job',NEW.job_id,NEW.updated_at
    );
  ELSIF NEW.state = 'cancelled' THEN
    PERFORM insert_workspace_notification(
      NEW.workspace_id,'job:' || NEW.job_id || ':cancelled:' || NEW.attempt,
      'job_cancelled','Job cancelled','The job stopped before completion.',
      'processing_job',NEW.job_id,NEW.updated_at
    );
  ELSIF NEW.state = 'retry_wait' THEN
    PERFORM insert_workspace_notification(
      NEW.workspace_id,'job:' || NEW.job_id || ':retry-required:' || NEW.attempt,
      'retry_required','Retry scheduled',coalesce(NEW.failure->>'message','The job will retry safely.'),
      'processing_job',NEW.job_id,NEW.updated_at
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION project_audit_notification() RETURNS trigger AS $$
BEGIN
  IF NEW.action = 'guest-source.handed-off' THEN
    PERFORM insert_workspace_notification(
      NEW.workspace_id,'audit:' || NEW.audit_event_id,
      'guest_handoff_completed','Guest source saved','The original source is now in Default Files.',
      NEW.resource_kind,NEW.resource_id,NEW.occurred_at
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER upload_notification_projection
  AFTER UPDATE ON upload_sessions
  FOR EACH ROW EXECUTE FUNCTION project_upload_notification();

CREATE TRIGGER job_notification_projection
  AFTER UPDATE ON processing_jobs
  FOR EACH ROW EXECUTE FUNCTION project_job_notification();

CREATE TRIGGER audit_notification_projection
  AFTER INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION project_audit_notification();

SELECT insert_workspace_notification(
  upload.workspace_id,
  'upload:' || upload.upload_session_id || ':' || upload.state || ':' || coalesce(job.attempt,0),
  CASE upload.state WHEN 'ready' THEN 'upload_accepted' ELSE 'upload_rejected' END,
  CASE upload.state WHEN 'ready' THEN 'File accepted' ELSE 'File not accepted' END,
  CASE upload.state WHEN 'ready' THEN upload.display_name ELSE coalesce(upload.failure->>'message',upload.display_name) END,
  'upload_session',upload.upload_session_id,upload.updated_at
)
FROM upload_sessions upload
LEFT JOIN processing_jobs job ON job.job_id = upload.job_id
WHERE upload.workspace_id IS NOT NULL AND upload.state IN ('ready','rejected')
  AND NOT EXISTS (
    SELECT 1 FROM notifications existing
    WHERE existing.workspace_id = upload.workspace_id
      AND existing.kind = CASE upload.state WHEN 'ready' THEN 'upload_accepted' ELSE 'upload_rejected' END
      AND existing.resource_id = upload.upload_session_id
      AND existing.occurred_at = upload.updated_at
  );

SELECT insert_workspace_notification(
  workspace_id,'upload:' || upload_session_id || ':expired',
  'source_cleanup_required','Temporary source expired',display_name,
  'upload_session',upload_session_id,updated_at
)
FROM upload_sessions upload WHERE workspace_id IS NOT NULL AND state = 'expired'
  AND NOT EXISTS (
    SELECT 1 FROM notifications existing
    WHERE existing.workspace_id = upload.workspace_id
      AND existing.kind = 'source_cleanup_required'
      AND existing.resource_id = upload.upload_session_id
      AND existing.occurred_at = upload.updated_at
  );

SELECT insert_workspace_notification(
  workspace_id,'job:' || job_id || ':completed:' || attempt,
  'job_completed','Job completed','The file check finished successfully.',
  'processing_job',job_id,updated_at
)
FROM processing_jobs job WHERE workspace_id IS NOT NULL AND state = 'succeeded'
  AND NOT EXISTS (
    SELECT 1 FROM notifications existing
    WHERE existing.workspace_id = job.workspace_id
      AND existing.kind = 'job_completed'
      AND existing.resource_id = job.job_id
      AND existing.occurred_at = job.updated_at
  );

SELECT insert_workspace_notification(
  workspace_id,'job:' || job_id || ':retry-completed:' || attempt,
  'retry_completed','Retry completed','The retried job finished successfully.',
  'processing_job',job_id,updated_at
)
FROM processing_jobs job WHERE workspace_id IS NOT NULL AND state = 'succeeded' AND attempt > 1
  AND NOT EXISTS (
    SELECT 1 FROM notifications existing
    WHERE existing.workspace_id = job.workspace_id
      AND existing.kind = 'retry_completed'
      AND existing.resource_id = job.job_id
      AND existing.occurred_at = job.updated_at
  );

SELECT insert_workspace_notification(
  workspace_id,'job:' || job_id || ':' || state || ':' || attempt,
  CASE state WHEN 'failed' THEN 'job_failed' WHEN 'cancelled' THEN 'job_cancelled' ELSE 'retry_required' END,
  CASE state WHEN 'failed' THEN 'Job could not finish' WHEN 'cancelled' THEN 'Job cancelled' ELSE 'Retry scheduled' END,
  CASE state
    WHEN 'failed' THEN coalesce(failure->>'message','Review the job timeline.')
    WHEN 'cancelled' THEN 'The job stopped before completion.'
    ELSE coalesce(failure->>'message','The job will retry safely.')
  END,
  'processing_job',job_id,updated_at
)
FROM processing_jobs job WHERE workspace_id IS NOT NULL AND state IN ('failed','cancelled','retry_wait')
  AND NOT EXISTS (
    SELECT 1 FROM notifications existing
    WHERE existing.workspace_id = job.workspace_id
      AND existing.kind = CASE job.state
        WHEN 'failed' THEN 'job_failed'
        WHEN 'cancelled' THEN 'job_cancelled'
        ELSE 'retry_required'
      END
      AND existing.resource_id = job.job_id
      AND existing.occurred_at = job.updated_at
  );

SELECT insert_workspace_notification(
  workspace_id,'audit:' || audit_event_id,
  'guest_handoff_completed','Guest source saved','The original source is now in Default Files.',
  resource_kind,resource_id,occurred_at
)
FROM audit_events audit WHERE action = 'guest-source.handed-off'
  AND NOT EXISTS (
    SELECT 1 FROM notifications existing
    WHERE existing.workspace_id = audit.workspace_id
      AND existing.kind = 'guest_handoff_completed'
      AND existing.resource_id = audit.resource_id
      AND existing.occurred_at = audit.occurred_at
  );

INSERT INTO schema_migrations(version) VALUES ('0012_recovery_2c_transactional_notifications');
COMMIT;
