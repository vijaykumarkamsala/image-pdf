BEGIN;

ALTER TABLE upload_sessions
  ADD COLUMN pdf_capability_analysis jsonb,
  ADD CONSTRAINT upload_pdf_capability_shape CHECK (
    pdf_capability_analysis IS NULL OR (
      expected_media_type = 'application/pdf'
      AND jsonb_typeof(pdf_capability_analysis) = 'object'
      AND pdf_capability_analysis->>'source_sha256' = verified_sha256::text
      AND pdf_capability_analysis->>'original_protected' = 'true'
    )
  );

ALTER TABLE source_inspection_facts
  ADD COLUMN pdf_capability_analysis jsonb,
  ADD CONSTRAINT source_pdf_capability_shape CHECK (
    pdf_capability_analysis IS NULL OR (
      media_type = 'application/pdf'
      AND jsonb_typeof(pdf_capability_analysis) = 'object'
      AND pdf_capability_analysis->>'source_sha256' = source_sha256::text
      AND pdf_capability_analysis->>'original_protected' = 'true'
    )
  );

INSERT INTO schema_migrations(version) VALUES ('0022_imported_pdf_capability');

COMMIT;
