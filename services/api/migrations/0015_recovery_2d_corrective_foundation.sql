BEGIN;

ALTER TABLE document_leases
  ADD COLUMN takeover_request_id text,
  ADD COLUMN takeover_request_reason text;

CREATE TABLE document_lease_events (
  document_lease_event_id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),
  document_id text NOT NULL REFERENCES editor_documents(document_id),
  lease_id text,
  event_kind text NOT NULL CHECK (event_kind IN (
    'acquired', 'heartbeat', 'takeover_requested', 'takeover_denied',
    'expired', 'released', 'force_takeover'
  )),
  actor_id text NOT NULL REFERENCES actors(actor_id),
  subject_actor_id text REFERENCES actors(actor_id),
  reason text,
  trace_id text NOT NULL,
  occurred_at timestamptz NOT NULL
);

CREATE INDEX document_lease_events_document_time_idx
  ON document_lease_events(workspace_id, document_id, occurred_at DESC);

CREATE TRIGGER document_lease_events_append_only
BEFORE UPDATE OR DELETE ON document_lease_events
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update();

ALTER TABLE notifications
  DROP CONSTRAINT notifications_kind_check,
  ADD COLUMN recipient_actor_id text REFERENCES actors(actor_id),
  ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
    'upload_accepted','upload_rejected','job_completed','job_failed','job_cancelled',
    'retry_required','retry_completed','guest_handoff_completed','source_cleanup_required',
    'lease_takeover_requested'
  ));

CREATE INDEX notifications_recipient_idx
  ON notifications(workspace_id, recipient_actor_id, occurred_at DESC);

INSERT INTO schema_migrations(version) VALUES ('0015_recovery_2d_corrective_foundation');
COMMIT;
