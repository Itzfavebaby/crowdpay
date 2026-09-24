-- Replace the fraud-retrain endpoint's hardcoded placeholder metrics (#808)
-- with versioned, persisted retrain runs computed from real review outcomes.

CREATE TABLE IF NOT EXISTS fraud_model_versions (
  id SERIAL PRIMARY KEY,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed'
    CHECK (status IN ('completed', 'insufficient_data', 'failed')),
  false_positive_rate NUMERIC(6, 4),
  validation_samples INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS fraud_model_versions_version_idx
  ON fraud_model_versions (version);
