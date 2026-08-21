-- 233: 레벨2 컷오버 T4 — flip 완료된 go 고유 테이블 폐기.
--
-- 대상은 전부 **코드 SQL 참조 0** 을 확인한 뒤 DROP 한다(d4d559b 및 2배치 flip 완료).
--   · bids / allocation_sessions  : 추첨 SoT = v2 (응모 API 410, prod 행 0 실측)
--   · webhook_logs                : B2-3 webhook flip → v2 webhook_deliveries 가 정본
--   · queue_sessions              : B2-2 queue flip → v2 QueueService(Redis) 가 정본
--   · crm_activities              : 코드 참조 0(CRM 관리 UI·route 는 1배치에서 이미 제거)
--
-- ⚠️ crm_contacts 는 **여기서 DROP 하지 않는다** — notification/recipients.ts 가
--    crmTiers/crmTags 세그먼트와 **전 발송 공통 블랙리스트(tier='blacklist')** 로 아직
--    하드 참조한다. 지금 지우면 "relation does not exist" 로 전 발송 경로가 죽는다.
--    메시징 세션이 v2 수신자 해석으로 재배선한 뒤 별도 마이그에서 제거한다.
--
-- FK 위상: bids.session_id → allocation_sessions(id) 이므로 자식(bids) 먼저.
-- 재실행 안전: IF EXISTS + CASCADE.

-- 1) 추첨 (자식 → 부모)
DROP TABLE IF EXISTS bids CASCADE;
DROP TABLE IF EXISTS allocation_sessions CASCADE;

-- 2) webhook 전송 로그 (구독 정의 webhooks 는 아직 코드 참조가 남아 별도 단계)
DROP TABLE IF EXISTS webhook_logs CASCADE;

-- 3) 스마트 대기열 세션 (v2 Redis 로 이전됨)
DROP TABLE IF EXISTS queue_sessions CASCADE;

-- 4) CRM 활동 로그 (crm_contacts 는 보류 — 위 주석 참조)
DROP TABLE IF EXISTS crm_activities CASCADE;
