-- Phase 5B-2: 실명인증 기록 테이블 (NICE/KCB 대응)
--
-- v2 호환 컬럼명 유지 (ci_hash, di_hash, verification_level, is_verified).
-- go는 현재 소비자 계정 테이블이 없는 guest checkout 구조라,
-- 실명인증 결과는 이 테이블에 단독 저장.
-- 향후 소비자 계정이 추가되면 ci_hash UNIQUE로 중복 방지 가능.
--
-- 실제 NICE/KCB API 호출은 별도 작업 (Phase 5B-2 2단계). 이번 마이그레이션은 스키마만.

CREATE TABLE IF NOT EXISTS identity_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 연결 정보 (실명인증 주체)
  account_id UUID NULL REFERENCES accounts(id) ON DELETE SET NULL,  -- 주최자 인증 시
  order_id UUID NULL REFERENCES orders(id) ON DELETE SET NULL,      -- 구매자 인증 시

  -- Provider 정보
  provider TEXT NOT NULL CHECK (provider IN ('nice', 'kcb', 'pcc', 'toss_cert')),
  provider_tx_id TEXT NULL,  -- NICE/KCB가 준 거래 ID

  -- 인증 결과 (v2 호환 컬럼명)
  ci_hash TEXT NULL,         -- SHA-256(CI). UNIQUE 제약은 소비자 계정 추가 시 도입
  di_hash TEXT NULL,         -- SHA-256(DI)
  ci_encrypted TEXT NULL,    -- AES-256-GCM(원본 CI). 복호화 가능 필요 시
  di_encrypted TEXT NULL,    -- AES-256-GCM(원본 DI)

  -- 개인정보 (최소 수집, 해시/암호화)
  name_hash TEXT NULL,       -- SHA-256(이름 + pepper) — 동명이인 대비
  birth_year SMALLINT NULL,  -- 연령 제한 이벤트용
  gender CHAR(1) NULL CHECK (gender IS NULL OR gender IN ('M', 'F')),
  phone_encrypted TEXT NULL, -- AES-256-GCM(전화번호)

  -- 상태
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'success', 'failed', 'expired', 'cancelled')),
  verification_level SMALLINT NOT NULL DEFAULT 0
    CHECK (verification_level BETWEEN 0 AND 3),
  -- 0=미인증, 1=이메일, 2=전화, 3=실명
  is_verified BOOLEAN NOT NULL DEFAULT FALSE,

  -- 원본 응답 (감사 + 디버깅)
  raw_response JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- 타임스탬프
  verified_at TIMESTAMPTZ NULL,
  expires_at TIMESTAMPTZ NULL,  -- 실명인증 유효 기간 (보통 1년)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_idverif_account
  ON identity_verifications(account_id)
  WHERE account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_idverif_order
  ON identity_verifications(order_id)
  WHERE order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_idverif_ci_hash
  ON identity_verifications(ci_hash)
  WHERE ci_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_idverif_status
  ON identity_verifications(status, created_at DESC);

COMMENT ON TABLE identity_verifications IS
  '실명인증 기록 (NICE/KCB/PCC/Toss). Phase 5B-2. v2 호환 컬럼명 유지.';
COMMENT ON COLUMN identity_verifications.ci_hash IS
  'v2 users.ci_hash와 동일 의미. SHA-256(CI). 구매 제한/중복 방지용.';
COMMENT ON COLUMN identity_verifications.verification_level IS
  'v2와 동일. 0=미인증, 1=이메일, 2=전화, 3=실명 인증.';
