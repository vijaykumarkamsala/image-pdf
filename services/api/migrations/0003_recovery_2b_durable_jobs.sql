BEGIN;

CREATE TABLE processing_jobs (
  job_id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind = 'file_intake_inspection'),
  owner_kind text NOT NULL CHECK (owner_kind IN ('actor', 'guest')),
  workspace_id text REFERENCES workspaces(workspace_id),
  actor_id text REFERENCES actors(actor_id),
  guest_session_id text REFERENCES guest_sessions(guest_session_id),
  upload_session_id text NOT NULL UNIQUE REFERENCES upload_sessions(upload_session_id),
  state text NOT NULL CHECK (state IN (
    'queued', 'leased', 'running', 'retry_wait', 'cancel_requested',
    'succeeded', 'failed', 'cancelled'
  )),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 20),
  progress_percent integer NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  lease_owner text,
  lease_token_hash char(64),
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  next_attempt_at timestamptz,
  failure jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (
    (owner_kind = 'actor' AND workspace_id IS NOT NULL AND actor_id IS NOT NULL AND guest_session_id IS NULL)
    OR
    (owner_kind = 'guest' AND workspace_id IS NULL AND actor_id IS NULL AND guest_session_id IS NOT NULL)
  )
);

CREATE TABLE job_checkpoints (
  job_id text NOT NULL REFERENCES processing_jobs(job_id),
  attempt integer NOT NULL CHECK (attempt >= 1),
  checkpoint_key text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (job_id, attempt, checkpoint_key)
);

CREATE TABLE job_events (
  cursor bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_event_id text NOT NULL UNIQUE,
  job_id text NOT NULL REFERENCES processing_jobs(job_id),
  event_kind text NOT NULL,
  state text NOT NULL,
  progress_percent integer NOT NULL CHECK (progress_percent BETWEEN 0 AND 100),
  occurred_at timestamptz NOT NULL,
  trace_id text NOT NULL
);

CREATE TABLE job_outbox (
  outbox_id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES processing_jobs(job_id),
  dispatch_kind text NOT NULL CHECK (dispatch_kind = 'process_job'),
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'dispatched')),
  delivery_attempts integer NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  available_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  dispatched_at timestamptz
);

ALTER TABLE upload_sessions
  ADD CONSTRAINT upload_session_job_fk FOREIGN KEY (job_id) REFERENCES processing_jobs(job_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX jobs_owner_workspace_idx ON processing_jobs(workspace_id, created_at DESC);
CREATE INDEX jobs_owner_guest_idx ON processing_jobs(guest_session_id, created_at DESC);
CREATE INDEX jobs_claim_idx ON processing_jobs(state, next_attempt_at, created_at);
CREATE INDEX job_events_job_cursor_idx ON job_events(job_id, cursor);
CREATE INDEX job_outbox_pending_idx ON job_outbox(state, available_at, created_at);

INSERT INTO schema_migrations(version) VALUES ('0003_recovery_2b_durable_jobs');
COMMIT;
