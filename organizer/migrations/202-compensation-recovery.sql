-- 202: compensation retry/unknown ledger and owner recovery actions.
-- 196 is immutable; these additive changes preserve the existing columns and
-- make ambiguous provider outcomes non-retryable until reconciliation/manual review.

ALTER TABLE payment_compensation_actions
  DROP CONSTRAINT IF EXISTS ck_payment_compensation_status;

ALTER TABLE payment_compensation_actions
  ADD CONSTRAINT ck_payment_compensation_status
  CHECK (status IN (
    'pending', 'processing', 'completed', 'failed', 'failed_retryable',
    'unknown', 'manual_review', 'cancelled'
  ));

ALTER TABLE payment_compensation_actions
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lease_token UUID,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_refund_id TEXT,
  ADD COLUMN IF NOT EXISTS provider_request_id TEXT,
  ADD COLUMN IF NOT EXISTS provider_status TEXT,
  ADD COLUMN IF NOT EXISTS last_error_code TEXT,
  ADD COLUMN IF NOT EXISTS last_error_summary TEXT,
  ADD COLUMN IF NOT EXISTS first_attempted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_attempted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS unknown_since TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS manual_review_reason TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_by UUID,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS original_payment_amount BIGINT,
  ADD COLUMN IF NOT EXISTS requested_refund_amount BIGINT,
  ADD COLUMN IF NOT EXISTS confirmed_refund_amount BIGINT,
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'KRW',
  ADD COLUMN IF NOT EXISTS lock_version INTEGER NOT NULL DEFAULT 0;

UPDATE payment_compensation_actions
   SET attempt_count = GREATEST(attempt_count, attempts),
       next_retry_at = COALESCE(next_retry_at, next_attempt_at),
       requested_refund_amount = COALESCE(requested_refund_amount, requested_amount),
       original_payment_amount = COALESCE(original_payment_amount, requested_amount)
 WHERE TRUE;

ALTER TABLE payment_compensation_actions
  ADD CONSTRAINT ck_payment_compensation_max_attempts CHECK (max_attempts BETWEEN 1 AND 20),
  ADD CONSTRAINT ck_payment_compensation_attempt_count CHECK (attempt_count >= 0),
  ADD CONSTRAINT ck_payment_compensation_requested_refund_amount CHECK (requested_refund_amount IS NULL OR requested_refund_amount >= 0),
  ADD CONSTRAINT ck_payment_compensation_confirmed_refund_amount CHECK (confirmed_refund_amount IS NULL OR confirmed_refund_amount >= 0);

CREATE INDEX IF NOT EXISTS ix_payment_compensation_recovery_due
  ON payment_compensation_actions(status, next_retry_at)
  WHERE status IN ('pending', 'failed_retryable');
CREATE INDEX IF NOT EXISTS ix_payment_compensation_review
  ON payment_compensation_actions(status, created_at)
  WHERE status IN ('unknown', 'manual_review');
CREATE INDEX IF NOT EXISTS ix_payment_compensation_lease
  ON payment_compensation_actions(lease_expires_at)
  WHERE status = 'processing';

CREATE TABLE IF NOT EXISTS payment_compensation_operator_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id UUID NOT NULL REFERENCES payment_compensation_actions(id) ON DELETE CASCADE,
  account_id UUID NOT NULL,
  actor_id UUID NOT NULL,
  operation_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('manual_review', 'confirm_completed', 'confirm_not_refunded', 'cancel', 'reconcile')),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(btrim(reason)) >= 5),
  evidence_id TEXT,
  provider_refund_id TEXT,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_payment_compensation_operator_operation UNIQUE (account_id, operation_key)
);

CREATE INDEX IF NOT EXISTS ix_payment_compensation_operator_actions_action
  ON payment_compensation_operator_actions(action_id, created_at DESC);

COMMENT ON TABLE payment_compensation_operator_actions IS
  'Owner-only compensation recovery actions. A unique operation key prevents duplicate external refund decisions.';
