BEGIN;

CREATE TABLE notifications (
  notification_id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  source_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'upload_accepted','upload_rejected','job_completed','job_failed','job_cancelled',
    'retry_required','retry_completed','guest_handoff_completed','source_cleanup_required'
  )),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  message text NOT NULL CHECK (length(message) BETWEEN 1 AND 1000),
  resource_kind text NOT NULL,
  resource_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, source_key)
);

CREATE TABLE notification_reads (
  notification_id text NOT NULL REFERENCES notifications(notification_id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES actors(actor_id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL,
  PRIMARY KEY (notification_id, actor_id)
);

CREATE TABLE experience_idempotency_records (
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES actors(actor_id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  command_name text NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (actor_id, idempotency_key)
);

CREATE INDEX notifications_workspace_order_idx
  ON notifications(workspace_id, occurred_at DESC, notification_id DESC);
CREATE INDEX notification_reads_actor_idx ON notification_reads(actor_id, read_at DESC);
CREATE INDEX processing_jobs_workspace_order_idx
  ON processing_jobs(workspace_id, updated_at DESC, job_id DESC) WHERE workspace_id IS NOT NULL;
CREATE INDEX upload_sessions_workspace_attention_idx
  ON upload_sessions(workspace_id, state, updated_at DESC) WHERE workspace_id IS NOT NULL;
CREATE INDEX projects_search_idx ON projects USING gin (to_tsvector('simple', name));
CREATE INDEX workspace_files_search_idx ON workspace_files USING gin (to_tsvector('simple', display_name));

INSERT INTO schema_migrations(version) VALUES ('0009_recovery_2c_experience');
COMMIT;
