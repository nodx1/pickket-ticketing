-- 207: provider-native reconciliation identifiers.
-- Additive only: 196-206 remain immutable. These fields let an operator prove
-- which provider/payment key was checked after an ambiguous response.

ALTER TABLE payment_compensation_actions
  ADD COLUMN IF NOT EXISTS provider_name TEXT NOT NULL DEFAULT 'v2',
  ADD COLUMN IF NOT EXISTS provider_payment_key TEXT,
  ADD COLUMN IF NOT EXISTS provider_cancel_id TEXT,
  ADD COLUMN IF NOT EXISTS provider_lookup_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS provider_last_lookup_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_last_lookup_status TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'payment_compensation_actions'::regclass
       AND conname = 'ck_payment_compensation_provider_name'
  ) THEN
    ALTER TABLE payment_compensation_actions
      ADD CONSTRAINT ck_payment_compensation_provider_name
      CHECK (provider_name IN ('v2', 'toss'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_payment_compensation_provider_lookup
  ON payment_compensation_actions(provider_name, provider_payment_key)
  WHERE provider_payment_key IS NOT NULL;

COMMENT ON COLUMN payment_compensation_actions.provider_payment_key IS
  'Provider-native payment identifier (for example Toss paymentKey); never use a guessed order id for reconciliation.';

ALTER TABLE message_delivery_attempts
  ADD COLUMN IF NOT EXISTS provider_lookup_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS provider_last_lookup_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_last_lookup_status TEXT;
