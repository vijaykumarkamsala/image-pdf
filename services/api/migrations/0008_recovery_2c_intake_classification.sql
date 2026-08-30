BEGIN;

CREATE TABLE intake_classifications (
  upload_session_id text PRIMARY KEY REFERENCES upload_sessions(upload_session_id) ON DELETE CASCADE,
  inferred_category text,
  confidence_percent smallint,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  customer_category text,
  updated_at timestamptz NOT NULL,
  CONSTRAINT intake_inferred_category_allowed CHECK (
    inferred_category IS NULL OR inferred_category IN (
      'photograph','graphic','document','scan','animation','other','unsure'
    )
  ),
  CONSTRAINT intake_customer_category_allowed CHECK (
    customer_category IS NULL OR customer_category IN (
      'photograph','graphic','document','scan','animation','other','unsure'
    )
  ),
  CONSTRAINT intake_confidence_range CHECK (
    confidence_percent IS NULL OR confidence_percent BETWEEN 0 AND 100
  ),
  CONSTRAINT intake_confidence_requires_inference CHECK (
    inferred_category IS NOT NULL OR confidence_percent IS NULL
  )
);

INSERT INTO schema_migrations(version) VALUES ('0008_recovery_2c_intake_classification');
COMMIT;
