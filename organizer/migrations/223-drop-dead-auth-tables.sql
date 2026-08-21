-- 레벨2 영역D(1차) — go DB 죽은 인증 테이블 즉시 DROP.
--   인증은 이미 v2 단일 SSOT(go 는 v2 access JWT 자체검증만). 아래 5테이블은 go 코드 참조 0
--   (grep 확인: FROM/INTO/UPDATE/JOIN 0건) — 실명인증·MFA·비번리셋·세션·도메인은 전부 v2 전담.
--   실데이터 0(테스트 대회 1개, 파괴적 전환 허용) 상태의 컷오버 골든타임에 정리한다.
--
--   ⚠️ 이름 주의: DROP 대상은 정확히 `sessions` 뿐. user_sessions/queue_sessions/
--     allocation_sessions/public_chat_sessions 는 별개 테이블 — 건드리지 않는다.
--
--   FK 위상: 이 5테이블은 accounts/users/orders 를 **참조(outbound)** 만 하고, 어떤 테이블도
--     이들을 FK 타깃으로 참조(inbound)하지 않는다(마이그레이션 전수 확인). 따라서 DROP 순서 무관.
--   방어: IF EXISTS — custom_domains 는 이 go DB 마이그셋에 CREATE 이력이 없어 미존재일 수 있음.
--   가역성: 데이터0·스키마만 → 계획 M4 D1(롤백가능) 단계.

DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS mfa_secrets;
DROP TABLE IF EXISTS identity_verifications;
DROP TABLE IF EXISTS password_reset_tokens;
DROP TABLE IF EXISTS custom_domains;
