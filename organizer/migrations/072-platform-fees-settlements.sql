CREATE TABLE IF NOT EXISTS platform_fee_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  fee_type TEXT NOT NULL CHECK (fee_type IN ('percentage', 'fixed', 'percentage_plus_fixed')),
  fee_percentage NUMERIC(5,2) NOT NULL DEFAULT 0,
  fee_fixed BIGINT NOT NULL DEFAULT 0,
  min_fee BIGINT NOT NULL DEFAULT 0,
  max_fee BIGINT,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO platform_fee_plans (name, description, fee_type, fee_percentage, fee_fixed, is_default)
SELECT '기본 플랜', '티켓당 3% + ₩300', 'percentage_plus_fixed', 3.00, 300, TRUE
WHERE NOT EXISTS (
  SELECT 1
  FROM platform_fee_plans
  WHERE is_default = TRUE
);

ALTER TABLE accounts
ADD COLUMN IF NOT EXISTS fee_plan_id UUID REFERENCES platform_fee_plans(id);

UPDATE accounts
SET fee_plan_id = (
  SELECT id
  FROM platform_fee_plans
  WHERE is_default = TRUE
  LIMIT 1
)
WHERE fee_plan_id IS NULL;

ALTER TABLE orders
ADD COLUMN IF NOT EXISTS platform_fee BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  gross_amount BIGINT NOT NULL DEFAULT 0,
  platform_fee BIGINT NOT NULL DEFAULT 0,
  refund_amount BIGINT NOT NULL DEFAULT 0,
  net_amount BIGINT NOT NULL DEFAULT 0,
  order_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed')) DEFAULT 'pending',
  paid_at TIMESTAMPTZ,
  bank_name TEXT,
  bank_account TEXT,
  bank_holder TEXT,
  memo TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_settlements_account_id ON settlements(account_id);
CREATE INDEX IF NOT EXISTS idx_settlements_period ON settlements(period_start, period_end);
