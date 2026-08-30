BEGIN;

ALTER TABLE job_outbox
  ADD COLUMN trace_id text,
  ADD COLUMN lease_owner text,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN last_error_category text;

UPDATE job_outbox outbox
SET trace_id = (
  SELECT trace_id FROM job_events
  WHERE job_id = outbox.job_id
  ORDER BY cursor
  LIMIT 1
);

ALTER TABLE job_outbox
  ALTER COLUMN trace_id SET NOT NULL,
  DROP CONSTRAINT job_outbox_state_check,
  ADD CONSTRAINT job_outbox_state_check
    CHECK (state IN ('pending', 'dispatching', 'dispatched')),
  ADD CONSTRAINT job_outbox_lease_shape CHECK (
    (state = 'dispatching' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (state <> 'dispatching' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  );

DROP INDEX job_outbox_pending_idx;
CREATE INDEX job_outbox_pending_idx
  ON job_outbox(state, available_at, lease_expires_at, created_at);

INSERT INTO schema_migrations(version) VALUES ('0006_recovery_2b_durable_dispatch');
COMMIT;
