BEGIN;

CREATE TABLE guest_sessions (
  guest_session_id text PRIMARY KEY,
  token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL
);

CREATE TABLE upload_sessions (
  upload_session_id text PRIMARY KEY,
  owner_kind text NOT NULL CHECK (owner_kind IN ('actor', 'guest')),
  workspace_id text REFERENCES workspaces(workspace_id),
  actor_id text REFERENCES actors(actor_id),
  guest_session_id text REFERENCES guest_sessions(guest_session_id),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 2048),
  expected_media_type text NOT NULL,
  expected_byte_size bigint NOT NULL CHECK (expected_byte_size > 0),
  bytes_received bigint NOT NULL DEFAULT 0 CHECK (bytes_received >= 0),
  state text NOT NULL CHECK (state IN (
    'initiated', 'uploading', 'finalising', 'inspecting',
    'ready', 'rejected', 'expired', 'cancelled'
  )),
  constraints jsonb NOT NULL,
  upload_token_hash char(64) NOT NULL CHECK (upload_token_hash ~ '^[0-9a-f]{64}$'),
  upload_token_expires_at timestamptz NOT NULL,
  quarantine_object_key text NOT NULL UNIQUE,
  immutable_object_key text,
  job_id text,
  asset_original_id text,
  source_version_id text,
  file_id text,
  source_facts jsonb,
  failure jsonb,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (bytes_received <= expected_byte_size),
  CHECK (
    (owner_kind = 'actor' AND workspace_id IS NOT NULL AND actor_id IS NOT NULL AND guest_session_id IS NULL)
    OR
    (owner_kind = 'guest' AND workspace_id IS NULL AND actor_id IS NULL AND guest_session_id IS NOT NULL)
  )
);

CREATE TABLE intake_idempotency_records (
  owner_scope text NOT NULL,
  idempotency_key text NOT NULL,
  command_name text NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (owner_scope, idempotency_key)
);

CREATE INDEX upload_sessions_workspace_idx ON upload_sessions(workspace_id, created_at DESC);
CREATE INDEX upload_sessions_guest_idx ON upload_sessions(guest_session_id, created_at DESC);
CREATE INDEX upload_sessions_expiry_idx ON upload_sessions(state, expires_at);

CREATE OR REPLACE FUNCTION enforce_upload_session_update() RETURNS trigger AS $$
DECLARE
  allowed boolean := false;
BEGIN
  IF OLD.owner_kind <> NEW.owner_kind
     OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR OLD.actor_id IS DISTINCT FROM NEW.actor_id
     OR OLD.guest_session_id IS DISTINCT FROM NEW.guest_session_id
     OR OLD.quarantine_object_key <> NEW.quarantine_object_key
     OR OLD.expected_byte_size <> NEW.expected_byte_size THEN
    RAISE EXCEPTION 'upload ownership and expected source facts are immutable';
  END IF;

  allowed := OLD.state = NEW.state OR
    (OLD.state = 'initiated' AND NEW.state IN ('uploading', 'expired', 'cancelled')) OR
    (OLD.state = 'uploading' AND NEW.state IN ('uploading', 'finalising', 'expired', 'cancelled')) OR
    (OLD.state = 'finalising' AND NEW.state IN ('inspecting', 'rejected', 'cancelled')) OR
    (OLD.state = 'inspecting' AND NEW.state IN ('ready', 'rejected', 'cancelled'));
  IF NOT allowed THEN
    RAISE EXCEPTION 'invalid upload session transition: % -> %', OLD.state, NEW.state;
  END IF;

  IF OLD.state IN ('ready', 'rejected', 'expired', 'cancelled') THEN
    RAISE EXCEPTION 'terminal upload sessions are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER upload_session_transition_guard
BEFORE UPDATE ON upload_sessions
FOR EACH ROW EXECUTE FUNCTION enforce_upload_session_update();

INSERT INTO schema_migrations(version) VALUES ('0002_recovery_2b_upload_sessions');
COMMIT;
