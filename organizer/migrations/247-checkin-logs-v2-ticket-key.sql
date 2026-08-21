-- W4-ORD: check_in_logs 를 go `attendees` 앵커에서 분리한다.
--
-- 배경: check_in_logs 는 **go-local 원장**(현장 체크인 감사·집계)이지만, 지금까지 유일한
-- 티켓 식별자가 `attendee_id`(→ go attendees FK) 였다. 그래서 체크인 이력을 보여주는
-- 모든 화면(체크인 CSV·최근 체크인 위젯·참석자 상세)이 표시용 이름/티켓번호 하나 때문에
-- `INNER JOIN attendees` 를 해야 했고, 참석자 정본이 v2 티켓으로 옮겨간 뒤에도 go attendees
-- 를 살려두는 **읽기 앵커**로 남아 있었다.
--
-- 조치: 로그 행에 v2 티켓 키(`v2_ticket_id`)와 이벤트 스코프(`event_id`), 그리고 기록 시점의
-- 표시값(`attendee_name`·`ticket_number`)을 함께 적는다.
--   · `v2_ticket_id` = 티켓 정본 키. 참석자 상세/입장취소가 이 값으로 로그를 찾는다.
--   · `event_id`     = 옛 `attendees.event_id` 를 통한 이벤트 스코프의 대체. 이게 없으면
--                      "이 이벤트의 체크인 로그"를 attendees JOIN 없이 못 고른다.
--   · 표시값 2개    = **기록 시점 스냅샷**(현장 원장의 성질). v2 를 재조회해 채우면 CSV 한 장에
--                      티켓 수만큼 원격호출이 붙고, v2 장애 시 이력 조회가 통째로 막힌다.
--
-- attendee_id 는 NULL 허용 + FK 해제로 강등한다(컬럼 자체는 남기되 더 이상 정본 키가 아님).
-- 2026-07-27 대표 결정으로 prod 데이터를 전부 초기화하고 재개최하므로 **백필하지 않는다** —
-- 기존 행 호환 폴백을 넣지 않는 것이 이 마이그레이션의 의도다.

ALTER TABLE check_in_logs ADD COLUMN IF NOT EXISTS v2_ticket_id UUID;
ALTER TABLE check_in_logs ADD COLUMN IF NOT EXISTS event_id UUID;
ALTER TABLE check_in_logs ADD COLUMN IF NOT EXISTS attendee_name TEXT;
ALTER TABLE check_in_logs ADD COLUMN IF NOT EXISTS ticket_number TEXT;

-- attendee_id 강등: FK(→ attendees) 해제 + NOT NULL 해제.
-- FK 가 남아 있으면 go attendees 행 없이는 체크인 로그를 쓸 수 없어(=참석자 원장 종속 유지)
-- 이 마이그레이션의 목적 자체가 무산된다.
ALTER TABLE check_in_logs DROP CONSTRAINT IF EXISTS check_in_logs_attendee_id_fkey;
ALTER TABLE check_in_logs ALTER COLUMN attendee_id DROP NOT NULL;

-- 조회 경로 2개:
--   1) 이벤트 단위 이력(CSV·최근 체크인 위젯) — (account_id, event_id, created_at DESC)
--   2) 티켓 단위 이력(참석자 상세·입장취소 DELETE) — (account_id, v2_ticket_id)
CREATE INDEX IF NOT EXISTS idx_check_in_logs_account_event_created
  ON check_in_logs (account_id, event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_check_in_logs_account_v2_ticket
  ON check_in_logs (account_id, v2_ticket_id);
