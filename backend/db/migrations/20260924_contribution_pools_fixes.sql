-- Fixes for contribution pools (#804):
--  - prevent duplicate membership under concurrent joins
--  - allow an in-flight submission state so double-submit can be rejected
--    without leaving the pool stuck if the Stellar submission fails
--  - record the tx hash of the aggregated contribution for auditability

ALTER TABLE pool_members
  ADD CONSTRAINT pool_members_pool_id_user_id_key UNIQUE (pool_id, user_id);

ALTER TABLE contribution_pools
  DROP CONSTRAINT IF EXISTS contribution_pools_status_check;

ALTER TABLE contribution_pools
  ADD CONSTRAINT contribution_pools_status_check
    CHECK (status IN ('open', 'closed', 'submitting', 'submitted', 'cancelled'));

ALTER TABLE contribution_pools
  ADD COLUMN tx_hash TEXT;
