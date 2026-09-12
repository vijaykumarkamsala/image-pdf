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

-- Recovery 2E records carry workspace and relationship identity together. The
-- earlier single-column foreign keys remain useful, while these candidate keys
-- and composite foreign keys prevent a valid identifier from another tenant or
-- another document from being attached to the row.
ALTER TABLE object_references
  ADD CONSTRAINT object_references_workspace_object_key
    UNIQUE (workspace_id, object_reference_id);

ALTER TABLE editor_documents
  ADD CONSTRAINT editor_documents_workspace_document_key
    UNIQUE (workspace_id, document_id);

ALTER TABLE document_versions
  ADD CONSTRAINT document_versions_document_version_key
    UNIQUE (document_id, document_version_id);

ALTER TABLE processing_recipes
  ADD CONSTRAINT processing_recipes_workspace_document_recipe_key
    UNIQUE (workspace_id, document_id, recipe_id, version),
  ADD CONSTRAINT processing_recipes_workspace_document_fk
    FOREIGN KEY (workspace_id, document_id)
    REFERENCES editor_documents(workspace_id, document_id),
  ADD CONSTRAINT processing_recipes_creator_membership_fk
    FOREIGN KEY (workspace_id, created_by_actor_id)
    REFERENCES memberships(workspace_id, actor_id);

ALTER TABLE recommendation_sets
  ADD CONSTRAINT recommendation_sets_workspace_set_key
    UNIQUE (workspace_id, recommendation_set_id),
  ADD CONSTRAINT recommendation_sets_workspace_document_fk
    FOREIGN KEY (workspace_id, document_id)
    REFERENCES editor_documents(workspace_id, document_id),
  ADD CONSTRAINT recommendation_sets_document_version_fk
    FOREIGN KEY (document_id, document_version_id)
    REFERENCES document_versions(document_id, document_version_id);

CREATE TABLE recommendation_decisions (
  decision_id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),
  recommendation_set_id text NOT NULL REFERENCES recommendation_sets(recommendation_set_id),
  recommendation_id text NOT NULL,
  actor_id text NOT NULL REFERENCES actors(actor_id),
  state text NOT NULL CHECK (state IN ('accepted','declined')),
  created_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, recommendation_set_id)
    REFERENCES recommendation_sets(workspace_id, recommendation_set_id),
  FOREIGN KEY (workspace_id, actor_id)
    REFERENCES memberships(workspace_id, actor_id)
);

CREATE INDEX recommendation_decisions_latest_idx
  ON recommendation_decisions(workspace_id, recommendation_set_id, recommendation_id, created_at DESC, decision_id DESC);

ALTER TABLE image_export_requests
  ADD COLUMN request_kind text NOT NULL DEFAULT 'export'
    CHECK (request_kind IN ('export','enhancement_preview'));

ALTER TABLE processing_jobs
  ADD CONSTRAINT processing_jobs_workspace_job_key
    UNIQUE (workspace_id, job_id);

ALTER TABLE image_export_requests
  ADD CONSTRAINT image_export_requests_workspace_request_key
    UNIQUE (workspace_id, export_request_id),
  ADD CONSTRAINT image_export_requests_relationship_key
    UNIQUE (workspace_id, document_id, document_version_id, recipe_id,
            recipe_version, request_kind, export_request_id),
  ADD CONSTRAINT image_export_requests_provenance_relationship_key
    UNIQUE (workspace_id, document_id, document_version_id, recipe_id,
            recipe_version, export_request_id),
  ADD CONSTRAINT image_export_requests_workspace_document_fk
    FOREIGN KEY (workspace_id, document_id)
    REFERENCES editor_documents(workspace_id, document_id),
  ADD CONSTRAINT image_export_requests_document_version_fk
    FOREIGN KEY (document_id, document_version_id)
    REFERENCES document_versions(document_id, document_version_id),
  ADD CONSTRAINT image_export_requests_recipe_fk
    FOREIGN KEY (workspace_id, document_id, recipe_id, recipe_version)
    REFERENCES processing_recipes(workspace_id, document_id, recipe_id, version),
  ADD CONSTRAINT image_export_requests_actor_membership_fk
    FOREIGN KEY (workspace_id, actor_id)
    REFERENCES memberships(workspace_id, actor_id),
  ADD CONSTRAINT image_export_requests_workspace_job_fk
    FOREIGN KEY (workspace_id, job_id)
    REFERENCES processing_jobs(workspace_id, job_id)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE processing_jobs
  ADD CONSTRAINT processing_jobs_workspace_export_request_fk
    FOREIGN KEY (workspace_id, export_request_id)
    REFERENCES image_export_requests(workspace_id, export_request_id)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE image_export_outputs
  ADD COLUMN workspace_id text,
  ADD COLUMN metadata_verified boolean,
  ADD COLUMN metadata_evidence jsonb,
  ADD COLUMN histogram jsonb,
  ADD CONSTRAINT image_export_outputs_metadata_evidence_check
    CHECK (metadata_evidence IS NULL OR jsonb_typeof(metadata_evidence) = 'object'),
  ADD CONSTRAINT image_export_outputs_histogram_check
    CHECK (histogram IS NULL OR jsonb_typeof(histogram) = 'object');

UPDATE image_export_outputs output
SET workspace_id=request.workspace_id
FROM image_export_requests request
WHERE request.export_request_id=output.export_request_id;

