-- 162: BFF cutover Phase 5 — go MFA 자산 제거
-- v2 가 MFA 처리. go mfa_secrets 더 이상 사용 안 함.
-- 모든 호출 코드는 stub 또는 410 처리됨.

DROP TABLE IF EXISTS mfa_secrets CASCADE;
