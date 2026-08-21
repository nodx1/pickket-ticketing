-- 250: 발송 원장 계열 8종 DROP (레벨2 컷오버 W5-MSG)
--
-- 🔴🔴 **organizer 배포 후에만 적용한다.** 🔴🔴
--   이 마이그레이션은 organizer 코드가 v2 원장(alembic `w5msg_0727`)만 바라보게 바뀐 뒤에
--   적용해야 한다. 순서를 뒤집으면(마이그 먼저) 배포 전 organizer 가 없는 테이블을 조회해
--   메시지 목록·발송 상세·수신함·캠페인 화면이 전부 500 이 되고, 크론이 크래시한다.
--
--   적용 순서:
--     ① alembic upgrade w5msg_0727 (v2 스키마 선적용 — 가산적이라 언제 해도 안전)
--     ② organizer 배포 (이 브랜치 코드)
--     ③ 헬스 + 메시지/수신함 화면 확인
--     ④ **그 다음** 이 마이그레이션 적용
--
-- 배경 — 무엇이 어디로 갔나 (전부 v2 SoT 로 이관 완료, go SQL 실측 0):
--   event_messages                    → v2 event_messages            (orgmsg_0724)
--   message_deliveries                → v2 message_deliveries        (orgmsg_0724)
--   message_delivery_attempts         → v2 message_delivery_attempts (orgmsg_0724 + w5msg_0727 컬럼)
--   message_delivery_operator_actions → v2 message_delivery_operator_actions (orgmsg_0724)
--   reminder_sends                    → v2 reminder_sends            (orgmsg_0724)
--   email_campaigns                   → v2 email_campaigns           (w5msg_0727 · 신설)
--   email_campaign_recipients         → v2 email_campaign_recipients (w5msg_0727 · 신설)
--   inbound_emails                    → v2 inbound_emails            (w5msg_0727 · 신설)
--
-- ⚠️ 캠페인은 **폐기가 아니라 이관**이다(대표 결정 2026-07-27). 신규 생성만 410 으로 동결돼
--    있고 조회·발송·통계 라이프사이클은 v2 원장 위에서 그대로 살아 있다.
--
-- 발송 소유권(이중발송 0): go 메시징 cron 4종(dispatch-messages / dispatch-campaigns /
--   reminders / consent-reconfirm)은 **flag 조건 없이 무조건** v2 위임 스텁이다. 실제 발송은
--   v2 Celery beat 가 단독 소유한다. 이 DROP 은 "go 가 다시 발송자로 되살아나는 경로"를
--   물리적으로 봉인하는 마지막 잠금이다.
--   (reconcile-deliveries 만 예외적으로 살아 있는데, provider 상태조회(DLR)는 go 에만 있는
--    NCP 클라이언트를 쓰기 때문이다. 그 경로도 원장 read/write 는 전부 v2 HTTP 다.)
--
-- 데이터 보존: 실데이터 0 전제(2026-07-24 prod 빈DB 초기화). 행이 있는 환경이라면 이 파일을
--   적용하기 전에 pg_dump 로 8개 테이블을 백업할 것 — DROP 은 되돌릴 수 없다.
--
-- 재실행 안전: 전부 IF EXISTS. CASCADE 는 이 테이블들을 참조하는 FK/뷰만 정리한다.

BEGIN;

-- 자식 → 부모 순서(FK 의존). CASCADE 가 있어도 명시적 순서를 유지해 의도를 드러낸다.
DROP TABLE IF EXISTS message_delivery_operator_actions CASCADE;
DROP TABLE IF EXISTS message_delivery_attempts CASCADE;
DROP TABLE IF EXISTS message_deliveries CASCADE;

DROP TABLE IF EXISTS email_campaign_recipients CASCADE;
DROP TABLE IF EXISTS email_campaigns CASCADE;

DROP TABLE IF EXISTS inbound_emails CASCADE;
DROP TABLE IF EXISTS reminder_sends CASCADE;

-- event_messages 는 위 자식들이 (FK 없이) message_id 로 참조하므로 마지막에 내린다.
DROP TABLE IF EXISTS event_messages CASCADE;

COMMIT;
