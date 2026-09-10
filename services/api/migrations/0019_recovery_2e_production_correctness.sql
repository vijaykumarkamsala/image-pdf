BEGIN;

ALTER TABLE source_inspection_facts
  ADD COLUMN frame_count integer CHECK (frame_count IS NULL OR frame_count > 0),
  ADD COLUMN colour_model text
    CHECK (colour_model IS NULL OR colour_model IN ('grayscale','rgb','cmyk','indexed'));

ALTER TABLE source_inspection_facts DISABLE TRIGGER source_inspection_facts_append_only;
UPDATE source_inspection_facts facts
SET frame_count = NULLIF(upload.source_facts->>'frame_count', '')::integer,
    colour_model = NULLIF(upload.source_facts->>'colour_model', '')
FROM upload_sessions upload
WHERE upload.source_version_id = facts.source_version_id
  AND upload.source_facts IS NOT NULL;
ALTER TABLE source_inspection_facts ENABLE TRIGGER source_inspection_facts_append_only;

ALTER TABLE recommendation_sets
  DROP CONSTRAINT recommendation_sets_workspace_id_document_id_document_versi_key;

CREATE UNIQUE INDEX recommendation_sets_logical_identity_idx
  ON recommendation_sets(workspace_id, document_id, document_version_id, intended_outcome)
  NULLS NOT DISTINCT;

CREATE TABLE recommendation_decisions (
  decision_id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),
  recommendation_set_id text NOT NULL REFERENCES recommendation_sets(recommendation_set_id),
  recommendation_id text NOT NULL,
  actor_id text NOT NULL REFERENCES actors(actor_id),
  state text NOT NULL CHECK (state IN ('accepted','declined')),
  created_at timestamptz NOT NULL
);

CREATE INDEX recommendation_decisions_latest_idx
  ON recommendation_decisions(workspace_id, recommendation_set_id, recommendation_id, created_at DESC, decision_id DESC);

ALTER TABLE image_export_requests
  ADD COLUMN request_kind text NOT NULL DEFAULT 'export'
    CHECK (request_kind IN ('export','enhancement_preview'));

ALTER TABLE image_export_outputs
  ADD COLUMN metadata_verified boolean,
  ADD COLUMN metadata_evidence jsonb,
  ADD COLUMN histogram jsonb,
  ADD CONSTRAINT image_export_outputs_metadata_evidence_check
    CHECK (metadata_evidence IS NULL OR jsonb_typeof(metadata_evidence) = 'object'),
  ADD CONSTRAINT image_export_outputs_histogram_check
    CHECK (histogram IS NULL OR jsonb_typeof(histogram) = 'object');

-- Outputs completed before byte-level verification are retained as evidence but
-- cannot remain customer-deliverable under the corrected completion invariant.
UPDATE image_export_outputs
SET state='failed',progress_percent=100,
    failure_code='output-verification-required',
    failure_message='This earlier derivative requires regeneration with completed-byte verification'
WHERE state='succeeded' AND (metadata_verified IS DISTINCT FROM true OR metadata_evidence IS NULL);

UPDATE image_export_requests request
SET state=CASE
      WHEN EXISTS(SELECT 1 FROM image_export_outputs output
                  WHERE output.export_request_id=request.export_request_id
                    AND output.state='succeeded')
      THEN 'partially_completed' ELSE 'failed' END,
    updated_at=now()
WHERE EXISTS(SELECT 1 FROM image_export_outputs output
             WHERE output.export_request_id=request.export_request_id
               AND output.failure_code='output-verification-required');

ALTER TABLE image_export_outputs
  ADD CONSTRAINT image_export_outputs_metadata_completion_check
    CHECK (state <> 'succeeded' OR (metadata_verified IS TRUE AND metadata_evidence IS NOT NULL));

ALTER TABLE export_provenance
  ADD COLUMN metadata_evidence jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata_evidence) = 'object');

CREATE TABLE enhancement_previews (
  preview_id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),
  actor_id text NOT NULL REFERENCES actors(actor_id),
  document_id text NOT NULL REFERENCES editor_documents(document_id),
  document_version_id text NOT NULL REFERENCES document_versions(document_version_id),
  recipe_id text NOT NULL,
  recipe_version integer NOT NULL,
  mode text NOT NULL CHECK (mode IN ('original','current','recommended')),
  export_request_id text NOT NULL UNIQUE REFERENCES image_export_requests(export_request_id),
  output_id text NOT NULL UNIQUE REFERENCES image_export_outputs(output_id),
  created_at timestamptz NOT NULL,
  FOREIGN KEY (recipe_id, recipe_version) REFERENCES processing_recipes(recipe_id, version)
);

CREATE INDEX enhancement_previews_document_idx
  ON enhancement_previews(workspace_id, document_id, created_at DESC);

CREATE TRIGGER recommendation_decisions_append_only
BEFORE UPDATE OR DELETE ON recommendation_decisions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update();

CREATE TRIGGER enhancement_previews_append_only
BEFORE UPDATE OR DELETE ON enhancement_previews
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update();

INSERT INTO schema_migrations(version) VALUES ('0019_recovery_2e_production_correctness');
COMMIT;
