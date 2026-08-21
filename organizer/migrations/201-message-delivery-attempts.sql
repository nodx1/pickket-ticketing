-- 201: provider attempt ledger and operator-review states for ambiguous deliveries.
-- Existing migrations are immutable. Unknown is never converted to failed or replayed
-- automatically; every provider call gets a durable attempt lineage.

ALTER TABLE message_deliveries
  DROP CONSTRAINT IF EXISTS message_deliveries_status_check;

ALTER TABLE message_deliveries
  ADD CONSTRAINT message_deliveries_status_check
  CHECK (status IN (
    'queued', 'sending', 'sent', 'delivered', 'failed', 'skipped',
    'unknown', 'manual_review', 'cancelled'
  ));

ALTER TABLE event_messages
  DROP CONSTRAINT IF EXISTS event_messages_status_check;

ALTER TABLE event_messages
  ADD CONSTRAINT event_messages_status_check
  CHECK (status IN (
    'draft', 'scheduled', 'queued', 'sending', 'sent',
    'sent_with_failures', 'failed', 'requires_review'
  ));

ALTER TABLE message_deliveries
  ADD COLUMN IF NOT EXISTS reconcile_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reconcile_first_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_reconciled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_reconcile_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS message_delivery_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id UUID NOT NULL REFERENCES message_deliveries(id) ON DELETE CASCADE,
  message_id UUID NOT NULL,
  account_id UUID NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'kakao')),
  provider TEXT NOT NULL,
  recipient_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  claim_token UUID,
  request_fingerprint TEXT,
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  previous_attempt_id UUID REFERENCES message_delivery_attempts(id),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  provider_request_id TEXT,
  http_status INTEGER,
  provider_error_code TEXT,
  provider_error_summary TEXT,
  result_status TEXT NOT NULL DEFAULT 'inflight'
    CHECK (result_status IN ('inflight', 'sent', 'delivered', 'failed', 'unknown', 'manual_review', 'cancelled')),
  timeout_stage TEXT,
  ambiguous BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_message_delivery_attempt_no UNIQUE (delivery_id, attempt_no)
);

CREATE INDEX IF NOT EXISTS ix_message_delivery_attempts_delivery
  ON message_delivery_attempts(delivery_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_message_delivery_attempts_review
  ON message_delivery_attempts(result_status, created_at)
  WHERE result_status IN ('unknown', 'manual_review');
CREATE INDEX IF NOT EXISTS ix_message_delivery_attempts_provider_request
  ON message_delivery_attempts(provider_request_id)
  WHERE provider_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS message_delivery_operator_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id UUID NOT NULL REFERENCES message_deliveries(id) ON DELETE CASCADE,
  account_id UUID NOT NULL,
  actor_id UUID NOT NULL,
  operation_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('manual_review', 'confirm_sent', 'confirm_failed', 'resend', 'reconcile')),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(btrim(reason)) >= 5),
  provider_request_id TEXT,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_message_delivery_operator_operation UNIQUE (account_id, operation_key)
);

CREATE INDEX IF NOT EXISTS ix_message_delivery_operator_actions_delivery
  ON message_delivery_operator_actions(delivery_id, created_at DESC);

COMMENT ON TABLE message_delivery_operator_actions IS
  'Owner-only delivery recovery actions. operation_key makes retries idempotent and preserves the prior state transition.';

COMMENT ON TABLE message_delivery_attempts IS
  'Provider 호출별 멱등 attempt 원장. unknown은 자동 재발송하지 않고 대사/수동 검토 대상으로 남긴다.';
