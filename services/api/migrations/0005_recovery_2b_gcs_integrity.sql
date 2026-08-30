BEGIN;

ALTER TABLE upload_sessions
  ADD COLUMN expected_sha256 char(64),
  ADD COLUMN verified_sha256 char(64),
  ADD COLUMN transfer_provider text NOT NULL DEFAULT 'local_api',
  ADD COLUMN protected_resumable_uri text,
  ADD COLUMN provider_generation text,
  ADD COLUMN provider_metadata jsonb,
  ADD CONSTRAINT upload_expected_sha256_format
    CHECK (expected_sha256 IS NULL OR expected_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT upload_verified_sha256_format
    CHECK (verified_sha256 IS NULL OR verified_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT upload_transfer_provider_value
    CHECK (transfer_provider IN ('local_api', 'google_cloud_storage')),
  ADD CONSTRAINT upload_provider_state_shape CHECK (
    (transfer_provider = 'local_api' AND protected_resumable_uri IS NULL)
    OR
    (transfer_provider = 'google_cloud_storage'
      AND (protected_resumable_uri IS NOT NULL OR state = 'initiated'))
  ) NOT VALID;

ALTER TABLE upload_sessions
  ALTER COLUMN transfer_provider DROP DEFAULT;

CREATE INDEX upload_sessions_quarantine_cleanup_idx
  ON upload_sessions(state, expires_at)
  WHERE immutable_object_key IS NULL;

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

INSERT INTO schema_migrations(version) VALUES ('0005_recovery_2b_gcs_integrity');
COMMIT;
