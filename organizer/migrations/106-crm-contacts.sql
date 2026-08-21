-- CRM 연락처 — 구매자 이메일 기반 고객 프로필
CREATE TABLE IF NOT EXISTS crm_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  phone TEXT,
  organization TEXT,
  tier TEXT NOT NULL DEFAULT 'regular' CHECK (tier IN ('regular', 'vip', 'vvip', 'blacklist')),
  tags TEXT[] NOT NULL DEFAULT '{}',
  notes TEXT,
  total_orders INT NOT NULL DEFAULT 0,
  total_spent BIGINT NOT NULL DEFAULT 0,
  last_order_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_contacts_account_email ON crm_contacts(account_id, email);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_account_tier ON crm_contacts(account_id, tier);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_tags ON crm_contacts USING gin(tags);

COMMENT ON TABLE crm_contacts IS 'CRM 고객 프로필 — 구매자 이메일 기반, 태그/등급/노트 관리';

-- CRM 활동 기록
CREATE TABLE IF NOT EXISTS crm_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
  event_id UUID REFERENCES events(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('order', 'refund', 'check_in', 'note', 'tag_change', 'tier_change', 'message')),
  summary TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_activities_contact ON crm_activities(contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_activities_event ON crm_activities(event_id);

COMMENT ON TABLE crm_activities IS 'CRM 활동 기록 — 주문/환불/체크인/메모 등 고객 타임라인';
