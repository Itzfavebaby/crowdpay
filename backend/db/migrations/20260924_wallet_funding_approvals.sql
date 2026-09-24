-- Persist campaign wallet top-up funding approvals (#811) so approval is a
-- real, idempotent Stellar submission instead of a log-only no-op.

CREATE TABLE IF NOT EXISTS wallet_funding_approvals (
  id SERIAL PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  wallet_public_key TEXT NOT NULL,
  deficit_xlm NUMERIC(20, 7) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'submitted', 'confirmed', 'failed')),
  tx_hash TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one funding approval may be in-flight (pending/submitted) per campaign
-- at a time; this is what makes approve-funding idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS wallet_funding_approvals_in_flight_idx
  ON wallet_funding_approvals (campaign_id)
  WHERE status IN ('pending', 'submitted');
