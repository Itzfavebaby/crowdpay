-- Make contribution submission atomic and idempotent (#810): record the DB
-- intent row before the Stellar transaction is submitted, and let a client
-- retry safely by supplying the same idempotency key.

ALTER TABLE stellar_transactions
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS stellar_transactions_idempotency_key_idx
  ON stellar_transactions (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
