-- 사업자 인증 심사 P1 — 계정(사업자) 레벨 선-심사 게이트.
-- 유료 이벤트 발행(draft→pending_review)은 accounts.verification_status='approved' 필요.
-- 이름·번호 등은 심사 기간만 보관(만료/종료 시 문서 삭제 — 데이터 최소보관, 운영 배치).

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verification_rejected_reason TEXT;

-- CHECK 는 별도 statement(IF NOT EXISTS 컬럼과 분리, 재실행 안전).
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_verification_status_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_verification_status_check
  CHECK (verification_status IN ('unverified', 'draft', 'pending', 'approved', 'rejected'));

-- 신청·심사 이력(재제출 = 새 행, 최신이 유효). 계정 1:N.
CREATE TABLE IF NOT EXISTS business_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- 사업자 정보(OCR/수기)
  biz_number TEXT,
  company_name TEXT,
  rep_name TEXT,
  biz_type TEXT,        -- 업태
  biz_item TEXT,        -- 종목
  address TEXT,
  opened_on DATE,
  -- 정산 계좌(P1: 마스킹 표시+admin 전용, 암호화는 하드닝 TODO)
  bank_name TEXT,
  bank_account TEXT,
  bank_holder TEXT,
  bank_verified BOOLEAN NOT NULL DEFAULT false,
  -- 확인 플래그
  authorized_confirmed BOOLEAN NOT NULL DEFAULT false,  -- "대표이거나 위임받음" 권한 체크
  masking_confirmed BOOLEAN NOT NULL DEFAULT false,     -- 개인정보 마스킹 확인
  -- 자동심사 결과(P2~P4)
  ocr_raw JSONB,
  gov_check_result JSONB,
  identity_result JSONB,
  bank_check_result JSONB,
  -- 심사 상태
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending', 'approved', 'rejected')),
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  rejected_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_business_verifications_account ON business_verifications(account_id);
CREATE INDEX IF NOT EXISTS idx_business_verifications_status ON business_verifications(status);

-- 역할별/유형별 제출 서류(사업자등록증·통장사본·인허가). verification 1:N.
CREATE TABLE IF NOT EXISTS business_verification_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  verification_id UUID NOT NULL REFERENCES business_verifications(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('biz_cert', 'bankbook', 'permit')),
  file_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bvd_verification ON business_verification_documents(verification_id);
