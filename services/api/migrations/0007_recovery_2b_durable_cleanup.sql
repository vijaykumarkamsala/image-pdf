BEGIN;

ALTER TABLE upload_sessions
  ADD COLUMN cleanup_lease_owner text,
  ADD COLUMN cleanup_lease_expires_at timestamptz,
  ADD COLUMN cleanup_completed_at timestamptz,
  ADD CONSTRAINT upload_cleanup_lease_shape CHECK (
    (cleanup_lease_owner IS NULL AND cleanup_lease_expires_at IS NULL)
    OR
    (cleanup_lease_owner IS NOT NULL AND cleanup_lease_expires_at IS NOT NULL)
  );

CREATE INDEX upload_sessions_cleanup_claim_idx
  ON upload_sessions(state, cleanup_completed_at, cleanup_lease_expires_at, expires_at)
  WHERE cleanup_completed_at IS NULL;

CREATE OR REPLACE FUNCTION enforce_upload_session_update() RETURNS trigger AS $$
DECLARE
  allowed boolean := false;
  guest_retention_expiry boolean := false;
  terminal_cleanup_update boolean := false;
BEGIN
  IF OLD.owner_kind <> NEW.owner_kind
     OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR OLD.actor_id IS DISTINCT FROM NEW.actor_id
     OR OLD.guest_session_id IS DISTINCT FROM NEW.guest_session_id
     OR OLD.quarantine_object_key <> NEW.quarantine_object_key
     OR OLD.expected_byte_size <> NEW.expected_byte_size
     OR OLD.expected_sha256 IS DISTINCT FROM NEW.expected_sha256
     OR OLD.transfer_provider <> NEW.transfer_provider THEN
    RAISE EXCEPTION 'upload ownership and expected source facts are immutable';
  END IF;

  IF NEW.verified_sha256 IS NOT NULL
     AND NEW.expected_sha256 IS NOT NULL
     AND NEW.verified_sha256 <> NEW.expected_sha256 THEN
    RAISE EXCEPTION 'verified checksum does not match expected checksum';
  END IF;

  guest_retention_expiry := OLD.owner_kind = 'guest'
    AND OLD.state IN ('ready', 'rejected') AND NEW.state = 'expired';
  terminal_cleanup_update := OLD.state IN ('ready', 'rejected', 'expired', 'cancelled')
    AND OLD.state = NEW.state
    AND (to_jsonb(OLD) - ARRAY['cleanup_lease_owner','cleanup_lease_expires_at','cleanup_completed_at'])
      = (to_jsonb(NEW) - ARRAY['cleanup_lease_owner','cleanup_lease_expires_at','cleanup_completed_at']);

  allowed := OLD.state = NEW.state OR guest_retention_expiry OR
    (OLD.state = 'initiated' AND NEW.state IN ('uploading', 'expired', 'cancelled')) OR
    (OLD.state = 'uploading' AND NEW.state IN ('uploading', 'finalising', 'expired', 'cancelled')) OR
    (OLD.state = 'finalising' AND NEW.state IN ('inspecting', 'rejected', 'cancelled')) OR
    (OLD.state = 'inspecting' AND NEW.state IN ('ready', 'rejected', 'cancelled'));
  IF NOT allowed THEN
    RAISE EXCEPTION 'invalid upload session transition: % -> %', OLD.state, NEW.state;
  END IF;

  IF OLD.state IN ('ready', 'rejected', 'expired', 'cancelled')
     AND NOT guest_retention_expiry AND NOT terminal_cleanup_update THEN
    RAISE EXCEPTION 'terminal upload sessions are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

INSERT INTO schema_migrations(version) VALUES ('0007_recovery_2b_durable_cleanup');
COMMIT;
