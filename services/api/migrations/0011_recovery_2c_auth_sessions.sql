BEGIN;

CREATE TABLE oidc_auth_transactions (
  state_hash char(64) PRIMARY KEY CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  nonce_hash char(64) NOT NULL CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
  code_verifier text NOT NULL CHECK (char_length(code_verifier) BETWEEN 43 AND 128),
  return_to text NOT NULL,
  handoff_upload_session_id text,
  guest_token_hash char(64) CHECK (guest_token_hash IS NULL OR guest_token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE TABLE oidc_actor_identities (
  issuer text NOT NULL,
  subject text NOT NULL,
  actor_id text NOT NULL REFERENCES actors(actor_id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (issuer, subject),
  UNIQUE (actor_id, issuer)
);

CREATE TABLE application_sessions (
  session_id_hash char(64) PRIMARY KEY CHECK (session_id_hash ~ '^[0-9a-f]{64}$'),
  actor_id text NOT NULL REFERENCES actors(actor_id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  rotate_after timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  revoked_at timestamptz,
  rotated_to_hash char(64) REFERENCES application_sessions(session_id_hash)
);

CREATE TABLE identity_audit_events (
  identity_audit_event_id text PRIMARY KEY,
  actor_id text REFERENCES actors(actor_id),
  action text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  subject_reference text,
  occurred_at timestamptz NOT NULL,
  trace_id text NOT NULL
);

CREATE INDEX application_sessions_actor_idx
  ON application_sessions(actor_id, expires_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX oidc_auth_transactions_expiry_idx
  ON oidc_auth_transactions(expires_at) WHERE consumed_at IS NULL;
CREATE INDEX identity_audit_actor_idx
  ON identity_audit_events(actor_id, occurred_at DESC);

INSERT INTO schema_migrations(version) VALUES ('0011_recovery_2c_auth_sessions');
COMMIT;