ALTER TABLE image_export_outputs
  ALTER COLUMN workspace_id SET NOT NULL,
  ADD CONSTRAINT image_export_outputs_workspace_request_output_key
    UNIQUE (workspace_id, export_request_id, output_id),
  ADD CONSTRAINT image_export_outputs_workspace_request_fk
    FOREIGN KEY (workspace_id, export_request_id)
    REFERENCES image_export_requests(workspace_id, export_request_id),
  ADD CONSTRAINT image_export_outputs_workspace_object_fk
    FOREIGN KEY (workspace_id, object_reference_id)
    REFERENCES object_references(workspace_id, object_reference_id),
  ADD CONSTRAINT image_export_outputs_metadata_completion_check
    CHECK (state <> 'succeeded' OR (metadata_verified IS TRUE AND metadata_evidence IS NOT NULL))
    NOT VALID;

ALTER TABLE export_provenance
  ADD COLUMN export_request_id text,
  ADD COLUMN metadata_evidence jsonb
    CHECK (metadata_evidence IS NULL OR jsonb_typeof(metadata_evidence) = 'object');

-- Controlled relationship enrichment of immutable 0018 evidence. No outcome,
-- digest or customer-visible state is rewritten.
ALTER TABLE export_provenance DISABLE TRIGGER export_provenance_append_only;
UPDATE export_provenance provenance
SET export_request_id=output.export_request_id
FROM image_export_outputs output
WHERE output.output_id=provenance.output_id;
ALTER TABLE export_provenance ENABLE TRIGGER export_provenance_append_only;

ALTER TABLE export_provenance
  ALTER COLUMN export_request_id SET NOT NULL,
  ADD CONSTRAINT export_provenance_workspace_request_output_fk
    FOREIGN KEY (workspace_id, export_request_id, output_id)
    REFERENCES image_export_outputs(workspace_id, export_request_id, output_id),
  ADD CONSTRAINT export_provenance_request_relationship_fk
    FOREIGN KEY (workspace_id, document_id, document_version_id, recipe_id,
                 recipe_version, export_request_id)
    REFERENCES image_export_requests(workspace_id, document_id,
                 document_version_id, recipe_id, recipe_version,
                 export_request_id),
  ADD CONSTRAINT export_provenance_metadata_completion_check
    CHECK (metadata_verified IS NOT TRUE OR metadata_evidence IS NOT NULL)
    NOT VALID;

ALTER TABLE export_bundles
  ADD CONSTRAINT export_bundles_workspace_request_fk
    FOREIGN KEY (workspace_id, export_request_id)
    REFERENCES image_export_requests(workspace_id, export_request_id),
  ADD CONSTRAINT export_bundles_workspace_job_fk
    FOREIGN KEY (workspace_id, job_id)
    REFERENCES processing_jobs(workspace_id, job_id)
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT export_bundles_workspace_object_fk
    FOREIGN KEY (workspace_id, object_reference_id)
    REFERENCES object_references(workspace_id, object_reference_id);

CREATE TABLE enhancement_previews (
  preview_id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),
  actor_id text NOT NULL REFERENCES actors(actor_id),
  document_id text NOT NULL REFERENCES editor_documents(document_id),
  document_version_id text NOT NULL REFERENCES document_versions(document_version_id),
  recipe_id text NOT NULL,
  recipe_version integer NOT NULL,
  mode text NOT NULL CHECK (mode IN ('original','current','recommended')),
  request_kind text NOT NULL DEFAULT 'enhancement_preview'
    CHECK (request_kind = 'enhancement_preview'),
  export_request_id text NOT NULL UNIQUE REFERENCES image_export_requests(export_request_id),
  output_id text NOT NULL UNIQUE REFERENCES image_export_outputs(output_id),
  created_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, actor_id)
    REFERENCES memberships(workspace_id, actor_id),
  FOREIGN KEY (workspace_id, document_id)
    REFERENCES editor_documents(workspace_id, document_id),
  FOREIGN KEY (document_id, document_version_id)
    REFERENCES document_versions(document_id, document_version_id),
  FOREIGN KEY (workspace_id, document_id, recipe_id, recipe_version)
    REFERENCES processing_recipes(workspace_id, document_id, recipe_id, version),
  FOREIGN KEY (workspace_id, document_id, document_version_id, recipe_id,
               recipe_version, request_kind, export_request_id)
    REFERENCES image_export_requests(workspace_id, document_id,
               document_version_id, recipe_id, recipe_version, request_kind,
               export_request_id),
  FOREIGN KEY (workspace_id, export_request_id, output_id)
    REFERENCES image_export_outputs(workspace_id, export_request_id, output_id)
);

CREATE INDEX enhancement_previews_document_idx
  ON enhancement_previews(workspace_id, document_id, created_at DESC);

CREATE TRIGGER recommendation_decisions_append_only
BEFORE UPDATE OR DELETE ON recommendation_decisions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update();

CREATE TRIGGER enhancement_previews_append_only
BEFORE UPDATE OR DELETE ON enhancement_previews
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update();

-- A fresh database validates both completion checks immediately. An existing
-- development database upgraded from 0018 may contain truthful historical
-- successes created before byte-level metadata evidence existed; those rows are
-- preserved and the NOT VALID checks still protect every new insert or update.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM image_export_outputs
    WHERE state='succeeded'
      AND (metadata_verified IS DISTINCT FROM true OR metadata_evidence IS NULL)
  ) THEN
    ALTER TABLE image_export_outputs
      VALIDATE CONSTRAINT image_export_outputs_metadata_completion_check;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM export_provenance
    WHERE metadata_verified IS TRUE AND metadata_evidence IS NULL
  ) THEN
    ALTER TABLE export_provenance
      VALIDATE CONSTRAINT export_provenance_metadata_completion_check;
  END IF;
END $$;

INSERT INTO schema_migrations(version) VALUES ('0019_recovery_2e_production_correctness');
COMMIT;
