-- 204: durable dead-letter replay history and operator controls.

ALTER TABLE inter_service_webhook_deliveries
  ADD COLUMN IF NOT EXISTS payload_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS dead_letter_reason TEXT,
  ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS replay_status TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS replay_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS replay_requested_by UUID,
  ADD COLUMN IF NOT EXISTS replay_reason TEXT,
  ADD COLUMN IF NOT EXISTS replay_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS replay_attempt_id UUID,
  ADD COLUMN IF NOT EXISTS permanently_ignored_at TIMESTAMPTZ;

UPDATE inter_service_webhook_deliveries
   SET payload_fingerprint = COALESCE(payload_fingerprint, md5(payload::text)),
       dead_lettered_at = CASE WHEN status = 'dead_lettered' THEN COALESCE(dead_lettered_at, created_at) ELSE dead_lettered_at END
 WHERE TRUE;

ALTER TABLE inter_service_webhook_deliveries
  DROP CONSTRAINT IF EXISTS ck_isw_deliveries_replay_status;
ALTER TABLE inter_service_webhook_deliveries
  ADD CONSTRAINT ck_isw_deliveries_replay_status
  CHECK (replay_status IN ('none', 'requested', 'processing', 'processed', 'failed', 'pending', 'dead_lettered', 'ignored_stale', 'quarantined'));

CREATE INDEX IF NOT EXISTS ix_isw_deliveries_dlq
  ON inter_service_webhook_deliveries(status, dead_lettered_at)
  WHERE direction = 'inbound' AND status = 'dead_lettered';

CREATE TABLE IF NOT EXISTS webhook_delivery_replay_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_row_id BIGINT NOT NULL REFERENCES inter_service_webhook_deliveries(id) ON DELETE CASCADE,
  delivery_id UUID NOT NULL,
  account_id UUID NOT NULL,
  actor_id UUID NOT NULL,
  operation_key TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'processed', 'pending', 'dead_lettered', 'ignored_stale', 'failed', 'quarantined')),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) >= 5),
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT uq_webhook_replay_operation UNIQUE (account_id, operation_key)
);

CREATE INDEX IF NOT EXISTS ix_webhook_replay_attempts_delivery
  ON webhook_delivery_replay_attempts(delivery_row_id, created_at DESC);

COMMENT ON TABLE webhook_delivery_replay_attempts IS
  'Owner-triggered DLQ replay attempts. Original payload is immutable; each replay has an idempotency key and result.';
