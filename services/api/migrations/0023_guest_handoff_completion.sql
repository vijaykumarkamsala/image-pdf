BEGIN;

-- A ready guest upload may be adopted exactly once, but only after the durable
-- handoff record and its workspace-owned immutable object have been created in
-- the same transaction. All other ownership and terminal-row changes remain
-- forbidden. This keeps the original upload facts immutable while allowing the
-- explicit ownership transition required by the guest-to-workspace contract.
CREATE OR REPLACE FUNCTION enforce_upload_session_update() RETURNS trigger AS $$
DECLARE
  allowed boolean := false;
  guest_retention_expiry boolean := false;
  terminal_cleanup_update boolean := false;
  manual_retry boolean := false;
  guest_handoff_completion boolean := false;
BEGIN
  guest_handoff_completion := OLD.owner_kind = 'guest'
    AND OLD.state = 'ready' AND NEW.state = 'ready'
    AND OLD.guest_session_id IS NOT NULL
    AND NEW.owner_kind = 'actor'
    AND NEW.workspace_id IS NOT NULL
    AND NEW.actor_id IS NOT NULL
    AND NEW.guest_session_id IS NULL
    AND NEW.file_id IS NOT NULL
    AND NEW.immutable_object_key IS NOT NULL
    AND NEW.immutable_provider_generation IS NOT NULL
    AND (to_jsonb(OLD) - ARRAY[
      'owner_kind','workspace_id','actor_id','guest_session_id','file_id',
      'immutable_object_key','immutable_provider_generation','updated_at'
    ]) = (to_jsonb(NEW) - ARRAY[
      'owner_kind','workspace_id','actor_id','guest_session_id','file_id',
      'immutable_object_key','immutable_provider_generation','updated_at'
    ])
    AND EXISTS (
      SELECT 1
      FROM guest_upload_handoffs handoff
      JOIN object_references object_ref
        ON object_ref.object_reference_id = handoff.object_reference_id
      WHERE handoff.upload_session_id = OLD.upload_session_id
        AND handoff.guest_session_id = OLD.guest_session_id
        AND handoff.workspace_id = NEW.workspace_id
        AND handoff.actor_id = NEW.actor_id
        AND handoff.file_id = NEW.file_id
        AND object_ref.workspace_id = NEW.workspace_id
        AND object_ref.object_key = NEW.immutable_object_key
        AND object_ref.storage_generation = NEW.immutable_provider_generation
    );

  IF (OLD.owner_kind <> NEW.owner_kind
     OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR OLD.actor_id IS DISTINCT FROM NEW.actor_id
     OR OLD.guest_session_id IS DISTINCT FROM NEW.guest_session_id)
     AND NOT guest_handoff_completion THEN
    RAISE EXCEPTION 'upload ownership and expected source facts are immutable';
  END IF;

  IF OLD.quarantine_object_key <> NEW.quarantine_object_key
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
  manual_retry := OLD.state = 'rejected' AND NEW.state = 'finalising'
    AND coalesce((OLD.failure->>'retryable')::boolean, false)
    AND OLD.cleanup_completed_at IS NULL
    AND OLD.expires_at > NEW.updated_at
    AND NEW.failure IS NULL
    AND (to_jsonb(OLD) - ARRAY['state','failure','updated_at'])
      = (to_jsonb(NEW) - ARRAY['state','failure','updated_at']);

  allowed := OLD.state = NEW.state OR guest_retention_expiry OR manual_retry OR
    (OLD.state = 'initiated' AND NEW.state IN ('uploading', 'expired', 'cancelled')) OR
    (OLD.state = 'uploading' AND NEW.state IN ('uploading', 'finalising', 'expired', 'cancelled')) OR
    (OLD.state = 'finalising' AND NEW.state IN ('inspecting', 'rejected', 'cancelled')) OR
    (OLD.state = 'inspecting' AND NEW.state IN ('ready', 'rejected', 'cancelled'));
  IF NOT allowed THEN
    RAISE EXCEPTION 'invalid upload session transition: % -> %', OLD.state, NEW.state;
  END IF;

  IF OLD.state IN ('ready', 'rejected', 'expired', 'cancelled')
     AND NOT guest_retention_expiry
     AND NOT terminal_cleanup_update
     AND NOT manual_retry
     AND NOT guest_handoff_completion THEN
    RAISE EXCEPTION 'terminal upload sessions are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

INSERT INTO schema_migrations(version) VALUES ('0023_guest_handoff_completion');
COMMIT;
