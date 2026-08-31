BEGIN;

ALTER TABLE intake_classifications
  ADD COLUMN evidence_label text NOT NULL DEFAULT 'unknown'
  CHECK (evidence_label IN ('verified','likely','unknown'));

UPDATE intake_classifications
SET evidence_label = CASE
  WHEN inferred_category IS NULL THEN 'unknown'
  WHEN confidence_percent >= 95 THEN 'verified'
  ELSE 'likely'
END,
confidence_percent = NULL;

ALTER TABLE intake_classifications DROP CONSTRAINT intake_confidence_range;
ALTER TABLE intake_classifications DROP CONSTRAINT intake_confidence_requires_inference;
ALTER TABLE intake_classifications
  ADD CONSTRAINT intake_numeric_confidence_unavailable CHECK (confidence_percent IS NULL);
ALTER TABLE intake_classifications
  ADD CONSTRAINT intake_evidence_matches_inference CHECK (
    (inferred_category IS NULL AND evidence_label = 'unknown') OR
    (inferred_category IS NOT NULL AND evidence_label IN ('verified','likely'))
  );

INSERT INTO schema_migrations(version) VALUES ('0013_recovery_2c_truthful_intake');
COMMIT;
