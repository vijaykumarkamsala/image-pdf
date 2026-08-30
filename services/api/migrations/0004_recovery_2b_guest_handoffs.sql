BEGIN;

CREATE TABLE guest_upload_handoffs (
  upload_session_id text PRIMARY KEY REFERENCES upload_sessions(upload_session_id),
  guest_session_id text NOT NULL REFERENCES guest_sessions(guest_session_id),
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),
  actor_id text NOT NULL REFERENCES actors(actor_id),
  object_reference_id text NOT NULL REFERENCES object_references(object_reference_id),
  asset_original_id text NOT NULL REFERENCES asset_originals(asset_original_id),
  source_version_id text NOT NULL REFERENCES source_versions(source_version_id),
  file_id text NOT NULL REFERENCES workspace_files(file_id),
  handed_off_at timestamptz NOT NULL,
  trace_id text NOT NULL
);

CREATE INDEX guest_handoffs_workspace_idx ON guest_upload_handoffs(workspace_id, handed_off_at DESC);

CREATE OR REPLACE FUNCTION enforce_upload_session_update() RETURNS trigger AS $$
DECLARE
  allowed boolean := false;
  guest_retention_expiry boolean := false;
BEGIN
  IF OLD.owner_kind <> NEW.owner_kind
     OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR OLD.actor_id IS DISTINCT FROM NEW.actor_id
     OR OLD.guest_session_id IS DISTINCT FROM NEW.guest_session_id
     OR OLD.quarantine_object_key <> NEW.quarantine_object_key
     OR OLD.expected_byte_size <> NEW.expected_byte_size THEN
    RAISE EXCEPTION 'upload ownership and expected source facts are immutable';
  END IF;

  guest_retention_expiry := OLD.owner_kind = 'guest'
    AND OLD.state IN ('ready', 'rejected') AND NEW.state = 'expired';
  allowed := OLD.state = NEW.state OR guest_retention_expiry OR
    (OLD.state = 'initiated' AND NEW.state IN ('uploading', 'expired', 'cancelled')) OR
    (OLD.state = 'uploading' AND NEW.state IN ('uploading', 'finalising', 'expired', 'cancelled')) OR
    (OLD.state = 'finalising' AND NEW.state IN ('inspecting', 'rejected', 'cancelled')) OR
    (OLD.state = 'inspecting' AND NEW.state IN ('ready', 'rejected', 'cancelled'));
  IF NOT allowed THEN
    RAISE EXCEPTION 'invalid upload session transition: % -> %', OLD.state, NEW.state;
  END IF;

  IF OLD.state IN ('ready', 'rejected', 'expired', 'cancelled') AND NOT guest_retention_expiry THEN
    RAISE EXCEPTION 'terminal upload sessions are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

INSERT INTO schema_migrations(version) VALUES ('0004_recovery_2b_guest_handoffs');
COMMIT;
