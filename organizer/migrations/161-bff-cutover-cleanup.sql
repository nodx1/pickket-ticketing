-- 161: BFF cutover Phase 2/4 — go 자체 인증 자산 정리
-- v2 가 인증 SSOT. go session 미사용. password 검증도 v2 가 처리.
--
-- ⚠️ 적용 후:
--   - users.password_hash 는 NULL 가능 (신규 가입자 NULL)
--   - sessions 테이블 사라짐 — 모든 사용자 v2 cookie 로 인증 필수
--   - 기존 사용자가 pickket_session 만 가졌으면 다음 로그인 필요
--
-- mfa_secrets 는 별도 단계에서 정리 (현재 deprecated 라 unused).

-- 1) password_hash NULL 허용
ALTER TABLE users
  ALTER COLUMN password_hash DROP NOT NULL;

-- 2) go session 테이블 제거
DROP TABLE IF EXISTS sessions CASCADE;
