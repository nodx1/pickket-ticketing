-- 205: 온라인 인덱스 안전성 보완
-- @nontransactional
--
-- 197~200에서 추가된 lease/retry 인덱스는 기존 DB에서 이미 생성됐을 수
-- 있다. 이 migration은 해당 인덱스를 CONCURRENTLY 방식으로 재구축해
-- 배포 시 테이블 쓰기를 장시간 막지 않도록 한다. REINDEX CONCURRENTLY는
-- 트랜잭션 안에서 실행할 수 없으므로 migrate.ts가 별도 모드로 실행한다.
-- 인덱스가 아직 없다면 선행 migration(197~200)이 먼저 실패해야 하며,
-- 부분 완료 후 재실행해도 REINDEX는 멱등이다.

REINDEX INDEX CONCURRENTLY ix_message_deliveries_claim_lease;
REINDEX INDEX CONCURRENTLY ix_isw_deliveries_pending_retry;
REINDEX INDEX CONCURRENTLY ix_email_campaigns_claim_lease;
REINDEX INDEX CONCURRENTLY ix_email_campaign_recipients_claim_lease;
